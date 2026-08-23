import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';
import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import {
  buildPortfolioSchedule,
  selectProjectSchedule,
  selectTaskSchedule
} from '../src/state/selectors/scheduleSelectors.js';

const standardCalendar = normalizeCalendar({
  id: 'cal-standard',
  name: 'Standard',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});

const sixDayCalendar = normalizeCalendar({
  id: 'cal-six-day',
  name: 'Six Day',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: []
});

const projects = [
  { id: 'p1', name: 'One', calendarId: standardCalendar.id, dataDate: '2026-07-22' },
  { id: 'p2', name: 'Two', calendarId: sixDayCalendar.id, dataDate: '2026-07-22' }
];

const people = [
  { id: 'u1', name: 'Ayşe' },
  { id: 'u2', name: 'Bora' }
];

const wbs = [
  { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'One', sortOrder: 1 },
  { id: 'p1-child', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'Child', sortOrder: 1 },
  { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Two', sortOrder: 1 }
];

const context = {
  projects,
  people,
  wbs,
  calendars: [standardCalendar, sixDayCalendar]
};

function task(projectId, id, extra = {}) {
  return {
    id,
    projectId,
    task: id,
    status: 'todo',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20',
    plannedDurationDays: 1,
    deps: [],
    ...extra
  };
}

test('normalizeTaskRecord migrates legacy dates and removes legacy field names', () => {
  const result = normalizeTaskRecord({
    id: 'legacy',
    proje: 'One',
    task: 'Legacy',
    sorumlu: ['Ayşe'],
    baslangicTarihi: '2026-07-20',
    bitisTarihi: '2026-07-24',
    hedefTarih: '2026-07-27'
  }, context);

  assert.equal(result.plannedStart, '2026-07-20');
  assert.equal(result.plannedFinish, '2026-07-24');
  assert.equal(result.targetFinish, '2026-07-27');
  assert.equal(result.plannedDurationDays, 5);
  assert.equal('baslangicTarihi' in result, false);
  assert.equal('bitisTarihi' in result, false);
  assert.equal('hedefTarih' in result, false);
});

test('normalizeTaskRecord gives canonical schedule fields precedence over legacy aliases', () => {
  const result = normalizeTaskRecord({
    id: 'canonical',
    projectId: 'p1',
    task: 'Canonical',
    plannedStart: '2026-08-03',
    baslangicTarihi: '2026-07-20',
    plannedFinish: '2026-08-04',
    bitisTarihi: '2026-07-24',
    targetFinish: '2026-08-05',
    hedefTarih: '2026-07-27'
  }, context);

  assert.equal(result.plannedStart, '2026-08-03');
  assert.equal(result.plannedFinish, '2026-08-04');
  assert.equal(result.targetFinish, '2026-08-05');
  assert.equal(result.plannedDurationDays, 2);
});

test('normalizeTaskRecord converts string dependencies into canonical relationship records', () => {
  const result = normalizeTaskRecord({
    id: 't2',
    projectId: 'p1',
    task: 'Dependent',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20',
    deps: ['t1']
  }, context);

  assert.deepEqual(result.deps, [{
    id: 't1',
    predecessorId: 't1',
    type: 'FS',
    lagDays: 0
  }]);
});

test('normalizeTaskRecord resolves legacy project and assignee names to stable IDs', () => {
  const result = normalizeTaskRecord({
    id: 'legacy-references',
    proje: 'Two',
    task: 'Legacy references',
    sorumlu: ['Bora'],
    plannedStart: '2026-07-17',
    plannedFinish: '2026-07-18'
  }, context);

  assert.equal(result.projectId, 'p2');
  assert.equal(result.proje, 'Two');
  assert.deepEqual(result.assigneeIds, ['u2']);
  assert.deepEqual(result.sorumlu, ['Bora']);
  assert.equal(result.wbsId, 'p2-root');
  assert.equal(result.plannedDurationDays, 2);
});

test('normalizeTaskRecord prefers a valid explicit project ID over a conflicting legacy project name', () => {
  const result = normalizeTaskRecord({
    id: 'explicit-project',
    projectId: 'p1',
    proje: 'Two',
    task: 'Explicit project',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20'
  }, context);

  assert.equal(result.projectId, 'p1');
  assert.equal(result.proje, 'One');
  assert.equal(result.wbsId, 'p1-root');
});

test('normalizeTaskRecord falls back to the project root when a requested WBS belongs to another project', () => {
  const result = normalizeTaskRecord({
    id: 'wrong-wbs',
    projectId: 'p1',
    wbsId: 'p2-root',
    task: 'Wrong WBS',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20'
  }, context);

  assert.equal(result.wbsId, 'p1-root');
});

test('normalizeTaskRecord preserves an unknown explicit project ID without inventing a project or WBS', () => {
  const result = normalizeTaskRecord({
    id: 'unknown-project',
    projectId: 'missing',
    task: 'Unknown project',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20'
  }, context);

  assert.equal(result.projectId, 'missing');
  assert.equal(result.proje, '');
  assert.equal(result.wbsId, null);
});

test('normalizeTaskRecord removes unknown assignee IDs and names', () => {
  const result = normalizeTaskRecord({
    id: 'unknown-assignees',
    projectId: 'p1',
    task: 'Unknown assignees',
    assigneeIds: ['u1', 'missing'],
    sorumlu: ['Ayşe', 'Unknown'],
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20'
  }, context);

  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe']);
});

test('normalizeTaskRecord initializes omitted dependencies as an empty array', () => {
  const result = normalizeTaskRecord({
    id: 'no-deps',
    projectId: 'p1',
    task: 'No dependencies',
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20'
  }, context);

  assert.deepEqual(result.deps, []);
});

test('normalizeTaskRecord forces milestones to zero planned duration', () => {
  const result = normalizeTaskRecord({
    id: 'milestone',
    projectId: 'p1',
    task: 'Milestone',
    milestone: true,
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-20',
    plannedDurationDays: 99
  }, context);

  assert.equal(result.plannedDurationDays, 0);
});

test('normalizeTaskRecord returns null duration for incomplete or invalid planned ranges', () => {
  assert.equal(normalizeTaskRecord({
    id: 'missing-finish',
    projectId: 'p1',
    task: 'Missing finish',
    plannedStart: '2026-07-20'
  }, context).plannedDurationDays, null);

  assert.equal(normalizeTaskRecord({
    id: 'invalid-order',
    projectId: 'p1',
    task: 'Invalid order',
    plannedStart: '2026-07-24',
    plannedFinish: '2026-07-20'
  }, context).plannedDurationDays, null);
});

test('normalizeTaskRecord uses the project calendar when calculating planned duration', () => {
  const result = normalizeTaskRecord({
    id: 'six-day',
    projectId: 'p2',
    task: 'Six-day task',
    plannedStart: '2026-07-17',
    plannedFinish: '2026-07-18'
  }, context);

  assert.equal(result.plannedDurationDays, 2);
});

test('normalizeTaskRecord lets an explicit task calendar override the project calendar', () => {
  const result = normalizeTaskRecord({
    id: 'task-calendar',
    projectId: 'p2',
    calendarId: standardCalendar.id,
    task: 'Task calendar',
    plannedStart: '2026-07-17',
    plannedFinish: '2026-07-18'
  }, context);

  assert.equal(result.plannedDurationDays, 1);
});

test('buildPortfolioSchedule has a stable empty default result', () => {
  assert.deepEqual(buildPortfolioSchedule(), {
    projects: {},
    tasks: {},
    criticalTaskIds: [],
    warnings: [],
    status: 'valid'
  });
});

test('buildPortfolioSchedule warns about tasks whose project is missing and omits them from projections', () => {
  const schedule = buildPortfolioSchedule({
    tasks: [task('missing', 'orphan')],
    projects,
    calendars: context.calendars
  });

  assert.equal(schedule.status, 'warning');
  assert.deepEqual(schedule.warnings[0], {
    scope: 'task',
    taskId: 'orphan',
    projectId: 'missing',
    code: 'UNKNOWN_PROJECT',
    message: 'Task orphan cannot be scheduled because its project is missing.',
    details: { taskId: 'orphan', projectId: 'missing' }
  });
  assert.equal(schedule.tasks.orphan, undefined);
});

test('buildPortfolioSchedule safely reports null task metadata for malformed task entries', () => {
  const schedule = buildPortfolioSchedule({
    tasks: [null],
    projects,
    calendars: context.calendars
  });

  assert.equal(schedule.status, 'warning');
  assert.equal(schedule.warnings[0].code, 'UNKNOWN_PROJECT');
  assert.equal(schedule.warnings[0].taskId, null);
  assert.equal(schedule.warnings[0].projectId, null);
});

test('an unknown-project warning does not prevent valid projects from being scheduled', () => {
  const schedule = buildPortfolioSchedule({
    tasks: [task('p1', 'A'), task('missing', 'orphan')],
    projects,
    calendars: context.calendars
  });

  assert.equal(schedule.status, 'warning');
  assert.equal(schedule.projects.p1.status, 'valid');
  assert.equal(schedule.tasks.A.projectId, 'p1');
});

test('cross-project detection accepts legacy dependency IDs and normalizes relationship details', () => {
  const schedule = buildPortfolioSchedule({
    tasks: [
      task('p1', 'A'),
      task('p2', 'B', { deps: [{ id: 'A', type: 'UNKNOWN', lagDays: 3 }] })
    ],
    projects,
    calendars: context.calendars
  });

  assert.equal(schedule.projects.p2.status, 'invalid');
  assert.deepEqual(schedule.projects.p2.error.details.dependencies, [{
    taskId: 'B',
    predecessorId: 'A',
    predecessorProjectId: 'p1',
    type: 'FS',
    lagDays: 3
  }]);
});

test('a missing predecessor invalidates only its project with a serialized CPM error', () => {
  const schedule = buildPortfolioSchedule({
    tasks: [
      task('p1', 'A'),
      task('p2', 'B', { deps: ['missing'] })
    ],
    projects,
    calendars: context.calendars
  });

  assert.equal(schedule.projects.p1.status, 'valid');
  assert.equal(schedule.projects.p2.status, 'invalid');
  assert.equal(schedule.projects.p2.error.code, 'MISSING_PREDECESSOR');
  assert.equal(schedule.projects.p2.error.details.taskId, 'B');
  assert.equal(schedule.tasks.A.projectId, 'p1');
  assert.equal(schedule.tasks.B, undefined);
});

test('schedule lookup selectors return null for absent schedules and unknown IDs', () => {
  assert.equal(selectProjectSchedule(undefined, 'p1'), null);
  assert.equal(selectTaskSchedule(undefined, 't1'), null);
  assert.equal(selectProjectSchedule({ projects: {} }, 'missing'), null);
  assert.equal(selectTaskSchedule({ tasks: {} }, 'missing'), null);
});
