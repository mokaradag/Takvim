import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import { commitTaskEditorEdits } from '../src/state/taskEditorCommit.js';
import { normalizeScheduleQuery } from '../src/server/schedule-change/scheduleRequestQueryNormalization.js';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const PREDECESSOR_ID = '33333333-3333-4333-8333-333333333333';
const SICIL = 900001;
const PARTIAL_SICIL = 900002;
const THIRD_SICIL = 900003;

function seed() {
  return {
    calendars: [],
    projects: [{ id: PROJECT_ID, name: 'Proje', accessLevel: 'FULL' }],
    people: [{ id: '1', name: 'Kullanıcı' }],
    wbs: [],
    tasks: [
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        wbsId: null,
        task: 'Görev',
        description: '',
        keyword: '',
        status: 'todo',
        priority: 'medium',
        progress: 0,
        assigneeIds: ['1'],
        deps: [],
        version: 'AQ=='
      },
      {
        id: PREDECESSOR_ID,
        projectId: PROJECT_ID,
        wbsId: null,
        task: 'Öncül',
        description: '',
        keyword: '',
        status: 'todo',
        priority: 'medium',
        progress: 0,
        assigneeIds: ['1'],
        deps: [],
        version: 'AQ=='
      }
    ],
    baselines: [],
    taskBaselineSnapshots: []
  };
}

function createPersistence(repository) {
  let state = createInitialState(seed());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) {
      state = appStateReducer(state, action);
      return state;
    },
    taskPatchDelayMs: 60_000
  });
  return { persistence, state: () => state };
}

function actualSeed() {
  return {
    calendars: [{
      CalendarId: DEFAULT_CALENDAR_ID,
      Name: 'Kurumsal Takvim',
      IsDefault: 1,
      IsActive: 1,
      WorkingDays: [1, 2, 3, 4, 5]
    }],
    people: [
      { Sicil: SICIL, DisplayName: 'Proje Yetkilisi', Username: 'u900001' },
      { Sicil: PARTIAL_SICIL, DisplayName: 'Görev Sorumlusu', Username: 'u900002' },
      { Sicil: THIRD_SICIL, DisplayName: 'İkinci Sorumlu', Username: 'u900003' }
    ],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'SAVE',
      ProjectName: 'Kayıt Projesi',
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
        Title: 'Görev',
        Description: '',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      },
      {
        TaskId: PREDECESSOR_ID,
        ProjectId: PROJECT_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Öncül',
        Description: '',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      }
    ],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: SICIL },
      { TaskId: TASK_ID, Sicil: PARTIAL_SICIL },
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

test('tarih talebi sorgusu düz ve istemci önekli Actual-System kimliklerini aynı UUIDye indirger', () => {
  const taskUpper = TASK_ID.toUpperCase();
  const projectUpper = PROJECT_ID.toUpperCase();
  assert.equal(normalizeScheduleQuery({ taskId: TASK_ID }).taskId, TASK_ID);
  assert.equal(normalizeScheduleQuery({ taskId: `task-${taskUpper}` }).taskId, TASK_ID);
  assert.equal(normalizeScheduleQuery({ projectId: PROJECT_ID }).projectId, PROJECT_ID);
  assert.equal(normalizeScheduleQuery({ projectId: `project-${projectUpper}` }).projectId, PROJECT_ID);
});

test('tarih talebi sorgusu rastgele veya yanlış türde kimlik öneklerini reddeder', () => {
  for (const taskId of [`foo-${TASK_ID}`, `wbs-${TASK_ID}`, `task-ek-${TASK_ID}`, 'task-gecersiz']) {
    assert.throws(
      () => normalizeScheduleQuery({ taskId }),
      (error) => error.code === 'MUTATION_FAILED' && error.message === 'Proje veya görev kimliği geçersiz.'
    );
  }
  assert.throws(
    () => normalizeScheduleQuery({ projectId: `task-${PROJECT_ID}` }),
    (error) => error.code === 'MUTATION_FAILED' && error.message === 'Proje veya görev kimliği geçersiz.'
  );
});

test('mevcut görev paneli normal istemci görev kimliğini tarih talebi sorgusuna verir', () => {
  const overlay = readFileSync(new URL('../src/features/task-detail/TaskDetailOverlay.jsx', import.meta.url), 'utf8');
  assert.match(overlay, /useScheduleRequestQuery\([\s\S]*taskId:\s*task\?\.id/);
  assert.equal(normalizeScheduleQuery({ taskId: `task-${TASK_ID}` }).taskId, TASK_ID);
});

test('önceki boşaltma aynı düzenlemeyi kalıcılaştırdıysa son Kaydet ikinci commit yapmaz', async () => {
  const calls = [];
  const repository = {
    async commitChanges(changes) {
      calls.push(changes);
      return {
        ...changes,
        taskUpserts: changes.taskUpserts.map((task) => ({ ...task, version: 'Ag==' }))
      };
    }
  };
  const stack = createPersistence(repository);
  try {
    const pending = stack.persistence.updateTask(TASK_ID, { description: 'Kaydedilmiş not' });
    const result = await commitTaskEditorEdits(
      stack.persistence,
      stack.state,
      [{ id: TASK_ID, version: 'AQ==', patch: { description: 'Kaydedilmiş not' } }],
      { taskId: TASK_ID }
    );

    assert.equal((await pending).ok, true);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskUpserts[0].dependencyMutation, false);
    assert.equal(stack.state().tasks.find((task) => task.id === TASK_ID).description, 'Kaydedilmiş not');
  } finally {
    stack.persistence.dispose();
  }
});

test('kalıcılaştırma başarısızsa Kaydet başarısız döner ve yeniden denenecek yama korunur', async () => {
  const repository = {
    async commitChanges() {
      const error = new Error('geçici hata');
      error.code = 'DATABASE_UNAVAILABLE';
      throw error;
    }
  };
  const stack = createPersistence(repository);
  try {
    stack.persistence.updateTask(TASK_ID, { description: 'Korunacak not' });
    const result = await commitTaskEditorEdits(
      stack.persistence,
      stack.state,
      [{ id: TASK_ID, version: 'AQ==', patch: { description: 'Korunacak not' } }],
      { taskId: TASK_ID }
    );

    assert.equal(result.ok, false);
    assert.equal(stack.persistence.hasFailedTaskUpdates([TASK_ID]), true);
  } finally {
    stack.persistence.dispose();
  }
});

test('bağımlılık niyeti yalnız deps veya proje yapısı değiştiğinde işaretlenir', async () => {
  const calls = [];
  const repository = {
    async commitChanges(changes) {
      calls.push(changes);
      return {
        ...changes,
        taskUpserts: changes.taskUpserts.map((task) => ({ ...task, version: `A${calls.length + 1}==` }))
      };
    }
  };
  const stack = createPersistence(repository);
  try {
    const contentUpdate = stack.persistence.updateTask(TASK_ID, { description: 'İçerik' });
    await stack.persistence.flushTaskUpdates([TASK_ID]);
    assert.equal((await contentUpdate).ok, true);
    assert.equal(calls[0].taskUpserts[0].dependencyMutation, false);

    const dependencyUpdate = stack.persistence.updateTask(TASK_ID, {
      deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 }]
    });
    await stack.persistence.flushTaskUpdates([TASK_ID]);
    assert.equal((await dependencyUpdate).ok, true);
    assert.equal(calls[1].taskUpserts[0].dependencyMutation, true);
  } finally {
    stack.persistence.dispose();
  }
});

test('bağımlılık düzenlenmediyse tam yetkili içerik kaydı mevcut bağımlılığı korur', async () => {
  const stack = await createActualStack(actualSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    assert.equal(task.deps.length, 1);
    const statementStart = stack.db.statements.length;
    const contentOnly = await stack.repository.commitChanges({
      taskUpserts: [{
        ...task,
        task: 'Güncellenmiş görev',
        assigneeMutation: false,
        dependencyMutation: false
      }]
    });
    const contentStatements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);
    assert.equal(
      contentStatements.filter((sql) => sql.includes('DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId')).length,
      0,
      'değişmeyen bağımlılıklar yeniden yazılmamalıdır'
    );
    assert.equal(
      contentStatements.filter((sql) => sql.includes('INSERT dbo.MR_TaskDependencies(')).length,
      0,
      'değişmeyen bağımlılıklar yeniden eklenmemelidir'
    );
    assert.equal(
      contentStatements.filter((sql) => sql.includes(
        'SELECT TOP (1) ProjectId FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK) WHERE ProjectId = @projectId AND IsActive = 1'
      )).length,
      1,
      'aynı projedeki kaynak ve hedef kapsamı tek etkin-proje sorgusunu paylaşmalıdır'
    );
    assert.equal(contentOnly.taskUpserts[0].deps.length, 1);
    assert.equal(contentOnly.taskUpserts[0].deps[0].predecessorId, PREDECESSOR_ID);
    assert.equal(stack.db.taskDependencies.length, 1);

    const structural = await stack.repository.commitChanges({
      taskUpserts: [{
        ...contentOnly.taskUpserts[0],
        deps: [],
        assigneeMutation: false,
        dependencyMutation: true
      }]
    });
    assert.equal(structural.taskUpserts[0].deps.length, 0);
    assert.equal(stack.db.taskDependencies.length, 0);
  } finally {
    await stack.dispose();
  }
});

test('aynı öncülün bağımlılık öznitelikleri değiştiğinde satır yeniden yazılır', async () => {
  const cases = [
    ['type', { type: 'SS' }],
    ['lagDays', { lagDays: 2 }],
    ['lagValue', { lagValue: 3 }],
    ['lagUnit', { lagUnit: 'day' }]
  ];

  for (const [field, patch] of cases) {
    const stack = await createActualStack(actualSeed(), { sicil: SICIL, corporateWbsSource: false });
    try {
      const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
      const statementStart = stack.db.statements.length;
      await stack.repository.commitChanges({
        taskUpserts: [{
          ...task,
          deps: task.deps.map((dependency) => ({ ...dependency, ...patch })),
          assigneeMutation: false,
          dependencyMutation: false
        }]
      });

      const statements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);
      assert.equal(
        statements.filter((sql) => sql.includes('DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId')).length,
        1,
        `${field} değişikliği bağımlılık satırını yeniden yazmalıdır`
      );
      assert.equal(
        statements.filter((sql) => sql.includes('INSERT dbo.MR_TaskDependencies(')).length,
        1,
        `${field} değişikliği yeni bağımlılık satırını eklemelidir`
      );
      const persisted = stack.db.taskDependencies.find((entry) => (
        String(entry.TaskId).toLowerCase() === TASK_ID
        && String(entry.PredecessorTaskId).toLowerCase() === PREDECESSOR_ID
      ));
      assert.ok(persisted);
      const column = {
        type: 'DependencyType',
        lagDays: 'LagDays',
        lagValue: 'LagValue',
        lagUnit: 'LagUnit'
      }[field];
      assert.equal(persisted[column], patch[field]);
    } finally {
      await stack.dispose();
    }
  }
});

test('kısmi yetkili içerik kaydı gizli bağımlılığı açığa çıkarmadan veya silmeden tamamlanır', async () => {
  const stack = await createActualStack(actualSeed(), { sicil: PARTIAL_SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    assert.equal(stack.state.projects.find((entry) => entry.id === PROJECT_ID)?.accessLevel, 'PARTIAL');
    assert.deepEqual(task.deps, []);

    const result = await stack.repository.commitChanges({
      taskUpserts: [{
        ...task,
        description: 'Sorumlu notu',
        assigneeMutation: false,
        dependencyMutation: false
      }]
    });

    assert.equal(result.taskUpserts[0].description, 'Sorumlu notu');
    assert.deepEqual(result.taskUpserts[0].deps, []);
    assert.equal(stack.db.taskDependencies.length, 1);
    assert.equal(String(stack.db.taskDependencies[0].PredecessorTaskId).toLowerCase(), PREDECESSOR_ID);
  } finally {
    await stack.dispose();
  }
});

test('sorumlu listesi değiştiğinde Sicil doğrulaması tek set sorgusuyla yapılır', async () => {
  const stack = await createActualStack(actualSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    const statementStart = stack.db.statements.length;
    const result = await stack.repository.commitChanges({
      taskUpserts: [{
        ...task,
        assigneeIds: [String(SICIL), String(THIRD_SICIL)],
        assigneeMutation: true,
        dependencyMutation: false
      }]
    });

    const statements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);
    assert.equal(
      statements.filter((sql) => sql.includes('STRING_SPLIT(@sicils')).length,
      1,
      'birden çok Sicil tek rehber sorgusunda doğrulanmalıdır'
    );
    assert.deepEqual(
      result.taskUpserts[0].assigneeIds.map(Number).sort((a, b) => a - b),
      [SICIL, THIRD_SICIL]
    );
  } finally {
    await stack.dispose();
  }
});

test('eşzamanlı sürüm çakışması içerik kaydında da CONFLICT olarak kalır', async () => {
  const stack = await createActualStack(actualSeed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const stale = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    const first = await stack.repository.commitChanges({
      taskUpserts: [{
        ...stale,
        description: 'İlk kayıt',
        assigneeMutation: false,
        dependencyMutation: false
      }]
    });
    assert.equal(first.taskUpserts[0].description, 'İlk kayıt');

    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          ...stale,
          description: 'Eski sürümden ikinci kayıt',
          assigneeMutation: false,
          dependencyMutation: false
        }]
      }),
      (error) => error.code === 'CONFLICT'
    );
  } finally {
    await stack.dispose();
  }
});