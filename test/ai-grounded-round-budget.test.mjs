/**
 * Rota AI · model turu bütçesi ve sunucu seçimi.
 *
 * Bildirilen istek kanıttaki olguları tek anlamlı belirliyorsa yanıtı sunucu
 * seçer: "Kaç gecikmiş görevim var ve hangileri?" Standart ve Derin kipte tek
 * model turuyla biter; seçim, düzeltme ya da devir turu yoktur. Hızlı yol
 * doğrulamayı, güncel yetki yoklamasını ve kapsam notunu atlamaz; birden çok
 * doğrulanan seçimde model yoluna döner. Sınamalar duvar saatini değil, model
 * turlarını, araç çağrılarını ve içeriksiz tur izini ölçer.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { captureConsole, createAiStack, DEFAULT_KEY, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, callRotaTool, LEAD, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';
import { verifyRequested } from './helpers/requestScenario.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { groundedSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { SCOPE_DISCLOSURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');

const PLANNING_PROFILE = 'chat.tools';
// Seçilen kipin araç profili planlar: Derin düşünme Standart modele indirgenmez.
const MODE_PROFILES = { standard: 'chat.tools', deep: 'chat.tools.reasoning' };
const { rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const QUESTION = 'Kaç gecikmiş görevim var ve hangileri?';
// İstemdeki örnek bildirim ve araç çağrısı: model bunu izler, sunucu tek turda yanıtlar.
const example = groundedSystemPrompt(new Date(NOW)).match(/örn\. (\{.*\}) ve rota_task_search (\{.*?\})\./);
const OVERDUE_LIST = JSON.parse(example[1]);
const OVERDUE_MINE = JSON.parse(example[2]);

const doneOf = (response) => response.events.find((event) => event.event === 'done')?.data;
const searchOverdue = (preface = [declared(OVERDUE_LIST)], args = OVERDUE_MINE) => ({ type: 'tool-calls', preface, calls: [{ name: 'rota_task_search', arguments: args }] });
const nativePlan = (request = OVERDUE_LIST, calls = [{ name: 'rota_task_search', arguments: OVERDUE_MINE }]) => ({
  type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request, calls } }]
});
const drained = (provider) => assert.equal(provider.pendingCount, 0, 'bütün betikli yanıtlar tüketildi');
const turnTraces = (lines) => lines.filter((line) => line.includes('"operation":"ai.grounded.turn"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
const visibilityReads = (stack) => stack.db.aiToolLog.filter((entry) => entry.query === 'task-visibility').length;
const issue = (verdict) => verdict.issues[0]?.code ?? null;

function stackFor(t, sicil = AYSE) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });
}

for (const mode of ['standard', 'deep']) {
  test(`"${QUESTION}" ends in one ${mode} model round: the server selects the declared facts and keeps every check`, async (t) => {
    const stack = stackFor(t);
    const logs = captureConsole(t);
    const profile = DEFAULT_AI_MODEL_REGISTRY.profiles[MODE_PROFILES[mode]];
    stack.provider.enqueue(nativePlan());
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION, mode })).assistantMessage;
    assert.deepEqual(stack.provider.calls.map((call) => [call.model, call.maxOutputTokens]), [[profile.model, profile.maxOutputTokens]],
      'tek model turu; seçim, düzeltme ya da devir turu yok');
    assert.equal(answer.finishReason, 'stop');
    assert.equal(answer.mode, mode);
    assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu \(ölçüt: Termin: Gecikmiş; Sorumlu: Ben\)\. 【R1】/);
    assert.equal(answer.content.split('\n').filter((line) => /^- \*\*.+\*\* — Termin: \*\*.+\*\* 【R1】$/.test(line)).length, 3);
    assert.ok(answer.content.endsWith(`\n\n${SCOPE_DISCLOSURE_TEXT}`), 'kısmi kapsam notu sunucu seçiminde de eklenir');
    assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
    assert.equal(stack.db.aiMessageEvidence.length, 1);
    assert.equal(visibilityReads(stack), 2, 'güncel görünürlük çizimden önce ve kayıttan sonra yeniden okunur');

    const [trace] = turnTraces(logs);
    const { rounds, ...counters } = trace.context;
    assert.deepEqual(Object.keys(counters).sort(), ['code', 'declarations', 'escalated', 'evidence', 'modelRounds', 'outcome', 'parts', 'presentation', 'repairs',
      'resultBytes', 'revalidationMs', 'scopeLoads', 'selectedBy', 'sqlMs', 'sqlQueries', 'toolCalls', 'toolFailures', 'toolRounds', 'usage', 'verificationMs']);
    assert.deepEqual({ parts: counters.parts, evidence: counters.evidence, presentation: counters.presentation }, { parts: 1, evidence: 1, presentation: null });
    assert.deepEqual(Object.keys(counters.usage).sort(), ['completion', 'firstEventMs', 'input', 'lengthStops', 'reasoning']);
    assert.equal(counters.usage.lengthStops, 0);
    assert.deepEqual({ outcome: counters.outcome, selectedBy: counters.selectedBy, escalated: counters.escalated, modelRounds: counters.modelRounds,
      toolRounds: counters.toolRounds, toolCalls: counters.toolCalls, declarations: counters.declarations, repairs: counters.repairs },
    { outcome: 'grounded', selectedBy: 'server', escalated: false, modelRounds: 1, toolRounds: 1, toolCalls: 1, declarations: 1, repairs: 0 });
    assert.deepEqual(rounds.map(({ purpose, profile: name, model, budget, finish, calls }) => ({ purpose, name, model, budget, finish, calls })),
      [{ purpose: 'plan', name: MODE_PROFILES[mode], model: profile.model, budget: profile.maxOutputTokens, finish: 'tool_calls', calls: 1 }]);
    assert.equal(stack.provider.calls[0].tools[0].name, 'rota_plan');
    assert.deepEqual(stack.provider.calls[0].tools.slice(1).map((tool) => tool.name).sort(), rotaToolNames().sort());
    assert.ok(stack.provider.calls[0].tools[0].parameters.properties.request.required.includes('population'));
    assert.ok(stack.provider.calls[0].tools[0].parameters.properties.request.required.includes('layout'));
    assert.equal(stack.provider.calls[0].emitted.some((event) => event.type === 'text'), false, 'yerel çağrı asistan metni olmadan çalışır');
    drained(stack.provider);
    // İz yalnızca sayaç, süre ve profil adı taşır: soru, kayıt, kimlik ya da anahtar yazılmaz.
    const line = logs.find((text) => text.includes('"operation":"ai.grounded.turn"'));
    for (const secret of [QUESTION, 'Radar test planı', 'Haftalık durum toplantısı', 'Kısmi kendi görevim', String(AYSE), DEFAULT_KEY, '【R1】', 'overdue']) {
      assert.equal(line.includes(secret), false, `tur izi içerik taşımaz: ${secret}`);
    }
    const { grounding } = aiTelemetrySnapshot();
    assert.equal(grounding.serverSelected, 1);
    assert.equal(grounding.repaired, 0);
    assert.equal(grounding.escalations.total, 0);
  });
}

test('a declaration without calls is read by the server; a missing declaration costs one extra model round, never a selection round', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  // Ayrı (çağrısız) bildirim: nüfus okumasını sunucu bildirimden kurar; ek model turu yoktur.
  stack.provider.enqueue({ type: 'answer', text: declared(OVERDUE_LIST) });
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage.finishReason, 'stop');
  // Bildirimsiz çağrı çalışmaz; düzeltmeden sonra çağrı bildirimle yinelenir.
  stack.provider.enqueue(searchOverdue([]), searchOverdue());
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 3);
  assert.deepEqual(turnTraces(logs).map(({ context }) => [context.selectedBy, context.toolCalls, context.rounds.map((round) => round.purpose)]),
    [['server', 1, ['plan']], ['server', 1, ['tools', 'declaration']]]);
  assert.deepEqual(turnTraces(logs).map(({ context }) => context.declarations), [1, 2]);
  assert.ok(stack.provider.calls.every((call) => call.model === DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model));
  drained(stack.provider);
});

test('an empty overdue population is answered from its complete first page in one model round', async (t) => {
  const stack = stackFor(t, LEAD);
  stack.provider.enqueue(searchOverdue());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(stack.provider.calls.length, 1);
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /^Eşleşen \*\*0\*\* görev bulundu/);
  assert.equal(answer.content.includes('\n- '), false, 'boş nüfusta satır yazılmaz');
  drained(stack.provider);
});

test('an empty population satisfies the listed row field only through its declared, complete count', async (t) => {
  const stack = stackFor(t, LEAD);
  const { ledger, result } = await callRotaTool(stack, LEAD, 'rota_task_search', OVERDUE_MINE);
  assert.deepEqual([result.totalCount, result.data.tasks.length, result.complete, result.truncated], [0, 0, true, false]);
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], OVERDUE_LIST)), null);
  assert.equal(issue(verifyRequested(ledger, ['R1:complete'], OVERDUE_LIST)), 'METRIC_MISSING', 'sayım olgusu olmadan boşluk iddia edilemez');
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], { ...OVERDUE_LIST, metrics: ['tasks.total'] })), 'LIST_ROWS_REQUIRED',
    'satır alanı bildirilmeyen liste yine satır ister');
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], { ...OVERDUE_LIST, filters: { assignee: 'me' } })), 'POPULATION_MISMATCH');
  // Boş olmayan nüfusta sayım satırların yerine geçmez.
  const overdue = { deadline: 'overdue' };
  const filled = await callRotaTool(stack, LEAD, 'rota_task_search', overdue);
  assert.ok(filled.result.data.tasks.length > 0);
  assert.equal(issue(verifyRequested(filled.ledger, ['R1:totalCount'], { ...OVERDUE_LIST, filters: overdue })), 'METRIC_MISSING');
  assert.equal(issue(verifyRequested(filled.ledger, ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'], { ...OVERDUE_LIST, filters: overdue })), null);
});

test('a newer complete snapshot supersedes duplicate older rows without another model round', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue({ type: 'tool-calls', preface: [declared(OVERDUE_LIST)], calls: [{ name: 'rota_task_search', arguments: OVERDUE_MINE },
    { name: 'rota_task_search', arguments: { ...OVERDUE_MINE, limit: 25 } }] });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(stack.provider.calls.length, 1);
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R2']);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.selectedBy, trace.context.rounds.map((round) => round.purpose)], ['server', ['plan']]);
  assert.equal(aiTelemetrySnapshot().grounding.serverSelected, 1);
  drained(stack.provider);
});

for (const mode of ['standard', 'deep']) {
  test(`a simple ongoing count is planned once by the ${mode} tool profile and answered by the server`, async (t) => {
    const stack = stackFor(t);
    const logs = captureConsole(t);
    stack.db.tasks.find((task) => task.TaskId === TASKS.OVERDUE).Status = 'in-progress';
    const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, layout: 'auto',
      filters: { status: ['in_progress'], assignee: 'me' } };
    stack.provider.enqueue(nativePlan(request, [{ name: 'rota_task_search', arguments: request.filters }]));
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Benim kaç tane devam eden görevim var?', mode })).assistantMessage;
    assert.equal(answer.finishReason, 'stop');
    assert.equal(answer.mode, mode);
    assert.match(answer.content, /\*\*1\*\*/);
    assert.equal(stack.provider.calls.length, 1);
    assert.equal(stack.provider.calls[0].model, DEFAULT_AI_MODEL_REGISTRY.profiles[MODE_PROFILES[mode]].model);
    const [trace] = turnTraces(logs);
    assert.deepEqual([trace.context.selectedBy, trace.context.escalated, trace.context.toolCalls], ['server', false, 1]);
    assert.deepEqual(trace.context.rounds.map((round) => round.profile), [MODE_PROFILES[mode]]);
    drained(stack.provider);
  });
}

test('repeated native data calls without a request never execute SQL; one Deep fallback recovers with a valid plan', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  let sqlBeforeDeep = null;
  stack.provider.enqueue(searchOverdue([]), searchOverdue([]), searchOverdue([]),
    { type: 'script', respond: () => { sqlBeforeDeep = (stack.db.aiToolLog || []).length; return nativePlan(); } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.equal(sqlBeforeDeep, 0, 'bildirimsiz çağrılar SQL çalıştırmaz');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [...Array(3).fill(DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model),
    DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model]);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.escalated, trace.context.toolCalls, trace.context.selectedBy], [true, 1, 'server']);
  assert.deepEqual(trace.context.rounds.map((round) => [round.purpose, round.profile]), [['tools', 'chat.tools'], ['declaration', 'chat.tools'],
    ['declaration', 'chat.tools'], ['plan', 'chat.tools.reasoning']]);
  assert.deepEqual(aiTelemetrySnapshot().grounding.escalations, { total: 1, byReason: { REQUEST_DECLARATION: 1 }, byOutcome: { grounded: 1 } });
  drained(stack.provider);
});

const emptyRound = { type: 'answer', text: '', chunks: [], reasoning: 1, finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 200, reasoningTokens: 200, totalTokens: 300 } };

test('an empty completion keeps timing and usage, retries once cheaply, then uses the typed plan', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(emptyRound, nativePlan());
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION, mode: 'deep' })).assistantMessage.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 2);
  assert.ok(stack.provider.calls.every((call) => call.model === DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model));
  const [trace] = turnTraces(logs);
  const [empty, retry] = trace.context.rounds;
  assert.deepEqual([empty.input, empty.completion, empty.reasoning, empty.finish], [100, 200, 200, 'stop']);
  assert.equal(typeof empty.firstEventMs, 'number');
  assert.equal(typeof empty.ms, 'number');
  assert.equal(retry.purpose, 'retry');
  assert.equal(trace.context.escalated, false);
  drained(stack.provider);
});

test('an empty completion preserves the allowed reported model mismatch in its trace', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const reported = DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model;
  stack.provider.enqueue({ ...emptyRound, model: reported }, nativePlan());
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION, mode: 'deep' })).assistantMessage.finishReason, 'stop');
  const [trace] = turnTraces(logs);
  const [empty, retry] = trace.context.rounds;
  assert.equal(empty.model, reported);
  assert.equal(empty.configuredModel, DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model);
  assert.equal(empty.modelMismatch, true);
  assert.equal(retry.modelMismatch, false);
  drained(stack.provider);
});

test('two empty completions get exactly one Deep fallback and then fail without an escalation storm', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(emptyRound, emptyRound, emptyRound);
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  assert.equal(response.events.find((event) => event.event === 'error')?.data.code, 'AI_PROVIDER_RESPONSE_INVALID');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model,
    DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'].model, DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model]);
  assert.deepEqual(stack.db.aiMessageEvidence, []);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.outcome, trace.context.modelRounds, trace.context.escalated], ['error', 3, true]);
  assert.ok(trace.context.rounds.every((round) => round.reasoning === 200));
  assert.deepEqual(aiTelemetrySnapshot().grounding.escalations, { total: 1, byReason: { EMPTY_COMPLETION: 1 }, byOutcome: { error: 1 } });
  drained(stack.provider);
});

test('a carrier ambiguity is repaired before SQL and explicit field binding stays in Standard', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const request = { operation: 'value', metrics: ['task.title', 'task.project'], entities: [{ type: 'task', id: TASKS.OVERDUE }],
    population: { tool: 'rota_task_detail' }, layout: 'auto' };
  stack.provider.enqueue(nativePlan(request, [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }]),
    { type: 'script', respond: () => {
      assert.equal((stack.db.aiToolLog || []).length, 0);
      return nativePlan({ ...request, fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.name' }] }, [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }]);
    } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${TASKS.OVERDUE}` })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /Radar Modernizasyonu/);
  assert.equal(stack.provider.calls.length, 2);
  assert.ok(stack.provider.calls.every((call) => call.model === DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model));
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.selectedBy, trace.context.rounds.map((round) => round.purpose)], ['server', ['plan', 'declaration']]);
  drained(stack.provider);
});

test('revoked ambiguous evidence cannot reach the provider fallback', async (t) => {
  const stack = stackFor(t);
  stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => row.TaskId !== TASKS.OVERDUE);
  const task = stack.db.tasks.find((row) => row.TaskId === TASKS.OVERDUE);
  const request = { operation: 'value', metrics: ['task.title', 'task.project'], entities: [{ type: 'task', id: task.TaskId }],
    population: { tool: 'rota_task_detail' }, layout: 'auto', reasoning: 'synthesis', fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.name' }] };
  stack.db.queryBarrier = { match(sql) {
    if (sql.includes('rota-ai-tool:task-visibility')) task.ProjectId = PROJECTS.HIDDEN;
    return false;
  } };
  stack.provider.enqueue(nativePlan(request, [{ name: 'rota_task_detail', arguments: { taskId: task.TaskId } }]));
  const response = await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${task.TaskId}` });
  assert.equal(doneOf(response).assistantMessage.finishReason, 'unavailable');
  assert.equal(stack.provider.calls.length, 1, 'iptal edilmiş araç yükü için takip çağrısı yapılmaz');
  assert.ok(stack.provider.calls.every((call) => call.messages.every((message) => message.role !== 'tool')));
  assert.equal(response.events.filter((event) => event.event === 'delta').some((event) => event.data.text.includes(task.Title)), false);
  assert.deepEqual(stack.db.aiMessageEvidence, []);
  drained(stack.provider);
});

test('a post-persist ACL change prevents every visible data delta and corrects terminal telemetry', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(nativePlan());
  stack.db.aiConversationHooks = { beforeAppend() {
    stack.db.projects.find((row) => row.ProjectId === PROJECTS.FULL).LeadSicil = LEAD;
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => ![TASKS.OVERDUE, TASKS.SERIES, TASKS.OCCURRENCE_OPEN].includes(row.TaskId));
  } };
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  const answer = doneOf(response).assistantMessage;
  assert.equal(answer.finishReason, 'not_found');
  assert.deepEqual(answer.evidence, []);
  const visible = response.events.filter((event) => event.event === 'delta').map((event) => event.data.text);
  assert.deepEqual(visible, [answer.content], 'yalnızca son açıklama kararı görünürdür');
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.outcome, trace.context.selectedBy, aiTelemetrySnapshot().grounding.serverSelected], ['not_found', null, 0]);
  drained(stack.provider);
});

test('provider-controlled model and finish metadata never enter content-free turn telemetry', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const marker = 'sk-provider-controlled-secret';
  const request = { operation: 'value', metrics: ['task.title', 'task.project'], entities: [{ type: 'task', id: TASKS.OVERDUE }],
    population: { tool: 'rota_task_detail' }, layout: 'auto', reasoning: 'synthesis', fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.name' }] };
  stack.provider.enqueue(nativePlan(request, [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }]),
    { type: 'answer', model: marker, finishReason: marker, text: JSON.stringify({ kind: 'rota', facts: ['R1:data.task.title', 'R1:data.task.project.name'] }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: `Görevin proje adı: ${TASKS.OVERDUE}`, mode: 'deep' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 2);
  const [trace] = turnTraces(logs);
  assert.equal(trace.context.rounds[1].model, DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model);
  assert.equal(trace.context.rounds[1].finish, null);
  assert.ok(logs.every((line) => !line.includes(marker)));
  drained(stack.provider);
});

test('an allowed reported model remains distinct from the configured route model', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  const request = { operation: 'value', metrics: ['task.title'], reasoning: 'synthesis', entities: [{ type: 'task', id: TASKS.OVERDUE }], population: { tool: 'rota_task_detail' } };
  stack.provider.enqueue(nativePlan(request, [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }]),
    { type: 'answer', model: DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model,
      text: JSON.stringify({ kind: 'rota', facts: ['R1:data.task.title'] }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: `Görevi yorumla ${TASKS.OVERDUE}`, mode: 'deep' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  const [trace] = turnTraces(logs);
  assert.equal(trace.context.rounds[1].model, DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model);
  assert.equal(trace.context.rounds[1].configuredModel, DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'].model);
  assert.equal(trace.context.rounds[1].modelMismatch, true);
  drained(stack.provider);
});

test('the fullest grounded turn line stays inside the log sanitizer key limit and keeps every round', async (t) => {
  const { recordGroundedTurn } = await import('../src/server/ai/aiTelemetry.js');
  const logs = captureConsole(t);
  const round = (purpose) => ({ purpose, profile: PLANNING_PROFILE, model: DEFAULT_AI_MODEL_REGISTRY.profiles[PLANNING_PROFILE].model, durationMs: 5, budget: 1600, finishReason: 'stop', input: 10, completion: 5 });
  recordGroundedTurn({ outcome: 'grounded', selectedBy: 'server', escalated: true, resultScopeOmitted: true, parts: 2, evidence: 3,
    escalation: { requestedMode: 'standard', models: ['m'], reason: 'VERIFICATION_FAILED', toolsReused: true, outcome: 'grounded' },
    presentation: { mode: 'composed', blocks: 3, chart: 'bar', ms: 9 }, rounds: [round('plan'), round('select'), round('compose')] });
  const [trace] = turnTraces(logs);
  // Günlük temizleyicisi nesne başına 25 alanın ötesini atar: tek satırlık tamamlanma kaydı bu sınırın içinde kalır.
  assert.ok(Object.keys(trace.context).length <= 25, String(Object.keys(trace.context).length));
  assert.deepEqual(trace.context.rounds.map((item) => item.purpose), ['plan', 'select', 'compose']);
  assert.equal(trace.context.resultScopeOmitted, true);
  assert.equal(trace.context.escalation.reason, 'VERIFICATION_FAILED');
  assert.deepEqual(trace.context.usage, { input: 30, completion: 15, reasoning: null, firstEventMs: null, lengthStops: 0 });
});
