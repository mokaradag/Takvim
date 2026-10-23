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
 * PLANNER_CLAUDE_LOG (çağrı başına içeriksiz ölçüm satırı; bütçe ve önbellek kapısının durumu), PLANNER_CLAUDE_MAX_CALLS, PLANNER_CLAUDE_MAX_UNCACHED
 * (önbellekten okunmayan girdi belirteçlerinin toplam üst sınırı), PLANNER_CLAUDE_REQUIRE_CACHE=1 (aynı önekle ikinci
 * çağrıdan sonra önbellek okuması zorunlu). Ev klasörü yalıtıldığı için CLI'nin kayıtlı oturumu görünmez; kimlik bilgisi
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ya da CLAUDE_CODE_OAUTH_TOKEN (ya da barındırılan oturumun ortamı) ile verilir.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
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
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    let row;
    try { row = JSON.parse(line); } catch { /* Eksik bütçe geçmişiyle model çağrılmaz. */ }
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || row.reserved !== true && !row.usage && typeof row.error !== 'string'
      || row.reserved !== undefined && row.reserved !== true
      || row.usage != null && (typeof row.usage !== 'object' || Array.isArray(row.usage)
        || ['input_tokens', 'cache_creation_input_tokens'].some(key => row.usage[key] != null && (!Number.isSafeInteger(row.usage[key]) || row.usage[key] < 0)))) {
      throw Object.assign(new Error('ledger'), { code: 'PLANNER_BUDGET_UNVERIFIED' });
    }
    return row;
  });
}

/** Pozitif tam sayı ortam sınırı; geçersiz değer sınırı kapatmaz, koşuyu durdurur. */
function limitFromEnv(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  if (!/^[1-9][0-9]{0,11}$/.test(value)) throw Object.assign(new Error(name), { code: 'PLANNER_LIMIT_INVALID' });
  return Number.parseInt(value, 10);
}

/** Yalnızca bu sahibin dosyasını kaldırır; yeni sahibin dolu dizini silinemez. */
function releaseLock(lock, owner) {
  try { if (owner) unlinkSync(path.join(lock, owner)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

/** PID yeniden kullanılsa da aynı süreç örneği olduğu doğrulanır. */
function processIdentity(pid, expected = null, timeoutMs = 120000) {
  if (process.platform === 'linux') {
    try {
      const recorded = /^linux:[0-9a-f-]{36}:([0-9]+):[0-9]+$/.exec(expected || '');
      const stat = readFileSync(expected ? `/proc/${recorded?.[1] || pid}/stat` : '/proc/self/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      const start = fields[19];
      if (!/^[0-9]+$/.test(start)) throw new Error('PLANNER_LEDGER_OWNER_UNVERIFIED');
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(0, stat.indexOf(' '))}:${start}`;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; if (error.code !== 'EPERM') throw error; }
  const result = process.platform === 'win32'
    ? spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; try { [System.Diagnostics.Process]::GetProcessById([int]$env:ROTA_LOCK_OWNER_PID).StartTime.ToUniversalTime().Ticks } catch { exit 3 }"],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, ROTA_LOCK_OWNER_PID: String(pid) } })
    : spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' } });
  if (result.error?.code === 'ETIMEDOUT') throw Object.assign(new Error('lock'), { code: 'PLANNER_LEDGER_LOCKED' });
  const identity = result.stdout?.trim();
  if (result.status === 0 && identity) return identity;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  throw new Error('PLANNER_LEDGER_OWNER_UNVERIFIED');
}

/** Kilit sahipliği atomik yayımlanır; bekleme bütçesi model yürütmesinden ayrıdır. */
async function withLock(file, work, timeoutMs) {
  const lock = `${file}.lock`;
  const candidate = mkdtempSync(`${lock}-`);
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = performance.now() + timeoutMs;
  try {
    const identity = processIdentity(process.pid, null, timeoutMs);
    if (!identity) throw new Error('PLANNER_LEDGER_OWNER_UNVERIFIED');
    writeFileSync(path.join(candidate, owner), JSON.stringify({ pid: process.pid, identity }));
    for (;;) {
      try { renameSync(candidate, lock); break; } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || performance.now() >= deadline) throw Object.assign(new Error('lock'), { code: 'PLANNER_LEDGER_LOCKED' });
        try {
          const owners = readdirSync(lock);
          if (!owners.length) releaseLock(lock, null); // Eski sürümün sahipsiz kilidi.
          for (const name of owners) {
            if (!/^[1-9][0-9]*-[0-9a-f-]{36}$/.test(name)) continue;
            const record = JSON.parse(readFileSync(path.join(lock, name), 'utf8'));
            const pid = typeof record === 'number' ? record : record.pid;
            if (!Number.isSafeInteger(pid) || pid < 1) continue;
            if (typeof record === 'number') {
              try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') releaseLock(lock, name); else if (error.code !== 'EPERM') throw error; }
              continue;
            }
            const current = processIdentity(pid, record.identity, Math.max(1, Math.floor(deadline - performance.now())));
            if (current === null || record.identity && record.identity !== current) releaseLock(lock, name);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await work(); } finally { releaseLock(lock, owner); }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

export const MODEL_CLEANUP_TIMEOUT_MS = 5000;

/** Grup üyesi, lider düşse de grup kimliğini tutarak kalan komutu sonlandırır. */
function monitorModelCommand() {
  let group = null;
  process.once('disconnect', () => { if (group) process.kill(-group, 'SIGKILL'); else process.exit(1); });
  process.once('message', ({ command, args, shell, groupId }) => {
    group = groupId;
    process.env.ROTA_MODEL_COMMAND_OWNER = String(group);
    const child = spawn(command, args, { shell, stdio: 'inherit' });
    let launchFailed = false;
    child.once('error', () => { launchFailed = true; });
    child.once('close', code => {
      let remaining = 2;
      const flushed = () => { if (!--remaining) process.send({ type: 'model-command-complete', code: launchFailed ? -1 : code, launchFailed }, error => { if (error) process.kill(-group, 'SIGKILL'); }); };
      process.stdout.end(flushed);
      process.stderr.end(flushed);
    });
  });
  process.channel.ref();
}

/** İç IPC modele geçmez; sahip ve gözetmen birbirinin kaybında aynı grubu temizler. */
function ownModelCommand() {
  const stop = () => process.kill(-process.pid, 'SIGKILL');
  process.once('disconnect', stop);
  process.once('message', ({ command, args, shell, pipedStderr }) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ROTA_MODEL_COMMAND_OWNER: 'monitor' }, stdio: ['inherit', 'pipe', 'pipe', 'ipc', 4]
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once('error', stop);
    child.once('exit', stop);
    let completion = null;
    let ended = 0;
    const publish = () => {
      if (!completion || ended !== 2) return;
      let remaining = 2;
      const flushed = () => { if (!--remaining) process.send(completion, error => { if (error) stop(); }); };
      process.stdout.end(flushed);
      if (pipedStderr) process.stderr.end(flushed);
      else process.stderr.write('', flushed);
    };
    child.stdout.once('end', () => { ended += 1; publish(); });
    child.stderr.once('end', () => { ended += 1; publish(); });
    child.once('message', value => { completion = value; publish(); });
    child.send({ command, args, shell, groupId: process.pid }, error => { if (error) stop(); });
  });
  // Lider ve gözetmen, başlatanın grup temizliğine kadar yaşar.
  process.channel.ref();
}

/** Mevcut komutu aynı yeteneklerle çalıştırır; POSIX grup lideri sonuçtan sonra yeniden kullanılamaz. */
export function spawnModelCommand(command, args, options) {
  if (process.platform === 'win32' || process.env.ROTA_MODEL_COMMAND_OWNER) {
    const child = spawn(command, args, { ...options, detached: false });
    Object.defineProperty(child, 'modelCommandGroup', { value: false });
    child.once('close', code => child.emit('command-close', code));
    return child;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    ...options, shell: false, detached: true,
    env: { ...options.env, ROTA_MODEL_COMMAND_OWNER: 'supervisor' },
    stdio: [...options.stdio, 'ipc', 'pipe']
  });
  // Gözetmenin de tuttuğu uç kapanmadan ChildProcess.close tamamlanamaz.
  child.stdio?.[4]?.resume();
  let completion = null;
  let stdoutEnded = false;
  let stderrEnded = !child.stderr;
  const completed = () => {
    if (completion && stdoutEnded && stderrEnded) {
      const code = completion.code;
      const launchFailed = completion.launchFailed === true;
      completion = null;
      child.emit('command-close', code, launchFailed);
    }
  };
  child.stdout.once('end', () => { stdoutEnded = true; completed(); });
  child.stderr?.once('end', () => { stderrEnded = true; completed(); });
  child.once('message', value => {
    if (value?.type !== 'model-command-complete' || !(value.code === null || Number.isInteger(value.code))) {
      child.emit('error', new Error('MODEL_COMMAND_ERROR'));
      return;
    }
    completion = value;
    completed();
  });
  child.send({ command, args, shell: options.shell === true, pipedStderr: Boolean(child.stderr) }, error => { if (error) child.emit('error', error); });
  return child;
}

const cleanupCommand = (command, args) => new Promise((resolveCleanup, rejectCleanup) => {
  const killer = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  let done = false;
  const finishCleanup = (error) => {
    if (done) return;
    done = true;
    clearTimeout(cleanupTimer);
    if (error) rejectCleanup(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_CLEANUP_ERROR', { cause: error }));
    else resolveCleanup();
  };
  const cleanupTimer = setTimeout(() => {
    try { killer.kill('SIGKILL'); } catch { /* Başarısız temizleme aşağıda raporlanır. */ }
    finishCleanup(new Error('cleanup timeout'));
  }, MODEL_CLEANUP_TIMEOUT_MS);
  killer.once('error', finishCleanup);
  killer.once('close', (code) => finishCleanup(code === 0 ? null : new Error('cleanup exit')));
});

/** Geliştirme komutunun temizleme sahibi: Windows ağacı ya da POSIX süreç/grup. */
export async function terminateModelCommand(child, { group = true } = {}) {
  const exited = child.exitCode !== null || child.signalCode !== null;
  const ownerPipe = child.stdio?.[4];
  if (!child.pid || ownerPipe?.closed || exited && !ownerPipe) return;
  if (process.platform === 'win32') {
    try { await cleanupCommand('taskkill', ['/pid', String(child.pid), '/T', '/F']); }
    catch {
      // Kök süreçten önce çocukları durdur; taskkill'in çıkışı da temizleme sonucuna dahildir.
      const script = `$ErrorActionPreference='Stop'; function Stop-Tree([int]$ownerId) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownerId" | ForEach-Object { Stop-Tree $_.ProcessId }; if (Get-Process -Id $ownerId -ErrorAction SilentlyContinue) { Stop-Process -Id $ownerId -Force } }; Stop-Tree ${child.pid}`;
      try { await cleanupCommand(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script]); }
      catch (error) {
        try { child.kill('SIGKILL'); } catch { /* Ağaç temizleme hatası korunur. */ }
        throw error;
      }
    }
  } else {
    await new Promise((resolve, reject) => {
      const completion = ownerPipe || child;
      const finish = error => {
        clearTimeout(timer);
        completion.off('close', closed); completion.off('error', failed);
        if (error) reject(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_CLEANUP_ERROR', { cause: error }));
        else resolve();
      };
      const closed = () => finish();
      const failed = error => finish(error);
      const timer = setTimeout(() => finish(new Error('cleanup timeout')), MODEL_CLEANUP_TIMEOUT_MS);
      completion.once('close', closed); completion.once('error', failed);
      try { if (!exited) process.kill(group && child.modelCommandGroup !== false ? -child.pid : child.pid, 'SIGKILL'); }
      catch (error) { finish(error.code === 'ESRCH' ? null : error); }
    });
  }
}

function runClaude(args, env, cwd, input, { command = 'claude', prefixArgs = [] }, timeoutMs) {
  return new Promise((resolve) => {
    // npm'nin sabit Claude girişini Node ile aç: .cmd içeriği ve model argümanları kabukta yorumlanmaz.
    if (process.platform === 'win32' && command === 'claude') {
      for (const directory of (env.PATH || '').split(';').filter(Boolean)) {
        const native = path.join(directory, 'claude.exe');
        if (existsSync(native)) { command = native; break; }
        const packaged = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(path.join(directory, 'claude.cmd')) && existsSync(packaged)) { command = packaged; break; }
        const entry = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (existsSync(path.join(directory, 'claude.cmd')) && existsSync(entry)) { command = process.execPath; prefixArgs = [entry]; break; }
      }
    }
    const child = spawnModelCommand(command, [...prefixArgs, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let launched = false;
    let timedOut = false;
    let cleanup = null;
    let settled = false;
    let stopping = false;
    const removeSignals = () => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup);
    };
    const stop = async code => {
      if (stopping) return;
      stopping = true;
      settled = true;
      clearTimeout(timer);
      cleanup ||= terminateModelCommand(child);
      try { await cleanup; } catch { code = 1; }
      removeSignals();
      process.exit(code);
    };
    const interrupt = () => stop(130);
    const terminate = () => stop(143);
    const hangup = () => stop(129);
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); process.once('SIGHUP', hangup);
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup ||= terminateModelCommand(child);
      let cleanupFailed = false;
      try { await cleanup; } catch { cleanupFailed = true; }
      removeSignals();
      if (!stopping) resolve({ ...result, timedOut, cleanupFailed });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cleanup = terminateModelCommand(child);
      finish({ code: -1, events });
    }, timeoutMs);
    child.once('spawn', () => { launched = true; });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try { events.push(JSON.parse(line)); } catch { /* CLI dışı satır */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ code: -1, events, launchFailed: !launched }));
    child.on('command-close', (code, launchFailed = false) => {
      if (settled) return;
      buffer += decoder.end();
      if (buffer.trim()) {
        try { events.push(JSON.parse(buffer)); } catch { /* CLI dışı son satır */ }
      }
      finish({ code, events, launchFailed });
    });
    child.on('close', () => { if (!settled) finish({ code: -1, events }); });
    child.stdin.end(input);
  });
}

function reportFailure(log, error, extra = {}) {
  if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), error, ...extra })}\n`);
  process.stdout.write(`${JSON.stringify({ text: '', toolCalls: [], error })}\n`);
}

async function complete(launcher, timeoutMs) {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const model = process.env.PLANNER_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const effort = process.env.PLANNER_CLAUDE_EFFORT || 'low';
  const log = process.env.PLANNER_CLAUDE_LOG || null;
  const fail = (error, extra) => reportFailure(log, error, extra);
  const [system, ...rest] = payload.messages;
  if (system?.role !== 'system') return fail('PLANNER_SYSTEM_MISSING');
  const all = payload.toolChoice === 'none' ? [] : payload.tools;
  // Zorunlu adlı araç (üretimde OpenAI uyumlu adlı işlev seçimi) CLI'nin yapılandırılmış çıktısıyla verilir: yanıt o aracın şemasıdır.
  const forced = payload.toolChoice?.name ? all.find((tool) => tool.name === payload.toolChoice.name) || null : null;
  const tools = forced ? all.filter((tool) => tool !== forced) : all;
  const staticPromptHash = hash(system.content);
  const toolCatalogHash = hash(JSON.stringify([forced?.name ?? null, all]));
  let maxCalls;
  let maxUncached;
  try { maxCalls = limitFromEnv('PLANNER_CLAUDE_MAX_CALLS'); maxUncached = limitFromEnv('PLANNER_CLAUDE_MAX_UNCACHED'); } catch (error) { return fail(error.code); }
  // Çağrılar arası denetimlerin durumu kayıt dosyasıdır: kayıt yoksa sınır ya da önbellek kapısı sessizce kapanmaz.
  if (!log && (maxCalls || maxUncached || process.env.PLANNER_CLAUDE_REQUIRE_CACHE === '1')) return fail('PLANNER_LEDGER_REQUIRED');
  const prior = log ? ledger(log) : [];
  const callId = log ? randomUUID() : null;
  if (log) {
    // Kilit, ayırımdan kullanım kaydına dek tutulur; sonraki çağrı tamamlanan harcamayı görür.
    const reservations = prior.filter((row) => row.reserved);
    if (maxCalls && reservations.length >= maxCalls) return fail('PLANNER_BUDGET_CALLS');
    const measured = prior.filter((row) => row.usage && Number.isSafeInteger(row.usage.input_tokens) && row.usage.input_tokens >= 0
      && Number.isSafeInteger(row.usage.cache_creation_input_tokens) && row.usage.cache_creation_input_tokens >= 0);
    if (maxUncached && (reservations.some((row) => row.callId && !measured.some((item) => item.callId === row.callId))
      || reservations.filter((row) => !row.callId).length > measured.filter((row) => !row.callId).length)) return fail('PLANNER_BUDGET_UNVERIFIED');
    const uncached = measured.reduce((sum, row) => sum + row.usage.input_tokens + row.usage.cache_creation_input_tokens, 0);
    if (maxUncached && uncached >= maxUncached) return fail('PLANNER_BUDGET_TOKENS');
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), reserved: true, callId })}\n`);
  }

  // Kararlı yalıtılmış ev ve çalışma klasörü: depo bağlamı, kullanıcı ayarı ya da proje yönergesi modele girmez.
  const home = process.env.PLANNER_CLAUDE_HOME || path.join(tmpdir(), 'rota-planner-claude-home');
  const cwd = path.join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const work = mkdtempSync(path.join(home, 'call-'));
  try {
    writeFileSync(path.join(work, 'system.txt'), system.content, 'utf8');
    writeFileSync(path.join(work, 'tools.json'), JSON.stringify(tools), 'utf8');
    writeFileSync(path.join(work, 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp', path.join(work, 'tools.json')] } } }), 'utf8');
    const keep = /^(PATH|LANG|LC_ALL|TZ|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_(REMOTE.*|PROVIDER_MANAGED_BY_HOST|ORGANIZATION_UUID|ACCOUNT_UUID|CONTAINER_ID|ENTRYPOINT|USE_CCR_V2|PROXY_RESOLVES_HOSTS|WORKER_EPOCH|ENVIRONMENT_RUNNER_VERSION)|CLAUDE_SESSION_INGRESS_TOKEN_FILE|SESSION_INGRESS_URL|CCR_.*|GLOBAL_AGENT_.*)$/;
    const windows = process.platform === 'win32'
      ? Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|ComSpec|PATHEXT)$/i.test(key))) : {};
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key))), ...windows, PATH: process.env.PATH || '', HOME: home,
      ...(process.platform === 'win32' ? { USERPROFILE: home } : {}), MAX_THINKING_TOKENS: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const args = ['-p', '--model', model, '--effort', effort, '--system-prompt-file', path.join(work, 'system.txt'), '--tools', '',
      '--strict-mcp-config', ...(tools.length ? ['--mcp-config', path.join(work, 'mcp.json')] : []),
      ...(forced ? ['--json-schema', JSON.stringify({ ...forced.parameters, description: forced.description })] : []), '--output-format', 'stream-json', '--verbose',
      '--max-turns', '1', '--no-session-persistence', '--disable-slash-commands'];
    const startedAt = Date.now();
    const { code, events, launchFailed, timedOut, cleanupFailed } = await runClaude(args, env, cwd, conversationText(rest), launcher, timeoutMs);
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
      input_tokens: result?.usage?.input_tokens ?? (launchFailed ? 0 : null), cache_creation_input_tokens: result?.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result?.usage?.cache_read_input_tokens ?? 0, output_tokens: result?.usage?.output_tokens ?? null,
      output_tokens_details: { thinking_tokens: Object.values(modelUsage).reduce((sum, item) => sum + (item.thinkingTokens ?? 0), 0) },
      thinkingBlocks: blocks.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking').length
    };
    const offered = (init?.tools || []).filter((name) => name.startsWith(PREFIX)).map((name) => name.slice(PREFIX.length));
    const row = { at: new Date().toISOString(), ...(callId ? { callId } : {}), models, effort, thinking: usage.output_tokens_details.thinking_tokens || usage.thinkingBlocks ? 'on' : 'off', usage,
      apiCalls: ids.size, numTurns: result?.num_turns ?? null, stopReason: !forced && blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : result?.stop_reason ?? null,
      durationMs: Date.now() - startedAt, rateLimit: limit ? { status: limit.status, utilization: limit.utilization ?? null } : null, staticPromptHash, toolCatalogHash, toolOrderHash: hash(JSON.stringify(offered)), tailChars: conversationText(rest).length };
    if (timedOut) return fail(cleanupFailed ? 'MODEL_COMMAND_TIMEOUT MODEL_COMMAND_CLEANUP_ERROR' : 'MODEL_COMMAND_TIMEOUT', row);
    if (cleanupFailed) return fail('MODEL_COMMAND_CLEANUP_ERROR', row);
    // --max-turns 1 ends a native tool handoff with this documented CLI status; it is not a failed completion.
    const toolHandoff = !forced && code === 1 && result?.is_error === true && result.subtype === 'error_max_turns'
      && blocks.some(block => block.type === 'tool_use' && block.name?.startsWith(PREFIX));
    if (code !== 0 && !toolHandoff || !result || result.is_error && result.subtype !== 'error_max_turns' || rejected || result.api_error_status) return fail('PLANNER_PROVIDER_ERROR', { ...row, status: result?.api_error_status ?? null });
    // CLI araçları kendi kararlı sırasıyla sunar: küme birebir aynı olmalı, sıra (toolOrderHash) çağrılar arasında sabit kalmalıdır.
    if (JSON.stringify([...offered].sort()) !== JSON.stringify(tools.map((tool) => tool.name).sort())) return fail('PLANNER_TOOLS_NOT_OFFERED', { ...row, offered });
    if (prior.some((item) => item.toolCatalogHash === toolCatalogHash && item.toolOrderHash && item.toolOrderHash !== row.toolOrderHash)) return fail('PLANNER_TOOL_ORDER_UNSTABLE', row);
    const first = prior.find((item) => {
      const ageMs = Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? startedAt - (Date.parse(item.at) - item.durationMs) : NaN;
      return !item.error && item.staticPromptHash === staticPromptHash && item.toolCatalogHash === toolCatalogHash
        && ageMs >= 0 && ageMs < 5 * 60 * 1000;
    });
    if (process.env.PLANNER_CLAUDE_REQUIRE_CACHE === '1' && first && !usage.cache_read_input_tokens) return fail('PLANNER_CACHE_NOT_REUSED', row);
    if (row.apiCalls !== 1) return fail('PLANNER_CALL_COUNT_UNEXPECTED', row);
    if (!models.length || models.some((item) => item !== model)) return fail('PLANNER_MODEL_MISMATCH', row);
    if (row.thinking !== 'off') return fail('PLANNER_THINKING_ON', row);
    if (log) appendFileSync(log, `${JSON.stringify(row)}\n`);
    // Zorunlu turda öteki araçlar yalnızca görünürdür (üretimdeki gibi); üretimin kısıtlı çözümü başka çağrı üretemez, burada da iletilmez.
    const structured = !result.is_error && result.structured_output && typeof result.structured_output === 'object' && !Array.isArray(result.structured_output);
    const toolCalls = forced ? structured ? [{ name: forced.name, arguments: result.structured_output }] : []
      : blocks.filter((block) => block.type === 'tool_use' && block.name.startsWith(PREFIX))
        .map((block) => ({ name: block.name.slice(PREFIX.length), arguments: block.input ?? {} }));
    const stop = row.stopReason;
    process.stdout.write(`${JSON.stringify({
      text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''), toolCalls,
      finishReason: forced && toolCalls.length || stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length'
        : stop === 'refusal' ? 'content_filter' : stop === 'pause_turn' ? 'stop' : stop || null, usage, models, thinking: row.thinking
    })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function runAdapter(launcher = {}) {
  const log = process.env.PLANNER_CLAUDE_LOG || null;
  let timeoutMs;
  try { timeoutMs = limitFromEnv('PLANNER_MODEL_TIMEOUT_MS') ?? 120000; } catch (error) { return reportFailure(log, error.code); }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 600000) return reportFailure(log, 'PLANNER_LIMIT_INVALID');
  const run = () => complete(launcher, timeoutMs);
  try { await (log ? withLock(log, run, timeoutMs) : run()); } catch (error) {
    if (!['PLANNER_LEDGER_LOCKED', 'PLANNER_BUDGET_UNVERIFIED'].includes(error.code)) throw error;
    reportFailure(log, error.code);
  }
}

const direct = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (direct) {
  if (process.argv[2] === 'mcp') serveTools(process.argv[3]);
  else if (process.send && process.env.ROTA_MODEL_COMMAND_OWNER === 'supervisor') ownModelCommand();
  else if (process.send && process.env.ROTA_MODEL_COMMAND_OWNER === 'monitor') monitorModelCommand();
  else await runAdapter();
}
