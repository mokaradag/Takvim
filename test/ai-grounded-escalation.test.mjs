/** Rota AI · muhakeme devri, ortak bütçeler ve içeriksiz boş yanıt tanısı. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { captureConsole, createAiStack, readSse, sendTurn, turnRequest, turnsRoute } from './helpers/aiStack.mjs';
import { AYSE, MEHMET, NOW, PROJECTS, rotaToolSeed, TASKS } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { GROUNDING_FAILURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { snapshotOperations } = await import('../src/server/observability/telemetryRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { aiRuntimeLoad } = await import('../src/server/ai/aiRuntime.js');
const { activeAssistantGenerationCountForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');
const { assistantStreamErrorPayload } = await import('../src/server/ai/assistant/assistantStreamResponse.js');
const { AiError } = await import('../src/server/ai/aiErrors.js');
const { parseChatCompletion } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const { reportedReasoningTokens } = await import('../src/server/ai/providers/openAiCompatibleStream.js');

const STANDARD = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model;
const DEEP = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model;
const INVALID = 'Projede 42 gecikmiş görev var.';
const QUESTION = `Radar Modernizasyonu projesinde kaç görev var? ${PROJECTS.FULL}`;

const fixedClocks = new WeakSet();

function stackFor(t, { env = {} } = {}) {
  if (!fixedClocks.has(t)) {
    fixedClocks.add(t);
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
  }
  const stack = createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', ...env }, seed: rotaToolSeed() });
  t.after(() => assert.equal(stack.provider.pendingCount, 0, 'bütün sağlayıcı yanıtları tüketildi'));
  return stack;
}

const toolResultsOf = (call) => (call.messages || []).filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
const eventsOf = (response, type) => response.events.filter((event) => event.event === type);
const deltas = (response) => eventsOf(response, 'delta').map((event) => event.data.text);
const doneOf = (response) => eventsOf(response, 'done')[0]?.data;
const factAnswer = (onCall = null) => ({ type: 'script', respond: (call) => {
  onCall?.(call);
  return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${toolResultsOf(call)[0].evidenceId}:totalCount`] }) };
} });
const toolQueries = (stack) => (stack.db.aiToolLog || []).filter((entry) => entry.query === 'task-facts').length;
const countFull = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, entities: [{ type: 'project', id: PROJECTS.FULL }] };
const searchFull = { type: 'tool-calls', preface: [declared(countFull)], calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] };
/** Adla çözülen görevin satırdaki durumu: sunucu seçim türetmez, olguyu model seçer (devir bu yolda sınanır). */
const NAMED = 'Radar test planı';
const NAMED_QUESTION = `${NAMED} görevinin durumu nedir?`;
const NAMED_ANSWER = /görevinin durumu \*\*Yapılacak\*\*/;
const statusNamed = { operation: 'value', metrics: ['task.status'], entities: [{ type: 'task', text: NAMED }] };
const searchNamed = { type: 'tool-calls', preface: [declared(statusNamed)], calls: [{ name: 'rota_task_search', arguments: { text: NAMED } }] };
const synthesizeNamed = { ...searchNamed, preface: [declared({ ...statusNamed, reasoning: 'synthesis', population: { tool: 'rota_task_search' } })] };
const statusAnswer = (onCall = null) => ({ type: 'script', respond: (call) => {
  onCall?.(call);
  return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${toolResultsOf(call)[0].evidenceId}:data.tasks.0.status`] }) };
} });
const logLines = (lines, operation) => lines.filter((line) => line.includes(`"operation":"${operation}"`)).map((line) => JSON.parse(line.slice(line.indexOf('{'))));

async function until(predicate, rounds = 2000) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await immediate();
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

test('a declared synthesis request is finalized once by Deep thinking with the same evidence and one visible answer', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  let queriesBeforeDeep = null;
  stack.provider.enqueue(synthesizeNamed, { type: 'answer', text: INVALID }, statusAnswer(() => { queriesBeforeDeep = toolQueries(stack); }));
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.equal(response.status, 200);
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, DEEP, DEEP], JSON.stringify(response.events));
  assert.equal(stack.provider.calls[1].toolChoice, 'none', 'kanıt varken Derin düşünme yalnızca yanıtı yazar');
  // Tek düzeltme bütçesi Standart modelde harcanmaz: aynı sorunu devredilen tur düzeltir.
  assert.doesNotMatch(stack.provider.calls[1].messages[0].content, /SUNUCU DOĞRULAMASI/);
  assert.match(stack.provider.calls[2].messages[0].content, /SUNUCU DOĞRULAMASI/);
  assert.ok(queriesBeforeDeep > 0);
  assert.equal(toolQueries(stack), queriesBeforeDeep, 'araç SQL’i Derin düşünmede yeniden çalışmaz');
  const done = doneOf(response);
  assert.equal(deltas(response).length, 1, 'kullanıcı tek yanıt görür');
  assert.equal(deltas(response)[0], done.assistantMessage.content);
  assert.match(done.assistantMessage.content, NAMED_ANSWER);
  assert.equal(done.assistantMessage.finishReason, 'stop');
  assert.equal(done.assistantMessage.mode, 'standard', 'istenen kip korunur');
  assert.deepEqual(done.assistantMessage.evidence.map((item) => item.id), ['R1']);
  assert.equal(response.text.includes('42 gecikmiş'), false);
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual(grounding.escalations, { total: 1, byReason: { SYNTHESIS_REQUIRED: 1 }, byOutcome: { grounded: 1 } });
  assert.equal(grounding.grounded, 1);
  assert.equal(grounding.failed, 0);
  const [event] = logLines(logs, 'ai.grounded.escalation');
  assert.deepEqual(event.context, { requestedMode: 'standard', models: [STANDARD, DEEP], reason: 'SYNTHESIS_REQUIRED', toolsReused: true, outcome: 'grounded' });
  for (const secret of [NAMED_QUESTION, NAMED, INVALID, 'Radar Modernizasyonu', String(AYSE)]) {
    assert.equal(logs.some((line) => line.includes(secret)), false, `günlük içerik taşımaz: ${secret}`);
  }
});

test('a verified Standard answer keeps the whole turn in Standard and spends no repair', async (t) => {
  const stack = stackFor(t);
  // İstek kanıttaki olguyu belirliyorsa sunucu seçer: ikinci model turu yoktur.
  stack.provider.enqueue(searchFull);
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD]);
  assert.match(doneOf(response).assistantMessage.content, /\*\*8\*\*/);
  // Seçimi model yaptığında da tur Standart kipte kalır.
  stack.provider.enqueue(searchNamed, statusAnswer());
  const named = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.slice(1).map((call) => call.model), [STANDARD, STANDARD]);
  assert.match(doneOf(named).assistantMessage.content, NAMED_ANSWER);
  const { grounding } = aiTelemetrySnapshot();
  assert.equal(grounding.escalations.total, 0);
  assert.equal(grounding.repaired, 0);
  assert.equal(grounding.grounded, 2);
  assert.equal(grounding.serverSelected, 1);
});

test('a Deep escalation that times out ends as a bounded timeout, not as a verification failure', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(synthesizeNamed, { type: 'status', status: 504 });
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, DEEP]);
  const [failure] = eventsOf(response, 'error');
  assert.equal(failure.data.code, 'AI_TIMEOUT');
  assert.equal(failure.data.retryable, true, 'süresi dolan tur kullanıcı tarafından yeniden denenebilir');
  assert.deepEqual(deltas(response), [], 'ne uydurma yanıt ne de doğrulama iletisi gösterilir');
  assert.deepEqual(stack.db.aiConversationMessages.map((row) => row.Role), ['user'], 'süresi dolan tur yazılmaz');
  assert.equal(stack.db.aiMessageEvidence.length, 0);
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual(grounding.escalations, { total: 1, byReason: { SYNTHESIS_REQUIRED: 1 }, byOutcome: { timeout: 1 } });
  assert.equal(grounding.failed, 0, 'sağlayıcı süre aşımı doğrulama hatası sayılmaz');
  assert.equal(logLines(logs, 'ai.grounded.escalation')[0].context.outcome, 'timeout');
});

test('an empty Standard completion is diagnosed without content and retried in-session without Deep escalation', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(
    searchNamed,
    { type: 'answer', text: '', chunks: [], reasoning: 3, usage: { promptTokens: 900, completionTokens: 512, totalTokens: 1412, reasoningTokens: 512 } },
    statusAnswer()
  );
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.match(doneOf(response).assistantMessage.content, NAMED_ANSWER);
  assert.equal(deltas(response).length, 1);
  const snapshot = aiTelemetrySnapshot();
  assert.equal(snapshot.emptyCompletions, 1);
  assert.equal(snapshot.grounding.escalations.total, 0);
  const providerOperation = snapshotOperations().find((entry) => entry.operation === 'ai.provider.stream');
  assert.equal(providerOperation.errorCount, 1);
  assert.equal(providerOperation.topFailureCode, 'AI_PROVIDER_RESPONSE_INVALID');
  const [diagnosis] = logLines(logs, 'ai.provider.empty_completion');
  assert.equal(diagnosis.code, 'AI_EMPTY_COMPLETION');
  assert.equal(diagnosis.context.profile, 'chat.tools');
  assert.equal(diagnosis.context.model, STANDARD);
  assert.equal(diagnosis.context.finishReason, 'stop');
  assert.deepEqual(diagnosis.context.usage, { input: 900, reasoning: 512, completion: 512, visible: 0 });
  assert.equal(diagnosis.context.toolCalls, false);
  assert.equal(diagnosis.context.reasoningReceived, true);
  assert.equal(diagnosis.context.textReceived, false);
  assert.equal(typeof diagnosis.context.firstEventMs, 'number');
  assert.equal(typeof diagnosis.context.providerMs, 'number');
  assert.equal(JSON.stringify(diagnosis).includes(NAMED_QUESTION), false);
});

test('Deep thinking retries one empty completion inside its own session and never loops', async (t) => {
  const recovered = stackFor(t);
  recovered.provider.enqueue(searchNamed, { type: 'answer', text: '', chunks: [] }, statusAnswer());
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'deep' });
  assert.deepEqual(recovered.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.match(doneOf(response).assistantMessage.content, NAMED_ANSWER);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);

  const exhausted = stackFor(t);
  exhausted.provider.enqueue(searchNamed, { type: 'answer', text: '', chunks: [] }, { type: 'answer', text: '', chunks: [] });
  const failed = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'deep' });
  assert.equal(exhausted.provider.calls.length, 3, 'araç turu + boş yanıt + tek yeniden deneme');
  const [error] = eventsOf(failed, 'error');
  assert.equal(error.data.code, 'AI_PROVIDER_RESPONSE_INVALID');
  assert.equal(error.data.reason, 'EMPTY_COMPLETION');
  assert.equal(error.data.retryable, true, 'kaydedilmeyen tur kullanıcı tarafından yeniden denenebilir');
  assert.deepEqual(exhausted.db.aiConversationMessages.map((row) => row.Role), ['user']);
  assert.equal(aiTelemetrySnapshot().emptyCompletions, 2);
});

test('a turn that ends without evidence because of NOT_FOUND, scope or SQL failure is not escalated', async (t) => {
  const reject = { type: 'answer', text: '{"kind":"rota","facts":["R9:totalCount"]}' };
  const cases = [
    { name: 'not found', calls: [{ name: 'rota_outlook_status', arguments: { taskId: TASKS.HIDDEN } }], message: `Gizli görevin Outlook durumu nedir? ${TASKS.HIDDEN}`, code: 'NOT_FOUND',
      request: { operation: 'value', metrics: ['subscriptions.active'], entities: [{ type: 'task', id: TASKS.HIDDEN }] } },
    { name: 'scope', calls: [{ name: 'rota_task_search', arguments: { text: 'Başka bir konu' } }], message: 'Radar görevleri', code: 'UNSUPPORTED_SCOPE',
      request: { operation: 'value', metrics: ['tasks.total'], filters: { text: 'Radar' } } },
    { name: 'sql', calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }], message: QUESTION, code: 'DATABASE_UNAVAILABLE', failing: 'task-facts', request: countFull }
  ];
  for (const item of cases) {
    const stack = stackFor(t);
    if (item.failing) stack.db.aiToolFailure = { [item.failing]: Object.assign(new Error('bağlantı yok'), { code: 'ESOCKET' }) };
    stack.provider.enqueue({ type: 'tool-calls', preface: [declared(item.request)], calls: item.calls }, reject, reject);
    const response = await sendTurn({ turnId: randomUUID(), message: item.message });
    assert.equal(toolResultsOf(stack.provider.calls[1])[0].error.code, item.code, item.name);
    assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD], `${item.name}: Derin düşünmeye devredilmez`);
    assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
    assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  }
});

test('a missing declaration fails within the cheap planning budget without SQL or Deep escalation', async (t) => {
  const stack = stackFor(t);
  const undeclared = { type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] };
  stack.provider.enqueue(undeclared, undeclared, undeclared);
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.equal(toolQueries(stack), 0);
  assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  assert.equal(stack.provider.pendingCount, 0);
});

test('Deep mode and installations without a Deep tool profile keep the single bounded repair', async (t) => {
  const deep = stackFor(t);
  deep.provider.enqueue(searchNamed, { type: 'answer', text: INVALID }, { type: 'answer', text: INVALID });
  const deepResponse = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'deep' });
  assert.equal(deep.provider.calls.length, 3);
  assert.equal(doneOf(deepResponse).assistantMessage.content, GROUNDING_FAILURE_TEXT);

  const directory = await mkdtemp(path.join(tmpdir(), 'rota-ai-escalation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai-models.json');
  await writeFile(file, JSON.stringify({
    ...DEFAULT_AI_MODEL_REGISTRY,
    profiles: { ...DEFAULT_AI_MODEL_REGISTRY.profiles, 'chat.tools.reasoning': { ...DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'], enabled: false } }
  }), 'utf8');
  const standardOnly = stackFor(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  standardOnly.provider.enqueue(searchNamed, { type: 'answer', text: INVALID }, { type: 'answer', text: INVALID });
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(standardOnly.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
});

test('a Deep session that cannot run falls back to the Standard result instead of a second answer', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(synthesizeNamed, { type: 'answer', text: INVALID }, { type: 'status', status: 503 });
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, DEEP, DEEP], JSON.stringify(response.events));
  assert.deepEqual(deltas(response), [GROUNDING_FAILURE_TEXT]);
  assert.equal(doneOf(response).assistantMessage.finishReason, 'grounding_failed');
  assert.deepEqual(aiTelemetrySnapshot().grounding.escalations, { total: 1, byReason: { SYNTHESIS_REQUIRED: 1 }, byOutcome: { error: 1 } });
});

test('an identity change before the Deep finalization ends the turn instead of falling back', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(synthesizeNamed, { type: 'script', respond: () => {
    stack.useSicil(MEHMET);
    return { type: 'answer', text: INVALID };
  } });
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.equal(stack.provider.calls.length, 2, 'kimlik değiştikten sonra ek sağlayıcı çağrısı yapılmaz');
  assert.equal(eventsOf(response, 'error').length, 1);
  assert.deepEqual(deltas(response), [], 'Standart güvenli iletisi de gösterilmez');
  assert.deepEqual(stack.db.aiConversationMessages.map((row) => row.Role), ['user']);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 1);
});

test('cancelling during the Deep finalization writes nothing and does not fall back', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(synthesizeNamed, { type: 'stall' });
  const controller = new AbortController();
  const response = await turnsRoute.POST(turnRequest({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'standard', conversationId: null }, { signal: controller.signal }));
  const reading = readSse(response).catch(() => null);
  await until(() => stack.provider.calls.length === 2 && stack.provider.calls[1].model === DEEP);
  controller.abort();
  await reading;
  await until(() => aiRuntimeLoad().active === 0 && activeAssistantGenerationCountForTests() === 0);
  assert.deepEqual(stack.db.aiConversationMessages.map((row) => row.Role), ['user'], 'ne Derin yanıt ne de Standart güvenli iletisi yazılır');
  assert.equal(stack.db.aiMessageEvidence.length, 0);
  assert.equal(stack.provider.calls.length, 2);
});

test('provider usage keeps reasoning token counts only when reported, and empty completions are retryable for the user', () => {
  assert.equal(reportedReasoningTokens({ completion_tokens_details: { reasoning_tokens: 40 } }), 40);
  assert.equal(reportedReasoningTokens({ reasoning_tokens: 7 }), 7);
  for (const usage of [{}, { completion_tokens_details: { reasoning_tokens: -1 } }, { reasoning_tokens: '7' }, null, []]) {
    assert.equal(reportedReasoningTokens(usage), null);
  }
  const completion = parseChatCompletion({
    model: 'm', choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 6 } }
  });
  assert.deepEqual(completion.usage, { promptTokens: 3, completionTokens: 9, totalTokens: 12, reasoningTokens: 6 });
  const empty = new AiError('AI_PROVIDER_RESPONSE_INVALID', { details: { reason: 'EMPTY_COMPLETION' } });
  assert.equal(assistantStreamErrorPayload(empty).retryable, true);
  assert.equal(assistantStreamErrorPayload(empty, { partial: true }).retryable, false);
  assert.equal(assistantStreamErrorPayload(new AiError('AI_PROVIDER_RESPONSE_INVALID', { details: { reason: 'MISSING_CHOICE' } })).retryable, false);
});

test('a missing declared metric is obtained by bounded Standard repair before tool-disabled escalation', async (t) => {
  const stack = stackFor(t);
  const request = { ...countFull, metrics: ['tasks.total', 'tasks.open'], population: { tool: 'rota_task_analytics' },
    fields: ['total', 'open'].map((metric) => ({ metric: `tasks.${metric}`, tool: 'rota_task_analytics', path: `data.totals.${metric}` })) };
  stack.provider.enqueue(
    { ...searchFull, preface: [declared(request)] }, factAnswer(),
    { type: 'script', respond: (call) => {
      assert.equal(call.model, STANDARD);
      assert.equal(call.toolChoice, 'auto');
      assert.ok(call.tools.some((tool) => tool.name === 'rota_task_analytics'));
      return { type: 'tool-calls', calls: [{ name: 'rota_task_analytics', arguments: { projectId: PROJECTS.FULL } }] };
    } }
  );
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.equal(doneOf(response).assistantMessage.finishReason, 'stop');
  // Düzeltmenin araç turu bildirilen bütün ölçüleri taşır: olguyu sunucu seçer.
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.deepEqual(doneOf(response).assistantMessage.evidence.map((item) => item.id), ['R2']);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
});

test('repair followed by Deep finalization shares its exhausted repair and tool budgets', async (t) => {
  const stack = stackFor(t);
  // Yanıt iki kanıtın olgularını birlikte ister: seçimi model yapar.
  const request = { ...countFull, reasoning: 'synthesis', metrics: ['project.code', 'tasks.open'], population: { tool: 'rota_task_analytics' },
    fields: [{ metric: 'project.code', tool: 'rota_task_search', path: 'data.project.code' }, { metric: 'tasks.open', tool: 'rota_task_analytics', path: 'data.totals.open' }] };
  stack.provider.enqueue({ ...searchFull, preface: [declared(request)] },
    { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.project.code'] }) },
    { type: 'tool-calls', calls: [{ name: 'rota_task_analytics', arguments: { projectId: PROJECTS.FULL } }] },
    { type: 'script', respond: (call) => {
      assert.equal(call.toolChoice, 'none');
      assert.equal(toolResultsOf(call).length, 2);
      return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.project.code', 'R2:data.totals.open'] }) };
    } });
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.equal(doneOf(response).assistantMessage.finishReason, 'stop');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD, DEEP]);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 1);
});

test('unauthorized or unavailable evidence repair fails closed after the shared single repair', async (t) => {
  for (const scenario of ['scope', 'sql']) {
    const stack = stackFor(t);
    const request = { ...countFull, metrics: ['tasks.total', 'tasks.open'], population: { tool: 'rota_task_analytics' },
    fields: ['total', 'open'].map((metric) => ({ metric: `tasks.${metric}`, tool: 'rota_task_analytics', path: `data.totals.${metric}` })) };
    stack.provider.enqueue({ ...searchFull, preface: [declared(request)] }, factAnswer(),
      { type: 'script', respond: () => {
        if (scenario === 'sql') stack.db.aiToolFailure = { 'task-facts': Object.assign(new Error('bağlantı yok'), { code: 'ESOCKET' }) };
        return { type: 'tool-calls', calls: [{ name: 'rota_task_analytics', arguments: { projectId: scenario === 'scope' ? PROJECTS.HIDDEN : PROJECTS.FULL } }] };
      } }, factAnswer());
    const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
    assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
    assert.equal(stack.provider.calls.length, 4);
    assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD, STANDARD]);
    assert.equal(aiTelemetrySnapshot().grounding.repaired, 1);
    assert.equal(toolResultsOf(stack.provider.calls[3]).at(-1).ok, false);
    assert.deepEqual(doneOf(response).assistantMessage.evidence, []);
  }
});
