import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sql from 'mssql';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const ACTOR = 810001;
const EMPLOYEE = 810002;
const OUTSIDER = 810003;
const OWNER = 810004;
const MISSING = 810005;
const OTHER_MANAGER = 810006;
const id = (number) => `b0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sortedIds = (rows) => rows.map((row) => row.id).sort();

function seed(mode) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [ACTOR, EMPLOYEE, OUTSIDER, OWNER, OTHER_MANAGER].map((Sicil) => ({
      Sicil, DisplayName: [EMPLOYEE, OUTSIDER].includes(Sicil) ? 'Aynı Ad Soyad' : `Kişi ${Sicil}`
    })),
    systemAdminSicils: mode === 'admin' ? [ACTOR] : [],
    projects: [
      { ProjectId: id(1), ProjectName: 'Etkin', SourceType: mode === 'corporate' ? 'CORPORATE' : 'MANUAL',
        ProjectCode: 'P1', LeadSicil: mode === 'lead' ? ACTOR : OWNER, CalendarId: DEFAULT_CALENDAR_ID },
      { ProjectId: id(2), ProjectName: 'Atanabilir', SourceType: 'CORPORATE', ProjectCode: 'P2', CalendarId: DEFAULT_CALENDAR_ID },
      { ProjectId: id(3), ProjectName: 'Kapalı', IsActive: 0, LeadSicil: ACTOR }
    ],
    corporateProjectAccess: mode === 'corporate' ? [{ ProjectCode: 'P1', Sicil: ACTOR }] : [],
    projectAccess: ['full', 'read'].includes(mode)
      ? [{ ProjectId: id(1), Sicil: ACTOR, AccessLevel: mode.toUpperCase() }] : [],
    executiveScope: [
      { ManagerSicil: OTHER_MANAGER, EmployeeSicil: OUTSIDER },
      ...(['executive', 'assignment-only'].includes(mode) ? [
        { ManagerSicil: ACTOR, EmployeeSicil: EMPLOYEE, ScopeType: 'UNIT' },
        { ManagerSicil: ACTOR, EmployeeSicil: EMPLOYEE, ScopeType: 'DEPARTMENT' }
      ] : [])
    ],
    wbs: [
      { WbsId: id(21), ProjectId: id(1), Code: '1', Name: 'Kök' },
      { WbsId: id(22), ProjectId: id(1), ParentWbsId: id(21), Code: '1.1', Name: 'Görev düğümü' },
      { WbsId: id(23), ProjectId: id(1), ParentWbsId: id(21), Code: '1.2', Name: 'Diğer düğüm' },
      { WbsId: id(24), ProjectId: id(2), Code: '1', Name: 'Atama kökü' },
      { WbsId: id(25), ProjectId: id(3), Code: '1', Name: 'Kapalı kök' }
    ],
    tasks: [11, 12, 13, 14, 15, 16].map((number) => ({
      TaskId: id(number), ProjectId: id(number === 16 ? 3 : 1), WbsId: id(number === 16 ? 25 : 22),
      Title: `Görev ${number}`, CreatedBySicil: mode === 'creator' && number === 13 ? ACTOR : OWNER
    })),
    taskAssignees: [
      { TaskId: id(11), Sicil: mode === 'own' ? ACTOR : OWNER },
      { TaskId: id(11), Sicil: OUTSIDER },
      { TaskId: id(11), Sicil: MISSING },
      { TaskId: id(12), Sicil: mode === 'assignment-only' ? OWNER : EMPLOYEE },
      { TaskId: id(12), Sicil: OUTSIDER },
      { TaskId: id(13), Sicil: OUTSIDER },
      { TaskId: id(14), Sicil: OUTSIDER },
      { TaskId: id(16), Sicil: ACTOR }
    ],
    taskDependencies: [{ ProjectId: id(1), TaskId: id(12), PredecessorTaskId: id(14) }],
    baselines: [{ BaselineId: id(31), ProjectId: id(1), Name: 'Plan', CreatedAt: '2026-09-01', IsPrimary: 1 }],
    taskBaselineSnapshots: [{ BaselineId: id(31), TaskId: id(12) }]
  };
}

async function payload() {
  const { GET } = await import('../src/app/api/mergen-rota/snapshot/route.js');
  const response = await GET(new Request('http://localhost/api/mergen-rota/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'automatic' }
  }));
  assert.equal(response.status, 200);
  return response.json();
}

for (const mode of ['admin', 'lead', 'corporate', 'full', 'read', 'creator', 'own', 'executive', 'assignment-only', 'none']) {
  test(`birleşik snapshot SQL: ${mode} yetki ve API yükü korunur`, async () => {
    const stack = await createActualStack(seed(mode), { sicil: ACTOR, corporateWbsSource: false });
    try {
      stack.db.statements.length = 0;
      stack.db.transactions.length = 0;
      const body = await payload();
      const full = ['admin', 'lead', 'corporate', 'full'].includes(mode);
      const broad = full || mode === 'read';
      const expectedTasks = broad ? [11, 12, 13, 14, 15]
        : ({ creator: [13], own: [11], executive: [12] }[mode] || []);
      assert.deepEqual(sortedIds(body.tasks), expectedTasks.map(id));
      assert.deepEqual(sortedIds(body.projects), (mode === 'admin' ? [1, 2] : expectedTasks.length ? [1] : []).map(id));
      if (body.projects.length) assert.equal(body.projects[0].accessLevel, full ? 'FULL' : 'PARTIAL');
      assert.deepEqual(sortedIds(body.wbs), (mode === 'admin' ? [21, 22, 23, 24]
        : broad || ['creator', 'own'].includes(mode) ? [21, 22, 23]
          : mode === 'executive' ? [21, 22] : []).map(id));
      assert.equal(body.tasks.reduce((count, task) => count + task.deps.length, 0), full ? 1 : 0);
      assert.equal(body.baselines.length, full ? 1 : 0);
      assert.equal(body.taskBaselineSnapshots.length, full ? 1 : 0);
      assert.equal(body.session.currentUser.employeeNo, String(ACTOR));
      assert.equal(body.session.isSystemAdmin, mode === 'admin');
      assert.deepEqual(body.assignmentScopeSicils, ['executive', 'assignment-only'].includes(mode) ? [String(EMPLOYEE)] : []);
      assert.deepEqual(sortedIds(body.assignableProjects), mode === 'admin' || ['executive', 'assignment-only'].includes(mode) ? [id(2)] : []);
      for (const task of body.tasks) {
        const stored = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === task.id);
        assert.equal(task.version, stored.RowVersion.toString('base64'));
        assert.equal(task.assigneeIds.includes('null'), false);
      }
      if (mode === 'own') {
        const task = body.tasks[0];
        assert.deepEqual(task.assigneeIds, [String(ACTOR)]);
        assert.deepEqual(task.assigneeDisplayNames, [`Kişi ${ACTOR}`, 'Aynı Ad Soyad']);
        assert.deepEqual(task.assigneeAvatarIdentities, [
          { name: `Kişi ${ACTOR}`, employeeNo: String(ACTOR) },
          { name: 'Aynı Ad Soyad', employeeNo: String(OUTSIDER) }
        ]);
        assert.equal(body.people.some((person) => person.id === String(OUTSIDER)), false);
        assert.equal(JSON.stringify(body).includes(String(MISSING)), false);
        assert.equal(task.assigneeCount, 3);
      }
      if (mode === 'executive') {
        assert.deepEqual(body.tasks[0].assigneeIds, [String(EMPLOYEE)]);
        assert.equal(JSON.stringify(body).includes(String(OUTSIDER)), false);
        assert.equal(body.tasks[0].createdBySicil, null);
        assert.equal(body.tasks[0].createdByName, null);
      }
      if (broad) {
        const task = body.tasks.find((row) => row.id === id(12));
        assert.deepEqual(task.assigneeIds, [String(EMPLOYEE), String(OUTSIDER)]);
        assert.deepEqual(task.assigneeDisplayNames, ['Aynı Ad Soyad', 'Aynı Ad Soyad']);
        assert.deepEqual(task.assigneeAvatarIdentities.map((person) => person.employeeNo), [String(EMPLOYEE), String(OUTSIDER)]);
      }
      const batches = stack.db.statements.filter((entry) => entry.sql.includes('CREATE TABLE #VisibleProjects'));
      assert.equal(batches.length, 1);
      assert.equal(stack.db.statements.some((entry) => entry.sql.includes('STRING_SPLIT(@taskIds')), false);
      // Pahalı kurumsal görünümler toplu işte BİR KEZ okunur.
      assert.equal((batches[0].sql.match(/FROM dbo\.MR_V_ExecutiveScope\b/g) || []).length, 1);
      assert.equal((batches[0].sql.match(/dbo\.MR_V_CorporateProjectAccess\b/g) || []).length, 1);
      assert.equal((batches[0].sql.match(/dbo\.MR_V_PeopleDirectory\b/g) || []).length, 1);
      assert.match(batches[0].sql, /SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope\s+WHERE ManagerSicil = @sicil/);
      assert.match(batches[0].sql, /JOIN #VisibleTasks visible ON visible\.TaskId = t\.TaskId/);
      assert.match(batches[0].sql, /JOIN #VisibleTasks visible ON visible\.TaskId = ta\.TaskId/);
      // Sorumlu sayımı satır başına değil tek toplamada ve yalnızca GÖRÜNÜR
      // görevler için çözülür.
      assert.equal((batches[0].sql.match(/SELECT COUNT\(\*\) FROM dbo\.MR_TaskAssignees/g) || []).length, 0);
      assert.match(batches[0].sql, /INSERT #TaskAssigneeFacts\(TaskId, AssigneeCount\)\s+SELECT ta\.TaskId, COUNT\(\*\)\s+FROM dbo\.MR_TaskAssignees ta\s+JOIN #VisibleTasks visible ON visible\.TaskId = ta\.TaskId/);
      assert.equal(stack.db.transactions.filter((entry) => entry.isolationLevel === sql.ISOLATION_LEVEL.SERIALIZABLE).length, 1);
    } finally { await stack.dispose(); }
  });
}

test('gerçek anlık görüntü isteği SQL ve izdüşüm alt fazlarını ayrı ayrı bildirir', async () => {
  const { resetTelemetryRegistryForTests, snapshotOperations } =
    await import('../src/server/observability/telemetryRegistry.js');
  const stack = await createActualStack(seed('read'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    resetTelemetryRegistryForTests();
    await payload();
    const names = new Set(snapshotOperations().map((entry) => entry.operation));
    // Var olan üretim ölçümleri KORUNUR; yeni adlar onların altındadır.
    for (const operation of [
      'api.snapshot',
      'phase.snapshot.transaction',
      'phase.snapshot.main-query',
      'phase.snapshot.main-query.sql',
      'phase.snapshot.main-query.projection',
      'phase.snapshot.main-query.sql.scope',
      'phase.snapshot.main-query.sql.task-scope',
      'phase.snapshot.main-query.sql.directory',
      'phase.snapshot.main-query.sql.result-sets',
      'phase.snapshot.authorization',
      'phase.snapshot.response'
    ]) {
      assert.ok(names.has(operation), operation);
    }
    for (const entry of snapshotOperations()) {
      if (entry.operation.startsWith('phase.snapshot.main-query')) assert.equal(entry.errorCount, 0);
    }
  } finally {
    resetTelemetryRegistryForTests();
    await stack.dispose();
  }
});

test('yönetici kapsamı her snapshot içinde yeniden okunur', async () => {
  const stack = await createActualStack(seed('executive'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    assert.equal((await payload()).tasks.length, 1);
    stack.db.executiveScope = [];
    const revoked = await payload();
    assert.deepEqual(revoked.tasks, []);
    assert.deepEqual(revoked.projects, []);
    assert.deepEqual(revoked.assignmentScopeSicils, []);
    assert.deepEqual(revoked.assignableProjects, []);
  } finally { await stack.dispose(); }
});

test('sorumlu SQL işi ana faza taşınır; ölçüm sınırları ve hata anlamı korunur', () => {
  const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const main = read('../src/server/repository/sqlAppRepository.js');
  const projected = read('../src/server/repository/projectedSqlAppRepository.js');
  const route = read('../src/app/api/mergen-rota/snapshot/route.js');
  assert.match(main, /observePhase\('phase.snapshot.main-query', \(\) => loadSnapshotFrom\(connection, auth\)\)/);
  assert.match(main, /observePhase\('phase.snapshot.authorization'/);
  for (const phase of ['transaction', 'default-calendar', 'schedule-inbox', 'session', 'catalog']) {
    assert.ok(projected.includes(`phase.snapshot.${phase}`));
  }
  assert.match(route, /phase.snapshot.response/);
  assert.match(route, /withRouteObservability\('api.snapshot'/);
  assert.doesNotMatch(projected, /phase.snapshot.assignees|STRING_SPLIT|taskIds/);

  // Yeni alt ölçümler var olan ana ölçümün İÇİNDE kalır: SQL beklemesi ile
  // JavaScript izdüşümü ayrı görülebilir, `phase.snapshot.main-query` adı ve
  // kapsamı değişmez.
  assert.match(main, /observePhase\('phase.snapshot.main-query.sql', \(\) => req.query\(/);
  assert.match(main, /'phase.snapshot.main-query.projection',\s+async \(\) => projectSnapshotRecordsets\(/);
  const loadBody = main.split('async function loadSnapshotFrom(')[1].split('function projectSnapshotRecordsets(')[0];
  assert.ok(
    loadBody.indexOf("observePhase('phase.snapshot.main-query.sql'")
      < loadBody.indexOf("'phase.snapshot.main-query.projection'"),
    'SQL ölçümü izdüşüm ölçümünden önce kapanmalıdır'
  );
});
