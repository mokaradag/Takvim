/**
 * Rota AI · Aşama 4E — zayıf model nitelendirmesi (Haiku 4.5, düşünme kapalı). Geliştirme aracıdır; `npm test` bu
 * dosyayı çalıştırmaz.
 *
 *   PLANNER_CLAUDE_LOG=cagri.jsonl PHASE4E_TIER=B PHASE4E_OUT=rapor.jsonl node --test scripts/analysis-qualification.mjs
 *
 * Katmanlar (PHASE4E_TIER):
 *   B  Yalnızca planlayıcı: kıyas kümesinin `tierB` soruları ÜRETİMDEKİ planlama sınırından geçer (sistem yönergesi, plan
 *      aracı, kayıt defteri, bildirim düzeltmeleri) ve ilk SQL'den önce durur. Puan: karar, ilk bildirimde kabul, kapsam,
 *      ekip düzeyi, adlar, yönler ve görselleştirme bayrağı. Rota verisi okunmaz.
 *   C  Takip zincirleri: planlayıcı modeldir; konuşma üretim hizmetinden geçer, araçlar sınama veri kümesini okur, düzen
 *      sunucunun kapsayan düzenidir (belirteç harcanmaz). Her turun araç düzeyindeki kapsamı denetlenir.
 *   D  Yalnızca düzen: planlar betiklidir (altın plan), yalnızca doğal yanıt düzeni modele gider.
 *   E  Uçtan uca: planlayıcı ve düzen modeldir.
 *   F  Bilgin yönetim analizi kıyas kümesi (`test/fixtures/bilgin-analysis-benchmark.json`, sentetik): özgün 40 sorunun
 *      karşılıkları uçtan uca (planlayıcı + düzen model; sentetik veri ve vakanın profili), ayrık küme (PHASE4E_SET=holdout)
 *      yalnızca planlayıcı. Vaka sınıfı (tam / kısmi / sınırlı) beklentiyi belirler; rapor içerik taşımaz, yalnızca bitiş,
 *      kapsam ihlalleri, sunum biçimi, bulgu ve grafik sayıları.
 *   G  Aşama G yönetici ve proje zekâsı kıyas kümesi (`test/fixtures/bilgin-executive-benchmark.json`, sentetik): hedefli vakalar
 *      uçtan uca (planlayıcı + düzen model; yönetici sentetik verisi ve vakanın profili; çok turlu vakalar sırayla), bağımsız ayrık
 *      küme (PHASE4E_SET=holdout) yalnızca planlayıcı. Çok kapsamlı vakada her kapsamın kendi nüfusu okunmalıdır.
 * Derin modele giden her çağrı modele GİTMEZ; sayılır ve başarısızlıktır (zayıf model kabulü güçlü modelle gizlenmez).
 * PHASE4E_CASES=id,… yalnızca o vakaları (başarısızların yeniden koşusu) çalıştırır. Rapor içerik taşımaz.
 * PLANNER_CLAUDE_FORCED_RETRY=1: CLI zorunlu aracı kısıtlı çözümle uygulayamadığı için model zorunlu turda başka bir araç
 * çağırırsa tur bir kez yalnızca zorunlu şemayla yinelenir; sayısı raporda `usage.forcedRetries` olarak ayrıca verilir.
 */
import { appendPrivateDiagnostic } from './private-diagnostic-trace.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureConsole } from '../test/helpers/aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from '../test/helpers/aiToolFixtures.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from '../test/helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed, EXEC_PROFILES } from '../test/helpers/executiveBenchmarkSeed.mjs';
import { answerQuality } from '../test/helpers/answerQuality.mjs';
import { phase4eConversation, turnViolations, renderedCharts } from '../test/helpers/phase4eScenario.mjs';
import { planCase } from './planner-evaluation.mjs';
import { completeModelRound } from './planner-followup-qualification.mjs';
import { qualificationProvider } from './answer-composition-qualification.mjs';

const TIER = process.env.PHASE4E_TIER || 'B';
const OUT = process.env.PHASE4E_OUT || null;
const ONLY = (process.env.PHASE4E_CASES || '').split(',').map((item) => item.trim()).filter(Boolean);
const EXPECTED_MODEL = process.env.PLANNER_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/ai-phase4e-corpus.json', import.meta.url), 'utf8'));
const followups = JSON.parse(readFileSync(new URL('../test/fixtures/ai-phase4e-followups.json', import.meta.url), 'utf8'));
const benchmark = JSON.parse(readFileSync(new URL('../test/fixtures/bilgin-analysis-benchmark.json', import.meta.url), 'utf8'));
const executive = JSON.parse(readFileSync(new URL('../test/fixtures/bilgin-executive-benchmark.json', import.meta.url), 'utf8'));
/** Kıyas konuşmalarının günü: sabit sınama saatinin Türkiye (UTC+3) günü. */
export const BENCHMARK_TODAY = new Date(NOW.getTime() + 3 * 3600000).toISOString().slice(0, 10);
const summary = { tier: TIER, model: EXPECTED_MODEL, cases: 0, passed: 0, failed: [], firstPass: 0, repairs: 0, escalations: 0, turns: 0, results: [] };

const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { analysisSuggestion } = await import('../src/server/ai/tools/analysisPlan.js');
const { containmentText } = await import('../src/server/ai/tools/toolScope.js');
// Her çağrı kendi satırlarına sahiptir; önceki ve eşzamanlı koşular yalnızca eklenen defteri paylaşabilir.
const RUN_ID = randomUUID();
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');

/* ── Tier B: planlayıcı ───────────────────────────────────────────── */

/** HER kabul edilen isteğin kapsamı (bir bölümün genişlemesi karışık sonuç verir); portföyde süzgeçsiz görev okuması portföydür. */
const scopeOf = (requests) => {
  if (!requests.length) return null;
  const one = (request) => {
    if (request.filters?.assignee === 'me') return 'self';
    if (request.filters?.assignee === 'team') return 'team';
    if (request.entities.some((entity) => entity.type === 'person')) return 'person';
    if (request.entities.some((entity) => entity.type === 'project')) return 'project';
    if (request.population?.tool === 'rota_portfolio_summary') return 'projects';
    return 'all';
  };
  const scopes = new Set(requests.map(one));
  if (scopes.has('projects') && [...scopes].every((scope) => ['projects', 'all'].includes(scope))) return 'projects';
  return scopes.size === 1 ? [...scopes][0] : `mixed:${[...scopes].join(',')}`;
};

/** Ayrıntılı isteğin eşdeğer analitik yönü (sunucunun türlü eşlemesi); eşdeğeri yoksa yön yoktur. */
const requestFocus = (request) => {
  const text = analysisSuggestion(request);
  return text ? JSON.parse(/\{.*\}/.exec(text)[0]).analysis.focus : [];
};
const day = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / 86400000;

function liveTurn(rounds, completeRound) {
  return (options) => runGroundedTurn(Object.freeze({
    sicil: 900001, profile: 'chat.tools', model: 'planner-under-test', reportedModel: () => null, maxOutputTokens: 4096,
    signal: new AbortController().signal, remainingMs: () => 600000,
    async round(input) {
      const measured = {};
      rounds.push(measured);
      const infrastructure = (reason) => {
        measured.infrastructure = reason;
        return Object.assign(new Error(`MODEL_INFRASTRUCTURE ${reason}`), { code: 'MODEL_INFRASTRUCTURE' });
      };
      try {
        const reply = await completeRound({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice });
        if (reply?.error) throw infrastructure(['PLANNER_BUDGET_CALLS', 'PLANNER_BUDGET_TOKENS'].includes(reply.error) ? reply.error : 'ADAPTER_ERROR');
        if (!reply.models?.length || reply.models.some((model) => model !== EXPECTED_MODEL)) throw infrastructure('PLANNER_MODEL_UNVERIFIED');
        if (reply.thinking !== 'off' || reply.usage?.output_tokens_details?.thinking_tokens) throw infrastructure('PLANNER_THINKING_ON');
        measured.finish = reply.finishReason;
        return { text: reply.text || '', toolCalls: (reply.toolCalls || []).map((call, index) => ({ id: `c${rounds.length}_${index}`, name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}), oversize: false })),
          finishReason: reply.finishReason || 'stop', model: null, configuredModel: 'planner-under-test', modelMismatch: false, usage: null, durationMs: 0, firstEventMs: null };
      } catch (error) {
        const reason = String(error?.message || '').replace(/^MODEL_INFRASTRUCTURE /, '');
        measured.infrastructure ||= ['PLANNER_LIMIT_INVALID', 'MODEL_COMMAND_ERROR', 'MODEL_COMMAND_CLEANUP_ERROR', 'MODEL_COMMAND_TIMEOUT', 'ADAPTER_OUTPUT_INVALID'].includes(reason)
          ? reason : 'MODEL_INVOCATION_FAILED';
        throw error;
      }
    }
  }), options);
}

/** Tier B puanı: kabul edilen planın kararı, HER isteğin kapsamı, düzey, adlar, görsel bayrağı, etkin yönler ve ufuk. */
export function plannerScore(result, expect) {
  const failures = [];
  const decision = result.decisions.at(-1) || null;
  const intent = result.outcome === 'planned' ? 'rota' : decision?.intent || result.outcome;
  if (result.outcome === 'error') failures.push(`hata ${result.error}`);
  // Aşama G: birden çok doğru kararı olan ayrık vaka (ör. yetkisiz kapsamda ret ya da kısmi yanıt) `intentAny` taşır.
  if (expect.intentAny ? !expect.intentAny.includes(intent) : intent !== expect.intent) failures.push(`karar ${intent} ≠ ${expect.intentAny ? expect.intentAny.join('|') : expect.intent}`);
  if (expect.reason && decision?.reason !== expect.reason) failures.push(`neden ${decision?.reason} ≠ ${expect.reason}`);
  const requests = result.plan?.requests || [];
  // Aşama G: çok kapsamlı beklentide her kapsam (kapsam + düzey) kabul edilen planın birincil ya da ek kapsamıdır; tek kapsam puanı uygulanmaz.
  if (expect.layers && result.outcome === 'planned') {
    const analysis = result.plan?.analysis;
    // Kabul edilen kararın özeti kapsamları `layers` olarak taşır (birincil + ek); ham plan biçimi `also`.
    const declaredLayers = analysis ? (analysis.layers || [analysis, ...(analysis.also || [])]) : [];
    const sameNames = (layer, other) => !layer.names?.length || JSON.stringify(layer.names.map((name) => containmentText(String(name))).sort())
      === JSON.stringify((other.names || []).map((name) => containmentText(String(name))).sort());
    for (const layer of expect.layers) {
      if (!declaredLayers.some((other) => other.scope === layer.scope && (other.level || '') === (layer.level || '') && sameNames(layer, other))) failures.push(`kapsam ${layer.scope}${layer.level ? `/${layer.level}` : ''} bildirilmedi`);
    }
    // Bildirilen kapsamın açılımı da o kapsamın nüfusunu okumalıdır (kapsam + düzey; adlı kapsamda adlı varlık): yalnızca özetin
    // kapsam listesinde görünmesi yetmez.
    // Adlı kapsam yalnızca türüyle değil kimliğiyle eşleşir: beklenti adı verdiyse okumanın varlığı o addır (başka kişi/proje
    // karşılamaz). Portföy kapsamı portföy aracının okumasıdır; koşulsuz görev okuması "görünür bütün işler" kapsamıdır.
    const sameName = (layer, entity) => !layer.names?.length || layer.names.some((name) => containmentText(String(name)) === containmentText(String(entity.query ?? entity.text ?? '')));
    const readsLayer = (layer, request) => (layer.scope === 'self' ? request.filters?.assignee === 'me'
      : layer.scope === 'team' ? request.filters?.assignee === 'team' && (request.filters?.teamLevel || '') === (layer.level || '')
        : ['person', 'project'].includes(layer.scope) ? request.entities?.some((entity) => entity.type === layer.scope && sameName(layer, entity)) && !request.filters?.assignee
          : layer.scope === 'projects' ? request.population?.tool === 'rota_portfolio_summary'
            : !request.filters?.assignee && !request.entities?.length && request.population?.tool !== 'rota_portfolio_summary');
    const reads = (layer) => requests.some((request) => readsLayer(layer, request));
    for (const layer of expect.layers.filter((layer) => !layer.optional)) if (!reads(layer)) failures.push(`kapsam ${layer.scope}${layer.level ? `/${layer.level}` : ''} okunmadı`);
    // Beklenen kapsamların üst kümesi kabul edilmez: bildirilen her kapsam ve açılan her istek beklenen kapsamlardan birinin nüfusudur
    // (ör. kendi + birim sorusuna eklenen bölüm kapsamı başarısızdır).
    for (const other of declaredLayers) {
      if (!expect.layers.some((layer) => other.scope === layer.scope && (other.level || '') === (layer.level || '') && sameNames(layer, other))) failures.push(`beklenmeyen kapsam ${other.scope}${other.level ? `/${other.level}` : ''} bildirildi`);
    }
    // Projeler kapsamının özet okuması koşulsuz görev okumasıdır (portföy satırları ayrıca okunur): o kapsamın kendi nüfusudur.
    const owns = (layer, request) => readsLayer(layer, request) || (layer.scope === 'projects' && readsLayer({ scope: 'all' }, request));
    if (requests.some((request) => !expect.layers.some((layer) => owns(layer, request)))) failures.push('beklenmeyen kapsam okundu');
  }
  // Birden çok doğru kararı olan vakada (`intentAny`) planlanmış sonuç da planın kendisiyle puanlanır (karar tek başına yetmez).
  if ((expect.intent === 'rota' || expect.intentAny?.includes('rota')) && result.outcome === 'planned') {
    const scope = scopeOf(requests);
    // Beklentide kapsam yoksa (ayrık kümede bilinçli olarak serbest) kapsam puanlanmaz; Tier B vakalarının hepsi kapsam taşır.
    const pairedSelf = expect.withSelf === true && result.plan?.analysis?.withSelf === true && expect.scope === 'person' && new Set(requests.map((request) => scopeOf([request]))).size === 2
      && requests.every((request) => ['person', 'self'].includes(scopeOf([request])));
    if (expect.withSelf === true && !pairedSelf) failures.push('kendiyle karşılaştırma eksik');
    if (expect.scope !== undefined && scope !== expect.scope && !pairedSelf) failures.push(`kapsam ${scope} ≠ ${expect.scope}`);
    const teamRequests = requests.filter((request) => request.filters?.assignee === 'team');
    if (expect.level && (!teamRequests.length || !teamRequests.every((request) => request.filters?.teamLevel === expect.level))) failures.push(`düzey ${expect.level} her ekip isteğinde değil`);
    const names = (values) => JSON.stringify([...new Set(values.map((value) => containmentText(String(value))))].sort());
    if (expect.names && names(requests.flatMap((request) => (request.entities || []).map((entity) => entity.query).filter((query) => query != null))) !== names(expect.names)) failures.push('ad kümesi beklenenle aynı değil');
    if (expect.visual && result.plan?.visual !== true) failures.push('görselleştirme bayrağı yok');
    // Kadro gerektiren soru (görevi olmayan üyeler): yalnızca kadroyla okunan ekip iş yükü karşılar; kişilere göre görev kırılımı
    // görevi olmayan üyeyi göstermez.
    if (expect.roster && !requests.some((request) => request.population?.tool === 'rota_workload_summary' && request.filters?.assignee === 'team')) failures.push('kadroyla okunan iş yükü yok');
    // Sunucunun GERÇEKTEN okuduğu yönler: özetin etkin yönleri (bölüm bütçesi, ufuk ve portföy kuralları uygulanmış); özet
    // yoksa kabul edilen ayrıntılı isteklerin eşdeğer yönleri. Bildirilen ama okunmayan yön sayılmaz.
    const focus = result.plan?.analysis ? [...result.plan.analysis.focus] : requests.flatMap(requestFocus);
    if (expect.focusAny && !focus.some((item) => expect.focusAny.includes(item))) failures.push(`yön ${focus.join('|') || '-'} beklenenlerle kesişmiyor`);
    // Beklenen ufuk kabul edilen bir okumanın aralığıdır (uçlarda en çok bir günlük yorum farkı).
    const bounded = requests.filter((request) => request.filters?.dateFrom || request.filters?.dateTo);
    if (expect.window && (!bounded.length || !bounded.every((request) => request.filters?.dateFrom && request.filters?.dateTo
      && Math.abs(day(request.filters.dateFrom) - day(expect.window[0])) <= 1 && Math.abs(day(request.filters.dateTo) - day(expect.window[1])) <= 1))) {
      failures.push(`ufuk ${expect.window.join('..')} okunmuyor`);
    }
    if (expect.overdueUnwindowed && !requests.some((request) => !request.filters?.dateFrom && !request.filters?.dateTo
      && (request.filters?.deadline === 'overdue' || request.metrics?.includes('tasks.overdue')))) failures.push('mevcut gecikme ayrı okunmadı');
    if (expect.upcomingWindow) {
      const resolve = (value) => /^T\+-?\d+$/.test(value) ? day(corpus.today) + Number(value.slice(2)) : day(value);
      const [from, to] = expect.upcomingWindow.map(resolve);
      if (!requests.some(({ population, filters = {} }) => ['rota_task_search', 'rota_task_analytics'].includes(population?.tool)
        && !population.groupBy && filters.deadline !== 'overdue' && (!filters.dateField || filters.dateField === 'targetFinish')
        && Array.isArray(filters.status) && filters.status.length === 2 && ['todo', 'in_progress'].every((status) => filters.status.includes(status))
        && Math.abs(day(filters.dateFrom) - from) <= 1 && Math.abs(day(filters.dateTo) - to) <= 1)) failures.push('yaklaşan teslimat ufku okunmadı');
    }
  }
  return failures;
}

export async function plannerCase(item, { completeRound = completeModelRound } = {}) {
  const rounds = [];
  const result = await planCase({ testCase: { id: 'q', text: item.text }, runTurn: liveTurn(rounds, completeRound), adviceFor: async () => ({ state: 'unavailable', candidates: [] }),
    now: new Date(`${corpus.today}T09:00:00.000Z`), catalog: toolCatalogForModel() });
  const failures = plannerScore(result, item.expect);
  const firstPass = rounds.length === 1 && !failures.length;
  return { id: item.id, rounds: rounds.length, firstPass, analysis: Boolean(result.plan?.analysis),
    infrastructure: rounds.find((round) => round.infrastructure)?.infrastructure || null, failures };
}

/* ── Tier C/D/E: konuşma ──────────────────────────────────────────── */

const plannerRouting = (planner, dry) => ({ planner, dry, escalations: 0 });

export async function conversationCase(t, turns, { plannerModel, composeModel, seed = rotaToolSeed(), sicil = AYSE, completeRound } = {}) {
  const rounds = [];
  const routing = plannerRouting(plannerModel, !composeModel);
  const provider = qualificationProvider(rounds, { provider: 'claude', routing, ...(completeRound ? { completeRound } : {}) });
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { sicil, seed, provider });
  const results = [];
  for (const turn of turns) {
    const before = rounds.length;
    const escalationsBefore = routing.escalations;
    let result;
    try { result = await ask({ ...turn, scripted: !plannerModel }, { detail: turn.expect?.detail || null }); }
    catch (error) {
      const infrastructure = rounds.slice(before).find((round) => round.infrastructure)?.infrastructure;
      if (!infrastructure) throw error;
      results.push({ text: turn.id || null, finish: 'error', infrastructure, failures: [`altyapı ${infrastructure}`] });
      summary.turns += 1;
      break;
    }
    const line = logs.map((row) => (row.includes('"operation":"ai.grounded.turn"') ? JSON.parse(row.slice(row.indexOf('{'))) : null)).filter(Boolean).at(-1);
    const presentation = line?.context?.presentation || null;
    const failures = turnViolations(result, turn.expect || {}, { live: Boolean(plannerModel) });
    if (routing.escalations > escalationsBefore) failures.push('DEEP_ESCALATION');
    const measured = rounds.slice(before);
    if (measured.some((round) => round.infrastructure)) failures.push(`altyapı ${measured.find((round) => round.infrastructure).infrastructure}`);
    const composed = composeModel && turn.requireComposed ? composedProblem(presentation) : null;
    if (composed) failures.push(composed);
    // Yerel tanı (PHASE4E_DEBUG): planlayıcının çağrıları ve sunucunun ret notları; rapora girmez.
    if (process.env.PHASE4E_DEBUG && failures.length) {
      // Her planlayıcı turunun, soru iletisinden sonraki kısmı: modelin çağrıları ve sunucunun ret notları.
      const trail = result.inputs.flatMap((input) => {
        const messages = input.messages || [];
        const start = messages.findLastIndex((message) => message.role === 'user');
        return messages.slice(start + 1).map((message) => ({ role: message.role, calls: (message.toolCalls || []).map((call) => `${call.name}(${String(call.arguments).slice(0, 700)})`),
          content: String(message.content || '').slice(0, 600) }));
      }).filter((item, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index);
      const reads = result.log.filter((row) => ['task-facts', 'portfolio'].includes(row.query)).map((row) => ({ query: row.query,
        ...Object.fromEntries(['assigneeMode', 'teamLevel', 'projectId', 'personSicil', 'dateFrom', 'dateTo', 'withAssignees', 'taskIds'].filter((key) => row.params?.[key] != null && row.params[key] !== '').map((key) => [key, String(row.params[key]).slice(0, 40)])) }));
      appendPrivateDiagnostic(process.env.PHASE4E_DEBUG, { turn: turn.text, failures, finish: result.answer?.finishReason, reads, trail, answer: result.answer?.content });
    }
    const content = String(result.answer?.content || '');
    results.push({ text: turn.id || null, finish: result.answer?.finishReason ?? null, plannerRounds: measured.filter((round) => round.purpose === 'plan').length, declarations: line?.context?.declarations ?? null,
      findings: presentation?.findings ?? 0, charts: renderedCharts(content).map((chart) => chart.type), concluded: answerQuality(content).ending,
      mode: presentation?.mode ?? null, server: presentation?.server === true, chartInserted: presentation?.chartInserted === true, reason: presentation?.reason ?? null, issue: presentation?.issue ?? null,
      rejected: presentation?.rejected ?? null, infrastructure: measured.find((round) => round.infrastructure)?.infrastructure || null, failures });
    summary.turns += 1;
    if (routing.escalations > escalationsBefore) summary.escalations += 1;
    if (measured.some((round) => round.infrastructure)) break;
  }
  return results;
}

const COMPOSITION_CASES = Object.freeze([
  ['d01', 'durumumu değerlendir', { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }],
  ['d02', 'iş yükümü grafikle göster', { scope: 'self', focus: ['workload'] }, true],
  ['d03', 'görevlerimin dağılımını grafik olarak göster', { scope: 'self', focus: ['status'] }, true],
  ['d04', 'ekibimin durumunu değerlendir', { scope: 'team', focus: ['overview', 'workload', 'overdue'] }],
  ['d05', 'Radar Modernizasyonu projesinin genel durumunu değerlendir', { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview', 'overdue', 'workload'] }],
  ['d06', 'açık işlerimin aylara göre dağılımını göster', { scope: 'self', focus: ['schedule'] }, true],
  ['d07', 'projelerimi karşılaştır', { scope: 'projects', focus: ['projects'] }],
  ['d08', "Ayşe Yılmaz ile Zeynep Kaya'nın iş yükünü karşılaştır", { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['workload'] }],
  ['d09', 'gecikmiş işlerimi değerlendir', { scope: 'self', focus: ['overdue'] }],
  ['d10', 'durumumu göstergelerle özetle', { scope: 'self', focus: ['overview'] }, true],
  // Sınama ekibinde görevli tek kişi vardır (iş yükü grafiği adaysızdır); ekip grafiği durum dağılımıyla sınanır.
  ['d11', 'ekibimin görevlerinin durum dağılımını grafikle göster', { scope: 'team', focus: ['status'] }, true],
  ['d12', 'öncelik dağılımımı ve kritik işlerimi göster', { scope: 'self', focus: ['priority', 'critical'] }]
]);

const E2E_CASES = Object.freeze([
  ['e01', [{ text: 'bu hafta işlerim açısından durumumu değerlendir', expect: { assignee: 'me', finish: 'stop' } }]],
  ['e02', [{ text: 'ekibimin bu haftaki durumunu değerlendir', expect: { assignee: 'team', finish: 'stop' } }]],
  ['e03', [{ text: 'Radar Modernizasyonu projesinin genel durumunu değerlendir', expect: { project: true, finish: 'stop' } }]],
  ['e04', [{ text: 'görevlerimin dağılımını grafik olarak göster', expect: { assignee: 'me', chart: true, finish: 'stop' } }]],
  ['e05', [{ text: 'ekibimin iş yükünü grafik olarak göster', expect: { assignee: 'team', chart: true, finish: 'stop' } }]],
  ['e06', followups.chains.find((chain) => chain.id === 'B').turns.slice(0, 4).map(({ text, expect }) => ({ text, expect }))]
]);

/**
 * Çok kapsamlı altın planın kapsam başına yönleri: kapsamın kendi yönleri, yazılmadıysa birincil yönler (kapsamda anlamı olmayan yön,
 * ör. kendi işlerinde alt birim kırılımı, devralınmaz). Her kapsamın yönü kendi kanıtıyla denetlenir.
 */
function layerFocus(layer, primary) {
  const applicable = (focus) => !(focus === 'org' && ['self', 'person'].includes(layer.scope)) && !(focus === 'projects' && layer.scope === 'project');
  return (layer.focus || primary.focus || []).filter(applicable);
}

/** Altın plandaki açık isteklerin (özetin yanındaki liste) teslim beklentisi: araç ve süzgeçler (göreli gün çözülmüş). */
function explicitExpectations(plan, resolveDay) {
  if (!plan?.analysis) return [];
  return [plan.request, ...(plan.additionalRequests || [])].filter((item) => item?.population?.tool)
    .map((item) => ({ tool: item.population.tool, filters: Object.fromEntries(Object.entries(item.filters || {}).map(([key, value]) => [key, ['dateFrom', 'dateTo'].includes(key) ? resolveDay(value) : value])),
      // Sıralamalı istekte ölçü, yön ve satır sınırı da beklentidir (en yakın teslimatlar ile en uzak teslimatlar aynı değildir).
      ...(item.operation === 'rank' && item.rank?.metric ? { rank: { metric: item.rank.metric, order: item.rank.order, ...(Number.isInteger(item.rank.limit) ? { limit: item.rank.limit } : {}) } } : {}) }));
}

/**
 * Kıyas vakasının canlı beklentisi: altın planın kapsamı (her nüfus okumasında), açık grafik isteği ve vaka sınıfı. Tam vakada
 * doğrulanmış yanıt (stop) zorunludur; kısmi vakada kapsamı doğrulanmış, dolu ve kanıtlı stop yanıtı gerekir; sınırlı vakada
 * verisiz ve desteklenmiyor bitişi gerekir; olgusal yanıt sınırlılık başarısı sayılamaz. Sunucu planı modelin yerine koymaz.
 */
export function benchmarkExpectation(item) {
  const analysis = item.plan?.analysis;
  const scope = analysis?.scope;
  const seed = analysisBenchmarkSeed();
  const names = analysis?.names || item.expect?.names || [];
  const resolveDay = (value) => {
    const token = /^T\+(-?\d+)$/.exec(value || '');
    // Göreli gün, vakanın KOŞTUĞU günden sayılır (sentetik verinin ve sistem yönergesinin günü: NOW'ın Türkiye günü). Planlayıcı
    // derleminin günü (`corpus.today`) başka bir gündür; onunla çözülen ufuk, modelin doğru yazdığı dönemi "okunmadı" sayıyordu.
    return token ? new Date(Date.parse(`${BENCHMARK_TODAY}T00:00:00Z`) + Number(token[1]) * 86400000).toISOString().slice(0, 10) : value;
  };
  const from = resolveDay(analysis?.dateFrom);
  const to = resolveDay(analysis?.dateTo);
  // Aşama G: çok kapsamlı planda her kapsamın kendi nüfusu okunur; tek kapsam beklentisi yerine kapsam başına okuma beklenir.
  const layers = analysis?.also?.length ? [analysis, ...analysis.also].map((entry) => ({ scope: entry.scope, ...(entry.level ? { level: entry.level } : {}), focus: layerFocus(entry, analysis) })) : null;
  return { ...item.expect, ...(item.handling !== 'limitation' ? { finish: 'stop' } : { finish: 'unsupported', noData: true }),
    ...(scope ? { scope } : {}), ...(layers ? { layers } : {}),
    ...(layers ? {} : scope === 'team' ? { assignee: 'team' } : scope === 'self' ? { assignee: 'me' } : {}),
    ...(analysis?.level && !layers ? { level: analysis.level } : {}), ...(analysis?.focus ? { focus: [...analysis.focus] } : {}),
    // Çok kapsamlı planda adlı birincil kapsamın kimlik koşulu her okumaya uygulanmaz (ek kapsamın okuması o kimliği taşımaz);
    // kapsamlar katman denetimiyle tek tek sınanır.
    ...(scope === 'project' && !layers ? { project: true, projectIds: names.map((name) => seed.projects.find((row) => row.ProjectName === name)?.ProjectId || `bilinmeyen:${name}`) } : {}),
    ...(scope === 'person' && !layers ? { person: true, people: names.map((name) => seed.people.find((row) => row.DisplayName === name)?.Sicil || -1) } : {}),
    ...(from && to ? { window: [from, to] } : {}),
    ...(item.plan?.table ? { table: true } : {}),
    ...(item.expect?.chart || item.expect?.chartTypes?.length ? { chart: true } : {}) };
}

/**
 * Aşama G vakasının canlı beklentisi: altın planın kapsamı ve düzeyi (tek kapsamda her nüfus okumasında; çok kapsamlıda kapsam başına),
 * vaka sınıfının bitişi ve vakanın kendi beklentileri (bulgu, çekince, zorunlu/yasak ifade). Yetkisiz kapsam `deniedLayers` ile
 * okunmak zorunda değildir. Sunucu planı modelin yerine koymaz.
 */
export function executiveExpectation(item) {
  const turns = item.turns || [{ text: item.text, plan: item.plan }];
  // Takip turu ("previous") önceki turun kapsamını sürdürür; açıklama ya da ret bekleyen vakada kapsam okunmaz.
  const analysis = item.handling === 'clarify' ? null
    : turns.map((turn) => turn.plan?.analysis).filter((entry) => entry && entry.scope !== 'previous').at(-1) || null;
  const scope = analysis?.scope;
  const denied = (layer) => (item.expect?.deniedLayers || []).some((entry) => entry.scope === layer.scope && (entry.level || null) === (layer.level || null));
  const seed = executiveBenchmarkSeed();
  // Adlı kapsam kendi kimliğiyle beklenir (sentetik verideki Sicil/proje kimliği): başka kişinin ya da projenin okuması karşılamaz.
  const identity = (layer, name) => (layer === 'person' ? { sicil: seed.people.find((row) => row.DisplayName === name)?.Sicil ?? -1 }
    : layer === 'project' ? { projectId: seed.projects.find((row) => row.ProjectName === name)?.ProjectId ?? `bilinmeyen:${name}` } : {});
  const layers = analysis?.also?.length ? [analysis, ...analysis.also].map((entry) => ({ scope: entry.scope, ...(entry.level ? { level: entry.level } : {}),
    ...(['person', 'project'].includes(entry.scope) && entry.names?.length === 1 ? identity(entry.scope, entry.names[0]) : {}), focus: layerFocus(entry, analysis) }))
    .map((layer) => (denied(layer) ? { ...layer, optional: true } : layer)) : null;
  const finish = item.expect?.finish || { denied: 'unavailable', clarify: 'clarification', limitation: 'unsupported' }[item.handling] || 'stop';
  const names = analysis?.names || [];
  const resolveDay = (value) => {
    const token = /^T\+(-?\d+)$/.exec(value || '');
    return token ? new Date(Date.parse(`${BENCHMARK_TODAY}T00:00:00Z`) + Number(token[1]) * 86400000).toISOString().slice(0, 10) : value;
  };
  const explicitRequests = explicitExpectations(turns.at(-1).plan, resolveDay);
  const from = resolveDay(analysis?.dateFrom);
  const to = resolveDay(analysis?.dateTo);
  const window = from && to ? [from, to] : null;
  return { ...item.expect, finish, ...(item.handling === 'limitation' ? { noData: true } : {}),
    // Açıklama vakası nüfus okumadan sorar (ad çözümü serbesttir).
    ...(item.handling === 'clarify' ? { noPopulation: true } : {}), ...(explicitRequests.length ? { explicitRequests } : {}),
    ...(scope && !item.expect?.scopeDenied ? { scope } : {}), ...(layers ? { layers } : {}),
    ...(layers || item.expect?.scopeDenied ? {} : scope === 'team' ? { assignee: 'team', ...(analysis.level ? { level: analysis.level } : {}) } : scope === 'self' ? { assignee: 'me' } : {}),
    ...(scope === 'project' && !layers && !item.expect?.scopeDenied ? { project: true, projectIds: names.map((name) => seed.projects.find((row) => row.ProjectName === name)?.ProjectId || `bilinmeyen:${name}`) } : {}),
    ...(scope === 'person' && !layers && !item.expect?.scopeDenied ? { person: true, people: names.map((name) => seed.people.find((row) => row.DisplayName === name)?.Sicil || -1) } : {}),
    // Özetin dönemi: dönemli okumalar istenen takvim penceresidir (dönemsiz gecikme okuması ayrıca serbesttir).
    ...(window && finish === 'stop' ? { window } : {}),
    // Tek kapsamlı ekip turunun yönleri kanıtla karşılanır (kapsam katmanlarındaki denetimin aynısı). Özne karşılaştırmasında
    // (adlı kişiler/projeler, kendiyle karşılaştırma) ve kendi işlerinde yönler değer okumalarıdır; o biçimler burada denetlenmez.
    ...(analysis?.scope === 'team' && !analysis.withSelf && !layers && finish === 'stop' && !item.expect?.scopeDenied ? { scopeFocus: layerFocus(analysis, analysis) } : {}),
    // Portföy kapsamı (birincil) portföy okumasını gerektirir: görev okumalarıyla geçemez.
    ...(scope === 'projects' && !item.expect?.scopeDenied && !denied(analysis) ? { portfolio: true } : {}),
    ...(turns.at(-1).plan?.visual ? { chart: true } : {}) };
}

/**
 * Çok turlu vakanın ara turunun beklentisi: o turun altın planından kurulan kapsam ve kimlik (son tur vakanın kendi beklentisidir).
 * Ara tur yalnızca doğrulanmış yanıtla (stop ya da turun kendi bitişi) bitmez; istenen kapsamı okumuş olmalıdır.
 */
export function executiveTurnExpectation(item, index) {
  const turns = item.turns || [{ text: item.text, plan: item.plan }];
  if (index >= turns.length - 1) return executiveExpectation(item);
  const partial = { id: item.id, profile: item.profile, handling: 'full', turns: turns.slice(0, index + 1), expect: {} };
  return { ...executiveExpectation(partial), finish: turns[index].expectFinish || 'stop' };
}

/** Düzen katmanı MODELİN düzenini sınar: sunucunun belirlenimci yedeği (model düzeni reddedildi) geçer sayılmaz. */
export function composedProblem(presentation) {
  if (presentation?.mode === 'composed' && presentation.server !== true) return null;
  return `düzen ${presentation?.mode}${presentation?.server ? '/sunucu' : ''}/${presentation?.reason}/${presentation?.issue}/${presentation?.rejected}`;
}

/** İstenen vaka kimliği bu katmanda yoksa (yazım hatası) koşu sıfır vakayla "geçmez": hata verir. */
export function pickCases(items, only = ONLY) {
  if (!only.length) return items;
  const ids = items.map((item) => item.id ?? item[0]);
  const unknown = only.filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`PHASE4E_CASES bu katmanda bulunmayan vaka: ${unknown.join(', ')}`);
  return items.filter((item) => only.includes(item.id ?? item[0]));
}

/* ── Kayıt ve özet ───────────────────────────────────────────────── */

export function usageTotals({ log = process.env.PLANNER_CLAUDE_LOG, runId = RUN_ID } = {}) {
  const rows = log && existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((row) => row?.runId === runId && row?.usage) : [];
  const sum = (key) => rows.reduce((total, row) => total + (row.usage[key] ?? 0), 0);
  return { calls: rows.length, forcedRetries: rows.filter((row) => row.forcedToolCall).length, schemaRejected: rows.filter((row) => row.schemaRejected).length, forcedText: rows.filter((row) => row.forcedText).length, input: sum('input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), cacheRead: sum('cache_read_input_tokens'), output: sum('output_tokens'),
    thinking: rows.reduce((total, row) => total + (row.usage.output_tokens_details?.thinking_tokens ?? 0), 0), models: [...new Set(rows.flatMap((row) => row.models || []))] };
}

export function record(entry) {
  summary.cases += 1;
  if (!entry.failures.length) summary.passed += 1;
  else summary.failed.push(entry.id);
  summary.results.push(entry);
  process.stderr.write(`[${entry.id}] ${entry.failures.length ? `FAIL ${entry.failures.join('; ')}` : 'ok'}\n`);
  // Kaydedilen başarısızlık koşuyu da başarısız kılar (`node --test` sıfırdan farklı çıkar); yalnızca yazılıp geçmez.
  assert.deepEqual(entry.failures, [], `${entry.id}: ${entry.failures.join('; ')}`);
}

/**
 * Vakalar sırayla kaydedilir; altyapı hatası korunur ve sonraki vaka başlatılmaz. Bütün vakalar TEK üst sınamanın alt
 * sınamalarıdır: üst düzeyde ardışık beklenen sınamalarda kök sınama ilk vakadan sonra kapanıp özeti (test.after) erken
 * yazıyordu; rapor yalnızca ilk vakayı içeriyordu.
 */
export async function runQualificationCases(items, execute) {
  await test('nitelendirme vakaları', async (parent) => {
    for (const item of items) {
      let infrastructure = false;
      await parent.test(`nitelendirme vakası: ${item.id}`, async (t) => {
        const entry = await execute(t, item);
        infrastructure = Boolean(entry.infrastructure || entry.turns?.some((turn) => turn.infrastructure));
        record(entry);
      });
      if (infrastructure) break;
    }
  });
}

const direct = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (direct) {
  if (!process.env.PLANNER_CLAUDE_LOG) throw new Error('PLANNER_CLAUDE_LOG gerekli: belirteç bütçesi ve önbellek kayıt dosyasıyla izlenir.');
  process.env.PLANNER_CLAUDE_RUN_ID = RUN_ID;
  test.after(() => {
    const totals = usageTotals();
    const report = { ...summary, usage: totals };
    process.stderr.write(`${JSON.stringify({ ...report, results: undefined })}\n`);
    if (OUT) appendFileSync(OUT, `${JSON.stringify(report)}\n`);
    assert.equal(totals.thinking, 0, 'THINKING_FORBIDDEN');
    assert.ok(totals.models.every((model) => model === EXPECTED_MODEL), 'MODEL_MISMATCH');
  });
  const pick = (items) => pickCases(items);
  if (TIER === 'B') {
    for (const item of pick(corpus.cases.filter((entry) => entry.tierB))) {
      test(`davranış durumu: ${item.id}`, async () => {
        const entry = await plannerCase(item);
        if (entry.firstPass) summary.firstPass += 1;
        summary.repairs += Math.max(0, entry.rounds - 1);
        summary.turns += 1;
        record(entry);
      });
    }
  } else if (TIER === 'C') {
    for (const chain of pick(followups.chains)) {
      test(`takip zinciri ${chain.id}`, async (t) => {
        const results = await conversationCase(t, chain.turns.map(({ text, expect }) => ({ text, expect })), { plannerModel: true, composeModel: false });
        record({ id: chain.id, turns: results, failures: results.flatMap((row, index) => row.failures.map((failure) => `#${index + 1} ${failure}`)) });
      });
    }
  } else if (TIER === 'D') {
    for (const [id, text, analysis, visual] of pick(COMPOSITION_CASES)) {
      test(`senaryo: ${id}`, async (t) => {
        const plan = { intent: 'rota', language: 'tr', analysis, ...(visual ? { visual: true } : {}) };
        const results = await conversationCase(t, [{ text, plan, requireComposed: true, expect: { finish: 'stop', ...(visual ? { chart: true } : {}) } }], { plannerModel: false, composeModel: true });
        record({ id, turns: results, failures: results.flatMap((row) => row.failures) });
      });
    }
  } else if (TIER === 'F' && process.env.PHASE4E_SET === 'holdout') {
    await runQualificationCases(pick(benchmark.holdout), async (_t, item) => {
      const entry = await plannerCase(item);
      if (entry.firstPass) summary.firstPass += 1;
      summary.repairs += Math.max(0, entry.rounds - 1);
      summary.turns += 1;
      return { ...entry, id: item.id, handling: item.handling };
    });
  } else if (TIER === 'F') {
    await runQualificationCases(pick(benchmark.original), async (t, item) => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const seed = analysisBenchmarkSeed();
      t.mock.timers.reset();
      const turn = { text: item.text, requireComposed: item.handling === 'full', expect: benchmarkExpectation(item) };
      const [result] = await conversationCase(t, [turn], { plannerModel: true, composeModel: true, seed, sicil: BENCH_PROFILES[item.profile] });
      const failures = [...result.failures];
      if (item.handling === 'partial' && result.finish !== 'stop') failures.push(`kısmi vaka bitişi ${result.finish}`);
      return { id: item.id, order: item.order, observed: item.observed, handling: item.handling, turns: [result], failures };
    });
  } else if (TIER === 'G' && process.env.PHASE4E_SET === 'holdout') {
    await runQualificationCases(pick(executive.holdout), async (_t, item) => {
      const entry = await plannerCase(item);
      if (entry.firstPass) summary.firstPass += 1;
      summary.repairs += Math.max(0, entry.rounds - 1);
      summary.turns += 1;
      return { ...entry, id: item.id };
    });
  } else if (TIER === 'G') {
    await runQualificationCases(pick(executive.scenarios), async (t, item) => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const seed = executiveBenchmarkSeed();
      t.mock.timers.reset();
      // Çok turlu vakada önceki turlar yalnızca doğrulanmış yanıtla biter; puan son turun beklentisidir.
      // Ara turlar da kendi altın planlarının kapsamıyla puanlanır: son turdaki doğru ret, ara turda yanlış kapsamı örtmez.
      const turns = (item.turns || [{ text: item.text }]).map((turn, index, all) => ({ text: turn.text,
        requireComposed: index === all.length - 1 && item.handling === 'full', expect: executiveTurnExpectation(item, index) }));
      const results = await conversationCase(t, turns, { plannerModel: true, composeModel: true, seed, sicil: EXEC_PROFILES[item.profile] });
      const failures = results.flatMap((row, index) => row.failures.map((failure) => (results.length > 1 ? `#${index + 1} ${failure}` : failure)));
      if (item.handling === 'partial' && results.at(-1)?.finish !== 'stop' && !item.expect?.finish) failures.push(`kısmi vaka bitişi ${results.at(-1)?.finish}`);
      return { id: item.id, persona: item.persona, handling: item.handling, turns: results, failures };
    });
  } else if (TIER === 'E') {
    for (const [id, turns] of pick(E2E_CASES)) {
      test(`senaryo: ${id}`, async (t) => {
        const results = await conversationCase(t, turns, { plannerModel: true, composeModel: true });
        record({ id, turns: results, failures: results.flatMap((row, index) => row.failures.map((failure) => `#${index + 1} ${failure}`)) });
      });
    }
  } else throw new Error('PHASE4E_TIER: B | C | D | E | F | G');
}
