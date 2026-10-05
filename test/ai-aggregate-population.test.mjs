/**
 * Rota AI · toplu kanıtın yetki nüfusu.
 *
 * Bir toplam, sayı ya da dağılım yalnızca dayandığı BÜTÜN görevler güncel
 * yetkiyle hâlâ görünürse açıklanır: listelenmeyen ama sayılan görevler de
 * nüfusa girer, son doğrulamada ve yeniden açılışta denetlenir. Nüfus sınırlı
 * kayda sığmazsa kayıtlı yanıt yeniden açılışta doğrulanamaz sayılır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack, loadAssistantConversation, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, LEAD, MEHMET, PARTIAL_OTHERS, PROJECTS, TASKS, WBS, ZEYNEP, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { claimFor, declared, evidenceReply } from './helpers/evidenceScenario.mjs';

const { decodeAuthorizationPopulation } = await import('../src/server/ai/tools/evidenceAuthorization.js');
const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');

const done = (response) => response.events.find((event) => event.event === 'done')?.data;
const deltas = (response) => response.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('');
const signal = () => new AbortController().signal;

/** Serinin önizlemede listelenmeyen eski bir yinelemesi. */
const EARLY_OCCURRENCE = '20000000-0000-4000-8000-000000000009';

function stackFor(t, overrides = {}) {
  const seed = rotaToolSeed(overrides);
  seed.tasks.push({ TaskId: EARLY_OCCURRENCE, ProjectId: PROJECTS.FULL, Title: 'Haftalık durum toplantısı', Status: 'done', Priority: 'medium', CreatedBySicil: null,
    WbsId: WBS.FULL_ROOT, RecurrenceParentTaskId: TASKS.SERIES, RecurrenceOccurrenceDate: '2026-09-14', TargetFinish: '2026-09-14', ActualStart: '2026-09-14', ActualFinish: '2026-09-14' });
  return createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed });
}

const FULL_TASKS = [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.DONE, TASKS.UNASSIGNED, TASKS.LITERAL, TASKS.SERIES, TASKS.OCCURRENCE_DONE, TASKS.OCCURRENCE_OPEN, EARLY_OCCURRENCE];
const FULL_OPEN_TASKS = [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.UNASSIGNED, TASKS.LITERAL, TASKS.SERIES, TASKS.OCCURRENCE_OPEN];
const SERIES_TASKS = [TASKS.SERIES, TASKS.OCCURRENCE_DONE, TASKS.OCCURRENCE_OPEN, EARLY_OCCURRENCE];
const NEVER_VISIBLE = [TASKS.HIDDEN, TASKS.OUTSIDER_CREATED, TASKS.TEAM_HIDDEN, TASKS.ARCHIVED, ...PARTIAL_OTHERS];

function populationOf(ledger) {
  const [entry] = ledger.authorizationEntries();
  assert.ok(entry, 'kanıt kaydı yok');
  return new Map(entry.taskReferences.map(({ taskId, projectId }) => [taskId, projectId]));
}

function assertPopulation(population, { includes = [], excludes = NEVER_VISIBLE }, label) {
  for (const id of includes) assert.ok(population.has(id), `${label}: sayılan görev nüfusta yok (${id})`);
  for (const id of excludes) assert.ok(!population.has(id), `${label}: görünmeyen görev nüfusa girdi (${id})`);
}

const activity = (id, taskId, projectId) => ({ AuditId: id, OccurredAt: '2026-09-29T08:00:00Z', ActorSicil: AYSE, ActionCode: 'UPDATE', EntityType: 'TASK',
  EntityId: taskId, ProjectId: projectId, BeforeJson: JSON.stringify({ Progress: 10 }), AfterJson: JSON.stringify({ Progress: 20 }) });

const WORKFLOW_SEED = Object.freeze({
  auditLog: [activity(1, TASKS.OVERDUE, PROJECTS.FULL), activity(2, TASKS.DUE_SOON, PROJECTS.FULL), activity(3, TASKS.READ_1, PROJECTS.READ)],
  taskScheduleChangeRequests: [
    { TaskId: TASKS.OVERDUE, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, Status: 'PENDING', CreatedAt: '2026-09-28T08:00:00Z' },
    { TaskId: TASKS.DUE_SOON, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, Status: 'PENDING', CreatedAt: '2026-09-27T08:00:00Z' },
    { TaskId: TASKS.READ_1, RequesterSicil: AYSE, DecisionOwnerSicil: LEAD, Status: 'PENDING', CreatedAt: '2026-09-26T08:00:00Z' }
  ],
  taskAssignmentCoordinations: [
    { TaskId: TASKS.OVERDUE, RequesterSicil: AYSE, RequestedAssigneeSicil: ZEYNEP, Mode: 'REQUEST', Status: 'PENDING', CreatedAt: '2026-09-28T08:00:00Z' },
    { TaskId: TASKS.LITERAL, RequesterSicil: AYSE, RequestedAssigneeSicil: MEHMET, Mode: 'REQUEST', Status: 'PENDING', CreatedAt: '2026-09-27T08:00:00Z' }
  ],
  // Zil önizlemesi kaynak başına sınırlıdır: sayaç önizlemede görünmeyen görevlere de dayanır.
  taskNotifications: [TASKS.OVERDUE, TASKS.PARTIAL_OWN, TASKS.DUE_SOON, TASKS.UNASSIGNED, TASKS.LITERAL, TASKS.SERIES, TASKS.OCCURRENCE_OPEN, TASKS.READ_1, TASKS.READ_2, TASKS.TEAM_VISIBLE]
    .map((taskId, index) => ({ RecipientSicil: AYSE, Kind: 'TASK_ASSIGNED', TaskId: taskId, ActorSicil: LEAD, EventKey: `n${index}`, OccurredAt: `2026-09-${String(28 - index).padStart(2, '0')}T08:00:00Z` }))
});

const AGGREGATE_CASES = [
  ['rota_project_detail', { projectId: PROJECTS.FULL }, { includes: FULL_TASKS }],
  ['rota_portfolio_summary', { limit: 1 }, { includes: [...FULL_TASKS, TASKS.READ_1, TASKS.READ_2, TASKS.PARTIAL_OWN, TASKS.PARTIAL_SHARED, TASKS.TEAM_VISIBLE] }],
  ['rota_wbs_inspect', { projectId: PROJECTS.FULL, limit: 1 }, { includes: FULL_TASKS }],
  ['rota_baseline_compare', { projectId: PROJECTS.FULL, limit: 1 }, { includes: FULL_TASKS }],
  ['rota_dependency_inspect', { projectId: PROJECTS.FULL }, { includes: FULL_TASKS }],
  ['rota_recurrence_inspect', { projectId: PROJECTS.FULL, limit: 1 }, { includes: SERIES_TASKS }],
  ['rota_recurrence_inspect', { taskId: TASKS.OCCURRENCE_OPEN }, { includes: SERIES_TASKS }],
  ['rota_task_analytics', { projectId: PROJECTS.FULL }, { includes: FULL_TASKS }],
  ['rota_task_search', { projectId: PROJECTS.FULL, limit: 1 }, { includes: FULL_TASKS }],
  ['rota_workload_summary', { projectId: PROJECTS.FULL, limit: 1 }, { includes: FULL_OPEN_TASKS }],
  ['rota_data_quality', { projectId: PROJECTS.FULL, limit: 1 }, { includes: FULL_TASKS }],
  ['rota_outlook_status', { limit: 1 }, { includes: [TASKS.OVERDUE, TASKS.DUE_SOON], excludes: [...NEVER_VISIBLE, TASKS.UNASSIGNED] }],
  ['rota_activity_search', { period: 'last_7_days', limit: 1 }, { includes: [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.READ_1] }],
  ['rota_schedule_requests', { limit: 1 }, { includes: [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.READ_1] }],
  ['rota_assignment_requests', { limit: 1 }, { includes: [TASKS.OVERDUE, TASKS.LITERAL] }],
  ['rota_notifications', {}, { includes: [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.PARTIAL_OWN, TASKS.READ_2, TASKS.TEAM_VISIBLE] }]
];

for (const [name, args, expected] of AGGREGATE_CASES) {
  test(`${name} records every counted task of its aggregate, not only the listed rows (${JSON.stringify(args)})`, async (t) => {
    const stack = stackFor(t, WORKFLOW_SEED);
    const { result, ledger } = await callRotaTool(stack, AYSE, name, args);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const population = populationOf(ledger);
    assertPopulation(population, expected, name);
    for (const [taskId, projectId] of population) {
      const task = stack.db.tasks.find((row) => row.TaskId === taskId);
      assert.ok(task, `${name}: nüfusta bilinmeyen görev`);
      assert.equal(projectId, task.ProjectId, `${name}: nüfus güncel projeyi taşımalı`);
    }
  });
}

test('moving a counted but unlisted task out of scope drops the aggregate at final revalidation, for every aggregate tool', async (t) => {
  for (const [name, args] of AGGREGATE_CASES) {
    const stack = stackFor(t, WORKFLOW_SEED);
    const { result, ledger, context } = await callRotaTool(stack, AYSE, name, args);
    assert.equal(result.ok, true, name);
    const listed = new Set(JSON.stringify(result.data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
    const population = populationOf(ledger);
    const unlisted = [...population.keys()].find((id) => !listed.has(id));
    assert.ok(unlisted, `${name}: listelenmeyen sayılan görev yok`);
    await context.revalidateAuthorization(signal());
    const entries = ledger.authorizationEntries();
    assert.ok((await context.revalidateEvidence(entries, signal())).has(entries[0].id), `${name}: değişmeyen kanıt korunmalı`);
    const task = stack.db.tasks.find((row) => row.TaskId === unlisted);
    task.ProjectId = PROJECTS.HIDDEN;
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => row.TaskId !== unlisted || row.Sicil !== AYSE);
    if (Number(task.CreatedBySicil) === AYSE) task.CreatedBySicil = MEHMET;
    await context.revalidateAuthorization(signal());
    assert.equal((await context.revalidateEvidence(ledger.authorizationEntries(), signal())).has(entries[0].id), false,
      `${name}: listelenmeyen sayılan görev kapsam dışına çıktığında toplam açıklanmamalı`);
  }
});

function citeProjectTotal(stack, projectId = PROJECTS.FULL) {
  const request = declared({ operation: 'value', metrics: ['tasks.total'], entities: [{ type: 'project', id: projectId }] });
  stack.provider.enqueue({ type: 'tool-calls', preface: [request], calls: [{ name: 'rota_project_detail', arguments: { projectId } }] },
    { type: 'script', respond: (call) => {
      const result = JSON.parse(call.messages.findLast((message) => message.role === 'tool').content);
      return { type: 'answer', text: evidenceReply(claimFor(result, 'data.visibleTasks.total')) };
    } });
}

test('a saved aggregate answer is hidden on reopen and replay when a counted, unlisted task leaves scope', async (t) => {
  const stack = stackFor(t);
  citeProjectTotal(stack);
  const turnId = randomUUID();
  const first = done(await sendTurn({ turnId, message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` }));
  assert.equal(first.assistantMessage.finishReason, 'stop');
  const stored = JSON.parse(stack.db.aiMessageEvidence[0].EvidenceJson);
  const population = decodeAuthorizationPopulation(stored.authorizationPopulation);
  assert.equal(population.length, FULL_TASKS.length);
  const reopened = await loadAssistantConversation(first.conversation.id);
  assert.equal(reopened.body.messages.find((message) => message.role === 'assistant').content, first.assistantMessage.content);
  // Proje yetkisi aynı kalır; yalnızca sayılan bir görev gizli projeye taşınır.
  stack.db.tasks.find((row) => row.TaskId === TASKS.DONE).ProjectId = PROJECTS.HIDDEN;
  const hidden = (await loadAssistantConversation(first.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(hidden.finishReason, 'not_found');
  assert.deepEqual(hidden.evidence, []);
  assert.doesNotMatch(hidden.content, new RegExp(String(FULL_TASKS.length)));
  const replay = await sendTurn({ turnId, conversationId: first.conversation.id, message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` });
  assert.equal(done(replay).replayed, true);
  assert.deepEqual(done(replay).assistantMessage.evidence, []);
  assert.equal(done(replay).assistantMessage.finishReason, 'not_found');
});

test('an aggregate whose population cannot fit the bounded record is shown in-turn but never re-disclosed unverified', async (t) => {
  const extra = Array.from({ length: 1600 }, (_, index) => ({
    TaskId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, ProjectId: PROJECTS.FULL, Title: `Toplu görev ${index + 1}`, Status: 'planned', Priority: 'medium'
  }));
  const stack = stackFor(t);
  stack.db.tasks.push(...extra);
  citeProjectTotal(stack);
  const turnId = randomUUID();
  const response = await sendTurn({ turnId, message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` });
  const saved = done(response);
  assert.equal(saved.assistantMessage.finishReason, 'stop');
  assert.equal(saved.assistantMessage.content, deltas(response));
  const total = String(FULL_TASKS.length + extra.length);
  const totalPattern = new RegExp(`${total[0]}\\\\?\\.?${total.slice(1)}`);
  assert.match(saved.assistantMessage.content, totalPattern);
  assert.equal(saved.assistantMessage.evidence.length, 1);
  const row = stack.db.aiMessageEvidence[0];
  assert.ok(row.EvidenceJson.length <= 32768, 'kalıcı kanıt 0018 sınırına sığmalı');
  const stored = JSON.parse(row.EvidenceJson);
  assert.deepEqual(stored.authorizationPopulation, { v: 1, complete: false });
  assert.equal(decodeAuthorizationPopulation(stored.authorizationPopulation), null);
  const reopened = (await loadAssistantConversation(saved.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(reopened.finishReason, 'unavailable');
  assert.deepEqual(reopened.evidence, []);
  assert.doesNotMatch(reopened.content, totalPattern);
  assert.match(reopened.content, /yeniden doğrulanamıyor/);
  const replay = await sendTurn({ turnId, conversationId: saved.conversation.id, message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` });
  assert.equal(done(replay).replayed, true);
  assert.doesNotMatch(deltas(replay), totalPattern);
  assert.match(deltas(replay), /yeniden doğrulanamıyor/);
});

test('a population that fits only without the reproduction data is persisted compactly and stays verifiable', async (t) => {
  const extra = Array.from({ length: 900 }, (_, index) => ({
    TaskId: `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, ProjectId: PROJECTS.FULL, Title: `Toplu görev ${index + 1}`, Status: 'planned', Priority: 'medium'
  }));
  const stack = stackFor(t);
  stack.db.tasks.push(...extra);
  citeProjectTotal(stack);
  const saved = done(await sendTurn({ turnId: randomUUID(), message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` }));
  const stored = JSON.parse(stack.db.aiMessageEvidence[0].EvidenceJson);
  assert.equal(decodeAuthorizationPopulation(stored.authorizationPopulation).length, FULL_TASKS.length + extra.length);
  const reopened = (await loadAssistantConversation(saved.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(reopened.content, saved.assistantMessage.content);
  stack.db.tasks.find((row) => row.TaskId === extra[450].TaskId).ProjectId = PROJECTS.HIDDEN;
  const hidden = (await loadAssistantConversation(saved.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(hidden.finishReason, 'not_found');
});

test('legacy aggregate evidence without a recorded population is unverifiable, while payload-bound legacy evidence still verifies', async (t) => {
  const stack = stackFor(t);
  citeProjectTotal(stack);
  const aggregate = done(await sendTurn({ turnId: randomUUID(), message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` }));
  stack.provider.enqueue({ type: 'tool-calls', preface: [declared({ operation: 'value', metrics: ['task.title'], entities: [{ type: 'task', id: TASKS.OVERDUE }] })],
    calls: [{ name: 'rota_task_detail', arguments: { taskId: TASKS.OVERDUE } }] },
    { type: 'script', respond: (call) => {
      const result = JSON.parse(call.messages.findLast((message) => message.role === 'tool').content);
      return { type: 'answer', text: evidenceReply(claimFor(result, 'data.task.title')) };
    } });
  const detail = done(await sendTurn({ turnId: randomUUID(), message: `Radar test planı görevini göster: ${TASKS.OVERDUE}` }));
  for (const row of stack.db.aiMessageEvidence) {
    const value = JSON.parse(row.EvidenceJson);
    delete value.authorizationPopulation;
    row.EvidenceJson = JSON.stringify(value);
  }
  const legacyAggregate = (await loadAssistantConversation(aggregate.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(legacyAggregate.finishReason, 'unavailable');
  assert.deepEqual(legacyAggregate.evidence, []);
  assert.notEqual(legacyAggregate.content, aggregate.assistantMessage.content);
  const legacyDetail = (await loadAssistantConversation(detail.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(legacyDetail.content, detail.assistantMessage.content);
  assert.equal(legacyDetail.evidence.length, 1);
});

test('a malformed persisted population fails closed', async (t) => {
  const stack = stackFor(t);
  citeProjectTotal(stack);
  const saved = done(await sendTurn({ turnId: randomUUID(), message: `Radar projesinde kaç görev var? ${PROJECTS.FULL}` }));
  for (const tampered of [{ v: 1, complete: true, tasks: { [PROJECTS.FULL]: 'AA' } }, { v: 2, complete: true, tasks: {} }, { v: 1, complete: true, tasks: { 'not-a-guid': '' } }]) {
    const row = stack.db.aiMessageEvidence[0];
    row.EvidenceJson = JSON.stringify({ ...JSON.parse(row.EvidenceJson), authorizationPopulation: tampered });
    const reopened = (await loadAssistantConversation(saved.conversation.id)).body.messages.find((message) => message.role === 'assistant');
    assert.notEqual(reopened.content, saved.assistantMessage.content, JSON.stringify(tampered));
    assert.deepEqual(reopened.evidence, []);
  }
});

test('read notification history beyond the evidence bound never turns unread or pending counts unknown', async (t) => {
  const read = Array.from({ length: TOOL_LIMITS.maxCursorOffset + 50 }, (_, index) => ({
    RecipientSicil: AYSE, Kind: 'TASK_ASSIGNED', TaskId: TASKS.OVERDUE, EventKey: `read-${index}`, ReadAt: '2026-09-20T08:00:00Z', OccurredAt: '2026-09-20T08:00:00Z'
  }));
  const stack = stackFor(t, {
    taskNotifications: [...read, { RecipientSicil: AYSE, Kind: 'TASK_ASSIGNED', TaskId: TASKS.DUE_SOON, EventKey: 'unread', OccurredAt: '2026-09-29T08:00:00Z' }],
    taskScheduleChangeRequests: [{ TaskId: TASKS.OVERDUE, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, Status: 'PENDING' }]
  });
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_notifications');
  assert.equal(result.data.taskEvents.unread, 1);
  assert.equal(result.data.scheduleRequests.awaitingYourDecision, 1);
  assert.equal(typeof result.data.unreadCount, 'number');
  assert.equal(result.data.actionRequiredCount, 1);
  assertPopulation(populationOf(ledger), { includes: [TASKS.OVERDUE, TASKS.DUE_SOON] }, 'rota_notifications');
});
