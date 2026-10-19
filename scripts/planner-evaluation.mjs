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
 *     toolChoice }`), stdout `{ text, toolCalls, usage, models }`. Komut modele kendi yerel araç çağırma
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
import { loadPlannerBenchmark, PLANNER_RUN_FORMAT, scorePlannerRun } from './planner-scoring.mjs';

registerServerOnlyShim();

const EVALUATION_SICIL = 900001;

const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { EVIDENCE_TEXT_FIELDS } = await import('../src/domain/ai/claimableEvidence.js');
const { semanticPlanningAdvice } = await import('../src/server/ai/assistant/semanticPlanning.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel, getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { SEMANTIC_RETRIEVAL_DEPTH } = await import('../src/server/ai/semanticRetrieval.js');
const {
  applyRerankScores, createEmbeddingSpace, createSemanticCatalogue, createSemanticIndex, rankSemanticIndex, semanticToolDefinitions
} = await import('../src/domain/ai/semanticContract.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments([command, ...rest]) {
  const flags = { passes: 1, concurrency: 4, semantic: 'none' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--json') flags.json = true;
    else if (flag === '--no-score') flags.noScore = true;
    else if (['--model-command', '--model', '--semantic', '--passes', '--concurrency', '--cases', '--out', '--inputs', '--run', '--reference-date'].includes(flag) && rest[i + 1] != null) {
      flags[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[++i];
    } else fail(`Tanınmayan bağımsız değişken: ${flag}`);
  }
  if (command === 'live') Object.assign(flags, { model: 'live', semantic: 'live' });
  if (flags.model != null && flags.model !== 'live') fail('--model yalnızca live olabilir (dış model için --model-command).');
  flags.passes = Number(flags.passes);
  flags.concurrency = Number(flags.concurrency);
  if (!Number.isSafeInteger(flags.passes) || flags.passes < 1 || flags.passes > 10) fail('--passes 1–10 olmalıdır.');
  if (!Number.isSafeInteger(flags.concurrency) || flags.concurrency < 1 || flags.concurrency > 16) fail('--concurrency 1–16 olmalıdır.');
  // Referans gün varsayılan olarak koşunun UTC günüdür: dış model komutunun kendi ortam bilgisi de bu günü taşır.
  flags.referenceDate ||= new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.referenceDate)) fail('--reference-date YYYY-MM-DD olmalıdır.');
  return { command, flags };
}

/* ── Modele giden metnin sızıntı denetimi ───────────────────────────── */

function leakGuard(benchmark) {
  const ids = benchmark.cases.map((testCase) => testCase.id);
  const markers = [/\b(?:tr|pl)-\d{3}\b/, /"(?:needs|avoid|expect|gold)"\s*:/, /ai-(?:semantic|planner)-benchmark/, /planner-scoring/];
  return (text) => {
    if (markers.some((marker) => marker.test(text)) || ids.some((id) => text.includes(id))) {
      fail('Modele giden metinde vaka kimliği ya da altın etiket izi bulundu; koşu durduruldu.');
    }
  };
}

/* ── Model bağdaştırıcıları ─────────────────────────────────────────── */

/**
 * Dış model komutu: stdin üretim turunun girdisini (`{ messages, tools, toolChoice }`, OpenAI uyumlu iletiler ve
 * işlev araçları) alır; stdout `{ text, toolCalls: [{ name, arguments }], usage, models }` yazar. Komut modele
 * kendi yerel araç çağırma biçimini verir (ör. bir sağlayıcının yerel araç arayüzü); araç yürütmez.
 */
function externalModel({ command, inputs, guard }) {
  const workdir = mkdtempSync(path.join(tmpdir(), 'rota-planner-'));
  let sequence = 0;
  const run = (payload) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MERGEN_ROTA_/.test(key)));
    const child = spawn('/bin/sh', ['-c', command], { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(Object.assign(new Error(`MODEL_COMMAND_FAILED ${code}`), { stderr: Buffer.concat(err).toString('utf8').slice(-400) }));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.end(payload);
  });
  return {
    async complete({ messages, tools, toolChoice }) {
      const payload = JSON.stringify({ messages, tools, toolChoice });
      guard(payload);
      const id = (sequence += 1);
      if (inputs) {
        const system = String(messages[0]?.role === 'system' ? messages[0].content : '');
        const hash = createHash('sha256').update(system).digest('hex').slice(0, 16);
        writeFileSync(path.join(inputs, `system-${hash}.txt`), system, 'utf8');
        writeFileSync(path.join(inputs, 'inputs.jsonl'), `${JSON.stringify({ call: id, system: hash, messages: messages.slice(1), tools: tools.map((tool) => tool.name), toolChoice })}\n`, { flag: 'a' });
      }
      const startedAt = Date.now();
      let reply;
      try { reply = JSON.parse(await run(payload)); } catch (error) { reply = { text: '', toolCalls: [], error: error.message || 'MODEL_COMMAND_FAILED' }; }
      if (inputs) writeFileSync(path.join(inputs, 'completions.jsonl'), `${JSON.stringify({ call: id, reply })}\n`, { flag: 'a' });
      const toolCalls = (Array.isArray(reply?.toolCalls) ? reply.toolCalls : []).filter((call) => call && typeof call.name === 'string')
        .map((call, index) => ({ id: `call_${id}_${index + 1}`, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}), oversize: false }));
      return { text: typeof reply?.text === 'string' ? reply.text : '', toolCalls, usage: reply?.usage ?? null, models: Array.isArray(reply?.models) ? reply.models : [],
        error: reply?.error ?? null, durationMs: Date.now() - startedAt };
    },
    dispose() { rmSync(workdir, { recursive: true, force: true }); }
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
  if (run?.catalogue !== items.fingerprint) fail('Anlamsal koşu dosyası güncel araç kataloğuna ait değil.');
  const space = createEmbeddingSpace({ profile: 'embedding', model: run.embedding?.model, provider: run.embedding?.provider }, run.embedding?.preprocessing);
  if (!space) fail('Anlamsal koşu dosyasının gömme kökeni geçersiz.');
  const index = createSemanticIndex(items, space, (run.embedding.documents || []).map((document, position) => ({ index: position, vector: document.vector })));
  if (!index.ok) fail(`Anlamsal dizin kurulamadı: ${index.reason}`);
  const queries = new Map((run.embedding.queries || []).map((query) => [query.case, query]));
  const reranks = new Map((run.rerank?.queries || []).map((query) => [query.case, query]));
  const result = new Map();
  for (const testCase of benchmark.cases) {
    const query = queries.get(testCase.id);
    if (!query || query.text !== testCase.text) { result.set(testCase.id, { status: 'unavailable', candidates: [], failure: { reason: 'NO_QUERY_VECTOR' } }); continue; }
    const ranked = rankSemanticIndex(index.index, { space, embeddings: [{ index: 0, vector: query.vector }], limit: Math.min(SEMANTIC_RETRIEVAL_DEPTH, items.items.length) });
    if (!ranked.ok) { result.set(testCase.id, { status: 'unavailable', candidates: [], failure: { reason: ranked.reason } }); continue; }
    const scores = reranks.get(testCase.id)?.scores;
    if (Array.isArray(scores)) {
      const byId = new Map(items.items.map((item, position) => [item.id, scores[position]]));
      const reranked = applyRerankScores(ranked.candidates, ranked.candidates.map((candidate, position) => ({ index: position, score: byId.get(candidate.id) })));
      if (reranked.ok) { result.set(testCase.id, { status: 'reranked', candidates: reranked.candidates, failure: null }); continue; }
    }
    result.set(testCase.id, { status: 'first_stage', candidates: ranked.candidates, failure: null });
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
async function planCase({ testCase, model = null, runTurn = null, adviceFor, now, catalog }) {
  const built = buildGroundedContext({ history: testCase.history || [], userContent: testCase.text, now });
  const planning = await adviceFor(testCase);
  const decisions = [];
  const rounds = [];
  let captured = null;
  const options = {
    // "Notlar ve iletiler" açık: planlayıcı serbest metin isteyen soruda da planıyla değerlendirilir (kapalıyken
    // sunucunun sabit uyarısı ayrı sınamada).
    messages: built.messages, catalog, context: createToolTurnContext({ sicil: EVALUATION_SICIL, now }), planning,
    allowedTextFields: [...EVIDENCE_TEXT_FIELDS],
    onText: async () => {}, deferDisclosure: true, escalation: false,
    onPlanned: (decision) => {
      decisions.push(decision);
      if (decision.intent === 'rota') { captured = decision; throw new PlanCaptured(); }
    }
  };
  try {
    const result = await (runTurn || externalTurn(model))(options, rounds);
    if (result === CAPTURED) return { outcome: 'planned', decisions, rounds, semantic: planning, plan: captured };
    return { outcome: result.outcome, decisions, rounds, semantic: planning };
  } catch (error) {
    if (error instanceof PlanCaptured) return { outcome: 'planned', decisions, rounds, semantic: planning, plan: captured };
    return { outcome: 'error', error: typeof error?.code === 'string' ? error.code : 'ERROR', decisions, rounds, semantic: planning };
  }
}

const CAPTURED = Symbol('captured');

/** Dış model komutu: üretimdeki oturum sözleşmesinin ikizi; komutun kendi hatası modelin kararı sayılmaz. */
function externalTurn(model) {
  return (options, rounds) => runGroundedTurn(Object.freeze({
    sicil: EVALUATION_SICIL, profile: 'chat.tools', model: 'planner-under-test', reportedModel: () => null, maxOutputTokens: 4096,
    signal: new AbortController().signal, remainingMs: () => 600000,
    async round({ messages, tools, toolChoice }) {
      const completion = await model.complete({ messages, tools, toolChoice });
      rounds.push({ durationMs: completion.durationMs, usage: completion.usage, models: completion.models, toolCalls: completion.toolCalls.length, error: completion.error });
      // Komutun kendi hatası (süreç, kimlik doğrulama, beklenmeyen model) modelin kararı değildir: vaka altyapı hatasıyla biter.
      if (completion.error) throw Object.assign(new Error('MODEL_COMMAND_ERROR'), { code: 'MODEL_COMMAND_ERROR' });
      return { text: completion.text, toolCalls: completion.toolCalls, finishReason: completion.toolCalls.length ? 'tool_calls' : 'stop', model: null,
        configuredModel: 'planner-under-test', modelMismatch: false, usage: null, durationMs: completion.durationMs, firstEventMs: null };
    }
  }), options);
}

/**
 * Üretim yolu: tur ağ geçidinin araç oturumunda (`chat.tools` profili, kayıtlı model, kapasite ve süre sınırı)
 * yürür. Ağ geçidi oturum içinden fırlayan her hatayı kendi hatasına çevirdiği için ilk SQL'den önceki durma
 * oturum içinde değer olarak döner.
 */
function liveTurn(gateway) {
  return (options, rounds) => gateway.runToolSession({
    profile: 'chat.tools',
    run: async (session) => {
      const recording = Object.freeze({ ...session, async round(input) {
        const startedAt = Date.now();
        const result = await session.round(input);
        rounds.push({ durationMs: Date.now() - startedAt, models: [result.model].filter(Boolean), toolCalls: result.toolCalls.length, error: null,
          usage: { input_tokens: result.usage?.promptTokens ?? null, output_tokens: result.usage?.completionTokens ?? null,
            output_tokens_details: { thinking_tokens: result.usage?.reasoningTokens ?? null } } });
        return result;
      } });
      try { return await runGroundedTurn(recording, options); } catch (error) {
        if (error instanceof PlanCaptured) return CAPTURED;
        throw error;
      }
    }
  });
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
  return { gateway, retrieval, planner: { profile: AI_PROFILES.CHAT_TOOLS, model: planner.route.model, provider: planner.route.provider } };
}

/** Puanlama için içeriksiz, kararlı karar kaydı (istek nesneleri JSON'a güvenle çevrilir). */
function recordOf(testCase, pass, outcome) {
  const plan = outcome.plan ? {
    requests: outcome.plan.requests.map((request) => JSON.parse(JSON.stringify(request))),
    calls: outcome.plan.calls.map((call) => ({ name: call.name, args: call.args }))
  } : null;
  const terminal = outcome.decisions.find((decision) => ['clarify', 'abstain'].includes(decision.intent)) || null;
  return {
    case: testCase.id, pass, outcome: outcome.outcome, error: outcome.error ?? null, plan,
    choice: terminal ? { intent: terminal.intent, reason: terminal.reason, ...(terminal.topics ? { topics: [...terminal.topics] } : {}) } : null,
    general: outcome.decisions.some((decision) => decision.intent === 'general'),
    declarations: outcome.decisions.at(-1)?.declarations ?? null,
    semantic: { state: outcome.semantic.state, candidates: [...outcome.semantic.candidates] },
    rounds: outcome.rounds.map((round) => ({ durationMs: round.durationMs, toolCalls: round.toolCalls,
      input: round.usage ? (round.usage.input_tokens ?? 0) + (round.usage.cache_read_input_tokens ?? 0) + (round.usage.cache_creation_input_tokens ?? 0) : null,
      output: round.usage?.output_tokens ?? null, thinking: round.usage?.output_tokens_details?.thinking_tokens ?? null,
      thinkingBlocks: round.usage?.thinkingBlocks ?? null, models: round.models, error: round.error ?? null }))
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
    const fromRun = candidatesFromRun(flags.semantic, { cases: loaded.cases });
    semanticProvenance = fromRun.provenance;
    adviceFor = (testCase) => semanticPlanningAdvice({ query: testCase.text, catalog, retrieve: async () => fromRun.byCase.get(testCase.id) });
  }
  if (!flags.modelCommand && flags.model !== 'live') fail('--model-command ya da --model live gerekir.');
  if (flags.inputs) mkdirSync(flags.inputs, { recursive: true });
  const model = flags.model === 'live' ? null : externalModel({ command: flags.modelCommand, inputs: flags.inputs || null, guard });
  const runTurn = flags.model === 'live' ? liveTurn(runtime.gateway) : null;
  const records = [];
  // Altyapı hatası (komut, kota, kimlik doğrulama) geçişi geçersiz kılar: kalan vakalar boşuna çalıştırılmaz.
  let infrastructure = null;
  try {
    for (let pass = 1; pass <= flags.passes; pass += 1) {
      const outcomes = await mapLimit(cases, flags.concurrency, async (testCase) => {
        if (infrastructure) return { outcome: 'error', error: 'SKIPPED', decisions: [], rounds: [], semantic: { state: 'unavailable', candidates: [] } };
        const outcome = await planCase({ testCase, model, runTurn, adviceFor, now, catalog });
        if (outcome.error === 'MODEL_COMMAND_ERROR') infrastructure ||= outcome.error;
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
  if (new Date().toISOString().slice(0, 10) !== flags.referenceDate && !process.argv.includes('--reference-date')) fail('Koşu referans günün dışına taştı; yeniden çalıştırın.');
  return {
    format: PLANNER_RUN_FORMAT, version: 1, runId: randomUUID(), benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint,
    referenceDate: loaded.referenceDate, passes: flags.passes, semantic: { mode: flags.semantic === 'none' || flags.semantic === 'live' ? flags.semantic : 'run', provenance: semanticProvenance },
    model: flags.model === 'live' ? { live: runtime.planner } : { command: flags.modelCommand.replace(/\s+/g, ' ').slice(0, 600) }, cases: cases.map((testCase) => testCase.id), records
  };
}

function printReport(run, flags) {
  const loaded = loadPlannerBenchmark({ referenceDate: run.referenceDate });
  const summary = scorePlannerRun(run, loaded);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ summary, run: { ...run, records: undefined } }, null, 2)}\n`);
    return summary;
  }
  const lines = [`# Planlayıcı değerlendirmesi`, '', `Kıyas: ${summary.benchmark} · referans gün ${summary.referenceDate} · geçiş ${summary.passes}`, ''];
  for (const pass of summary.byPass) {
    lines.push(`## Geçiş ${pass.pass}: ${pass.correct}/${pass.total} doğru (answer ${pass.byExpect.answer.correct}/${pass.byExpect.answer.total}, clarify ${pass.byExpect.clarify.correct}/${pass.byExpect.clarify.total}, abstain ${pass.byExpect.abstain.correct}/${pass.byExpect.abstain.total})`);
    for (const miss of pass.failures) lines.push(`- ${miss.case}: ${miss.reasons.join(', ')}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return summary;
}

/** Sınamalar planlama sınırını aynı yoldan çalıştırır (komut satırı yalnızca doğrudan çalıştırmada). */
export { planCase, recordOf };

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const { command, flags } = direct ? parseArguments(process.argv.slice(2)) : { command: null, flags: null };
if (!direct) {
  // İçe aktarıldı: komut çalıştırılmaz.
} else if (command === 'run') {
  const run = await runEvaluation(flags);
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  if (flags.noScore) process.stdout.write(`${JSON.stringify(run.records.map(({ rounds: _rounds, ...record }) => record), null, 1)}\n`);
  else printReport(run, flags);
} else if (command === 'report') {
  if (!flags.run) fail('--run gerekir.');
  let run;
  try { run = JSON.parse(readFileSync(flags.run, 'utf8')); } catch { fail('Koşu dosyası okunamadı.'); }
  printReport(run, flags);
} else if (command === 'live') {
  const run = await runEvaluation(flags);
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  printReport(run, flags);
} else {
  fail('Komut: run | report | live');
}
