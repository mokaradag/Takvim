/**
 * Rota AI doğal yanıt düzeni — gerçek model nitelendirmesi (Aşama 4D). Geliştirme aracıdır; `npm test` bu dosyayı
 * çalıştırmaz (adı `*.test.mjs` değildir).
 *
 *   COMPOSITION_QUALIFICATION_STAGE=smoke node --test scripts/answer-composition-qualification.mjs
 *
 * Her vaka ÜRETİMDEKİ asistan hizmetinden geçer (konuşma kaydı, salt okunur araçlar, sunucu doğrulayıcıları, kalıcı
 * kanıt, olgu sayfası, düzen doğrulayıcısı ve çizici). Planlama turları belirlenimcidir (sabit `rota_plan`); yalnızca
 * doğal yanıt düzeni turu modele gider. Böylece belirteç bütçesi yalnızca ölçülen tura harcanır ve sonuç planlayıcı
 * kalitesinden bağımsızdır. Kabul ölçütü üretimin kendisidir: düzen doğrulanıp çizildiyse "composed", aksi hâlde
 * doğrulanmış belirlenimci anlatıma dönülür ve neden kaydedilir; ayrıca yanıtın beklenen doğrulanmış değerleri taşıdığı
 * ve kanıt kümesinin düzenden bağımsız kaldığı denetlenir.
 *
 * Sağlayıcı (COMPOSITION_QUALIFICATION_PROVIDER):
 *   dry     model çağrılmaz; düzeni her olguyu temsil eden sabit betik yazar (vakaların ve ölçümün kuru sınaması).
 *   claude  `scripts/planner-claude-model.mjs` komutu (PLANNER_CLAUDE_MODEL, varsayılan claude-haiku-4-5-20251001;
 *           düşünme kapalı, en düşük çaba). Bütçe: PLANNER_CLAUDE_LOG zorunlu, PLANNER_CLAUDE_MAX_CALLS ve
 *           PLANNER_CLAUDE_MAX_UNCACHED ile sınırlanır.
 *   live    kurum içi OpenAI uyumlu uç: MERGEN_ROTA_AI_BASE_URL, MERGEN_ROTA_AI_DEFAULT_API_KEY ve isteğe bağlı
 *           MERGEN_ROTA_AI_MODEL_REGISTRY_PATH; uygulama dizininden çalıştırılınca `.env.local` da okunur (kabuk
 *           değeri önceliklidir). Düzen turu üretim sağlayıcı bağdaştırıcısıyla Standart modele gider.
 *
 * Aşama (COMPOSITION_QUALIFICATION_STAGE): smoke | targeted | broad | all. Rapor: COMPOSITION_QUALIFICATION_OUT
 * (JSON satırı). Rapor içerik taşımaz: soru, yanıt, kayıt adı ya da kimlik yazılmaz; yalnızca vaka kimliği, sonuç ve ölçüm.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureConsole, createAiStack, sendTurn } from '../test/helpers/aiStack.mjs';
import { createFakeAiProvider } from '../test/helpers/fakeAiProvider.mjs';
import { AYSE, NOW, TASKS, rotaToolSeed } from '../test/helpers/aiToolFixtures.mjs';
import { coveringBlocks, compositionView, isCompositionCall } from '../test/helpers/compositionScenario.mjs';
import { verifyCompletion } from './planner-evaluation.mjs';
import { completeModelRound } from './planner-followup-qualification.mjs';
import { loadDeploymentEnvironment } from './semantic-evaluation.mjs';

const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');

const PROVIDER = process.env.COMPOSITION_QUALIFICATION_PROVIDER || 'dry';
const STAGE = process.env.COMPOSITION_QUALIFICATION_STAGE || 'smoke';
const OUT = process.env.COMPOSITION_QUALIFICATION_OUT || null;
const EXPECTED_MODEL = process.env.PLANNER_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const STAGES = Object.freeze(['smoke', 'targeted', 'broad']);
const LIVE_ENV = Object.freeze(['MERGEN_ROTA_AI_BASE_URL', 'MERGEN_ROTA_AI_DEFAULT_API_KEY', 'MERGEN_ROTA_AI_MODEL_REGISTRY_PATH']);

/* ── Vakalar ───────────────────────────────────────────────── */

const OVERDUE = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, filters: { deadline: 'overdue', assignee: 'me' } };
const MY_TASKS = { operation: 'list', metrics: ['task.title', 'task.status', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { assignee: 'me' } };
const plan = (request, { language = 'tr', additionalRequests = null } = {}) => ({ intent: 'rota', language, request, ...(additionalRequests ? { additionalRequests } : {}) });
const detail = (previous) => ({ operation: 'value', metrics: ['task.priority', 'task.targetFinish', 'task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', previous }] });

/**
 * Her vaka bir ya da birkaç kullanıcı turudur; `expect` yanıtta bulunması gereken doğrulanmış değerlerdir (sunucunun
 * yazdığı yuva değerleri). Son tur ölçülür; önceki turlar takip bağlamını kurar ve onların düzen turları da sayılır.
 */
export const COMPOSITION_CASES = Object.freeze([
  { id: 'overdue-list', stage: 'smoke', turns: [{ question: 'Geciken görevlerimi göster.', plan: plan(OVERDUE), expect: ['3', '23', 'Haftalık durum toplantısı'] }] },
  { id: 'task-record', stage: 'smoke', turns: [{ question: 'Radar test planı görevinin önceliği ve termini ne?',
    plan: plan({ operation: 'value', metrics: ['task.priority', 'task.targetFinish'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar test planı' }] }),
    expect: ['Kritik', '20 Eylül 2026'] }] },
  { id: 'priority-distribution', stage: 'targeted', turns: [{ question: 'Görevlerimin önceliğe göre dağılımı nasıl?',
    plan: plan({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' }, filters: { assignee: 'me' } }),
    expect: ['Orta'] }] },
  { id: 'english-overdue', stage: 'targeted', turns: [{ question: 'Show my overdue tasks.', plan: plan(OVERDUE, { language: 'en' }), expect: ['23', '7 September 2026'] }] },
  { id: 'followup-priority', stage: 'targeted', turns: [
    { question: 'Geciken görevlerimi göster.', plan: plan(OVERDUE) },
    { question: 'Bunların öncelikleri ne?', plan: plan({ previousResult: true, operation: 'list', metrics: ['task.title', 'task.priority'], population: { tool: 'rota_task_search', collection: 'tasks' } }),
      expect: ['Kritik', 'Radar test planı'] }] },
  { id: 'partial-section', stage: 'targeted', failure: { outlook: 'ESOCKET' }, turns: [{ question: `Geciken görevlerimi ve ${TASKS.OVERDUE} görevinin Outlook durumunu göster.`,
    plan: plan(OVERDUE, { additionalRequests: [{ operation: 'value', metrics: ['subscriptions.active'], population: { tool: 'rota_outlook_status' }, entities: [{ type: 'task', id: TASKS.OVERDUE }] }] }),
    expect: ['23', 'ulaşılamıyor'], outcome: 'unavailable' }] },
  { id: 'comparison', stage: 'broad', turns: [
    { question: 'Geciken görevlerimi göster.', plan: plan(OVERDUE) },
    { question: 'İlk ikisinin öncelik, termin ve durumlarını karşılaştır.', plan: plan(detail(1), { additionalRequests: [detail(2)] }), expect: ['Orta', 'Kritik', '7 Eylül 2026', '20 Eylül 2026'] }] },
  { id: 'my-tasks', stage: 'broad', turns: [{ question: 'Görevlerimi listele.', plan: plan(MY_TASKS), expect: ['Radar test planı', 'Kısmi ortak görev'] }] },
  { id: 'project-summary', stage: 'broad', turns: [{ question: 'Radar Modernizasyonu projesini özetle.',
    plan: plan({ operation: 'value', metrics: ['project.name', 'tasks.total', 'tasks.overdue', 'tasks.done'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] }),
    expect: ['Radar Modernizasyonu'] }] },
  { id: 'notifications', stage: 'broad', turns: [{ question: 'Okunmamış bildirimlerim kaç tane?', plan: plan({ operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' } }) }] },
  { id: 'status-distribution', stage: 'broad', turns: [{ question: 'Radar Modernizasyonu projesindeki görevler duruma göre nasıl dağılıyor?',
    plan: plan({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] }) }] },
  { id: 'english-followup', stage: 'broad', turns: [
    { question: 'Show my overdue tasks.', plan: plan(OVERDUE, { language: 'en' }) },
    { question: 'What are their priorities?', plan: plan({ previousResult: true, operation: 'list', metrics: ['task.title', 'task.priority'], population: { tool: 'rota_task_search', collection: 'tasks' } }, { language: 'en' }),
      expect: ['Critical'] }] }
]);

/* ── Sağlayıcı ─────────────────────────────────────────────── */

const usageOf = (reply) => ({
  input: reply.usage?.input_tokens ?? null, cacheCreate: reply.usage?.cache_creation_input_tokens ?? null, cacheRead: reply.usage?.cache_read_input_tokens ?? null,
  output: reply.usage?.output_tokens ?? null, thinking: reply.usage?.output_tokens_details?.thinking_tokens ?? null
});

/** Planlama betikli, düzen turu seçilen sağlayıcıda; her düzen turunun ölçümü `rounds` listesine yazılır. */
function qualificationProvider(rounds) {
  const fake = createFakeAiProvider({ semanticQueue: false, respond: (call) => (['embeddings', 'rerank'].includes(call.kind) ? { type: 'status', status: 503 } : null) });
  const live = PROVIDER === 'live' ? createOpenAiCompatibleProvider() : null;
  let standard = null;
  return { ...fake, async streamToolCompletion(input) {
    if (!isCompositionCall(input)) return fake.streamToolCompletion(input);
    standard ??= input.model;
    const view = compositionView(input);
    const measured = { shape: view.shape, language: view.language, facts: view.facts.length, tables: view.tables.length, charts: view.charts.length,
      budget: input.maxOutputTokens ?? null, model: input.model };
    rounds.push(measured);
    const startedAt = performance.now();
    if (live) {
      // Kurum içi uçta süre akışın sonuna kadar, kullanım sağlayıcının bildirdiği değerlerle ölçülür.
      const result = await live.streamToolCompletion(input);
      return { ...result, events: (async function* measuredEvents() {
        try {
          for await (const event of result.events) {
            if (event.type === 'done') {
              Object.assign(measured, { finish: event.finishReason ?? null, usage: { input: event.usage?.promptTokens ?? null, cacheCreate: null, cacheRead: null,
                output: event.usage?.completionTokens ?? null, thinking: event.usage?.reasoningTokens ?? 0 } });
            }
            yield event;
          }
        } finally {
          measured.latencyMs = Math.round(performance.now() - startedAt);
        }
      })() };
    }
    if (PROVIDER === 'dry') {
      fake.enqueue({ type: 'answer', native: true, text: JSON.stringify(coveringBlocks(view)) });
      return fake.streamToolCompletion(input);
    }
    const reply = await completeModelRound({ messages: input.messages, tools: [], toolChoice: 'none', maxOutputTokens: input.maxOutputTokens }, input.signal);
    measured.latencyMs = Math.round(performance.now() - startedAt);
    if (!reply || typeof reply.text !== 'string' || reply.error) throw new Error(`MODEL_INFRASTRUCTURE ${reply?.error || 'ADAPTER_OUTPUT_INVALID'}`);
    if (!reply.models?.length || reply.models.some((model) => model !== EXPECTED_MODEL) || reply.thinking !== 'off') throw new Error('MODEL_INFRASTRUCTURE PLANNER_MODEL_UNVERIFIED');
    verifyCompletion(reply.finishReason);
    Object.assign(measured, { models: reply.models, thinking: reply.thinking, finish: reply.finishReason, usage: usageOf(reply) });
    fake.enqueue({ type: 'answer', native: true, text: reply.text, finishReason: reply.finishReason });
    return fake.streamToolCompletion(input);
  } };
}

/* ── Koşu ──────────────────────────────────────────────────── */

const summary = { provider: PROVIDER, stage: STAGE, model: PROVIDER === 'claude' ? EXPECTED_MODEL : null, cases: 0, passed: 0, composed: 0, narrative: 0,
  calls: 0, reasons: {}, issues: {}, charts: 0, escalations: 0, usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, thinking: 0 }, results: [] };

const turnLine = (logs) => logs.map((line) => (line.includes('"operation":"ai.grounded.turn"') ? JSON.parse(line.slice(line.indexOf('{'))) : null)).filter(Boolean).at(-1);

async function runCase(t, item) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const env = { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true',
    ...(PROVIDER === 'live' ? Object.fromEntries(LIVE_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]])) : {}) };
  const rounds = [];
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env, provider: qualificationProvider(rounds) });
  if (item.failure) stack.db.aiToolFailure = Object.fromEntries(Object.entries(item.failure).map(([query, code]) => [query, Object.assign(new Error('nitelendirme'), { code })]));
  const logs = captureConsole(t);
  let conversationId = null;
  let result = null;
  for (const [index, turn] of item.turns.entries()) {
    const before = rounds.length;
    stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: turn.plan }] });
    const response = await sendTurn({ turnId: randomUUID(), message: turn.question, ...(conversationId ? { conversationId, expectedSequence: index * 2 } : {}) });
    const done = response.events?.find((event) => event.event === 'done')?.data;
    const line = turnLine(logs);
    const measured = rounds.slice(before);
    for (const round of measured) {
      summary.calls += 1;
      for (const key of Object.keys(summary.usage)) summary.usage[key] += round.usage?.[key] ?? 0;
    }
    if (line?.context?.escalated) summary.escalations += 1;
    const failures = [];
    if (!done) failures.push(`yanıt yok (${response.status})`);
    else {
      conversationId = done.conversation.id;
      const answer = done.assistantMessage;
      if (answer.finishReason !== (turn.outcome === 'unavailable' ? 'unavailable' : 'stop')) failures.push(`sonuç ${answer.finishReason}`);
      for (const value of turn.expect || []) if (!String(answer.content).includes(value)) failures.push(`beklenen değer yok #${(turn.expect || []).indexOf(value) + 1}`);
      if (/\{F\d+\}|【(R\d+)】\s*【\1】/.test(answer.content)) failures.push('çözülmemiş yuva ya da yinelenen kaynak');
    }
    const presentation = line?.context?.presentation || null;
    result = { id: item.id, stage: item.stage, turn: index + 1, mode: presentation?.mode ?? null, reason: presentation?.reason ?? null, issue: presentation?.issue ?? null,
      blocks: presentation?.blocks ?? null, chart: presentation?.chart ?? null, failures,
      rounds: measured.map(({ shape, language, facts, tables, charts, budget, finish, latencyMs, usage }) => ({ shape, language, facts, tables, charts, budget, finish: finish ?? null, latencyMs: latencyMs ?? null, usage: usage ?? null })) };
    if (presentation?.mode) summary[presentation.mode] += 1;
    if (presentation?.reason) summary.reasons[presentation.reason] = (summary.reasons[presentation.reason] || 0) + 1;
    if (presentation?.issue) summary.issues[presentation.issue] = (summary.issues[presentation.issue] || 0) + 1;
    if (presentation?.chart) summary.charts += 1;
    summary.results.push(result);
    process.stderr.write(`[${item.id}#${index + 1}] ${presentation?.mode ?? '-'} ${presentation?.reason ?? ''} ${presentation?.issue ?? ''} ${failures.join('; ')}\n`);
  }
  summary.cases += 1;
  // Vaka, ölçülen son turun doğal düzenle yazılması ve bütün değer denetimlerinin geçmesiyle başarılıdır.
  if (result && result.mode === 'composed' && summary.results.filter((row) => row.id === item.id).every((row) => !row.failures.length)) summary.passed += 1;
}

/**
 * Rapor yazıldıktan sonra yanıtsız tur, değer denetimi hatası, Derin devri ya da düşünme komutu başarısız kılar.
 * Doğrulanmış anlatıma dönüşler doğru yanıttır; komutu düşürmez, oranı ve nedeniyle raporlanır.
 */
export function finalizeCompositionQualification(report) {
  process.stderr.write(`${JSON.stringify(report)}\n`);
  if (OUT) appendFileSync(OUT, `${JSON.stringify(report)}\n`);
  assert.deepEqual(report.results.filter((row) => row.failures.length).map((row) => `${row.id}#${row.turn}`), [], 'COMPOSITION_CHECKS_FAILED');
  assert.equal(report.escalations, 0, 'COMPOSITION_ESCALATION_FORBIDDEN');
  assert.equal(report.usage.thinking, 0, 'COMPOSITION_THINKING_FORBIDDEN');
}

const direct = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (direct) {
  if (!['dry', 'claude', 'live'].includes(PROVIDER)) throw new Error('COMPOSITION_QUALIFICATION_PROVIDER: dry | claude | live');
  if (![...STAGES, 'all'].includes(STAGE)) throw new Error('COMPOSITION_QUALIFICATION_STAGE: smoke | targeted | broad | all');
  if (PROVIDER === 'claude' && !process.env.PLANNER_CLAUDE_LOG) throw new Error('PLANNER_CLAUDE_LOG gerekli: bütçe ve önbellek kapısı kayıt dosyasıyla izlenir.');
  if (PROVIDER === 'live') loadDeploymentEnvironment();
  if (PROVIDER === 'live' && !LIVE_ENV.slice(0, 2).every((key) => process.env[key])) throw new Error('MERGEN_ROTA_AI_BASE_URL ve MERGEN_ROTA_AI_DEFAULT_API_KEY gerekli.');
  test.after(() => finalizeCompositionQualification(summary));
  for (const item of COMPOSITION_CASES.filter((entry) => STAGE === 'all' || entry.stage === STAGE)) {
    test(item.id, (t) => runCase(t, item));
  }
}
