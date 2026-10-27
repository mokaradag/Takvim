/**
 * Görev atama kapsamının YAZMA sınırı ve plan bütünlüğü.
 *
 * Zincir gerçek kodla kurulur: istemci deposu → rota gövdeleri → sertleştirilmiş
 * SQL deposu → bellek içi SQL Server ikizi.
 *
 * Sınanan davranışlar:
 *   1. Atama kapsamı iş dağılım ağacına, gizli bağımlılıklara ve kapsam dışı
 *      ilişkili görevlere DOKUNAMAZ.
 *   2. Sistem yöneticisi de etkin olmayan projeye görev yazamaz.
 *   3. Yetki, kurumsal rehber yoklamasından ÖNCE denetlenir.
 *   4. Temel Kip düzenlemesi Kapsamlı Kipte kurulmuş planı ezmez.
 *   5. Tarih girişi imkânsız takvim gününü kabul etmez.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPORATE_PROJECT_ID,
  CORPORATE_ROOT_WBS_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';

import { parseDisplayDate } from '../src/components/dateInputFormat.js';
import { ownsSimpleModePlan } from '../src/features/task-detail/simpleTaskPlan.js';
import { plainTextToHtml } from '../src/features/reminders/plainTextHtml.js';
import { planTemplateStartAlignment } from '../src/features/task-detail/recurrenceTemplateAlignment.js';
import { canDeleteTask, resolveTaskCreationProject } from '../src/state/projectWritePolicy.js';
import { canResolveTaskAssignee } from '../src/state/appState.js';
import { calculateCpm } from '../src/scheduling/cpm/engine.js';

const MANAGER_SICIL = 900500;
const SUBORDINATE_SICIL = 900501;
const OUTSIDER_SICIL = 900502;
const PLAIN_SICIL = 900503;
const NEW_TASK_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const HIDDEN_WBS_ID = 'bb22cc33-dd44-4e55-8f66-001122334455';

function assignmentSeed(overrides = {}) {
  const base = corporateSeed();
  return {
    ...base,
    people: [
      ...base.people,
      { Sicil: MANAGER_SICIL, DisplayName: 'Birim Yöneticisi', Username: 'byonetici' },
      { Sicil: SUBORDINATE_SICIL, DisplayName: 'Ast Personel', Username: 'astpersonel' },
      { Sicil: OUTSIDER_SICIL, DisplayName: 'Başka Birim', Username: 'baskabirim' },
      { Sicil: PLAIN_SICIL, DisplayName: 'Sıradan Kullanıcı', Username: 'siradan' }
    ],
    systemAdminSicils: [],
    corporateProjectAccess: [],
    executiveScope: [{ ManagerSicil: MANAGER_SICIL, EmployeeSicil: SUBORDINATE_SICIL, ScopeType: 'UNIT' }],
    ...overrides
  };
}

function taskChanges(overrides = {}) {
  return {
    taskUpserts: [{
      id: NEW_TASK_ID,
      projectId: CORPORATE_PROJECT_ID,
      wbsId: CORPORATE_ROOT_WBS_ID,
      task: 'Yöneticinin atadığı iş',
      keyword: 'Atama',
      status: 'todo',
      priority: 'medium',
      plannedStart: '2026-08-17',
      plannedFinish: '2026-08-20',
      targetFinish: '2026-08-20',
      assigneeIds: [String(SUBORDINATE_SICIL)],
      deps: [],
      ...overrides
    }]
  };
}

/* ── 1. İş dağılım ağacı yerleşimi ──────────────────────────────── */

test('atama kapsamıyla yazılan görev GİZLİ bir WBS düğümüne bağlanamaz', async () => {
  const seed = assignmentSeed();
  // Kök dışında, istemciye hiç bildirilmeyen ikinci bir düğüm.
  seed.wbs = [...seed.wbs, {
    WbsId: HIDDEN_WBS_ID,
    ProjectId: CORPORATE_PROJECT_ID,
    ParentWbsId: CORPORATE_ROOT_WBS_ID,
    Code: 'GIZLI',
    Name: 'Gizli düğüm',
    SortOrder: 2
  }];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ wbsId: HIDDEN_WBS_ID })),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /iş dağılım ağacı düğümü seçilemez/);
        return true;
      }
    );
    // Kök düğüm kabul edilir: kapsam kaydıyla istemciye bildirilen tek düğümdür.
    const committed = await stack.repository.commitChanges(taskChanges());
    assert.equal(committed.taskUpserts.length, 1);
  } finally {
    await stack.dispose();
  }
});

/* ── 2. Gizli bağımlılıklar ─────────────────────────────────────── */

test('atama kapsamı düzenlemesi GÖRÜNMEYEN öncülleri silmez', async () => {
  const predecessorId = 'cc33dd44-ee55-4f66-8a77-112233445566';
  const seed = assignmentSeed();
  seed.tasks = [
    {
      TaskId: predecessorId,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Görünmeyen öncül',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-10'
    },
    {
      TaskId: NEW_TASK_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Astın görevi',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-20'
    }
  ];
  seed.taskAssignees = [{ TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL }];
  seed.taskDependencies = [{
    TaskDependencyId: 'dd44ee55-ff66-4a77-8b88-223344556677',
    ProjectId: CORPORATE_PROJECT_ID,
    TaskId: NEW_TASK_ID,
    PredecessorTaskId: predecessorId,
    DependencyType: 'FS',
    LagDays: 0
  }];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    // PARTIAL anlık görüntü bağımlılık yüklemez: istemci `deps: []` taşır.
    const snapshot = await stack.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.ok(visible, 'astın görevi yöneticiye görünmelidir');
    assert.deepEqual(visible.deps, []);

    // Yalnızca başlık düzenlenir; bağımlılık satırı KORUNUR.
    await stack.repository.commitChanges({
      taskUpserts: [{ ...visible, task: 'Yeni başlık', version: visible.version }]
    });
    assert.equal(stack.db.taskDependencies.length, 1, 'görünmeyen öncül silinmemelidir');
    assert.equal(stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')).Title, 'Yeni başlık');
  } finally {
    await stack.dispose();
  }
});

/* ── 3. Kapsam dışı ilişkili görevler ───────────────────────────── */

test('atama kapsamı oluşturucu olmadan görevi silemez ve kapsam dışı yinelemeye dokunamaz', async () => {
  // Görev silindiğinde yinelemeleri AYRILIR (`RecurrenceParentTaskId = NULL`).
  // Bu yinelemeler görünmez ve yöneticinin kapsamı dışında olabilir; kapsam içi
  // bir görevi silmek onlara yazmamalıdır.
  const occurrenceId = 'ee55ff66-aa77-4b88-8c99-334455667788';
  const seed = assignmentSeed();
  seed.tasks = [
    {
      TaskId: NEW_TASK_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Astın seri şablonu',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-20',
      RecurrenceRule: 'FREQ=WEEKLY;BYDAY=MO'
    },
    {
      TaskId: occurrenceId,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Başka birime düşen yineleme',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-27',
      RecurrenceParentTaskId: NEW_TASK_ID,
      RecurrenceOccurrenceDate: '2026-08-24'
    }
  ];
  seed.taskAssignees = [
    { TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL },
    { TaskId: occurrenceId, Sicil: OUTSIDER_SICIL }
  ];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.ok(visible, 'şablon yöneticiye görünmelidir');

    await assert.rejects(
      stack.repository.commitChanges({ taskDeletes: [{ id: visible.id, version: visible.version }] }),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.equal(error.message, 'Görev silme işlemi tam proje yetkisi gerektirir.');
        return true;
      }
    );

    // Kapsam dışı yineleme DOKUNULMADAN durur: seri bağı da silinmemiştir.
    const occurrence = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('ee55ff66'));
    assert.ok(occurrence.RecurrenceParentTaskId, 'kapsam dışı yinelemenin seri bağı korunmalıdır');
    assert.equal(stack.db.tasks.some((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')), true);
  } finally {
    await stack.dispose();
  }
});

/* ── 3a. Proje taşıma bağımlılık modeline yazma hakkı vermez ────── */

const SECOND_PROJECT_ID = 'e7e7e7e7-0000-4000-8000-000000000001';
const SECOND_ROOT_WBS_ID = 'e7e7e7e7-0000-4000-8000-000000000002';
const MOVED_TASK_ID = 'e7e7e7e7-0000-4000-8000-000000000003';
const SUCCESSOR_TASK_ID = 'e7e7e7e7-0000-4000-8000-000000000004';

function moveSeed() {
  const base = assignmentSeed();
  const task = (TaskId, Title) => ({
    TaskId, ProjectId: CORPORATE_PROJECT_ID, WbsId: CORPORATE_ROOT_WBS_ID, Title, Status: 'planned', Priority: 'medium',
    PlannedStart: '2026-08-17', PlannedFinish: '2026-08-20', TargetFinish: '2026-08-21', CreatedBySicil: 900010
  });
  return {
    ...base,
    corporateProjects: [...base.corporateProjects,
      { ProjectCode: 'P4417042', ProjectName: 'İkinci kurumsal proje', ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı faaliyetler' }],
    corporateProjectAccess: [
      { ProjectCode: 'P4417041', Sicil: 900010, RoleCode: 'PROJECT_MANAGER' },
      { ProjectCode: 'P4417042', Sicil: 900010, RoleCode: 'PROJECT_MANAGER' }
    ],
    projects: [...base.projects, {
      ...base.projects[0], ProjectId: SECOND_PROJECT_ID, ProjectCode: 'P4417042', ProjectName: 'İkinci kurumsal proje'
    }],
    wbs: [...base.wbs, {
      WbsId: SECOND_ROOT_WBS_ID, ProjectId: SECOND_PROJECT_ID, ParentWbsId: null, Code: 'P4417042',
      Name: 'İkinci kurumsal proje', SortOrder: 0, SourceType: 'CORPORATE'
    }],
    tasks: [task(MOVED_TASK_ID, 'Taşınan öncül'), task(SUCCESSOR_TASK_ID, 'Ardıl')],
    taskAssignees: [MOVED_TASK_ID, SUCCESSOR_TASK_ID].map((TaskId) => ({ TaskId, Sicil: SUBORDINATE_SICIL })),
    taskDependencies: [{
      TaskDependencyId: 'e7e7e7e7-0000-4000-8000-000000000005', ProjectId: CORPORATE_PROJECT_ID,
      TaskId: SUCCESSOR_TASK_ID, PredecessorTaskId: MOVED_TASK_ID, DependencyType: 'FS', LagDays: 0
    }]
  };
}

test('atama kapsamıyla başka projeye taşınan öncül, FULL yetkisi olmayan aktöre ardılın bağımlılığını sildirmez', async () => {
  const find = (snapshot, id) => snapshot.tasks.find((task) => String(task.id).toLowerCase().includes(id.slice(-12)));
  const stack = await createActualStack(moveSeed(), { sicil: MANAGER_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    const moved = find(snapshot, MOVED_TASK_ID);
    const successor = find(snapshot, SUCCESSOR_TASK_ID);
    assert.deepEqual([moved.deps, successor.deps], [[], []], 'KISMİ görünüm bağımlılık taşımaz');
    // Taşıma ve ardılın değişmeyen, boş bağımlılıklı güncellemesi aynı kümede.
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...moved, projectId: SECOND_PROJECT_ID, wbsId: null }, successor] }),
      (error) => error.code === 'FORBIDDEN' && /kaynak projede tam proje yetkisiyle/.test(error.message)
    );
    assert.equal(stack.db.taskDependencies.length, 1, 'ardılın bağımlılığı korunur');
    assert.equal(String(stack.db.tasks.find((row) => String(row.TaskId).toLowerCase() === MOVED_TASK_ID).ProjectId).toLowerCase(), CORPORATE_PROJECT_ID.toLowerCase());
  } finally {
    await stack.dispose();
  }

  // Bağımlılık satırı olan ve olmayan görevin reddedilen taşıması ayırt edilemez: KISMİ görünüm
  // bağımlılık taşımaz, yanıt gizli satırların varlığını söylememelidir.
  const moveResponse = async (seed) => {
    const actorStack = await createActualStack(seed, { sicil: MANAGER_SICIL });
    try {
      const moved = find(await actorStack.repository.loadSnapshot(), MOVED_TASK_ID);
      const error = await actorStack.repository.commitChanges({ taskUpserts: [{ ...moved, projectId: SECOND_PROJECT_ID, wbsId: null }] })
        .then(() => null, (failure) => failure);
      assert.equal(actorStack.db.taskDependencies.length, seed.taskDependencies.length, 'satırlar korunur');
      return JSON.stringify({ code: error?.code, message: error?.message, details: error?.details ?? null });
    } finally {
      await actorStack.dispose();
    }
  };
  const withDependencies = await moveResponse(moveSeed());
  const withoutDependencies = await moveResponse({ ...moveSeed(), taskDependencies: [] });
  assert.equal(withDependencies, withoutDependencies);
  assert.match(withDependencies, /"code":"FORBIDDEN".*kaynak projede tam proje yetkisiyle/);

  // İki projede FULL yetkili, ardılı uzlaştırarak taşımaya devam eder.
  const lead = await createActualStack(moveSeed(), { sicil: 900010 });
  try {
    const snapshot = await lead.repository.loadSnapshot();
    const moved = find(snapshot, MOVED_TASK_ID);
    const successor = find(snapshot, SUCCESSOR_TASK_ID);
    assert.equal(successor.deps.length, 1);
    await lead.repository.commitChanges({
      taskUpserts: [{ ...moved, projectId: SECOND_PROJECT_ID, wbsId: SECOND_ROOT_WBS_ID }, { ...successor, deps: [] }]
    });
    assert.equal(lead.db.taskDependencies.length, 0);
    assert.equal(String(lead.db.tasks.find((row) => String(row.TaskId).toLowerCase() === MOVED_TASK_ID).ProjectId).toLowerCase(), SECOND_PROJECT_ID);
  } finally {
    await lead.dispose();
  }
});

/* ── 3b. Kontrollü tarihler: YAZILACAK değer yetkilendirilir ────── */

function datedTaskSeed(overrides = {}) {
  return {
    TaskId: NEW_TASK_ID,
    ProjectId: CORPORATE_PROJECT_ID,
    WbsId: CORPORATE_ROOT_WBS_ID,
    Title: 'Kontrollü planlı görev',
    Status: 'planned',
    Priority: 'medium',
    PlannedStart: '2026-08-17',
    PlannedFinish: '2026-08-20',
    TargetFinish: '2026-08-21',
    CreatedBySicil: PLAIN_SICIL,
    ...overrides
  };
}

test('atama kapsamı gönderilmeyen kontrollü tarihleri SİLEMEZ; açık temizleme ve değişiklik yetkisiz kalır', async () => {
  const SECOND_SUBORDINATE = 900504;
  const OTHER_CALENDAR_ID = 'c0a80101-2222-4222-8222-222222222222';
  const base = assignmentSeed();
  const seed = assignmentSeed({
    calendars: [...base.calendars, { CalendarId: OTHER_CALENDAR_ID, Name: 'Üç Günlük Takvim', IsDefault: 0, IsActive: 1, WorkingDays: [1, 2, 3] }],
    people: [...base.people, { Sicil: SECOND_SUBORDINATE, DisplayName: 'İkinci Ast', Username: 'ikinciast' }],
    executiveScope: [...base.executiveScope, { ManagerSicil: MANAGER_SICIL, EmployeeSicil: SECOND_SUBORDINATE, ScopeType: 'UNIT' }]
  });
  seed.tasks = [datedTaskSeed({ PlannedDurationDays: 4 })];
  seed.taskAssignees = [{ TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL }];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  const stored = () => stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('aa11bb22'));
  const dates = () => ['PlannedStart', 'PlannedFinish', 'TargetFinish'].map((field) => (stored()[field] == null ? null : String(stored()[field]).slice(0, 10)));
  try {
    const snapshot = await stack.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    // Kanonikleştirme eksik alanı `undefined` anahtarına çevirir: tarihler hiç gönderilmez.
    const { plannedStart, plannedFinish, plannedDurationDays, targetFinish, ...withoutDates } = visible;
    assert.deepEqual([plannedStart, plannedFinish, targetFinish], ['2026-08-17', '2026-08-20', '2026-08-21']);
    assert.equal(plannedDurationDays, 4);

    const reassigned = await stack.repository.commitChanges({ taskUpserts: [{ ...withoutDates, assigneeIds: [String(SECOND_SUBORDINATE)] }] });
    assert.deepEqual(dates(), ['2026-08-17', '2026-08-20', '2026-08-21'], 'yalnızca atama değişikliği tarihleri korur');

    const current = reassigned.taskUpserts.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.equal(current.plannedDurationDays, 4, 'yalnızca atama değişikliği kanonik süreyi korur');
    assert.equal(stored().PlannedDurationDays, 4, 'gönderilmeyen süre kalıcı satırdan silinmez');
    for (const patch of [{ plannedStart: null }, { plannedFinish: null }, { targetFinish: null }, { plannedFinish: '2026-08-25' }]) {
      await assert.rejects(
        stack.repository.commitChanges({ taskUpserts: [{ ...withoutDates, ...patch, assigneeIds: current.assigneeIds, version: current.version }] }),
        (error) => error.code === 'FORBIDDEN',
        JSON.stringify(patch)
      );
    }
    assert.deepEqual(dates(), ['2026-08-17', '2026-08-20', '2026-08-21']);
    assert.equal(stored().PlannedDurationDays, 4, 'yetkisiz tarih değişikliği süreyi de değiştirmez');

    const changed = await stack.repository.commitChanges({
      taskUpserts: [{ ...withoutDates, calendarId: OTHER_CALENDAR_ID, assigneeIds: current.assigneeIds, version: current.version }]
    });
    const changedTask = changed.taskUpserts.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.equal(changedTask.plannedDurationDays, null, 'farklı etkin takvimde mevcut gönderilen süre yolu kullanılır');
    assert.equal(stored().PlannedDurationDays, null);
    assert.equal(String(stored().CalendarId).toLowerCase(), OTHER_CALENDAR_ID);
    assert.deepEqual(dates(), ['2026-08-17', '2026-08-20', '2026-08-21']);
    assert.equal(calculateCpm([changedTask], stack.state).tasks[changedTask.id].durationDays, 3, 'mevcut CPM hesabı yeni takvimi kullanır');
  } finally {
    await stack.dispose();
  }

  // Süre gönderilmese de sorumlunun gerçek plan tarihi değişikliği yeniden hesaplanır.
  const assignee = await createActualStack(seed, { sicil: SUBORDINATE_SICIL });
  try {
    const { plannedDurationDays, ...task } = assignee.state.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.equal(plannedDurationDays, 4);
    const updated = await assignee.repository.commitChanges({
      taskUpserts: [{ ...task, plannedFinish: '2026-08-21', assigneeMutation: false }]
    });
    assert.equal(updated.taskUpserts[0].plannedDurationDays, 5);
    assert.equal(assignee.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')).PlannedDurationDays, 5);
  } finally {
    await assignee.dispose();
  }

  // Tam proje yetkilisi açık temizlemeyi yapabilmeye devam eder.
  const full = await createActualStack({ ...corporateSeed(), tasks: [datedTaskSeed()] }, { sicil: 900010 });
  try {
    const snapshot = await full.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    await full.repository.commitChanges({ taskUpserts: [{ ...visible, targetFinish: null }] });
    assert.equal(full.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')).TargetFinish, null);
  } finally {
    await full.dispose();
  }
});

test('gönderilmeyen süre kaynak proje takvimini izler; etkin olmayan görev takviminin süresi korunmaz', async () => {
  const OTHER_CALENDAR_ID = 'c0a80101-3333-4333-8333-333333333333';
  const moved = moveSeed();
  moved.calendars.push({ CalendarId: OTHER_CALENDAR_ID, Name: 'Üç Günlük Takvim', IsDefault: 0, IsActive: 1, WorkingDays: [1, 2, 3] });
  moved.projects[1].CalendarId = OTHER_CALENDAR_ID;
  moved.corporateProjectAccess.push({ ProjectCode: 'P4417041', Sicil: MANAGER_SICIL, RoleCode: 'PROJECT_MANAGER' });
  moved.tasks = [{ ...moved.tasks[0], PlannedDurationDays: 4 }];
  moved.taskAssignees = [moved.taskAssignees[0]];
  moved.taskDependencies = [];

  const base = assignmentSeed();
  const inactive = assignmentSeed({
    calendars: [
      { ...base.calendars[0], WorkingDays: [1, 2, 3] },
      { CalendarId: OTHER_CALENDAR_ID, Name: 'Eski Takvim', IsDefault: 0, IsActive: 0, WorkingDays: [1, 2, 3, 4, 5] }
    ],
    tasks: [datedTaskSeed({ CalendarId: OTHER_CALENDAR_ID, PlannedDurationDays: 4 })],
    taskAssignees: [{ TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL }]
  });

  for (const [name, seed, patch] of [
    ['kaynak FULL, hedef atama kapsamı', moved, { projectId: SECOND_PROJECT_ID, wbsId: SECOND_ROOT_WBS_ID }],
    ['etkin olmayan override temizliği', inactive, {}]
  ]) {
    const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
    try {
      const task = { ...stack.state.tasks[0] };
      for (const field of ['plannedStart', 'plannedFinish', 'plannedDurationDays', 'calendarId']) delete task[field];
      const result = await stack.repository.commitChanges({ taskUpserts: [{ ...task, ...patch }] });
      const updated = result.taskUpserts[0];
      assert.equal(updated.plannedDurationDays, null, name);
      assert.equal(stack.db.tasks[0].PlannedDurationDays, null, name);
      assert.equal(stack.db.tasks[0].CalendarId, null, name);
      assert.equal(updated.projectId.toLowerCase(), (patch.projectId || CORPORATE_PROJECT_ID).toLowerCase(), name);
      await stack.reload();
      assert.equal(calculateCpm(stack.state.tasks, stack.state).tasks[updated.id].durationDays, 3, name);
    } finally {
      await stack.dispose();
    }
  }
});

/* ── 4. Sistem yöneticisi ve etkin proje ────────────────────────── */

test('sistem yöneticisi ETKİN OLMAYAN projeye görev yazamaz', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    // Proje yığın kurulduktan SONRA pasifleştirilir: kurumsal katalog eşitlemesi
    // tohumdaki projeyi yeniden etkinleştirdiği için tohumda kapatmak yetmez.
    for (const project of stack.db.projects) project.IsActive = 0;

    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ assigneeIds: [] })),
      (error) => {
        // Sertleştirme katmanı da aynı sınırı korur; her iki katman da yazmayı
        // reddeder ve görev etkin olmayan projeye düşmez.
        assert.ok(
          /Etkin olmayan bir projede görev yazılamaz|Hedef proje bulunamadı veya etkin değil/.test(error.message),
          `beklenmeyen ileti: ${error.message}`
        );
        return true;
      }
    );
    assert.equal(stack.db.tasks.some((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')), false);
  } finally {
    await stack.dispose();
  }
});

/* ── 5. Rehber yoklaması ────────────────────────────────────────── */

test('yetki, kurumsal rehber yoklamasından ÖNCE denetlenir', async () => {
  // Sıradan kullanıcı: ne kurumsal proje erişimi ne de atama kapsamı vardır.
  const stack = await createActualStack(assignmentSeed(), { sicil: PLAIN_SICIL });
  try {
    // Var olmayan bir Sicil ile de yanıt aynı yetki hatasıdır: geçerli ve
    // geçersiz sicillerin farklı hata üretmesi rehberi yoklamaya yarardı.
    const unknown = await stack.repository
      .commitChanges({
        taskUpserts: [{
          ...taskChanges().taskUpserts[0],
          projectId: CORPORATE_PROJECT_ID,
          assigneeIds: ['999999']
        }]
      })
      .then(() => null, (error) => error);
    const known = await stack.repository
      .commitChanges(taskChanges({ assigneeIds: [String(OUTSIDER_SICIL)] }))
      .then(() => null, (error) => error);

    assert.ok(unknown && known, 'iki istek de reddedilmelidir');
    // İkisi de AYNI hatadır: bilinmeyen Sicil için "geçersiz çalışan",
    // gerçek Sicil için FORBIDDEN dönseydi bu fark rehberi yoklamaya yarardı.
    // Kullanıcının göremediği proje var olmayan projeyle aynı yanıtı alır.
    assert.equal(unknown.code, 'MUTATION_FAILED');
    assert.equal(known.code, 'MUTATION_FAILED');
    assert.equal(unknown.message, known.message);
    assert.equal(/Geçersiz çalışan Sicil/.test(unknown.message), false);
  } finally {
    await stack.dispose();
  }
});

/* ── 5b. Gizli eş sorumlu ───────────────────────────────────────── */

test('KISMİ yönetici görünümü kapsam dışı eş sorumlu kimliğini veya adını vermez', async () => {
  const seed = assignmentSeed();
  seed.tasks = [{
    TaskId: NEW_TASK_ID,
    ProjectId: CORPORATE_PROJECT_ID,
    WbsId: CORPORATE_ROOT_WBS_ID,
    Title: 'Ortak görev',
    Status: 'planned',
    Priority: 'medium',
    TargetFinish: '2026-08-20'
  }];
  // Görev bir asta VE kapsam dışı bir çalışana atanmıştır.
  seed.taskAssignees = [
    { TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL },
    { TaskId: NEW_TASK_ID, Sicil: OUTSIDER_SICIL }
  ];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    const task = snapshot.tasks.find((entry) => String(entry.id).toLowerCase().includes('aa11bb22'));
    assert.ok(task, 'görev astı üzerinden yöneticiye görünür');

    // Kapsam dışı sorumlunun Sicili istemciye TAŞINMAZ. Görünür görevler için
    // çalışan sorumlu tamamlaması, anlık görüntünün gizlediği satırları geri
    // getirmemelidir.
    assert.deepEqual(task.assigneeIds, [String(SUBORDINATE_SICIL)]);
    assert.equal(task.assigneeIds.includes(String(OUTSIDER_SICIL)), false);
    assert.deepEqual(task.assigneeDisplayNames, ['Ast Personel']);

    // Yetkili SAYI yine de bildirilir: arayüz "gizli sorumlu var" sonucuna
    // varıp paneli salt okunur açabilsin diye. Sayı kimlik taşımaz.
    assert.equal(task.assigneeCount, 2);
    assert.ok(task.assigneeCount > task.assigneeIds.length, 'gizli sorumlu tespit edilebilmelidir');
    assert.equal(canDeleteTask(stack.state, task.id), false, 'liste eylemi sunucunun gizli sorumlu sınırını izler');
  } finally {
    await stack.dispose();
  }
});

/* ── 6. Temel Kip planı ─────────────────────────────────────────── */

test('Temel Kip düzenlemesi Kapsamlı Kipte kurulmuş planın sahibi değildir', () => {
  // Üç tarih eşitse plan Temel Kipte kurulmuştur ve birlikte taşınabilir.
  assert.equal(ownsSimpleModePlan({ plannedStart: '2026-08-20', plannedFinish: '2026-08-20', targetFinish: '2026-08-20' }), true);
  // Plan tarihleri ayrıştıysa Kapsamlı Kipe aittir; Temel Kip onu ezmemelidir.
  assert.equal(ownsSimpleModePlan({ plannedStart: '2026-08-10', plannedFinish: '2026-08-18', targetFinish: '2026-08-20' }), false);
  // Hiç plan tarihi yoksa Temel Kip alanı serbestçe kurabilir.
  assert.equal(ownsSimpleModePlan({ targetFinish: '2026-08-20' }), true);
});

/* ── 7. Tarih girişi ────────────────────────────────────────────── */

test('imkânsız ISO takvim günü kabul edilmez', () => {
  // Tireli metin maskeyi atladığı için doğrulanmadan geçiyor, `parseDate()`
  // onu mart ayına yuvarlıyordu.
  assert.equal(parseDisplayDate('2026-02-31'), null);
  assert.equal(parseDisplayDate('2026-13-01'), null);
  assert.equal(parseDisplayDate('2026-02-28'), '2026-02-28');
  // Artık yıl gerçek takvimle doğrulanır.
  assert.equal(parseDisplayDate('2024-02-29'), '2024-02-29');
  assert.equal(parseDisplayDate('2026-02-29'), null);
});

/* ── 8. Tekrar şablonu hizalaması ───────────────────────────────── */

test('DTSTART hizalaması ÇALIŞMA GÜNÜ süresini korur', () => {
  // Pzt–Cum takvimi: Cuma–Pazartesi 2 iş günüdür. Ham takvim farkıyla (3 gün)
  // kaydırıldığında bitiş Perşembeye taşınıyor ve süre 4 iş gününe çıkıyordu.
  const calendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
  const task = { plannedStart: '2026-08-14', plannedFinish: '2026-08-17', targetFinish: '2026-08-17' };
  const aligned = planTemplateStartAlignment(task, 'FREQ=WEEKLY;BYDAY=MO', { calendar });

  assert.ok(aligned, 'kural Pazartesi istediği için hizalama gerekir');
  assert.equal(aligned.plannedStart, '2026-08-17');
  // Başlangıç Pazartesi ise 2 iş günlük görev SALI biter.
  assert.equal(aligned.plannedFinish, '2026-08-18');
  // Termin bir taahhüt tarihidir; takvim günü farkıyla kayar.
  assert.equal(aligned.targetFinish, '2026-08-20');
});

/* ── 9. Yeni görev varsayılan sorumlusu ─────────────────────────── */

test('atama kapsamı projesinde varsayılan sorumlu KAPSAM İÇİNDEN seçilir', () => {
  const state = {
    session: { dataMode: 'actual' },
    currentUser: { id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' },
    people: [
      { id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' },
      { id: String(SUBORDINATE_SICIL), name: 'Ast Personel' }
    ],
    assignmentScopeSicils: [String(SUBORDINATE_SICIL)]
  };
  const assignProject = { id: 'p1', name: 'CN43N', accessLevel: 'ASSIGN' };
  const fullProject = { id: 'p2', name: 'Tam yetki', accessLevel: 'FULL' };

  // Kapsam projesinde oturum sahibi kapsam dışıdır; astı seçilir.
  assert.equal(canResolveTaskAssignee(state, assignProject), true);
  // Tam yetkili projede davranış DEĞİŞMEZ: varsayılan yine oturum sahibidir.
  assert.equal(canResolveTaskAssignee(state, fullProject), true);
  // Kapsam oturum sahibini ve rehberdeki hiç kimseyi içermiyorsa oluşturma
  // düğmesi etkinleşmemelidir: istek zaten reddedilirdi.
  const unreachable = {
    ...state,
    assignmentScopeSicils: ['999999'],
    people: [{ id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' }]
  };
  assert.equal(canResolveTaskAssignee(unreachable, assignProject), false);
  // Tam yetkili projede aynı durum oluşturmayı ENGELLEMEZ.
  assert.equal(canResolveTaskAssignee(unreachable, fullProject), true);
});

test('proje çalışma alanında atama kapsamı da görev oluşturmaya yeter', () => {
  const state = {
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    // Proje PARTIAL görünür (ast görevi üzerinden) ama atama kapsamındadır.
    projects: [{ id: 'p1', name: 'CN43N', accessLevel: 'PARTIAL' }],
    assignableProjects: [{ id: 'p1', name: 'CN43N', accessLevel: 'ASSIGN' }]
  };
  const resolved = resolveTaskCreationProject(state);
  assert.ok(resolved, 'atama kapsamındaki seçili proje çözülmelidir');
  assert.equal(resolved.id, 'p1');
});

/* ── 10. Zengin metin yapıştırması ──────────────────────────────── */

test('düz metin yapıştırması satır yapısını korur', () => {
  const html = plainTextToHtml('Birinci satır\nİkinci satır\n\nYeni paragraf');
  assert.equal(html, '<p>Birinci satır<br />İkinci satır</p><p>Yeni paragraf</p>');
  // Yapıştırılan metin KAÇIRILIR: `<script>` yalnızca metin üretir.
  assert.equal(plainTextToHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});