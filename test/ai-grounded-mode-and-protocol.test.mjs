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
import { assistantReadiness, captureConsole, createAiStack, listAssistantConversations, sendTurn } from './helpers/aiStack.mjs';
import { startFakeOpenAiCompatibleServer } from './helpers/fakeOpenAiCompatibleServer.mjs';
import { AYSE, callRotaTool, LEAD, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { GROUNDING_FAILURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { generateAssistantAnswer, prepareAssistantTurn } = await import('../src/server/ai/assistant/assistantService.js');
const { AiError } = await import('../src/server/ai/aiErrors.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const { aiRuntimeLoad } = await import('../src/server/ai/aiRuntime.js');
const { activeAssistantGenerationCountForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');

const STANDARD = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model;
const DEEP = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model;
const OVERDUE_QUESTION = 'Kaç gecikmiş görevim var ve hangileri?';
const OVERDUE_MINE = { deadline: 'overdue', assignee: 'me' };
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' },
  layout: 'auto', filters: OVERDUE_MINE };
const ONGOING_MINE = { status: ['in_progress'], assignee: 'me' };
const MINE = { assignee: 'me' };
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

/* ── Yürütme kümesinin atomik ön denetimi ─────────────────── */

const directSibling = (name, args, extra = {}) => ({ name, arguments: args, ...extra });
const invalidExecutionSets = {
  'a malformed direct sibling': [directSibling('rota_task_search', { deadline: 'late' })],
  'an unknown direct sibling': [directSibling('rota_sql_query', { sql: 'SELECT 1' })],
  'an oversize direct sibling': [directSibling('rota_task_search', { text: 'x'.repeat(9 * 1024) })],
  'an out-of-scope direct sibling (identity the user never gave)': [directSibling('rota_task_detail', { taskId: TASKS.OVERDUE })],
  'more distinct calls than one round allows': [1, 2, 3, 4, 5].map((limit) => directSibling('rota_task_search', { ...OVERDUE_MINE, limit }))
};

test('one invalid member of the execution set rejects the whole set before any SQL; the next valid plan answers', async (t) => {
  for (const [name, siblings] of Object.entries(invalidExecutionSets)) {
    await t.test(name, async (st) => {
      const stack = stackFor(st);
      let sqlAtRepair = null;
      let refusal = null;
      stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) }, ...siblings] },
        { type: 'script', respond: (call) => {
          sqlAtRepair = sqlCalls(stack);
          refusal = call.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
          return nativePlan();
        } });
      const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
      assert.equal(sqlAtRepair, 0, 'geçersiz kümenin geçerli çağrısı da çalışmaz');
      assert.ok(refusal.length > 0 && refusal.every((result) => result.ok === false), 'kümenin her çağrısı reddedilmiş görünür');
      assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
      drained(stack);
    });
  }
});

test('duplicate provider call IDs and plan/direct duplicates are executed once each under server-assigned unique IDs', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const reads = [['rota_task_search', OVERDUE_MINE], ['rota_task_analytics', {}], ['rota_workload_summary', {}]];
  let transcript = null;
  // Üç planlı çağrı ve aynı üç çağrı doğrudan: sınır (5) ayıklanmış kümeye uygulanır.
  stack.provider.enqueue({ type: 'tool-calls', calls: [
    { id: 'id_0', name: 'rota_plan', arguments: plan({ ...OVERDUE_LIST, reasoning: 'synthesis' }, reads.map(([name, args]) => ({ name, arguments: args }))) },
    ...reads.map(([name, args]) => ({ id: 'id_0', name, arguments: Object.fromEntries(Object.entries(args).reverse()) }))
  ] }, { type: 'script', respond: (call) => {
    transcript = call.messages;
    return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'] }) };
  } });
  await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION });
  const [trace] = turnTraces(logs);
  assert.equal(trace.toolCalls, 3);
  const ids = transcript.flatMap((message) => message.toolCalls || []).map((call) => call.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length, 'döküm kimlikleri benzersizdir');
  assert.ok(ids.every((id) => id !== 'id_0'), 'kimlikleri sunucu verir');
  assert.deepEqual(transcript.filter((item) => item.role === 'tool').map((message) => message.toolCallId), ids);
  drained(stack);
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

/* ── Donan tur: canlı tutma ilerleme değildir ───────────── */

const FROZEN_QUESTION = 'Takılan soru: kaç gecikmiş görevim var ve hangileri?';
const sseEvent = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
/** Gerçek OpenAI uyumlu akışta yerel plan çağrısı: rol, araç çağrısı parçası, bitiş, [DONE]. */
const planStream = (model) => [
  sseEvent({ model, choices: [{ index: 0, delta: { role: 'assistant' } }] }),
  sseEvent({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
    function: { name: 'rota_plan', arguments: JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }])) } }] } }] }),
  sseEvent({ model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n'
];
// Yalnızca SSE yorum satırı gönderen, hiç anlamlı olay üretmeyen sağlayıcı (takılan sunucu).
const keepaliveOnly = Array.from({ length: 2000 }, () => ': keepalive\n\n');

async function settled(predicate, limitMs = 5000) {
  for (const started = Date.now(); !predicate(); ) {
    if (Date.now() - started > limitMs) assert.fail('beklenen durum oluşmadı');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a frozen Rota turn ends at the provider progress bound and releases everything; the same conversation, a new conversation and another user continue', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const server = await startFakeOpenAiCompatibleServer();
  t.after(() => server.close());
  const stack = createAiStack(t, { sicil: AYSE, provider: createOpenAiCompatibleProvider(), seed: rotaToolSeed(), env: {
    MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_BASE_URL: server.baseUrl, MERGEN_ROTA_AI_PROVIDER_FIRST_EVENT_TIMEOUT_MS: '1500'
  } });
  const frozen = (body) => JSON.stringify(body?.messages || []).includes('Takılan soru');
  server.setScenario({ stream: { gapMs: 5, chunks: (body) => (frozen(body) ? keepaliveOnly : planStream(body?.model)) } });
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));

  // 1) Kabul edilen tur sağlayıcıda takılır; sağlayıcı yalnızca canlı tutma gönderir.
  let frozenDone = false;
  const frozenTurnId = randomUUID();
  const frozenTurn = sendTurn({ turnId: frozenTurnId, message: FROZEN_QUESTION }).finally(() => { frozenDone = true; });
  await settled(() => server.state.requests.some((request) => frozen(request.body)));
  // 2) Başka kullanıcı aynı anda yanıt alır: takılan tur küresel bir kilit tutmaz.
  stack.useSicil(LEAD);
  const other = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
  assert.equal(other.finishReason, 'stop');
  assert.equal(frozenDone, false, 'diğer kullanıcının turu takılan turu beklemedi');
  stack.useSicil(AYSE);
  // 3) İlerleme sınırı dolar: tek hata olayı, sağlayıcı bağlantısı kesilir, kapasite ve üretim hakkı bırakılır.
  const stalled = await frozenTurn;
  const accepted = stalled.events.find((event) => event.event === 'accepted').data;
  const error = stalled.events.at(-1);
  assert.deepEqual([error.event, error.data.code, error.data.reason], ['error', 'AI_TIMEOUT', 'PROVIDER_STALLED']);
  assert.equal(stalled.events.filter((event) => ['done', 'error'].includes(event.event)).length, 1);
  await server.waitForClosedStreams(1);
  await settled(() => aiRuntimeLoad().active === 0 && activeAssistantGenerationCountForTests() === 0);
  // 4) Sağlayıcı düzelince aynı tur yeniden denenir; ardından aynı konuşmada yeni soru ve yeni konuşma yanıt alır.
  server.setScenario({ stream: { chunks: (body) => planStream(body?.model) } });
  const retry = doneOf(await sendTurn({ turnId: frozenTurnId, conversationId: accepted.conversation.id, message: FROZEN_QUESTION })).assistantMessage;
  assert.match(retry.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  const next = doneOf(await sendTurn({ turnId: randomUUID(), conversationId: accepted.conversation.id, message: OVERDUE_QUESTION })).assistantMessage;
  assert.equal(next.finishReason, 'stop');
  const fresh = await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION });
  assert.notEqual(fresh.events[0].data.conversation.id, accepted.conversation.id);
  assert.equal(doneOf(fresh).assistantMessage.finishReason, 'stop');
  // 5) İlgisiz uçlar sağlıklı kalır.
  assert.equal((await listAssistantConversations()).status, 200);
  assert.deepEqual([aiRuntimeLoad().active, activeAssistantGenerationCountForTests()], [0, 0]);
});

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

test('an answer whose text cannot be delivered is traced as an error, never as a delivered answer', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(nativePlan());
  const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: OVERDUE_QUESTION, mode: 'standard', conversationId: null }) });
  t.after(() => turn.claim?.release());
  // Yazılan yanıtın metni akışa giremez (teslim hatası); üretim sinyali kesilmemiştir.
  await assert.rejects(generateAssistantAnswer(turn, { onText: async () => { throw new AiError('AI_CANCELLED'); } }), { code: 'AI_CANCELLED' });
  assert.deepEqual(turnTraces(logs).map((trace) => [trace.outcome, trace.code]), [['error', 'AI_CANCELLED']]);
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual([grounding.grounded, grounding.serverSelected], [0, 0], 'teslim edilmeyen yanıt sayılmaz');
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

test('a tool whose SQL never returns (and ignores cancellation) is cut at the tool-phase bound; the turn ends instead of waiting', async (t) => {
  const stack = stackFor(t);
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));
  let release;
  stack.db.queryBarrier = { match: (sql) => sql.startsWith('/* rota-ai-tool:task-facts */'), entered: 0, released: new Promise((resolve) => { release = resolve; }) };
  t.after(() => release());
  const rounds = [];
  const session = { profile: 'chat.tools', model: STANDARD, signal: new AbortController().signal, remainingMs: () => 60000, round: async ({ messages }) => {
    rounds.push(messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)));
    return rounds.length === 1
      ? { text: '', toolCalls: [{ id: 'p1', name: 'rota_plan', arguments: JSON.stringify(plan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: OVERDUE_MINE }])) }], finishReason: 'tool_calls' }
      : { text: JSON.stringify({ kind: 'rota', facts: ['R1:totalCount'] }), toolCalls: [], finishReason: 'stop' };
  } };
  const startedAt = performance.now();
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: OVERDUE_QUESTION, now: NOW }).messages,
    catalog: toolCatalogForModel(), context: createToolTurnContext({ sicil: AYSE, now: NOW }), limits: { ...TOOL_LIMITS, maxToolPhaseMs: 300 }, onText: async () => {} });
  assert.ok(performance.now() - startedAt < 5000, 'tur takılan SQL\'i beklemedi');
  assert.equal(stack.db.queryBarrier.entered, 1);
  assert.equal(rounds[1]?.[0]?.error?.code, 'TIMEOUT', 'model aracın süre aşımını görür');
  assert.notEqual(result.outcome, 'grounded');
  assert.equal(result.evidence?.length ?? 0, 0);
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

test('evidence whose access is removed before a follow-up tool round never reaches another provider round', async (t) => {
  const stack = stackFor(t);
  const task = stack.db.tasks.find((row) => row.TaskId === TASKS.OVERDUE);
  stack.provider.enqueue(detailPlan(), { type: 'script', respond: () => {
    // Model eldeki kanıta ek bir izleme okuması isterken erişim kaldırılır.
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => row.TaskId !== TASKS.OVERDUE);
    task.ProjectId = PROJECTS.HIDDEN;
    return { type: 'tool-calls', calls: [{ name: 'rota_task_analytics', arguments: {} }] };
  } });
  const response = await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${TASKS.OVERDUE}` });
  const answer = doneOf(response).assistantMessage;
  assert.equal(stack.provider.calls.length, 2, 'geçersizleşen kanıtı taşıyan döküm yeniden gönderilmez');
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
    } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(sqlAtRepair, 0);
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, new RegExp(`\\*\\*${expected}\\*\\* devam eden görev`));
  const [trace] = turnTraces(logs);
  // Değer isteğinde grup satırı toplamı belirsizleştirmez: düzeltilen planın toplamını sunucu seçer.
  assert.deepEqual([trace.selectedBy, ...trace.rounds.map((round) => round.purpose)], ['server', 'plan', 'declaration']);
  assert.deepEqual([trace.toolCalls, trace.escalated], [1, false], 'plan içindeki ve doğrudan yinelenen çağrı bir kez çalışır');
  drained(stack);
});

test('a declared aggregate that the population tool cannot carry is refused before SQL; the model patches its own refused plan', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const expected = (await callRotaTool(stack, AYSE, 'rota_task_analytics', MINE)).result.data.totals.inProgress;
  const queriesBefore = sqlCalls(stack);
  let sqlAtRepair = null;
  // Kayıtlı zayıf model yanıtları: önce taşınamayan ölçü (layout da yok), sonra yalnızca nüfus aracı düzeltilmiş plan.
  stack.provider.enqueue(
    // Durum koşulu bildirilmediği için devam eden sayı görev aramasının toplamı değildir (kırılım kimliği uygulanmaz).
    { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr',
      request: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_search' }, filters: MINE } } },
    { name: 'rota_task_search', arguments: { ...MINE, limit: 1 } }] },
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
        request: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics' }, filters: MINE } } },
      { name: 'rota_task_analytics', arguments: MINE }] };
    } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.equal(sqlAtRepair, 0, 'doğrulanamayacak istek için SQL çalışmaz');
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, new RegExp(`\\*\\*${expected}\\*\\* devam eden görev bulunuyor \\(ölçüt: Sorumlu: Ben\\)`));
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.selectedBy, ...trace.rounds.map((round) => round.purpose)], ['server', 'plan', 'declaration']);
  assert.deepEqual([trace.toolCalls, trace.escalated], [1, false]);
  drained(stack);
});

test('a repair cannot narrow the question: dropping a record the user named is refused before SQL; the full plan answers both parts', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const open = (await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL })).result.data.totals.open;
  const total = (await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.READ })).result.data.totals.total;
  const queriesBefore = sqlCalls(stack);
  const projects = [{ type: 'project', text: 'Radar Modernizasyonu' }, { type: 'project', text: 'Okuma Projesi' }];
  const planOnly = (request) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request } }] });
  const refusalOf = (call) => JSON.parse(call.messages.at(-1).content).error;
  let narrowed = null;
  // Kayıtlı zayıf model yanıtları: ret ipuçlarına soruyu daraltarak (ikinci projeyi ve ölçüsünü atarak) "uyar".
  stack.provider.enqueue(
    planOnly({ operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_project_search', collection: 'matches' }, entities: projects }),
    { type: 'script', respond: (call) => {
      assert.ok(refusalOf(call).details.includes('$.bindings:required'));
      return planOnly({ operation: 'value', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics' }, entities: [projects[0]],
        bindings: [{ metric: 'tasks.open', entity: 0 }] });
    } },
    { type: 'script', respond: (call) => {
      narrowed = { sql: sqlCalls(stack) - queriesBefore, error: refusalOf(call) };
      return planOnly({ operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_task_analytics' }, entities: projects,
        bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.total', entity: 1 }] });
    } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(),
    message: 'Radar Modernizasyonu projesindeki açık görev sayısını ve Okuma Projesi\'ndeki toplam görev sayısını ayrı ayrı söyle.' })).assistantMessage;
  assert.equal(narrowed.sql, 0, 'daraltılmış bildirim için SQL çalışmaz');
  assert.deepEqual(narrowed.error.details, ['$.entities:dropped']);
  assert.match(narrowed.error.hints[0], /"Okuma Projesi" bildirimden düşürülemez/);
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, new RegExp(`Radar Modernizasyonu[^\\n]*\\*\\*${open}\\*\\*`));
  assert.match(answer.content, new RegExp(`Okuma Projesi[^\\n]*\\*\\*${total}\\*\\*`));
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.selectedBy, trace.escalated, trace.declarations], ['server', false, 3]);
  drained(stack);
});

test('a count read through a paged search is answered from its exact total; a paged list is completed by one server read of the declared population', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const expected = (await callRotaTool(stack, AYSE, 'rota_task_search', ONGOING_MINE)).result.totalCount;
  stack.provider.enqueue(nativePlan(ONGOING_COUNT, [{ name: 'rota_task_search', arguments: { ...ONGOING_MINE, limit: 1 } }]),
    nativePlan(OVERDUE_LIST, [{ name: 'rota_task_search', arguments: { ...OVERDUE_MINE, limit: 1 } }]));
  const count = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Kaç devam eden görevim var?' })).assistantMessage;
  assert.match(count.content, new RegExp(`\\*\\*${expected}\\*\\*`));
  const list = doneOf(await sendTurn({ turnId: randomUUID(), message: OVERDUE_QUESTION })).assistantMessage;
  assert.match(list.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  const [countTrace, listTrace] = turnTraces(logs);
  assert.deepEqual([countTrace.selectedBy, countTrace.modelRounds, countTrace.toolCalls], ['server', 1, 1]);
  // Tek sayfalık satırlar bütün listeyi kanıtlamaz: sunucu bildirilen nüfusu bir kez tam okur ve satırları kendisi seçer.
  assert.deepEqual([listTrace.selectedBy, listTrace.modelRounds, listTrace.toolCalls], ['server', 1, 2]);
  drained(stack);
});
