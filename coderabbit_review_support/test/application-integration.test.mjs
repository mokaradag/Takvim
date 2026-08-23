import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';
import {
  selectPersonById,
  selectProjectById,
  selectTaskById,
  selectTasksByPerson,
  selectTasksByProject
} from '../src/domain/selectors/index.js';
import { selectTaskStats } from '../src/scheduling/metrics/index.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import {
  buildPortfolioSchedule,
  selectProjectSchedule,
  selectTaskSchedule
} from '../src/state/selectors/scheduleSelectors.js';

function makeSeed() {
  return {
    calendars: [
      {
        id: 'cal-weekday',
        name: 'Weekday',
        timezone: 'Europe/Istanbul',
        workingDays: [1, 2, 3, 4, 5],
        holidays: []
      },
      {
        id: 'cal-six-day',
        name: 'Six Day',
        timezone: 'Europe/Istanbul',
        workingDays: [1, 2, 3, 4, 5, 6],
        holidays: []
      }
    ],
    projects: [
      { id: 'p1', name: 'Alpha', leadId: 'u1', calendarId: 'cal-weekday', dataDate: '2026-07-22' },
      { id: 'p2', name: 'Beta', leadId: 'u2', calendarId: 'cal-six-day', dataDate: '2026-07-22' }
    ],
    people: [
      { id: 'u1', name: 'Ayşe Kaya' },
      { id: 'u2', name: 'Bora Demir' }
    ],
    wbs: [
      { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'Alpha', sortOrder: 1 },
      { id: 'p1-work', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'Work', sortOrder: 1 },
      { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Beta', sortOrder: 1 }
    ],
    tasks: [
      {
        id: 't1',
        task: 'Legacy discovery',
        proje: 'Alpha',
        sorumlu: ['Ayşe Kaya'],
        baslangicTarihi: '2026-07-20',
        bitisTarihi: '2026-07-22',
        hedefTarih: '2026-07-24',
        status: 'in_progress',
        deps: []
      },
      {
        id: 't2',
        task: 'Implementation',
        projectId: 'p1',
        wbsId: 'p1-work',
        assigneeIds: ['u2'],
        plannedStart: '2026-07-23',
        plannedFinish: '2026-07-24',
        plannedDurationDays: 2,
        targetFinish: '2026-07-24',
        status: 'todo',
        deps: [{ predecessorId: 't1', type: 'FS', lagDays: 0 }]
      },
      {
        id: 't3',
        task: 'Beta task',
        projectId: 'p2',
        wbsId: 'p2-root',
        assigneeIds: ['u2'],
        plannedStart: '2026-07-20',
        plannedFinish: '2026-07-21',
        plannedDurationDays: 2,
        targetFinish: '2026-07-21',
        status: 'done',
        deps: []
      }
    ],
    baselines: [
      { id: 'b1', projectId: 'p1', name: 'Initial', isPrimary: true }
    ],
    taskBaselineSnapshots: [
      { id: 's1', baselineId: 'b1', taskId: 't1', plannedStart: '2026-07-20', plannedFinish: '2026-07-22' }
    ]
  };
}

async function loadState(repository) {
  return createInitialState(await repository.loadSnapshot());
}

function scheduleFor(state) {
  return buildPortfolioSchedule({
    tasks: state.tasks,
    projects: state.projects,
    calendars: state.calendars
  });
}

test('repository snapshot boots into a ready application state', async () => {
  const repository = createMockRepository(makeSeed());
  const snapshot = await repository.loadSnapshot();
  const state = createInitialState(snapshot);
  assert.equal(state.dataStatus, 'ready');
  assert.equal(state.loadError, null);
  assert.equal(state.projects.length, 2);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.wbs.length, 3);
  assert.equal(state.baselines.length, 1);
  assert.equal(state.taskBaselineSnapshots.length, 1);
});

test('application boot migrates legacy task schedule fields into the canonical model', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const task = selectTaskById(state.tasks, 't1');
  assert.equal(task.plannedStart, '2026-07-20');
  assert.equal(task.plannedFinish, '2026-07-22');
  assert.equal(task.targetFinish, '2026-07-24');
  assert.equal(task.plannedDurationDays, 3);
  assert.equal('baslangicTarihi' in task, false);
  assert.equal('bitisTarihi' in task, false);
  assert.equal('hedefTarih' in task, false);
});

test('application boot resolves legacy project, assignee, and default WBS references', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const task = selectTaskById(state.tasks, 't1');
  assert.equal(task.projectId, 'p1');
  assert.equal(task.proje, 'Alpha');
  assert.deepEqual(task.assigneeIds, ['u1']);
  assert.deepEqual(task.sorumlu, ['Ayşe Kaya']);
  assert.equal(task.wbsId, 'p1-root');
});

test('application boot normalizes dependency records without losing relationship semantics', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  assert.deepEqual(selectTaskById(state.tasks, 't2').deps, [
    { id: 't1', predecessorId: 't1', type: 'FS', lagDays: 0 }
  ]);
});

test('normalized application state is immediately schedulable across projects', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const schedule = scheduleFor(state);
  assert.equal(schedule.status, 'valid');
  assert.deepEqual(schedule.warnings, []);
  assert.equal(selectProjectSchedule(schedule, 'p1').status, 'valid');
  assert.equal(selectProjectSchedule(schedule, 'p2').status, 'valid');
});

test('portfolio schedule projects every scheduled task back to its owning project', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const schedule = scheduleFor(state);
  for (const task of state.tasks) {
    const projected = selectTaskSchedule(schedule, task.id);
    assert.ok(projected, task.id);
    assert.equal(projected.projectId, task.projectId);
  }
});

test('schedule derivation does not mutate normalized application tasks', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const before = structuredClone(state.tasks);
  scheduleFor(state);
  assert.deepEqual(state.tasks, before);
});

test('domain selectors operate correctly on normalized boot state', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  assert.equal(selectProjectById(state.projects, 'p2')?.name, 'Beta');
  assert.equal(selectPersonById(state.people, 'u1')?.name, 'Ayşe Kaya');
  assert.deepEqual(selectTasksByProject(state.tasks, 'p1').map((task) => task.id), ['t1', 't2']);
  assert.deepEqual(selectTasksByPerson(state.tasks, 'u2').map((task) => task.id), ['t2', 't3']);
});

test('aggregate statistics can be calculated directly from booted application state', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const stats = selectTaskStats(state.tasks, new Date(2026, 6, 22));
  assert.deepEqual(stats, {
    total: 3,
    active: 2,
    inProgress: 1,
    todo: 1,
    done: 1,
    overdue: 0,
    compRate: 33
  });
});

test('task reducer updates canonical assignee IDs from legacy display-name edits', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const next = appStateReducer(state, {
    type: 'task/update',
    id: 't1',
    patch: { sorumlu: ['Bora Demir'] }
  });
  const task = selectTaskById(next.tasks, 't1');
  assert.deepEqual(task.sorumlu, ['Bora Demir']);
  assert.deepEqual(task.assigneeIds, ['u2']);
});

test('task reducer changes project ownership and assigns the destination project default WBS', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const next = appStateReducer(state, {
    type: 'task/update',
    id: 't1',
    patch: { proje: 'Beta' }
  });
  const task = selectTaskById(next.tasks, 't1');
  assert.equal(task.projectId, 'p2');
  assert.equal(task.proje, 'Beta');
  assert.equal(task.wbsId, 'p2-root');
});

test('reducer-normalized task updates round-trip through repository persistence', async () => {
  const repository = createMockRepository(makeSeed());
  const state = await loadState(repository);
  const next = appStateReducer(state, {
    type: 'task/update',
    id: 't1',
    patch: { sorumlu: ['Bora Demir'], targetFinish: '2026-07-27' }
  });
  const updated = selectTaskById(next.tasks, 't1');
  await repository.commitChanges({ taskUpserts: [updated] });
  const reloaded = await loadState(repository);
  const persisted = selectTaskById(reloaded.tasks, 't1');
  assert.deepEqual(persisted.assigneeIds, ['u2']);
  assert.deepEqual(persisted.sorumlu, ['Bora Demir']);
  assert.equal(persisted.targetFinish, '2026-07-27');
});

test('persisted task date changes are reflected by a newly derived portfolio schedule', async () => {
  const repository = createMockRepository(makeSeed());
  const state = await loadState(repository);
  const before = scheduleFor(state);
  const task = selectTaskById(state.tasks, 't3');
  await repository.commitChanges({
    taskUpserts: [{ ...task, plannedStart: '2026-07-25', plannedFinish: '2026-07-27', plannedDurationDays: 2 }]
  });
  const afterState = await loadState(repository);
  const after = scheduleFor(afterState);
  assert.notEqual(selectProjectSchedule(after, 'p2').projectStart, selectProjectSchedule(before, 'p2').projectStart);
  assert.equal(selectTaskSchedule(after, 't3').earlyStart, '2026-07-25');
});

test('task deletion persists through reload and disappears from schedule projection', async () => {
  const repository = createMockRepository(makeSeed());
  await repository.commitChanges({ taskDeletes: ['t3'] });
  const state = await loadState(repository);
  const schedule = scheduleFor(state);
  assert.equal(selectTaskById(state.tasks, 't3'), null);
  assert.equal(selectTaskSchedule(schedule, 't3'), null);
  assert.equal(selectProjectSchedule(schedule, 'p2').status, 'empty');
});

test('new WBS nodes and task assignments round-trip through the repository together', async () => {
  const repository = createMockRepository(makeSeed());
  const state = await loadState(repository);
  const task = selectTaskById(state.tasks, 't1');
  const node = { id: 'p1-new', projectId: 'p1', parentId: 'p1-root', code: '1.2', name: 'New scope', sortOrder: 2 };
  await repository.commitChanges({
    wbsUpserts: [node],
    taskUpserts: [{ ...task, wbsId: node.id }]
  });
  const reloaded = await loadState(repository);
  assert.equal(reloaded.wbs.some((item) => item.id === node.id), true);
  assert.equal(selectTaskById(reloaded.tasks, 't1').wbsId, node.id);
});

test('WBS deletion and task reassignment can be persisted atomically', async () => {
  const repository = createMockRepository(makeSeed());
  const state = await loadState(repository);
  const task = selectTaskById(state.tasks, 't2');
  await repository.commitChanges({
    taskUpserts: [{ ...task, wbsId: 'p1-root' }],
    wbsDeletes: ['p1-work']
  });
  const reloaded = await loadState(repository);
  assert.equal(reloaded.wbs.some((item) => item.id === 'p1-work'), false);
  assert.equal(selectTaskById(reloaded.tasks, 't2').wbsId, 'p1-root');
});

test('a cross-project dependency introduced through persistence invalidates only the affected project', async () => {
  const repository = createMockRepository(makeSeed());
  const state = await loadState(repository);
  const task = selectTaskById(state.tasks, 't2');
  await repository.commitChanges({
    taskUpserts: [{ ...task, deps: [{ predecessorId: 't3', type: 'FS', lagDays: 0 }] }]
  });
  const reloaded = await loadState(repository);
  const schedule = scheduleFor(reloaded);
  assert.equal(selectProjectSchedule(schedule, 'p1').status, 'invalid');
  assert.equal(selectProjectSchedule(schedule, 'p1').error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.equal(selectProjectSchedule(schedule, 'p2').status, 'valid');
  assert.equal(schedule.status, 'warning');
});

test('an unknown-project task produces a warning without blocking valid project schedules', async () => {
  const repository = createMockRepository(makeSeed());
  await repository.commitChanges({
    taskUpserts: [{
      id: 'orphan',
      task: 'Orphan',
      projectId: 'missing',
      plannedStart: '2026-07-20',
      plannedFinish: '2026-07-20',
      plannedDurationDays: 1,
      deps: []
    }]
  });
  const state = await loadState(repository);
  const schedule = scheduleFor(state);
  assert.equal(schedule.status, 'warning');
  assert.equal(schedule.warnings.some((item) => item.code === 'UNKNOWN_PROJECT' && item.taskId === 'orphan'), true);
  assert.equal(selectProjectSchedule(schedule, 'p1').status, 'valid');
  assert.equal(selectProjectSchedule(schedule, 'p2').status, 'valid');
});

test('normalizing a task record is idempotent inside the same application context', async () => {
  const state = await loadState(createMockRepository(makeSeed()));
  const context = {
    projects: state.projects,
    people: state.people,
    wbs: state.wbs,
    calendars: state.calendars
  };
  const task = selectTaskById(state.tasks, 't2');
  assert.deepEqual(normalizeTaskRecord(task, context), task);
});

test('repository reload creates an independent application state graph', async () => {
  const repository = createMockRepository(makeSeed());
  const first = await loadState(repository);
  first.tasks[0].task = 'Mutated locally';
  first.projects[0].name = 'Mutated project';
  const second = await loadState(repository);
  assert.equal(selectTaskById(second.tasks, 't1').task, 'Legacy discovery');
  assert.equal(selectProjectById(second.projects, 'p1').name, 'Alpha');
});

test('schedule projection remains deterministic across repeated reloads of unchanged repository data', async () => {
  const repository = createMockRepository(makeSeed());
  const first = scheduleFor(await loadState(repository));
  const second = scheduleFor(await loadState(repository));
  assert.deepEqual(second, first);
});

test('failed repository mutation leaves bootable persisted application data unchanged', async () => {
  const repository = createMockRepository(makeSeed(), { failNextMutation: true });
  const before = await repository.loadSnapshot();
  await assert.rejects(repository.commitChanges({ taskDeletes: ['t1'] }));
  const after = await repository.loadSnapshot();
  assert.deepEqual(after, before);
  const state = createInitialState(after);
  assert.equal(state.dataStatus, 'ready');
  assert.equal(selectTaskById(state.tasks, 't1')?.id, 't1');
});
