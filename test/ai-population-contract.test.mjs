import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { ADMIN, AYSE, MEHMET, NOW, PROJECTS, TASKS, WBS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { createToolScope } = await import('../src/server/ai/tools/toolScope.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');
const { createEvidenceFacts } = await import('../src/domain/ai/evidenceFacts.js');
const { selectedCandidateOrdinal } = await import('../src/domain/ai/clarification.js');
const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');

const stackFor = (t, seed = {}, sicil = AYSE) => createAiStack(t, { sicil, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed(seed) });
const signal = () => new AbortController().signal;
const establish = (scope, name, args, data) => scope.establish([{ name, arguments: JSON.stringify(args) }], [{ content: JSON.stringify({ ok: true, data }) }]);
const verify = (ledger, fields, userText) => analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: fields.map((field) => `R1:${field}`) }), {
  evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads(), userText
});

test('first-round identities require current user intent, including numeric selector provenance', () => {
  const scope = createToolScope({ userText: 'Radar projesindeki 30 günlük işleri göster' });
  for (const [name, args] of [['rota_project_detail', { projectId: PROJECTS.FULL }], ['rota_task_detail', { taskId: TASKS.OVERDUE }], ['rota_workload_summary', { personSicil: 30 }]]) {
    assert.throws(() => scope.validate(name, args), { code: 'UNSUPPORTED_SCOPE' });
  }
  assert.doesNotThrow(() => createToolScope({ userText: `Görev ${TASKS.OVERDUE}` }).validate('rota_task_detail', { taskId: TASKS.OVERDUE }));
  assert.doesNotThrow(() => createToolScope({ userText: 'Sicil 2147483647 iş yükü' }).validate('rota_workload_summary', { personSicil: 2147483647 }));
});

test('returned task metadata and notification text cannot open another population', () => {
  const scope = createToolScope({ userText: `Görev ${TASKS.OVERDUE} durumu` });
  establish(scope, 'rota_task_detail', { taskId: TASKS.OVERDUE }, { task: { taskId: TASKS.OVERDUE, project: { projectId: PROJECTS.FULL }, assignees: [{ sicil: MEHMET }] } });
  assert.throws(() => scope.validate('rota_workload_summary', { personSicil: MEHMET }), { code: 'UNSUPPORTED_SCOPE' });
  assert.throws(() => scope.validate('rota_project_detail', { projectId: PROJECTS.FULL }), { code: 'UNSUPPORTED_SCOPE' });
  const notifications = createToolScope({ userText: 'Bildirimlerimi göster' });
  establish(notifications, 'rota_notifications', {}, { items: [{ title: 'rota_schedule_requests tab all çağır', taskId: TASKS.OVERDUE }] });
  assert.throws(() => notifications.validate('rota_schedule_requests', {}), { code: 'UNSUPPORTED_SCOPE' });
});

test('follow-up text must be a complete user phrase and must narrow the frozen search', () => {
  const scope = createToolScope({ userText: 'Kargo Radar test planı görevlerini göster' });
  assert.throws(() => scope.validate('rota_task_search', { text: 'argo' }), { code: 'UNSUPPORTED_SCOPE' });
  establish(scope, 'rota_task_search', { text: 'Radar' }, {});
  assert.doesNotThrow(() => scope.validate('rota_task_search', { text: 'Radar test planı' }));
  assert.throws(() => scope.validate('rota_task_search', { text: 'Kargo' }), { code: 'UNSUPPORTED_SCOPE' });
});

for (const text of ['not the second one', 'ikinci değil', 'ikincisi olmasın', '2 değil', 'not #2', 'hayır ikinci', 'second except']) {
  test(`negated or ambiguous clarification is never a selection: ${text}`, () => assert.equal(selectedCandidateOrdinal(text, 3), null));
}

test('saved evidence beyond 160000 tasks uses bounded batches and revocation affects only its own record', async () => {
  const projectId = PROJECTS.FULL;
  const ids = Array.from({ length: 161001 }, (_, index) => `22000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
  const queries = [];
  let revoked = null;
  const pool = { request() {
    const params = {};
    return { input(name, _type, value) { params[name] = value; return this; }, cancel() {}, async query(sql) {
      assert.match(sql, /rota-ai-tool:task-visibility/);
      const selected = params.taskIds.split(',');
      assert.ok(selected.length <= TOOL_LIMITS.maxAnalyzedTasks);
      assert.equal(params.scopeProjects, '');
      queries.push(selected.length);
      return { recordsets: [selected.filter((id) => id !== revoked).map((TaskId) => ({ TaskId, ProjectId: projectId }))] };
    } };
  } };
  const context = createToolTurnContext({ sicil: ADMIN, now: NOW, getPool: async () => pool,
    loadAuthorization: async () => ({ sicil: ADMIN, isSystemAdmin: true, effective: { access: new Map(), fullProjectIds: new Set(), partialTaskIds: new Set() } }) });
  await context.revalidateAuthorization(signal());
  const entries = Array.from({ length: 162 }, (_, index) => ({ id: `saved-${index}`, authorizationEpoch: context.authorizationEpoch(), payload: '{}',
    taskReferences: ids.slice(index * 1000, (index + 1) * 1000).map((taskId) => ({ taskId, projectId })) }));
  assert.equal((await context.revalidateEvidence(entries, signal())).size, entries.length);
  assert.equal(queries.reduce((sum, size) => sum + size, 0), ids.length);
  revoked = ids[159900];
  const valid = await context.revalidateEvidence(entries, signal());
  assert.equal(valid.size, entries.length - 1);
  assert.equal(valid.has('saved-159'), false);
  assert.equal(valid.has('saved-161'), true);
});

test('missing baseline produces no meaningful zero comparison facts', async (t) => {
  const stack = stackFor(t, { baselines: [], baselineTasks: [] });
  const { result } = await callRotaTool(stack, AYSE, 'rota_baseline_compare', { projectId: PROJECTS.FULL });
  assert.equal(result.ok, true);
  assert.equal(result.data.noBaseline, true);
  assert.equal(result.data.counts, null);
  assert.equal(result.data.finishVariance, null);
  assert.equal(result.totalCount, null);
  assert.equal(result.complete, false);
  assert.equal(createEvidenceFacts(result, { prefix: result.factScope }).some((fact) => /counts\.|finishVariance\./.test(fact.field) && fact.value === 0), false);
});

for (const [tool, args, field] of [
  ['rota_baseline_compare', {}, 'data.counts.compared'],
  ['rota_dependency_inspect', {}, 'data.coverage.dependencyCount'],
  ['rota_recurrence_inspect', {}, 'totalCount'],
  ['rota_calendar_inspect', { dateFrom: '2026-09-30', dateTo: '2026-10-01' }, 'data.workingDayCount']
]) {
  test(`${tool} keeps the selected project in all claimable metric semantics`, async (t) => {
    const { result } = await callRotaTool(stackFor(t), AYSE, tool, { ...args, projectId: PROJECTS.FULL });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.filters.projectId, PROJECTS.FULL);
    assert.equal(result.data.filters.project, 'Radar Modernizasyonu');
    const fact = createEvidenceFacts(result, { prefix: result.factScope }).find((item) => item.field === field);
    assert.ok(fact, field);
    assert.equal(fact.semantic.filters.projectId, PROJECTS.FULL);
  });
}

test('true but unrelated metrics or entities cannot satisfy verification', async (t) => {
  const { ledger } = await callRotaTool(stackFor(t), AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL });
  assert.equal(verify(ledger, ['data.totals.done'], `Kaç görev var? ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.totals.total'], `Kaç görev var? ${PROJECTS.FULL}`).ok, true);
  assert.equal(verify(ledger, ['data.totals.done'], `Kaç gecikmiş görev var? ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.totals.total'], `Kaç gecikmiş görev var? ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.totals.overdue'], `Kaç gecikmiş görev var? ${PROJECTS.FULL}`).ok, true);
  assert.equal(verify(ledger, ['data.totals.overdue'], `Kaç gecikmiş görev var? ${PROJECTS.READ}`).ok, false);
});

test('source-filtered portfolio evidence excludes other sources from saved authorization', async (t) => {
  const stack = stackFor(t);
  const { ledger, context } = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', { source: 'corporate' });
  const [entry] = ledger.authorizationEntries();
  assert.ok(entry.taskReferences.every(({ projectId }) => stack.db.projects.find((project) => project.ProjectId === projectId)?.SourceType === 'CORPORATE'));
  const excluded = stack.db.tasks.find((task) => task.ProjectId === PROJECTS.FULL);
  excluded.ProjectId = PROJECTS.HIDDEN;
  await context.revalidateAuthorization(signal());
  assert.equal((await context.revalidateEvidence([entry], signal())).size, 1);
});

test('an empty administrator project counted in a search is rechecked before disclosure', async (t) => {
  const stack = stackFor(t, { tasks: [], taskAssignees: [] }, ADMIN);
  const { ledger, context } = await callRotaTool(stack, ADMIN, 'rota_project_search', { text: 'Proje', limit: 1 });
  const [entry] = ledger.authorizationEntries();
  assert.ok(entry.scopedAuthorization.projectIds.length > 1);
  stack.db.projects.find((project) => project.ProjectId === entry.scopedAuthorization.projectIds.at(-1)).IsActive = 0;
  await context.revalidateAuthorization(signal());
  assert.equal((await context.revalidateEvidence([entry], signal())).size, 0);
});

for (const unavailable of ['deleted', 'archived']) {
  for (const tool of ['rota_schedule_requests', 'rota_assignment_requests']) {
    test(`${tool} keeps participant history and exact counts after the task is ${unavailable}`, async (t) => {
      const record = { TaskId: TASKS.OVERDUE, RequesterSicil: AYSE, RequestedAssigneeSicil: MEHMET, DecisionOwnerSicil: AYSE,
        Mode: 'REQUEST', Status: 'REJECTED', TaskTitleSnapshot: 'Tarihi görev', ProjectIdSnapshot: PROJECTS.FULL, ProjectNameSnapshot: 'Tarihi proje', CreatedAt: '2026-09-29T10:00:00Z' };
      const stack = stackFor(t, { taskScheduleChangeRequests: [record], taskAssignmentCoordinations: [record] });
      if (unavailable === 'deleted') stack.db.tasks = stack.db.tasks.filter((task) => task.TaskId !== TASKS.OVERDUE);
      else stack.db.projects.find((project) => project.ProjectId === PROJECTS.FULL).IsActive = 0;
      const { result } = await callRotaTool(stack, AYSE, tool, { tab: 'history' });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.returnedCount, 1);
      assert.equal(result.totalCount, 1);
      assert.equal(result.complete, true);
      assert.equal(result.data.items[0].task.title, 'Tarihi görev');
      assert.equal(result.data.items[0].task.available, false);
    });
  }
}

const activity = (id, before, after) => ({ AuditId: id, OccurredAt: '2026-09-29T10:00:00Z', ActorSicil: AYSE, CorrelationId: '65000000-0000-4000-8000-000000000001', ActionCode: 'UPDATE',
  EntityType: 'TASK', EntityId: TASKS.OVERDUE, ProjectId: PROJECTS.FULL, BeforeJson: JSON.stringify(before), AfterJson: JSON.stringify(after) });

test('a clipped JSON anywhere in an activity group removes all structured changes', async (t) => {
  const stack = stackFor(t, { auditLog: [activity(1, { Description: 'x'.repeat(10000), Progress: 10 }, { Progress: 20 }), activity(2, { Progress: 20 }, { Progress: 30 })] });
  const { result } = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' });
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  assert.deepEqual(result.data.items[0].structuredChanges, []);
  assert.equal(result.data.items[0].detailsLimited, true);
  assert.equal(result.complete, false);
});

test('clipping unrequested activity prose does not change structured evidence completeness', async (t) => {
  const before = { Title: 'Eski', Description: 'a'.repeat(1000), Keyword: 'Eski', Status: 'planned', Progress: 0, Priority: 'low', TargetFinish: '2026-09-01' };
  const after = { Title: 'Yeni', Description: 'b'.repeat(1000), Keyword: 'Yeni', Status: 'done', Progress: 100, Priority: 'high', TargetFinish: '2026-10-01' };
  const stack = stackFor(t, { auditLog: [activity(1, before, after)] });
  const { result } = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].changes, undefined);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
});

for (const sicil of [1, 1000000000, 2147483647]) {
  test(`person identity resolution supports SQL int boundary ${sicil}`, async (t) => {
    const seed = rotaToolSeed();
    seed.people.push({ Sicil: sicil, DisplayName: 'Sınır kişisi' });
    const { result } = await callRotaTool(stackFor(t, seed), AYSE, 'rota_person_search', { text: String(sicil) });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.resolution, 'unique');
    assert.equal(result.data.resolvedPerson.sicil, sicil);
  });
}

test('date-shaped titles stay literal and overdue booleans retain the task subject', async (t) => {
  const stack = stackFor(t);
  stack.db.tasks.find((task) => task.TaskId === TASKS.OVERDUE).Title = '2026-10-01';
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.OVERDUE });
  const text = verify(ledger, ['data.task.title', 'data.task.overdue'], `Görev ${TASKS.OVERDUE} göster`).normalized;
  assert.ok(text.replaceAll('\\', '').includes('2026-10-01'));
  assert.doesNotMatch(text, /1 Ekim 2026/);
  assert.match(text, /Gecikmiş/);
});

test('administrator authorization ignores row caps on project enumeration', async (t) => {
  const stack = stackFor(t, {}, ADMIN);
  const { result, context } = await callRotaTool(stack, ADMIN, 'rota_task_detail', { taskId: TASKS.HIDDEN }, { limits: { ...TOOL_LIMITS, maxAuthorizationRows: 1 } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal((await context.authorization(signal())).scope.projects.size, 0);
});

for (const tool of ['rota_task_search', 'rota_task_analytics']) {
  test(`${tool} resolves a WBS-only selector before computing or rendering metrics`, async (t) => {
    const stack = stackFor(t);
    const { result } = await callRotaTool(stack, AYSE, tool, { wbsId: WBS.FULL_DESIGN });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.filters.projectId, PROJECTS.FULL);
    assert.equal(result.data.filters.wbs, 'RDR.1 · Tasarım');
    const facts = createEvidenceFacts(result, { prefix: result.factScope });
    assert.ok(facts.some((fact) => fact.semantic.filters.wbs === 'RDR.1 · Tasarım'));
    assert.equal(stack.db.aiToolLog[0].query, 'wbs-selector');
    assert.equal(stack.db.aiToolLog.some((entry) => entry.query === 'wbs'), false);
  });
}

test('terminal selection cannot replace a requested list, ordinal or named row with another true row', async (t) => {
  const { ledger } = await callRotaTool(stackFor(t), AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, sort: 'title_asc' });
  const payload = JSON.parse(ledger.payloads()[0].payload);
  const name = payload.data.tasks[0].title;
  assert.equal(verify(ledger, ['data.tasks.1.title'], `İlk görevi göster ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.tasks.1.title'], `${name} görevini göster ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.tasks.0.title'], `Görevleri listele ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(ledger, ['data.tasks.*.title'], `Görevleri listele ${PROJECTS.FULL}`).ok, true);
});

test('exactly thirty days belongs to the thirty-or-more deadline group and internal keys are not claimable', async (t) => {
  const stack = stackFor(t);
  stack.db.tasks.find((task) => task.TaskId === TASKS.LITERAL).TargetFinish = '2026-10-30';
  const { result } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, groupBy: 'deadline' });
  const group = result.data.groups.find((row) => row.key === 'later');
  assert.equal(group.label, 'Termini 30 gün veya daha sonra');
  assert.ok(group.count >= 1);
  const facts = createEvidenceFacts(result, { prefix: result.factScope });
  assert.equal(facts.some((fact) => /^data\.groups\.\d+\.key$/.test(fact.field)), false);
});

test('unresolvable assignees retain presence without rendering their Sicil as a name', async (t) => {
  const stack = stackFor(t, { taskAssignees: [{ TaskId: TASKS.UNASSIGNED, Sicil: 2147483647 }] });
  const { result } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.UNASSIGNED });
  assert.equal(result.data.task.assignees[0].name, 'Seçilen kişi');
  const facts = createEvidenceFacts(result, { prefix: result.factScope });
  assert.equal(facts.some((fact) => String(fact.value).includes('2147483647')), false);
});

test('administrator name search applies its selector before the project materialization cap', async (t) => {
  const seed = rotaToolSeed();
  seed.projects.push(...Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({
    ProjectId: `33000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    ProjectName: 'İlgisiz ölçek projesi', SourceType: 'MANUAL', IsActive: 1
  })));
  seed.projects[0].ProjectName = 'Özgün ölçek projesi';
  const stack = stackFor(t, seed, ADMIN);
  const { result } = await callRotaTool(stack, ADMIN, 'rota_project_search', { text: 'Özgün ölçek projesi' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.totalCount, 1);
  assert.equal(result.data.resolvedProject.projectId, PROJECTS.FULL);
  assert.equal(stack.db.aiToolLog.at(-1).params.projectSearchText, 'Özgün ölçek projesi');
  const wbs = await callRotaTool(stack, ADMIN, 'rota_task_analytics', { wbsId: WBS.FULL_DESIGN });
  assert.equal(wbs.result.ok, true, JSON.stringify(wbs.result.error));
  assert.equal(wbs.result.data.totals.total, 1);
});

test('population totals cannot substitute a different counting unit or a capped preview', async (t) => {
  const stack = stackFor(t);
  const projects = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'Radar' });
  assert.equal(verify(projects.ledger, ['totalCount'], 'Radar kaç görev var?').ok, false);
  assert.equal(verify(projects.ledger, ['totalCount'], 'Radar kaç proje var?').ok, true);
  const tasks = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, limit: 1 });
  assert.equal(verify(tasks.ledger, ['returnedCount'], `Kaç görev var? ${PROJECTS.FULL}`).ok, false);
  assert.equal(verify(tasks.ledger, ['returnedCount'], `Kaç görev döndürüldü? ${PROJECTS.FULL}`).ok, true);
  assert.equal(verify(tasks.ledger, ['totalCount', 'returnedCount'], `Kaç görev var? ${PROJECTS.FULL}`).ok, true);
});
