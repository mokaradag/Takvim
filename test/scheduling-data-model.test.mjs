import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { migrateLegacyTaskSchedule } from '../src/data/migrations/legacyTaskSchedule.js';
import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';
import { validateTaskBaselineSnapshot, validateTaskSchedule } from '../src/domain/validation/index.js';
import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import { getStatus } from '../src/scheduling/metrics/index.js';
import { createInitialState, appStateReducer, createNewTask } from '../src/state/appState.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';
import {
  selectPrimaryBaselineForProject,
  selectTaskBaselineSnapshot
} from '../src/state/selectors/baselineSelectors.js';

const calendar = normalizeCalendar({
  id: 'cal-test',
  name: 'Test',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});

const context = {
  calendars: [calendar],
  projects: [{ id: 'p1', name: 'Project', calendarId: calendar.id, dataDate: '2026-07-21' }],
  people: [],
  wbs: [{ id: 'wbs-p1', projectId: 'p1', parentId: null, code: '1', name: 'Project' }]
};

const MOCK_SNAPSHOT = await createMockRepository().loadSnapshot();
function createMockState() {
  return createInitialState(structuredClone(MOCK_SNAPSHOT));
}

test('legacy task dates migrate once to canonical schedule fields', () => {
  const migrated = migrateLegacyTaskSchedule({
    id: 'legacy',
    baslangicTarihi: '2026-07-01',
    bitisTarihi: '2026-07-10',
    hedefTarih: '2026-07-12'
  });

  assert.equal(migrated.plannedStart, '2026-07-01');
  assert.equal(migrated.plannedFinish, '2026-07-10');
  assert.equal(migrated.targetFinish, '2026-07-12');
  assert.equal('baslangicTarihi' in migrated, false);
  assert.equal('bitisTarihi' in migrated, false);
  assert.equal('hedefTarih' in migrated, false);
});

test('task normalization produces canonical current-plan data and working-day planned duration', () => {
  const task = normalizeTaskRecord({
    id: 't1',
    projectId: 'p1',
    task: 'Task',
    status: 'todo',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-24',
    targetFinish: '2026-07-27',
    remainingDurationDays: null,
    deps: []
  }, context);

  assert.equal(task.plannedDurationDays, 5);
  assert.equal(task.actualStart, null);
  assert.equal(task.actualFinish, null);
  assert.equal(task.remainingDurationDays, null);
  assert.equal('earlyStart' in task, false);
  assert.equal('durationDays' in task, false);
});

test('task schedule validation supports explicit actuals and reports invalid date relationships', () => {
  assert.deepEqual(validateTaskSchedule({
    plannedStart: '2026-07-01',
    plannedFinish: '2026-07-10',
    plannedDurationDays: 8,
    actualStart: '2026-07-03',
    actualFinish: null,
    remainingDurationDays: 3
  }), []);

  assert.ok(validateTaskSchedule({
    plannedStart: '2026-07-10',
    plannedFinish: '2026-07-01',
    plannedDurationDays: null
  }).some((issue) => issue.code === 'PLANNED_FINISH_BEFORE_START'));

  assert.ok(validateTaskSchedule({
    actualStart: '2026-07-10',
    actualFinish: '2026-07-09'
  }).some((issue) => issue.code === 'ACTUAL_FINISH_BEFORE_START'));

  assert.ok(validateTaskSchedule({
    actualStart: null,
    actualFinish: '2026-07-09'
  }).some((issue) => issue.code === 'ACTUAL_FINISH_WITHOUT_START'));
});

test('baseline snapshot validation reports invalid historical date order', () => {
  assert.ok(validateTaskBaselineSnapshot({
    baselineId: 'b1',
    taskId: 't1',
    plannedStart: '2026-07-10',
    plannedFinish: '2026-07-09',
    plannedDurationDays: 2,
    calendarId: 'cal-test'
  }).some((issue) => issue.code === 'BASELINE_FINISH_BEFORE_START'));
});

test('milestones normalize to zero planned duration', () => {
  const task = normalizeTaskRecord({
    id: 'm1',
    projectId: 'p1',
    task: 'Milestone',
    milestone: true,
    plannedStart: '2026-07-24',
    plannedFinish: '2026-07-24',
    deps: []
  }, context);

  assert.equal(task.plannedDurationDays, 0);
});

test('target finish drives overdue status independently of planned finish', () => {
  const referenceDate = new Date(2026, 6, 21);

  assert.equal(getStatus({
    status: 'todo',
    plannedFinish: '2026-07-10',
    targetFinish: '2026-07-25'
  }, referenceDate).id, 'todo');

  assert.equal(getStatus({
    status: 'todo',
    plannedFinish: '2026-07-30',
    targetFinish: '2026-07-20'
  }, referenceDate).id, 'overdue');
});

test('current-plan edits and new tasks do not mutate historical baseline snapshots', () => {
  const initial = createMockState();
  const originalSnapshots = structuredClone(initial.taskBaselineSnapshots);
  const task = initial.tasks[0];

  const edited = appStateReducer(initial, {
    type: 'task/update',
    id: task.id,
    patch: { plannedStart: task.plannedStart, plannedFinish: task.targetFinish }
  });

  assert.notEqual(edited.tasks.find((item) => item.id === task.id).plannedFinish, task.plannedFinish);
  assert.deepEqual(edited.taskBaselineSnapshots, originalSnapshots);

  const newTask = createNewTask(edited, new Date(2026, 6, 21), 'new-task');
  const withNewTask = appStateReducer(edited, { type: 'task/add', task: newTask });
  assert.equal(withNewTask.taskBaselineSnapshots.some((snapshot) => snapshot.taskId === 'new-task'), false);
  assert.equal(newTask.remainingDurationDays, null);
});

test('mock projects expose a primary baseline and initial task snapshots', () => {
  const state = createMockState();
  assert.equal(state.baselines.length, state.projects.length);
  assert.equal(state.taskBaselineSnapshots.length, state.tasks.length);
  for (const project of state.projects) {
    assert.ok(selectPrimaryBaselineForProject(state.baselines, project.id));
  }
});

test('primary baseline selectors return separate immutable snapshot data', () => {
  const state = createMockState();
  const task = state.tasks[0];
  const baseline = selectPrimaryBaselineForProject(state.baselines, task.projectId);
  const snapshot = selectTaskBaselineSnapshot(state.taskBaselineSnapshots, task.id, baseline.id);

  assert.ok(baseline);
  assert.ok(snapshot);
  assert.equal(snapshot.plannedStart, task.plannedStart);
  assert.notStrictEqual(snapshot, task);
});

test('project dataDate survives repository and state normalization', () => {
  const state = createMockState();
  assert.ok(state.projects.every((project) => /^\d{4}-\d{2}-\d{2}$/.test(project.dataDate)));
});

test('CPM results remain derived and are not written back into canonical tasks', () => {
  const state = createMockState();
  const schedule = buildPortfolioSchedule({
    tasks: state.tasks,
    projects: state.projects,
    calendars: state.calendars
  });

  assert.ok(Object.keys(schedule.tasks).length > 0);
  assert.ok(state.tasks.every((task) => !('earlyStart' in task) && !('lateFinish' in task) && !('isCritical' in task)));
});

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else files.push(full);
  }
  return files;
}

test('legacy schedule property names are isolated to the migration adapter in src', async () => {
  const srcRoot = path.resolve('src');
  const files = await sourceFiles(srcRoot);
  const legacyNames = ['baslangicTarihi', 'bitisTarihi', 'hedefTarih'];
  const offenders = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (legacyNames.some((name) => content.includes(name))
      && !file.endsWith(path.join('data', 'migrations', 'legacyTaskSchedule.js'))) {
      offenders.push(path.relative(srcRoot, file));
    }
  }

  assert.deepEqual(offenders, []);
});
