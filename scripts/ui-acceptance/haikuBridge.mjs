/**
 * UI kabulü için OpenAI uyumlu yerel uç (yalnızca 127.0.0.1). Uygulamanın üretim sağlayıcı bağdaştırıcısının gönderdiği
 * her /v1/chat/completions isteği deponun nitelendirilmiş Claude CLI bağdaştırıcısına (scripts/planner-claude-model.mjs)
 * iletilir: model kimliği her çağrıda claude-haiku-4-5-20251001 olarak doğrulanır, düşünme kapalıdır (0 belirteç), tek API
 * çağrısıdır. Başka bir model istenirse istek reddedilir ve devir girişimi olarak sayılır. İçerik günlüğe yazılmaz.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('../planner-claude-model.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PORT = Number(process.env.BRIDGE_PORT || 18731);
const MODEL = 'claude-haiku-4-5-20251001';
const LEDGER = process.env.BRIDGE_LEDGER;
const CALLS = process.env.BRIDGE_CALLS;
let queue = Promise.resolve();
let sequence = 0;

const record = (row) => { if (CALLS) appendFileSync(CALLS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); };

function toAdapter(body) {
  const messages = (body.messages || []).map((message) => {
    if (message.role === 'assistant') {
      return { role: 'assistant', content: message.content ?? '', ...(message.tool_calls?.length
        ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? '{}' })) } : {}) };
    }
    if (message.role === 'tool') return { role: 'tool', toolCallId: message.tool_call_id, content: message.content ?? '' };
    return { role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') };
  });
  const tools = (body.tools || []).map((tool) => ({ name: tool.function?.name, description: tool.function?.description || '', parameters: tool.function?.parameters || { type: 'object' } }));
  const choice = body.tool_choice;
  const toolChoice = !tools.length || choice === 'none' ? 'none' : choice?.function?.name ? { name: choice.function.name } : 'auto';
  return { messages, tools, toolChoice, ...(Number.isSafeInteger(body.max_tokens) ? { maxOutputTokens: body.max_tokens } : {}) };
}

function runAdapter(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADAPTER], {
      cwd: ROOT,
      env: { ...process.env, PLANNER_CLAUDE_MODEL: MODEL, PLANNER_CLAUDE_EFFORT: 'low', PLANNER_CLAUDE_LOG: LEDGER,
        PLANNER_CLAUDE_MAX_CALLS: process.env.BRIDGE_MAX_CALLS || '150', PLANNER_CLAUDE_MAX_UNCACHED: process.env.BRIDGE_MAX_UNCACHED || '900000' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      let parsed = null;
      try { parsed = line ? JSON.parse(line) : null; } catch { parsed = null; }
      resolve({ code, parsed, err: err.slice(0, 300) });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function complete(body) {
  const id = ++sequence;
  const input = toAdapter(body);
  const purpose = input.tools.length ? 'plan' : 'compose';
  const startedAt = Date.now();
  const { code, parsed, err } = await runAdapter(input);
  const ms = Date.now() - startedAt;
  if (!parsed || !parsed.models) {
    record({ id, purpose, ok: false, code, ms, error: parsed?.error || err.split('\n')[0] || 'NO_OUTPUT' });
    return null;
  }
  const usage = parsed.usage || {};
  const thinking = usage.output_tokens_details?.thinking_tokens ?? null;
  record({ id, purpose, ok: true, ms, models: parsed.models, thinking: parsed.thinking, thinkingTokens: thinking, thinkingBlocks: usage.thinkingBlocks ?? null,
    finish: parsed.finishReason, toolCalls: (parsed.toolCalls || []).map((call) => call.name), input: usage.input_tokens, cacheWrite: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens, output: usage.output_tokens, maxTokens: input.maxOutputTokens ?? null });
  // Yalnızca yerel tanı (sentetik veri): son çıktılar karalama klasöründe; rapora ve depoya girmez.
  if (process.env.BRIDGE_DEBUG) appendFileSync(process.env.BRIDGE_DEBUG, `${JSON.stringify({ id, purpose, text: parsed.text, toolCalls: parsed.toolCalls })}
`);
  const toolCalls = (parsed.toolCalls || []).map((call, index) => ({ id: `call_${id}_${index + 1}`, type: 'function',
    function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) } }));
  const prompt = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return {
    id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: parsed.models[0],
    choices: [{ index: 0, message: { role: 'assistant', content: parsed.text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : parsed.finishReason === 'length' ? 'length' : 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: usage.output_tokens ?? 0, total_tokens: prompt + (usage.output_tokens ?? 0),
      completion_tokens_details: { reasoning_tokens: thinking ?? 0 } }
  };
}

const server = http.createServer((request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method === 'GET' && request.url.endsWith('/models')) return send(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) return send(404, { error: { message: 'not found' } });
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { error: { message: 'bad json' } }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: { message: 'bad json' } });
    if (body.model !== MODEL) {
      record({ purpose: 'escalation-attempt', ok: false, requestedModel: String(body.model).slice(0, 80) });
      return send(400, { error: { message: 'only the qualification model is served' } });
    }
    queue = queue.then(async () => {
      const result = await complete(body);
      if (!result) send(503, { error: { message: 'model call failed' } });
      else send(200, result);
    }).catch(() => send(500, { error: { message: 'bridge error' } }));
  });
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`bridge listening ${server.address().port}\n`));
