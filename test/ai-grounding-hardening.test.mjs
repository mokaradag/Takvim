/**
 * Rota AI · kanıt, kapsam sınırı ve yetki sertleştirmeleri.
 *
 * Kapsam sınırının güvenilir niyet kaynakları (kullanıcı iletisi, veri
 * okunmadan önceki bildirim, kullanıcının açık serbest metin seçimi), aday
 * belirsizliği, toplu kanıtın nüfus doğrulaması, belirlenimci olgu
 * yazımının niteleyicileri ve geçici SQL tablolarının temizliği sınanır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack, loadAssistantConversation, sendTurn } from './helpers/aiStack.mjs';
import { ADMIN, ALI_1, ALI_2, AYSE, NOW, PROJECTS, TASKS, WBS, callRotaTool, callRotaTools, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { claimFor, evidenceReply } from './helpers/evidenceScenario.mjs';

const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { createToolScope } = await import('../src/server/ai/tools/toolScope.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
const { renderEvidenceFact, createEvidenceFacts } = await import('../src/domain/ai/evidenceFacts.js');
const { claimableContract, projectEvidenceData } = await import('../src/domain/ai/claimableEvidence.js');
const { aiTelemetrySnapshot, recordProviderCall } = await import('../src/server/ai/aiTelemetry.js');
const { aiHealthComponent } = await import('../src/server/ai/aiHealth.js');
const { authorizationFingerprint } = await import('../src/server/ai/tools/evidenceAuthorization.js');
const { buildRotaScope } = await import('../src/server/ai/tools/rota/rotaScope.js');
const { parseTurnRoute, parseTurnWindow } = await import('../src/domain/ai/evidenceIntent.js');
const { COORDINATION_EVIDENCE_INBOX_SQL } = await import('../src/server/assignment/assignmentCoordinationQueries.js');
const { TASK_ACTIVITY_SQL } = await import('../src/server/reports/taskActivityReport.js');
const { TASK_NOTIFICATION_EVIDENCE_INBOX_SQL } = await import('../src/server/notifications/taskNotificationQueries.js');
const { ServerPersistenceError } = await import('../src/server/errors.js');

const TOOLS_ON = Object.freeze({ MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' });
const calls = (name, args = {}, id = 'call') => ({ text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const reply = (text, finishReason = 'stop') => ({ text, toolCalls: [], finishReason });
const results = (input) => input.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
const stackFor = (t, seed = {}, sicil = AYSE) => createAiStack(t, { sicil, env: TOOLS_ON, seed: rotaToolSeed(seed) });
const ok = (data = {}) => ({ content: JSON.stringify({ ok: true, data }) });
const established = (scope, name, args, data) => scope.establish([{ name, arguments: JSON.stringify(args) }], [ok(data)]);

async function turn(t, steps, { user = 'Rota verisini incele', allowedTextFields = [], sicil = AYSE, seed = {}, context = null } = {}) {
  const stack = stackFor(t, seed, sicil);
  const texts = [];
  const scope = context || createToolTurnContext({ sicil, now: NOW });
  const session = { signal: new AbortController().signal, round: async (input) => {
    const step = steps.shift();
    assert.ok(step, 'Beklenmeyen ek model turu');
    return typeof step === 'function' ? step(input, stack) : step;
  } };
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: user, now: NOW }).messages,
    catalog: toolCatalogForModel(), context: scope, allowedTextFields, onText: async (text) => texts.push(text) });
  assert.equal(steps.length, 0);
  return { result, stack, texts };
}

/* ── Kapsam sınırı ─────────────────────────────────────────── */

test('a follow-up search may use text the user typed but not text read from tool results', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'Radar projesindeki gecikmiş görevler' });
  established(scope, 'rota_task_analytics', { deadline: 'overdue' }, { totals: {} });
  assert.doesNotThrow(() => scope.validate('rota_project_search', { text: 'radar' }));
  assert.throws(() => scope.validate('rota_project_search', { text: 'Gizli Proje' }), { code: 'UNSUPPORTED_SCOPE' });
});

test('same-tool follow-ups may narrow the widest root values but not widen narrower ones', () => {
  const scope = createToolScope({ today: '2026-09-30' });
  established(scope, 'rota_portfolio_summary', {}, { totals: {} });
  established(scope, 'rota_activity_search', { period: 'last_7_days' }, { items: [] });
  assert.doesNotThrow(() => scope.validate('rota_portfolio_summary', { includeEmpty: false }));
  assert.doesNotThrow(() => scope.validate('rota_activity_search', { period: 'last_7_days', scope: 'mine' }));
  const narrow = createToolScope({ today: '2026-09-30' });
  established(narrow, 'rota_portfolio_summary', { includeEmpty: false }, { totals: {} });
  assert.throws(() => narrow.validate('rota_portfolio_summary', { includeEmpty: true }), { code: 'UNSUPPORTED_SCOPE' });
});

test('an ambiguous lookup does not block unrelated resolved entities, and its candidates never become identities', () => {
  const scope = createToolScope({ today: '2026-09-30' });
  scope.establish([
    { name: 'rota_task_detail', arguments: JSON.stringify({ taskId: TASKS.OVERDUE }) },
    { name: 'rota_person_search', arguments: JSON.stringify({ text: 'Ali' }) }
  ], [ok({ task: { taskId: TASKS.OVERDUE, project: { projectId: PROJECTS.FULL } } }), ok({ ambiguous: true, people: [{ sicil: 910004 }, { sicil: 910005 }] })]);
  assert.doesNotThrow(() => scope.validate('rota_dependency_inspect', { taskId: TASKS.OVERDUE }));
  assert.throws(() => scope.validate('rota_workload_summary', { personSicil: 910004 }), { code: 'UNSUPPORTED_SCOPE' });
});

test('a unique exact project match authorizes only that project, not the fuzzy alternatives', () => {
  const scope = createToolScope({ today: '2026-09-30' });
  established(scope, 'rota_project_search', { text: 'Radar' }, { ambiguous: false, matches: [
    { projectId: PROJECTS.FULL, exactMatch: true }, { projectId: PROJECTS.READ, exactMatch: false }] });
  assert.doesNotThrow(() => scope.validate('rota_project_detail', { projectId: PROJECTS.FULL }));
  assert.throws(() => scope.validate('rota_project_detail', { projectId: PROJECTS.READ }), { code: 'UNSUPPORTED_SCOPE' });
});

test('task-name resolution proves a unique task before detail follow-ups', async (t) => {
  const stack = stackFor(t, { tasks: [...rotaToolSeed().tasks, { TaskId: '20000000-0000-4000-8000-000000000777', ProjectId: PROJECTS.FULL,
    Title: 'Radar test planı ikinci', Status: 'planned', Priority: 'medium' }] });
  const ambiguous = await callRotaTool(stack, AYSE, 'rota_task_search', { text: 'Radar test' });
  assert.equal(ambiguous.result.data.titleResolution, 'ambiguous');
  assert.ok(ambiguous.result.data.tasks.length >= 2);
  const scope = createToolScope({ today: '2026-09-30' });
  established(scope, 'rota_task_search', { text: 'Radar test' }, ambiguous.result.data);
  assert.throws(() => scope.validate('rota_task_detail', { taskId: TASKS.OVERDUE }), { code: 'UNSUPPORTED_SCOPE' });

  const unique = await callRotaTool(stack, AYSE, 'rota_task_search', { text: 'Radar test planı' });
  assert.equal(unique.result.data.titleResolution, 'unique');
  assert.equal(unique.result.data.resolvedTask.taskId, TASKS.OVERDUE);
  const resolved = createToolScope({ today: '2026-09-30' });
  established(resolved, 'rota_task_search', { text: 'Radar test planı' }, unique.result.data);
  assert.doesNotThrow(() => resolved.validate('rota_task_detail', { taskId: TASKS.OVERDUE }));
  assert.throws(() => resolved.validate('rota_task_detail', { taskId: '20000000-0000-4000-8000-000000000777' }), { code: 'UNSUPPORTED_SCOPE' });
});

test('server-owned aggregate identities are drill-down roots', () => {
  const scope = createToolScope({ today: '2026-09-30' });
  established(scope, 'rota_task_analytics', { groupBy: 'project' }, { groupBy: 'project', groups: [{ key: PROJECTS.FULL, count: 3 }, { key: 'other', count: 1 }] });
  assert.doesNotThrow(() => scope.validate('rota_project_detail', { projectId: PROJECTS.FULL }));
  assert.throws(() => scope.validate('rota_project_detail', { projectId: PROJECTS.HIDDEN }), { code: 'UNSUPPORTED_SCOPE' });
  const quality = createToolScope({ today: '2026-09-30' });
  established(quality, 'rota_data_quality', {}, { checks: [] });
  assert.doesNotThrow(() => quality.validate('rota_task_search', { deadline: 'no_target_finish' }));
});

test('a cross-tool time window must be the default or declared before data is read', () => {
  const scope = createToolScope({ today: '2026-09-30' });
  established(scope, 'rota_task_detail', { taskId: TASKS.OVERDUE }, { task: { taskId: TASKS.OVERDUE } });
  assert.doesNotThrow(() => scope.validate('rota_activity_search', { taskId: TASKS.OVERDUE }));
  assert.throws(() => scope.validate('rota_activity_search', { taskId: TASKS.OVERDUE, period: 'custom', dateFrom: '2025-01-01', dateTo: '2026-09-30' }), { code: 'UNSUPPORTED_SCOPE' });
  assert.throws(() => scope.validate('rota_activity_search', { taskId: TASKS.OVERDUE, period: 'last_7_days' }), { code: 'UNSUPPORTED_SCOPE' });

  const declared = createToolScope({ today: '2026-09-30' });
  const declaration = { kind: 'route', intent: 'rota', window: { period: 'last_7_days' } };
  assert.equal(parseTurnRoute(declaration), 'rota');
  declared.declare(parseTurnWindow(declaration));
  established(declared, 'rota_task_detail', { taskId: TASKS.OVERDUE }, { task: { taskId: TASKS.OVERDUE } });
  assert.doesNotThrow(() => declared.validate('rota_activity_search', { taskId: TASKS.OVERDUE, period: 'last_7_days' }));
  assert.throws(() => declared.validate('rota_activity_search', { taskId: TASKS.OVERDUE, period: 'custom', dateFrom: '2026-01-01' }), { code: 'UNSUPPORTED_SCOPE' });
  assert.equal(parseTurnRoute({ kind: 'route', intent: 'general', window: { period: 'today' } }), null);
});

test('free-text fields require the user\'s explicit choice, even in the first round', () => {
  const scope = createToolScope({ today: '2026-09-30', allowedTextFields: [] });
  assert.throws(() => scope.validate('rota_task_detail', { taskId: TASKS.OVERDUE, textFields: ['description'] }), (error) => error.code === 'UNSUPPORTED_SCOPE'
    && error.details.includes('$.textFields:not-authorized'));
  const allowed = createToolScope({ today: '2026-09-30', allowedTextFields: ['description'] });
  assert.doesNotThrow(() => allowed.validate('rota_task_detail', { taskId: TASKS.OVERDUE, textFields: ['description'] }));
});

test('the turn endpoint only accepts a boolean free-text choice and forwards it to containment', async (t) => {
  const stack = stackFor(t);
  const invalid = await sendTurn({ turnId: randomUUID(), message: 'Notu göster', includeText: 'yes' });
  assert.equal(invalid.status, 400);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_task_detail', arguments: { taskId: TASKS.LITERAL, textFields: ['description'] } }] },
    { type: 'script', respond: (call) => {
      const tool = JSON.parse(call.messages.find((message) => message.role === 'tool').content);
      assert.equal(tool.error.code, 'UNSUPPORTED_SCOPE');
      return { type: 'answer', text: '{"kind":"unavailable"}' };
    } });
  const refused = await sendTurn({ turnId: randomUUID(), message: 'Rapor görevinin notu ne?' });
  assert.equal(refused.status, 200);
  // Sağlayıcı ikizindeki doğrulama hatası akışta hata olayı olur; tur tamamlanmalı ve veri açılmamalıdır.
  const done = refused.events.find((event) => event.event === 'done');
  assert.ok(done, 'the turn must complete; a provider-side assertion failure surfaces as an error event');
  assert.equal(done.data.assistantMessage.finishReason, 'unavailable');
});

test('successful later rounds open their own follow-ups (person → task list → task detail)', async (t) => {
  const { result } = await turn(t, [calls('rota_person_search', { text: 'Ayşe Yılmaz' }), (input) => {
    const person = results(input)[0].data.people[0];
    return calls('rota_task_search', { personSicil: person.sicil }, 'list');
  }, (input) => {
    assert.ok(input.tools.some((tool) => tool.name === 'rota_task_detail'));
    return calls('rota_task_detail', { taskId: results(input).at(-1).data.tasks[0].taskId }, 'detail');
  }, (input) => {
    assert.equal(results(input).at(-1).ok, true);
    return reply(evidenceReply(claimFor(results(input).at(-1), 'data.task.status')));
  }], { user: 'Ayşe Yılmaz\'ın ilk görevinin durumu?' });
  assert.equal(result.outcome, 'grounded');
});

test('a lone partial person match is a candidate, not a Sicil identity for follow-ups', async (t) => {
  const { result } = await turn(t, [calls('rota_person_search', { text: 'Ayşe' }), (input) => {
    const found = results(input)[0];
    assert.equal(found.data.resolution, 'partial');
    assert.equal(found.data.resolvedPerson, undefined);
    assert.equal(found.data.candidates.length, 1);
    return calls('rota_task_search', { personSicil: found.data.people[0].sicil }, 'list');
  }, (input) => {
    assert.equal(results(input).at(-1).error.code, 'UNSUPPORTED_SCOPE');
    return reply(JSON.stringify({ kind: 'clarification', evidence: 'R1' }));
  }], { user: 'Ayşe\'nin görevleri' });
  assert.equal(result.outcome, 'clarification');
  assert.match(result.text, /^1\. \*\*Ayşe Yılmaz\*\*/);
  assert.match(result.text, /Onaylamak için \*\*1\*\* yazın/);
  assert.deepEqual(JSON.parse(result.evidenceRows[0].evidenceJson).clarificationContext, [{ ordinal: 0, personSicil: AYSE }]);
});

test('a resolved project name reaches project-scoped activity, workload and request tools', async (t) => {
  const { result } = await turn(t, [calls('rota_project_search', { text: 'Radar Modernizasyonu' }), (input) => {
    assert.ok(['rota_activity_search', 'rota_workload_summary', 'rota_schedule_requests', 'rota_assignment_requests', 'rota_recurrence_inspect']
      .every((name) => input.tools.some((tool) => tool.name === name)));
    assert.equal(results(input)[0].data.resolution, 'unique');
    return calls('rota_workload_summary', { projectId: results(input)[0].data.resolvedProject.projectId }, 'load');
  }, (input) => reply(evidenceReply(claimFor(results(input).at(-1), 'data.openTaskCount')))], { user: 'Radar Modernizasyonu projesinin iş yükü' });
  assert.equal(result.outcome, 'grounded');
});

test('a lone partial project match cannot open project-scoped follow-ups without confirmation', async (t) => {
  const { result } = await turn(t, [calls('rota_project_search', { text: 'Radar' }), (input) => {
    const found = results(input)[0];
    assert.equal(found.data.resolution, 'partial');
    assert.equal(found.data.ambiguous, false);
    return calls('rota_project_detail', { projectId: found.data.matches[0].projectId }, 'detail');
  }, (input) => {
    assert.equal(results(input).at(-1).error.code, 'UNSUPPORTED_SCOPE');
    return reply('{"kind":"clarification"}');
  }], { user: 'Radar projesinin durumu' });
  assert.equal(result.outcome, 'clarification');
  assert.match(result.text, /^1\. \*\*Radar Modernizasyonu\*\* \(RDR\)/);
});

/* ── Sonuç ve telemetri ────────────────────────────────────── */

test('a verified answer is stored as a server-terminal stop even after a provider tool_calls finish', async (t) => {
  const { result } = await turn(t, [calls('rota_task_detail', { taskId: TASKS.OVERDUE }), (input) => ({
    text: evidenceReply(claimFor(results(input)[0], 'data.task.status')), toolCalls: [], finishReason: 'tool_calls'
  })]);
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.finishReason, 'stop');
});

test('general-chat redirects are counted separately from candidate clarifications', async (t) => {
  let before = null;
  const { result } = await turn(t, [() => {
    before = { ...aiTelemetrySnapshot().grounding };
    return reply('{"kind":"general","text":"Proje yönetimi bir disiplindir."}');
  }], { user: 'Proje yönetimi nedir?' });
  assert.equal(result.outcome, 'general_redirect');
  const after = aiTelemetrySnapshot().grounding;
  assert.equal(after.general_redirect - before.general_redirect, 1);
  assert.equal(after.clarification - before.clarification, 0);
});

test('a clarification always presents the server-held candidate set; the model cannot drop alternatives', async (t) => {
  const named = await turn(t, [calls('rota_person_search', { text: 'Ali' }), (input) => {
    const found = results(input)[0];
    return reply(JSON.stringify({ kind: 'clarification', claims: [claimFor(found, 'data.people.0.name'), claimFor(found, 'data.people.0.jobTitle')] }));
  }], { user: 'Ali’nin iş yükü' });
  assert.equal(named.result.outcome, 'clarification');
  const rows = named.result.text.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.equal(rows.length, 2, 'every candidate is shown even when the model named one');
  assert.match(rows[0], /Uzman · K1 \/ Kalite \/ Üretim/);
  assert.match(rows[1], /Mühendis · T2 \/ Tasarım \/ Planlama/);
  const context = JSON.parse(named.result.evidenceRows[0].evidenceJson).clarificationContext;
  assert.deepEqual(context, [{ ordinal: 0, personSicil: ALI_1 }, { ordinal: 1, personSicil: ALI_2 }]);

  const bare = await turn(t, [calls('rota_person_search', { text: 'Ali' }), reply('{"kind":"clarification"}')], { user: 'Ali’nin iş yükü' });
  assert.equal(bare.result.outcome, 'clarification');
  assert.equal(bare.result.text.split('\n').filter((line) => /^\d+\. /.test(line)).length, 2);

  const forged = await turn(t, [calls('rota_person_search', { text: 'Ali' }), reply('{"kind":"clarification","evidence":"R1","candidates":[0]}'),
    reply('{"kind":"clarification","evidence":"R9"}')], { user: 'Ali’nin iş yükü' });
  assert.equal(forged.result.outcome, 'failed');

  const unique = await turn(t, [calls('rota_project_search', { text: 'Radar Modernizasyonu' }), reply('{"kind":"clarification","evidence":"R1"}'),
    reply('{"kind":"clarification"}')], { user: 'Radar Modernizasyonu' });
  assert.equal(unique.result.outcome, 'failed', 'a uniquely resolved search has nothing to clarify');
});

/* ── Toplu kanıt ve yetki ──────────────────────────────────── */

test('aggregate evidence is dropped when a counted but unlisted task leaves the authorized population', async (t) => {
  const { result } = await turn(t, [calls('rota_task_analytics', { projectId: PROJECTS.FULL }), (input, stack) => {
    // Sayılan görev, kullanıcının göremediği projeye taşınır; projedeki yetki aynı kalır.
    stack.db.tasks.find((task) => task.TaskId === TASKS.DONE).ProjectId = PROJECTS.HIDDEN;
    return reply(evidenceReply(claimFor(results(input)[0], 'data.totals.total')));
  }, reply('{"kind":"unavailable"}')]);
  assert.notEqual(result.outcome, 'grounded');
  assert.deepEqual(result.evidenceRows, []);
});

test('admin project evidence survives the final authorization re-read', async (t) => {
  const { result } = await turn(t, [calls('rota_project_detail', { projectId: PROJECTS.FULL }),
    (input) => reply(evidenceReply(claimFor(results(input)[0], 'data.project.name')))], { sicil: ADMIN });
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.evidenceRows.length, 1);
});

test('archiving a project changes the administrator\'s population-wide epoch', async (t) => {
  const stack = stackFor(t, {}, ADMIN);
  const first = createToolTurnContext({ sicil: ADMIN, now: NOW });
  await first.authorization(new AbortController().signal);
  stack.db.projects.find((project) => project.ProjectId === PROJECTS.READ).IsActive = 0;
  const second = createToolTurnContext({ sicil: ADMIN, now: NOW });
  await second.authorization(new AbortController().signal);
  assert.notEqual(first.authorizationEpoch(), second.authorizationEpoch());
});

test('the authorization fingerprint reuses the canonical identity set for repeated checks', () => {
  const auth = { sicil: AYSE, isSystemAdmin: false, scopeIdentities: Array.from({ length: 5000 }, (_, index) => 5000 - index), scopeTaskRights: [],
    effective: { access: new Map([[PROJECTS.FULL, { accessLevel: 'FULL', reasons: ['MANUAL_PROJECT_LEAD'] }]]), partialTaskIds: new Set() } };
  const scope = buildRotaScope(auth);
  const sort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function counted(...args) { if (this.length >= 5000) sorts += 1; return sort.apply(this, args); };
  try {
    const first = authorizationFingerprint(auth, scope);
    for (let index = 0; index < 12; index += 1) assert.equal(authorizationFingerprint(auth, scope), first);
    authorizationFingerprint(auth, scope, { projectIds: [PROJECTS.FULL] });
  } finally { Array.prototype.sort = sort; }
  assert.equal(sorts, 1, 'the large identity set is sorted once per loaded context');
});

test('evidence revalidation reads task identities in bounded chunks instead of failing the whole set', async (t) => {
  stackFor(t);
  const context = createToolTurnContext({ sicil: AYSE, now: NOW, limits: { ...TOOL_LIMITS, maxAnalyzedTasks: 2 } });
  await context.revalidateAuthorization(new AbortController().signal);
  const entry = (id, taskId) => ({ id, authorizationEpoch: context.authorizationEpoch(), taskReferences: [{ taskId, projectId: PROJECTS.FULL }] });
  const authorized = await context.revalidateEvidence([entry('a', TASKS.OVERDUE), entry('b', TASKS.DUE_SOON), entry('c', TASKS.DONE), entry('d', TASKS.HIDDEN)], new AbortController().signal);
  assert.deepEqual([...authorized].sort(), ['a', 'b', 'c']);
});

/* ── Olgu yazımı ───────────────────────────────────────────── */

test('calendar weekdays, workflow statuses and access levels render their real meaning', async (t) => {
  const stack = stackFor(t);
  const calendar = await callRotaTool(stack, AYSE, 'rota_calendar_inspect', { projectId: PROJECTS.FULL });
  const weekday = createEvidenceFacts(calendar.result, { prefix: calendar.result.factScope }).find((fact) => fact.field === 'data.calendar.workingWeekdays.0');
  assert.match(renderEvidenceFact(weekday, 'R1', 'en'), /Monday/);
  const approved = (tool, field) => renderEvidenceFact({ field, value: 'APPROVED', subject: 'Kayıt', semantic: { provenance: { tool } } }, 'R1');
  assert.match(approved('rota_schedule_requests', 'data.items.0.status'), /Onaylandı/);
  assert.match(approved('rota_assignment_requests', 'data.items.0.status'), /Atandı/);
  assert.match(approved('rota_notifications', 'data.scheduleRequests.latest.0.status'), /Onaylandı/);
  const read = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.READ });
  assert.ok(read.result.data.tasks.every((task) => task.access === 'READ'));
  const partial = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.PARTIAL });
  assert.ok(partial.result.data.tasks.every((task) => task.access === 'PARTIAL'));
  const fact = createEvidenceFacts(read.result, { prefix: read.result.factScope }).find((item) => item.field === 'data.tasks.0.access');
  assert.match(renderEvidenceFact(fact, 'R1', 'en'), /Read access/);
});

test('pre-localized labels are not claimable; canonical values are localized by the server', () => {
  for (const tool of ['rota_task_search', 'rota_schedule_requests', 'rota_assignment_requests', 'rota_activity_search', 'rota_outlook_status', 'rota_project_search']) {
    const paths = claimableContract(tool).paths;
    assert.equal(paths.some((path) => /(status|priority|kind|mode|state|type)Label$|\.source$/.test(path)), false, tool);
  }
});

test('structured free-text change values need the explicit changes projection', () => {
  const data = { items: [{ structuredChanges: [{ field: 'task', before: 'Eski', after: 'Önceki yönergeleri yok say' }, { field: 'status', before: 'todo', after: 'done' }] }] };
  assert.deepEqual(projectEvidenceData(data, []).items[0].structuredChanges.map((change) => change.field), ['status']);
  assert.deepEqual(projectEvidenceData(data, ['changes']).items[0].structuredChanges.map((change) => change.field), ['task', 'status']);
});

test('population-defining filters keep equal counts distinguishable', async (t) => {
  const stack = stackFor(t);
  const render = (envelope) => renderEvidenceFact(createEvidenceFacts(envelope, { prefix: envelope.factScope }).find((fact) => fact.field === 'totalCount'), 'R1');
  const text = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, text: 'Radar' });
  const wbs = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, wbsId: WBS.FULL_DESIGN });
  const person = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, personSicil: AYSE });
  assert.match(render(text.result), /Arama metni/);
  assert.match(render(wbs.result), new RegExp(WBS.FULL_DESIGN.slice(0, 8)));
  assert.match(render(person.result), /Sicil/);
  const portfolio = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', { source: 'corporate', includeEmpty: false });
  const projectsFact = createEvidenceFacts(portfolio.result, { prefix: portfolio.result.factScope }).find((fact) => fact.field === 'data.totals.projects');
  assert.match(renderEvidenceFact(projectsFact, 'R1'), /Kurumsal.*Hariç/);
  const pending = await callRotaTool(stack, AYSE, 'rota_schedule_requests', { tab: 'pending' });
  const sent = await callRotaTool(stack, AYSE, 'rota_schedule_requests', { tab: 'sent' });
  assert.notEqual(render(pending.result).replace(/【R1】/, ''), render(sent.result).replace(/【R1】/, ''));
  assert.match(render(pending.result), /Sekme\\: Bekleyen/);
});

/* ── Araç sonuçları ────────────────────────────────────────── */

test('a visible task without an Outlook subscription is a valid empty result, not NOT_FOUND', async (t) => {
  const stack = stackFor(t);
  const visible = await callRotaTool(stack, AYSE, 'rota_outlook_status', { taskId: TASKS.DONE });
  assert.equal(visible.result.ok, true);
  assert.equal(visible.result.totalCount, 0);
  const hidden = await callRotaTool(stack, AYSE, 'rota_outlook_status', { taskId: TASKS.HIDDEN });
  assert.equal(hidden.result.error.code, 'NOT_FOUND');
});

test('person search honors an explicit limit of one while still reporting ambiguity', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_person_search', { text: 'Ali Veli', limit: 1 });
  assert.equal(result.data.people.length, 1);
  assert.equal(result.data.ambiguous, true);
  assert.equal(result.truncated, true);
});

test('activity evidence uses the true first value of a group and drops field details when rows are omitted', async (t) => {
  const event = (auditId, before, after) => ({ AuditId: auditId, EntityType: 'TASK', ActionCode: 'UPDATE', EntityId: TASKS.OVERDUE, ProjectId: PROJECTS.FULL,
    ActorSicil: AYSE, ActorDisplayName: 'Ayşe Yılmaz', CorrelationId: 'c-1', OccurredAt: `2026-09-29T0${auditId}:00:00.000Z`,
    BeforeJson: JSON.stringify(before), AfterJson: JSON.stringify(after) });
  const two = stackFor(t, { auditLog: [event(1, { Progress: 10 }, { Progress: 20 }), event(2, { Progress: 20 }, { Progress: 40 })] });
  const pair = await callRotaTool(two, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' });
  assert.deepEqual(pair.result.data.items[0].structuredChanges, [{ field: 'progress', before: 10, after: 40 }]);
  two.db.auditLog = [event(1, { Progress: 10 }, { Progress: 20 }), event(2, { Progress: 20 }, { Progress: 30 }), event(3, { Progress: 30 }, { Progress: 40, Status: 'done' })];
  const many = await callRotaTool(two, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29', textFields: ['changes'] });
  assert.deepEqual(many.result.data.items[0].structuredChanges, []);
  assert.equal(many.result.data.items[0].detailsLimited, true);
  assert.equal(many.result.complete, false);
});

test('activity snapshots are keyed by their text projection', async (t) => {
  const stack = stackFor(t, { auditLog: [{ AuditId: 1, EntityType: 'TASK', ActionCode: 'UPDATE', EntityId: TASKS.OVERDUE, ProjectId: PROJECTS.FULL, ActorSicil: AYSE,
    ActorDisplayName: 'Ayşe Yılmaz', OccurredAt: '2026-09-29T08:00:00.000Z', BeforeJson: JSON.stringify({ assigneeIds: [AYSE] }), AfterJson: JSON.stringify({ assigneeIds: [AYSE, 910003] }) }] });
  const { results } = await callRotaTools(stack, AYSE, [
    ['rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' }],
    ['rota_activity_search', { period: 'custom', dateFrom: '2026-09-29', textFields: ['changes'] }]
  ], { limits: { ...TOOL_LIMITS, roundConcurrency: 1 } });
  assert.match(results[1].data.items[0].changes.join(' '), /Zeynep Kaya/);
});

test('project detail never publishes a capped dependency count as exact: the metric is unknown, the rest stays exact', async (t) => {
  const seed = rotaToolSeed();
  seed.taskDependencies = Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({ ProjectId: PROJECTS.FULL,
    TaskId: TASKS.DUE_SOON, PredecessorTaskId: TASKS.OVERDUE, DependencyType: 'FS', LagDays: index }));
  const stack = createAiStack(t, { sicil: AYSE, seed });
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.FULL });
  assert.equal(result.ok, true);
  assert.equal(result.data.project.dependencyCount, null);
  assert.deepEqual(result.data.project.countsOverLimit, ['dependencyCount']);
  assert.equal(result.data.project.wbsNodeCount, 3);
  assert.equal(result.complete, false);
  const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');
  const verdict = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: ['R1:data.project.dependencyCount', 'R1:data.project.wbsNodeCount'] }),
    { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads() });
  assert.match(verdict.normalized, /Kesin değil: analiz sınırını aşıyor/);
  assert.doesNotMatch(verdict.normalized, new RegExp(String(TOOL_LIMITS.maxAnalyzedTasks).replace(/(\d)(?=(\d{3})+$)/g, '$1.?')));
});

/* ── SQL ve sağlık ─────────────────────────────────────────── */

test('evidence temp tables are dropped before creation and before every bounded-result THROW', () => {
  for (const statement of [COORDINATION_EVIDENCE_INBOX_SQL, TASK_NOTIFICATION_EVIDENCE_INBOX_SQL, TASK_ACTIVITY_SQL]) {
    assert.match(statement, /DROP TABLE IF EXISTS #/);
  }
  const sources = ['src/server/assignment/assignmentCoordinationQueries.js', 'src/server/schedule-change/scheduleRequestQueries.js', 'src/server/reports/taskActivityReport.js'];
  return Promise.all(sources.map(async (file) => {
    const text = await import('node:fs/promises').then((fs) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    for (const match of text.matchAll(/BEGIN\s+(?:--[^\n]*\n\s*)?DROP TABLE ([^;]+);\s+THROW 51001/g)) assert.ok(match[1].includes('#'), file);
    assert.doesNotMatch(text, /THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;\s*(?:SELECT|DECLARE @lastPage)[\s\S]{0,40}#(?:Coordination|Schedule)EvidenceSnapshot/);
    assert.ok(/BEGIN[\s\S]{0,120}DROP TABLE[^;]+;\s+THROW 51001/.test(text), file);
  }));
});

test('every Rota tool bounded-result THROW first drops all temp tables the batch creates', async () => {
  const queries = await import('../src/server/ai/tools/rota/rotaToolQueries.js');
  let total = 0;
  for (const [name, text] of Object.entries(queries)) {
    const created = new Set([...text.matchAll(/(?:CREATE TABLE|INTO) (#\w+)/g)].map((match) => match[1]));
    const guarded = [...text.matchAll(/BEGIN\s+DROP TABLE IF EXISTS ([^;]+);\s+THROW 51001/g)];
    assert.equal(guarded.length, (text.match(/THROW 51001/g) || []).length, `${name}: every THROW cleans up first`);
    for (const [, list] of guarded) {
      const dropped = new Set(list.split(',').map((table) => table.trim()));
      for (const table of created) assert.ok(dropped.has(table), `${name}: ${table} is dropped before THROW`);
    }
    total += guarded.length;
  }
  assert.ok(total > 0);
});

test('an invalid tools flag does not hide a more severe AI health warning', (t) => {
  const stack = stackFor(t);
  stack.setEnv({ MERGEN_ROTA_AI_TOOLS_ENABLED: 'on' });
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5, code: 'AI_PROVIDER_UNAVAILABLE' });
  const failing = aiHealthComponent({ now: Date.now() });
  assert.match(failing.message, /Son sağlayıcı çağrısı başarısız/);
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5 });
  assert.match(aiHealthComponent({ now: Date.now() }).message, /etkinleştirme ayarı geçersiz|Model kaydı|profil|tablo/);
});

/* ── Kayıtlı yanıtlar ──────────────────────────────────────── */

test('a General-chat answer that quotes a citation-like marker stays visible after reload', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue({ type: 'stream', text: 'Kaynak atıfları 【R1】 biçiminde yazılır.' });
  const response = await sendTurn({ turnId: randomUUID(), message: 'Atıf biçimi nedir?', source: 'general' });
  const done = response.events.find((event) => event.event === 'done').data;
  const reopened = await loadAssistantConversation(done.conversation.id);
  const answer = reopened.body.messages.find((message) => message.role === 'assistant');
  assert.equal(answer.content, 'Kaynak atıfları 【R1】 biçiminde yazılır.');
  assert.equal(answer.finishReason, 'general');
});

test('a transient evidence-schema probe failure is retryable and never saves an unavailable answer', async (t) => {
  const stack = stackFor(t);
  let failed = false;
  stack.db.queryBarrier = {
    match: (sql) => !failed && sql.includes('@evidenceReady') && (failed = true),
    entered: 0,
    released: Promise.reject(new ServerPersistenceError('DATABASE_UNAVAILABLE', 'SQL zaman aşımı.'))
  };
  stack.db.queryBarrier.released.catch(() => {});
  const turnId = randomUUID();
  const first = await sendTurn({ turnId, message: 'Radar projesinde kaç görev var?' });
  assert.equal(first.status, 503);
  assert.equal(stack.db.aiConversationMessages.some((row) => row.Role === 'assistant'), false);
  stack.db.queryBarrier = null;
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL } }] },
    { type: 'script', respond: (call) => ({ type: 'answer', text: evidenceReply(claimFor(JSON.parse(call.messages.filter((message) => message.role === 'tool').at(-1).content), 'totalCount')) }) });
  const retry = await sendTurn({ turnId, message: 'Radar projesinde kaç görev var?' });
  const done = retry.events.find((event) => event.event === 'done').data;
  assert.notEqual(done.assistantMessage.finishReason, 'unavailable');
});

test('authorization id lists are materialized once into keyed temp tables before any membership check', async () => {
  const queries = await import('../src/server/ai/tools/rota/rotaToolQueries.js');
  for (const [name, text] of Object.entries(queries)) {
    const splits = (text.match(/STRING_SPLIT\(@scopeTasks/g) || []).length;
    assert.equal(splits, (text.match(/INSERT #AiScopeTaskIds\(TaskId\)/g) || []).length, `${name}: @scopeTasks is split only to stage #AiScopeTaskIds`);
    assert.doesNotMatch(text, /EXISTS\s*\(\s*SELECT 1 FROM STRING_SPLIT\(@(?:scope|disclosure)/, `${name}: no per-row split of an authorization list`);
  }
  assert.match(queries.AI_TOOL_OUTLOOK_SQL, /SELECT 1 FROM #AiScopeTaskIds permitted WHERE permitted\.TaskId = t\.TaskId/);
  const { CURRENT_TASK_DISCLOSURE_SQL, DISCLOSURE_SCOPE_SETUP_SQL } = await import('../src/server/authorization/disclosureScope.js');
  assert.doesNotMatch(CURRENT_TASK_DISCLOSURE_SQL, /STRING_SPLIT/);
  assert.match(DISCLOSURE_SCOPE_SETUP_SQL, /CREATE TABLE #AiDisclosureTasks\(TaskId uniqueidentifier NOT NULL PRIMARY KEY\)/);
});
