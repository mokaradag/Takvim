/**
 * Rota AI · kip yönlendirmesi, zayıf model protokolü ve tur izi.
 *
 * Kullanıcının seçtiği kip modele bağlı kısmı belirler: Standart `chat.tools`,
 * Derin düşünme `chat.tools.reasoning` ile planlar; Derin kip Standart profile
 * gereksinim duymaz ve kendine devretmez. Planı yerel çağrı yerine metin
 * olarak (yönlendirme zarfı, kod çiti, `<tool_call>` zarfı) ya da planla
 * birlikte doğrudan araç çağrısıyla veren model aynı doğrulamadan geçer; geçerli
 * plan olmadan SQL çalışmaz ve kurtarma sınırlıdır. Kayıt hatası da turun tek
 * son izini bırakır; yetki yalnızca arada model ya da araç işi olduysa yeniden okunur.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assistantReadiness, captureConsole, createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, callRotaTool, LEAD, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { GROUNDING_FAILURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');

const STANDARD = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model;
const DEEP = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model;
const OVERDUE_QUESTION = 'Kaç gecikmiş görevim var ve hangileri?';
const OVERDUE_MINE = { deadline: 'overdue', assignee: 'me' };
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' },
  layout: 'auto', filters: OVERDUE_MINE };
const ONGOING_MINE = { status: ['in_progress'], assignee: 'me' };
const ONGOING_COUNT = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, layout: 'auto', filters: ONGOING_MINE };
const TOP_OVERDUE = { operation: 'rank', metrics: ['task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 3 },
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: OVERDUE_MINE };

const plan = (request, calls) => ({ intent: 'rota', language: 'tr', request, calls });
const nativePlan = (request = OVERDUE_LIST, calls = [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) => ({
  type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan(request, calls) }]
});
const doneOf = (response) => response.events.find((event) => event.event === 'done')?.data;
const deltas = (response) => response.events.filter((event) => event.event === 'delta').map((event) => event.data.text);
const turnTraces = (lines) => lines.filter((line) => line.includes('"operation":"ai.grounded.turn"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))).context);
const sqlCalls = (stack) => (stack.db.aiToolLog || []).length;
const visibilityReads = (stack) => (stack.db.aiToolLog || []).filter((entry) => entry.query === 'task-visibility').length;
const drained = (stack) => assert.equal(stack.provider.pendingCount, 0, 'bütün betikli yanıtlar tüketildi');

const fixedClocks = new WeakSet();

function stackFor(t, { sicil = AYSE, env = {} } = {}) {
  if (!fixedClocks.has(t)) {
    fixedClocks.add(t);
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
  }
  return createAiStack(t, { sicil, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', ...env }, seed: rotaToolSeed() });
}

async function registryWithout(t, profile) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-ai-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai-models.json');
  await writeFile(file, JSON.stringify({ ...DEFAULT_AI_MODEL_REGISTRY,
    profiles: { ...DEFAULT_AI_MODEL_REGISTRY.profiles, [profile]: { ...DEFAULT_AI_MODEL_REGISTRY.profiles[profile], enabled: false } } }), 'utf8');
  return file;
}

/* ── Kip yönlendirmesi ───────────────────────────────────── */

test('Deep thinking answers Rota data through its own tool profile even when the Standard tool profile is not installed', async (t) => {
  const stack = stackFor(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: await registryWithout(t, 'chat.tools') } });
  const logs = captureConsole(t);
  const readiness = await assistantReadiness();
  assert.deepEqual(readiness.body.assistant.rotaData.modes, [{ id: 'standard', available: false }, { id: 'deep', available: true }]);
  stack.provider.enqueue(nativePlan());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION, mode: 'deep' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.equal(answer.mode, 'deep');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [DEEP]);
  assert.deepEqual(turnTraces(logs)[0].rounds.map((round) => [round.purpose, round.profile, round.model]), [['plan', 'chat.tools.reasoning', DEEP]]);
  // Standart kipte araç profili yoksa veri sorusu model çağırmadan güvenli olarak kullanılamaz.
  const standard = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION, mode: 'standard' })).assistantMessage;
  assert.equal(standard.finishReason, 'unavailable');
  assert.equal(stack.provider.calls.length, 1);
  drained(stack);
});

test('Deep thinking never escalates to itself: protocol failures stay in one bounded Deep session without SQL', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const undeclared = { type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: OVERDUE_MINE }] };
  stack.provider.enqueue(undeclared, undeclared, undeclared);
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION, mode: 'deep' })).assistantMessage;
  assert.equal(answer.content, GROUNDING_FAILURE_TEXT);
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [DEEP, DEEP, DEEP]);
  assert.equal(sqlCalls(stack), 0);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.escalated, trace.modelRounds, trace.toolCalls], [false, 3, 0]);
  assert.ok(trace.rounds.every((round) => round.profile === 'chat.tools.reasoning'));
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  drained(stack);
});

test('a Standard turn that succeeds never invokes the Deep profile', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(nativePlan(ONGOING_COUNT, [{ name: 'rota_task_search', arguments: ONGOING_MINE }]));
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD]);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.outcome, trace.selectedBy, trace.escalated, trace.modelRounds, trace.toolRounds], ['grounded', 'server', false, 1, 1]);
  drained(stack);
});

/* ── Zayıf modelin plan biçimleri ────────────────────────── */

const textPlans = {
  'a route declaration carrying the calls as assistant text': JSON.stringify({ kind: 'route', ...plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) }),
  'the plan object inside one code fence': `\`\`\`json\n${JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]))}\n\`\`\``,
  'a rota_plan call leaked as <tool_call> text': `<tool_call>\n${JSON.stringify({ name: 'rota_plan', arguments: plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) })}\n</tool_call>`
};

for (const [name, text] of Object.entries(textPlans)) {
  test(`${name} is validated like the native plan and answered in one Standard round`, async (t) => {
    const stack = stackFor(t);
    const logs = captureConsole(t);
    stack.provider.enqueue({ type: 'answer', text });
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
    assert.equal(answer.finishReason, 'stop');
    assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
    assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD]);
    const [trace] = turnTraces(logs);
    assert.deepEqual([trace.outcome, trace.selectedBy, trace.modelRounds, trace.toolCalls, trace.declarations, trace.repairs, trace.escalated],
      ['grounded', 'server', 1, 1, 1, 0, false]);
    drained(stack);
  });
}

test('a plan with only the typed request may carry its read calls natively in the same response', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request: OVERDUE_LIST } },
    { name: 'rota_task_search', arguments: OVERDUE_MINE }] });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.equal(stack.provider.calls.length, 1);
  assert.equal(stack.provider.calls[0].tools[0].name, 'rota_plan', 'plan aracı salt okunur araçlarla birlikte sunulur');
  assert.ok(stack.provider.calls[0].tools.some((tool) => tool.name === 'rota_task_search'));
  // Aynı çağrı plan içinde ve doğrudan yinelenirse SQL bir kez çalışır.
  const repeated = stackFor(t);
  repeated.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) },
    { name: 'rota_task_search', arguments: { assignee: 'me', deadline: 'overdue' } }] });
  const logs = captureConsole(t);
  doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION }));
  assert.equal(turnTraces(logs)[0].toolCalls, 1);
  drained(stack);
  drained(repeated);
});

test('an invalid legacy declaration gets a schema-derived repair hint, runs no SQL, and a valid text plan then succeeds', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  let sqlAtRepair = null;
  stack.provider.enqueue(
    { type: 'answer', text: declared({ ...ONGOING_COUNT, filters: { status: 'in_progress', assignee: 'me' } }) },
    { type: 'script', respond: (call) => {
      sqlAtRepair = sqlCalls(stack);
      assert.match(call.messages[0].content, /Bildirim sorunları: \$\.filters\.status:type/);
      assert.match(call.messages[0].content, /Beklenen biçim: filters\.status: string dizisi todo\|in_progress\|done/);
      return { type: 'answer', text: JSON.stringify({ kind: 'route', ...plan(ONGOING_COUNT, [{ name: 'rota_task_search', arguments: ONGOING_MINE }]) }) };
    } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.notEqual(answer.content, GROUNDING_FAILURE_TEXT);
  assert.equal(sqlAtRepair, 0, 'geçersiz bildirimle SQL çalışmaz');
  const [trace] = turnTraces(logs);
  assert.deepEqual(trace.rounds.map((round) => [round.purpose, round.profile]), [['plan', 'chat.tools'], ['declaration', 'chat.tools']]);
  assert.deepEqual([trace.outcome, trace.escalated, trace.toolCalls], ['grounded', false, 1]);
  drained(stack);
});

test('text that only names a read tool or an unknown tool never executes; cheap recovery is bounded before one Deep fallback', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  let sqlBeforeDeep = null;
  // Standart bütçe: bir yanıt düzeltmesi ve iki bildirim düzeltmesi; sonra tek Derin devri.
  stack.provider.enqueue(
    { type: 'answer', text: JSON.stringify({ name: 'rota_task_search', arguments: OVERDUE_MINE }) },
    { type: 'answer', text: JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_sql_query', arguments: { sql: 'SELECT 1' } }])) },
    { type: 'answer', text: JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: { deadline: 'late' } }])) },
    { type: 'answer', text: JSON.stringify({ intent: 'rota', language: 'tr', calls: [{ name: 'rota_task_search', arguments: OVERDUE_MINE }] }) },
    { type: 'script', respond: () => { sqlBeforeDeep = sqlCalls(stack); return nativePlan(); } }
  );
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.equal(sqlBeforeDeep, 0);
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD, STANDARD, DEEP]);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.escalated, trace.toolCalls], [true, 1]);
  drained(stack);
});

/* ── Sayım, liste ve sıralama: sıfır ve sıfır olmayan ───── */

for (const sicil of [AYSE, LEAD]) {
  test(`count, list and rank answers match the authorized evidence for ${sicil === AYSE ? 'a user with' : 'a user without'} matching tasks`, async (t) => {
    const stack = stackFor(t, { sicil });
    const ongoing = (await callRotaTool(stack, sicil, 'rota_task_search', ONGOING_MINE)).result.totalCount;
    const overdue = (await callRotaTool(stack, sicil, 'rota_task_search', { ...OVERDUE_MINE, sort: 'overdue_days_desc' })).result;
    stack.provider.enqueue(
      nativePlan(ONGOING_COUNT, [{ name: 'rota_task_search', arguments: ONGOING_MINE }]),
      nativePlan(),
      nativePlan(TOP_OVERDUE, [{ name: 'rota_task_search', arguments: { ...OVERDUE_MINE, sort: 'overdue_days_desc' } }])
    );
    const count = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
    const list = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
    const rank = doneOf(await sendTurn({ turnId: randomUUID(), message: 'En gecikmiş 3 görevim hangileri?' })).assistantMessage;
    for (const answer of [count, list, rank]) assert.equal(answer.finishReason, 'stop', answer.content);
    assert.match(count.content, new RegExp(`\\*\\*${ongoing}\\*\\*`));
    assert.match(list.content, new RegExp(`^Eşleşen \\*\\*${overdue.totalCount}\\*\\* görev bulundu`));
    assert.equal(list.content.split('\n').filter((line) => line.startsWith('- ')).length, overdue.totalCount);
    const ranked = overdue.data.tasks.slice(0, 3).map((row) => row.title);
    for (const title of ranked) assert.ok(rank.content.includes(title), `sıralamada ${title}`);
    assert.equal(rank.content.split('\n').filter((line) => line.startsWith('- ') || /^\d+\. /.test(line)).length, ranked.length);
    assert.equal(stack.provider.calls.length, 3, 'her soru tek model turu');
    if (sicil === LEAD) assert.equal(overdue.totalCount, 0);
    else assert.ok(overdue.totalCount >= 3);
    drained(stack);
  });
}

/* ── Son tur izi ─────────────────────────────────────────── */

test('a persistence failure still records exactly one terminal turn trace with the error outcome', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.db.aiConversationHooks = { beforeAppend() { stack.db.aiEvidenceSchemaMissing = true; } };
  stack.provider.enqueue(nativePlan());
  const response = await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION });
  assert.equal(response.events.find((event) => event.event === 'error')?.data.code, 'AI_CONFIGURATION_ERROR');
  assert.deepEqual(deltas(response), [], 'kaydedilemeyen yanıt gösterilmez');
  const traces = turnTraces(logs);
  assert.equal(traces.length, 1);
  assert.deepEqual([traces[0].outcome, traces[0].code, traces[0].modelRounds, traces[0].toolCalls], ['error', 'AI_CONFIGURATION_ERROR', 1, 1]);
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual([grounding.grounded, grounding.failed, grounding.serverSelected], [0, 0, 0], 'teslim edilmeyen yanıt sayılmaz');
  drained(stack);
});

test('deferred completion is idempotent: a later error cannot add a second trace or answer count', async (t) => {
  stackFor(t);
  const logs = captureConsole(t);
  const session = { profile: 'chat.tools', model: STANDARD, signal: new AbortController().signal, round: async () => ({
    text: '', toolCalls: [{ id: 'p1', name: 'rota_plan', arguments: JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }])) }], finishReason: 'tool_calls'
  }) };
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: OVERDUE_QUESTION, now: NOW }).messages,
    catalog: toolCatalogForModel(), context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, deferDisclosure: true });
  assert.equal(result.outcome, 'grounded');
  assert.equal(turnTraces(logs).length, 0, 'açıklama tamamlanana kadar iz yazılmaz');
  result.completeDisclosure('grounded');
  result.completeDisclosure('error', 'AI_INTERNAL_ERROR');
  assert.deepEqual(turnTraces(logs).map((trace) => trace.outcome), ['grounded']);
  assert.equal(aiTelemetrySnapshot().grounding.grounded, 1);
});

test('a general redirect keeps its own outcome although it is stored as a clarification', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue({ type: 'answer', text: '{"kind":"route","intent":"general","language":"tr"}' },
    { type: 'answer', text: JSON.stringify({ kind: 'general', text: 'Genel bir açıklama.' }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Proje yönetimi nedir?' })).assistantMessage;
  assert.equal(answer.finishReason, 'clarification');
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual([grounding.general_redirect, grounding.clarification], [1, 0]);
  assert.deepEqual(turnTraces(logs).map((trace) => trace.outcome), ['general_redirect']);
  drained(stack);
});

/* ── Yetkinin yeniden okunması ───────────────────────────── */

const titleAndProject = { operation: 'value', metrics: ['task.title', 'task.project'], entities: [{ type: 'task', id: TASKS.OVERDUE }],
  population: { tool: 'rota_task_detail' }, layout: 'auto' };
const detailPlan = () => nativePlan(titleAndProject, [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }]);
const selectTitleAndProject = { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.task.title', 'R1:data.task.project.name'] }) };

test('authorization is read once between a tool round and the next model round, and again after the model round', async (t) => {
  const stack = stackFor(t);
  const reads = [];
  stack.provider.enqueue(detailPlan(), { type: 'script', respond: () => { reads.push(visibilityReads(stack)); return selectTitleAndProject; } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${TASKS.OVERDUE}` })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(reads, [1], 'sunucu seçimi denemesinden sonra aynı yetki ikinci kez okunmaz');
  // Model turundan sonra son doğrulama ve kayıttan sonraki açıklama yetkiyi yeniden okur.
  assert.equal(visibilityReads(stack), 3);
  drained(stack);
});

test('access revoked during the model selection round is caught by the post-round revalidation before any data delta', async (t) => {
  const stack = stackFor(t);
  const task = stack.db.tasks.find((row) => row.TaskId === TASKS.OVERDUE);
  stack.provider.enqueue(detailPlan(), { type: 'script', respond: () => {
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => row.TaskId !== TASKS.OVERDUE);
    task.ProjectId = PROJECTS.HIDDEN;
    return selectTitleAndProject;
  } });
  const response = await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${TASKS.OVERDUE}` });
  const answer = doneOf(response).assistantMessage;
  assert.equal(answer.finishReason, 'unavailable');
  assert.deepEqual(answer.evidence, []);
  assert.equal(deltas(response).some((text) => text.includes(task.Title)), false);
  assert.deepEqual(stack.db.aiMessageEvidence, []);
  drained(stack);
});

/* ── Kayıtlı zayıf model yanıtları ───────────────────────── */

// Bir canlı zayıf modelin "Kaç devam eden görevim var?" için verdiği ilk plan: analiz aracında olmayan bir koleksiyon.
const recordedAnalyticsPlan = { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr',
  request: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics', collection: 'tasks' }, layout: 'auto', filters: ONGOING_MINE },
  calls: [{ name: 'rota_task_analytics', arguments: ONGOING_MINE }] } }, { name: 'rota_task_analytics', arguments: ONGOING_MINE }] };

test('a recorded weak-model plan with a wrong collection is repaired from registry hints before any SQL and then answered', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const expected = (await callRotaTool(stack, AYSE, 'rota_task_analytics', ONGOING_MINE)).result.data.totals.inProgress;
  const queriesBefore = sqlCalls(stack);
  let sqlAtRepair = null;
  stack.provider.enqueue(recordedAnalyticsPlan,
    { type: 'script', respond: (call) => {
      sqlAtRepair = sqlCalls(stack) - queriesBefore;
      assert.match(call.messages[0].content, /population\.collection \(rota_task_analytics\): overdueAging\.buckets\|groups; value isteğinde gerekmez/);
      const fixed = structuredClone(recordedAnalyticsPlan);
      delete fixed.calls[0].arguments.request.population.collection;
      return fixed;
    } },
    { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.totals.inProgress'] }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(sqlAtRepair, 0);
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, new RegExp(`\\*\\*${expected}\\*\\* devam eden görev`));
  const [trace] = turnTraces(logs);
  assert.deepEqual(trace.rounds.map((round) => round.purpose), ['plan', 'declaration', 'select']);
  assert.deepEqual([trace.toolCalls, trace.escalated], [1, false], 'plan içindeki ve doğrudan yinelenen çağrı bir kez çalışır');
  drained(stack);
});

test('a declared aggregate that the population tool cannot carry is refused before SQL; the model patches its own refused plan', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const expected = (await callRotaTool(stack, AYSE, 'rota_task_analytics', ONGOING_MINE)).result.data.totals.inProgress;
  const queriesBefore = sqlCalls(stack);
  let sqlAtRepair = null;
  // Kayıtlı zayıf model yanıtları: önce taşınamayan ölçü (layout da yok), sonra yalnızca nüfus aracı düzeltilmiş plan.
  stack.provider.enqueue(
    { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr',
      request: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_search' }, filters: ONGOING_MINE } } },
    { name: 'rota_task_search', arguments: { ...ONGOING_MINE, limit: 1 } }] },
    { type: 'script', respond: (call) => {
      sqlAtRepair = sqlCalls(stack) - queriesBefore;
      assert.match(call.messages[0].content, /Bildirim sorunları: \$\.metrics\[0\]:population/);
      const [refusedCall, ...refusals] = call.messages.slice(-3);
      assert.deepEqual(refusedCall.toolCalls.map((item) => item.name), ['rota_plan', 'rota_task_search'], 'model reddedilen kendi planını görür');
      const [plan, sibling] = refusals.map((message) => JSON.parse(message.content));
      assert.deepEqual(plan.error.details, ['$.metrics[0]:population']);
      assert.match(plan.error.hints[0], /^tasks\.inProgress: rota_task_search taşımaz; taşıyan araçlar rota_task_analytics\|/);
      assert.deepEqual(sibling.error.details, ['$.plan:invalid']);
      return { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr',
        request: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics' }, filters: ONGOING_MINE } } },
      { name: 'rota_task_analytics', arguments: ONGOING_MINE }] };
    } },
    { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.totals.inProgress'] }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(sqlAtRepair, 0, 'doğrulanamayacak istek için SQL çalışmaz');
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, new RegExp(`\\*\\*${expected}\\*\\* devam eden görev bulunuyor \\(ölçüt: Durum: Devam ediyor; Sorumlu: Ben\\)`));
  const [trace] = turnTraces(logs);
  assert.deepEqual(trace.rounds.map((round) => round.purpose), ['plan', 'declaration', 'select']);
  assert.deepEqual([trace.toolCalls, trace.escalated], [1, false]);
  drained(stack);
});

test('a count read through a paged search is answered by the server from its exact total, but a paged list is never server-selected', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const expected = (await callRotaTool(stack, AYSE, 'rota_task_search', ONGOING_MINE)).result.totalCount;
  stack.provider.enqueue(nativePlan(ONGOING_COUNT, [{ name: 'rota_task_search', arguments: { ...ONGOING_MINE, limit: 1 } }]),
    nativePlan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: { ...OVERDUE_MINE, limit: 1 } }]),
    { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'] }) });
  const count = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.match(count.content, new RegExp(`\\*\\*${expected}\\*\\*`));
  await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION });
  const [countTrace, listTrace] = turnTraces(logs);
  assert.deepEqual([countTrace.selectedBy, countTrace.modelRounds], ['server', 1]);
  assert.notEqual(listTrace.selectedBy, 'server', 'tek sayfalık satırlar bütün listeyi kanıtlamaz');
  assert.equal(listTrace.rounds[1].purpose, 'select');
});
