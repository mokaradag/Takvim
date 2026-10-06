import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack, assistantReadiness } from './helpers/aiStack.mjs';
import { AYSE, LEAD, NOW, PROJECTS, TASKS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { createToolScope } = await import('../src/server/ai/tools/toolScope.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { getRotaTool } = await import('../src/server/ai/tools/toolRegistry.js');
const { readWbs } = await import('../src/server/ai/tools/rota/rotaToolStore.js');
const { parseInline } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const { effectiveAssistantSource, rotaDataAvailability } = await import('../src/features/ai/assistant/assistantPresentation.js');
const stackFor = (t) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });

test('successful later tools freeze their own normalized population', () => {
  const scope = createToolScope();
  scope.establish([{ name: 'rota_project_search', arguments: '{"text":"Radar"}' }], [{ content: JSON.stringify({ ok: true, data: { matches: [{ projectId: PROJECTS.FULL, exactMatch: true }], resolution: 'unique', resolvedProject: { projectId: PROJECTS.FULL } } }) }]);
  const args = { projectId: PROJECTS.FULL, deadline: 'overdue', status: ['todo'] };
  assert.doesNotThrow(() => scope.validate('rota_task_search', args));
  scope.establish([{ name: 'rota_task_search', arguments: JSON.stringify(args) }], [{ content: '{"ok":true,"data":{}}' }]);
  assert.doesNotThrow(() => scope.validate('rota_task_search', { ...args, limit: 1, cursor: 'next' }));
  for (const broadened of [{ projectId: PROJECTS.FULL }, { ...args, status: ['done'] }, { ...args, textFields: ['description'] }]) {
    assert.throws(() => scope.validate('rota_task_search', broadened), { code: 'UNSUPPORTED_SCOPE' });
  }
});

test('workload preserves cents above the safe scaled-number range', async (t) => {
  stackFor(t);
  const context = createToolTurnContext({ sicil: AYSE, now: NOW });
  const authorization = await context.authorization(new AbortController().signal);
  const facts = Array.from({ length: 20000 }, (_, index) => ({ TaskId: `a1000000-0000-4000-8000-${String(index).padStart(12, '0')}`, ProjectId: PROJECTS.FULL,
    Title: 'Task', Status: 'todo', AssigneeCount: 1, ResolvedAssigneeCount: 1, PlannedHours: index ? '9999999999.99' : '9999999999.98' }));
  const assignees = facts.map((row) => ({ TaskId: row.TaskId, Sicil: AYSE, DisplayName: 'Ayşe', IdentityVisible: 1, Resolved: 1 }));
  const executor = { request() { return { input() { return this; }, async query() { return { recordsets: [facts, [], assignees] }; } }; } };
  const result = await getRotaTool('rota_workload_summary').handler({}, { today: '2026-09-29', authorization: async () => authorization, sql: (work) => work(executor) });
  assert.equal(result.data.people[0].plannedHoursOnAssignedTasks, '199999999999799.99');
  assert.equal(result.data.people[0].tasksWithPlannedHours, 20000);
});

test('WBS recursion limits produce a bounded tool error, including wrapped SQL errors', async (t) => {
  stackFor(t);
  const { scope } = await createToolTurnContext({ sicil: AYSE }).authorization(new AbortController().signal);
  for (const error of [{ number: 530 }, { originalError: { info: { number: 530 } } }]) {
    const executor = { request() { return { input() { return this; }, async query() { throw error; } }; } };
    await assert.rejects(readWbs(executor, scope, { projectId: PROJECTS.FULL, wbsId: TASKS.OVERDUE, today: '2026-09-29', maxRows: 100 }), { code: 'RESULT_TOO_LARGE' });
  }
});

test('task paging ignores assignee projection changes but detects population drift', async (t) => {
  const stack = stackFor(t);
  const first = await callRotaTool(stack, AYSE, 'rota_task_search', { limit: 1 });
  assert.ok(first.result.nextCursor);
  stack.db.taskAssignees.push({ TaskId: first.result.data.tasks[0].taskId, Sicil: LEAD });
  const second = await callRotaTool(stack, AYSE, 'rota_task_search', { limit: 1, cursor: first.result.nextCursor });
  assert.equal(second.result.ok, true);
  stack.db.tasks.push({ ...stack.db.tasks.find((row) => row.TaskId === TASKS.OVERDUE), TaskId: 'a2000000-0000-4000-8000-000000000001' });
  const changed = await callRotaTool(stack, AYSE, 'rota_task_search', { limit: 1, cursor: first.result.nextCursor });
  assert.equal(changed.result.error.code, 'INVALID_ARGUMENTS');
});

test('escaped citations remain literal and unescaped citations still tokenize', () => {
  assert.equal(parseInline('\\【R1】').some((token) => token.type === 'cite'), false);
  assert.equal(parseInline('\\【R1】').map((token) => token.value || '').join(''), '【R1】');
  assert.equal(parseInline('【R1】').some((token) => token.type === 'cite'), true);
  assert.equal(parseInline('\\\\【R1】').some((token) => token.type === 'cite'), true);
});

test('unavailable Rota modes keep the selected Rota source and expose a localized reason', () => {
  const ready = { rotaData: { enabled: true, available: true, modes: [{ id: 'standard', available: true }, { id: 'deep', available: false }] } };
  assert.equal(effectiveAssistantSource(ready, 'standard', 'rota'), 'rota');
  assert.equal(effectiveAssistantSource(ready, 'deep', 'rota'), 'rota', 'the server returns the fixed unavailable outcome instead of an ungrounded answer');
  assert.equal(effectiveAssistantSource(ready, 'standard', 'general'), 'general');
  assert.equal(effectiveAssistantSource({ rotaData: { enabled: false } }, 'standard', 'rota'), null, 'feature off sends no source');
  assert.equal(effectiveAssistantSource(null, 'standard', 'rota'), null);
  for (const reason of ['EVIDENCE_SCHEMA_MISSING', 'EVIDENCE_SCHEMA_UNKNOWN', 'PROFILE_UNAVAILABLE']) {
    const unavailable = { rotaData: { ...ready.rotaData, available: false, reason } };
    assert.equal(effectiveAssistantSource(unavailable, 'standard', 'rota'), 'rota');
    assert.match(rotaDataAvailability(unavailable, 'standard').message, /Genel sohbet/);
    assert.ok(!rotaDataAvailability(unavailable, 'standard').message.includes(reason));
  }
});

test('recent tool and turn failures remain visible when evidence schema observation is stale', async (t) => {
  stackFor(t);
  await assistantReadiness();
  const { noteEvidenceSchema } = await import('../src/server/ai/assistant/conversationStore.js');
  const { aiHealthComponent } = await import('../src/server/ai/aiHealth.js');
  const { recordAiToolCall, recordAssistantTurn } = await import('../src/server/ai/aiTelemetry.js');
  noteEvidenceSchema(true, new Date(Date.now() - 16 * 60 * 1000));
  assert.match(aiHealthComponent().message, /yakın zamanda doğrulanmadı/);
  recordAiToolCall({ tool: 'rota_task_search', code: 'INTERNAL' });
  assert.match(aiHealthComponent().message, /aracı hizmet hatası/);
  recordAssistantTurn({ code: 'AI_INTERNAL_ERROR', serviceFailure: true });
  assert.match(aiHealthComponent().message, /Bilgin turu tamamlanamadı/);
});

test('claims beyond the first 256 enumerated facts are already verified by selected paths', async (t) => {
  const stack = stackFor(t);
  const template = stack.db.projects.find((row) => row.ProjectId === PROJECTS.FULL);
  stack.db.projects = Array.from({ length: 25 }, (_, index) => ({ ...template, ProjectId: `a3000000-0000-4000-8000-${String(index).padStart(12, '0')}`, ProjectName: `Project ${String(index).padStart(2, '0')}`, ProjectCode: `P${index}` }));
  stack.db.tasks = [];
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', { limit: 25 });
  assert.equal(result.data.projects.length, 25);
  const { createEvidenceFacts } = await import('../src/domain/ai/evidenceFacts.js');
  const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');
  const field = 'data.projects.24.tasks.total';
  assert.equal(createEvidenceFacts(result, { prefix: result.factScope }).some((fact) => fact.field === field), false);
  const fact = createEvidenceFacts(result, { prefix: result.factScope, fields: [field] })[0];
  assert.ok(fact);
  const claim = { evidenceId: result.evidenceId, factId: fact.factId, subjectId: fact.subjectId, field, operator: 'eq', value: fact.value };
  assert.equal(analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', claims: [claim] }), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads() }).ok, true);
});

test('Outlook fixture defaults are active and exercise visible subscriptions', async (t) => {
  const stack = stackFor(t);
  assert.ok(stack.db.taskOutlookSubscriptions.every((row) => row.IsActive === 1));
  const { result } = await callRotaTool(stack, AYSE, 'rota_outlook_status');
  assert.equal(result.totalCount, 2);
  assert.deepEqual(result.data.items.map((row) => row.task.taskId).sort(), [TASKS.OVERDUE, TASKS.DUE_SOON].sort());
});

test('only emitted portfolio IDs are trusted and detail calls still revalidate current authorization', async (t) => {
  stackFor(t);
  const { createToolExecutor } = await import('../src/server/ai/tools/toolExecutor.js');
  const { createEvidenceLedger } = await import('../src/server/ai/tools/evidenceLedger.js');
  let available = true;
  const context = createToolTurnContext({ sicil: AYSE, now: NOW, loadAuthorization: async () => ({ sicil: AYSE,
    effective: { access: available ? new Map([[PROJECTS.FULL, { accessLevel: 'FULL', reasons: [] }], [PROJECTS.READ, { accessLevel: 'FULL', reasons: [] }]]) : new Map(), partialTaskIds: new Set() } }) });
  const scope = createToolScope({ userText: 'Hangi projede en çok gecikme var; ayrıntısını göster' });
  const executor = createToolExecutor({ context, ledger: createEvidenceLedger(), signal: new AbortController().signal, validateCall: scope.validate });
  const call = (name, args) => ({ id: name, name, arguments: JSON.stringify(args) });
  const portfolioCall = call('rota_portfolio_summary', { limit: 1 });
  const messages = await executor.runRound([portfolioCall]);
  const result = JSON.parse(messages[0].content);
  assert.equal(result.ok, true);
  assert.equal(result.data.projects[0].projectId, PROJECTS.FULL);
  scope.establish([portfolioCall], messages);
  const detail = async (id) => JSON.parse((await executor.runRound([call('rota_project_detail', { projectId: id })]))[0].content);
  assert.equal((await detail(PROJECTS.FULL)).ok, true);
  for (const id of [PROJECTS.HIDDEN, PROJECTS.READ, '12345678-1234-4123-8123-123456789012']) {
    assert.equal((await detail(id)).error.code, 'UNSUPPORTED_SCOPE');
  }
  available = false;
  assert.equal((await detail(PROJECTS.FULL)).error.code, 'NOT_FOUND');
});
