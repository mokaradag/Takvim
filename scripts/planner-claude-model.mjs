/**
 * Rota AI planlayıcı değerlendirmesi için Claude CLI model komutu (Aşama 4C) — geliştirme aracı; uygulama, CI ve
 * Rota sunucusu bu dosyayı çalıştırmaz.
 *
 *   node scripts/planner-evaluation.mjs run --model-command 'node scripts/planner-claude-model.mjs' --semantic kosu.json
 *
 * stdin: üretim turunun girdisi `{ messages, tools, toolChoice }`; stdout: `{ text, toolCalls, finishReason, usage, models,
 * thinking }`. Araçlar modele yerel araç çağırma arayüzüyle (yalnızca bu araçları sunan, hiçbir aracı yürütmeyen yerel MCP
 * sunucusu) KAYIT SIRASIYLA verilir; ilk sistem iletisi değişmeyen sistem yönergesidir, kalan iletiler tek kullanıcı
 * iletisine sırasıyla yazılır. Böylece araçlar ve sistem yönergesi önbelleğe alınabilir önek olarak bayt bayt sabit kalır.
 *
 * Model kimliği ve düşünmesizlik her çağrıda gözlemden doğrulanır: CLI'nin kullandığı her model beklenen model olmalı,
 * düşünme bloğu ve düşünme belirteci sıfır olmalıdır (`MAX_THINKING_TOKENS=0`, en düşük `--effort`). Kimlik doğrulama,
 * kota, beklenmeyen model, düşünme, bütçe aşımı ya da önbelleğin yeniden kullanılmaması komut hatasıdır; değerlendirici
 * bunu altyapı hatası sayar ve koşuyu durdurur.
 *
 * Ortam: PLANNER_CLAUDE_MODEL (varsayılan claude-haiku-4-5-20251001), PLANNER_CLAUDE_EFFORT (low),
 * PLANNER_CLAUDE_LOG (çağrı başına içeriksiz ölçüm satırı), PLANNER_CLAUDE_MAX_CALLS, PLANNER_CLAUDE_MAX_UNCACHED
 * (önbellekten okunmayan girdi belirteçlerinin toplam üst sınırı), PLANNER_CLAUDE_REQUIRE_CACHE=1 (aynı önekle ikinci
 * çağrıdan sonra önbellek okuması zorunlu).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = 'rota';
const PREFIX = `mcp__${SERVER}__`;
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Yerel MCP sunucusu: verilen araçları verilen sırayla listeler, hiçbirini yürütmez. */
function serveTools(file) {
  const tools = JSON.parse(readFileSync(file, 'utf8'));
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null) return;
    if (message.method === 'initialize') {
      reply(message.id, { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1' } });
    } else if (message.method === 'tools/list') {
      reply(message.id, { tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) });
    } else if (message.method === 'tools/call') {
      reply(message.id, { content: [{ type: 'text', text: 'not executed' }], isError: true });
    } else {
      reply(message.id, {});
    }
  });
}

/** Sistem dışı iletiler tek kullanıcı iletisinde, sırasıyla ve rolleriyle. */
function conversationText(messages) {
  const lines = [];
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    if (message.role === 'system') lines.push(`[SUNUCU NOTU]\n${content}`);
    else if (message.role === 'user') lines.push(`[KULLANICI]\n${content}`);
    else if (message.role === 'tool') lines.push(`[ARAÇ SONUCU ${message.toolCallId || ''}]\n${content}`);
    else if (message.role === 'assistant') {
      const calls = (message.toolCalls || []).map((call) => `${call.name}(${call.arguments}) [${call.id}]`);
      lines.push(`[ASİSTAN]\n${[content, ...calls].filter(Boolean).join('\n')}`);
    }
  }
  return lines.join('\n\n');
}

function ledger(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function runClaude(args, env, cwd, input) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try { events.push(JSON.parse(line)); } catch { /* CLI dışı satır */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ code: -1, events }));
    child.on('close', (code) => resolve({ code, events }));
    child.stdin.end(input);
  });
}

async function complete() {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const model = process.env.PLANNER_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const effort = process.env.PLANNER_CLAUDE_EFFORT || 'low';
  const log = process.env.PLANNER_CLAUDE_LOG || null;
  const fail = (error, extra = {}) => {
    if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), error, ...extra })}\n`);
    process.stdout.write(`${JSON.stringify({ text: '', toolCalls: [], error })}\n`);
  };
  const [system, ...rest] = payload.messages;
  if (system?.role !== 'system') return fail('PLANNER_SYSTEM_MISSING');
  const all = payload.toolChoice === 'none' ? [] : payload.tools;
  // Zorunlu adlı araç (üretimde OpenAI uyumlu adlı işlev seçimi) CLI'nin yapılandırılmış çıktısıyla verilir: yanıt o aracın şemasıdır.
  const forced = payload.toolChoice?.name ? all.find((tool) => tool.name === payload.toolChoice.name) || null : null;
  const tools = forced ? all.filter((tool) => tool !== forced) : all;
  const staticPromptHash = hash(system.content);
  const toolCatalogHash = hash(JSON.stringify([forced?.name ?? null, all]));
  const prior = ledger(log);
  const calls = prior.filter((row) => row.usage).length;
  const uncached = prior.reduce((sum, row) => sum + (row.usage ? row.usage.input_tokens + row.usage.cache_creation_input_tokens : 0), 0);
  if (process.env.PLANNER_CLAUDE_MAX_CALLS && calls >= Number(process.env.PLANNER_CLAUDE_MAX_CALLS)) return fail('PLANNER_BUDGET_CALLS');
  if (process.env.PLANNER_CLAUDE_MAX_UNCACHED && uncached >= Number(process.env.PLANNER_CLAUDE_MAX_UNCACHED)) return fail('PLANNER_BUDGET_TOKENS');

  // Kararlı yalıtılmış ev ve çalışma klasörü: depo bağlamı, kullanıcı ayarı ya da proje yönergesi modele girmez.
  const home = process.env.PLANNER_CLAUDE_HOME || path.join(tmpdir(), 'rota-planner-claude-home');
  const cwd = path.join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const work = mkdtempSync(path.join(home, 'call-'));
  try {
    writeFileSync(path.join(work, 'system.txt'), system.content, 'utf8');
    writeFileSync(path.join(work, 'tools.json'), JSON.stringify(tools), 'utf8');
    writeFileSync(path.join(work, 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp', path.join(work, 'tools.json')] } } }), 'utf8');
    const keep = /^(PATH|LANG|LC_ALL|TZ|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|ANTHROPIC_BASE_URL|CLAUDE_CODE_(REMOTE.*|PROVIDER_MANAGED_BY_HOST|ORGANIZATION_UUID|ACCOUNT_UUID|CONTAINER_ID|ENTRYPOINT|USE_CCR_V2|PROXY_RESOLVES_HOSTS|WORKER_EPOCH|ENVIRONMENT_RUNNER_VERSION)|CLAUDE_SESSION_INGRESS_TOKEN_FILE|SESSION_INGRESS_URL|CCR_.*|GLOBAL_AGENT_.*)$/;
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key))), HOME: home, MAX_THINKING_TOKENS: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const args = ['-p', '--model', model, '--effort', effort, '--system-prompt-file', path.join(work, 'system.txt'), '--tools', '',
      '--strict-mcp-config', ...(tools.length ? ['--mcp-config', path.join(work, 'mcp.json')] : []),
      ...(forced ? ['--json-schema', JSON.stringify({ ...forced.parameters, description: forced.description })] : []), '--output-format', 'stream-json', '--verbose',
      '--max-turns', '1', '--no-session-persistence', '--disable-slash-commands'];
    const startedAt = Date.now();
    const { code, events } = await runClaude(args, env, cwd, conversationText(rest));
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
    const result = events.find((event) => event.type === 'result');
    const assistants = events.filter((event) => event.type === 'assistant' && !event.parent_tool_use_id).map((event) => event.message);
    const limit = events.findLast((event) => event.type === 'rate_limit_event')?.rate_limit_info || null;
    const rejected = limit?.status === 'rejected';
    const blocks = assistants.flatMap((message) => message.content || []);
    const modelUsage = result?.modelUsage || {};
    const models = [...new Set([...Object.keys(modelUsage), ...assistants.map((message) => message.model)])];
    const ids = new Set(assistants.map((message) => message.id));
    const usage = {
      input_tokens: result?.usage?.input_tokens ?? null, cache_creation_input_tokens: result?.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result?.usage?.cache_read_input_tokens ?? 0, output_tokens: result?.usage?.output_tokens ?? null,
      output_tokens_details: { thinking_tokens: Object.values(modelUsage).reduce((sum, item) => sum + (item.thinkingTokens ?? 0), 0) },
      thinkingBlocks: blocks.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking').length
    };
    const offered = (init?.tools || []).filter((name) => name.startsWith(PREFIX)).map((name) => name.slice(PREFIX.length));
    const row = { at: new Date().toISOString(), models, effort, thinking: usage.output_tokens_details.thinking_tokens || usage.thinkingBlocks ? 'on' : 'off', usage,
      apiCalls: ids.size, numTurns: result?.num_turns ?? null, stopReason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : result?.stop_reason ?? null,
      durationMs: Date.now() - startedAt, rateLimit: limit ? { status: limit.status, utilization: limit.utilization ?? null } : null, staticPromptHash, toolCatalogHash, toolOrderHash: hash(JSON.stringify(offered)), tailChars: conversationText(rest).length };
    if (code !== 0 && !result || result?.is_error && result?.subtype !== 'error_max_turns' || rejected || result?.api_error_status) return fail('PLANNER_PROVIDER_ERROR', { ...row, status: result?.api_error_status ?? null });
    // CLI araçları kendi kararlı sırasıyla sunar: küme birebir aynı olmalı, sıra (toolOrderHash) çağrılar arasında sabit kalmalıdır.
    if (JSON.stringify([...offered].sort()) !== JSON.stringify(tools.map((tool) => tool.name).sort())) return fail('PLANNER_TOOLS_NOT_OFFERED', { ...row, offered });
    if (prior.some((item) => item.toolCatalogHash === toolCatalogHash && item.toolOrderHash && item.toolOrderHash !== row.toolOrderHash)) return fail('PLANNER_TOOL_ORDER_UNSTABLE', row);
    const first = prior.find((item) => !item.error && item.staticPromptHash === staticPromptHash && item.toolCatalogHash === toolCatalogHash);
    if (process.env.PLANNER_CLAUDE_REQUIRE_CACHE === '1' && first && !usage.cache_read_input_tokens) return fail('PLANNER_CACHE_NOT_REUSED', row);
    if (row.apiCalls !== 1) return fail('PLANNER_CALL_COUNT_UNEXPECTED', row);
    if (log) appendFileSync(log, `${JSON.stringify(row)}\n`);
    const toolCalls = blocks.filter((block) => block.type === 'tool_use' && (block.name.startsWith(PREFIX) || forced && block.name === 'StructuredOutput'))
      .map((block) => ({ name: block.name === 'StructuredOutput' ? forced.name : block.name.slice(PREFIX.length), arguments: block.input ?? {} }));
    const stop = row.stopReason;
    process.stdout.write(`${JSON.stringify({
      text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''), toolCalls,
      finishReason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : stop || null, usage, models, thinking: row.thinking
    })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'mcp') serveTools(process.argv[3]);
else await complete();
