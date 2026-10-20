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

test('4C artık değerlendirme: danışmanlık kimlik ve iç hatası model çağrısından önce koşuyu geçersiz kılar', async () => {
  const loaded = loadPlannerBenchmark();
  for (const error of [Object.assign(new Error('gizli tanı'), { code: 'AI_UNAUTHORIZED' }), new TypeError('gizli iç tanı')]) {
    let called = false;
    const outcome = await planCase({ testCase: loaded.cases[0], model: { complete() { called = true; } },
      adviceFor: async () => { throw error; }, now: loaded.now, catalog });
    assert.equal(outcome.outcome, 'error');
    assert.equal(outcome.error, error.code || 'ERROR');
    assert.equal(called, false);
    assert.deepEqual(outcome.rounds, []);
    assert.deepEqual(outcome.decisions, []);
    assert.ok(!JSON.stringify(outcome).includes(error.message));
  }
});

/** Her turda verilen plan çağrısını döndüren model; gördüğü girdiler sızıntı denetimi için saklanır. */
function scriptedModel(args) {
  const inputs = [];
  return {
    inputs,
    async complete(payload) {
      inputs.push(JSON.stringify(payload));
      return { text: '', toolCalls: [{ id: 'call_1', name: 'rota_plan', arguments: JSON.stringify(args), oversize: false }], finishReason: 'tool_calls', usage: { inputTokens: 12, outputTokens: 8, thinkingTokens: 0 }, models: ['scripted'], thinking: 'off', error: null, durationMs: 0 };
    }
  };
}

async function decide(loaded, testCase, args) {
  const model = scriptedModel(args);
  const outcome = await planCase({ testCase, model, adviceFor: unavailable, now: loaded.now, catalog });
  return { record: recordOf(testCase, 1, outcome), inputs: model.inputs };
}

const answerPlan = (testCase, referenceDate) => ({ intent: 'rota', language: testCase.language, ...resolveExample(testCase.example, referenceDate) });
const clone = (value) => JSON.parse(JSON.stringify(value));

test('4C CLI değer alan her bayrak eksik değeri yan etki olmadan reddeder', async () => {
  const { parseArguments } = await import('../scripts/planner-evaluation.mjs');
  for (const flag of ['--model-command', '--model', '--semantic', '--passes', '--concurrency', '--cases', '--out', '--inputs', '--run', '--reference-date', '--expected-model', '--model-timeout-ms', '--model-output-bytes']) {
    for (const suffix of [['--json'], ['--out', 'run.json'], [], [''], ['   ']]) {
      assert.throws(() => parseArguments(['run', flag, ...suffix]), /bir değer gerektirir/, `${flag} ${suffix.join(' ')}`);
    }
  }
  const { flags } = parseArguments(['run', '--out', 'run.json', '--json']);
  assert.equal(flags.out, 'run.json');
  assert.equal(flags.json, true);
});

test('4C dış model kesintisi tüm etkin süreçleri ve geçici dizini temizler', { skip: process.platform !== 'linux' }, async (t) => {
  const { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-signal-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evaluator = new URL('../scripts/planner-evaluation.mjs', import.meta.url).href;
  const running = (pid) => {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    return !existsSync(`/proc/${pid}/stat`) || !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  };
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const marker = path.join(dir, signal); const runnerFile = path.join(dir, `${signal}.mjs`); const modelFile = path.join(dir, `${signal}.cjs`);
    writeFileSync(modelFile, `const fs=require('node:fs'),file=${JSON.stringify(marker)}+'-'+process.pid;fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,tmp:process.env.TMPDIR}));fs.renameSync(file+'.tmp',file);setInterval(()=>{},1000);`);
    const command = `"${process.execPath}" "${modelFile}"`;
    writeFileSync(runnerFile, `import { externalModel } from ${JSON.stringify(evaluator)};const model=externalModel({command:${JSON.stringify(command)},guard:()=>{}});await Promise.all([1,2].map(()=>model.complete({messages:[],tools:[],toolChoice:'none'})));model.dispose();`);
    const runner = spawn(process.execPath, [runnerFile], { stdio: 'ignore' });
    const closed = new Promise(resolve => runner.once('exit', (code, stoppedBy) => resolve({ code, stoppedBy })));
    const children = [];
    try {
      for (let i = 0; i < 500; i += 1) {
        const files = readdirSync(dir).filter(name => name.startsWith(`${signal}-`) && !name.endsWith('.tmp'));
        if (files.length === 2) { children.push(...files.map(name => JSON.parse(readFileSync(path.join(dir, name), 'utf8')))); break; }
        await delay(10);
      }
      assert.equal(children.length, 2, 'iki model çağrısı başladı');
      runner.kill(signal);
      const timeout = setTimeout(() => runner.kill('SIGKILL'), 5000);
      const result = await closed; clearTimeout(timeout);
      assert.equal(result.code, status);
      for (const child of children) {
        for (let i = 0; i < 100 && running(child.pid); i += 1) await delay(10);
        assert.equal(running(child.pid), false, 'model çalışmıyor');
        assert.equal(existsSync(child.tmp), false, 'geçici dizin kaldırıldı');
      }
    } finally {
      runner.kill('SIGKILL');
      for (const child of children) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* Zaten sonlandı. */ } rmSync(child.tmp, { recursive: true, force: true }); }
    }
  }
});

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
    const planned = await decide(loaded, testCase, { ...answerPlan(someAnswer, referenceDate), language: testCase.language });
    assert.equal(planned.record.outcome, 'planned', `${testCase.id}: ${planned.record.error ?? planned.record.outcome}`);
    assert.deepEqual(scoreDecision(testCase, planned.record, { referenceDate }).reasons, ['decision:planned'], testCase.id);
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
  await reject('tr-001', (r) => { r.plan.calls.push(clone(r.plan.calls[0])); });
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
  rejects((r) => { r.records[0].rounds[0].finishReason = null; }, /PLANNER_COMPLETION_UNVERIFIED/);
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
  const reply = { text: '', toolCalls: [{ name: 'rota_plan', arguments: { intent: 'general', language: 'tr' } }], models: ['claude-haiku-4-5-20251001'], finishReason: 'tool_calls', thinking: 'off', usage: { inputTokens: 7, outputTokens: 3, thinkingTokens: 0 } };
  const rawCommand = command(`process.stdout.write(${JSON.stringify(JSON.stringify(reply))})`) + ' --api-key NEVER_SAVE_THIS';
  const { flags } = parseArguments(['run', '--model-command', rawCommand, '--cases', 'pl-018', '--reference-date', '2026-10-14']);
  const run = await runEvaluation(flags);
  assert.equal(run.records[0].rounds[0].input, 7);
  assert.equal(run.records[0].rounds[0].output, 3);
  assert.equal(run.records[0].rounds[0].thinking, 0);
  const truncatedCommand = command(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...reply, finishReason: 'length' }))})`);
  const truncatedRun = await runEvaluation({ ...flags, modelCommand: truncatedCommand });
  assert.equal(truncatedRun.records[0].outcome, 'failed');
  assert.ok(truncatedRun.records[0].rounds.every(round => round.finishReason === 'length'));
  assert.ok(!JSON.stringify(run).includes('NEVER_SAVE_THIS'));
  assert.ok(!JSON.stringify(run).includes(rawCommand));
  const runPath = path.join(dir, 'run.json');
  writeFileSync(runPath, JSON.stringify(run));
  const cli = spawnSync(process.execPath, ['scripts/planner-evaluation.mjs', 'report', '--run', runPath, '--json'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  const reported = JSON.parse(cli.stdout);
  assert.equal(reported.summary.byPass[0].correct, 1);
  assert.equal(reported.summary.gatePassed, false);
  assert.ok(!cli.stdout.includes('NEVER_SAVE_THIS'));
  for (const patch of [{ models: ['claude-sonnet-4-5'] }, { thinking: 'on' }, { usage: { thinkingTokens: 1 } }, { error: 'provider outage with private token' }, { finishReason: null }]) {
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
    embedding: { model: 'local-double', provider: 'test', preprocessing: 'none', queryPrefix: '', documentPrefix: '', batchSize: 1, documentLatencyMs: 1, documents, queries: [{ case: c.id, text: c.text, vector: [1, 0], latencyMs: 1 }] },
    rerank: { model: 'local-rerank', provider: 'test', batchSize: 1, queries: [{ case: c.id, latencyMs: 1, scores: items.items.map((item, index) => ({ id: item.id, score: index })) }] } };
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

test('4C izin girdisi altından bağımsızdır; puanlı ve tanısal turlar aynı planlayıcı girdisini görür', async () => {
  const loaded = loadPlannerBenchmark();
  const diagnostic = loadPlannerBenchmark({ goldRequired: false });
  assert.equal(diagnostic.cases.length, 136);
  for (const id of ['tr-001', 'tr-016', 'tr-051', 'pl-017']) {
    const c = loaded.cases.find((c) => c.id === id);
    const d = diagnostic.cases.find((c) => c.id === id);
    const args = answerPlan(c, loaded.referenceDate);
    const normal = scriptedModel(args);
    const changed = scriptedModel(args);
    await planCase({ testCase: c, model: normal, adviceFor: unavailable, now: loaded.now, catalog });
    await planCase({ testCase: { ...d, gold: { groups: [{ any: [{ textFields: ['requesterMessage'] }] }] } }, model: changed, adviceFor: unavailable, now: loaded.now, catalog });
    assert.deepEqual(changed.inputs, normal.inputs, id);
  }
});

test('4C zorunlu kimlikler kapalıdır; eksik ya da değiştirilmiş 19 ek vaka kabul edilmez', () => {
  for (const mutate of [(d) => d.supplementary.pop(), (d) => d.supplementary[0].id = 'pl-020',
    (d) => d.supplementary[1].id = d.supplementary[0].id]) {
    const document = clone(DOCUMENT); mutate(document);
    assert.throws(() => loadPlannerBenchmark({ plannerDocument: document }), /mandatory-ids/);
  }
});

test('4C gold düzeltmeleri İngilizce, bildirim listesi, sorumlu VE durum ve tüm açıklama konularını sınar', async () => {
  const loaded = loadPlannerBenchmark();
  const { metricPaths } = await import('../src/domain/ai/claimableEvidence.js');
  const notification = loaded.cases.find(c => c.id === 'pl-005');
  assert.deepEqual(notification.example.request.metrics, ['task.title', 'notification.unread']);
  for (const metric of notification.example.request.metrics) for (const source of ['scheduleRequests', 'assignmentCoordination', 'taskEvents']) {
    assert.ok(metricPaths('rota_notifications', metric).some(path => path.includes(`${source}.latest.*.`)), `${metric}: ${source}`);
  }

  for (const [id, mutate] of [
    ['pl-017', (r) => r.language = 'tr'],
    ['pl-005', (r) => { r.plan.requests[0].operation = 'value'; r.plan.requests[0].metrics = ['notifications.unread']; }],
    ['tr-092', (r) => r.plan.requests[1].metrics = ['task.assignees']]
  ]) {
    const c = loaded.cases.find((c) => c.id === id);
    const { record } = await decide(loaded, c, answerPlan(c, loaded.referenceDate));
    assert.equal(scoreDecision(c, record, loaded).correct, true, id);
    mutate(record);
    assert.equal(scoreDecision(c, record, loaded).correct, false, id);
  }
  const c = loaded.cases.find((c) => c.choice?.topics?.length === 3);
  assert.ok(c);
  const { record } = await decide(loaded, c, { intent: 'clarify', language: c.language, clarify: { reason: c.choice.reason, topics: c.choice.topics.map((g) => g[0]) } });
  assert.equal(scoreDecision(c, record, loaded).correct, true);
  record.choice.topics.pop();
  assert.equal(scoreDecision(c, record, loaded).correct, false);
  const document = clone(DOCUMENT);
  document.cases[0].plan.groups[0].any[0].window.from = { date: '02-29' };
  assert.doesNotThrow(() => loadPlannerBenchmark({ plannerDocument: document, referenceDate: '2024-02-29' }));
});

test('4C bozuk kayıt raporu TypeError yerine PLANNER_RUN_INVALID verir; anlamsız koşu nitelendiremez', async () => {
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, scorePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark();
  const records = [];
  for (const c of loaded.cases) {
    const args = c.expect === 'answer' ? answerPlan(c, loaded.referenceDate) : { intent: c.expect, language: c.language,
      ...(c.choice ? { [c.expect]: { reason: c.choice.reason, ...(c.choice.topics ? { topics: c.choice.topics.map((g) => g[0]) } : {}) } } : {}) };
    records.push((await decide(loaded, c, args)).record);
  }
  const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint,
    referenceDate: loaded.referenceDate, passes: 1, cases: loaded.cases.map((c) => c.id), records, semantic: { mode: 'none' },
    model: { commandHash: '0'.repeat(64) }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
  const none = scorePlannerRun(run, loaded);
  assert.equal(none.byPass[0].correct, 136);
  assert.equal(none.gatePassed, false);
  for (const mutate of [(r) => r.records[0] = null, (r) => r.records[0].plan = {}, (r) => r.records[0].plan.requests = [null],
    (r) => r.records[0].plan.calls = null, (r) => r.records[0].rounds = [null], (r) => r.records[0].plan.requests[0].metrics = null]) {
    const broken = clone(run); mutate(broken);
    assert.throws(() => scorePlannerRun(broken, loaded), /PLANNER_RUN_INVALID/);
  }
  run.semantic = { mode: 'run', provenance: { model: 'test-double', provider: 'test', preprocessing: 'none' } };
  for (const record of run.records) record.semantic = { state: 'first_stage', candidates: ['rota_task_search'] };
  assert.equal(scorePlannerRun(run, loaded).gatePassed, true, 'yalnızca puanlayıcı sınaması; gerçek model kabulü değildir');
  run.records.at(-1).semantic = { state: 'unavailable', candidates: [] };
  assert.equal(scorePlannerRun(run, loaded).gatePassed, false, 'tek ek vakada bile danışmanlık yoksa kabul yoktur');
});

test('4C canlı yol aynı sızıntı ve model denetimini uygular; eksik kullanım yalnızca kayıtlı düşünmesiz rotada sıfırdır', async () => {
  const { liveTurn, leakGuard } = await import('../scripts/planner-evaluation.mjs');
  const loaded = loadPlannerBenchmark();
  const c = loaded.cases[0];
  const args = answerPlan(c, loaded.referenceDate);
  const gateway = (patch = {}, event = null) => ({ runToolSession: async ({ run }) => {
    try { return await run({ model: 'qwen', signal: new AbortController().signal, round: async (input) => {
      if (event) await input.onEvent(event);
      return { text: '', toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(args) }], model: 'qwen', finishReason: 'tool_calls', ...patch };
    } }); } catch { throw Object.assign(new Error('mapped'), { code: 'AI_INTERNAL_ERROR' }); }
  } });
  const execute = async (patch, event = null, thinking = 'off', guard = leakGuard(loaded)) => planCase({ testCase: c,
    runTurn: liveTurn(gateway(patch, event), 'qwen', guard, { thinking }), adviceFor: unavailable, now: loaded.now, catalog });
  const valid = await execute({});
  assert.equal(valid.outcome, 'planned');
  assert.equal(valid.rounds[0].usage.output_tokens_details.thinking_tokens, 0);
  assert.equal((await execute({ usage: { reasoningTokens: 2 } })).error, 'PLANNER_THINKING_UNVERIFIED');
  assert.equal((await execute({}, { type: 'thinking' })).error, 'PLANNER_THINKING_UNVERIFIED');
  assert.equal((await execute({}, null, 'unverified')).error, 'PLANNER_THINKING_UNVERIFIED');
  assert.equal((await execute({ model: 'wrong' })).error, 'PLANNER_MODEL_MISMATCH');
  let checked = 0;
  const guard = (text) => { checked += 1; leakGuard(loaded)(text); };
  assert.equal((await execute({}, null, 'off', guard)).outcome, 'planned');
  assert.equal(checked, 1);
  assert.throws(() => guard('tr-001'), /sızıntı|vaka kimliği/);
});

test('4C dış altyapı kodları model kimliği hatasına dönüşmez; çelişen komut seçimi reddedilir', async () => {
  const { parseArguments } = await import('../scripts/planner-evaluation.mjs');
  assert.throws(() => parseArguments(['live', '--model-command', 'node model.cjs']), /SELECTORS_CONFLICT/);
  assert.throws(() => parseArguments(['run', '--model', 'live', '--model-command', 'node model.cjs']), /SELECTORS_CONFLICT/);
  assert.throws(() => parseArguments(['run', '--no-score', '--out', 'run.json']), /UNSCORED_OUTPUT/);
  const loaded = loadPlannerBenchmark();
  for (const code of ['MODEL_COMMAND_TIMEOUT', 'MODEL_COMMAND_OUTPUT_LIMIT', 'MODEL_COMMAND_ERROR']) {
    const result = await planCase({ testCase: loaded.cases[0], model: { complete: async () => ({ text: '', toolCalls: [], models: [], error: code }) },
      expectedModel: 'qwen', adviceFor: unavailable, now: loaded.now, catalog });
    assert.equal(result.error, code);
    assert.equal(result.rounds[0].error, code);
  }
});

test('4C anlamsal artifakt tüm 136 soruyu ve tüm belge skorlarını kapsar; belgelenmiş çıkarım hatası ilk aşamadır', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { candidatesFromRun } = await import('../scripts/planner-evaluation.mjs');
  const { createSemanticCatalogue, semanticToolDefinitions } = await import('../src/domain/ai/semanticContract.js');
  const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-all-semantic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loaded = loadPlannerBenchmark();
  const items = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name)))).catalogue;
  const run = { format: 'mergen-rota-semantic-model-run', version: 1, benchmark: loaded.semanticFingerprint, catalogue: items.fingerprint,
    embedding: { model: 'test-double', provider: 'test', preprocessing: 'none', queryPrefix: '', documentPrefix: '', batchSize: 1, documentLatencyMs: 1, documents: items.items.map((item, index) => ({ id: item.id, text: item.text, vector: [items.items.length - index, 1] })),
      queries: loaded.cases.map((c) => ({ case: c.id, text: c.text, vector: [1, 0], latencyMs: 1 })) },
    rerank: { model: 'test-rerank', provider: 'test', batchSize: 1, queries: loaded.cases.map((c) => ({ case: c.id, latencyMs: 1, scores: items.items.map((item, index) => ({ id: item.id, score: index })) })) } };
  const file = path.join(dir, 'run.json');
  const read = (value) => { writeFileSync(file, JSON.stringify(value)); return candidatesFromRun(file, loaded); };
  const valid = read(run);
  assert.equal(valid.byCase.size, 136);
  assert.equal(valid.byCase.get('pl-019').status, 'reranked');
  const failed = clone(run); failed.rerank.queries[0] = { case: 'tr-001', failure: 'INFERENCE_FAILED', latencyMs: 1 };
  assert.equal(read(failed).byCase.get('tr-001').status, 'first_stage');
  const failedQuery = clone(run); failedQuery.embedding.queries[0] = { case: 'tr-001', text: loaded.cases[0].text, failure: 'INFERENCE_FAILED', latencyMs: 1 };
  assert.equal(read(failedQuery).byCase.get('tr-001').status, 'unavailable');
  const badScore = clone(run); badScore.rerank.queries[0].scores[0].score = null;
  assert.equal(read(badScore).byCase.get('tr-001').status, 'first_stage');
  for (const mutate of [(r) => r.embedding.queries.pop(), (r) => r.rerank.queries.pop(),
    (r) => r.rerank.queries[0].scores.pop(), (r) => r.rerank.queries[0].scores.push(clone(r.rerank.queries[0].scores[0])),
    (r) => r.rerank.queries[0] = { case: 'tr-001', failure: 'OTHER' },
    (r) => r.rerank.queries[0] = { case: 'tr-001', failure: 'INFERENCE_FAILED' },
    (r) => { r.rerank.provider = ''; }, (r) => { r.embedding.documentLatencyMs = -1; },
    (r) => { r.rerank.queries[0].latencyMs = '1'; }]) {
    const invalid = clone(run); mutate(invalid); assert.throws(() => read(invalid), /SEMANTIC_/);
  }
});

test('4C son geçiş: modelin kendi hatalı anahtarı sızıntı değildir; sunucu girdisi denetlenir', async () => {
  const { leakGuard } = await import('../scripts/planner-evaluation.mjs');
  const loaded = loadPlannerBenchmark(); const guard = leakGuard(loaded);
  const good = answerPlan(loaded.cases[0], loaded.referenceDate);
  const model = scriptedModel(good); let calls = 0;
  const complete = model.complete.bind(model);
  model.complete = async payload => { guard(payload); const reply = await complete(payload);
    if (++calls === 1) reply.toolCalls[0].arguments = JSON.stringify({ ...good, avoid: [] });
    guard.observe(reply);
    return reply; };
  assert.equal((await planCase({ testCase: loaded.cases[0], model, adviceFor: unavailable, now: loaded.now, catalog })).outcome, 'planned');
  for (const role of ['system', 'user', 'tool']) assert.throws(() => guard({ messages: [{ role, content: '{"gold":1}' }] }), e => e.code === 'PLANNER_GOLD_LEAK');
  assert.throws(() => guard({ messages: [{ role: 'assistant', content: '{"gold":1}' }] }), e => e.code === 'PLANNER_GOLD_LEAK');
  assert.throws(() => guard({ messages: [{ role: 'assistant', toolCalls: [{ arguments: '{"gold":1}' }] }] }), e => e.code === 'PLANNER_GOLD_LEAK');
  assert.throws(() => guard({ messages: [{ role: 'assistant', content: 'tr-001' }] }), e => e.code === 'PLANNER_GOLD_LEAK');
});

test('4C son geçiş: bitiş nedenleri iki yolda doğrulanır ve bilinmeyen kullanım null kalır', async () => {
  const { liveTurn } = await import('../scripts/planner-evaluation.mjs');
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, scorePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark(); const c = loaded.cases[0]; const args = answerPlan(c, loaded.referenceDate);
  for (const finishReason of ['stop', 'end_turn', 'eos', 'stop_sequence', null]) {
    const model = scriptedModel(args); const complete = model.complete.bind(model);
    model.complete = async p => ({ ...await complete(p), finishReason });
    const result = await planCase({ testCase: c, model, expectedModel: 'scripted', adviceFor: unavailable, now: loaded.now, catalog });
    assert.equal(result.outcome, finishReason ? 'planned' : 'error');
    if (finishReason) {
      const record = recordOf(c, 1, result);
      const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint, referenceDate: loaded.referenceDate,
        passes: 1, cases: [c.id], records: [record], semantic: { mode: 'none' }, model: { commandHash: '0'.repeat(64) }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
      assert.equal(scorePlannerRun(run, loaded).byPass[0].correct, 1);
    }
    const gateway = { runToolSession: ({ run }) => run({ model: 'scripted', signal: new AbortController().signal,
      round: async () => ({ ...await model.complete({ messages: [], tools: [] }), model: 'scripted' }) }) };
    const live = await planCase({ testCase: c, runTurn: liveTurn(gateway, 'scripted', () => {}, { thinking: 'off' }), adviceFor: unavailable, now: loaded.now, catalog });
    assert.equal(live.outcome, finishReason ? 'planned' : 'error');
  }
  const model = scriptedModel(args); const complete = model.complete.bind(model); model.complete = async p => ({ ...await complete(p), usage: {} });
  const unknown = await planCase({ testCase: c, model, adviceFor: unavailable, now: loaded.now, catalog });
  assert.equal(recordOf(c, 1, unknown).rounds[0].input, null);
});

test('4C son geçiş: canlı boş yanıt ölçümü doğrulanır, model ıskası olarak puanlanır', async () => {
  const { liveTurn } = await import('../scripts/planner-evaluation.mjs');
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, scorePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark(); const c = loaded.cases[0]; let calls = 0;
  const gateway = { runToolSession: async ({ run }) => {
    try { return await run({ model: 'scripted', signal: new AbortController().signal, remainingMs: () => 30000, round: async () => {
      calls += 1;
      throw Object.assign(new Error('empty'), { code: 'AI_PROVIDER_RESPONSE_INVALID', details: { reason: 'EMPTY_COMPLETION' },
        roundMeasurements: { model: 'scripted', modelMismatch: false, finishReason: 'stop', usage: { thinkingTokens: 0 } } });
    } }); } catch { throw Object.assign(new Error('mapped'), { code: 'AI_INTERNAL_ERROR' }); }
  } };
  const outcome = await planCase({ testCase: c, runTurn: liveTurn(gateway, 'scripted', () => {}, { thinking: 'off' }), adviceFor: unavailable, now: loaded.now, catalog });
  assert.equal(outcome.outcome, 'failed'); assert.equal(calls, 2); assert.equal(outcome.rounds.length, 2);
  const record = recordOf(c, 1, outcome);
  const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint, referenceDate: loaded.referenceDate,
    passes: 1, cases: [c.id], records: [record], semantic: { mode: 'none' }, model: { live: { model: 'scripted', provider: 'test', profile: 'chat.tools', thinking: 'off' } }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
  for (const kind of ['failed', 'unavailable', 'not_found']) {
    record.outcome = kind;
    assert.equal(scorePlannerRun(run, loaded).byPass[0].correct, 0);
  }
  record.rounds[0].models = [];
  assert.throws(() => scorePlannerRun(run, loaded), /MODEL_MISMATCH/);
});

test('4C son geçiş: gerçek ağ geçidindeki boş yanıt ve güvenlik hatası ayrı kalır', async (t) => {
  const { createAiStack } = await import('./helpers/aiStack.mjs');
  const { getAiGateway } = await import('../src/server/ai/aiRuntime.js');
  const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
  const { liveTurn, leakGuard } = await import('../scripts/planner-evaluation.mjs');
  const loaded = loadPlannerBenchmark(); const c = loaded.cases[0];
  const stack = createAiStack(t, { env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const model = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model;
  const execute = () => planCase({ testCase: c, runTurn: liveTurn(getAiGateway(), model, leakGuard(loaded), { thinking: 'off' }),
    adviceFor: unavailable, now: loaded.now, catalog });
  stack.provider.enqueue({ type: 'answer', text: '' }, { type: 'answer', text: '' });
  const missed = await execute();
  assert.equal(missed.outcome, 'failed'); assert.equal(missed.rounds.length, 2);
  assert.deepEqual(missed.rounds.map(round => round.models), [[model], [model]]);
  stack.provider.enqueue({ type: 'answer', text: '', model: 'wrong' });
  assert.equal((await execute()).error, 'PLANNER_MODEL_MISMATCH');
  stack.provider.enqueue({ type: 'status', status: 401 });
  assert.equal((await execute()).outcome, 'error');
});

test('4C dış komut çağıranın klasörüne göre çözülür ve geçici klasörü ayrıdır', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const dir = mkdtempSync(path.join(process.cwd(), 'planner-relative-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.cjs');
  writeFileSync(file, `process.stdout.write(JSON.stringify({text:process.cwd(),toolCalls:[],models:[],usage:{thinkingTokens:0},thinking:'off', isolated:process.env.TMPDIR !== process.cwd()}));`);
  const model = externalModel({ command: `"${process.execPath}" "${path.relative(process.cwd(), file)}"`, guard: () => {} });
  try { const reply = await model.complete({ messages: [], tools: [], toolChoice: 'none' }); assert.equal(reply.error, null); assert.equal(reply.text, process.cwd()); }
  finally { model.dispose(); }
});

test('4C yakınsama: ham yapılandırılmış metindeki gold sızıntısı kararlı kodla durur', async () => {
  const { leakGuard, liveTurn } = await import('../scripts/planner-evaluation.mjs');
  const loaded = loadPlannerBenchmark(); const guard = leakGuard(loaded);
  for (const payload of [{ messages: [{ content: '{"gold":1}' }] }, { messages: [{ content: JSON.stringify({ payload: '{"gold":1}' }) }] }, { tools: [{ description: '{"needs":[]}' }] }, { messages: [{ content: [{ text: '{"expect":"answer"}' }] }] }]) {
    assert.throws(() => guard(payload), e => e.code === 'PLANNER_GOLD_LEAK');
  }
  const gateway = { runToolSession: async ({ run }) => {
    try { return await run({ model: 'qwen', round: async () => { throw Error('should not reach'); } }); }
    catch { throw Object.assign(new Error('mapped'), { code: 'AI_INTERNAL_ERROR' }); }
  } };
  const result = await planCase({ testCase: { ...loaded.cases[0], text: '{"gold":1}' }, runTurn: liveTurn(gateway, 'qwen', guard, { thinking: 'off' }), adviceFor: unavailable, now: loaded.now, catalog });
  assert.equal(result.error, 'PLANNER_GOLD_LEAK');
});

test('4C yakınsama: kesik dış model yanıtı başarısız vaka sayılır, bozuk kayıt kabul edilmez', async () => {
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION, scorePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark(); const c = loaded.cases[0]; const model = scriptedModel(answerPlan(c, loaded.referenceDate));
  const complete = model.complete.bind(model); model.complete = async p => ({ ...await complete(p), finishReason: 'length' });
  const outcome = await planCase({ testCase: c, model, adviceFor: unavailable, now: loaded.now, catalog });
  assert.equal(outcome.outcome, 'failed');
  const record = recordOf(c, 1, outcome);
  const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint, referenceDate: loaded.referenceDate,
    passes: 1, cases: [c.id], records: [record], semantic: { mode: 'none' }, model: { commandHash: '0'.repeat(64) }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
  assert.equal(scorePlannerRun(run, loaded).byPass[0].correct, 0);
  record.language = null;
  assert.equal(scorePlannerRun(run, loaded).byPass[0].correct, 0);
  for (const mutate of [r => { r.records[0].language = 'xx'; }, r => { r.records[0].plan = {}; }, r => { r.records[0].rounds = []; }]) {
    const bad = clone(run); mutate(bad); assert.throws(() => scorePlannerRun(bad, loaded), /PLANNER_RUN_INVALID/);
  }
});

test('4C yakınsama: sayfa boyu aynı nüfusu ayrı okuma yapmaz', async () => {
  const loaded = loadPlannerBenchmark(); const c = loaded.cases.find(c => c.id === 'tr-008'); const args = answerPlan(c, loaded.referenceDate);
  const { record } = await decide(loaded, c, args);
  const call = record.plan.calls.find(c => c.name === 'rota_task_search'); assert.ok(call);
  record.plan.calls.push({ ...clone(call), args: { ...call.args, limit: 1 } });
  assert.ok(scoreDecision(c, record, { referenceDate: loaded.referenceDate }).reasons.includes('calls:duplicate'));
});

test('4C yakınsama: varsayılan alanın açık bağı eşdeğerdir; başka anlam geçmez', async () => {
  const loaded = loadPlannerBenchmark();
  for (const [id, fields] of [['tr-064', [{ metric: 'notifications.unread', tool: 'rota_notifications', path: 'data.unreadCount' }]],
    ['tr-008', [{ metric: 'task.title', tool: 'rota_task_search', path: 'data.tasks.*.title' }, { metric: 'task.overdueDays', tool: 'rota_task_search', path: 'data.tasks.*.overdueDays' }]]]) {
    const c = loaded.cases.find(c => c.id === id);
    const args = answerPlan(c, loaded.referenceDate); args.request.fields = fields;
    const { record } = await decide(loaded, c, args);
    assert.equal(record.outcome, 'planned');
    assert.equal(scoreDecision(c, record, loaded).correct, true, id);
    record.plan.requests[0].fields[0].path = 'data.unrelated';
    assert.equal(scoreDecision(c, record, loaded).correct, false);
  }
});

test('4C yakınsama: birleşik proje ve IDA seçicilerinin geçerli bağları puanlanır', async () => {
  const loaded = loadPlannerBenchmark(); const c = loaded.cases.find(c => c.id === 'tr-041');
  const args = answerPlan(c, loaded.referenceDate);
  args.request.bindings = [{ metric: 'wbs.subtreeOpen', entity: 1 }];
  const { record } = await decide(loaded, c, args);
  assert.equal(record.outcome, 'planned');
  assert.equal(scoreDecision(c, record, loaded).correct, true);
  record.plan.requests[0].bindings[0].entity = 9;
  assert.equal(scoreDecision(c, record, loaded).correct, false);
});

test('4C yakınsama: kendi atama talebi yalnızca gönderilen kapsamıyla puanlanır', async () => {
  const loaded = loadPlannerBenchmark(); const c = loaded.cases.find(c => c.id === 'tr-061');
  for (const filters of [{}, { tab: 'all' }, { tab: 'history' }, { workflowStatus: 'APPROVED' }, { tab: 'sent' }, { tab: 'sent', workflowStatus: 'APPROVED' }]) {
    const args = answerPlan(c, loaded.referenceDate); args.request.filters = filters;
    const { record } = await decide(loaded, c, args);
    assert.equal(record.outcome, filters.tab === 'all' ? 'failed' : 'planned');
    assert.equal(scoreDecision(c, record, loaded).correct, filters.tab === 'sent', JSON.stringify(filters));
  }
});

test('4C yakınsama: başarılı model komutunun arka plan çocuğu da temizlenir', { skip: process.platform !== 'linux' }, async (t) => {
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-background-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.cjs');
  const marker = path.join(dir, 'child.json');
  const heartbeat = path.join(dir, 'heartbeat');
  // Kaynak sabittir; dosya yolları koda eklenmez, süreç bağımsız değişkeni olarak taşınır.
  writeFileSync(file, `
    const fs = require('node:fs');
    const path = require('node:path');
    const heartbeat = path.join(__dirname, 'heartbeat');
    const child = require('node:child_process').spawn(process.execPath, ['-e',
      "const fs = require('node:fs'); let n = 0; setInterval(() => fs.writeFileSync(process.argv[1], String(++n)), 10);",
      heartbeat], { stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(path.join(__dirname, 'child.json'), JSON.stringify({ pid: child.pid }));
    const ready = setInterval(() => {
      if (fs.existsSync(heartbeat)) { clearInterval(ready); console.log(JSON.stringify({ text: 'ok' })); }
    }, 10);
  `);
  const model = externalModel({ command: `"${process.execPath}" "${file}"`, guard: () => {} });
  t.after(() => model.dispose());
  t.after(() => { try { process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid, 'SIGKILL'); } catch { /* Zaten sonlandı. */ } });
  const result = await model.complete({ messages: [], tools: [], toolChoice: 'none' });
  assert.equal(result.text, 'ok'); assert.equal(result.error, null);
  await delay(50);
  const stopped = readFileSync(heartbeat, 'utf8');
  await delay(100);
  assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'arka plan çocuğu artık çalışmıyor');
});

test('4C yakınsama: canlı değerlendirici ortak Sicil kabul sınırını aşmaz', async (t) => {
  const { createAiStack } = await import('./helpers/aiStack.mjs');
  const { startFakeOpenAiCompatibleServer } = await import('./helpers/fakeOpenAiCompatibleServer.mjs');
  const { parseArguments, runEvaluation } = await import('../scripts/planner-evaluation.mjs');
  const server = await startFakeOpenAiCompatibleServer({ delayMs: 40 });
  t.after(() => server.close());
  server.setScenario({ stream: { chunks: body => {
    const event = value => `data: ${JSON.stringify({ model: body.model, ...value })}\n\n`;
    return [event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'p1', type: 'function', function: { name: 'rota_plan', arguments: '{"intent":"general","language":"tr"}' } }] } }] }),
      event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n'];
  } } });
  createAiStack(t, { env: { MERGEN_ROTA_AI_BASE_URL: server.baseUrl, MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0' } });
  const { flags } = parseArguments(['run', '--model', 'live', '--semantic', 'none', '--concurrency', '4', '--cases', 'tr-113,tr-114,tr-115', '--reference-date', '2026-10-14', '--no-score']);
  const run = await runEvaluation(flags);
  assert.equal(run.records.length, 3);
  assert.ok(run.records.every(record => record.outcome === 'general_redirect'));
  assert.equal(server.state.requests.length, 3);
});
