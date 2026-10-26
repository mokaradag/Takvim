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

/** Model tamamlanması ile yaşayan grup sahibinin kapanışı ayrı olaylardır. */
function finishFixtureCommand(child, code = 0) {
  if (process.platform === 'win32') {
    child.exitCode = code;
    child.emit('close', code);
  } else {
    child.stdout.emit('end');
    child.stderr?.emit('end');
    child.emit('message', { type: 'model-command-complete', code });
  }
}

test('4C donmuş bulgular: Windows temizliği yalnızca yaşayan kök PID üzerinde çalışır', async (t) => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const spawn = childProcess.spawn;
  const killed = [];
  let mode;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => { Object.defineProperty(process, 'platform', platform); childProcess.spawn = spawn; syncBuiltinESMExports(); });
  childProcess.spawn = (command, args) => {
    if (command === 'taskkill') { killed.push(args); const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 0)); return killer; }
    const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { assert.fail('beklenmeyen kill'); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (mode === 'running') child.stdout.emit('data', Buffer.alloc(20));
      else {
        if (mode === 'exited') child.exitCode = 0;
        else child.signalCode = 'SIGTERM';
        child.stdout.emit('data', Buffer.from('{}'));
        child.emit('close', child.exitCode);
      }
    }));
    return child;
  };
  syncBuiltinESMExports();
  for (mode of ['exited', 'signalled', 'running']) {
    const model = externalModel({ command: 'test-double', guard: () => {}, outputBytes: 10 });
    try { await model.complete({ messages: [], tools: [], toolChoice: 'auto' }); }
    finally { model.dispose(); }
    assert.equal(killed.length, mode === 'running' ? 1 : 0, mode);
  }
  assert.deepEqual(killed[0], ['/pid', '1234', '/T', '/F']);
});

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

test('4C §12.5 metin izni sözleşmesi açık vaka girdisidir; altın izin açmaz', async () => {
  const documentation = readFileSync(new URL('../docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md', import.meta.url), 'utf8');
  const section = documentation.split('### 12.5 ')[1].split('### 12.6 ')[0];
  assert.match(section, /input\.allowedTextFields/);
  assert.doesNotMatch(section, /yalnızca altın sözleşmesi bunu gerektiren/);
  const loaded = loadPlannerBenchmark();
  const c = loaded.cases.find(item => item.id === 'tr-001');
  const args = answerPlan(c, loaded.referenceDate);
  args.request.population.textFields = ['description'];
  const run = testCase => planCase({ testCase, model: scriptedModel(args), adviceFor: unavailable, now: loaded.now, catalog });
  const gold = { groups: [{ any: [{ textFields: ['description'] }] }] };
  const closed = await run({ ...c, gold });
  assert.equal(closed.outcome, 'clarification');
  assert.equal(closed.plan, undefined);
  const opened = await run({ ...c, gold: {}, input: { allowedTextFields: ['description'] } });
  assert.equal(opened.outcome, 'planned');
  assert.deepEqual(opened.plan.requests[0].population.textFields, ['description']);
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

test('4C bozuk kayıt raporu TypeError yerine PLANNER_RUN_INVALID verir; anlamsız koşu nitelendiremez', async (t) => {
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
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.json');
  const stronger = clone(run);
  stronger.qualification.expectedModel = 'claude-sonnet-4-5';
  for (const record of stronger.records) for (const round of record.rounds) round.models = ['claude-sonnet-4-5'];
  writeFileSync(file, JSON.stringify(stronger));
  const report = spawnSync(process.execPath, ['scripts/planner-evaluation.mjs', 'report', '--run', file], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /beklenen claude-sonnet-4-5.*gözlenen claude-sonnet-4-5.*anlamsal run.*kapı GEÇTİ/);
  assert.match(report.stdout, /general \d+\/\d+/);
  assert.match(report.stdout, /claude-haiku-4-5-20251001/);
  run.records.at(-1).semantic = { state: 'unavailable', candidates: [] };
  const lost = scorePlannerRun(run, loaded);
  assert.equal(lost.gatePassed, false, 'tek ek vakada bile danışmanlık yoksa kabul yoktur');
  assert.deepEqual(lost.semanticUnavailable, [`1:${run.records.at(-1).case}`], 'kapıyı düşüren danışmanlık kaybı vaka adıyla raporlanır');
  writeFileSync(file, JSON.stringify(run));
  const lostReport = spawnSync(process.execPath, ['scripts/planner-evaluation.mjs', 'report', '--run', file], { encoding: 'utf8' });
  assert.equal(lostReport.status, 1);
  assert.match(lostReport.stdout, new RegExp(`kapı KALDI[\\s\\S]*Anlamsal danışmanlık yok \\(kapıyı düşürür\\): 1 kayıt — 1:${run.records.at(-1).case}`));
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
  const missing = clone(run); missing.embedding.queries.pop();
  assert.throws(() => read(missing), error => error.code === 'SEMANTIC_RUN_INVALID'
    && /sorgu satırları girdiyle eşleşmiyor/.test(error.message) && /planner-evaluation.mjs input/.test(error.message));
  const stale = clone(run); stale.benchmark = 'private-marker';
  assert.throws(() => read(stale), error => error.code === 'SEMANTIC_RUN_INVALID' && /bayat/.test(error.message) && !error.message.includes('private-marker'));
  for (const [mutate, reason] of [
    [r => { r.format = 'private-marker'; }, /biçimi tanınmadı/],
    [r => { r.embedding.queries[0].text = 'private-marker'; }, /sorgu metni girdiyle aynı değil/],
    [r => { r.embedding.documents[0].text = 'private-marker'; }, /belge metni girdiyle aynı değil/],
    [r => { r.embedding.queries[1] = clone(r.embedding.queries[0]); }, /yinelenen, yabancı ya da bozuk sorgu/],
    [r => { r.embedding.queries[0].latencyMs = -1; }, /sorgu gecikmesi geçersiz/],
    [r => { r.embedding.queries[0].failure = 'private-marker'; }, /sorgu sonucu tutarsız/],
    [r => { r.embedding.queryPrefix = 'private-marker'; }, /ön ekler|önekler/],
    [r => { r.rerank.provider = ''; }, /yeniden sıralama modeli kökeni geçersiz/]
  ]) {
    const invalid = clone(run); mutate(invalid);
    assert.throws(() => read(invalid), error => error.code === 'SEMANTIC_RUN_INVALID' && reason.test(error.message) && !error.message.includes('private-marker'));
  }
  writeFileSync(file, JSON.stringify(run));
  assert.throws(() => candidatesFromRun(file, { ...loaded, cases: { map() { throw new TypeError('private-marker'); } } }),
    error => error.code === 'SEMANTIC_RUN_INVALID' && !error.message.includes('private-marker'));
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
  const canonicalOnly = clone(run);
  const canonical = new Set(loaded.cases.filter(row => row.canonical).map(row => row.id));
  canonicalOnly.embedding.queries = canonicalOnly.embedding.queries.filter(row => canonical.has(row.case));
  canonicalOnly.rerank.queries = canonicalOnly.rerank.queries.filter(row => canonical.has(row.case));
  assert.throws(() => read(canonicalOnly), /sorgu satırları girdiyle eşleşmiyor/, '117 rows cannot fabricate supplementary advice');
  read(run);
  const { parseArguments, runEvaluation } = await import('../scripts/planner-evaluation.mjs');
  const model = path.join(dir, 'model.cjs');
  const response = { text: '', toolCalls: [{ name: 'rota_plan', arguments: { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } } }],
    finishReason: 'tool_calls', models: ['scripted'], thinking: 'off', usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } } };
  writeFileSync(model, `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`);
  for (const diagnostic of [false, true]) {
    const { flags } = parseArguments(['run', '--model-command', `"${process.execPath}" "${model}"`, '--semantic', file,
      '--cases', 'tr-001,pl-019', '--expected-model', 'scripted', '--reference-date', loaded.referenceDate, ...(diagnostic ? ['--no-score'] : [])]);
    const evaluated = await runEvaluation(flags);
    assert.equal(evaluated.records.length, 2);
    assert.ok(evaluated.records.every(record => record.semantic.state === 'reranked' && record.outcome === 'clarification'));
    assert.equal(evaluated.semantic.mode, 'run');
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

test('4C sahte sağlayıcı: metinsel plan düşünme olaylarını gerçek ağ geçidine taşır', async (t) => {
  const { createAiStack } = await import('./helpers/aiStack.mjs');
  const { getAiGateway } = await import('../src/server/ai/aiRuntime.js');
  const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
  const { liveTurn, leakGuard } = await import('../scripts/planner-evaluation.mjs');
  const loaded = loadPlannerBenchmark(); const c = loaded.cases[0];
  const stack = createAiStack(t, { env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const model = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model;
  for (const type of ['answer', 'reply', 'stream']) for (const reasoning of [2, 0]) {
    stack.provider.enqueue({ type, reasoning, text: JSON.stringify({ name: 'rota_plan', arguments: answerPlan(c, loaded.referenceDate) }) });
    const result = await planCase({ testCase: c, runTurn: liveTurn(getAiGateway(), model, leakGuard(loaded), { thinking: 'off' }),
      adviceFor: unavailable, now: loaded.now, catalog });
    const events = stack.provider.calls.at(-1).emitted;
    assert.equal(events.filter(event => event.type === 'reasoning').length, reasoning, type);
    if (reasoning) {
      assert.equal(events[0].type, 'reasoning');
      assert.equal(result.error, 'PLANNER_THINKING_UNVERIFIED', type);
    } else assert.equal(result.outcome, 'planned', type);
  }
});

test('4C dış komut çağıranın klasörüne göre çözülür ve geçici klasörü ayrıdır', async (t) => {
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const dir = mkdtempSync(path.join(process.cwd(), 'planner-relative-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.cjs');
  writeFileSync(file, `
    const fs = require('node:fs');
    fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'isolation-marker'), 'ok');
    process.stdout.write(JSON.stringify({text:JSON.stringify({cwd:process.cwd(),tmp:process.env.TMPDIR,temp:process.env.TEMP,short:process.env.TMP}),toolCalls:[],models:[],usage:{thinkingTokens:0},thinking:'off'}));
  `);
  const model = externalModel({ command: `"${process.execPath}" "${path.relative(process.cwd(), file)}"`, guard: () => {} });
  let seen;
  try {
    const reply = await model.complete({ messages: [], tools: [], toolChoice: 'none' });
    assert.equal(reply.error, null);
    seen = JSON.parse(reply.text);
    assert.equal(seen.cwd, process.cwd());
    assert.ok(seen.tmp && seen.tmp !== seen.cwd);
    assert.equal(seen.temp, seen.tmp);
    assert.equal(seen.short, seen.tmp);
    assert.equal(readFileSync(path.join(seen.tmp, 'isolation-marker'), 'utf8'), 'ok');
    assert.equal(existsSync(path.join(seen.cwd, 'isolation-marker')), false);
  } finally { model.dispose(); }
  assert.equal(existsSync(seen.tmp), false);
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

/** Yerel süreçlerin işletim sistemi ortamı; model/uygulama ayarı ve kimlik bilgisi içermez. */
function commandPlatformEnv() {
  const keep = /^(PATH|SystemRoot|SystemDrive|WINDIR|ComSpec|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles(?:\(x86\))?|CommonProgramFiles(?:\(x86\))?|PSModulePath|PATHEXT)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
}

/**
 * Windows'u taklit eden POSIX çağrılarının ev denetimi ikizi: `SystemRoot` altındaki sahte PowerShell, çözülmüş ev
 * yolunda `untrusted` geçen evi reddeder, ötekini kabul eder. Gerçek ACL denetimi Windows işinde sınanır.
 */
async function windowsHomeCheckStandIn(dir) {
  const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const systemRoot = path.join(dir, 'windows');
  const folder = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'powershell.exe'), '#!/bin/sh\ncase "$ROTA_PLANNER_HOME" in *untrusted*) exit 3 ;; esac\nexit 0\n');
  chmodSync(path.join(folder, 'powershell.exe'), 0o755);
  return systemRoot;
}

test('Claude model komutu: geçersiz bütçe, kayıtsız bütçe ve tükenen çağrı hakkı modele gitmeden reddedilir', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-claude-budget-'));
  const log = path.join(dir, 'calls.jsonl');
  const input = JSON.stringify({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }], tools: [], toolChoice: 'auto' });
  // PATH boş: denetim geçseydi CLI bulunamazdı; beklenen kod yalnızca ön denetimden gelir.
  const run = (env) => JSON.parse(spawnSync(process.execPath, ['scripts/planner-claude-model.mjs'], { input, encoding: 'utf8', env: { ...commandPlatformEnv(), PATH: '', ...env } }).stdout).error;
  try {
    for (const value of ['abc', '-1', '1.5', '0']) assert.equal(run({ PLANNER_CLAUDE_MAX_CALLS: value, PLANNER_CLAUDE_LOG: log }), 'PLANNER_LIMIT_INVALID', value);
    assert.equal(run({ PLANNER_CLAUDE_MAX_CALLS: '2' }), 'PLANNER_LEDGER_REQUIRED');
    assert.equal(run({ PLANNER_CLAUDE_REQUIRE_CACHE: '1' }), 'PLANNER_LEDGER_REQUIRED');
    for (const value of ['1e3', '0x100', '0', '-1', '1.5', 'abc', ' ', '19', '600001']) {
      assert.equal(run({ PLANNER_MODEL_TIMEOUT_MS: value, PLANNER_CLAUDE_LOG: log }), 'PLANNER_LIMIT_INVALID', value);
    }
    writeFileSync(log, `${JSON.stringify({ reserved: true })}\n${JSON.stringify({ reserved: true })}\n`);
    assert.equal(run({ PLANNER_CLAUDE_MAX_CALLS: '2', PLANNER_CLAUDE_LOG: log }), 'PLANNER_BUDGET_CALLS');
    for (const value of ['20', ' 1000 ', '600000', '']) {
      assert.equal(run({ PLANNER_MODEL_TIMEOUT_MS: value, PLANNER_CLAUDE_MAX_CALLS: '2' }), 'PLANNER_LEDGER_REQUIRED', value);
    }
    writeFileSync(log, `${JSON.stringify({ usage: { input_tokens: 10, cache_creation_input_tokens: 90 } })}\n`);
    assert.equal(run({ PLANNER_CLAUDE_MAX_UNCACHED: '100', PLANNER_CLAUDE_LOG: log }), 'PLANNER_BUDGET_TOKENS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude model komutu: başka kullanıcının değiştirebileceği ev MCP yapılandırması yazılmadan ve bütçe ayrılmadan reddedilir', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-claude-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = JSON.stringify({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }], tools: [], toolChoice: 'auto' });
  let calls = 0;
  const run = (script, home, env = {}) => {
    const log = path.join(dir, `calls-${calls += 1}.jsonl`);
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8',
      env: { ...commandPlatformEnv(), PATH: '', PLANNER_CLAUDE_LOG: log, PLANNER_CLAUDE_HOME: home, ...env } });
    const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { error: JSON.parse(result.stdout).error, reserved: rows.some(row => row.reserved) };
  };
  const untrusted = (outcome, label) => {
    assert.equal(outcome.error, 'PLANNER_HOME_UNTRUSTED', label);
    assert.equal(outcome.reserved, false, `${label}: güvenilmeyen ev bütçe ayırmaz`);
  };

  const adapter = 'scripts/planner-claude-model.mjs';
  if (process.platform === 'win32') {
    // Gerçek ACL: başka hesaba devredilen yazma hakkı evi, yalnızca bu klasörde verilen alt öğe silme hakkı atayı
    // güvenilmez kılar. Kullanıcının kendi geçici klasörü altındaki ev kabul edilir.
    const grant = (target, rights) => assert.equal(spawnSync('icacls', [target, '/grant', `*S-1-1-0:${rights}`], { encoding: 'utf8' }).status, 0);
    const shared = path.join(dir, 'shared');
    mkdirSync(shared);
    grant(shared, '(OI)(CI)M');
    untrusted(run(adapter, path.join(shared, 'home')), 'herkese yazılabilir ev');
    assert.deepEqual(readdirSync(path.join(shared, 'home')), [], 'reddedilen eve yürütülebilir yapılandırma yazılmaz');
    const renamable = path.join(dir, 'renamable');
    mkdirSync(renamable);
    grant(renamable, '(DC)');
    untrusted(run(adapter, path.join(renamable, 'home')), 'alt öğesi başkasınca silinebilen ata');
    const outcome = run(adapter, path.join(dir, 'private', 'home'));
    if (outcome.error === 'PLANNER_HOME_UNTRUSTED') {
      // Tanı: beklenmeyen reddin hangi klasör ve hesaptan geldiği (yalnızca başarısızlıkta).
      const dump = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command',
        "$p=$env:ROTA_PLANNER_HOME; while ($p) { $a=[IO.Directory]::GetAccessControl($p); $t=[Security.Principal.SecurityIdentifier]; '{0} {1}' -f $p, $a.GetOwner($t).Value; "
        + "foreach ($r in $a.GetAccessRules($true,$true,$t)) { '  {0} {1} {2:X} {3}' -f $r.IdentityReference.Value, $r.AccessControlType, [long]$r.FileSystemRights, $r.PropagationFlags }; $p=[IO.Path]::GetDirectoryName($p) }"],
      { encoding: 'utf8', env: { ...process.env, ROTA_PLANNER_HOME: path.join(dir, 'private', 'home') } });
      assert.fail(`özel ev reddedildi:\n${dump.stdout}${dump.stderr}`);
    }
    return;
  }

  // Windows yolu her platformda bağlantısıyla sınanır: denetim süreci (sahte PowerShell) çözülmüş evi alır, sıfırdan
  // farklı çıkış ya da çalışmayan denetim evi reddeder. Taklit edilen platformda kayıt kilidi Windows sürecini
  // sorgulayacağı için bu çağrılar kayıtsızdır.
  const windows = path.join(dir, 'windows.mjs');
  writeFileSync(windows, `Object.defineProperty(process, 'platform', { value: 'win32' });
    const { runAdapter } = await import(${JSON.stringify(pathToFileURL(path.resolve(adapter)).href)});
    await runAdapter();`);
  const windowsEnv = { SystemRoot: await windowsHomeCheckStandIn(dir), PLANNER_CLAUDE_LOG: '' };
  untrusted(run(windows, path.join(dir, 'untrusted-home'), windowsEnv), 'denetimin reddettiği ev');
  assert.deepEqual(readdirSync(path.join(dir, 'untrusted-home')), [], 'reddedilen eve yürütülebilir yapılandırma yazılmaz');
  mkdirSync(path.join(dir, 'untrusted-target'));
  symlinkSync(path.join(dir, 'untrusted-target'), path.join(dir, 'linked-home'));
  untrusted(run(windows, path.join(dir, 'linked-home'), windowsEnv), 'bağlantının çözülmüş hedefi denetlenir');
  untrusted(run(windows, path.join(dir, 'unchecked-home'), { PLANNER_CLAUDE_LOG: '' }), 'çalışmayan denetim');
  assert.deepEqual(readdirSync(path.join(dir, 'unchecked-home')), []);
  assert.notEqual(run(windows, path.join(dir, 'private-home'), windowsEnv).error, 'PLANNER_HOME_UNTRUSTED');

  const shared = path.join(dir, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  untrusted(run(adapter, path.join(shared, 'home')), 'başkasına yazılabilir yapışkansız ata');
  assert.deepEqual(readdirSync(path.join(shared, 'home')), []);
  const open = path.join(dir, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  untrusted(run(adapter, open), 'başkasına yazılabilir ev');
  assert.deepEqual(readdirSync(open), []);
  // Bağlantı çözülür ve hedefin kendisi denetlenir: güvenli klasörden açık eve giden bağ da reddedilir.
  symlinkSync(open, path.join(dir, 'link'));
  untrusted(run(adapter, path.join(dir, 'link')), 'açık eve yönelen bağlantı');
  // Yapışkan bitli ortak kök (ör. /tmp) altındaki kendi klasörü güvenilirdir.
  const sticky = path.join(dir, 'sticky');
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  assert.notEqual(run(adapter, path.join(sticky, 'home')).error, 'PLANNER_HOME_UNTRUSTED');
});

/** Gerçek komut sınırı; yerel CLI ikizi yalnızca açık dosya bariyerinde tamamlanır. */
async function claudeCommandFixture(t, { reuse = false, events = null, newline = true, descendant = false, standalone = false, payload = null, executionDelayMs = 0, commandTimeoutMs = 8000, ...limits } = {}) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { spawnModelCommand, terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, watch, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-claude-command-'));
  const entered = path.join(dir, 'entered');
  mkdirSync(entered);
  const log = path.join(dir, 'calls.jsonl');
  const release = path.join(dir, 'release');
  const children = [];
  const killed = new Set();
  const kill = child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killed.add(child);
    if (process.platform === 'win32') {
      const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      if (result.error) throw result.error;
    } else try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  t.after(async () => {
    children.forEach(({ child }) => kill(child));
    await Promise.allSettled(children.map(({ done }) => done));
    rmSync(dir, { recursive: true, force: true });
  });
  const model = path.join(dir, 'claude.cjs');
  const adapter = path.join(dir, 'model.mjs');
  writeFileSync(adapter, `import { runAdapter } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/planner-claude-model.mjs')).href)};
    await runAdapter({ command: process.argv[3] || process.execPath, prefixArgs: process.argv[3] ? [] : [process.argv[2]] });`);
  writeFileSync(model, `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = __dirname;
    if (${descendant}) {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref();
      fs.writeFileSync(path.join(root, 'descendant'), String(child.pid));
    }
    fs.writeFileSync(path.join(root, 'entered', String(process.pid)), 'ready');
    const finish = () => {
      if (!fs.existsSync(path.join(root, 'release'))) return;
      watcher.close();
      const cached = ${reuse} && fs.readdirSync(path.join(root, 'entered')).length > 1;
      setTimeout(() => { const events = ${events ? JSON.stringify(events) : `[
        {type:'system',subtype:'init',tools:[]},
        {type:'assistant',message:{id:'one',model:'claude-haiku-4-5-20251001',content:[{type:'text',text:'ok'}]}},
        {type:'result',num_turns:1,stop_reason:'end_turn',usage:{input_tokens:10,cache_creation_input_tokens:90,cache_read_input_tokens:cached?100:0,output_tokens:1}}
      ]`}; events.forEach((event, index) => process.stdout.write(JSON.stringify(event) + (${newline} || index < events.length - 1 ? '\\n' : ''))); }, ${executionDelayMs});
    };
    const watcher = fs.watch(root, finish);
    process.stdin.resume();
    finish();
  `);
  const waitFor = predicate => new Promise((resolve, reject) => {
    let settled = false;
    const done = error => { if (settled) return; settled = true; watchers.forEach(watcher => watcher.close()); clearTimeout(timer); error ? reject(error) : resolve(); };
    const check = () => { if (!settled && predicate()) done(); };
    const watchers = [watch(dir, check), watch(entered, check)];
    watchers.forEach(watcher => watcher.on('error', done));
    const timer = setTimeout(() => done(new Error('CLI bariyeri beklenirken süre aşıldı')), 5000);
    children.at(-1)?.done.then(reply => { if (!settled && !predicate()) done(new Error(`Bağdaştırıcı hazır olmadan bitti: ${reply.error || reply.signal || 'no provider call'}`)); }, done);
    check();
  });
  const start = (extra = {}, command = null) => {
    const launch = standalone ? spawn : spawnModelCommand;
    const child = launch(process.execPath, [adapter, model, ...(command ? [command] : [])], { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...commandPlatformEnv(), PLANNER_CLAUDE_HOME: path.join(dir, 'home'), PLANNER_CLAUDE_LOG: log, ...limits, ...extra } });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const done = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { kill(child); reject(new Error('Bağdaştırıcı tamamlanmadı')); }, commandTimeoutMs);
      const finish = async (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killed.has(child)) return resolve({ terminated: true, signal });
        try { await terminateModelCommand(child); assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (error) { reject(error); }
      };
      child.on('command-close', finish);
      child.on('close', (code, signal) => { if (standalone || !settled) finish(code, signal); });
    });
    children.push({ child, done });
    child.stdin.end(JSON.stringify(payload || { messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'question' }], tools: [], toolChoice: 'none' }));
    return { child, done };
  };
  return { start, kill, waitFor, log, dir, adapter, model, command: '"' + process.execPath + '" "' + adapter + '" "' + model + '"', descendantPid: () => Number(readFileSync(path.join(dir, 'descendant'), 'utf8')), release: () => writeFileSync(release, 'go'),
    count: () => readdirSync(entered).length,
    locked: () => existsSync(`${log}.lock`),
    waiting: () => readdirSync(dir).some(name => name.startsWith('calls.jsonl.lock-')),
    rows: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('Claude son yakınsama: kilit ve yürütme ayrı sürelerle sınırlıdır', async (t) => {
  const cli = await claudeCommandFixture(t, { executionDelayMs: 5500, commandTimeoutMs: 20000 });
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  const second = cli.start({ PLANNER_MODEL_TIMEOUT_MS: '10000' });
  await cli.waitFor(() => cli.waiting());
  cli.release();
  assert.equal((await first.done).text, 'ok');
  assert.equal((await second.done).text, 'ok', 'kilit beklemesi yürütme bütçesini tüketmez');
  const hung = await claudeCommandFixture(t, { PLANNER_MODEL_TIMEOUT_MS: '5000', commandTimeoutMs: 20000 });
  const timedOut = await hung.start().done;
  assert.equal(timedOut.error, 'MODEL_COMMAND_TIMEOUT', 'modelin kendi yürütme süresi sınırlıdır');
  assert.equal(hung.locked(), false, 'süre aşımı kilidi bırakır');
  assert.equal(hung.rows().filter(row => row.reserved).length, 1);
  assert.equal(hung.rows().find(row => row.error).usage.input_tokens, null, 'bilinmeyen harcama sıfır sayılmaz');
});

test('4C takip nitelendirmesi: üst süre kilit ve yürütme bütçelerini kapsar', async (t) => {
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const original = { spawn: cp.spawn, kill: process.kill };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let child;
  let kills = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => { cp.spawn = original.spawn; process.kill = original.kill; Object.defineProperty(process, 'platform', platform); syncBuiltinESMExports(); });
  cp.spawn = () => (child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), send() {} }));
  process.kill = (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    kills += 1;
    if (signal === 'SIGKILL') queueMicrotask(() => { child.signalCode = signal; child.emit('close', null); });
  };
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = realModelProvider();
  const pending = provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none' });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  // 100 seconds waiting for the ledger, then 100 seconds executing: both below 120 seconds.
  t.mock.timers.tick(200000);
  assert.equal(kills, 0, 'üst süre ikinci evreyi erken kesmez');
  child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', toolCalls: [], finishReason: 'end_turn', models: ['claude-haiku-4-5-20251001'], thinking: 'off' })));
  finishFixtureCommand(child);
  const completed = await observed;
  assert.equal(completed.error, undefined);
  for await (const event of completed.value.events) assert.notEqual(event.type, 'error');
  const next = provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none' });
  const failure = assert.rejects(next, /MODEL_COMMAND_TIMEOUT/);
  t.mock.timers.tick(251000);
  await failure;
  assert.equal(kills, 2, 'başarı ve zaman aşımı grupları birer kez temizlenir');
});

test('Claude yakınsama: eşzamanlı aynı önek tamamlanan çağrıya göre önbellek denetler', async (t) => {
  for (const reuse of [false, true]) await t.test(String(reuse), async (t) => {
    const cli = await claudeCommandFixture(t, { reuse, PLANNER_CLAUDE_REQUIRE_CACHE: '1' });
    const first = cli.start();
    await cli.waitFor(() => cli.count() === 1);
    const second = cli.start();
    await cli.waitFor(() => cli.waiting() || cli.count() === 2);
    assert.equal(cli.count(), 1, 'önceki kullanım kaydedilmeden ikinci model çağrısı başlamaz');
    cli.release();
    const replies = await Promise.all([first.done, second.done]);
    assert.equal(replies[0].error, undefined);
    assert.equal(replies[1].error, reuse ? undefined : 'PLANNER_CACHE_NOT_REUSED');
    assert.equal(cli.count(), 2);
    assert.equal(cli.rows().filter(row => row.usage).length, 2);
    assert.equal(cli.locked(), false);
  });
});

test('Claude son yakınsama: bayat önbellek ısınır, yakın çağrı ve kalıcı bütçe kapıları korunur', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_REQUIRE_CACHE: '1', PLANNER_CLAUDE_MAX_CALLS: '3' });
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  cli.release();
  assert.equal((await first.done).text, 'ok');
  const rows = cli.rows();
  rows.find(row => row.usage).at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  writeFileSync(cli.log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal((await cli.start().done).text, 'ok', 'süresi dolmuş önek yeniden ısınabilir');
  assert.equal((await cli.start().done).error, 'PLANNER_CACHE_NOT_REUSED', 'yakın başarılı satır hâlâ önbellek okumasını gerektirir');
  assert.equal((await cli.start().done).error, 'PLANNER_BUDGET_CALLS', 'bayat satır bütçeden silinmez');
  assert.equal(cli.count(), 3);
  assert.equal(cli.rows().filter(row => row.reserved).length, 3);
});

test('Claude yakınsama: eşzamanlı çağrı tükenen belirteç bütçesini aşarak modele gitmez', async (t) => {
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_UNCACHED: '100' });
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  const second = cli.start();
  await cli.waitFor(() => cli.waiting() || cli.count() === 2);
  assert.equal(cli.count(), 1);
  cli.release();
  const replies = await Promise.all([first.done, second.done]);
  assert.equal(replies[0].error, undefined);
  assert.equal(replies[1].error, 'PLANNER_BUDGET_TOKENS');
  assert.equal(cli.count(), 1, 'reddedilen çağrı sağlayıcıya ulaşmaz');
  assert.equal(cli.rows().filter(row => row.reserved).length, 1);
  assert.equal(cli.locked(), false);
});

test('Claude yakınsama: öldürülen kilit sahibi kurtarılır; bilinmeyen harcama kapalı kalır', async (t) => {
  const cli = await claudeCommandFixture(t);
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  assert.equal(cli.locked(), true);
  cli.kill(first.child);
  assert.equal((await first.done).terminated, true);
  const denied = await cli.start({ PLANNER_CLAUDE_MAX_UNCACHED: '100' }).done;
  assert.equal(denied.error, 'PLANNER_BUDGET_UNVERIFIED');
  assert.equal(cli.count(), 1, 'yarım kalan kullanım sıfır sayılmaz');
  cli.release();
  const recovered = await Promise.all([cli.start({ PLANNER_CLAUDE_MAX_CALLS: '2' }).done, cli.start({ PLANNER_CLAUDE_MAX_CALLS: '2' }).done]);
  assert.equal(recovered.filter(reply => reply.text === 'ok').length, 1);
  assert.equal(recovered.filter(reply => reply.error === 'PLANNER_BUDGET_CALLS').length, 1);
  assert.equal(cli.count(), 2);
  assert.equal(cli.locked(), false);
});

test('Claude yakınsama: otuz saniyeden uzun geçerli çağrı bekleyen çağrıyı düşürmez', { timeout: 60000 }, async (t) => {
  const cli = await claudeCommandFixture(t, { reuse: true, commandTimeoutMs: 45000, PLANNER_CLAUDE_REQUIRE_CACHE: '1' });
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  const second = cli.start();
  await cli.waitFor(() => cli.waiting());
  await new Promise(resolve => setTimeout(resolve, 32000));
  assert.equal(cli.count(), 1);
  cli.release();
  const replies = await Promise.all([first.done, second.done]);
  assert.ok(replies.every(reply => !reply.error && reply.text === 'ok'));
  assert.equal(cli.count(), 2);
  assert.equal(cli.locked(), false);
});

test('Claude yakınsama: canlı sahip korunur, bekleyen kendi komut bütçesinde sonlanır', async (t) => {
  const cli = await claudeCommandFixture(t);
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  const blocked = await cli.start({ PLANNER_MODEL_TIMEOUT_MS: '100' }).done;
  assert.equal(blocked.error, 'PLANNER_LEDGER_LOCKED');
  assert.equal(cli.locked(), true);
  assert.equal(cli.count(), 1);
  cli.release();
  assert.equal((await first.done).text, 'ok');
  assert.equal(cli.locked(), false);
});

test('Claude yakınsama: yeniden kullanılan canlı PID eski süreç örneğinin kilidini tutamaz', async (t) => {
  const { randomUUID } = await import('node:crypto');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_CALLS: '1', PLANNER_MODEL_TIMEOUT_MS: '5000' });
  let identity = 'previous-process-instance';
  if (process.platform === 'linux') {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const start = BigInt(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
    identity = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(0, stat.indexOf(' '))}:${start + 1n}`;
  }
  mkdirSync(`${cli.log}.lock`);
  writeFileSync(path.join(`${cli.log}.lock`, `${process.pid}-${randomUUID()}`), JSON.stringify({ pid: process.pid, identity }));
  cli.release();
  const replies = await Promise.all([cli.start().done, cli.start().done]);
  assert.equal(replies.filter(reply => reply.text === 'ok').length, 1);
  assert.equal(replies.filter(reply => reply.error === 'PLANNER_BUDGET_CALLS').length, 1);
  assert.equal(cli.count(), 1);
  assert.equal(cli.locked(), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'yeni PID sahibi sonlandırılmaz');
});

test('Claude Windows kilit temizliği: geçici dosya paylaşımı hatası sahipliği ve çağrı bütçesini korur', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const [phase, method, code] of [['stale', 'unlinkSync', 'EPERM'], ['owner', 'unlinkSync', 'EBUSY'], ['directory', 'rmdirSync', 'EPERM']]) {
    await t.test(phase, async (t) => {
      const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_CALLS: '1', PLANNER_MODEL_TIMEOUT_MS: '5000' });
      const lock = `${cli.log}.lock`;
      if (phase === 'stale') {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000001`), JSON.stringify({ pid: process.pid, identity: 'previous-process-instance' }));
      }
      fs.writeFileSync(cli.adapter, `
        import fs from 'node:fs';
        import path from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const original = fs[${JSON.stringify(method)}];
        let failures = 0;
        fs[${JSON.stringify(method)}] = function(file, ...args) {
          const target = ${JSON.stringify(phase)} === 'directory' ? file === ${JSON.stringify(lock)}
            : path.dirname(file) === ${JSON.stringify(lock)} && path.basename(file).startsWith(String(${phase === 'stale' ? process.pid : 'process.pid'}) + '-');
          if (target && failures++ < 2) {
            fs.appendFileSync(${JSON.stringify(`${cli.log}.faults`)}, '${code}\\n');
            throw Object.assign(new Error('sharing violation'), { code: '${code}' });
          }
          return original(file, ...args);
        };
        syncBuiltinESMExports();
      ` + fs.readFileSync(cli.adapter, 'utf8'));
      cli.release();
      const replies = await Promise.all([cli.start().done, cli.start().done]);
      assert.equal(replies.filter(reply => reply.text === 'ok').length, 1);
      assert.equal(replies.filter(reply => reply.error === 'PLANNER_BUDGET_CALLS').length, 1);
      assert.ok(fs.readFileSync(`${cli.log}.faults`, 'utf8').trim().split('\n').length >= 2);
      assert.equal(cli.count(), 1);
      assert.equal(cli.locked(), false);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
    });
  }
});

test('Claude Windows kilit temizliği: kalıcı hata süre sınırında kapalı kalır', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const code of ['EPERM', 'EACCES']) await t.test(code, async (t) => {
    const cli = await claudeCommandFixture(t, { PLANNER_MODEL_TIMEOUT_MS: '2000' });
    const lock = `${cli.log}.lock`;
    const owner = path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000001`);
    fs.mkdirSync(lock);
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, identity: 'previous-process-instance' }));
    fs.writeFileSync(cli.adapter, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.unlinkSync;
      fs.unlinkSync = function(file, ...args) {
        if (file === ${JSON.stringify(owner)}) {
          fs.appendFileSync(${JSON.stringify(`${cli.log}.faults`)}, '${code}\\n');
          throw Object.assign(new Error('permanent failure'), { code: '${code}' });
        }
        return original(file, ...args);
      };
      syncBuiltinESMExports();
    ` + fs.readFileSync(cli.adapter, 'utf8'));
    await assert.rejects(cli.start().done, new RegExp(code));
    const failures = fs.readFileSync(`${cli.log}.faults`, 'utf8').trim().split('\n').length;
    assert.ok(code === 'EPERM' ? failures > 1 : failures === 1);
    assert.equal(cli.count(), 0);
    assert.equal(fs.existsSync(owner), true);
  });
});

test('Claude Windows kilit temizliği: yineleme sırasında gelen yeni sahip silinmez', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t, { PLANNER_MODEL_TIMEOUT_MS: '2000' });
  const lock = `${cli.log}.lock`;
  const owner = path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000001`);
  const replacement = path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000002`);
  fs.mkdirSync(lock);
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, identity: 'previous-process-instance' }));
  fs.writeFileSync(cli.adapter, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.unlinkSync;
    let replaced = false;
    fs.unlinkSync = function(file, ...args) {
      if (file === ${JSON.stringify(owner)} && !replaced) {
        replaced = true;
        original(file, ...args);
        fs.writeFileSync(${JSON.stringify(replacement)}, '${process.pid}');
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      }
      return original(file, ...args);
    };
    syncBuiltinESMExports();
  ` + fs.readFileSync(cli.adapter, 'utf8'));
  assert.equal((await cli.start().done).error, 'PLANNER_LEDGER_LOCKED');
  assert.equal(cli.count(), 0);
  assert.equal(fs.existsSync(replacement), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('4C kayıtlı dış komut: kuyruk yürütme süresini tüketmez; kapanış bekleyenleri başlatmaz', async (t) => {
  const { mkdtempSync, rmSync, watch, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-queued-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, 'trace.jsonl');
  const file = path.join(dir, 'model.cjs');
  writeFileSync(trace, '');
  writeFileSync(file, `
    const fs = require('node:fs');
    const path = require('node:path');
    const id = JSON.parse(fs.readFileSync(0, 'utf8')).messages[0].content;
    const record = phase => fs.appendFileSync(path.join(__dirname, 'trace.jsonl'), JSON.stringify({id,phase,budget:process.env.PLANNER_MODEL_TIMEOUT_MS})+'\\n');
    record('start');
    setTimeout(() => {record('end'); console.log(JSON.stringify({text:'ok',toolCalls:[]}));}, 350);
  `);
  const create = () => externalModel({ command: `"${process.execPath}" "${file}"`, guard: () => {}, ledger: path.join(dir, 'calls.jsonl'), timeoutMs: 1000 });
  const input = id => ({ messages: [{ role: 'user', content: String(id) }], tools: [], toolChoice: 'none' });
  const rows = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const model = create();
  t.after(() => model.dispose());
  const replies = await Promise.all([1, 2, 3, 4].map(id => model.complete(input(id))));
  assert.ok(replies.every(reply => reply.error === null && reply.text === 'ok'));
  assert.deepEqual(rows().map(({ id, phase }) => [id, phase]), [1, 2, 3, 4].flatMap(id => [[String(id), 'start'], [String(id), 'end']]));
  assert.ok(rows().every(row => row.budget === '1000'));
  model.dispose();
  writeFileSync(trace, '');
  const cancelled = create();
  t.after(() => cancelled.dispose());
  const started = new Promise((resolve, reject) => {
    const watcher = watch(dir, () => { if (rows().length) { clearTimeout(timer); watcher.close(); resolve(); } });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Komut başlamadı')); }, 5000);
  });
  const waiting = [1, 2, 3].map(id => cancelled.complete(input(id)));
  await started;
  cancelled.dispose();
  assert.ok((await Promise.all(waiting)).every(reply => reply.error === 'MODEL_COMMAND_ERROR'));
  assert.equal(rows().filter(row => row.phase === 'start').length, 1);
});

test('4C takip nitelendirmesi: açık bitiş nedeni korunur, bilinmeyen neden sağlayıcıya geçmez', async () => {
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  for (const reason of [undefined, null, '', 'unknown', 'error_max_turns', 'stop', 'end_turn', 'eos', 'stop_sequence', 'tool_calls', 'length', 'content_filter']) {
    for (const toolCalls of [[], [{ name: 'rota_task_search', arguments: {} }]]) {
      const provider = realModelProvider({ completeRound: async () => ({ text: '', toolCalls, finishReason: reason, models: ['claude-haiku-4-5-20251001'], thinking: 'off' }) });
      const input = { model: 'standard', messages: [], tools: [], toolChoice: 'auto' };
      if ([undefined, null, '', 'unknown', 'error_max_turns'].includes(reason)) {
        await assert.rejects(provider.streamToolCompletion(input), /PLANNER_COMPLETION_UNVERIFIED/);
        assert.equal(provider.calls.length, 0);
      } else {
        const stream = await provider.streamToolCompletion(input);
        const events = [];
        for await (const event of stream.events) events.push(event);
        assert.equal(events.find(event => event.type === 'done').finishReason, reason);
      }
    }
  }
});

test('4C takip nitelendirmesi: gerçek metin ve araç önsözü yerel plan çağrısına çevrilmez', async () => {
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const text = JSON.stringify({ name: 'rota_plan', arguments: { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } } });
  for (const toolCalls of [[], [{ id: 'real-call', name: 'rota_task_search', arguments: '{}' }], [{ id: 'native-plan', name: 'rota_plan', arguments: '{"intent":"general","language":"tr"}' }]]) {
    const provider = realModelProvider({ completeRound: async () => ({ text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'end_turn',
      models: ['claude-haiku-4-5-20251001'], thinking: 'off' }) });
    const stream = await provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'auto' });
    const events = [];
    for await (const event of stream.events) events.push(event);
    assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), text);
    assert.deepEqual(events.at(-1).toolCalls || [], toolCalls.map(call => ({ ...call, oversize: false })));
  }
});

test('4C takip nitelendirmesi: metin planı üretim sınırında reddedilir ve yerel çağrıyla onarılır', async (t) => {
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const { createAiStack, sendTurn } = await import('./helpers/aiStack.mjs');
  const { AYSE, NOW, rotaToolSeed } = await import('./helpers/aiToolFixtures.mjs');
  const { randomUUID } = await import('node:crypto');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const plan = { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } };
  let rounds = 0;
  const provider = realModelProvider({ completeRound: async () => ({
    text: ++rounds === 1 ? JSON.stringify({ name: 'rota_plan', arguments: plan }) : '',
    toolCalls: rounds === 1 ? [] : [{ name: 'rota_plan', arguments: plan }],
    finishReason: rounds === 1 ? 'end_turn' : 'tool_calls', models: ['claude-haiku-4-5-20251001'], thinking: 'off'
  }) });
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, provider });
  const response = await sendTurn({ turnId: randomUUID(), message: 'Onun durumu?' });
  assert.equal(response.events.find(event => event.event === 'done').data.assistantMessage.finishReason, 'clarification');
  assert.equal(rounds, 2, 'metin JSON ilk plan kararı olarak kabul edilmez');
  assert.equal(stack.db.aiToolLog?.length || 0, 0);
});

test('4C takip nitelendirmesi: başarısız senaryo ve devir raporlandıktan sonra komut başarısız olur', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-followup-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.mjs');
  const out = path.join(dir, 'report.jsonl');
  writeFileSync(file, `
    import test from 'node:test';
    import { readFileSync } from 'node:fs';
    import { finalizeQualification } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/planner-followup-qualification.mjs')).href)};
    const result = JSON.parse(readFileSync(new URL('./result.json', import.meta.url), 'utf8'));
    test('fixture', () => {});
    test.after(() => finalizeQualification(result));
  `);
  for (const [failed, escalations, expected] of [[[], 0, 0], [[{ reason: 'wrong answer' }], 0, 1], [[], 1, 1]]) {
    const result = { chains: 1, turns: 1, passed: failed.length ? 0 : 1, failed, modelCalls: 0, escalations, models: [] };
    writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
    rmSync(out, { force: true });
    const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env: { ...commandPlatformEnv(), PLANNER_FOLLOWUP_OUT: out } });
    assert.equal(run.status, expected, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), result, 'başarısız rapor da korunur');
  }
});

test('Claude son yedi: kanıtlanmış başlatma hatası harcama bırakmaz; sonraki bütçeli çağrı çalışır', async (t) => {
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_UNCACHED: '101' });
  const failed = await cli.start({}, path.join(path.dirname(cli.log), 'missing-cli')).done;
  assert.equal(failed.error, 'PLANNER_PROVIDER_ERROR');
  assert.equal(cli.count(), 0);
  assert.equal(cli.rows().find(row => row.usage)?.usage.input_tokens, 0);
  assert.equal(cli.locked(), false);
  cli.release();
  assert.equal((await cli.start().done).text, 'ok');
  assert.equal(cli.count(), 1);
});

test('Claude son yedi: başlamış ama sonuçsuz oturum tamamlanma ve sıfır harcama kanıtı değildir', async (t) => {
  for (const toolCall of [false, true]) await t.test(String(toolCall), async (t) => {
    const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_UNCACHED: '101', events: [
      { type: 'system', subtype: 'init', tools: [] },
      ...(toolCall ? [{ type: 'assistant', message: { id: 'one', model: 'claude-haiku-4-5-20251001', content: [
        { type: 'tool_use', name: 'mcp__rota__rota_plan', input: { intent: 'general', language: 'tr' } }
      ] } }] : [])
    ] });
    cli.release();
    const failed = await cli.start().done;
    assert.equal(failed.error, 'PLANNER_PROVIDER_ERROR');
    assert.deepEqual(failed.toolCalls, []);
    assert.equal(cli.rows().find(row => row.usage)?.usage.input_tokens, null);
    assert.equal((await cli.start().done).error, 'PLANNER_BUDGET_UNVERIFIED');
    assert.equal(cli.count(), 1, 'bilinmeyen harcama yeni sağlayıcı çağrısı açmaz');
    assert.equal(cli.locked(), false);
  });
});

test('4C son yedi: istenen denetim girdisi normalleştirilmiş yanıtla aynı çağrıya bağlanır', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-audit-response-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.cjs');
  const response = { text: 'rejected plan', toolCalls: [{ name: 'rota_plan', arguments: { intent: 'invalid' } }],
    finishReason: 'tool_calls', models: ['observed-model'], thinking: 'off', usage: { input_tokens: 12 } };
  writeFileSync(file, `console.log(${JSON.stringify(JSON.stringify(response))});`);
  const model = externalModel({ command: `"${process.execPath}" "${file}"`, inputs: dir, guard: () => {} });
  t.after(() => model.dispose());
  const reply = await model.complete({ messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'question' }], tools: [], toolChoice: 'auto' });
  const input = JSON.parse(readFileSync(path.join(dir, 'inputs.jsonl'), 'utf8'));
  const saved = JSON.parse(readFileSync(path.join(dir, 'completions.jsonl'), 'utf8'));
  assert.deepEqual(saved, { call: input.call, ...reply });
  assert.equal(saved.toolCalls[0].arguments, JSON.stringify(response.toolCalls[0].arguments));
  assert.equal(saved.finishReason, 'tool_calls');
  assert.equal(saved.usage.input_tokens, 12);
});

test('4C takip nitelendirmesi son yedi: süreç sahibi zaman aşımı, iptal ve geç kapanışı tek kez sonlandırır', { timeout: 5000 }, async (t) => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const kills = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const spawn = childProcess.spawn;
  const kill = process.kill;
  const exit = process.exit;
  const exits = [];
  const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => process.listenerCount(name));
  process.exit = code => { exits.push(code); };
  t.after(() => { Object.defineProperty(process, 'platform', platform); childProcess.spawn = spawn; process.kill = kill; process.exit = exit; syncBuiltinESMExports(); });
  childProcess.spawn = (command, args, options) => {
    if (command === 'taskkill') { kills.push(args); const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 0)); return killer; }
    const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null,
      options, stdin: new PassThrough(), stdout: new PassThrough(), send() {}, kill() { kills.push('child'); } });
    children.push(child);
    return child;
  };
  process.kill = (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    kills.push([pid, signal]);
    if (signal === 'SIGKILL') { const child = children.at(-1); queueMicrotask(() => { child.signalCode = signal; child.emit('close', null); }); }
  };
  syncBuiltinESMExports();
  for (const os of ['linux', 'win32']) {
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    for (const mode of ['timeout', 'cancel', 'deadline', 'signal', 'error', 'success']) {
      const controller = new AbortController();
      const provider = realModelProvider();
      const pending = provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none', signal: controller.signal });
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      const child = children.at(-1);
      const before = kills.length;
      if (mode === 'timeout') t.mock.timers.tick(251000);
      if (mode === 'cancel') controller.abort();
      if (mode === 'deadline') {
        const { AiError } = await import('../src/server/ai/aiErrors.js');
        controller.abort(new AiError('AI_TIMEOUT'));
      }
      if (mode === 'signal') { process.listeners('SIGTERM').at(-1)(); await new Promise(setImmediate); assert.equal(exits.at(-1), 143); }
      if (mode === 'error') child.emit('error', new Error('spawn failure'));
      if (mode !== 'success') {
        await new Promise(setImmediate);
        assert.equal(settled, true, `${mode}: komut tek terminal sonuca ulaşır`);
      }
      if (mode === 'success') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', toolCalls: [], finishReason: 'end_turn', models: ['claude-haiku-4-5-20251001'], thinking: 'off' })));
        finishFixtureCommand(child);
        const stream = await pending;
        for await (const event of stream.events) assert.notEqual(event.type, 'error');
      } else {
        await assert.rejects(pending, mode === 'timeout' ? /MODEL_COMMAND_TIMEOUT/ : mode === 'deadline' ? error => error.code === 'AI_TIMEOUT' : ['cancel', 'signal'].includes(mode) ? error => error.code === 'AI_CANCELLED' : /MODEL_COMMAND_ERROR/);
        assert.equal(child.options.detached, os !== 'win32');
        if (mode !== 'error') assert.equal(kills.length, before + 1, 'süreç ağacı tek temizleme kararıyla sonlandırılır');
        assert.equal(provider.calls.length, 0, 'başarısız çıktı sağlayıcıya geçmez');
      }
      const terminalKills = kills.length;
      child.exitCode = 0;
      child.emit('close', 0);
      controller.abort();
      t.mock.timers.tick(120000);
      assert.equal(kills.length, terminalKills, 'geç kapanış ve iptal yeniden sonlandırmaz');
      assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => process.listenerCount(name)), listeners);
    }
  }
});

test('4C takip nitelendirmesi: temizleme hatası tek sonucu ve sonraki çağrıyı korur', { timeout: 5000 }, async (t) => {
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const { AiError } = await import('../src/server/ai/aiErrors.js');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const original = { spawn: cp.spawn, kill: process.kill };
  const systemRoot = process.env.SystemRoot;
  process.env.SystemRoot ||= 'C:/Windows';
  t.after(() => { if (systemRoot == null) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot; });
  const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => process.listenerCount(name));
  const commands = [];
  let child;
  let cleanupMode;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { Object.defineProperty(process, 'platform', platform); cp.spawn = original.spawn; process.kill = original.kill; syncBuiltinESMExports(); });
  cp.spawn = (command, args) => {
    if (command !== process.execPath) {
      commands.push({ command, args });
      const killer = Object.assign(new EventEmitter(), { kill() {} });
      queueMicrotask(() => {
        if (cleanupMode === 'spawn-error' && command === 'taskkill') killer.emit('error', new Error('spawn'));
        else if (cleanupMode !== 'hang') killer.emit('close', command === 'taskkill' || cleanupMode === 'both-fail' ? 1 : 0);
      });
      return killer;
    }
    child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), send() {}, kill() { commands.push({ command: 'root' }); return true; } });
    return child;
  };
  process.kill = (pid, signal) => {
    if (cleanupMode !== 'ok') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal === 'SIGKILL') queueMicrotask(() => { child.signalCode = signal; child.emit('close', null); });
  };
  syncBuiltinESMExports();
  for (const os of ['linux', 'win32']) for (const mode of os === 'linux' ? ['denied'] : ['nonzero', 'spawn-error', 'both-fail', 'hang']) {
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    for (const outcome of os === 'linux' ? ['cancel', 'deadline', 'timeout', 'success'] : ['cancel', 'deadline', 'timeout']) {
      cleanupMode = mode;
      commands.length = 0;
      const provider = realModelProvider();
      const controller = new AbortController();
      const pending = provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none', signal: controller.signal });
      const observed = pending.then(value => ({ value }), error => ({ error }));
      if (outcome === 'success') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', toolCalls: [], finishReason: 'end_turn', models: ['claude-haiku-4-5-20251001'], thinking: 'off' })));
        finishFixtureCommand(child);
      } else if (outcome === 'timeout') t.mock.timers.tick(300000);
      else controller.abort(outcome === 'deadline' ? new AiError('AI_TIMEOUT') : undefined);
      await new Promise(setImmediate);
      if (mode === 'hang') {
        t.mock.timers.tick(5000);
        await new Promise(setImmediate);
        t.mock.timers.tick(5000);
        await new Promise(setImmediate);
      }
      const { error } = await observed;
      assert.ok(error, os + ':' + mode + ':' + outcome);
      if (outcome === 'cancel' || outcome === 'deadline') assert.equal(error.code, outcome === 'cancel' ? 'AI_CANCELLED' : 'AI_TIMEOUT');
      else assert.match(error.message, outcome === 'timeout' ? /MODEL_COMMAND_TIMEOUT/ : /MODEL_COMMAND_CLEANUP_ERROR/);
      const failedCleanup = os === 'linux' || ['both-fail', 'hang'].includes(mode);
      if (outcome !== 'success') assert.equal(Boolean(error.cause), failedCleanup, 'temizleme hatası asıl sonucu gizlemez');
      if (os === 'win32') {
        assert.equal(commands[0].command, 'taskkill');
        assert.match(commands[1].command, /powershell.exe$/i);
        assert.match(commands[1].args.at(-1), /ParentProcessId/);
        assert.match(commands[1].args.at(-1), /Stop-Process/);
      }
      const count = commands.length;
      child.emit('close', 0); controller.abort(); t.mock.timers.tick(300000);
      assert.equal(commands.length, count, 'geç olay yeniden temizlemez');
      assert.equal(provider.calls.length, 0, 'hata başarılı model yanıtına çevrilmez');
      assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => process.listenerCount(name)), listeners);
      cleanupMode = 'ok';
      const next = provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none' });
      child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', toolCalls: [], finishReason: 'end_turn', models: ['claude-haiku-4-5-20251001'], thinking: 'off' })));
      finishFixtureCommand(child);
      for await (const event of (await next).events) assert.notEqual(event.type, 'error');
    }
  }
});

test('4C son yedi: Windows kapısı sıfır eşleşmeyi ve başarısız testi reddeder', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  const guardPattern = /@'\r?\n([\s\S]*?)\r?\n\s*'@ \| node --input-type=module/;
  const guard = guardPattern.exec(workflow)?.[1];
  assert.ok(guard, 'Windows adımı test sayısını denetleyen komutu çalıştırır');
  assert.equal(guardPattern.exec(workflow.replace(/\r?\n/g, '\r\n'))?.[1].replaceAll('\r\n', '\n'), guard.replaceAll('\r\n', '\n'), 'Windows CRLF aynı kapı komutunu çıkarır');
  assert.ok(guard.includes('Claude|4C kayıtlı dış komut|4C takip nitelendirmesi'));
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-windows-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.test.mjs');
  for (const [name, throws, status] of [[t.name, false, 0], [t.name, true, 1], ['Claude fixture', false, 0], ['unrelated', false, 1], ['Claude fixture', true, 1]]) {
    writeFileSync(fixture, `import test from 'node:test';test(${JSON.stringify(name)},()=>{${throws ? "throw new Error('failure');" : ''}});`);
    const command = guard.replace('test/ai-planner-benchmark.test.mjs', fixture.replaceAll('\\', '/'));
    const run = spawnSync(process.execPath, ['--input-type=module'], { input: command, encoding: 'utf8', env: commandPlatformEnv() });
    assert.equal(run.status, status, run.stdout + run.stderr);
  }
});

test('4C takip nitelendirmesi son yedi: ilk liste tam görünür atama nüfusunu gerektirir', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-followup-population-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'provider.mjs');
  const out = path.join(dir, 'report.jsonl');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    let calls = 0;
    cp.spawn = () => {
      const child = Object.assign(new EventEmitter(), {exitCode: null, signalCode: null, stdin:new PassThrough(),stdout:new PassThrough(),send(){},kill(){}});
      child.stdin.resume();
      child.stdin.on('finish', () => queueMicrotask(() => {
        const filters = process.env.POPULATION_CASE === 'subset' ? {assignee:'me', priority:['critical']} : process.env.POPULATION_CASE === 'extra' ? {} : {assignee:'me'};
        const plan = calls++ === 0 ? {intent:'rota',language:'tr',request:{operation:'list',metrics:['task.title'],population:{tool:'rota_task_search',collection:'tasks'},filters}} : {intent:'abstain',language:'tr',abstain:{reason:'outside_data'}};
        child.stdout.emit('data',Buffer.from(JSON.stringify({text:'',toolCalls:[{name:'rota_plan',arguments:plan}],finishReason:'tool_calls',models:['claude-haiku-4-5-20251001'],thinking:'off'})));
        if (process.platform === 'win32') { child.exitCode = 0; child.emit('close',0); }
        else { child.stdout.emit('end'); child.emit('message',{type:'model-command-complete',code:0}); }
      }));
      return child;
    };
    syncBuiltinESMExports();
  `);
  for (const mode of ['complete', 'subset', 'extra']) {
    rmSync(out, { force: true });
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--test', '--test-isolation=none', '--test-name-pattern=takip zinciri:', 'scripts/planner-followup-qualification.mjs'],
      { encoding: 'utf8', timeout: 15000, env: { ...commandPlatformEnv(), POPULATION_CASE: mode, PLANNER_FOLLOWUP_OUT: out } });
    assert.equal(run.error, undefined, run.stderr);
    assert.ok((await import('node:fs')).existsSync(out), run.stdout + run.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    const openingFailure = report.failed.find(row => row.message === 'Görevlerimi listele.');
    assert.equal(Boolean(openingFailure), mode !== 'complete', `${mode}: ${run.stderr}`);
    assert.equal(report.turns, 5, 'sonraki gönderge kontrolleri de bağımsız çalışır');
  }
});

test('Claude frozen 16: cache age comes from request start, not completion', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_REQUIRE_CACHE: '1' });
  const first = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  cli.release();
  assert.equal((await first.done).text, 'ok');
  const rows = cli.rows();
  rows.find(row => row.usage).durationMs = 6 * 60 * 1000;
  writeFileSync(cli.log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal((await cli.start().done).text, 'ok', 'expired prefix must be allowed to warm again');
  assert.equal((await cli.start().done).error, 'PLANNER_CACHE_NOT_REUSED', 'a genuinely recent request still requires reuse');
});

test('Claude frozen 16: corrupt ledger never authorizes a model reservation', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const cli = await claudeCommandFixture(t, { PLANNER_CLAUDE_MAX_CALLS: '1' });
  cli.release();
  for (const corrupt of ['{broken', 'null', '[]', '42', '{}', '{"reserved":false}', '{"reserved":"true"}', '{"usage":"broken"}']) {
    writeFileSync(cli.log, corrupt + '\n');
    assert.equal((await cli.start().done).error, 'PLANNER_BUDGET_UNVERIFIED');
    assert.equal(cli.count(), 0, 'no model command may launch from partial budget history');
    assert.ok(!readFileSync(cli.log, 'utf8').split('\n').slice(1).filter(Boolean).some(line => JSON.parse(line).reserved));
  }
});

test('Claude frozen 16: final stream event is consumed at EOF', async (t) => {
  const cli = await claudeCommandFixture(t, { newline: false });
  const pending = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  cli.release();
  assert.equal((await pending.done).text, 'ok');
});

test('Claude frozen 16: forced calls originate only from validated final output', async (t) => {
  const attempted = { intent: 'general', language: 'tr' };
  const accepted = { intent: 'abstain', language: 'tr', abstain: { reason: 'security' } };
  for (const structured of [null, accepted]) await t.test(structured ? 'accepted' : 'rejected', async (t) => {
    const cli = await claudeCommandFixture(t, { payload: {
      messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'question' }],
      tools: [{ name: 'rota_plan', parameters: { type: 'object' } }], toolChoice: { name: 'rota_plan' }
    }, events: [
      { type: 'system', subtype: 'init', tools: [] },
      { type: 'assistant', message: { id: 'one', model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', name: 'StructuredOutput', input: attempted }] } },
      { type: 'result', num_turns: 1, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, ...(structured ? { structured_output: structured } : {}) }
    ] });
    const pending = cli.start();
    await cli.waitFor(() => cli.count() === 1);
    cli.release();
    const reply = await pending.done;
    assert.deepEqual(reply.toolCalls, structured ? [{ name: 'rota_plan', arguments: accepted }] : []);
    assert.equal(reply.finishReason, structured ? 'tool_calls' : 'end_turn');
  });
});

test('Claude frozen 16: refusal and pause preserve model misses', async (t) => {
  const { verifyCompletion } = await import('../scripts/planner-evaluation.mjs');
  for (const [stop, expected] of [['refusal', 'content_filter'], ['pause_turn', 'stop'], ['unexpected', 'unexpected']]) {
    await t.test(stop, async (t) => {
      const cli = await claudeCommandFixture(t, { events: [
        { type: 'system', subtype: 'init', tools: [] },
        { type: 'assistant', message: { id: 'one', model: 'claude-haiku-4-5-20251001', content: [] } },
        { type: 'result', num_turns: 1, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 0 } }
      ] });
      const pending = cli.start();
      await cli.waitFor(() => cli.count() === 1);
      cli.release();
      const reply = await pending.done;
      assert.equal(reply.finishReason, expected);
      assert.deepEqual(reply.toolCalls, []);
      if (stop === 'unexpected') assert.throws(() => verifyCompletion(reply.finishReason), /PLANNER_COMPLETION_UNVERIFIED/);
      else {
        assert.doesNotThrow(() => verifyCompletion(reply.finishReason));
        const loaded = loadPlannerBenchmark();
        const outcome = await planCase({ testCase: loaded.cases[0], model: { complete: async () => reply }, adviceFor: unavailable, now: loaded.now, catalog });
        assert.notEqual(outcome.outcome, 'error');
        assert.equal(scoreDecision(loaded.cases[0], recordOf(loaded.cases[0], 1, outcome), { referenceDate: loaded.referenceDate }).correct, false);
      }
    });
  }
});

test('4C frozen 16: adapter diagnostics remain bounded and classified', async (t) => {
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  for (const code of ['PLANNER_BUDGET_TOKENS', 'PLANNER_BUDGET_CALLS', 'PLANNER_BUDGET_UNVERIFIED', 'PLANNER_MODEL_MISMATCH', 'PLANNER_THINKING_ON', 'PLANNER_CACHE_NOT_REUSED', 'PLANNER_LEDGER_LOCKED', 'PLANNER_PROVIDER_ERROR', 'MODEL_COMMAND_TIMEOUT MODEL_COMMAND_CLEANUP_ERROR', 'PRIVATE secret']) {
    const command = '"' + process.execPath + '" -e ' + JSON.stringify('process.stdout.write(JSON.stringify({error:' + JSON.stringify(code) + '}))');
    const model = externalModel({ command, guard: () => {} });
    try {
      const reply = await model.complete({ messages: [], tools: [], toolChoice: 'none' });
      assert.equal(reply.error, code === 'PRIVATE secret' ? 'MODEL_COMMAND_ERROR' : code);
      assert.deepEqual(reply.toolCalls, []);
      assert.equal(reply.text, '');
    } finally { model.dispose(); }
  }
});

test('4C takip nitelendirmesi frozen 16: malformed envelopes never reach the provider', async () => {
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const valid = { text: '', toolCalls: [], finishReason: 'end_turn', models: ['claude-haiku-4-5-20251001'], thinking: 'off' };
  for (const reply of [null, [], { ...valid, toolCalls: undefined }, { ...valid, toolCalls: {} }, { ...valid, toolCalls: [null] }, { ...valid, text: 3 }, { ...valid, models: 'wrong' }, { ...valid, error: {} }]) {
    const provider = realModelProvider({ completeRound: async () => reply });
    await assert.rejects(provider.streamToolCompletion({ model: 'standard', messages: [], tools: [], toolChoice: 'none' }),
      /MODEL_INFRASTRUCTURE ADAPTER_OUTPUT_INVALID/);
    assert.equal(provider.calls.length, 0);
  }
});

test('4C frozen 16: a planned artifact requires a request-bound first read', async () => {
  const { validatePlannerRun } = await import('../scripts/planner-scoring.mjs');
  const loaded = loadPlannerBenchmark();
  const testCase = loaded.cases.find(c => c.expect === 'answer');
  const { record } = await decide(loaded, testCase, answerPlan(testCase, loaded.referenceDate));
  assert.equal(scoreDecision(testCase, record, { referenceDate: loaded.referenceDate }).correct, true);
  const empty = clone(record);
  empty.plan.calls = [];
  assert.equal(scoreDecision(testCase, empty, { referenceDate: loaded.referenceDate }).correct, false);
  const { PLANNER_RUN_FORMAT, PLANNER_RUN_VERSION } = await import('../scripts/planner-scoring.mjs');
  const run = { format: PLANNER_RUN_FORMAT, version: PLANNER_RUN_VERSION, benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint,
    referenceDate: loaded.referenceDate, passes: 1, cases: [testCase.id], records: [record], semantic: { mode: 'none' }, model: { commandHash: '0'.repeat(64) }, qualification: { expectedModel: 'scripted', thinking: 'off' } };
  assert.doesNotThrow(() => validatePlannerRun(run, loaded));
  run.records[0].plan.calls = [];
  assert.throws(() => validatePlannerRun(run, loaded), /PLANNER_RUN_INVALID/);
});


test('Claude frozen 16: standalone timeout owns the model descendant group', async (t) => {
  const cli = await claudeCommandFixture(t, { descendant: true, standalone: true, PLANNER_MODEL_TIMEOUT_MS: '1000' });
  const pending = cli.start();
  await cli.waitFor(() => cli.count() === 1);
  const pid = cli.descendantPid();
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const reply = await pending.done;
  assert.equal(reply.error, 'MODEL_COMMAND_TIMEOUT');
  let running = true;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') running = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1][0] !== 'Z';
  } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; running = false; }
  assert.equal(running, false, 'timeout cannot settle while a model descendant is running');
});

test('Claude frozen 16: completed commands cannot signal a reused process group', async (t) => {
  const { terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const kill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => { signals.push([pid, signal]); };
  t.after(() => { process.kill = kill; });
  for (const terminal of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    await terminateModelCommand({ pid: process.pid, ...terminal });
    assert.deepEqual(signals.filter(([, signal]) => signal !== 0), [], 'the completed child PID is now owned by another live process');
  }
});


test('Claude frozen 16: outer disposal drains the adapter-owned descendant group', async (t) => {
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const cli = await claudeCommandFixture(t, { descendant: true });
  const model = externalModel({ command: cli.command, guard: () => {}, timeoutMs: 8000 });
  t.after(() => model.dispose());
  const pending = model.complete({ messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'question' }], tools: [], toolChoice: 'none' });
  await cli.waitFor(() => cli.count() === 1);
  const pid = cli.descendantPid();
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await model.dispose();
  const reply = await pending;
  assert.equal(reply.error, 'MODEL_COMMAND_ERROR');
  let running = true;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') running = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1][0] !== 'Z';
  } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; running = false; }
  assert.equal(running, false, 'outer cancellation must drain the owned model group');
  await model.dispose();
});

test('Claude frozen 16: the command owner remains alive until cleanup', async (t) => {
  const { spawnModelCommand, terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const { once } = await import('node:events');
  const child = spawnModelCommand(process.execPath, ['-e', 'process.stdout.write("done")'], { env: commandPlatformEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => terminateModelCommand(child));
  child.stdout.resume(); child.stderr.resume();
  const completed = once(child, 'command-close');
  child.stdin.end();
  const [code, launchFailed] = await completed;
  assert.equal(code, 0);
  if (process.platform !== 'win32') {
    assert.equal(launchFailed, false);
    assert.equal(child.exitCode, null, 'the owned group leader cannot be recycled before cleanup');
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    const exited = once(child, 'exit');
    child.disconnect();
    await exited;
    assert.equal(child.signalCode, 'SIGKILL', 'loss of the owning channel must terminate the owned group');
  }
  await terminateModelCommand(child);
});

test('4C frozen 16: external finalization owns cleanup before reentrant completion', async (t) => {
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { externalModel } = await import('../scripts/planner-evaluation.mjs');
  const original = { spawn: cp.spawn, kill: process.kill };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => { cp.spawn = original.spawn; process.kill = original.kill; Object.defineProperty(process, 'platform', platform); syncBuiltinESMExports(); });
  let child;
  let signals = 0;
  cp.spawn = () => (child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), send() {} }));
  process.kill = (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    signals += 1;
    if (signals === 1) { child.signalCode = 'SIGKILL'; child.emit('close', null); }
  };
  syncBuiltinESMExports();
  const model = externalModel({ command: 'fixture', guard: () => {} });
  t.after(() => model.dispose());
  const pending = model.complete({ messages: [], tools: [], toolChoice: 'none' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', toolCalls: [] })));
  finishFixtureCommand(child);
  const reply = await pending;
  assert.equal(reply.text, 'ok');
  assert.equal(reply.error, null);
  assert.equal(signals, 1, 'a reentrant completion cannot start another cleanup');
  child.stdout.emit('data', Buffer.from('stale'));
  child.emit('close', 0);
  await model.dispose();
  assert.equal(signals, 1);
});

test('Claude frozen 16 blocker: recycled group between probe and signal is never killed', async (t) => {
  const { terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const kill = process.kill;
  let recycled = false;
  const unauthorized = [];
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  process.kill = (pid, signal) => {
    if (signal === 0) {
      // The probe observed absence; the caller is then preempted while a new group gets this ID.
      recycled = true;
      throw Object.assign(new Error('previous owner is gone'), { code: 'ESRCH' });
    }
    if (recycled) unauthorized.push([pid, signal]);
  };
  t.after(() => { process.kill = kill; Object.defineProperty(process, 'platform', platform); });
  await terminateModelCommand({ pid: 1234, exitCode: 0, signalCode: null });
  assert.deepEqual(unauthorized, [], 'cleanup must retain ownership atomically through the signal');
});

test('Claude frozen 18: standard Windows npm launcher passes arguments without a shell', async (t) => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t);
  const bin = path.join(cli.dir, 'npm path & literal%');
  const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(pkg, { recursive: true });
  const argv = path.join(cli.dir, 'argv.json');
  const marker = path.join(cli.dir, 'SHELL_EXECUTED');
  writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\necho forbidden > "' + marker + '"\n');
  writeFileSync(path.join(pkg, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(path.join(pkg, 'cli.js'),
    'require("node:fs").writeFileSync(' + JSON.stringify(argv) + ', JSON.stringify(process.argv.slice(2)));\n' +
    readFileSync(cli.model, 'utf8').replace('const root = __dirname;', 'const root = ' + JSON.stringify(cli.dir) + ';'));
  writeFileSync(cli.adapter, 'Object.defineProperty(process,"platform",{value:"win32"});\n' + readFileSync(cli.adapter, 'utf8'));
  const pending = cli.start({ PATH: bin, PLANNER_CLAUDE_LOG: '', SystemRoot: process.env.SystemRoot || await windowsHomeCheckStandIn(cli.dir) }, 'claude');
  await cli.waitFor(() => cli.count() === 1);
  cli.release();
  const reply = await pending.done;
  assert.equal(reply.text, 'ok');
  assert.equal(existsSync(marker), false);
  const args = JSON.parse(readFileSync(argv, 'utf8'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
});

test('4C takip nitelendirmesi frozen 18: hash advice never reaches the real model', async (t) => {
  const { realModelProvider } = await import('../scripts/planner-followup-qualification.mjs');
  const { createAiStack, sendTurn } = await import('./helpers/aiStack.mjs');
  const { AYSE, NOW, rotaToolSeed } = await import('./helpers/aiToolFixtures.mjs');
  const { randomUUID } = await import('node:crypto');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const inputs = [];
  const provider = realModelProvider({ completeRound: async input => {
    inputs.push(input);
    return { text: '', toolCalls: [{ name: 'rota_plan', arguments: { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } } }],
      finishReason: 'tool_calls', models: ['claude-haiku-4-5-20251001'], thinking: 'off' };
  } });
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, provider });
  const response = await sendTurn({ turnId: randomUUID(), message: 'Onun durumu?' });
  assert.equal(response.events.find(event => event.event === 'done').data.assistantMessage.finishReason, 'clarification');
  assert.equal(inputs.length, 1);
  assert.ok(!JSON.stringify(inputs[0].messages).includes('SUNUCU (anlamsal danışmanlık)'));
  assert.ok(provider.semanticCalls.some(call => call.kind === 'embeddings'));
  assert.ok(!provider.semanticCalls.some(call => call.kind === 'rerank'));
  assert.equal(stack.db.aiToolLog?.length || 0, 0);
});

test('4C frozen 16 sibling: a crashed group owner drains its model job before failure', async (t) => {
  const { spawnModelCommand, terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const { once } = await import('node:events');
  const script = 'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.unref();process.stdout.write(JSON.stringify([process.pid,child.pid])+"\\n");setInterval(()=>{},1000);';
  const child = spawnModelCommand(process.execPath, ['-e', script], { env: commandPlatformEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => terminateModelCommand(child));
  child.stderr.resume(); child.stdin.end();
  const [data] = await once(child.stdout, 'data');
  const pids = JSON.parse(String(data));
  t.after(() => pids.forEach(pid => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }));
  if (process.platform === 'win32') {
    await terminateModelCommand(child);
  } else {
    const closed = once(child, 'close');
    process.kill(child.pid, 'SIGKILL');
    await closed;
    await terminateModelCommand(child);
  }
  for (const pid of pids) {
    let running = true;
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') running = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1][0] !== 'Z';
    } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; running = false; }
    assert.equal(running, false, 'unexpected owner loss cannot leave a model job running');
  }
});

test('4C frozen 16 sibling: exited owners wait for cleanup without signaling a recycled group', async (t) => {
  const { terminateModelCommand } = await import('../scripts/planner-claude-model.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const kill = process.kill;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  process.kill = () => assert.fail('an exited owner must never signal a possibly recycled process group');
  t.after(() => { process.kill = kill; Object.defineProperty(process, 'platform', platform); });
  const witness = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: 1, signalCode: null, stdio: [null, null, null, null, witness] });
  let settled = false;
  const cleanup = terminateModelCommand(child).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'failure waits for the surviving group member to finish cleanup');
  witness.destroy();
  await cleanup;
  assert.equal(settled, true);
});

test('4C frozen 16 sibling: follow-up command cleanup preserves inherited stderr', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const moduleUrl = new URL('../scripts/planner-claude-model.mjs', import.meta.url).href;
  const script = `import {spawnModelCommand,terminateModelCommand} from ${JSON.stringify(moduleUrl)};
    import {once} from 'node:events';
    for(let i=0;i<2;i++) {
      const child=spawnModelCommand(process.execPath,['-e','process.stdout.write("ok")'],{env:{...process.env},stdio:['pipe','pipe','inherit']});
      child.stdout.resume(); child.stdin.end();
      await once(child,'command-close'); await terminateModelCommand(child);
      await new Promise((resolve,reject)=>process.stderr.write('diagnostic-'+i+'\\n',error=>error?reject(error):resolve()));
    }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: commandPlatformEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { err += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, err);
  assert.equal(err, 'diagnostic-0\ndiagnostic-1\n');
});

test('Claude frozen 22: Windows CLI uses the isolated profile and required system environment', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t);
  const capture = path.join(cli.dir, 'environment.json');
  writeFileSync(cli.adapter, 'Object.defineProperty(process,"platform",{value:"win32"});\n' + readFileSync(cli.adapter, 'utf8'));
  writeFileSync(cli.model, 'require("node:fs").writeFileSync(' + JSON.stringify(capture) + ',JSON.stringify(process.env));\n' + readFileSync(cli.model, 'utf8'));
  const systemRoot = process.env.SystemRoot || await windowsHomeCheckStandIn(cli.dir);
  const windows = { SystemRoot: systemRoot, windir: process.env.windir || systemRoot,
    ComSpec: process.env.ComSpec || systemRoot + '\\System32\\cmd.exe', PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' };
  const pending = cli.start({ ...windows, PLANNER_CLAUDE_LOG: '', USERPROFILE: path.join(cli.dir, 'operator-profile'),
    APPDATA: path.join(cli.dir, 'operator-data'), CLAUDE_CONFIG_DIR: path.join(cli.dir, 'operator-config') });
  await cli.waitFor(() => cli.count() === 1);
  cli.release();
  assert.equal((await pending.done).text, 'ok');
  const seen = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(seen.USERPROFILE, path.join(cli.dir, 'home'));
  assert.equal(seen.HOME, seen.USERPROFILE);
  const normalized = Object.fromEntries(Object.entries(seen).map(([key, value]) => [key.toLowerCase(), value]));
  for (const [key, value] of Object.entries(windows)) assert.equal(normalized[key.toLowerCase()], value);
  assert.equal(seen.APPDATA, undefined);
  assert.equal(seen.CLAUDE_CONFIG_DIR, undefined);
});

test('4C final convergence: symlinked evaluator and Claude entrypoints execute', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'planner-symlink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'checkout');
  symlinkSync(path.resolve('.'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const evaluator = spawnSync(process.execPath, [path.join(link, 'scripts/planner-evaluation.mjs'), 'input'], { encoding: 'utf8' });
  assert.equal(evaluator.status, 0, evaluator.stderr);
  const input = JSON.parse(evaluator.stdout);
  assert.equal(input.queries.length, 136);
  assert.equal(new Set(input.queries.map(row => row.case)).size, 136);
  const adapter = spawnSync(process.execPath, [path.join(link, 'scripts/planner-claude-model.mjs')], {
    input: JSON.stringify({ messages: [], tools: [], toolChoice: 'none' }), encoding: 'utf8',
    env: { ...commandPlatformEnv(), PLANNER_CLAUDE_LOG: '' }
  });
  assert.equal(adapter.status, 0, adapter.stderr);
  assert.equal(JSON.parse(adapter.stdout).error, 'PLANNER_SYSTEM_MISSING');
});

test('4C takip nitelendirmesi final convergence: symlinked follow-up qualification registers tests and finalizes', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync, mkdtempSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'followup-symlink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'checkout');
  symlinkSync(path.resolve('.'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const report = path.join(dir, 'report.jsonl');
  const ledger = path.join(dir, 'calls.jsonl');
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(link, 'scripts/planner-followup-qualification.mjs')], {
    encoding: 'utf8', env: { ...commandPlatformEnv(), PLANNER_MODEL_TIMEOUT_MS: 'invalid', PLANNER_FOLLOWUP_OUT: report, PLANNER_CLAUDE_LOG: ledger }
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /FOLLOWUP_QUALIFICATION_FAILED/);
  assert.doesNotMatch(child.stdout, /^1\.\.0$/m);
  const summary = JSON.parse(readFileSync(report, 'utf8').trim());
  assert.ok(summary.chains > 0);
  assert.ok(summary.failed.length > 0);
  assert.ok(summary.modelCalls > 0, 'registered chains attempt the model boundary');
  assert.deepEqual(summary.models, []);
  assert.equal(existsSync(ledger), false, 'invalid local budget never launches the adapter');
});

test('Claude final convergence: packaged Windows executable uses the fixed command without a shell', async (t) => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const cli = await claudeCommandFixture(t);
  const bin = path.join(cli.dir, 'npm path & literal%');
  const packaged = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  mkdirSync(path.dirname(packaged), { recursive: true });
  writeFileSync(packaged, 'native executable fixture');
  const marker = path.join(cli.dir, 'SHELL_EXECUTED');
  writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\necho forbidden > "' + marker + '"\n');
  writeFileSync(cli.adapter, `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const original = cp.spawn;
    cp.spawn = (command, args, options) => {
      assert.equal(command, ${JSON.stringify(packaged)});
      assert.ok(!options.shell);
      assert.equal(args[args.indexOf('--effort') + 1], 'low');
      assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
      assert.equal(options.env.MAX_THINKING_TOKENS, '0');
      return original(process.execPath, [${JSON.stringify(cli.model)}, ...args], options);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ` + readFileSync(cli.adapter, 'utf8'));
  cli.release();
  const reply = await cli.start({ PATH: bin, PLANNER_CLAUDE_LOG: '', SystemRoot: process.env.SystemRoot || await windowsHomeCheckStandIn(cli.dir) }, 'claude').done;
  assert.equal(reply.text, 'ok');
  assert.equal(existsSync(marker), false);
});

test('Claude final convergence: a valid result followed by a failed exit never qualifies', async (t) => {
  for (const exit of ['process.exitCode = 7;', "process.stdout.write('', () => process.kill(process.pid, 'SIGTERM'));"]) await t.test(exit, async (t) => {
    const { writeFileSync } = await import('node:fs');
    const cli = await claudeCommandFixture(t);
    writeFileSync(cli.model, readFileSync(cli.model, 'utf8').replace('}, 0);', exit + ' }, 0);'));
    cli.release();
    const reply = await cli.start().done;
    assert.equal(reply.error, 'PLANNER_PROVIDER_ERROR');
    assert.deepEqual(reply.toolCalls, []);
    assert.equal(reply.text, '');
    assert.equal(cli.rows().at(-1).error, 'PLANNER_PROVIDER_ERROR');
    assert.equal(cli.rows().at(-1).usage.input_tokens, 10, 'the valid result event was observed before failure');
    assert.equal(cli.locked(), false);
  });
});

test('Claude posted convergence: only the documented one-turn tool handoff permits exit 1', async (t) => {
  for (const scenario of [
    { code: 1, subtype: 'error_max_turns', tool: true, error: false },
    { code: 1, subtype: 'success', tool: true, error: true },
    { code: 1, subtype: 'error_max_turns', tool: false, error: true },
    { code: 7, subtype: 'error_max_turns', tool: true, error: true }
  ]) await t.test(JSON.stringify(scenario), async (t) => {
    const { writeFileSync } = await import('node:fs');
    const call = { name: 'rota_task_search', arguments: {} };
    const cli = await claudeCommandFixture(t, { payload: {
      messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'question' }],
      tools: [{ name: call.name, parameters: { type: 'object' } }], toolChoice: 'auto'
    }, events: [
      { type: 'system', subtype: 'init', tools: ['mcp__rota__rota_task_search'] },
      { type: 'assistant', message: { id: 'one', model: 'claude-haiku-4-5-20251001', content: scenario.tool
        ? [{ type: 'tool_use', name: 'mcp__rota__rota_task_search', input: {} }] : [{ type: 'text', text: 'not a tool handoff' }] } },
      { type: 'result', is_error: scenario.subtype === 'error_max_turns', subtype: scenario.subtype,
        num_turns: 1, stop_reason: scenario.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
    ] });
    writeFileSync(cli.model, readFileSync(cli.model, 'utf8').replace('}, 0);', `process.exitCode = ${scenario.code}; }, 0);`));
    cli.release();
    const reply = await cli.start().done;
    if (scenario.error) {
      assert.equal(reply.error, 'PLANNER_PROVIDER_ERROR');
      assert.deepEqual(reply.toolCalls, []);
    } else {
      assert.equal(reply.error, undefined);
      assert.deepEqual(reply.toolCalls, [call]);
      assert.equal(reply.finishReason, 'tool_calls');
      assert.equal(reply.thinking, 'off');
    }
    assert.equal(cli.locked(), false);
  });
});

test('4C final convergence: distinct later-part reads score only against their owning request', async () => {
  const { derivedReads, requestBoundCall } = await import('../src/server/ai/tools/requestPopulation.js');
  const { bindRequestEntities } = await import('../src/server/ai/tools/requestDeclaration.js');
  const loaded = loadPlannerBenchmark();
  const testCase = loaded.cases.find(row => row.id === 'tr-060');
  const { record } = await decide(loaded, testCase, answerPlan(testCase, loaded.referenceDate));
  assert.equal(record.plan.requests.length, 2);
  const second = record.plan.requests[1];
  const reads = derivedReads(second, bindRequestEntities(second, []), { today: loaded.referenceDate, attempted: new Set() });
  const later = reads.find(call => !requestBoundCall(record.plan.requests[0], call.name, call.args, { today: loaded.referenceDate }));
  assert.ok(later, 'the second section must require a distinct read');
  record.plan.calls.push({ name: later.name, args: later.args });
  assert.deepEqual(scoreDecision(testCase, record, { referenceDate: loaded.referenceDate }), { correct: true, reasons: [] });
  const wrong = clone(record);
  wrong.plan.calls.at(-1).args = { ...later.args, projectId: '00000000-0000-4000-8000-000000000099' };
  assert.ok(scoreDecision(testCase, wrong, { referenceDate: loaded.referenceDate }).reasons.includes('calls:unrelated'));
  wrong.plan.calls.at(-1).name = 'rota_calendar_inspect';
  assert.ok(scoreDecision(testCase, wrong, { referenceDate: loaded.referenceDate }).reasons.includes('calls:unrelated'));
});
