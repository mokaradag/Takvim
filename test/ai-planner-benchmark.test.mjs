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
      return { text: '', toolCalls: [{ id: 'call_1', name: 'rota_plan', arguments: JSON.stringify(args), oversize: false }], usage: { inputTokens: 12, outputTokens: 8, thinkingTokens: 0 }, models: ['scripted'], thinking: 'off', error: null, durationMs: 0 };
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
    const choice = { intent: testCase.expect, language: testCase.language, ...(testCase.choice ? { [testCase.expect]: { reason: testCase.choice.reason, ...(testCase.choice.topics ? { topics: testCase.choice.topics.map((group) => group[0]).slice(0, 4) } : {}) } } : {}) };
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

test('kapalı puanlama maddi yanlışları eksik altın alanıyla geçirmez', async () => {
  const referenceDate = '2026-10-14';
  const loaded = loadPlannerBenchmark({ referenceDate });
  const reject = async (id, mutate) => {
    const testCase = loaded.cases.find((item) => item.id === id);
    const { record } = await decide(loaded, testCase, answerPlan(testCase, referenceDate));
    assert.ok(scoreDecision(testCase, record, { referenceDate }).correct, id);
    mutate(record);
    assert.equal(scoreDecision(testCase, record, { referenceDate }).correct, false, id);
  };
  await reject('tr-001', (r) => { r.plan.requests.push(clone(r.plan.requests[0])); });
  await reject('tr-001', (r) => { r.plan.requests[0].filters.priority = ['high']; });
  await reject('tr-004', (r) => { r.plan.requests[0].operation = 'value'; r.plan.requests[0].metrics = ['tasks.total']; });
  await reject('tr-003', (r) => { r.plan.requests[0].operation = 'rank'; r.plan.requests[0].rank = { metric: 'task.progressPercent', order: 'desc', limit: 1 }; });
  await reject('tr-072', (r) => { r.plan.requests[0].population.collection = 'successors'; });
  await reject('tr-073', (r) => { r.plan.requests[0].population.collection = 'predecessors'; });
  await reject('tr-001', (r) => { r.plan.requests[0].reasoning = 'synthesis'; });
  await reject('tr-001', (r) => { r.plan.requests[0].population.textFields = ['description']; });
  await reject('tr-001', (r) => { r.language = 'en'; });
  await reject('tr-048', (r) => { r.plan.requests[0].fields[0].path = 'data.people.*.organization.directorate'; });
  await reject('tr-001', (r) => { r.plan.requests[0].metrics.push('task.budget'); });
  for (const id of ['tr-096', 'tr-101', 'tr-105', 'tr-110', 'tr-112', 'tr-114']) {
    const c = loaded.cases.find((item) => item.id === id);
    const choice = { intent: c.expect, language: c.language, [c.expect]: { reason: c.choice.reason, ...(c.choice.topics ? { topics: c.choice.topics.map((group) => group[0]) } : {}) } };
    const { record } = await decide(loaded, c, choice);
    assert.equal(scoreDecision(c, record, { referenceDate }).correct, true, id);
    const wrong = clone(record); wrong.choice.reason = c.expect === 'clarify' ? 'wrong' : 'general';
    assert.equal(scoreDecision(c, wrong, { referenceDate }).correct, false, id);
    if (c.choice.topics) {
      const topics = clone(record); topics.choice.topics = ['rota_calendar_inspect', 'rota_outlook_status'];
      assert.equal(scoreDecision(c, topics, { referenceDate }).correct, false);
    }
    const general = clone(record); general.outcome = 'general_redirect'; general.choice = null; general.general = true;
    assert.equal(scoreDecision(c, general, { referenceDate }).correct, false);
  }
});

test('normal soruda korumalı metin kapalıdır; gerçek general vakaları iki dilde ölçülür', async () => {
  const loaded = loadPlannerBenchmark();
  const c = loaded.cases.find((item) => item.id === 'tr-001');
  const args = answerPlan(c, loaded.referenceDate);
  args.request.population.textFields = ['description'];
  const model = scriptedModel(args);
  const result = await planCase({ testCase: c, model, adviceFor: unavailable, now: loaded.now, catalog });
  assert.equal(result.outcome, 'clarification');
  assert.equal(result.plan, undefined);
  assert.match(model.inputs[1], /not-authorized/);
  for (const c of loaded.cases.filter((item) => item.expect === 'general')) {
    const { record } = await decide(loaded, c, { intent: 'general', language: c.language });
    assert.equal(scoreDecision(c, record, loaded).correct, true);
    assert.equal(record.rounds.length, 1);
    assert.equal(scoreDecision(c, { ...record, language: c.language === 'tr' ? 'en' : 'tr' }, loaded).correct, false);
  }
});

test('koşu bütünlüğü, tarih ve gerçek model/düşünme kökeni puanlamadan önce zorunludur', async () => {
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, scorePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark();
  const c = loaded.cases[0];
  const { record } = await decide(loaded, c, answerPlan(c, loaded.referenceDate));
  const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint,
    referenceDate: loaded.referenceDate, passes: 1, cases: [c.id], records: [record], semantic: { mode: 'none' }, model: { commandHash: '0'.repeat(64) }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
  const summary = scorePlannerRun(run, loaded);
  assert.equal(summary.byPass[0].correct, 1);
  assert.equal(summary.gatePassed, false, 'kısmi koşu tam kabul değildir');
  const rejects = (mutate, code = /PLANNER_RUN_INVALID/) => {
    const bad = clone(run); mutate(bad);
    assert.throws(() => scorePlannerRun(bad, loaded), code);
  };
  rejects((r) => { r.cases.push(c.id); });
  rejects((r) => { r.cases = []; r.records = []; });
  rejects((r) => { r.cases = ['unknown']; });
  rejects((r) => { r.records.push(clone(record)); });
  rejects((r) => { r.records = []; });
  rejects((r) => { r.passes = 0; });
  rejects((r) => { r.records[0].pass = 2; });
  rejects((r) => { r.records[0].outcome = 'error'; });
  rejects((r) => { r.referenceDate = '2026-13-01'; });
  const changed = { ...run, referenceDate: '2026-10-20' };
  assert.throws(() => scorePlannerRun(changed, loadPlannerBenchmark({ referenceDate: changed.referenceDate })), /PLANNER_RUN_STALE/);
  rejects((r) => { r.records[0].rounds[0].models = ['claude-sonnet-4-5']; }, /PLANNER_MODEL_MISMATCH/);
  rejects((r) => { r.records[0].rounds[0].thinking = 2; }, /PLANNER_THINKING_UNVERIFIED/);
  rejects((r) => { r.records[0].rounds[0].thinking = null; }, /PLANNER_THINKING_UNVERIFIED/);
  rejects((r) => { r.model.command = 'secret'; });
  for (const date of ['2026-13-01', '2026-02-30', '2026-02-29']) assert.throws(() => loadPlannerBenchmark({ referenceDate: date }), /REFERENCE_DATE_INVALID/);
  for (const date of ['02-30', '13-01']) {
    const gold = clone(DOCUMENT); gold.cases[0].plan.groups[0].any[0].window.from = { date };
    assert.throws(() => loadPlannerBenchmark({ plannerDocument: gold }), /invalid/);
  }
});

test('dış model komutu sınırlıdır, altyapı hatası puan değildir ve komut sırrı kayda yazılmaz', async (t) => {
  const { mkdtempSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { externalModel, parseArguments, runEvaluation } = await import('../scripts/planner-evaluation.mjs');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let sequence = 0;
  const command = (code) => {
    const file = path.join(dir, `model-${++sequence}.cjs`);
    writeFileSync(file, code);
    return `"${process.execPath}" "${file}"`;
  };
  const payload = { messages: [], tools: [], toolChoice: 'none' };
  for (const [code, error] of [["setInterval(()=>{},1000)", 'MODEL_COMMAND_TIMEOUT'], ["process.stdout.write('x'.repeat(10000))", 'MODEL_COMMAND_OUTPUT_LIMIT'], ["process.stderr.write('x'.repeat(10000))", 'MODEL_COMMAND_OUTPUT_LIMIT']]) {
    const model = externalModel({ command: command(code), inputs: null, guard: () => {}, timeoutMs: error === 'MODEL_COMMAND_TIMEOUT' ? 50 : 5000, outputBytes: 1024 });
    try { assert.equal((await model.complete(payload)).error, error); } finally { model.dispose(); }
  }
  const reply = { text: '', toolCalls: [{ name: 'rota_plan', arguments: { intent: 'general', language: 'tr' } }], models: ['claude-haiku-4-5-20251001'], thinking: 'off', usage: { inputTokens: 7, outputTokens: 3, thinkingTokens: 0 } };
  const rawCommand = command(`process.stdout.write(${JSON.stringify(JSON.stringify(reply))})`) + ' --api-key NEVER_SAVE_THIS';
  const { flags } = parseArguments(['run', '--model-command', rawCommand, '--cases', 'pl-018', '--reference-date', '2026-10-14']);
  const run = await runEvaluation(flags);
  assert.equal(run.records[0].rounds[0].input, 7);
  assert.equal(run.records[0].rounds[0].output, 3);
  assert.equal(run.records[0].rounds[0].thinking, 0);
  assert.ok(!JSON.stringify(run).includes('NEVER_SAVE_THIS'));
  assert.ok(!JSON.stringify(run).includes(rawCommand));
  const runPath = path.join(dir, 'run.json');
  writeFileSync(runPath, JSON.stringify(run));
  const cli = spawnSync(process.execPath, ['scripts/planner-evaluation.mjs', 'report', '--run', runPath, '--json'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 1);
  assert.ok(!cli.stdout.includes('NEVER_SAVE_THIS'));
  for (const patch of [{ models: ['claude-sonnet-4-5'] }, { thinking: 'on' }, { usage: { thinkingTokens: 1 } }, { error: 'provider outage with private token' }]) {
    const badCommand = command(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...reply, ...patch }))})`);
    await assert.rejects(runEvaluation({ ...flags, modelCommand: badCommand }), /altyapı hatası/);
  }
  assert.deepEqual(readdirSync(dir).filter((file) => file.endsWith('.json')), ['run.json']);
});

test('anlamsal koşuda belgeler ve sayısal yeniden sıralama puanları kimlikle bağlanır', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { candidatesFromRun } = await import('../scripts/planner-evaluation.mjs');
  const { createSemanticCatalogue, semanticToolDefinitions } = await import('../src/domain/ai/semanticContract.js');
  const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-semantic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const items = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name)))).catalogue;
  const c = loadPlannerBenchmark().cases[0];
  const documents = items.items.map((item, index) => ({ id: item.id, text: item.text, vector: [items.items.length - index, 1] }));
  const run = { format: 'mergen-rota-semantic-model-run', version: 1, benchmark: 'test-benchmark', catalogue: items.fingerprint,
    embedding: { model: 'local-double', provider: 'test', preprocessing: 'none', documents, queries: [{ case: c.id, text: c.text, vector: [1, 0] }] },
    rerank: { model: 'local-rerank', provider: 'test', queries: [{ case: c.id, scores: items.items.map((item, index) => ({ id: item.id, score: index })) }] } };
  const file = path.join(dir, 'run.json');
  const read = (value) => { writeFileSync(file, JSON.stringify(value)); return candidatesFromRun(file, { cases: [c], semanticFingerprint: 'test-benchmark' }).byCase.get(c.id); };
  const normal = read(run);
  assert.equal(normal.status, 'reranked');
  const shuffled = clone(run); shuffled.embedding.documents.reverse(); shuffled.rerank.queries[0].scores.reverse();
  assert.deepEqual(read(shuffled), normal);
  const first = read({ ...run, rerank: null });
  assert.notDeepEqual(first.candidates.map((item) => item.id), normal.candidates.map((item) => item.id));
  for (const mutate of [
    (r) => { r.embedding.documents.push(clone(r.embedding.documents[0])); },
    (r) => { r.embedding.documents.pop(); },
    (r) => { r.embedding.queries.push(clone(r.embedding.queries[0])); },
    (r) => { r.rerank.queries[0].scores[0].score = '1'; },
    (r) => { r.rerank.queries[0].scores[0].id = 'unknown'; }
  ]) {
    const bad = clone(run); mutate(bad); assert.throws(() => read(bad), /SEMANTIC_/);
  }
});
