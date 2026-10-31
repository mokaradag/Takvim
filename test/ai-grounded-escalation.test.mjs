import { nativeDeclaration } from './helpers/evidenceScenario.mjs';
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
import { declared, systemText } from './helpers/evidenceScenario.mjs';

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
const { generateAssistantAnswer, prepareAssistantTurn } = await import('../src/server/ai/assistant/assistantService.js');

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

const toolResultsOf = (call) => (call.messages || []).filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).filter((body) => body.tool !== 'rota_plan');
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
/**
 * Adla çözülen görevin durumu ve projesi: proje adı ve kodu aynı ölçüyü taşır,
 * bu yüzden sunucu seçim türetmez ve olguları model seçer (devir bu yolda sınanır).
 */
const NAMED = 'Radar test planı';
const NAMED_QUESTION = `${NAMED} görevinin durumu ve projesi nedir?`;
const NAMED_ANSWER = /görevinin durumu \*\*Yapılacak\*\*/;
const statusNamed = { operation: 'value', metrics: ['task.status', 'task.project'], reasoning: 'synthesis', fields: [{ metric: 'task.project', tool: 'rota_task_search', path: 'data.tasks.*.project.name' }], entities: [{ type: 'task', text: NAMED }] };
const searchNamed = { type: 'tool-calls', preface: [declared(statusNamed)], calls: [{ name: 'rota_task_search', arguments: { text: NAMED } }] };
const synthesizeNamed = { ...searchNamed, preface: [declared({ ...statusNamed, reasoning: 'synthesis', population: { tool: 'rota_task_search' } })] };
const statusAnswer = (onCall = null) => ({ type: 'script', respond: (call) => {
  onCall?.(call);
  const id = toolResultsOf(call)[0].evidenceId;
  return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${id}:data.tasks.0.status`, `${id}:data.tasks.0.project.name`] }) };
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
  // Devir temiz dökümle yapılır ama bu turun yetkili kanıtını (araç çağrısı ve sonucu) taşır.
  const handedOver = toolResultsOf(stack.provider.calls[1]);
  assert.deepEqual(handedOver.map((result) => [result.ok, result.evidenceId]), [[true, 'R1']]);
  assert.ok(handedOver[0].data.tasks.some((row) => row.title === NAMED), 'Derin düşünme kanıtın değerlerini görür');
  // Tek düzeltme bütçesi Standart modelde harcanmaz: aynı sorunu devredilen tur düzeltir.
  assert.doesNotMatch(systemText(stack.provider.calls[1].messages), /SUNUCU DOĞRULAMASI/);
  assert.match(systemText(stack.provider.calls[2].messages), /SUNUCU DOĞRULAMASI/);
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
  // Devir ayrı bir başarı satırı yazmaz: özeti turun tek tamamlanma kaydındadır.
  assert.deepEqual(logLines(logs, 'ai.grounded.escalation'), []);
  const turnLines = logLines(logs, 'ai.grounded.turn');
  assert.equal(turnLines.length, 1);
  assert.deepEqual(turnLines[0].context.escalation, { requestedMode: 'standard', models: [STANDARD, DEEP], reason: 'SYNTHESIS_REQUIRED', kind: 'select', toolsReused: true, outcome: 'grounded' });
  assert.equal(turnLines[0].context.escalated, true);
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
  stack.provider.enqueue({ ...searchNamed, preface: [declared({ ...statusNamed, reasoning: 'deterministic' })] });
  const named = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.slice(1).map((call) => call.model), [STANDARD]);
  assert.match(doneOf(named).assistantMessage.content, NAMED_ANSWER);
  const { grounding } = aiTelemetrySnapshot();
  assert.equal(grounding.escalations.total, 0);
  assert.equal(grounding.repaired, 0);
  assert.equal(grounding.grounded, 2);
  assert.equal(grounding.serverSelected, 2);
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
  assert.deepEqual(logLines(logs, 'ai.grounded.escalation'), []);
  const [turnLine] = logLines(logs, 'ai.grounded.turn');
  assert.deepEqual([turnLine.context.outcome, turnLine.context.code, turnLine.context.escalation.outcome], ['error', 'AI_TIMEOUT', 'timeout']);
});

for (const cancelled of [false, true]) {
  test(`late Standard escalation keeps the original generation deadline (${cancelled ? 'cancel' : 'timeout'})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    fixedClocks.add(t);
    const stack = stackFor(t, { env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000',
      MERGEN_ROTA_AI_PROVIDER_FIRST_EVENT_TIMEOUT_MS: '100000', MERGEN_ROTA_AI_PROVIDER_IDLE_TIMEOUT_MS: '100000' } });
    const controller = new AbortController();
    stack.provider.enqueue({ type: 'deferred-stream' }, { type: 'deferred-stream' });
    const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'standard' }) });
    t.after(() => turn.claim.release());
    const pending = generateAssistantAnswer(turn, { signal: controller.signal, onText: async () => {} });
    const rejected = assert.rejects(pending, { code: cancelled ? 'AI_CANCELLED' : 'AI_TIMEOUT' });
    await until(() => Boolean(stack.provider.calls[0]?.emit));
    t.mock.timers.tick(44000);
    stack.provider.calls[0].emitPlan({ intent: 'rota', language: 'tr', request: statusNamed,
      calls: [{ name: 'rota_task_search', arguments: { text: NAMED } }] });
    await until(() => Boolean(stack.provider.calls[1]?.emit));
    assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, DEEP]);
    t.mock.timers.tick(1999);
    await immediate();
    assert.equal(stack.provider.calls[1].aborted, false, 'Derin kalan süreyi kullanır');
    if (cancelled) controller.abort();
    else t.mock.timers.tick(1);
    // Eski uygulamada Derin kendi 225 saniyelik bütçesini alırdı.
    assert.equal(stack.provider.calls[1].signal.aborted, true, 'özgün sınır/iptal Derin sağlayıcıya ulaşır');
    await rejected;
    assert.deepEqual(stack.db.aiConversationMessages.map((row) => row.Role), ['user']);
    assert.equal(aiRuntimeLoad().active, 0);
    assert.equal(stack.provider.activeCount, 0);
    const telemetry = aiTelemetrySnapshot().grounding;
    assert.equal(telemetry.failed, 0);
    assert.deepEqual(telemetry.escalations.byOutcome, cancelled ? { error: 1 } : { timeout: 1 });
  });
}

for (const mode of ['standard', 'deep']) {
  test(`${mode === 'standard' ? 'early escalation retains useful Deep time' : 'direct Deep retains its normal budget'} and generation expiry does not time post-generation delivery`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    fixedClocks.add(t);
    const stack = stackFor(t, { env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000',
      MERGEN_ROTA_AI_PROVIDER_FIRST_EVENT_TIMEOUT_MS: '100000', MERGEN_ROTA_AI_PROVIDER_IDLE_TIMEOUT_MS: '100000' } });
    stack.provider.enqueue({ type: 'deferred-stream' });
    if (mode === 'standard') stack.provider.enqueue({ type: 'deferred-stream' });
    const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: NAMED_QUESTION, mode }) });
    t.after(() => turn.claim.release());
    let delivered = null;
    const pending = generateAssistantAnswer(turn, { onText: async () => {}, onDelivery: async (prepare) => {
      assert.equal(aiRuntimeLoad().active, 0, 'kiralar üretim sonunda bırakıldı');
      t.mock.timers.tick(230000);
      delivered = await prepare();
    } });
    await until(() => Boolean(stack.provider.calls[0]?.emit));
    t.mock.timers.tick(mode === 'standard' ? 1000 : 46001);
    stack.provider.calls[0].emitPlan({ intent: 'rota', language: 'tr', request: statusNamed,
      calls: [{ name: 'rota_task_search', arguments: { text: NAMED } }] });
    if (mode === 'standard') {
      await until(() => Boolean(stack.provider.calls[1]?.emit));
      t.mock.timers.tick(14000);
      const id = toolResultsOf(stack.provider.calls[1])[0].evidenceId;
      stack.provider.calls[1].emit(JSON.stringify({ kind: 'rota', facts: [`${id}:data.tasks.0.status`, `${id}:data.tasks.0.project.name`] }));
      stack.provider.calls[1].complete();
    } else {
      // Derin başlangıçtan tek bütçe alır; Standart'ın kısa bütçesine indirgenmez.
      stack.provider.enqueue(statusAnswer());
    }
    const result = await pending;
    assert.equal(result.finishReason, 'stop');
    assert.match(delivered.answer.content, NAMED_ANSWER);
    assert.deepEqual(stack.provider.calls.map((call) => call.model), mode === 'standard' ? [STANDARD, DEEP] : [DEEP, DEEP]);
    assert.equal(aiRuntimeLoad().active, 0);
  });
}

test('a completed grounded generation can persist and revalidate disclosure after its generation deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  fixedClocks.add(t);
  const stack = stackFor(t, { env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000',
    MERGEN_ROTA_AI_PROVIDER_FIRST_EVENT_TIMEOUT_MS: '100000' } });
  stack.provider.enqueue({ type: 'deferred-stream' });
  const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: QUESTION, mode: 'standard' }) });
  t.after(() => turn.claim.release());
  let release;
  let persisting = false;
  stack.db.commitHook = async () => { persisting = true; await new Promise((resolve) => { release = resolve; }); };
  t.after(() => release?.());
  const visible = [];
  const pending = generateAssistantAnswer(turn, { onText: async (text) => { visible.push(text); } });
  await until(() => Boolean(stack.provider.calls[0]?.emit));
  t.mock.timers.tick(45000);
  stack.provider.calls[0].emitPlan({ intent: 'rota', language: 'tr', request: countFull,
    calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] });
  await until(() => persisting);
  assert.equal(aiRuntimeLoad().active, 0);
  t.mock.timers.tick(2000);
  await immediate();
  assert.deepEqual(visible, [], 'kayıt bitmeden kanıt açıklanmaz');
  release();
  const result = await pending;
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(visible, [result.answer.content]);
  assert.match(result.answer.content, /\*\*8\*\*/);
});

test('an empty Standard completion is diagnosed without content and retried in-session without Deep escalation', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(
    { type: 'answer', text: '', chunks: [], reasoning: 3, usage: { promptTokens: 900, completionTokens: 512, totalTokens: 1412, reasoningTokens: 512 } },
    { ...searchNamed, preface: [declared({ ...statusNamed, reasoning: 'deterministic' })] }
  );
  const response = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD]);
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
  assert.deepEqual(recovered.provider.calls.map((call) => call.model), [DEEP, DEEP, DEEP], 'Derin kip bütün tur boyunca Derin profilde kalır');
  assert.match(doneOf(response).assistantMessage.content, NAMED_ANSWER);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);

  const exhausted = stackFor(t);
  exhausted.provider.enqueue(searchNamed, { type: 'answer', text: '', chunks: [] }, { type: 'answer', text: '', chunks: [] });
  const failed = await sendTurn({ turnId: randomUUID(), message: NAMED_QUESTION, mode: 'deep' });
  assert.equal(exhausted.provider.calls.length, 3, 'araç turu + boş yanıt + tek yeniden deneme');
  assert.ok(exhausted.provider.calls.every((call) => call.model === DEEP), 'Derin kip kendine devretmez');
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
    // Kapsam dışı çağrı veri okunmadan reddedilir: Standart tek ucuz düzeltmesini kullanır, devir engellenir.
    { name: 'scope', calls: [{ name: 'rota_task_search', arguments: { text: 'Başka bir konu' } }], message: 'Radar görevleri', code: 'UNSUPPORTED_SCOPE', rounds: 2,
      request: { operation: 'value', metrics: ['tasks.total'], filters: { text: 'Radar' } } },
    { name: 'sql', calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }], message: QUESTION, code: 'DATABASE_UNAVAILABLE', failing: 'task-facts', request: countFull }
  ];
  for (const item of cases) {
    const stack = stackFor(t);
    if (item.failing) stack.db.aiToolFailure = { [item.failing]: Object.assign(new Error('bağlantı yok'), { code: 'ESOCKET' }) };
    stack.provider.enqueue({ type: 'tool-calls', preface: [declared(item.request)], calls: item.calls }, ...Array((item.rounds || 3) - 1).fill(reject));
    const response = await sendTurn({ turnId: randomUUID(), message: item.message });
    assert.equal(toolResultsOf(stack.provider.calls[1])[0].error.code, item.code, item.name);
    assert.deepEqual(stack.provider.calls.map((call) => call.model), Array(item.rounds || 3).fill(STANDARD), `${item.name}: Derin düşünmeye devredilmez`);
    assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
    assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  }
});

const tooLarge = () => Object.assign(new Error('AI_TOOL_RESULT_TOO_LARGE'), { number: 51001 });
const countPlan = { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request: { ...countFull, layout: 'auto' },
  calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] } }] };

test('a failed Rota read does not reopen planning for Deep merely because the ledger is empty', async (t) => {
  const stack = stackFor(t);
  stack.db.aiToolFailure = { 'task-facts': tooLarge() };
  stack.provider.enqueue(countPlan, { type: 'answer', text: INVALID }, { type: 'answer', text: INVALID });
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, STANDARD]);
  assert.equal(doneOf(response).assistantMessage.finishReason, 'grounding_failed');
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
});

test('without evidence and with the shared tool budget spent, the turn is not escalated to a Deep round that could not read data', async (t) => {
  const stack = stackFor(t);
  stack.db.aiToolFailure = { 'task-facts': tooLarge() };
  stack.provider.enqueue(countPlan, countPlan, countPlan, countPlan, { type: 'answer', text: INVALID }, { type: 'answer', text: INVALID });
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.ok(stack.provider.calls.every((call) => call.model === STANDARD), JSON.stringify(stack.provider.calls.map((call) => call.model)));
  assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
});

test('a missing declaration exhausts the single Standard repair without SQL, then restarts once on Deep, which has its own single repair', async (t) => {
  const stack = stackFor(t);
  const undeclared = { type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] };
  stack.provider.enqueue(undeclared, undeclared, undeclared, undeclared);
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  // Standart: tek ucuz bildirim düzeltmesi; Derin: temiz başlangıç ve kendi tek düzeltmesi. Tur hiçbir koşulda tekrar Standart'a dönmez.
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, STANDARD, DEEP, DEEP]);
  assert.equal(toolQueries(stack), 0, 'geçerli istek olmadan hiçbir kipte SQL çalışmaz');
  assert.equal(doneOf(response).assistantMessage.content, GROUNDING_FAILURE_TEXT);
  assert.deepEqual(aiTelemetrySnapshot().grounding.escalations, { total: 1, byReason: { REQUEST_DECLARATION: 1 }, byOutcome: { failed: 1 } });
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

test('a declared population the plan did not read is read by the server before any repair or escalation', async (t) => {
  const stack = stackFor(t);
  const request = { ...countFull, metrics: ['tasks.total', 'tasks.open'], population: { tool: 'rota_task_analytics' },
    fields: ['total', 'open'].map((metric) => ({ metric: `tasks.${metric}`, tool: 'rota_task_analytics', path: `data.totals.${metric}` })) };
  stack.provider.enqueue({ type: 'answer', text: declared(request) });
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.equal(doneOf(response).assistantMessage.finishReason, 'stop');
  // Planın çağrısı bildirilen nüfusu okumadı: sunucu nüfus okumasını bildirimden kurar ve olguyu seçer; düzeltme ya da devir yoktur.
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD]);
  assert.deepEqual(doneOf(response).assistantMessage.evidence.map((item) => item.id), ['R1']);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
});

test('a synthesis request whose population the server completed is finalized once by Deep with tools closed', async (t) => {
  const stack = stackFor(t);
  // Yanıt iki kanıtın olgularını birlikte ister: seçimi model yapar.
  const request = { ...countFull, reasoning: 'synthesis', metrics: ['project.code', 'tasks.open'], population: { tool: 'rota_task_analytics' },
    fields: [{ metric: 'project.code', tool: 'rota_task_search', path: 'data.project.code' }, { metric: 'tasks.open', tool: 'rota_task_analytics', path: 'data.totals.open' }] };
  stack.provider.enqueue({ ...searchFull, preface: [declared(request)] },
    { type: 'script', respond: (call) => {
      // Sunucunun tamamladığı kanıtla Derin düşünme yalnızca yanıtı yazar: araçlar kapalı, iki kanıt görünür.
      assert.equal(call.toolChoice, 'none');
      assert.equal(toolResultsOf(call).length, 2);
      return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.project.code', 'R2:data.totals.open'] }) };
    } });
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.equal(doneOf(response).assistantMessage.finishReason, 'stop');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD, DEEP]);
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 1);
});

test('an unauthorized or unavailable population read fails closed without escalation', async (t) => {
  for (const scenario of ['scope', 'sql']) {
    const stack = stackFor(t);
    // Kullanıcının yazdığı ama göremediği proje; ya da nüfus okuması sırasında SQL kesintisi.
    const projectId = scenario === 'scope' ? PROJECTS.HIDDEN : PROJECTS.FULL;
    const request = { operation: 'value', metrics: ['tasks.total', 'tasks.open'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', id: projectId }],
      fields: ['total', 'open'].map((metric) => ({ metric: `tasks.${metric}`, tool: 'rota_task_analytics', path: `data.totals.${metric}` })) };
    if (scenario === 'sql') stack.db.aiToolFailure = { 'task-facts': Object.assign(new Error('bağlantı yok'), { code: 'ESOCKET' }) };
    stack.provider.enqueue({ type: 'answer', text: declared(request) }, { type: 'answer', text: INVALID }, { type: 'answer', text: INVALID });
    const response = await sendTurn({ turnId: randomUUID(), message: `Projede kaç görev var? ${projectId}` });
    const answer = doneOf(response).assistantMessage;
    assert.ok(answer.content === GROUNDING_FAILURE_TEXT || answer.finishReason === 'unavailable', `${scenario}: ${answer.content}`);
    assert.deepEqual(answer.evidence, []);
    assert.equal(answer.content.includes('42'), false);
    assert.ok(stack.provider.calls.every((call) => call.model === STANDARD), `${scenario}: Derin düşünmeye devredilmez`);
    assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  }
});

test('each provider session, including the Deep hand-off, is a generation progress point before its first round', async (t) => {
  stackFor(t);
  const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
  const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
  const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
  let progress = 0;
  const seen = [];
  const session = (rounds) => ({ signal: new AbortController().signal, remainingMs: () => 60000, round: async (input) => {
    seen.push(progress);
    return rounds.shift()(input);
  } });
  const plan = () => (nativeDeclaration({ text: declared(statusNamed), toolCalls: [{ id: 'call', name: 'rota_task_search', arguments: JSON.stringify({ text: NAMED }) }] }));
  const options = { messages: buildGroundedContext({ userContent: NAMED_QUESTION, now: NOW }).messages, catalog: toolCatalogForModel(),
    context: createToolTurnContext({ sicil: AYSE, now: NOW }), onProgress: () => { progress += 1; }, onText: async () => {} };
  const standard = await runGroundedTurn(session([plan]), { ...options, escalation: true });
  assert.equal(standard.outcome, 'escalate');
  assert.equal(seen[0], 1, 'Standart oturumun kurulması ilk sağlayıcı turundan önce ilerlemedir');
  const before = progress;
  const deep = await runGroundedTurn(session([(input) => {
    const id = toolResultsOf(input)[0].evidenceId;
    return { text: JSON.stringify({ kind: 'rota', facts: [`${id}:data.tasks.0.status`, `${id}:data.tasks.0.project.name`] }), toolCalls: [], finishReason: 'stop' };
  }]), { ...options, resume: standard.resume });
  assert.equal(seen[1], before + 1, 'Derin devri kendi kurulumundan sonra yeni ilerlemeyle başlar; Standart turun ilerlemesini tüketmez');
  assert.equal(deep.outcome, 'grounded');
});
