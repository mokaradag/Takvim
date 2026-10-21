/**
 * Rota AI planlayıcı değerlendirmesi (Aşama 4C) — geliştirme aracı; uygulama, CI ve Rota sunucusu bu dosyayı
 * çalıştırmaz.
 *
 *   node scripts/planner-evaluation.mjs run (--model-command '<komut>' | --model live) [--semantic kosu.json|none|live]
 *        [--passes 3] [--concurrency 4] [--cases tr-001,tr-002] [--out sonuc.json] [--inputs klasor] [--json]
 *     Kıyas kümesinin her vakasını ÜRETİMDEKİ planlama sınırından geçirir: sunucuya ait sistem yönergesi ve
 *     bağlam (`buildGroundedContext`), Aşama 4B anlamsal danışmanlığı (`semanticPlanningAdvice`), kayıt
 *     defteri araçları ve `rota_plan`, `runGroundedTurn` döngüsü (bildirim düzeltmeleri dâhil) ve aynı
 *     sunucu doğrulayıcıları. İlk SQL'den hemen önce (ya da açıklama/çekimserlik/genel yönlendirmeyle)
 *     tur durur; hiçbir Rota verisi okunmaz. Karar altın etiketlerle `planner-scoring.mjs` içinde puanlanır.
 *
 *     Model, verilen dış komutla çağrılır: stdin üretim turunun `session.round` girdisidir (`{ messages, tools,
 *     toolChoice }`), stdout `{ text, toolCalls, finishReason, usage, models, thinking: "off" }`. Komut modele kendi yerel araç çağırma
 *     arayüzünü verir ve araç yürütmez. Modele giden girdi vaka kimliği, beklenti ya da altın etiket taşıyamaz
 *     (her çağrıdan önce denetlenir). `--inputs` modele giden her girdiyi ve yanıtı denetim için yazar.
 *
 *     --semantic kosu.json : `semantic-model-qualification.py` koşu dosyası (gerçek model vektörleri);
 *                            adaylar üretimdeki 4A/4B sözleşmesiyle (dizin, ilk aşama, yeniden sıralama) kurulur.
 *     --semantic none      : anlamsal danışmanlık yok (profil kapalı) — Aşama 3 planlama sırası.
 *     --semantic live      : üretimdeki keşif hizmeti (ağ geçidi → `embedding`/`rerank` profilleri, 4B dizini).
 *     --model live         : planlayıcı, ağ geçidinin `chat.tools` araç oturumundaki kayıtlı modeldir.
 *
 *   node scripts/planner-evaluation.mjs live [--passes N] [--cases …] [--out …] [--json]
 *     Kurum içi kabul: `run --model live --semantic live` (ortam uygulamayla aynı kaynaktan, @next/env ile
 *     okunur; kurumsal anahtar kullanılır, kullanıcı oturumu yoktur, Rota verisi okunmaz).
 *
 *   node scripts/planner-evaluation.mjs report --run sonuc.json [--json]
 *     Kaydedilmiş koşuyu güncel altın etiketlerle yeniden puanlar (bayat koşu reddedilir).
 *   node scripts/planner-evaluation.mjs input [--out girdi.json]
 *     Anlamsal koşucu için kanonik ve ek 136 sorunun girdisini üretir.
 *
 * Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md §12
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';
import { readModelRun } from './semantic-evaluation.mjs';
import { loadPlannerBenchmark, PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, WEAK_PLANNER_MODEL, validCalendarDate, scorePlannerRun } from './planner-scoring.mjs';

registerServerOnlyShim();

const EVALUATION_SICIL = 900001;

const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { semanticPlanningAdvice } = await import('../src/server/ai/assistant/semanticPlanning.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel, getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { SEMANTIC_RETRIEVAL_DEPTH } = await import('../src/server/ai/semanticRetrieval.js');
const {
  applyRerankScores, createSemanticCatalogue, createSemanticIndex, rankSemanticIndex, semanticToolDefinitions
} = await import('../src/domain/ai/semanticContract.js');

function fail(message) {
  throw Object.assign(new Error(message), { code: message });
}

function parseArguments([command, ...rest]) {
  const flags = { passes: 1, concurrency: 4, semantic: 'none' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--json') flags.json = true;
    else if (flag === '--no-score') flags.noScore = true;
    else if (['--model-command', '--model', '--semantic', '--passes', '--concurrency', '--cases', '--out', '--inputs', '--run', '--reference-date', '--expected-model', '--model-timeout-ms', '--model-output-bytes'].includes(flag)) {
      if (rest[i + 1] == null || !String(rest[i + 1]).trim() || String(rest[i + 1]).startsWith('--')) fail(`${flag} bir değer gerektirir.`);
      flags[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[++i];
    } else fail(`Tanınmayan bağımsız değişken: ${flag}`);
  }
  if (command === 'live') Object.assign(flags, { model: 'live', semantic: 'live' });
  if ((flags.model === 'live' || command === 'live') && flags.modelCommand) fail('PLANNER_MODEL_SELECTORS_CONFLICT');
  if (flags.noScore && flags.out) fail('PLANNER_UNSCORED_OUTPUT_UNSUPPORTED');
  if (flags.model != null && flags.model !== 'live') fail('--model yalnızca live olabilir (dış model için --model-command).');
  flags.passes = Number(flags.passes);
  flags.concurrency = Number(flags.concurrency);
  if (!Number.isSafeInteger(flags.passes) || flags.passes < 1 || flags.passes > 10) fail('--passes 1–10 olmalıdır.');
  if (!Number.isSafeInteger(flags.concurrency) || flags.concurrency < 1 || flags.concurrency > 16) fail('--concurrency 1–16 olmalıdır.');
  // Referans gün varsayılan olarak koşunun UTC günüdür: dış model komutunun kendi ortam bilgisi de bu günü taşır.
  flags.explicitReferenceDate = Boolean(flags.referenceDate);
  flags.referenceDate ||= new Date().toISOString().slice(0, 10);
  if (!validCalendarDate(flags.referenceDate)) fail('--reference-date YYYY-MM-DD olmalıdır.');
  for (const [key, fallback, min, max] of [['modelTimeoutMs', 120000, 20, 600000], ['modelOutputBytes', 4 * 1024 * 1024, 1024, 8 * 1024 * 1024]]) {
    flags[key] = Number(flags[key] ?? fallback);
    if (!Number.isSafeInteger(flags[key]) || flags[key] < min || flags[key] > max) fail(`${key}: geçersiz sınır`);
  }
  if (flags.expectedModel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(flags.expectedModel)) fail('--expected-model geçersiz.');
  return { command, flags };
}

/* ── Modele giden metnin sızıntı denetimi ───────────────────────────── */

function leakGuard(benchmark) {
  const ids = benchmark.cases.map((testCase) => testCase.id);
  const authored = new Set();
  const argumentHash = value => {
    try { return createHash('sha256').update(JSON.stringify(JSON.parse(value))).digest('hex'); } catch { return null; }
  };
  const markers = [/\b(?:tr|pl)-\d{3}\b/, /ai-(?:semantic|planner)-benchmark/, /planner-scoring/];
  const goldKey = /"(?:needs|avoid|expect|gold)\\*"\s*:/;
  const inspect = (value, modelAuthored = false, assistant = false) => {
    if (typeof value === 'string') {
      if (markers.some((marker) => marker.test(value)) || !modelAuthored && goldKey.test(value) || ids.some((id) => value.includes(id))) {
        throw Object.assign(new Error('Modele giden metinde vaka kimliği ya da altın etiket izi bulundu; koşu durduruldu.'), { code: 'PLANNER_GOLD_LEAK' });
      }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        inspect(`"${key}":`, modelAuthored);
        inspect(item, modelAuthored || assistant && key === 'arguments' && authored.has(argumentHash(item)), assistant);
      }
    }
  };
  const guard = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return inspect(input);
    for (const [key, value] of Object.entries(input)) {
      inspect(`"${key}":`);
      // Yalnızca bu koşuda modelden alınan çağrı kendi çıktısıdır; geçmiş ve sunucu girdileri istisna değildir.
      if (key === 'messages' && Array.isArray(value)) value.forEach(message => inspect(message, false, message?.role === 'assistant'));
      else inspect(value);
    }
  };
  guard.observe = completion => {
    for (const call of completion.toolCalls || []) {
      const hash = argumentHash(call.arguments);
      if (hash) authored.add(hash);
    }
  };
  return guard;
}

const COMPLETION_REASONS = Object.freeze(['stop', 'end_turn', 'eos', 'stop_sequence', 'tool_calls', 'length', 'content_filter']);
const verifyCompletion = reason => { if (!COMPLETION_REASONS.includes(reason)) fail('PLANNER_COMPLETION_UNVERIFIED'); };

/** Belirteç şekilleri tek yerde normalleştirilir; bilinmeyen düşünme sayısı sıfır sayılmaz. */
function normalizedUsage(usage) {
  if (!usage) return null;
  const number = (...values) => values.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
  return {
    input_tokens: number(usage.input_tokens, usage.promptTokens, usage.inputTokens),
    cache_read_input_tokens: number(usage.cache_read_input_tokens) ?? 0,
    cache_creation_input_tokens: number(usage.cache_creation_input_tokens) ?? 0,
    output_tokens: number(usage.output_tokens, usage.completionTokens, usage.outputTokens),
    output_tokens_details: { thinking_tokens: number(usage.output_tokens_details?.thinking_tokens, usage.reasoningTokens, usage.thinkingTokens) },
    thinkingBlocks: number(usage.thinkingBlocks)
  };
}

function verifyModel(models, usage, expectedModel, thinkingMode) {
  const reject = (code) => { throw Object.assign(new Error(code), { code }); };
  if (!Array.isArray(models) || !models.length || models.some((model) => model !== expectedModel)) reject('PLANNER_MODEL_MISMATCH');
  if (thinkingMode !== 'off' || usage?.output_tokens_details?.thinking_tokens !== 0 || usage.thinkingBlocks != null && usage.thinkingBlocks !== 0) reject('PLANNER_THINKING_UNVERIFIED');
}

/* ── Model bağdaştırıcıları ─────────────────────────────────────────── */

/**
 * Dış model komutu: stdin üretim turunun girdisini (`{ messages, tools, toolChoice }`, OpenAI uyumlu iletiler ve
 * işlev araçları) alır; stdout `{ text, toolCalls: [{ name, arguments }], finishReason, usage, models, thinking: "off" }` yazar. Komut modele
 * kendi yerel araç çağırma biçimini verir (ör. bir sağlayıcının yerel araç arayüzü); araç yürütmez.
 */
function externalModel({ command, inputs, guard, timeoutMs = 120000, outputBytes = 4 * 1024 * 1024 }) {
  const workdir = mkdtempSync(path.join(tmpdir(), 'rota-planner-'));
  const active = new Set();
  const dispose = () => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup);
    for (const stop of active) stop();
    active.clear();
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  const interrupt = () => { try { dispose(); } finally { process.exit(130); } };
  const terminate = () => { try { dispose(); } finally { process.exit(143); } };
  const hangup = () => { try { dispose(); } finally { process.exit(129); } };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); process.once('SIGHUP', hangup);
  let sequence = 0;
  const run = (payload) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MERGEN_ROTA_/.test(key)));
    const child = spawn(command, { shell: true, detached: process.platform !== 'win32', cwd: process.cwd(), env: { ...env, TMPDIR: workdir, TEMP: workdir, TMP: workdir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let bytes = 0;
    let settled = false;
    const terminate = () => {
      if (process.platform === 'win32') {
        // Çıkmış kökün PID'si başka bir sürece atanmış olabilir.
        if (child.exitCode !== null || child.signalCode !== null) return;
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    active.add(terminate);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      // POSIX süreç grubu temizlenir; Windows ağacı yalnızca kök yaşarken sonlandırılır.
      terminate();
      active.delete(terminate);
      clearTimeout(timer);
      if (error) { reject(Object.assign(new Error(error), { code: error })); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish('MODEL_COMMAND_TIMEOUT'), timeoutMs);
    const capture = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > outputBytes) { finish('MODEL_COMMAND_OUTPUT_LIMIT'); return; }
      if (stdout) out.push(chunk);
    };
    child.stdout.on('data', (chunk) => capture(chunk, true));
    child.stderr.on('data', (chunk) => capture(chunk, false));
    child.on('error', () => finish('MODEL_COMMAND_ERROR'));
    child.stdin.on('error', () => finish('MODEL_COMMAND_ERROR'));
    child.on('close', (code) => finish(code === 0 ? null : 'MODEL_COMMAND_ERROR', Buffer.concat(out).toString('utf8')));
    child.stdin.end(payload);
  });
  return {
    async complete({ messages, tools, toolChoice }) {
      const payload = JSON.stringify({ messages, tools, toolChoice });
      guard({ messages, tools, toolChoice });
      const id = (sequence += 1);
      if (inputs) {
        const system = String(messages[0]?.role === 'system' ? messages[0].content : '');
        const hash = createHash('sha256').update(system).digest('hex').slice(0, 16);
        writeFileSync(path.join(inputs, `system-${hash}.txt`), system, 'utf8');
        writeFileSync(path.join(inputs, 'inputs.jsonl'), `${JSON.stringify({ call: id, system: hash, messages: messages.slice(1), tools: tools.map((tool) => tool.name), toolChoice })}\n`, { flag: 'a' });
      }
      const startedAt = Date.now();
      let reply;
      try { reply = JSON.parse(await run(payload)); } catch (error) { reply = { text: '', toolCalls: [], error: ['MODEL_COMMAND_TIMEOUT', 'MODEL_COMMAND_OUTPUT_LIMIT'].includes(error.code) ? error.code : 'MODEL_COMMAND_ERROR' }; }
      if (reply?.error) reply = { text: '', toolCalls: [], error: ['MODEL_COMMAND_TIMEOUT', 'MODEL_COMMAND_OUTPUT_LIMIT'].includes(reply.error) ? reply.error : 'MODEL_COMMAND_ERROR' };
      if (inputs) writeFileSync(path.join(inputs, 'completions.jsonl'), `${JSON.stringify({ call: id, error: reply?.error ?? null, usage: normalizedUsage(reply?.usage) })}\n`, { flag: 'a' });
      const toolCalls = (Array.isArray(reply?.toolCalls) ? reply.toolCalls : []).filter((call) => call && typeof call.name === 'string')
        .map((call, index) => ({ id: `call_${id}_${index + 1}`, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}), oversize: false }));
      guard.observe?.({ toolCalls });
      return { text: typeof reply?.text === 'string' ? reply.text : '', toolCalls, usage: normalizedUsage(reply?.usage), thinking: reply?.thinking === 'off' ? 'off' : 'unverified', models: Array.isArray(reply?.models) ? reply.models : [],
        finishReason: reply?.finishReason ?? null, error: reply?.error ?? null, durationMs: Date.now() - startedAt };
    },
    dispose
  };
}

/* ── Anlamsal danışmanlık ───────────────────────────────────────────── */

function catalogue() {
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  if (!built.ok) fail('Araç kataloğu geçersiz.');
  return built.catalogue;
}

/**
 * Gerçek model koşu dosyasından (vektörler, yeniden sıralama skorları) vaka başına aday listesi: üretimdeki
 * 4A sözleşmesi ve 4B derinliğiyle. Yeniden sıralama yoksa ya da geçersizse ilk aşama sırası (`first_stage`).
 */
function candidatesFromRun(file, benchmark) {
  let run;
  try { run = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('Anlamsal koşu dosyası okunamadı.'); }
  const items = catalogue();
  let trusted;
  try { trusted = readModelRun(run, { catalogue: items, benchmark: { fingerprint: benchmark.semanticFingerprint, cases: benchmark.cases } }); }
  catch (error) {
    // Yalnızca sabit doğrulayıcı nedenleri; ham iç hata ya da artifakt değeri gösterilmez.
    const reason = error?.code === 'SEMANTIC_RUN_REJECTED' ? error.message : null;
    throw Object.assign(new Error(`SEMANTIC_RUN_INVALID${reason ? `: ${reason}` : ''} (girdi: planner-evaluation.mjs input)`), { code: 'SEMANTIC_RUN_INVALID' });
  }
  const { space, documents, queries, rerank } = trusted;
  const index = createSemanticIndex(items, space, items.items.map((item, position) => ({ index: position, vector: documents.get(item.id).vector })));
  if (!index.ok) fail('SEMANTIC_VECTOR_INVALID');
  const result = new Map();
  for (const testCase of benchmark.cases) {
    const query = queries.get(testCase.id);
    if (query.failure === 'INFERENCE_FAILED') {
      result.set(testCase.id, { status: 'unavailable', candidates: [], failure: { reason: 'INFERENCE_FAILED' } });
      continue;
    }
    const ranked = rankSemanticIndex(index.index, { space, embeddings: [{ index: 0, vector: query.vector }], limit: Math.min(SEMANTIC_RETRIEVAL_DEPTH, items.items.length) });
    if (!ranked.ok) fail('SEMANTIC_VECTOR_INVALID');
    const outcome = rerank?.outcomes.get(testCase.id);
    if (outcome === 'ok') {
      const scores = rerank.scores.get(testCase.id);
      const reranked = applyRerankScores(ranked.candidates, ranked.candidates.map((candidate, index) => ({ index, score: scores.get(candidate.id).score })));
      if (!reranked.ok) fail('SEMANTIC_RERANK_SCORES_INVALID');
      result.set(testCase.id, { status: 'reranked', candidates: reranked.candidates, failure: null });
    } else {
      result.set(testCase.id, { status: 'first_stage', candidates: ranked.candidates, failure: rerank ? { reason: 'RERANK_FAILED' } : null });
    }
  }
  return { provenance: { model: run.embedding.model, provider: run.embedding.provider, preprocessing: run.embedding.preprocessing,
    runtime: run.embedding.runtime ?? null, reranker: run.rerank?.model ?? null }, byCase: result };
}

/* ── Planlama sınırı ────────────────────────────────────────────────── */

class PlanCaptured extends Error {}

/**
 * Tek vaka: üretimdeki planlama döngüsü ilk SQL'den önce durdurulur. Bağlam kimliği sentetiktir; tur
 * kanıt okumadan bittiği için SQL bağlamı hiç kullanılmaz.
 */
async function planCase({ testCase, model = null, runTurn = null, adviceFor, now, catalog, expectedModel = null }) {
  const built = buildGroundedContext({ history: testCase.history || [], userContent: testCase.text, now });
  let planning = { state: 'unavailable', candidates: [] };
  const decisions = [];
  const rounds = [];
  let captured = null;
  const options = {
    // "Notlar ve iletiler" açık: planlayıcı serbest metin isteyen soruda da planıyla değerlendirilir (kapalıyken
    // sunucunun sabit uyarısı ayrı sınamada).
    messages: built.messages, catalog, context: createToolTurnContext({ sicil: EVALUATION_SICIL, now }),
    allowedTextFields: [...(testCase.input?.allowedTextFields || [])],
    onText: async () => {}, deferDisclosure: true, escalation: false,
    onPlanned: (decision) => {
      decisions.push(decision);
      if (decision.intent === 'rota') { captured = decision; throw new PlanCaptured(); }
      if (decision.intent === 'general') throw new PlanCaptured();
    }
  };
  try {
    planning = await adviceFor(testCase);
    options.planning = planning;
    const result = await (runTurn || externalTurn(model, expectedModel))(options, rounds);
    if (result === CAPTURED) return { outcome: captured ? 'planned' : 'general_redirect', decisions, rounds, semantic: planning, plan: captured };
    return { outcome: result.outcome, decisions, rounds, semantic: planning };
  } catch (error) {
    if (error instanceof PlanCaptured) return { outcome: captured ? 'planned' : 'general_redirect', decisions, rounds, semantic: planning, plan: captured };
    return { outcome: 'error', error: typeof error?.code === 'string' ? error.code : 'ERROR', decisions, rounds, semantic: planning };
  }
}

const CAPTURED = Symbol('captured');

/** Dış model komutu: üretimdeki oturum sözleşmesinin ikizi; komutun kendi hatası modelin kararı sayılmaz. */
function externalTurn(model, expectedModel) {
  return (options, rounds) => runGroundedTurn(Object.freeze({
    sicil: EVALUATION_SICIL, profile: 'chat.tools', model: 'planner-under-test', reportedModel: () => null, maxOutputTokens: 4096,
    signal: new AbortController().signal, remainingMs: () => 600000,
    async round({ messages, tools, toolChoice }) {
      const completion = await model.complete({ messages, tools, toolChoice });
      completion.usage = normalizedUsage(completion.usage);
      rounds.push({ finishReason: completion.finishReason ?? null, thinkingMode: completion.thinking, durationMs: completion.durationMs, usage: completion.usage, models: completion.models, toolCalls: completion.toolCalls.length, error: completion.error });
      // Komutun kendi hatası (süreç, kimlik doğrulama, beklenmeyen model) modelin kararı değildir: vaka altyapı hatasıyla biter.
      if (completion.error) throw Object.assign(new Error(completion.error), { code: completion.error });
      if (expectedModel) {
        verifyModel(completion.models, completion.usage, expectedModel, completion.thinking);
        verifyCompletion(completion.finishReason);
      }
      return { text: completion.text, toolCalls: completion.toolCalls, finishReason: completion.finishReason ?? (completion.toolCalls.length ? 'tool_calls' : 'stop'), model: null,
        configuredModel: 'planner-under-test', modelMismatch: false, usage: null, durationMs: completion.durationMs, firstEventMs: null };
    }
  }), options);
}

/**
 * Üretim yolu: tur ağ geçidinin araç oturumunda (`chat.tools` profili, kayıtlı model, kapasite ve süre sınırı)
 * yürür. Ağ geçidi oturum içinden fırlayan her hatayı kendi hatasına çevirdiği için ilk SQL'den önceki durma
 * oturum içinde değer olarak döner.
 */
function liveTurn(gateway, expectedModel, guard, route) {
  return (options, rounds) => gateway.runToolSession({
    profile: 'chat.tools',
    run: async (session) => {
      const recording = Object.freeze({ ...session, async round(input) {
        guard({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice });
        const startedAt = Date.now();
        let thinking = false;
        let empty = null;
        let result;
        try { result = await session.round({ ...input, onEvent: async (event) => {
          if (event.type === 'thinking') thinking = true;
          return input.onEvent?.(event);
        } }); } catch (error) {
          if (error?.code !== 'AI_PROVIDER_RESPONSE_INVALID' || error.details?.reason !== 'EMPTY_COMPLETION') throw error;
          empty = error;
          result = { ...error.roundMeasurements, toolCalls: [] };
        }
        const model = session.reportedModel?.(result.model) ?? result.model;
        const usage = normalizedUsage(result.usage || {});
        // Kayıtlı düşünmesiz rota, olay gözlemi ve sağlayıcının eksik/sıfır kullanım biçimi birlikte doğrulanır.
        if (route?.thinking === 'off' && !thinking && usage.output_tokens_details.thinking_tokens == null) usage.output_tokens_details.thinking_tokens = 0;
        rounds.push({ finishReason: result.finishReason ?? null, thinkingMode: thinking ? 'on' : route?.thinking, durationMs: Date.now() - startedAt, models: [model].filter(Boolean),
          toolCalls: result.toolCalls.length, error: null, usage });
        if (session.model !== expectedModel || result.modelMismatch) fail('PLANNER_MODEL_MISMATCH');
        verifyModel([model], usage, expectedModel, thinking ? 'on' : route?.thinking);
        verifyCompletion(result.finishReason);
        if (empty) throw empty;
        guard.observe?.(result);
        return result;
      } });
      try { return await runGroundedTurn(recording, options); } catch (error) {
        if (error instanceof PlanCaptured) return CAPTURED;
        if (error?.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details?.reason === 'EMPTY_COMPLETION') return { outcome: 'failed' };
        // Ağ geçidi değerlendirme kodlarını yeniden sınıflandırmasın.
        if (typeof error?.code === 'string' && error.code.startsWith('PLANNER_')) return { evaluationError: error };
        throw error;
      }
    }
  }).then((result) => { if (result?.evaluationError) throw result.evaluationError; return result; });
}

/**
 * Kurum içi çalışma zamanı: ortam uygulamayla aynı kaynaktan okunur, ağ geçidi süreçteki gibi kurulur
 * (kurumsal anahtar, kullanıcı oturumu yok); anlamsal keşif üretimdeki hizmetin aynısıdır (4B dizini).
 */
async function liveRuntime() {
  const { loadDeploymentEnvironment, routeDiagnosticsToStderr } = await import('./semantic-evaluation.mjs');
  routeDiagnosticsToStderr();
  loadDeploymentEnvironment();
  const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
  const { createAiAdmissionController } = await import('../src/server/ai/admissionController.js');
  const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
  const { loadAiModelRegistry } = await import('../src/server/ai/modelRegistryLoader.js');
  const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
  const { createSemanticRetrieval } = await import('../src/server/ai/semanticRetrieval.js');
  const { AI_PROFILES, resolveModelProfile } = await import('../src/domain/ai/aiModelRegistry.js');
  const config = parseAiConfig(process.env);
  if (!config.available) fail(`Yapay zekâ yapılandırması kullanılamıyor (${config.enabled ? config.issues.join(', ') : 'MERGEN_ROTA_AI_ENABLED'}).`);
  if (!config.defaultApiKey) fail('Canlı değerlendirme kurumsal anahtarla çalışır: MERGEN_ROTA_AI_DEFAULT_API_KEY gerekli.');
  let registry;
  try { registry = await loadAiModelRegistry({ path: config.registryPath }); } catch { fail('Model kaydı yüklenemedi.'); }
  const planner = resolveModelProfile(registry, AI_PROFILES.CHAT_TOOLS);
  if (!planner.ok) fail(`chat.tools profili kullanılamıyor (${planner.reason}).`);
  const admission = createAiAdmissionController({ limits: config.limits });
  const provider = createOpenAiCompatibleProvider();
  const gateway = createAiGateway({
    getProvider: () => provider, getAdmission: () => admission, loadConfig: () => config, loadRegistry: async () => registry,
    currentSicil: async () => EVALUATION_SICIL, verifySicil: async () => {},
    resolveCredential: async () => ({ source: 'default', apiKey: config.defaultApiKey })
  });
  const retrieval = createSemanticRetrieval({ getGateway: () => gateway, loadRegistry: async () => registry });
  return { gateway, retrieval, maxActivePerUser: config.limits.maxActivePerUser, planner: { profile: AI_PROFILES.CHAT_TOOLS, model: planner.route.model, provider: planner.route.provider, thinking: planner.route.capabilities.includes('reasoning') ? 'unverified' : 'off' } };
}

/** Puanlama için içeriksiz, kararlı karar kaydı (istek nesneleri JSON'a güvenle çevrilir). */
function recordOf(testCase, pass, outcome) {
  const plan = outcome.plan ? {
    requests: outcome.plan.requests.map((request) => JSON.parse(JSON.stringify(request))),
    calls: outcome.plan.calls.map((call) => ({ name: call.name, args: call.args }))
  } : null;
  const terminal = outcome.decisions.find((decision) => ['clarify', 'abstain'].includes(decision.intent)) || null;
  return {
    case: testCase.id, pass, language: outcome.plan?.language ?? outcome.decisions.at(-1)?.language ?? null, outcome: outcome.outcome, error: outcome.error ?? null, plan,
    choice: terminal ? { intent: terminal.intent, reason: terminal.reason, ...(terminal.topics ? { topics: [...terminal.topics] } : {}) } : null,
    general: outcome.decisions.some((decision) => decision.intent === 'general'),
    declarations: outcome.decisions.at(-1)?.declarations ?? null,
    semantic: { state: outcome.semantic.state, candidates: [...outcome.semantic.candidates] },
    rounds: outcome.rounds.map((round) => ({ finishReason: round.finishReason ?? null, durationMs: round.durationMs, toolCalls: round.toolCalls,
      input: round.usage?.input_tokens != null ? round.usage.input_tokens + (round.usage.cache_read_input_tokens ?? 0) + (round.usage.cache_creation_input_tokens ?? 0) : null,
      output: round.usage?.output_tokens ?? null, thinking: round.usage?.output_tokens_details?.thinking_tokens ?? null,
      thinkingBlocks: round.usage?.thinkingBlocks ?? null, thinkingMode: round.thinkingMode ?? null, models: round.models, error: round.error ?? null }))
  };
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

async function runEvaluation(flags) {
  const loaded = loadPlannerBenchmark({ goldRequired: !flags.noScore, referenceDate: flags.referenceDate });
  const selected = flags.cases ? new Set(flags.cases.split(',').map((item) => item.trim())) : null;
  if (selected && [...selected].some((id) => !loaded.cases.some((testCase) => testCase.id === id))) fail('UNKNOWN_CASE_ID');
  const cases = loaded.cases.filter((testCase) => !selected || selected.has(testCase.id));
  if (!cases.length) fail('Seçilen vaka yok.');
  const now = loaded.now;
  const catalog = toolCatalogForModel();
  const guard = leakGuard(loaded);
  let semanticProvenance = null;
  let adviceFor;
  const runtime = flags.model === 'live' || flags.semantic === 'live' ? await liveRuntime() : null;
  if (flags.semantic === 'none') {
    adviceFor = () => semanticPlanningAdvice({ query: 'x', catalog, retrieve: async () => ({ status: 'unavailable', candidates: [], failure: { reason: 'PROFILE_DISABLED' } }) });
  } else if (flags.semantic === 'live') {
    adviceFor = (testCase) => semanticPlanningAdvice({ query: testCase.text, catalog, retrieve: (input) => runtime.retrieval.retrieve(input) });
    semanticProvenance = { path: 'gateway' };
  } else {
    const fromRun = candidatesFromRun(flags.semantic, loaded);
    semanticProvenance = fromRun.provenance;
    adviceFor = (testCase) => semanticPlanningAdvice({ query: testCase.text, catalog, retrieve: async () => fromRun.byCase.get(testCase.id) });
  }
  if (!flags.modelCommand && flags.model !== 'live') fail('--model-command ya da --model live gerekir.');
  if (flags.inputs) mkdirSync(flags.inputs, { recursive: true });
  const expectedModel = flags.expectedModel || (flags.model === 'live' ? runtime.planner.model : WEAK_PLANNER_MODEL);
  if (runtime && flags.model === 'live' && runtime.planner.model !== expectedModel) fail('PLANNER_MODEL_MISMATCH');
  if (runtime && flags.model === 'live' && runtime.planner.thinking !== 'off') fail('PLANNER_THINKING_UNVERIFIED');
  const model = flags.model === 'live' ? null : externalModel({ command: flags.modelCommand, inputs: flags.inputs || null, guard, timeoutMs: flags.modelTimeoutMs, outputBytes: flags.modelOutputBytes });
  const runTurn = flags.model === 'live' ? liveTurn(runtime.gateway, expectedModel, guard, runtime.planner) : null;
  const concurrency = runtime ? Math.min(flags.concurrency, runtime.maxActivePerUser) : flags.concurrency;
  const records = [];
  // Altyapı hatası (komut, kota, kimlik doğrulama) geçişi geçersiz kılar: kalan vakalar boşuna çalıştırılmaz.
  let infrastructure = null;
  try {
    for (let pass = 1; pass <= flags.passes; pass += 1) {
      const outcomes = await mapLimit(cases, concurrency, async (testCase) => {
        if (infrastructure) return { outcome: 'error', error: 'SKIPPED', decisions: [], rounds: [], semantic: { state: 'unavailable', candidates: [] } };
        const outcome = await planCase({ testCase, model, runTurn, adviceFor, now, catalog, expectedModel });
        if (outcome.outcome === 'error') infrastructure ||= outcome.error;
        return outcome;
      });
      outcomes.forEach((outcome, index) => records.push(recordOf(cases[index], pass, outcome)));
      process.stderr.write(`pass ${pass}/${flags.passes} tamamlandı (${cases.length} vaka)\n`);
      if (infrastructure) break;
    }
  } finally {
    model?.dispose();
  }
  if (infrastructure) fail(`Geçiş altyapı hatasıyla durdu (${infrastructure}); koşu geçersizdir ve kaydedilmedi.`);
  // Koşu UTC gün dönümünü geçtiyse dış modelin ortam günü referans günden ayrılmış olabilir: koşu geçersizdir.
  if (new Date().toISOString().slice(0, 10) !== flags.referenceDate && !flags.explicitReferenceDate) fail('Koşu referans günün dışına taştı; yeniden çalıştırın.');
  return {
    format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, runId: randomUUID(), benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint,
    referenceDate: loaded.referenceDate, passes: flags.passes, semantic: { mode: flags.semantic === 'none' || flags.semantic === 'live' ? flags.semantic : 'run', provenance: semanticProvenance },
    qualification: { expectedModel, thinking: 'off' },
    model: flags.model === 'live' ? { live: runtime.planner } : { commandHash: createHash('sha256').update(flags.modelCommand).digest('hex') }, cases: cases.map((testCase) => testCase.id), records
  };
}

function printReport(run, flags) {
  const loaded = loadPlannerBenchmark({ referenceDate: run.referenceDate });
  const summary = scorePlannerRun(run, loaded);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ summary, run: { ...run, records: undefined } }, null, 2)}\n`);
    return summary;
  }
  const lines = [`# Planlayıcı değerlendirmesi`, '', `Kıyas: ${summary.benchmark} · referans gün ${summary.referenceDate} · geçiş ${summary.passes}`,
    `Model: beklenen ${run.qualification.expectedModel} · gözlenen ${summary.models.join(', ') || '—'} · anlamsal ${summary.semantic.mode} · kapı ${summary.gatePassed ? 'GEÇTİ' : 'KALDI'}`,
    `Zayıf model hedefi: ${WEAK_PLANNER_MODEL}`, ''];
  for (const pass of summary.byPass) {
    lines.push(`## Geçiş ${pass.pass}: ${pass.correct}/${pass.total} doğru (answer ${pass.byExpect.answer.correct}/${pass.byExpect.answer.total}, clarify ${pass.byExpect.clarify.correct}/${pass.byExpect.clarify.total}, abstain ${pass.byExpect.abstain.correct}/${pass.byExpect.abstain.total}, general ${pass.byExpect.general.correct}/${pass.byExpect.general.total}; kanonik ${pass.canonical.correct}/${pass.canonical.total}, ek ${pass.supplementary.correct}/${pass.supplementary.total})`);
    for (const miss of pass.failures) lines.push(`- ${miss.case}: ${miss.reasons.join(', ')}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return summary;
}

/** Sınamalar planlama sınırını aynı yoldan çalıştırır (komut satırı yalnızca doğrudan çalıştırmada). */
export { candidatesFromRun, externalModel, liveTurn, leakGuard, parseArguments, planCase, recordOf, runEvaluation };

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
try {
const { command, flags } = direct ? parseArguments(process.argv.slice(2)) : { command: null, flags: null };
if (!direct) {
  // İçe aktarıldı: komut çalıştırılmaz.
} else if (command === 'input') {
  const loaded = loadPlannerBenchmark();
  const items = catalogue();
  const input = { format: 'mergen-rota-semantic-input', version: 1, benchmark: loaded.semanticFingerprint, catalogue: items.fingerprint,
    documents: items.items.map(({ id, text }) => ({ id, text })), queries: loaded.cases.map(({ id, text }) => ({ case: id, text })) };
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  else process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
} else if (command === 'run' || command === 'live') {
  const run = await runEvaluation(flags);
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  if (flags.noScore) process.stdout.write(`${JSON.stringify(run.records.map(({ rounds: _rounds, ...record }) => record), null, 1)}\n`);
  else process.exitCode = printReport(run, flags).gatePassed ? 0 : 1;
} else if (command === 'report') {
  if (!flags.run) fail('--run gerekir.');
  let run;
  try { run = JSON.parse(readFileSync(flags.run, 'utf8')); } catch { fail('Koşu dosyası okunamadı.'); }
  process.exitCode = printReport(run, flags).gatePassed ? 0 : 1;
} else {
  fail('Komut: input | run | report | live');
}

} catch (error) {
  if (!direct) throw error;
  process.stderr.write(`${String(error.message).slice(0, 400)}\n`);
  process.exitCode = 1;
}
