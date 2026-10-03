/**
 * Rota AI alan araçları · yetki, belirlenimci hesaplar ve güvenlik.
 *
 * Araçlar gerçek yetki bağlamı yükleyicisi, gerçek araç SQL kapısı, gerçek
 * yürütücü ve bellek içi SQL Server ikiziyle çalışır; model yerine çağrılar
 * modelin göndereceği biçimde (JSON metni) verilir.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import {
  ADMIN, ALI_1, ALI_2, AYSE, BASELINE_ID, callRotaTool, callRotaTools, LEAD, MEHMET, NOW, OUTSIDER,
  PARTIAL_OTHERS, PROJECTS, rotaToolSeed, TASKS, WBS, ZEYNEP
} from './helpers/aiToolFixtures.mjs';

const toolQueries = await import('../src/server/ai/tools/rota/rotaToolQueries.js');
const { toolSqlGateStatus } = await import('../src/server/ai/tools/toolSqlGate.js');
const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { createToolExecutor } = await import('../src/server/ai/tools/toolExecutor.js');
const { createEvidenceLedger } = await import('../src/server/ai/tools/evidenceLedger.js');

function stackFor(t, overrides = {}, sicil = AYSE) {
  return createAiStack(t, { sicil, seed: rotaToolSeed(overrides) });
}

async function visibleTaskIds(stack, sicil, args = {}) {
  const { result } = await callRotaTool(stack, sicil, 'rota_task_search', { limit: 50, sort: 'title_asc', ...args });
  assert.equal(result.ok, true, JSON.stringify(result));
  return new Set(result.data.tasks.map((task) => task.taskId));
}

/* ── Yetki matrisi ────────────────────────────────────────── */

test('yetki matrisi: sistem yöneticisi, FULL, READ, kısmi, yönetim kapsamı, oluşturan ve ilgisiz kullanıcı yalnızca kendi kapsamını görür', async (t) => {
  const stack = stackFor(t, {
    corporateProjectAccess: [{ Sicil: MEHMET, ProjectCode: 'PRT' }],
    projectAccess: [
      { ProjectId: PROJECTS.READ, Sicil: AYSE, AccessLevel: 'READ', GrantSource: 'MANUAL_GRANT' },
      { ProjectId: PROJECTS.FULL, Sicil: LEAD, AccessLevel: 'FULL', GrantSource: 'MANUAL_GRANT' }
    ]
  });
  const all = [...Object.values(TASKS)].filter((id) => ![TASKS.ARCHIVED, TASKS.DELETED_BASELINE].includes(id));
  // Sistem yöneticisi: bütün ETKİN projelerin bütün görevleri; etkin olmayan proje hiç görünmez.
  const admin = await visibleTaskIds(stack, ADMIN);
  assert.deepEqual([...admin].sort(), [...all, ...PARTIAL_OTHERS].sort());
  const adminDetail = await callRotaTool(stack, ADMIN, 'rota_task_detail', { taskId: TASKS.OVERDUE });
  assert.equal(adminDetail.result.data.task.access.level, 'FULL');
  assert.equal(adminDetail.result.data.task.access.dependenciesAndBaselines, true);
  assert.equal(adminDetail.result.scope.kind, 'complete-projects');
  for (const projectId of [PROJECTS.ARCHIVED, '10000000-0000-4000-8000-00000000abcd']) {
    const missingProject = await callRotaTool(stack, ADMIN, 'rota_task_analytics', { projectId });
    assert.equal(missingProject.result.ok, false);
    assert.equal(missingProject.result.error.code, 'NOT_FOUND', 'sistem yöneticisi etkin olmayan veya var olmayan projeyi sentetik FULL kabul etmez');
  }
  // Proje lideri (FULL) + okuma hibesi (READ) + kendi görevleri (kısmi) + astın görevi (yönetim kapsamı).
  const ayse = await visibleTaskIds(stack, AYSE);
  assert.deepEqual([...ayse].sort(), [
    TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.DONE, TASKS.UNASSIGNED, TASKS.LITERAL, TASKS.SERIES, TASKS.OCCURRENCE_DONE,
    TASKS.OCCURRENCE_OPEN, TASKS.READ_1, TASKS.READ_2, TASKS.PARTIAL_OWN, TASKS.PARTIAL_SHARED, TASKS.TEAM_VISIBLE
  ].sort());
  for (const hidden of [TASKS.HIDDEN, TASKS.TEAM_HIDDEN, TASKS.ARCHIVED, ...PARTIAL_OTHERS]) assert.equal(ayse.has(hidden), false, hidden);
  // Kurumsal proje rolü FULL verir: MEHMET kısmi projenin 10 görevinin hepsini görür.
  const mehmet = await visibleTaskIds(stack, MEHMET, { projectId: PROJECTS.PARTIAL });
  assert.equal(mehmet.size, 10);
  // Manuel FULL hibe projenin bütün görevlerini açar.
  const lead = await visibleTaskIds(stack, LEAD, { projectId: PROJECTS.FULL });
  assert.equal(lead.size, 8);
  // Yalnızca sorumlu olduğu görevler (kısmi): ZEYNEP iki görev görür.
  assert.deepEqual([...await visibleTaskIds(stack, ZEYNEP)].sort(), [TASKS.DUE_SOON, TASKS.TEAM_VISIBLE].sort());
  // Oluşturan: ilgisiz kullanıcı yalnızca kendi açtığı görevi görür.
  assert.deepEqual([...await visibleTaskIds(stack, OUTSIDER)], [TASKS.OUTSIDER_CREATED]);
  // Görünmeyen görev ile var olmayan görev AYNI sonucu verir.
  for (const taskId of [TASKS.HIDDEN, '20000000-0000-4000-8000-00000000abcd']) {
    const { result } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal(result.error.message, 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.');
  }
  const outsiderDetail = await callRotaTool(stack, OUTSIDER, 'rota_task_detail', { taskId: TASKS.OVERDUE });
  assert.equal(outsiderDetail.result.error.code, 'NOT_FOUND');
});

test('kısmi kapsam: 10 görevin 2si görünürken toplamlar yalnızca 2 görevi sayar ve tam proje görünümü iddia edilmez', async (t) => {
  const stack = stackFor(t);
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.PARTIAL });
  assert.equal(result.ok, true);
  assert.equal(result.data.totals.total, 2);
  assert.equal(result.totalCount, 2);
  assert.deepEqual(result.scope.kind, 'authorized-task-subset');
  assert.equal(result.scope.completeProjectView, false);
  assert.equal(ledger.summaries()[0].partial, true, 'kanıt kısmi kapsamı taşır');
  // Portföy de gizli görevleri sayıya katmaz ve projeyi kısmi olarak işaretler.
  const portfolio = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', { includeEmpty: true, limit: 25 });
  const partial = portfolio.result.data.projects.find((project) => project.projectId === PROJECTS.PARTIAL);
  assert.equal(partial.tasks.total, 2);
  assert.equal(partial.completeTaskView, false);
  assert.equal(portfolio.result.scope.kind, 'authorized-task-subset');
  assert.equal(portfolio.result.data.projects.some((project) => project.projectId === PROJECTS.HIDDEN), false);
  // Sistem yöneticisi aynı projede 10 görevi, tam kapsamla görür.
  const admin = await callRotaTool(stack, ADMIN, 'rota_task_analytics', { projectId: PROJECTS.PARTIAL });
  assert.equal(admin.result.data.totals.total, 10);
  assert.equal(admin.result.scope.kind, 'complete-projects');
  assert.equal(admin.ledger.summaries()[0].partial, false);
});

test('gizli eş sorumlu: adı yalnızca kendi görevinde görünür, Sicil’i hiç görünmez; kişi süzgeci onu ortaya çıkaramaz', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.PARTIAL_SHARED });
  assert.equal(result.ok, true);
  const assignees = result.data.task.assignees;
  assert.deepEqual(assignees.find((person) => person.name === 'Ayşe Yılmaz'), { name: 'Ayşe Yılmaz', sicil: AYSE });
  assert.deepEqual(assignees.find((person) => person.name === 'Mehmet Demir'), { name: 'Mehmet Demir', identityHidden: true });
  assert.equal(JSON.stringify(result).includes(String(MEHMET)), false, 'gizli eş sorumlunun Sicil’i hiçbir alanda yok');
  // Kişi süzgeci yalnızca kimliği açık sorumluluklarla eşleşir: kısmi projedeki ortak görev dönmez.
  const filtered = await visibleTaskIds(stack, AYSE, { personSicil: MEHMET });
  assert.equal(filtered.has(TASKS.PARTIAL_SHARED), false);
  assert.deepEqual([...filtered].sort(), [TASKS.DONE, TASKS.READ_1].sort());
  // İş yükünde gizli eş sorumlu kişi olarak sayılmaz.
  const workload = await callRotaTool(stack, AYSE, 'rota_workload_summary', { projectId: PROJECTS.PARTIAL });
  assert.deepEqual(workload.result.data.people.map((person) => person.sicil), [AYSE]);
  assert.equal(workload.result.data.people[0].openTasks, 2);
  assert.equal(Object.hasOwn(workload.result.data.people[0], 'plannedHours'), false, 'kişi-saat tahsisi izlenimi veren alan dönmez');
  assert.equal(Object.hasOwn(workload.result.data.people[0], 'plannedHoursOnAssignedTasks'), true);
  assert.match(workload.result.data.notes.join(' '), /kişi-saat tahsisi değildir/);
  assert.equal(Object.hasOwn(workload.result.data, 'openTasksWithOnlyHiddenAssignees'), false);
  // Oluşturan kimliği kısmi görevde kapalıdır.
  assert.equal(result.data.task.createdBy, null);
});

test('görev ayrıntısında oluşturan kimliği anlık görüntünün READ, sorumluluk ve yönetim kapsamı sınırını izler', async (t) => {
  const ownStack = stackFor(t);
  const shared = ownStack.db.tasks.find((task) => task.TaskId.toLowerCase() === TASKS.PARTIAL_SHARED.toLowerCase());
  shared.CreatedBySicil = MEHMET;
  const viaAssignment = await callRotaTool(ownStack, AYSE, 'rota_task_detail', { taskId: TASKS.PARTIAL_SHARED });
  assert.equal(viaAssignment.result.data.task.createdBy?.sicil, MEHMET, 'kendi sorumluluğundaki görevde oluşturan görünür');

  const executiveStack = stackFor(t);
  const team = executiveStack.db.tasks.find((task) => task.TaskId.toLowerCase() === TASKS.TEAM_VISIBLE.toLowerCase());
  team.CreatedBySicil = LEAD;
  const viaExecutive = await callRotaTool(executiveStack, AYSE, 'rota_task_detail', { taskId: TASKS.TEAM_VISIBLE });
  assert.equal(viaExecutive.result.data.task.createdBy, null, 'yalnız yönetim kapsamı oluşturan kimliğini açmaz');

  const readStack = stackFor(t);
  const readTask = readStack.db.tasks.find((task) => task.TaskId.toLowerCase() === TASKS.READ_1.toLowerCase());
  readTask.CreatedBySicil = MEHMET;
  const viaRead = await callRotaTool(readStack, AYSE, 'rota_task_detail', { taskId: TASKS.READ_1 });
  assert.equal(viaRead.result.data.task.createdBy?.sicil, MEHMET, 'READ görünürlüğünde oluşturan görünür');
});

test('yönetim kapsamı: yönetici yalnızca astının görevini ve onun iş dağılım zincirini görür', async (t) => {
  const stack = stackFor(t);
  const team = await visibleTaskIds(stack, AYSE, { projectId: PROJECTS.TEAM });
  assert.deepEqual([...team], [TASKS.TEAM_VISIBLE]);
  const wbs = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.TEAM, depth: 4 });
  assert.equal(wbs.result.ok, true);
  assert.equal(wbs.result.data.catalogVisibility, 'ancestor-chain-of-visible-tasks');
  assert.deepEqual(wbs.result.data.nodes.map((node) => node.wbsId).sort(), [WBS.TEAM_ROOT, WBS.TEAM_BRANCH, WBS.TEAM_LEAF].sort());
  assert.equal(wbs.result.data.nodes.some((node) => node.wbsId === WBS.TEAM_OTHER), false);
  // Tam projede katalog ve alt ağaç toplamları.
  const full = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 3 });
  assert.equal(full.result.data.catalogVisibility, 'full-catalog');
  const root = full.result.data.nodes.find((node) => node.wbsId === WBS.FULL_ROOT);
  assert.equal(root.subtreeTasks, 8);
  assert.equal(root.directTasks, 6);
  const design = full.result.data.nodes.find((node) => node.wbsId === WBS.FULL_DESIGN);
  assert.equal(design.subtreeTasks, 2);
  assert.equal(design.subtreeOverdue, 1);
  const shallow = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 1 });
  assert.equal(shallow.result.complete, false);
  assert.equal(shallow.result.truncated, true);
  assert.match(shallow.result.data.notes.join(' '), /derinlikte kesildi/);
});

test('döngülü WBS bileşeni düşürülmez ve bozuk yapı açıkça işaretlenir', async (t) => {
  const stack = stackFor(t);
  const root = stack.db.wbs.find((node) => node.WbsId === WBS.FULL_ROOT);
  root.ParentWbsId = WBS.FULL_DETAIL;

  const result = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4 });
  assert.equal(result.result.ok, true);
  assert.deepEqual(
    result.result.data.nodes.map((node) => node.wbsId).sort(),
    [WBS.FULL_ROOT, WBS.FULL_DESIGN, WBS.FULL_DETAIL].sort()
  );
  assert.equal(result.result.data.nodes.every((node) => node.malformedCycle === true), true);
  assert.match(result.result.data.notes.join(' '), /döngü/i);

  const focused = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', {
    projectId: PROJECTS.FULL,
    wbsId: WBS.FULL_DESIGN,
    depth: 4
  });
  assert.equal(focused.result.ok, true);
  assert.deepEqual(
    focused.result.data.nodes.map((node) => node.wbsId).sort(),
    [WBS.FULL_ROOT, WBS.FULL_DESIGN, WBS.FULL_DETAIL].sort()
  );
});

/* ── Belirlenimci hesaplar ────────────────────────────────── */

test('toplamlar belirlenimcidir: durum, gecikme, 7 gün, terminsiz, tamamlanma oranı ve saat kapsaması', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, groupBy: 'deadline' });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.data.totals }, {
    total: 8, todo: 5, inProgress: 1, done: 2, open: 6, overdue: 2, dueToday: 0, dueNext7Days: 2,
    openWithoutTargetFinish: 1, doneWithoutActualFinish: 0, milestonesOpen: 0, completionRatePercent: 25
  });
  assert.deepEqual(result.data.hours.plannedHours, { total: 16, tasksWithValue: 2, tasksWithoutValue: 6 });
  assert.deepEqual(result.data.hours.actualHours, { total: 12, tasksWithValue: 1, tasksWithoutValue: 7 });
  const groups = Object.fromEntries(result.data.groups.map((group) => [group.key, group.count]));
  assert.deepEqual(groups, { overdue: 2, done: 2, due_days_1_to_6: 2, due_days_7_to_29: 1, no_target_finish: 1 });
  assert.equal(result.scope.kind, 'complete-projects');

  const limited = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, groupBy: 'deadline', limit: 3 });
  assert.equal(limited.result.data.groupCount, 5);
  assert.equal(limited.result.data.groups.length, 3);
  assert.equal(limited.result.data.groups.at(-1).key, 'other');
  assert.equal(limited.result.complete, false);
  assert.equal(limited.result.truncated, true);
});

test('Türkiye günü sınırı: UTC 21:30’da termini “dün” olan görev gecikmiştir, bir saat önce bugün terminlidir', async (t) => {
  const stack = stackFor(t);
  const after = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.PARTIAL, deadline: 'overdue' }, { now: NOW });
  assert.deepEqual(after.result.data.tasks.map((task) => task.taskId), [TASKS.PARTIAL_OWN]);
  assert.equal(after.result.data.tasks[0].overdueDays, 1);
  const before = new Date('2026-09-29T20:30:00.000Z');
  const dueToday = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.PARTIAL, deadline: 'due_today' }, { now: before });
  assert.deepEqual(dueToday.result.data.tasks.map((task) => task.taskId), [TASKS.PARTIAL_OWN]);
  const overdueBefore = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.PARTIAL, deadline: 'overdue' }, { now: before });
  assert.equal(overdueBefore.result.totalCount, 0);
});

test('arama sıralı, sayfalı ve kesin toplamlıdır; imleç süzgece bağlıdır', async (t) => {
  const stack = stackFor(t);
  const first = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, sort: 'title_asc', limit: 3 });
  assert.equal(first.result.totalCount, 8);
  assert.equal(first.result.returnedCount, 3);
  assert.equal(first.result.complete, false);
  assert.ok(first.result.nextCursor);
  const second = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, sort: 'title_asc', limit: 3, cursor: first.result.nextCursor });
  assert.equal(second.result.returnedCount, 3);
  assert.equal(new Set([...first.result.data.tasks, ...second.result.data.tasks].map((task) => task.taskId)).size, 6);
  const mismatched = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.READ, sort: 'title_asc', limit: 3, cursor: first.result.nextCursor });
  assert.equal(mismatched.result.error.code, 'INVALID_ARGUMENTS');
  // Gecikme süzgecinde varsayılan sıralama en çok geciken önce.
  const overdue = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue' });
  assert.deepEqual(overdue.result.data.tasks.map((task) => task.taskId), [TASKS.SERIES, TASKS.TEAM_VISIBLE, TASKS.OVERDUE, TASKS.READ_1, TASKS.PARTIAL_OWN]);
  assert.equal(overdue.result.data.sort, 'overdue_days_desc');
});

test('dar görev süzgeçleri SQL satır sınırından önce uygulanır', () => {
  const sqlText = toolQueries.AI_TOOL_TASK_FACTS_SQL;
  const order = sqlText.indexOf('ORDER BY t.TaskId');
  for (const token of ['@statusCsv', '@priorityCsv', '@milestone', '@deadline', '@dateField']) {
    const index = sqlText.indexOf(token);
    assert.ok(index > 0 && index < order, `${token} TOP sınırından önce WHERE içinde uygulanır`);
  }
});

test('AI atama talepleri bildirim kapsamından bağımsız canlı karar yetkisini kullanır', async (t) => {
  const coordinationId = '60000000-0000-4000-8000-000000000001';
  const stack = stackFor(t, {
    executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP, ScopeType: 'DIRECTORATE' }],
    taskAssignmentCoordinations: [{
      CoordinationId: coordinationId,
      TaskId: TASKS.TEAM_VISIBLE,
      RequesterSicil: MEHMET,
      RequestedAssigneeSicil: ZEYNEP,
      Mode: 'REQUEST',
      Status: 'PENDING',
      TaskTitleSnapshot: 'Astın kurulum görevi',
      ProjectIdSnapshot: PROJECTS.TEAM,
      ProjectNameSnapshot: 'Ekip Projesi',
      ProjectCodeSnapshot: 'EKP',
      AssigneeNameSnapshot: 'Zeynep Kaya',
      CreatedAt: '2026-09-29T10:00:00.000Z'
    }]
  });
  const { result } = await callRotaTool(stack, AYSE, 'rota_assignment_requests', { tab: 'pending' });
  assert.equal(result.ok, true);
  assert.equal(result.totalCount, 1);
  assert.equal(result.data.items[0].coordinationId.toLowerCase(), coordinationId.toLowerCase());
  assert.equal(result.data.items[0].you.canDecide, true);
  assert.equal(result.data.items[0].actionRequiredFromYou, true);
});

/* ── SQL güvenliği ────────────────────────────────────────── */

test('tanınmayan araç denemeleri toplam çağrı sınırını tüketir', async (t) => {
  const stack = stackFor(t);
  const limits = { ...TOOL_LIMITS, maxTotalCalls: 2, maxCallsPerRound: 5 };
  const { executor, results } = await callRotaTools(stack, AYSE, [
    ['rota_bilinmeyen_bir', {}],
    ['rota_bilinmeyen_iki', {}]
  ], { limits });
  assert.deepEqual(results.map((result) => result.error.code), ['UNKNOWN_TOOL', 'UNKNOWN_TOOL']);
  const [message] = await executor.runRound([{
    id: 'call_3',
    name: 'rota_task_search',
    arguments: '{}'
  }]);
  const third = JSON.parse(message.content);
  assert.equal(third.error.code, 'LIMIT_EXCEEDED');
  assert.equal((stack.db.aiToolLog || []).length, 0, 'sınırı aşan çağrı SQL çalıştırmaz');
});

test('tur sınırını aşan çağrılar sonraki turların toplam çağrı bütçesini tüketmez', async (t) => {
  const stack = stackFor(t);
  const limits = { ...TOOL_LIMITS, maxCallsPerRound: 2, maxTotalCalls: 3 };
  const { executor, results } = await callRotaTools(stack, AYSE, [
    ['rota_task_search', { projectId: PROJECTS.FULL, limit: 1 }],
    ['rota_task_search', { projectId: PROJECTS.FULL, limit: 1 }],
    ['rota_task_search', { projectId: PROJECTS.FULL, limit: 1 }]
  ], { limits });
  assert.equal(results[2].error.code, 'LIMIT_EXCEEDED');
  const [message] = await executor.runRound([{
    id: 'call_4',
    name: 'rota_task_analytics',
    arguments: JSON.stringify({ projectId: PROJECTS.FULL })
  }]);
  const next = JSON.parse(message.content);
  assert.equal(next.ok, true, JSON.stringify(next));
});

test('SQL enjeksiyonu ve joker karakterler yalnızca veridir; SQL metni hiçbir zaman birleştirilmez', async (t) => {
  const stack = stackFor(t);
  const constants = new Set(Object.values(toolQueries));
  for (const [text, expected] of [["' OR 1=1 --", []], ['%', [TASKS.LITERAL]], ['_', [TASKS.LITERAL]], ['[', [TASKS.LITERAL]], ['[özel]', [TASKS.LITERAL]], ['%50', [TASKS.LITERAL]]]) {
    const { result } = await callRotaTool(stack, AYSE, 'rota_task_search', { text });
    assert.equal(result.ok, true, text);
    assert.deepEqual(result.data.tasks.map((task) => task.taskId), expected, text);
    // Nüfus okuması (sayfa sorumlu izdüşümü ayrı, görev kimlikleriyle okunur).
    const last = stack.db.aiToolLog.filter((entry) => entry.query === 'task-facts' && !entry.params.taskIds).at(-1);
    assert.equal(last?.params.text, text, 'bu çağrının metni parametre olarak gider');
  }
  const project = await callRotaTool(stack, AYSE, 'rota_project_search', { text: "x' UNION SELECT * FROM dbo.MR_Tasks --" });
  assert.equal(project.result.ok, true);
  assert.equal(project.result.totalCount, 0);
  const executed = stack.db.statements.map((entry) => entry.sql).filter((sql) => sql.startsWith('/* rota-ai-tool:'));
  assert.ok(executed.length > 0);
  for (const sql of executed) assert.ok(constants.has(sql), 'çalışan metin sabitlerden biridir');
  const injected = await callRotaTool(stack, AYSE, 'rota_task_search', { sort: "target_finish_asc; DROP TABLE dbo.MR_Tasks" });
  assert.equal(injected.result.error.code, 'INVALID_ARGUMENTS');
  const identity = await callRotaTool(stack, AYSE, 'rota_task_search', { sicil: ADMIN });
  assert.equal(identity.result.error.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(identity.result.error.details, ['$.sicil:unknown']);
});

/* ── Varlık çözümü ────────────────────────────────────────── */

test('görev metin araması SQL Turkish_100_CI_AI I/İ davranışıyla aynıdır', async (t) => {
  const stack = stackFor(t);
  const task = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === TASKS.OVERDUE.toLowerCase());
  task.Title = 'Isparta radar testi';
  const dotless = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, text: 'ısparta' });
  assert.deepEqual(dotless.result.data.tasks.map((row) => row.taskId), [TASKS.OVERDUE]);
  const dotted = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, text: 'isparta' });
  assert.equal(dotted.result.totalCount, 0);
});

test('proje ve kişi araması tahmin etmez: belirsizlik, aynı adlı kişiler ve görünmeyen proje ayrı bildirilir', async (t) => {
  const stack = stackFor(t);
  const exact = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'RDR' });
  assert.equal(exact.result.data.matches[0].projectId, PROJECTS.FULL);
  assert.equal(exact.result.data.matches[0].exactMatch, true);
  assert.equal(exact.result.data.ambiguous, false);
  const many = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'Proje' });
  assert.equal(many.result.data.ambiguous, true);
  assert.ok(many.result.totalCount >= 3);
  assert.equal(many.result.data.matches.some((match) => match.projectId === PROJECTS.HIDDEN), false);
  const hidden = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'Gizli' });
  assert.equal(hidden.result.totalCount, 0);
  const people = await callRotaTool(stack, AYSE, 'rota_person_search', { text: 'Ali Veli' });
  assert.equal(people.result.ok, true);
  assert.deepEqual(people.result.data.people.map((person) => person.sicil).sort(), [ALI_1, ALI_2]);
  assert.equal(people.result.data.ambiguous, true);
  assert.equal(people.result.data.sameNameCount, 1);
  assert.match(people.result.data.guidance, /Sicil/);
});

test('dizin araması kaynak sınırına ulaşırsa kesin toplam bilinmiyor olarak döner', async (t) => {
  const base = rotaToolSeed();
  const people = [
    ...base.people,
    ...Array.from({ length: 30 }, (_, index) => ({
      Sicil: 90000 + index, DisplayName: `Test Kişi ${index + 1}`, Username: `test${index + 1}`
    }))
  ];
  const stack = stackFor(t, { people });
  const capped = await callRotaTool(stack, AYSE, 'rota_person_search', { text: 'Test Kişi', limit: 25 });
  assert.equal(capped.result.returnedCount, 25);
  assert.equal(capped.result.totalCount, null);
  assert.equal(capped.result.complete, false);
  assert.equal(capped.result.truncated, true);

  const exactPeople = [
    ...base.people,
    ...Array.from({ length: 25 }, (_, index) => ({
      Sicil: 91000 + index, DisplayName: `Tam Kişi ${index + 1}`, Username: `tam${index + 1}`
    }))
  ];
  const exactStack = stackFor(t, { people: exactPeople });
  const exact = await callRotaTool(exactStack, AYSE, 'rota_person_search', { text: 'Tam Kişi', limit: 25 });
  assert.deepEqual([exact.result.returnedCount, exact.result.totalCount, exact.result.complete, exact.result.truncated], [25, 25, true, false]);
});

test('proje künyesi erişim nedenini açıklar; READ bağımlılık ve baz planı açmaz', async (t) => {
  const stack = stackFor(t);
  const read = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.READ });
  assert.equal(read.result.data.access.level, 'READ');
  assert.deepEqual(read.result.data.access.reasons, ['Proje erişim hibesi']);
  assert.equal(read.result.data.access.completeTaskView, true);
  assert.equal(read.result.data.access.dependenciesAndBaselines, false);
  assert.equal(read.result.data.visibleTasks.total, 2);
  assert.equal(read.result.data.project.dependencyCount, null);
  assert.equal(read.result.data.project.wbsNodeCount, 0, 'READ erişimi tam WBS kataloğu sayısını da görür');
  const partial = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.PARTIAL });
  assert.equal(partial.result.data.access.level, 'PARTIAL');
  assert.equal(partial.result.data.project.wbsNodeCount, 0, 'kendi görev kapsamı da tam WBS kataloğu sayısını görür');
  assert.ok(partial.result.data.access.reasons.includes('Görev sorumlusu'));
  assert.equal(partial.result.scope.kind, 'authorized-task-subset');
  const full = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.FULL });
  assert.deepEqual(full.result.data.access.reasons, ['Proje lideri']);
  assert.equal(full.result.data.project.dependencyCount, 4);
  assert.equal(full.result.data.project.baselineCount, 1);
  assert.deepEqual(full.result.data.project.tags, ['Savunma']);
  assert.equal(full.result.data.visibleTasks.overdue, 2);
  const hidden = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.HIDDEN });
  assert.equal(hidden.result.error.code, 'NOT_FOUND');
});

test('proje etiketi önizleme sınırına ulaşırsa ayrıntı sonucu eksik işaretlenir', async (t) => {
  const projectTags = Array.from({ length: 21 }, (_, index) => ({
    ProjectId: PROJECTS.FULL, TagName: `Etiket ${index + 1}`, SortOrder: index + 1
  }));
  const stack = stackFor(t, { projectTags });
  const { result } = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.FULL });
  assert.equal(result.data.project.tags.length, 20);
  assert.equal(result.data.project.tagCount, 21);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

/* ── Plan araçları ────────────────────────────────────────── */

test('baz plan karşılaştırması belirlenimci sapma verir; silinmiş görevin kaydı korunur; yalnızca FULL', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_baseline_compare', { projectId: PROJECTS.FULL });
  assert.equal(result.ok, true);
  assert.equal(result.data.baseline.baselineId, BASELINE_ID);
  assert.deepEqual(result.data.counts, {
    snapshotTasks: 4, compared: 3, finishSlipped: 1, finishEarlier: 1, finishUnchanged: 1,
    startSlipped: 0, missingDates: 0, removedSinceBaseline: 1, addedSinceBaseline: 5
  });
  assert.deepEqual(result.data.mostSlipped.map((item) => [item.taskId, item.varianceDays]), [[TASKS.OVERDUE, 5]]);
  assert.deepEqual(result.data.finishVariance, { averageDays: 0.7, maxSlipDays: 5, maxEarlierDays: 3 });
  const read = await callRotaTool(stack, AYSE, 'rota_baseline_compare', { projectId: PROJECTS.READ });
  assert.equal(read.result.error.code, 'UNSUPPORTED_SCOPE');
  const hidden = await callRotaTool(stack, AYSE, 'rota_baseline_compare', { projectId: PROJECTS.HIDDEN });
  assert.equal(hidden.result.error.code, 'NOT_FOUND');
});

test('bağımlılıklar FS/SS/FF/SF ve gecikmeyle okunur; kritik yol hesaplanmaz; READ projede kapalıdır', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.DUE_SOON });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.predecessors.map((item) => [item.taskId, item.type, item.lag.label]), [[TASKS.OVERDUE, 'FS', '+2 gün']]);
  assert.deepEqual(result.data.successors.map((item) => [item.taskId, item.type]), [[TASKS.UNASSIGNED, 'SS']]);
  assert.match(result.data.notes.join(' '), /Kritik yol/);
  const coverage = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { projectId: PROJECTS.FULL });
  assert.deepEqual(coverage.result.data.coverage, {
    taskCount: 8, dependencyCount: 4, tasksWithPredecessor: 4, tasksWithSuccessor: 3, tasksWithoutAnyDependency: 3,
    byType: { FS: 1, SS: 1, FF: 1, SF: 1 }, withPositiveLag: 1, withNegativeLag: 1
  });
  const lead = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.LITERAL });
  assert.equal(lead.result.data.predecessors[0].lag.label, '−1 hafta');

  const legacyStack = stackFor(t);
  const legacyDependency = legacyStack.db.taskDependencies.find((row) => row.TaskId === TASKS.DUE_SOON
    && row.PredecessorTaskId === TASKS.OVERDUE);
  legacyDependency.LagValue = null;
  legacyDependency.LagDays = 3;
  legacyDependency.LagUnit = 'week';
  const legacy = await callRotaTool(legacyStack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.DUE_SOON });
  assert.deepEqual(
    [legacy.result.data.predecessors[0].lag.value, legacy.result.data.predecessors[0].lag.unit, legacy.result.data.predecessors[0].lag.label],
    [3, 'week', '+3 hafta']
  );

  const read = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { projectId: PROJECTS.READ });
  assert.equal(read.result.error.code, 'UNSUPPORTED_SCOPE');
  const readTask = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.READ_2 });
  assert.equal(readTask.result.error.code, 'UNSUPPORTED_SCOPE');
  const missing = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', {});
  assert.equal(missing.result.error.code, 'INVALID_ARGUMENTS');
});

test('tekrar serisi, çalışma takvimi ve plan veri kalitesi ürün kurallarıyla hesaplanır', async (t) => {
  const stack = stackFor(t);
  const series = await callRotaTool(stack, AYSE, 'rota_recurrence_inspect', { taskId: TASKS.OCCURRENCE_OPEN });
  assert.equal(series.result.ok, true);
  assert.equal(series.result.data.series.templateTaskId, TASKS.SERIES);
  assert.equal(series.result.data.series.visibleOccurrences, 2);
  assert.equal(series.result.data.series.open, 1);
  assert.equal(series.result.data.series.done, 1);
  assert.match(series.result.data.series.ruleDescription, /hafta/i);
  assert.deepEqual(series.result.data.series.next.map((item) => item.taskId), [TASKS.OCCURRENCE_OPEN]);
  const adminNonRecurring = await callRotaTool(stack, ADMIN, 'rota_recurrence_inspect', { taskId: TASKS.OVERDUE });
  assert.equal(adminNonRecurring.result.ok, true);
  assert.equal(adminNonRecurring.result.data.recurring, false);
  assert.equal(adminNonRecurring.result.scope.kind, 'complete-projects');
  const calendar = await callRotaTool(stack, AYSE, 'rota_calendar_inspect', { projectId: PROJECTS.FULL, dateFrom: '2026-10-26', dateTo: '2026-10-30' });
  assert.equal(calendar.result.ok, true);
  assert.equal(calendar.result.data.workingDayCount, 4);
  assert.deepEqual(calendar.result.data.holidays, [{ date: '2026-10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' }]);
  assert.deepEqual(calendar.result.data.calendar.workingWeekdays, ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma']);
  const reversed = await callRotaTool(stack, AYSE, 'rota_calendar_inspect', { dateFrom: '2026-10-30', dateTo: '2026-10-26' });
  assert.equal(reversed.result.error.code, 'INVALID_ARGUMENTS');
  const tooLong = await callRotaTool(stack, AYSE, 'rota_calendar_inspect', { dateFrom: '2026-01-01', dateTo: '2027-06-01' });
  assert.equal(tooLong.result.error.code, 'INVALID_ARGUMENTS');
  const quality = await callRotaTool(stack, AYSE, 'rota_data_quality', { projectId: PROJECTS.FULL });
  const counts = Object.fromEntries(quality.result.data.checks.map((check) => [check.id, check.count]));
  assert.deepEqual(counts, { assignee: 1, targetFinish: 1, schedule: 3, wbs: 0 });
  assert.equal(quality.result.data.openTaskCount, 6);
  assert.equal(quality.result.data.completedWithoutActualFinish.count, 0);
});

test('gizli tekrar şablonunun kimliği görünür yineleme üzerinden sızmaz', async (t) => {
  const stack = stackFor(t);
  const templateId = PARTIAL_OTHERS[0];
  const template = stack.db.tasks.find((task) => task.TaskId === templateId);
  const occurrence = stack.db.tasks.find((task) => task.TaskId === TASKS.PARTIAL_OWN);
  template.RecurrenceRule = 'FREQ=WEEKLY;BYDAY=MO';
  occurrence.RecurrenceParentTaskId = templateId;
  occurrence.RecurrenceOccurrenceDate = '2026-10-05';

  const single = await callRotaTool(stack, AYSE, 'rota_recurrence_inspect', { taskId: TASKS.PARTIAL_OWN });
  assert.equal(single.result.ok, true);
  assert.equal(Object.hasOwn(single.result.data.series, 'templateTaskId'), false);
  assert.equal(single.ledger.summaries()[0].entity.id, TASKS.PARTIAL_OWN);

  const detail = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.PARTIAL_OWN });
  assert.equal(Object.hasOwn(detail.result.data.task.recurrence, 'seriesTaskId'), false);

  const listing = await callRotaTool(stack, AYSE, 'rota_recurrence_inspect', { projectId: PROJECTS.PARTIAL });
  const listed = listing.result.data.series.find((item) => item.title === occurrence.Title);
  assert.ok(listed);
  assert.equal(Object.hasOwn(listed, 'templateTaskId'), false);
  assert.equal(JSON.stringify([single.result, detail.result, listing.result, single.ledger.summaries()]).includes(templateId), false);
});

test('plan kalitesi kurumsal dizinde çözülemeyen sorumlu Sicilini sorumlu saymaz', async (t) => {
  const seed = rotaToolSeed();
  const stack = stackFor(t, {
    taskAssignees: [...seed.taskAssignees, { TaskId: TASKS.UNASSIGNED, Sicil: 919999 }]
  });
  const quality = await callRotaTool(stack, AYSE, 'rota_data_quality', { projectId: PROJECTS.FULL });
  const assignee = quality.result.data.checks.find((check) => check.id === 'assignee');
  assert.equal(assignee.count, 1);
  assert.ok(assignee.examples.some((item) => item.taskId === TASKS.UNASSIGNED));
  const unassigned = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, assignee: 'unassigned', limit: 50 });
  assert.ok(unassigned.result.data.tasks.some((item) => item.taskId === TASKS.UNASSIGNED), 'dizinde çözülemeyen Sicil görevi sorumlu saymaz');
  const workload = await callRotaTool(stack, AYSE, 'rota_workload_summary', { projectId: PROJECTS.FULL });
  assert.equal(workload.result.data.unassignedOpenTasks, 1);
  assert.equal(workload.result.data.people.some((person) => person.sicil === 919999), false);
  const grouped = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, groupBy: 'assignee', limit: 25 });
  const unassignedGroup = grouped.result.data.groups.find((group) => group.key === 'unassigned');
  assert.equal(unassignedGroup?.count, 1);
});

/* ── İş akışları ve kişisel veriler ───────────────────────── */

test('Outlook durumu yalnızca kullanıcının kendi aboneliklerinin Rota teslim durumudur', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, AYSE, 'rota_outlook_status', {});
  assert.equal(result.ok, true);
  assert.equal(result.data.activeSubscriptions, 2);
  assert.equal(Object.hasOwn(result.data, 'subscriptionsForTasksNoLongerVisible'), false);
  assert.deepEqual([result.returnedCount, result.totalCount, result.complete], [2, 2, true], 'toplam ve dağılım yalnızca güncel görünür aboneliklerdir');
  assert.deepEqual(result.data.byState, { delivered: 1, failed: 1 });
  assert.equal(result.data.byStateComplete, true);
  assert.equal(result.truncated, false);
  const states = Object.fromEntries(result.data.items.map((item) => [item.task.taskId, item.state]));
  assert.deepEqual(states, { [TASKS.OVERDUE]: 'delivered', [TASKS.DUE_SOON]: 'failed' });
  const failed = result.data.items.find((item) => item.state === 'failed');
  assert.equal(failed.failure.code, 'SMTP_TIMEOUT');
  assert.equal(failed.failure.message, 'E-posta sunucusu zamanında yanıt vermedi.');
  assert.match(result.data.note, /posta kutusu içeriğini bilmez/);
  assert.equal(result.data.items.some((item) => item.task.taskId === TASKS.UNASSIGNED), false, 'başka kullanıcının aboneliği görünmez');
});

test('bildirimler yalnızca okunur: okundu/temizlendi işareti değişmez', async (t) => {
  const stack = stackFor(t, {
    taskNotifications: [{ RecipientSicil: AYSE, Kind: 'TASK_ASSIGNED', TaskId: TASKS.OVERDUE, ActorSicil: LEAD, TaskTitleSnapshot: 'Radar test planı', ProjectNameSnapshot: 'Radar Modernizasyonu', EventKey: 'e1' }],
    taskScheduleChangeRequests: [{ TaskId: TASKS.OVERDUE, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, RequesterMessage: 'Termin kaysın', Status: 'PENDING', OriginalTargetFinish: '2026-09-20', ProposedTargetFinish: '2026-10-10' }]
  });
  const before = JSON.stringify({ notifications: stack.db.taskNotifications, schedule: stack.db.scheduleNotifications });
  const { result } = await callRotaTool(stack, AYSE, 'rota_notifications', {});
  assert.equal(result.ok, true);
  assert.equal(result.data.taskEvents.unread, 1);
  assert.equal(result.data.scheduleRequests.awaitingYourDecision, 1);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.totalCount, null);
  assert.match(result.data.note, /okundu olarak işaretlemez/);
  assert.equal(JSON.stringify({ notifications: stack.db.taskNotifications, schedule: stack.db.scheduleNotifications }), before);
  const requests = await callRotaTool(stack, AYSE, 'rota_schedule_requests', { tab: 'pending' });
  assert.equal(requests.result.ok, true);
  assert.equal(requests.result.totalCount, 1);
  const item = requests.result.data.items[0];
  assert.equal(item.yourRole, 'decision-owner');
  assert.equal(item.awaitingYourDecision, true);
  assert.deepEqual(item.proposedChanges, { targetFinish: { from: '2026-09-20', to: '2026-10-10' } });
  const outsider = await callRotaTool(stack, OUTSIDER, 'rota_schedule_requests', {});
  assert.equal(outsider.result.totalCount, 0, 'katılımcı olmayan talebi göremez');
});

test('hareket geçmişi görünür görevlerle sınırlıdır; ekip kapsamı yöneticiye açıktır; görev süzgeci çalışır', async (t) => {
  const at = '2026-09-29T08:00:00.000Z';
  const event = (id, taskId, projectId, actor, after) => ({
    AuditId: id, OccurredAt: at, ActorSicil: actor, ActorDisplayName: 'Eski Ad', ActionCode: 'UPDATE', EntityType: 'TASK', EntityId: taskId,
    ProjectId: projectId, CorrelationId: `c-${id}`, BeforeJson: JSON.stringify({ Status: 'planned' }), AfterJson: JSON.stringify(after)
  });
  const stack = stackFor(t, {
    auditLog: [
      event(1, TASKS.OVERDUE, PROJECTS.FULL, ZEYNEP, { Status: 'in-progress' }),
      event(2, TASKS.HIDDEN, PROJECTS.HIDDEN, MEHMET, { Status: 'done' }),
      event(3, TASKS.DUE_SOON, PROJECTS.FULL, AYSE, { Status: 'done' })
    ]
  });
  const { result } = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.events, 2, 'görünmeyen görevin hareketi sayılmaz');
  assert.equal(result.data.items.some((item) => item.task.title === 'Gizli görev'), false);
  const filtered = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29', taskId: TASKS.OVERDUE, textFields: ['changes'] });
  assert.equal(filtered.result.totalCount, 1);
  assert.ok(filtered.result.data.items[0].changes.some((line) => line.startsWith('Durum:')));
  const team = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29', scope: 'team' });
  assert.equal(team.result.ok, true);
  const denied = await callRotaTool(stack, ZEYNEP, 'rota_activity_search', { scope: 'team' });
  assert.equal(denied.result.error.code, 'UNSUPPORTED_SCOPE');
  const range = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2024-01-01', dateTo: '2026-01-01' });
  assert.equal(range.result.error.code, 'INVALID_ARGUMENTS');
});


test('hareket geçmişi kısmi kapsamda gizli eş sorumlu adını açığa çıkarmaz', async (t) => {
  const at = '2026-09-29T08:00:00.000Z';
  const stack = stackFor(t, {
    auditLog: [{
      AuditId: 41,
      OccurredAt: at,
      ActorSicil: AYSE,
      ActorDisplayName: 'Ayşe Yılmaz',
      ActionCode: 'UPDATE',
      EntityType: 'TASK',
      EntityId: TASKS.PARTIAL_SHARED,
      ProjectId: PROJECTS.PARTIAL,
      CorrelationId: 'c-hidden-assignee',
      BeforeJson: JSON.stringify({ Status: 'planned', assigneeIds: [AYSE] }),
      AfterJson: JSON.stringify({ Status: 'planned', assigneeIds: [AYSE, MEHMET] })
    }]
  });
  const { result } = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29', textFields: ['changes'] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCount, 1);
  assert.ok(result.data.items[0].changes.includes('Gizli sorumlu bilgisi değişti.'));
  assert.equal(JSON.stringify(result).includes('Mehmet Demir'), false);
});

/* ── Sınırlar, kanıt ve kaynak kullanımı ──────────────────── */

test('çağrı sınırları: turda en fazla beş çağrı yürütülür; tanınmayan araç, bozuk ve aşırı büyük bağımsız değişken güvenli hata alır', async (t) => {
  const stack = stackFor(t);
  const calls = [
    ['rota_task_search', { projectId: PROJECTS.FULL }],
    ['rota_task_search', { projectId: PROJECTS.FULL }],
    ['execute_sql', { sql: 'SELECT 1' }],
    ['rota_task_search', '{bozuk'],
    ['rota_portfolio_summary', {}],
    ['rota_task_analytics', {}],
    ['rota_notifications', {}]
  ];
  const { results, ledger } = await callRotaTools(stack, AYSE, calls);
  assert.equal(results.length, 7, 'her çağrı kimliğine bir sonuç');
  assert.equal(results[0].ok, true);
  assert.equal(results[1].evidenceId, results[0].evidenceId, 'aynı çağrı aynı kanıtı kullanır, SQL yinelenmez');
  assert.equal(results[2].error.code, 'UNKNOWN_TOOL');
  assert.equal(results[3].error.code, 'INVALID_ARGUMENTS');
  assert.equal(results[4].ok, true);
  assert.equal(results[5].error.code, 'LIMIT_EXCEEDED');
  assert.equal(results[6].error.code, 'LIMIT_EXCEEDED');
  assert.deepEqual(ledger.ids(), ['R1', 'R2'], 'kanıt kimlikleri çağrı sırasıyla verilir');
  const factReads = stack.db.aiToolLog.filter((entry) => entry.query === 'task-facts');
  assert.equal(factReads.filter((entry) => !entry.params.taskIds).length, 1, 'liste ve toplam aynı olgu okumasından gelir; yinelenen çağrı yeniden çalışmaz');
  assert.equal(factReads.length, 2, 'sorumlu izdüşümü yalnızca dönen sayfanın görevleri için bir kez okunur');
  assert.equal(factReads[1].params.withAssignees, 1);
  assert.ok(factReads[1].params.taskIds.split(',').length <= 20);
  const oversize = await callRotaTools(stack, AYSE, [['rota_task_search', JSON.stringify({ text: 'a', filler: 'x'.repeat(9000) })]]);
  assert.equal(oversize.results[0].error.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(oversize.results[0].error.details, ['$:tooLarge']);
});

test('sonuç boyutu sınırlıdır: büyük liste kısaltılır ve bildirilir, sığmayan sonuç güvenli hata alır', async (t) => {
  const stack = stackFor(t);
  stack.useSicil(AYSE);
  const big = {
    name: 'rota_big_list', resultPolicy: { rows: ['items'], trim: ['items'] }, version: 1, topic: 'tasks', evidenceKind: 'task-list', timeoutMs: 8000, parameters: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => ({
      data: { items: Array.from({ length: 400 }, (_, index) => ({ index, text: 'x'.repeat(100) })) },
      scope: { kind: 'complete-projects', completeProjectView: true }, complete: true, truncated: false, returnedCount: 400, totalCount: 400, nextCursor: 'abc',
      evidence: { label: 'Büyük liste', highlights: [] }
    })
  };
  const blob = { ...big, name: 'rota_big_blob', handler: async () => ({ ...(await big.handler()), data: { blob: 'y'.repeat(40000) } }) };
  const context = createToolTurnContext({ sicil: AYSE, now: NOW });
  const ledger = createEvidenceLedger();
  const executor = createToolExecutor({ context, ledger, signal: new AbortController().signal, resolveTool: (name) => ({ rota_big_list: big, rota_big_blob: blob }[name] || null) });
  const [list, huge] = await executor.runRound([{ id: 'a', name: 'rota_big_list', arguments: '{}' }, { id: 'b', name: 'rota_big_blob', arguments: '{}' }]);
  const shrunk = JSON.parse(list.content);
  assert.ok(Buffer.byteLength(list.content) <= TOOL_LIMITS.maxResultBytes);
  assert.equal(shrunk.truncated, true);
  assert.equal(shrunk.complete, false);
  assert.equal(shrunk.nextCursor, null);
  assert.ok(shrunk.data.items.length < 400);
  assert.match(shrunk.data.sizeNote, /boyut sınırı/);
  assert.equal(JSON.parse(huge.content).error.code, 'RESULT_TOO_LARGE');
  assert.equal(ledger.summaries()[0].truncated, true);

  const hardLimits = { ...TOOL_LIMITS, maxTotalResultBytes: 140 };
  const boundedExecutor = createToolExecutor({
    context: createToolTurnContext({ sicil: AYSE, now: NOW, limits: hardLimits }),
    ledger: createEvidenceLedger(),
    signal: new AbortController().signal,
    limits: hardLimits
  });
  const boundedMessages = await boundedExecutor.runRound(
    Array.from({ length: 5 }, (_, index) => ({ id: `limit_${index}`, name: `unknown_${index}`, arguments: '{}' }))
  );
  const emittedBytes = boundedMessages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0);
  assert.ok(emittedBytes <= hardLimits.maxTotalResultBytes);
  assert.equal(boundedExecutor.stats().resultBytes, emittedBytes);
});

test('kanıt defteri modele verilen güvenli sonucu saklar; veri içindeki talimat ve atıf işaretleri nötrlenir', async (t) => {
  const stack = stackFor(t);
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.LITERAL, textFields: ['description'] });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceId, 'R1');
  assert.equal(result.data.task.description.includes('【'), false);
  assert.match(result.data.task.description, /\(R7\)/);
  const [row] = ledger.persistable(['R1']);
  assert.equal(row.toolName, 'rota_task_detail');
  assert.equal(row.evidenceType, 'task-detail');
  assert.equal(row.entityType, 'task');
  assert.equal(row.entityId, TASKS.LITERAL);
  const persisted = JSON.parse(row.evidenceJson);
  assert.match(persisted.authorizationEpoch, /^[a-f0-9]{64}$/);
  assert.deepEqual(persisted.authorizationReferences, [{ taskId: TASKS.LITERAL, projectId: PROJECTS.FULL }]);
  assert.equal(persisted.scopedAuthorization.version, 1);
  assert.match(persisted.scopedAuthorization.epoch, /^[a-f0-9]{64}$/);
  delete persisted.authorizationEpoch;
  delete persisted.authorizationReferences;
  delete persisted.scopedAuthorization;
  assert.deepEqual(persisted, result);
  assert.doesNotMatch(row.evidenceJson + row.summaryJson, /@scope|#AiScope|STRING_SPLIT|isAdmin|scopeProjects/);
  assert.equal(result.generatedAt.endsWith('Z'), true);
  assert.equal(result.today, '2026-09-30');
});

test('araç SQL kapısı sorgu gerçekten bitince bırakılır; iptal edilen tur yer tutmaya devam etmez', async (t) => {
  const stack = stackFor(t);
  let release;
  stack.db.queryBarrier = { match: (sql) => sql.includes('rota-ai-tool:task-facts'), entered: 0, released: new Promise((resolve) => { release = resolve; }) };
  const cancel = new AbortController();
  const pending = callRotaTools(stack, AYSE, [['rota_task_search', {}]], { signal: cancel.signal });
  while (stack.db.queryBarrier.entered === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolSqlGateStatus().active, 1);
  cancel.abort();
  await assert.rejects(pending, (error) => error.code === 'AI_CANCELLED');
  assert.equal(toolSqlGateStatus().active, 1, 'sürücüdeki sorgu bitmeden yer bırakılmaz');
  release();
  for (let index = 0; index < 20 && toolSqlGateStatus().active; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolSqlGateStatus().active, 0);
  stack.db.queryBarrier = null;
  const after = await callRotaTool(stack, AYSE, 'rota_task_search', {});
  assert.equal(after.result.ok, true);
  assert.equal(toolSqlGateStatus().active, 0);
});

test('yetki bağlamı her araç kümesinde yeniden okunur ve kümedeki çağrılar arasında paylaşılır', async (t) => {
  const stack = stackFor(t);
  stack.useSicil(AYSE);
  const context = createToolTurnContext({ sicil: AYSE, now: NOW });
  const executor = createToolExecutor({
    context,
    ledger: createEvidenceLedger(),
    signal: new AbortController().signal
  });
  await executor.runRound([
    { id: 'call_1', name: 'rota_task_search', arguments: '{}' },
    { id: 'call_2', name: 'rota_portfolio_summary', arguments: '{}' }
  ]);
  assert.equal(context.stats().authorizationLoads, 1);
  stack.db.projectAccess = [];
  await executor.runRound([{ id: 'call_3', name: 'rota_task_search', arguments: '{}' }]);
  assert.equal(context.stats().authorizationLoads, 2, 'aynı çağrı yeni turda önceki yetkiyle önbellekten dönmez');
  const [detail] = await executor.runRound([{
    id: 'call_4',
    name: 'rota_project_detail',
    arguments: JSON.stringify({ projectId: PROJECTS.READ })
  }]);
  assert.equal(JSON.parse(detail.content).error.code, 'NOT_FOUND');
  assert.equal(context.stats().authorizationLoads, 3);
});

test('admins can use every explicit active-project gate while archived and unknown projects remain hidden', async (t) => {
  const stack = stackFor(t);
  for (const name of ['rota_task_search', 'rota_task_analytics', 'rota_project_detail', 'rota_wbs_inspect', 'rota_baseline_compare', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_calendar_inspect']) {
    const { result } = await callRotaTool(stack, ADMIN, name, { projectId: PROJECTS.FULL });
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    const absent = await callRotaTool(stack, ADMIN, name, { projectId: PROJECTS.ARCHIVED });
    assert.equal(absent.result.error.code, 'NOT_FOUND', name);
  }
});

test('all task-population analysis paths fail closed before processing an oversized project', async (t) => {
  const extraTasks = Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({
    TaskId: `29000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, ProjectId: PROJECTS.FULL,
    Title: 'Budget sentinel', Status: 'planned', Priority: 'medium', CreatedBySicil: AYSE
  }));
  const stack = stackFor(t, { tasks: extraTasks });
  for (const [name, args] of [
    ['rota_task_search', { projectId: PROJECTS.FULL }],
    ['rota_task_analytics', { projectId: PROJECTS.FULL }],
    ['rota_portfolio_summary', { limit: 1, source: 'manual' }],
    ['rota_project_detail', { projectId: PROJECTS.FULL }],
    ['rota_wbs_inspect', { projectId: PROJECTS.FULL }],
    ['rota_baseline_compare', { projectId: PROJECTS.FULL }]
  ]) {
    const { result, ledger } = await callRotaTool(stack, ADMIN, name, args);
    assert.equal(result.error?.code, 'RESULT_TOO_LARGE', `${name}: ${JSON.stringify(result)}`);
    assert.equal(ledger.size(), 0);
  }
});

test('assignment fan-out has its own analyzed-row sentinel', async (t) => {
  const taskAssignees = Array.from({ length: TOOL_LIMITS.maxAnalyzedAssignments + 1 }, (_, index) => ({ TaskId: TASKS.OVERDUE, Sicil: index + 50000 }));
  const stack = stackFor(t, { taskAssignees });
  const { result } = await callRotaTool(stack, ADMIN, 'rota_task_detail', { taskId: TASKS.OVERDUE });
  assert.equal(result.error?.code, 'RESULT_TOO_LARGE');
});

test('oversized baseline snapshots stop before the added-task anti-join', async (t) => {
  const taskBaselineSnapshots = Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({
    BaselineId: BASELINE_ID, TaskId: `28000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  }));
  const stack = stackFor(t, { taskBaselineSnapshots });
  const { result } = await callRotaTool(stack, ADMIN, 'rota_baseline_compare', { projectId: PROJECTS.FULL });
  assert.equal(result.error?.code, 'RESULT_TOO_LARGE');
});

test('model generation between rounds does not consume the accumulated tool-execution budget', async () => {
  let time = 0;
  const tool = {
    name: 'rota_timing', topic: 'tasks', evidenceKind: 'task-list', timeoutMs: 8000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => { time += 1000; return { data: { tasks: [] }, complete: true, scope: { kind: 'complete-projects' }, evidence: { label: 'Timing' } }; }
  };
  const executor = createToolExecutor({
    context: { sicil: AYSE, today: '2026-10-01', beginRound() {} }, ledger: createEvidenceLedger(),
    signal: new AbortController().signal, clock: () => time, resolveTool: () => tool,
    limits: { ...TOOL_LIMITS, maxToolPhaseMs: 2500 }
  });
  const invoke = async (id) => JSON.parse((await executor.runRound([{ id, name: tool.name, arguments: '{}' }]))[0].content);
  assert.equal((await invoke('first')).ok, true);
  time += 60000;
  assert.equal((await invoke('second')).ok, true);
  time += 60000;
  // Tool time continues accumulating even when the model uses no tool budget.
  assert.equal((await invoke('third')).ok, true);
  assert.equal((await invoke('fourth')).error.code, 'LIMIT_EXCEEDED');
});

test('a cumulative-budget rejection cannot create an undisclosed ledger entry, including the exact boundary', async () => {
  const tool = {
    name: 'rota_budget', topic: 'tasks', evidenceKind: 'task-list', timeoutMs: 8000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ data: { value: 'x' }, complete: true, scope: { kind: 'complete-projects' }, evidence: { label: 'Budget' } })
  };
  const context = { sicil: AYSE, today: '2026-10-01', beginRound() {} };
  const run = async (maxBytes) => {
    const ledger = createEvidenceLedger();
    const executor = createToolExecutor({ context, ledger, signal: new AbortController().signal, resolveTool: () => tool,
      limits: { ...TOOL_LIMITS, maxTotalResultBytes: maxBytes } });
    const [message] = await executor.runRound([{ id: 'budget', name: tool.name, arguments: '{}' }]);
    return { ledger, message };
  };
  const accepted = await run(10000);
  const bytes = Buffer.byteLength(accepted.message.content);
  const rejected = await run(bytes - 1);
  assert.equal(JSON.parse(rejected.message.content).error.code, 'LIMIT_EXCEEDED');
  assert.deepEqual(rejected.ledger.ids(), []);
  assert.deepEqual(rejected.ledger.payloads(), []);
  const exact = await run(bytes);
  assert.equal(JSON.parse(exact.message.content).evidenceId, 'R1');
  assert.deepEqual(exact.ledger.ids(), ['R1']);
});

test('partial unassigned searches and quality metrics do not depend on hidden assignments', async (t) => {
  const stack = stackFor(t);
  const context = createToolTurnContext({ sicil: AYSE, now: NOW, loadAuthorization: async () => ({
    sicil: AYSE, isExecutive: true,
    effective: { access: new Map([[PROJECTS.TEAM, { accessLevel: 'PARTIAL', reasons: ['EXECUTIVE_SCOPE'] }]]),
      partialTaskIds: new Set([TASKS.TEAM_VISIBLE]) }
  }) });
  const executor = createToolExecutor({ context, ledger: createEvidenceLedger(), signal: new AbortController().signal });
  stack.db.taskAssignees = [];
  const read = async () => (await executor.runRound([
    { id: 'search', name: 'rota_task_search', arguments: JSON.stringify({ projectId: PROJECTS.TEAM, assignee: 'unassigned' }) },
    { id: 'analytics', name: 'rota_task_analytics', arguments: JSON.stringify({ projectId: PROJECTS.TEAM, assignee: 'unassigned' }) },
    { id: 'quality', name: 'rota_data_quality', arguments: JSON.stringify({ projectId: PROJECTS.TEAM }) }
  ])).map((message) => JSON.parse(message.content));
  const before = await read();
  stack.db.taskAssignees.push({ TaskId: TASKS.TEAM_VISIBLE, Sicil: MEHMET });
  const after = await read();
  before.forEach((result, index) => {
    assert.equal(result.ok, true);
    assert.equal(after[index].ok, true);
    assert.deepEqual(after[index].data, result.data);
    assert.equal(after[index].totalCount, result.totalCount);
  });
  assert.equal(after[0].totalCount, 1);
  stack.db.taskAssignees = Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({ TaskId: TASKS.TEAM_VISIBLE, Sicil: index + 50000 }));
  const hiddenFanout = await read();
  hiddenFanout.forEach((result, index) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, before[index].data);
  });
  assert.match(toolQueries.AI_TOOL_TASK_FACTS_SQL, /COUNT\(CASE WHEN permitted.IdentityVisible = 1 THEN resolved.Sicil END\)/);
});

test('Outlook hidden membership never affects visible counts, completeness or evidence metadata', async (t) => {
  const stack = stackFor(t);
  const first = await callRotaTool(stack, AYSE, 'rota_outlook_status');
  for (let index = 0; index < 7; index += 1) {
    const id = `2a000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    stack.db.tasks.push({ TaskId: id, ProjectId: PROJECTS.HIDDEN, Title: 'Hidden membership', Status: 'planned' });
    stack.db.taskOutlookSubscriptions.push({ TaskId: id, ProjectId: PROJECTS.HIDDEN, UserSicil: AYSE, IsActive: true });
  }
  const second = await callRotaTool(stack, AYSE, 'rota_outlook_status');
  assert.deepEqual(second.result.data, first.result.data);
  assert.deepEqual(second.ledger.summaries()[0].counts, first.ledger.summaries()[0].counts);
  assert.equal(second.ledger.summaries()[0].label, first.ledger.summaries()[0].label);
  const hidden = await callRotaTool(stack, AYSE, 'rota_outlook_status', { taskId: TASKS.HIDDEN });
  const absent = await callRotaTool(stack, AYSE, 'rota_outlook_status', { taskId: '20000000-0000-4000-8000-00000000ffff' });
  assert.deepEqual(hidden.result, absent.result);
  assert.equal(hidden.result.error.code, 'NOT_FOUND');
});

test('no baseline returns deterministically without staging an oversized task population', async (t) => {
  const tasks = Array.from({ length: TOOL_LIMITS.maxAnalyzedTasks + 1 }, (_, index) => ({
    TaskId: `2b000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    ProjectId: PROJECTS.FULL, Title: 'Task', Status: 'planned'
  }));
  const stack = stackFor(t, { tasks, baselines: [], taskBaselineSnapshots: [] });
  const { result } = await callRotaTool(stack, ADMIN, 'rota_baseline_compare', { projectId: PROJECTS.FULL });
  assert.equal(result.ok, true);
  assert.equal(result.data.baseline, null);
  const sql = toolQueries.AI_TOOL_BASELINE_SQL;
  assert.doesNotMatch(sql, /\bRowCount\b/);
  assert.ok(sql.indexOf('IF @selectedBaseline IS NOT NULL') < sql.indexOf('INSERT #AiScopeTasks'));
  assert.match(toolQueries.AI_TOOL_PROJECT_SEARCH_SQL, /LEN\(@text\) = 0 AND @projectId IS NOT NULL/);
});

test('project source and activity changes expose canonical types alongside display labels', async (t) => {
  const stack = stackFor(t, { auditLog: [{ AuditId: 99, OccurredAt: '2026-09-29T08:00:00Z',
    ActorSicil: AYSE, ActorDisplayName: 'Ayşe Yılmaz', ActionCode: 'UPDATE', EntityType: 'TASK',
    EntityId: TASKS.OVERDUE, ProjectId: PROJECTS.FULL, CorrelationId: 'typed-changes',
    BeforeJson: JSON.stringify({ Title: 'Alfa', Progress: 20, TargetFinish: '2026-10-01', IsMilestone: false }),
    AfterJson: JSON.stringify({ Title: 'Alfa', Progress: 30, TargetFinish: '2026-10-15', IsMilestone: true }) }] });
  const search = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'Kısmi' });
  assert.equal(search.result.data.matches[0].sourceType, 'corporate');
  const detail = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.PARTIAL });
  assert.equal(detail.result.data.project.sourceType, 'corporate');
  const activity = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'custom', dateFrom: '2026-09-29' });
  assert.deepEqual(activity.result.data.items[0].structuredChanges, [
    { field: 'progress', before: 20, after: 30 }, { field: 'targetFinish', before: '2026-10-01', after: '2026-10-15' },
    { field: 'milestone', before: false, after: true }
  ]);
});

test('AI completion rates share product rounding and empty-set semantics', async (t) => {
  const { selectTaskStats } = await import('../src/scheduling/metrics/index.js');
  const tasks = [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.DONE].map((id) => ({ TaskId: id, ProjectId: PROJECTS.FULL,
    Title: 'Completion', Status: id === TASKS.DONE ? 'done' : 'planned' }));
  const stack = stackFor(t, { tasks });
  const product = selectTaskStats(tasks.map((task) => ({ status: task.Status === 'done' ? 'done' : 'todo' })));
  const analytics = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL });
  const project = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.FULL });
  assert.equal(analytics.result.data.totals.completionRatePercent, product.compRate);
  assert.equal(project.result.data.visibleTasks.completionRatePercent, product.compRate);
  const empty = await callRotaTool(stack, AYSE, 'rota_task_analytics', { text: 'No matching title' });
  assert.equal(empty.result.data.totals.completionRatePercent, selectTaskStats([]).compRate);
});
