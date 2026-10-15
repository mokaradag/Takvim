import assert from 'node:assert/strict';
import test from 'node:test';

import { dependencyChanges } from '../src/scheduling/dependencyChanges.js';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';
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

test('dependencyMutation=false tam yetkide de ilişki izdüşümünü yok sayar', async () => {
  const stack = await createActualStack(seed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const predecessor = stack.state.tasks.find((task) => task.id === PREDECESSOR_ID);
    await stack.repository.commitChanges({
      taskUpserts: [{ ...predecessor, deps: [{ predecessorId: TASK_ID, type: 'FS', lagDays: 0 }],
        assigneeMutation: false, dependencyMutation: false }]
    });

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
        const response = await stack.repository.commitChanges({ taskUpserts: [{ ...task, deps, dependencyChanges: dependencyChanges(task.deps, deps), dependencyMutation: true, assigneeMutation: false }] });
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
      { ...target, deps: [{ predecessorId: newId, type: 'SS', lagDays: 0 }], dependencyChanges: dependencyChanges(target.deps, [{ predecessorId: newId, type: 'SS', lagDays: 0 }]), dependencyMutation: true, assigneeMutation: false },
      created
    ] });
    assert.ok(response.taskUpserts.some((row) => row.id === newId));
    assert.equal(stack.db.statements.filter((entry) => entry.sql.includes('/* commit-resource-discovery */')).length, 1);
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
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...target, deps: [{ predecessorId: OTHER_TASK, type: 'FS', lagDays: 0 }], dependencyMutation: true }] }), { code: 'FORBIDDEN' });
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

for (const readGrant of [false, true]) {
  test(`içerik kaydı görünürlüğü kaybolan öncülü doğrulamaz veya yazmaz (READ=${readGrant})`, async () => {
    const data = partialSeed();
    if (readGrant) data.projectAccess.push({ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'READ' });
    const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
    try {
      const task = stack.state.tasks.find((row) => row.id === TASK_ID);
      stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => String(row.TaskId).toLowerCase() !== PREDECESSOR_ID);
      stack.db.projectAccess = [];
      const start = stack.db.statements.length;
      const result = await stack.persistence.mutate('task/update', { type: 'task/update', id: TASK_ID, patch: { task: 'İçerik kaydı', progress: 20 } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(stack.db.taskDependencies.length, 2);
      assert.deepEqual(result.value.taskUpserts.find((row) => row.id === TASK_ID).deps, []);
      assert.equal(stack.db.statements.slice(start).some((row) => /DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId;/.test(row.sql)), false);
      assert.ok(task.deps.some((dep) => dep.predecessorId === PREDECESSOR_ID));
    } finally { await stack.dispose(); }
  });
}

test('snapshotta görünmeyen kenar sonradan görünür olsa da açık delta onu silmez', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const observed = stack.state.tasks.find((row) => row.id === TASK_ID).deps;
    stack.db.projectAccess.push({ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'READ', IsActive: 1 });
    const result = await stack.persistence.mutate('task/update', { type: 'task/update', id: TASK_ID,
      observedDependencies: observed, patch: { deps: [] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(stack.db.taskDependencies.map((dep) => String(dep.PredecessorTaskId).toLowerCase()), [HIDDEN_ID]);
    await stack.reload();
    assert.deepEqual(stack.state.tasks.find((row) => row.id === TASK_ID).deps.map((dep) => dep.predecessorId), [HIDDEN_ID]);
  } finally { await stack.dispose(); }
});

test('görünürlüğü kaybolan kenarın açık eski çıkarma isteği kalıcı kenarı korur', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => String(row.TaskId).toLowerCase() !== PREDECESSOR_ID);
    await stack.repository.commitChanges({ taskUpserts: [{ ...task, deps: [], dependencyMutation: true,
      dependencyChanges: dependencyChanges(task.deps, []), assigneeMutation: false }] });
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});

test('bilinmeyen, gizli ve çapraz proje UUID aynı hata sözleşmesini kullanır', async () => {
  const data = partialSeed();
  data.projectAccess.push({ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'READ' });
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    const errors = [];
    for (const target of [OTHER_TASK, '99999999-9999-4999-8999-999999999999']) {
      try { await stack.repository.commitChanges({ taskUpserts: [{ ...task,
        dependencyMutation: true, dependencyChanges: { upserts: [{ predecessorId: target, type: 'FS', lagDays: 0 }], removals: [] } }] }); }
      catch (error) { errors.push([error.code, error.message, error.details]); }
    }
    stack.db.projectAccess = [];
    try { await stack.repository.commitChanges({ taskUpserts: [{ ...task,
      dependencyMutation: true, dependencyChanges: { upserts: [{ predecessorId: HIDDEN_ID, type: 'FS', lagDays: 0 }], removals: [] } }] }); }
    catch (error) { errors.push([error.code, error.message, error.details]); }
    assert.equal(errors.length, 3);
    assert.deepEqual(errors[0], errors[1]);
    assert.deepEqual(errors[0], errors[2]);
    for (const id of [OTHER_PROJECT, OTHER_TASK, HIDDEN_ID]) assert.equal(JSON.stringify(errors).includes(id), false);
  } finally { await stack.dispose(); }
});

for (const creator of [false, true]) {
  for (const missing of [false, true]) {
    test(`dar görev kimliği rehberden bağımsızdır; iki ardışık kayıt korunur (creator=${creator}, missing=${missing})`, async () => {
      const stack = await createActualStack(partialSeed({ creator }), { sicil: SICIL, corporateWbsSource: false });
      try {
        const initial = stack.state.tasks.find((row) => row.id === TASK_ID);
        assert.equal(initial.assigneeIds.includes(String(SICIL + 1)), creator);
        if (missing) stack.db.people = stack.db.people.filter((row) => row.Sicil !== SICIL + 1);
        for (const title of ['Birinci kayıt', 'İkinci kayıt']) {
          const result = await stack.persistence.mutate('task/update', { type: 'task/update', id: TASK_ID, patch: { task: title } });
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.deepEqual(stack.state.tasks.find((row) => row.id === TASK_ID).assigneeIds, initial.assigneeIds);
          assert.equal(stack.db.taskAssignees.filter((row) => String(row.TaskId).toLowerCase() === TASK_ID).length, 2);
        }
        await stack.reload();
        assert.deepEqual(stack.state.tasks.find((row) => row.id === TASK_ID).assigneeIds, initial.assigneeIds);
      } finally { await stack.dispose(); }
    });
  }
}

test('ilgisiz FULL projesi PARTIAL görevde gizli eş sorumluyu açmaz veya gerektirmez', async () => {
  const data = partialSeed();
  data.projectAccess.push({ ProjectId: OTHER_PROJECT, Sicil: SICIL, AccessLevel: 'FULL' });
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const initial = stack.state.tasks.find((row) => row.id === TASK_ID);
    assert.deepEqual(initial.assigneeIds, [String(SICIL)]);
    for (const title of ['Bir', 'İki']) {
      const result = await stack.persistence.mutate('task/update', { type: 'task/update', id: TASK_ID, patch: { task: title } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(stack.state.tasks.find((row) => row.id === TASK_ID).assigneeIds, [String(SICIL)]);
    }
  } finally { await stack.dispose(); }
});

test('ASSIGNEE_CREATE seçilen öncülü gerçek oluşturma/kayıt/yeniden yükleme zincirinde korur', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const id = '98888888-8888-4888-8888-888888888888';
    const created = await executeTaskCreation({ state: stack.state, id,
      input: { projectId: PROJECT_ID, task: 'Bağımlı yeni görev', deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }] },
      mutate: stack.persistence.mutate });
    assert.equal(created.scope, 'ASSIGNEE_CREATE');
    assert.equal(created.result.ok, true, JSON.stringify(created.result));
    await stack.reload();
    assert.deepEqual(stack.state.tasks.find((task) => task.id === id).deps.map((dep) => dep.predecessorId), [PREDECESSOR_ID]);
  } finally { await stack.dispose(); }
});

test('silme salt okunur ardılı kaydetmez; sunucu yalnızca ilişkiyi temizler', async () => {
  const data = partialSeed({ creator: true });
  data.taskAssignees = data.taskAssignees.filter((row) => !(String(row.TaskId).toLowerCase() === PREDECESSOR_ID && row.Sicil !== SICIL));
  data.tasks.find((row) => row.TaskId === TASK_ID).CreatedBySicil = SICIL + 1;
  data.projectAccess.push({ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'READ' });
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const before = { ...stack.db.tasks.find((task) => String(task.TaskId).toLowerCase() === TASK_ID) };
    const result = await stack.persistence.mutate('task/delete', { type: 'task/delete', id: PREDECESSOR_ID });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(stack.db.tasks.find((task) => String(task.TaskId).toLowerCase() === TASK_ID), before);
    assert.equal(stack.db.taskDependencies.some((dep) => String(dep.PredecessorTaskId).toLowerCase() === PREDECESSOR_ID), false);
  } finally { await stack.dispose(); }
});

for (const partial of [false, true]) {
  test(`ilişki yazması görev ağını ilişki satırlarından önce kilitler (partial=${partial})`, async () => {
    const stack = await createActualStack(partial ? partialSeed() : seed(), { sicil: SICIL, corporateWbsSource: false });
    try {
      const task = stack.state.tasks.find((row) => row.id === TASK_ID);
      const start = stack.db.statements.length;
      await stack.repository.commitChanges({ taskUpserts: [{ ...task, dependencyMutation: true,
        dependencyChanges: { upserts: [{ predecessorId: PREDECESSOR_ID, type: 'FF', lagDays: 0 }], removals: [] } }] });
      const queries = stack.db.statements.slice(start).map((row) => row.sql);
      const firstTask = queries.findIndex((sql) => sql.includes('/* commit-task-lock */'));
      const firstEdge = queries.findIndex((sql) => sql.includes('/* commit-dependency-lock */'));
      const lastProject = queries.findLastIndex((sql) => sql.includes('/* commit-project-lock */'));
      assert.ok(lastProject >= 0 && lastProject < firstTask && firstTask < firstEdge);
    } finally { await stack.dispose(); }
  });
}

test('içerik niyeti eski ilişki yükünü HTTP doğrulamasında da yok sayar', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    const result = await stack.repository.commitChanges({ taskUpserts: [{ ...task, task: 'Geçerli içerik',
      dependencyMutation: false, assigneeMutation: false,
      deps: [{ predecessorId: 'eskimiş-projeksiyon', type: 'ESKI', lagDays: 'eskimiş' }],
      dependencyChanges: { upserts: null, removals: ['eskimiş'] } }] });
    assert.equal(result.taskUpserts.find((row) => row.id === TASK_ID).task, 'Geçerli içerik');
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});

test('ilişki deltası mevcut tür/gecikme/tekrar/sınır doğrulamasını atlayamaz', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((row) => row.id === TASK_ID);
    const valid = { predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 };
    for (const delta of [
      { upserts: [{ ...valid, type: 'INVALID' }], removals: [] },
      { upserts: [{ ...valid, lagValue: 3000, lagUnit: 'month' }], removals: [] },
      { upserts: [valid, valid], removals: [] },
      { upserts: [valid], removals: [1] },
      { upserts: [], removals: Array(501).fill(PREDECESSOR_ID) }
    ]) {
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...task, dependencyMutation: true, dependencyChanges: delta }] }), { code: 'MUTATION_FAILED' });
    }
    assert.equal(stack.db.taskDependencies.length, 2);
  } finally { await stack.dispose(); }
});


test('explicit edge updates/removals preserve untouched row identity and creation provenance', async () => {
  const data = partialSeed();
  data.taskDependencies.forEach((row, i) => Object.assign(row, {
    TaskDependencyId: `a0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    CreatedBySicil: SICIL + 1, UpdatedBySicil: SICIL + 1,
    CreatedAt: '2025-01-01T00:00:00.000Z', UpdatedAt: '2025-02-01T00:00:00.000Z'
  }));
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const hidden = structuredClone(stack.db.taskDependencies.find((d) => d.PredecessorTaskId.toLowerCase() === HIDDEN_ID));
    const visible = structuredClone(stack.db.taskDependencies.find((d) => d.PredecessorTaskId.toLowerCase() === PREDECESSOR_ID));
    const task = stack.state.tasks.find((t) => t.id === TASK_ID);
    await stack.repository.commitChanges({ taskUpserts: [{ ...task, dependencyMutation: true, assigneeMutation: false,
      dependencyChanges: { upserts: [{ predecessorId: PREDECESSOR_ID, type: 'FF', lagDays: 3 }], removals: [] } }] });
    assert.deepEqual(stack.db.taskDependencies.find((d) => d.PredecessorTaskId.toLowerCase() === HIDDEN_ID), hidden);
    const updated = stack.db.taskDependencies.find((d) => d.PredecessorTaskId.toLowerCase() === PREDECESSOR_ID);
    assert.equal(updated.TaskDependencyId, visible.TaskDependencyId);
    assert.equal(updated.CreatedBySicil, visible.CreatedBySicil);
    assert.equal(updated.CreatedAt, visible.CreatedAt);
    assert.equal(updated.DependencyType, 'FF');
    await stack.reload();
    const current = stack.state.tasks.find((t) => t.id === TASK_ID);
    await stack.repository.commitChanges({ taskUpserts: [{ ...current, dependencyMutation: true, assigneeMutation: false,
      dependencyChanges: { upserts: [], removals: [PREDECESSOR_ID] } }] });
    assert.deepEqual(stack.db.taskDependencies, [hidden]);
    await stack.reload();
    const start = stack.db.statements.length;
    await stack.repository.commitChanges({ taskUpserts: [{ ...stack.state.tasks.find((t) => t.id === TASK_ID), task: 'Content',
      dependencyMutation: false, assigneeMutation: false }] });
    assert.deepEqual(stack.db.taskDependencies, [hidden]);
    assert.equal(stack.db.statements.slice(start).some(({ sql }) => /(?:INSERT|UPDATE|DELETE) dbo.MR_TaskDependencies/.test(sql)), false);
    assert.equal(stack.db.statements.slice(start).some(({ sql }) => /MR_(?:Projects|Calendars) WITH \(UPDLOCK/.test(sql)), false);
  } finally { await stack.dispose(); }
});

function movingSeed() {
  const data = seed();
  data.projects.push({ ...data.projects[0], ProjectId: OTHER_PROJECT, ProjectCode: 'DEST', ProjectName: 'Destination' });
  return data;
}

for (const moved of ['both', 'predecessor', 'successor']) {
  test(`atomic ${moved} move preserves retained edge or applies its explicit pre-move removal`, async () => {
    const stack = await createActualStack(movingSeed(), { sicil: SICIL, corporateWbsSource: false });
    try {
      const edge = structuredClone(stack.db.taskDependencies[0]);
      const successor = stack.state.tasks.find((t) => t.id === TASK_ID);
      const predecessor = stack.state.tasks.find((t) => t.id === PREDECESSOR_ID);
      const taskUpserts = [{ ...successor, projectId: moved === 'predecessor' ? PROJECT_ID : OTHER_PROJECT,
        // A stale/partial projection never becomes replacement truth, even during a move.
        deps: [], dependencyMutation: true, assigneeMutation: false,
        dependencyChanges: { upserts: [], removals: moved === 'both' ? [] : [PREDECESSOR_ID] } }];
      if (moved !== 'successor') taskUpserts.push({ ...predecessor, projectId: OTHER_PROJECT, deps: [], dependencyMutation: true,
        assigneeMutation: false, dependencyChanges: { upserts: [], removals: [] } });
      const response = await stack.repository.commitChanges({ taskUpserts });
      if (moved === 'both') {
        assert.deepEqual(stack.db.taskDependencies, [{ ...edge, ProjectId: OTHER_PROJECT.toUpperCase() }]);
        const { appStateReducer } = await import('../src/state/appState.js');
        const state = appStateReducer(stack.state, { type: 'data/apply-changes', changes: response });
        assert.ok(state.tasks.find((t) => t.id === TASK_ID).deps.some((d) => d.predecessorId === PREDECESSOR_ID));
      } else assert.equal(stack.db.taskDependencies.length, 0);
      await stack.reload();
      assert.equal(stack.state.tasks.find((t) => t.id === TASK_ID).deps.length, moved === 'both' ? 1 : 0);
    } finally { await stack.dispose(); }
  });
}

for (const contentSuccessor of [false, true]) {
  test(`unreconciled cross-project move fails atomically (contentSuccessor=${contentSuccessor})`, async () => {
    const stack = await createActualStack(movingSeed(), { sicil: SICIL, corporateWbsSource: false });
    try {
      const tasks = stack.db.tasks.map((t) => ({ ...t, RowVersion: Buffer.from(t.RowVersion) })), edges = structuredClone(stack.db.taskDependencies);
      const predecessor = stack.state.tasks.find((t) => t.id === PREDECESSOR_ID);
      const taskUpserts = [{ ...predecessor, projectId: OTHER_PROJECT, dependencyMutation: true,
        dependencyChanges: { upserts: [], removals: [] } }];
      if (contentSuccessor) taskUpserts.push({ ...stack.state.tasks.find((t) => t.id === TASK_ID), dependencyMutation: false, assigneeMutation: false });
      await assert.rejects(stack.repository.commitChanges({ taskUpserts }), { code: 'MUTATION_FAILED' });
      assert.deepEqual(stack.db.tasks, tasks);
      assert.deepEqual(stack.db.taskDependencies, edges);
    } finally { await stack.dispose(); }
  });
}

test('readback includes a predecessor that became visible after editor load', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((t) => t.id === TASK_ID);
    assert.equal(stack.state.tasks.some((t) => t.id === HIDDEN_ID), false);
    stack.db.taskAssignees.push({ TaskId: HIDDEN_ID.toUpperCase(), Sicil: SICIL });
    const response = await stack.repository.commitChanges({ taskUpserts: [{ ...task, task: 'New title', dependencyMutation: false, assigneeMutation: false }] });
    const returnedIds = new Set(response.taskUpserts.map((t) => t.id));
    for (const row of response.taskUpserts) for (const dep of row.deps || []) assert.ok(returnedIds.has(dep.predecessorId));
    assert.ok(returnedIds.has(HIDDEN_ID));
    const { appStateReducer } = await import('../src/state/appState.js');
    const state = appStateReducer(stack.state, { type: 'data/apply-changes', changes: response });
    const saved = state.tasks.find((t) => t.id === TASK_ID);
    for (const dep of saved.deps) assert.ok(state.tasks.some((t) => t.id === dep.predecessorId));
  } finally { await stack.dispose(); }
});


test('client save-draft moves both endpoints without manufacturing dependency removals', async () => {
  const stack = await createActualStack(movingSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const edge = structuredClone(stack.db.taskDependencies[0]);
    const result = await stack.persistence.mutate('task/save-draft', { type: 'task/save-draft',
      updates: [TASK_ID, PREDECESSOR_ID].map((id) => ({ id, patch: { projectId: OTHER_PROJECT, wbsId: null } })) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stack.db.taskDependencies[0].TaskDependencyId, edge.TaskDependencyId);
    assert.equal(stack.state.tasks.find((t) => t.id === TASK_ID).deps[0].predecessorId, PREDECESSOR_ID);
  } finally { await stack.dispose(); }
});

test('hidden task project guesses share one content-save authorization response', async () => {
  const stack = await createActualStack(partialSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((t) => t.id === TASK_ID);
    for (const projectId of [PROJECT_ID, OTHER_PROJECT]) await assert.rejects(stack.repository.commitChanges({
      taskUpserts: [{ ...task, id: HIDDEN_ID, projectId, dependencyMutation: false, assigneeMutation: false }]
    }), { code: 'FORBIDDEN' });
  } finally { await stack.dispose(); }
});


test('task deletion can invalidate an old edge while another delta updates the successor', async () => {
  const data = seed();
  data.tasks.push({ ...data.tasks[1], TaskId: OTHER_TASK });
  data.taskAssignees.push({ TaskId: OTHER_TASK, Sicil: SICIL });
  const stack = await createActualStack(data, { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((t) => t.id === TASK_ID);
    const predecessor = stack.state.tasks.find((t) => t.id === PREDECESSOR_ID);
    await stack.repository.commitChanges({ taskDeletes: [{ id: predecessor.id, version: predecessor.version }], taskUpserts: [{ ...task,
      dependencyMutation: true, dependencyChanges: { upserts: [{ predecessorId: OTHER_TASK, type: 'SS', lagDays: 0 }], removals: [] } }] });
    assert.equal(stack.db.taskDependencies.length, 1);
    assert.equal(stack.db.taskDependencies[0].PredecessorTaskId.toLowerCase(), OTHER_TASK);
  } finally { await stack.dispose(); }
});

test('readback starts after mutation locks are released and is not replayed as a mutation', async () => {
  const stack = await createActualStack(seed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    stack.db.transactions.length = 0;
    await stack.repository.commitChanges({ taskUpserts: [{ ...stack.state.tasks.find((t) => t.id === TASK_ID), dependencyMutation: false, assigneeMutation: false }] });
    const [mutation, readback] = stack.db.transactions;
    assert.equal(stack.db.transactions.length, 2);
    assert.ok(mutation.commitStatementIndex <= readback.statementIndex);
    const { withSqlTransaction, afterSqlCommit, isWithinSqlTransaction } = await import('../src/server/db/pool.js');
    let writes = 0;
    await assert.rejects(withSqlTransaction(async () => {
      writes++;
      return afterSqlCommit(async () => {
        assert.equal(isWithinSqlTransaction(), false);
        throw Object.assign(new Error('readback deadlock'), { number: 1205 });
      });
    }, { deadlockRetries: 1 }), /readback deadlock/);
    assert.equal(writes, 1);
  } finally { await stack.dispose(); }
});
