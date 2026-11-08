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

function liveTurn(rounds) {
  return (options) => runGroundedTurn(Object.freeze({
    sicil: 900001, profile: 'chat.tools', model: 'planner-under-test', reportedModel: () => null, maxOutputTokens: 4096,
    signal: new AbortController().signal, remainingMs: () => 600000,
    async round(input) {
      const reply = await completeModelRound({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice });
      if (reply?.error) throw Object.assign(new Error(`MODEL_INFRASTRUCTURE ${reply.error}`), { code: 'MODEL_INFRASTRUCTURE' });
      if (!reply.models?.length || reply.models.some((model) => model !== EXPECTED_MODEL)) throw Object.assign(new Error('PLANNER_MODEL_UNVERIFIED'), { code: 'MODEL_INFRASTRUCTURE' });
      if (reply.thinking !== 'off' || reply.usage?.output_tokens_details?.thinking_tokens) throw Object.assign(new Error('PLANNER_THINKING_ON'), { code: 'MODEL_INFRASTRUCTURE' });
      rounds.push({ finish: reply.finishReason });
      return { text: reply.text || '', toolCalls: (reply.toolCalls || []).map((call, index) => ({ id: `c${rounds.length}_${index}`, name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}), oversize: false })),
        finishReason: reply.finishReason || 'stop', model: null, configuredModel: 'planner-under-test', modelMismatch: false, usage: null, durationMs: 0, firstEventMs: null };
    }
  }), options);
}

/** Tier B puanı: kabul edilen planın kararı, HER isteğin kapsamı, düzey, adlar, görsel bayrağı, etkin yönler ve ufuk. */
export function plannerScore(result, expect) {
  const failures = [];
  const decision = result.decisions.at(-1) || null;
  const intent = result.outcome === 'planned' ? 'rota' : decision?.intent || result.outcome;
  if (result.outcome === 'error') failures.push(`hata ${result.error}`);
  if (intent !== expect.intent) failures.push(`karar ${intent} ≠ ${expect.intent}`);
  if (expect.reason && decision?.reason !== expect.reason) failures.push(`neden ${decision?.reason} ≠ ${expect.reason}`);
  const requests = result.plan?.requests || [];
  if (expect.intent === 'rota' && result.outcome === 'planned') {
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

async function plannerCase(item) {
  const rounds = [];
  const result = await planCase({ testCase: { id: 'q', text: item.text }, runTurn: liveTurn(rounds), adviceFor: async () => ({ state: 'unavailable', candidates: [] }),
    now: new Date(`${corpus.today}T09:00:00.000Z`), catalog: toolCatalogForModel() });
  const failures = plannerScore(result, item.expect);
  const firstPass = rounds.length === 1 && !failures.length;
  return { id: item.id, rounds: rounds.length, firstPass, analysis: Boolean(result.plan?.analysis), failures };
}

/* ── Tier C/D/E: konuşma ──────────────────────────────────────────── */

const plannerRouting = (planner, dry) => ({ planner, dry, escalations: 0 });

async function conversationCase(t, turns, { plannerModel, composeModel, seed = rotaToolSeed(), sicil = AYSE }) {
  const rounds = [];
  const routing = plannerRouting(plannerModel, !composeModel);
  const provider = qualificationProvider(rounds, { provider: 'claude', routing });
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { sicil, seed, provider });
  const results = [];
  for (const turn of turns) {
    const before = rounds.length;
    const escalationsBefore = routing.escalations;
    const result = await ask({ ...turn, scripted: !plannerModel }, { detail: turn.expect?.detail || null });
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
      rejected: presentation?.rejected ?? null, failures });
    summary.turns += 1;
    if (routing.escalations > escalationsBefore) summary.escalations += 1;
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
    return token ? new Date(Date.parse(`${corpus.today}T00:00:00Z`) + Number(token[1]) * 86400000).toISOString().slice(0, 10) : value;
  };
  const from = resolveDay(analysis?.dateFrom);
  const to = resolveDay(analysis?.dateTo);
  return { ...item.expect, ...(item.handling !== 'limitation' ? { finish: 'stop' } : { finish: 'unsupported', noData: true }),
    ...(scope ? { scope } : {}),
    ...(scope === 'team' ? { assignee: 'team' } : scope === 'self' ? { assignee: 'me' } : {}),
    ...(analysis?.level ? { level: analysis.level } : {}), ...(analysis?.focus ? { focus: [...analysis.focus] } : {}),
    ...(scope === 'project' ? { project: true, projectIds: names.map((name) => seed.projects.find((row) => row.ProjectName === name)?.ProjectId || `bilinmeyen:${name}`) } : {}),
    ...(scope === 'person' ? { person: true, people: names.map((name) => seed.people.find((row) => row.DisplayName === name)?.Sicil || -1) } : {}),
    ...(from && to ? { window: [from, to] } : {}),
    ...(item.plan?.table ? { table: true } : {}),
    ...(item.expect?.chart || item.expect?.chartTypes?.length ? { chart: true } : {}) };
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
    for (const item of pick(benchmark.holdout)) {
      test(`ayrık vaka: ${item.id}`, async () => {
        const entry = await plannerCase(item);
        if (entry.firstPass) summary.firstPass += 1;
        summary.repairs += Math.max(0, entry.rounds - 1);
        summary.turns += 1;
        record({ ...entry, id: item.id, handling: item.handling });
      });
    }
  } else if (TIER === 'F') {
    for (const item of pick(benchmark.original)) {
      test(`kıyas vakası: ${item.id}`, async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW });
        const seed = analysisBenchmarkSeed();
        t.mock.timers.reset();
        const turn = { text: item.text, requireComposed: item.handling === 'full', expect: benchmarkExpectation(item) };
        const [result] = await conversationCase(t, [turn], { plannerModel: true, composeModel: true, seed, sicil: BENCH_PROFILES[item.profile] });
        const failures = [...result.failures];
        if (item.handling === 'partial' && result.finish !== 'stop') failures.push(`kısmi vaka bitişi ${result.finish}`);
        record({ id: item.id, order: item.order, observed: item.observed, handling: item.handling, turns: [result], failures });
      });
    }
  } else if (TIER === 'E') {
    for (const [id, turns] of pick(E2E_CASES)) {
      test(`senaryo: ${id}`, async (t) => {
        const results = await conversationCase(t, turns, { plannerModel: true, composeModel: true });
        record({ id, turns: results, failures: results.flatMap((row, index) => row.failures.map((failure) => `#${index + 1} ${failure}`)) });
      });
    }
  } else throw new Error('PHASE4E_TIER: B | C | D | E | F');
}
