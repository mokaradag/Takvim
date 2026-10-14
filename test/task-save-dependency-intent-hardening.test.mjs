import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const PROJECT_ID = '91111111-1111-4111-8111-111111111111';
const TASK_ID = '92222222-2222-4222-8222-222222222222';
const PREDECESSOR_ID = '93333333-3333-4333-8333-333333333333';
const SICIL = 910001;

function seed() {
  return {
    calendars: [{
      CalendarId: DEFAULT_CALENDAR_ID,
      Name: 'Kurumsal Takvim',
      IsDefault: 1,
      IsActive: 1,
      WorkingDays: [1, 2, 3, 4, 5]
    }],
    people: [{ Sicil: SICIL, DisplayName: 'Proje Yetkilisi', Username: 'u910001' }],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'DEP',
      ProjectName: 'Bağımlılık Projesi',
      LeadSicil: SICIL,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    tasks: [
      {
        TaskId: TASK_ID,
        ProjectId: PROJECT_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Ardıl',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      },
      {
        TaskId: PREDECESSOR_ID,
        ProjectId: PROJECT_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Öncül',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      }
    ],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: SICIL },
      { TaskId: PREDECESSOR_ID, Sicil: SICIL }
    ],
    taskDependencies: [{
      ProjectId: PROJECT_ID,
      TaskId: TASK_ID,
      PredecessorTaskId: PREDECESSOR_ID,
      DependencyType: 'FS',
      LagDays: 0
    }]
  };
}

test('istemci dependencyMutation=false gönderse de gerçek bağımlılık değişikliği döngü doğrulamasını atlayamaz', async () => {
  const stack = await createActualStack(seed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const predecessor = stack.state.tasks.find((task) => task.id === PREDECESSOR_ID);
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          ...predecessor,
          deps: [{ predecessorId: TASK_ID, type: 'FS', lagDays: 0 }],
          assigneeMutation: false,
          dependencyMutation: false
        }]
      }),
      (error) => error.code === 'MUTATION_FAILED' && /döngü/.test(error.message)
    );

    assert.equal(stack.db.taskDependencies.length, 1);
    assert.equal(String(stack.db.taskDependencies[0].TaskId).toLowerCase(), TASK_ID);
    assert.equal(String(stack.db.taskDependencies[0].PredecessorTaskId).toLowerCase(), PREDECESSOR_ID);
  } finally {
    await stack.dispose();
  }
});

const HIDDEN_ID = '94444444-4444-4444-8444-444444444444';
const OTHER_PROJECT = '95555555-5555-4555-8555-555555555555';
const OTHER_TASK = '96666666-6666-4666-8666-666666666666';

function partialSeed({ creator = false } = {}) {
  const data = seed();
  data.projectAccess = [];
  data.projects[0].LeadSicil = SICIL + 1;
  data.people.push({ Sicil: SICIL + 1, DisplayName: 'Diğer çalışan' });
  data.tasks.forEach((task) => { task.CreatedBySicil = creator ? SICIL : SICIL + 1; });
  data.tasks.push({ ...data.tasks[0], TaskId: HIDDEN_ID, CreatedBySicil: SICIL + 1, Title: 'Gizli görev' });
  data.projects.push({ ...data.projects[0], ProjectId: OTHER_PROJECT });
  data.tasks.push({ ...data.tasks[0], TaskId: OTHER_TASK, ProjectId: OTHER_PROJECT, CreatedBySicil: SICIL + 1 });
  data.taskAssignees.push({ TaskId: HIDDEN_ID, Sicil: SICIL + 1 }, { TaskId: TASK_ID, Sicil: SICIL + 1 });
  data.taskDependencies.push({ ProjectId: PROJECT_ID, TaskId: TASK_ID, PredecessorTaskId: HIDDEN_ID, DependencyType: 'SS', LagDays: 0 });
  return data;
}

for (const creator of [false, true]) {
  test(`${creator ? 'oluşturan' : 'normal sorumlu'} görünür bağı ekler, değiştirir ve kaldırır; gizli bağ kaybolmaz`, async () => {
    const stack = await createActualStack(partialSeed({ creator }), { sicil: SICIL, corporateWbsSource: false });
    try {
      assert.equal(stack.state.projects.find((p) => p.id === PROJECT_ID).accessLevel, 'PARTIAL');
      assert.equal(stack.state.tasks.some((task) => task.id === HIDDEN_ID), false);
      assert.deepEqual(stack.state.tasks.find((task) => task.id === TASK_ID).deps.map((d) => d.predecessorId), [PREDECESSOR_ID]);
      for (const deps of [[], [{ predecessorId: PREDECESSOR_ID, type: 'FF', lagDays: 2 }], [{ predecessorId: PREDECESSOR_ID, type: 'SF', lagDays: -1 }], []]) {
        const task = stack.state.tasks.find((row) => row.id === TASK_ID);
        const response = await stack.repository.commitChanges({ taskUpserts: [{ ...task, deps, dependencyMutation: true, assigneeMutation: false }] });
        assert.deepEqual(response.taskUpserts.find((row) => row.id === TASK_ID).deps.map((d) => [d.predecessorId, d.type]), deps.map((d) => [d.predecessorId, d.type]));
        assert.ok(stack.db.taskDependencies.some((d) => String(d.PredecessorTaskId).toLowerCase() === HIDDEN_ID));
        await stack.reload();
        assert.deepEqual(stack.state.tasks.find((row) => row.id === TASK_ID).deps.map((d) => [d.predecessorId, d.type]), deps.map((d) => [d.predecessorId, d.type]));
      }
      assert.equal(stack.db.taskDependencies.length, 1);
    } finally { await stack.dispose(); }
  });
}

test('normal kullanıcının gizli hedef, çapraz proje ve yetkisiz ardıl yazmaları reddedilir', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    for (const predecessorId of [HIDDEN_ID, OTHER_TASK]) {
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...task, deps: [{ predecessorId, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), { code: 'FORBIDDEN' });
    }
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...task, id: HIDDEN_ID, deps: [], dependencyMutation: true }] }), { code: 'FORBIDDEN' });
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [
      { ...task, deps: [{ predecessorId: HIDDEN_ID, type: 'FS', lagDays: 0 }], dependencyMutation: true },
      { ...task, id: HIDDEN_ID, deps: [], dependencyMutation: true }
    ] }), { code: 'FORBIDDEN' });
    assert.equal(stack.db.taskDependencies.length, 2);
    assert.equal(stack.state.tasks.some((row) => row.id === HIDDEN_ID), false);
  } finally { await stack.dispose(); }
});

test('kısmi ağda gizli görev üzerinden oluşan döngü reddedilir; gizli kimlikler hata ayrıntısına girmez', async () => {
  const data = partialSeed();
  data.taskDependencies = [
    { ProjectId: PROJECT_ID, TaskId: HIDDEN_ID, PredecessorTaskId: TASK_ID, DependencyType: 'FS', LagDays: 0 },
    { ProjectId: PROJECT_ID, TaskId: PREDECESSOR_ID, PredecessorTaskId: HIDDEN_ID, DependencyType: 'FS', LagDays: 0 }
  ];
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...task, deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), (error) => {
      assert.equal(error.code, 'MUTATION_FAILED');
      assert.match(error.message, /döngü/);
      assert.equal(JSON.stringify(error).includes(HIDDEN_ID), false);
      return true;
    });
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});

for (const admin of [false, true]) {
  test(`${admin ? 'sistem yöneticisi' : 'tam proje yetkilisi'} bağımlılık yönetimini sürdürür`, async () => {
    const data = seed();
    if (admin) { data.projectAccess = []; data.systemAdminSicils = [SICIL]; }
    const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
    try {
      const task = stack.state.tasks.find((row) => row.id === TASK_ID);
      const response = await stack.repository.commitChanges({ taskUpserts: [{ ...task, deps: [{ predecessorId: PREDECESSOR_ID, type: 'SS', lagDays: 0 }], dependencyMutation: true }] });
      assert.equal(response.taskUpserts.find((row) => row.id === TASK_ID).deps[0].type, 'SS');
    } finally { await stack.dispose(); }
  });
}

test('normal sorumlu yeni görevle öncül ve ardıl bağlantılarını tek atomik kayıtta kurabilir', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const newId = '97777777-7777-4777-8777-777777777777';
    const target = stack.state.tasks.find((row) => row.id === TASK_ID);
    const created = { ...target, id: newId, version: undefined, task: 'Yeni ara görev',
      calendarId: null, plannedDurationDays: null, assigneeIds: [String(SICIL)],
      deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }] };
    const response = await stack.repository.commitChanges({ taskUpserts: [
      { ...target, deps: [{ predecessorId: newId, type: 'SS', lagDays: 0 }], dependencyMutation: true, assigneeMutation: false },
      created
    ] });
    assert.ok(response.taskUpserts.some((row) => row.id === newId));
    assert.equal(stack.db.statements.filter((entry) => entry.sql.includes('STRING_SPLIT(@scopedDependencyTaskIds')).length, 1);
    await stack.reload();
    assert.equal(stack.state.tasks.find((row) => row.id === newId).deps[0].predecessorId, PREDECESSOR_ID);
    assert.equal(stack.state.tasks.find((row) => row.id === TASK_ID).deps[0].predecessorId, newId);
    assert.ok(stack.db.taskDependencies.some((row) => String(row.PredecessorTaskId).toLowerCase() === HIDDEN_ID));
    assert.equal(stack.state.tasks.some((row) => row.id === HIDDEN_ID), false);
  } finally { await stack.dispose(); }
});

test('içerik kaydı eski boş PARTIAL izdüşümünü gönderse de görünür ve gizli bağlar korunur', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const target = stack.state.tasks.find((row) => row.id === TASK_ID);
    const response = await stack.repository.commitChanges({ taskUpserts: [{ ...target, task: 'Yeni başlık', deps: [], dependencyMutation: false, assigneeMutation: false }] });
    assert.equal(stack.db.taskDependencies.length, 2);
    assert.deepEqual(response.taskUpserts.find((row) => row.id === TASK_ID).deps.map((dep) => dep.predecessorId), [PREDECESSOR_ID]);
  } finally { await stack.dispose(); }
});

test('READ görünürlüğü ardıl yazma hakkı vermez; görünür çapraz proje bağlantısı da reddedilir', async () => {
  const data = partialSeed();
  data.projectAccess.push({ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'READ' }, { ProjectId: OTHER_PROJECT, Sicil: SICIL, AccessLevel: 'READ' });
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const target = stack.state.tasks.find((row) => row.id === TASK_ID);
    const readonly = stack.state.tasks.find((row) => row.id === HIDDEN_ID);
    assert.ok(stack.state.tasks.some((row) => row.id === OTHER_TASK));
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...readonly, deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), { code: 'FORBIDDEN' });
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...target, deps: [{ predecessorId: OTHER_TASK, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), { code: 'MUTATION_FAILED' });
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});

test('sorumluluk kaldırıldıktan sonra açık panel eski yetkiyle bağımlılık yazamaz', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const target = stack.state.tasks.find((row) => row.id === TASK_ID);
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => !(String(row.TaskId).toLowerCase() === TASK_ID && row.Sicil === SICIL));
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...target, deps: [], dependencyMutation: true, assigneeMutation: false }] }), { code: 'FORBIDDEN' });
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});

test('gizli bağların korunması mevcut görev başına bağımlılık sınırını aşamaz', async () => {
  const data = partialSeed();
  data.taskDependencies = [];
  for (let i = 0; i < 500; i++) {
    const taskId = `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    data.tasks.push({ ...data.tasks[0], TaskId: taskId, CreatedBySicil: SICIL + 1 });
    data.taskDependencies.push({ ProjectId: PROJECT_ID, TaskId: TASK_ID, PredecessorTaskId: taskId, DependencyType: 'FS', LagDays: 0 });
  }
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const target = stack.state.tasks.find((row) => row.id === TASK_ID);
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...target, deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), (error) => error.code === 'MUTATION_FAILED' && /sınırı/.test(error.message));
    assert.equal(stack.db.taskDependencies.length, 500);
  } finally { await stack.dispose(); }
});
