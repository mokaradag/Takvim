/**
 * Planlayıcı değerlendirmesinin altın etiketleri ve puanlaması (Aşama 4C).
 *
 * Altın etiket belgesi kapalı şemadır ve Aşama 4A kıyas kümesine bağlıdır. Her yanıt vakasının örnek planı
 * üretimdeki planlama sınırından (runGroundedTurn, ilk SQL'den önce) geçer ve kendi etiketini karşılar:
 * etiketler karşılanabilirdir. Puanlama anlama bakar: ilgisiz araç, eksik ya da fazla varlık, yanlış pencere,
 * eksik ya da fazla bölüm ve yanlış bağımlı kaynak yanlış sayılır. Modele giden metin vaka kimliği ya da
 * altın etiket taşımaz.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planCase, recordOf } from '../scripts/planner-evaluation.mjs';
import { loadPlannerBenchmark, PLANNER_BENCHMARK_FILE, resolveExample, scoreDecision } from '../scripts/planner-scoring.mjs';

const { semanticPlanningAdvice } = await import('../src/server/ai/assistant/semanticPlanning.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');

const DOCUMENT = JSON.parse(readFileSync(PLANNER_BENCHMARK_FILE, 'utf8'));
const catalog = toolCatalogForModel();
const unavailable = () => semanticPlanningAdvice({ query: 'x', catalog, retrieve: async () => ({ status: 'unavailable', candidates: [], failure: { reason: 'PROFILE_DISABLED' } }) });

/** Her turda verilen plan çağrısını döndüren model; gördüğü girdiler sızıntı denetimi için saklanır. */
function scriptedModel(args) {
  const inputs = [];
  return {
    inputs,
    async complete(payload) {
      inputs.push(JSON.stringify(payload));
      return { text: '', toolCalls: [{ id: 'call_1', name: 'rota_plan', arguments: JSON.stringify(args), oversize: false }], usage: null, models: ['scripted'], error: null, durationMs: 0 };
    }
  };
}

async function decide(loaded, testCase, args) {
  const model = scriptedModel(args);
  const outcome = await planCase({ testCase, model, adviceFor: unavailable, now: loaded.now, catalog });
  return { record: recordOf(testCase, 1, outcome), inputs: model.inputs };
}

const answerPlan = (testCase, referenceDate) => ({ intent: 'rota', language: 'tr', ...resolveExample(testCase.example, referenceDate) });
const clone = (value) => JSON.parse(JSON.stringify(value));

test('altın etiket belgesi kapalı şemadır, kıyas kümesine bağlıdır ve bozulmuş biçimleri reddeder', () => {
  const loaded = loadPlannerBenchmark({ referenceDate: '2026-10-14' });
  assert.equal(loaded.cases.filter((testCase) => testCase.canonical).length, 117);
  assert.match(loaded.fingerprint, /^[0-9a-f]{64}$/);
  const rejects = (mutate, issue) => {
    const document = clone(DOCUMENT);
    mutate(document);
    assert.throws(() => loadPlannerBenchmark({ plannerDocument: document }), (error) => error.message.includes(issue), issue);
  };
  rejects((document) => { document.extra = true; }, '$.extra:unknown');
  rejects((document) => { document.semanticBenchmark = '0'.repeat(64); }, 'semanticBenchmark:stale');
  rejects((document) => { document.cases.pop(); }, 'cases:count');
  rejects((document) => { document.cases[95].plan = document.cases[0].plan; }, 'gold-forbidden');
  rejects((document) => { delete document.cases[0].example; }, 'answer-gold-required');
  rejects((document) => { document.cases[0].plan.groups[0].any[0].tools = ['rota_calendar_inspect']; }, 'tools:outside-group');
  rejects((document) => { document.cases[0].plan.groups[0].any[0].secret = 1; }, 'secret:unknown');
  rejects((document) => { document.cases[59].plan.groups.pop(); }, 'groups:count');
  rejects((document) => { document.cases[59].plan.groups[1].need = 0; }, 'need-1-uncovered');
});

test('her yanıt vakasının örnek planı üretim planlama sınırından geçer ve kendi etiketini karşılar', async () => {
  // Pazartesi ve çarşamba: hafta başı çapası bugüne eşit ve değilken.
  for (const referenceDate of ['2026-10-14', '2026-10-19']) {
    const loaded = loadPlannerBenchmark({ referenceDate });
    for (const testCase of loaded.cases.filter((item) => item.expect === 'answer')) {
      const { record } = await decide(loaded, testCase, answerPlan(testCase, referenceDate));
      assert.equal(record.outcome, 'planned', `${testCase.id} ${referenceDate}: ${record.error ?? record.outcome}`);
      assert.equal(record.declarations, 1, `${testCase.id}: örnek ilk bildirimde kabul edilir`);
      const scored = scoreDecision(testCase, record, { referenceDate });
      assert.ok(scored.correct, `${testCase.id} ${referenceDate}: ${scored.reasons.join(', ')}`);
    }
  }
});

test('açıklama ve çekimserlik vakaları yalnızca sunucunun sonlandırıcı kararıyla doğru sayılır; plan yanlıştır', async () => {
  const referenceDate = '2026-10-14';
  const loaded = loadPlannerBenchmark({ referenceDate });
  const someAnswer = loaded.cases.find((testCase) => testCase.id === 'tr-008');
  for (const testCase of loaded.cases.filter((item) => item.expect !== 'answer')) {
    const choice = testCase.expect === 'clarify' ? { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } }
      : { intent: 'abstain', language: 'tr', abstain: { reason: 'security' } };
    const chosen = await decide(loaded, testCase, choice);
    assert.ok(scoreDecision(testCase, chosen.record, { referenceDate }).correct, testCase.id);
    assert.equal(chosen.record.plan, null);
    const planned = await decide(loaded, testCase, answerPlan(someAnswer, referenceDate));
    assert.equal(scoreDecision(testCase, planned.record, { referenceDate }).correct, false, `${testCase.id}: plan ${planned.record.outcome}`);
  }
  // Yanıt vakasında sonlandırıcı karar da yanlıştır.
  const refused = await decide(loaded, someAnswer, { intent: 'abstain', language: 'tr', abstain: { reason: 'write' } });
  assert.deepEqual(scoreDecision(someAnswer, refused.record, { referenceDate }).reasons, ['decision:abstained']);
});

test('puanlama anlamı denetler: araç, varlık, pencere, süzgeç, sıralama, bölüm ve bağımlı kaynak', async () => {
  const referenceDate = '2026-10-14';
  const loaded = loadPlannerBenchmark({ referenceDate });
  const byId = new Map(loaded.cases.map((testCase) => [testCase.id, testCase]));
  const wrong = async (id, mutate, reason) => {
    const testCase = byId.get(id);
    const args = answerPlan(testCase, referenceDate);
    mutate(args);
    const { record } = await decide(loaded, testCase, args);
    assert.equal(record.outcome, 'planned', `${id}: değiştirilmiş plan da geçerli olmalı (${record.error ?? record.outcome})`);
    const scored = scoreDecision(testCase, record, { referenceDate });
    assert.equal(scored.correct, false, `${id}: ${reason}`);
    assert.ok(scored.reasons.some((item) => item.includes(reason)), `${id}: ${scored.reasons.join(', ')} ⊅ ${reason}`);
  };
  // Kullanıcının kendi görevleri yerine herkesin gecikmiş görevleri.
  await wrong('tr-008', (args) => { delete args.request.filters.assignee; }, 'filter:assignee');
  // Yarın yerine bugün.
  await wrong('tr-091', (args) => { args.request.filters.dateFrom = referenceDate; args.request.filters.dateTo = referenceDate; }, 'window:from');
  // Bağımlı bölüm yok: öncüller sorulmuş ama okunmuyor.
  await wrong('tr-091', (args) => { delete args.additionalRequests; }, 'group1');
  // Adı geçen proje düşürülmüş.
  await wrong('tr-010', (args) => { delete args.request.entities; }, 'entity:project');
  // Sorulmayan proje eklenmiş.
  await wrong('tr-008', (args) => { args.request.entities = [{ type: 'project', text: 'gecikmis' }]; }, 'entity:extra-project');
  // En çok yerine en az.
  await wrong('tr-034', (args) => { args.request.rank.order = 'asc'; }, 'rank:order');
  // İhtiyaç dışı araçla okunan ek bölüm.
  await wrong('tr-064', (args) => { args.additionalRequests = [{ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, layout: 'auto' }]; }, 'unrelated:rota_task_analytics');
  // Gereken ölçü yok.
  await wrong('tr-018', (args) => { args.request.metrics = ['task.plannedHours']; }, 'metrics:any');
  // İki talep türünden yalnızca biri (iki bölüm de aynı aracı okur).
  await wrong('tr-060', (args) => { args.request = clone(args.additionalRequests[0]); }, 'group0');
  // İki dönem karşılaştırmasında tek dönem.
  await wrong('tr-056', (args) => { delete args.additionalRequests; }, 'group1');
});

test('ek bölüm yalnızca sorunun bir okumasıysa kabul edilir', async () => {
  const referenceDate = '2026-10-14';
  const loaded = loadPlannerBenchmark({ referenceDate });
  const testCase = loaded.cases.find((item) => item.id === 'tr-090');
  const args = answerPlan(testCase, referenceDate);
  args.additionalRequests = [{ operation: 'value', metrics: ['tasks.overdue'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', text: 'Radar' }], layout: 'auto' }];
  const extra = await decide(loaded, testCase, args);
  assert.ok(scoreDecision(testCase, extra.record, { referenceDate }).correct, 'aynı projenin gecikme toplamını ayrıca okuyan bölüm kabul edilir');
  args.additionalRequests[0].entities = [{ type: 'project', text: 'Radar' }];
  args.additionalRequests[0].filters = { assignee: 'me' };
  const narrowed = await decide(loaded, testCase, args);
  assert.deepEqual(scoreDecision(testCase, narrowed.record, { referenceDate }).reasons, ['parts:extra']);
});

test('modele giden girdi vaka kimliği, beklenti, ihtiyaç ya da altın etiket taşımaz', async () => {
  const referenceDate = '2026-10-14';
  const loaded = loadPlannerBenchmark({ referenceDate });
  const markers = [/\b(?:tr|pl)-\d{3}\b/, /"(?:needs|avoid|expect|gold|groups)"\s*:/, /ai-(?:semantic|planner)-benchmark/, /planner-scoring/];
  for (const testCase of loaded.cases.filter((item) => ['tr-091', 'tr-096', 'tr-115', 'pl-001'].includes(item.id))) {
    const args = testCase.example ? answerPlan(testCase, referenceDate) : { intent: 'abstain', language: 'tr', abstain: { reason: 'security' } };
    const { inputs } = await decide(loaded, testCase, args);
    assert.ok(inputs.length >= 1);
    for (const input of inputs) for (const marker of markers) assert.doesNotMatch(input, marker, testCase.id);
  }
});

test('üretim kodu altın etiketleri, kıyas kümesini ve değerlendirme betiklerini içe aktarmaz; vaka kimliği ya da metni taşımaz', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const walk = (directory) => readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(?:m?js|jsx|ts|tsx)$/.test(name) ? [full] : [];
  });
  const semantic = JSON.parse(readFileSync(new URL('./fixtures/ai-semantic-benchmark.json', import.meta.url), 'utf8'));
  const texts = [...semantic.cases.map((testCase) => testCase.text), ...DOCUMENT.supplementary.map((testCase) => testCase.text)];
  for (const file of walk('src')) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /planner-(?:scoring|evaluation)|ai-(?:planner|semantic)-benchmark|fixtures\//, file);
    assert.doesNotMatch(source, /['"`](?:tr|pl)-\d{3}['"`]/, file);
    for (const text of texts) assert.ok(!source.includes(text), `${file}: kıyas metni`);
  }
});
