import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectPersonById,
  selectProjectById,
  selectTaskById,
  selectTasksByPerson,
  selectTasksByProject
} from '../src/domain/selectors/index.js';
import {
  normalizeProjectReferences,
  normalizeTaskReferences
} from '../src/domain/validation/index.js';
import {
  addDays,
  diffDays,
  eachDay,
  endOfMonth,
  endOfWeek,
  fmt,
  fmtISO,
  isSameDay,
  isWeekend,
  parseDate,
  startOfMonth,
  startOfWeek
} from '../src/scheduling/dates/index.js';
import {
  depId,
  normalizeDependency,
  relTypeOf
} from '../src/scheduling/dependencies/index.js';
import {
  holidayFor,
  isWorkingDay
} from '../src/scheduling/calendars/index.js';
import {
  getGroupScheduleSummaries,
  getStatus,
  getTaskDateRange,
  selectTaskStats,
  taskPlannedDurationDays
} from '../src/scheduling/metrics/index.js';

const people = [
  { id: 'person-1', name: 'Ayşe Kaya' },
  { id: 'person-2', name: 'Mehmet Demir' }
];
const projects = [
  { id: 'project-1', name: 'Alpha', lead: 'Ayşe Kaya' },
  { id: 'project-2', name: 'Beta', lead: 'Mehmet Demir' }
];
const wbs = [
  { id: 'wbs-alpha', projectId: 'project-1', parentId: null, code: '1', name: 'Alpha' },
  { id: 'wbs-beta', projectId: 'project-2', parentId: null, code: '2', name: 'Beta' }
];

test('domain selectors use stable IDs', () => {
  const tasks = [
    { id: 'task-1', projectId: 'project-1', assigneeIds: ['person-1'] },
    { id: 'task-2', projectId: 'project-2', assigneeIds: ['person-1', 'person-2'] }
  ];

  assert.equal(selectTaskById(tasks, 'task-2')?.id, 'task-2');
  assert.equal(selectTaskById(tasks, 'missing'), null);
  assert.deepEqual(selectTasksByProject(tasks, 'project-1').map((task) => task.id), ['task-1']);
  assert.deepEqual(selectTasksByPerson(tasks, 'person-1').map((task) => task.id), ['task-1', 'task-2']);
  assert.equal(selectProjectById(projects, 'project-2')?.name, 'Beta');
  assert.equal(selectPersonById(people, 'person-2')?.name, 'Mehmet Demir');
});

test('domain normalization derives canonical relationship IDs without dropping display fields', () => {
  const project = normalizeProjectReferences(projects[0], people);
  assert.equal(project.leadId, 'person-1');

  const task = normalizeTaskReferences({
    id: 'task-1',
    proje: 'Alpha',
    sorumlu: ['Ayşe Kaya', 'Mehmet Demir']
  }, { projects, people, wbs });

  assert.equal(task.projectId, 'project-1');
  assert.deepEqual(task.assigneeIds, ['person-1', 'person-2']);
  assert.deepEqual(task.sorumlu, ['Ayşe Kaya', 'Mehmet Demir']);
  assert.equal(task.wbsId, 'wbs-alpha');
  assert.deepEqual(task.deps, []);
});

test('domain normalization can rebuild display names from canonical assignee IDs', () => {
  const task = normalizeTaskReferences({
    id: 'task-2',
    projectId: 'project-2',
    assigneeIds: ['person-2', 'missing']
  }, { projects, people, wbs });

  assert.equal(task.proje, 'Beta');
  assert.deepEqual(task.assigneeIds, ['person-2']);
  assert.deepEqual(task.sorumlu, ['Mehmet Demir']);
  assert.equal(task.wbsId, 'wbs-beta');
});

test('date helpers preserve local calendar dates and inclusive ranges', () => {
  const date = parseDate('2026-07-21');

  assert.equal(fmtISO(date), '2026-07-21');
  assert.equal(fmt(date, 'dd MMM yyyy'), '21 Tem 2026');
  assert.equal(fmtISO(addDays('2026-01-31', 1)), '2026-02-01');
  assert.equal(diffDays('2026-07-25', '2026-07-21'), 4);
  assert.equal(fmtISO(startOfMonth(date)), '2026-07-01');
  assert.equal(fmtISO(endOfMonth(date)), '2026-07-31');
  assert.equal(fmtISO(startOfWeek(date)), '2026-07-20');
  assert.equal(fmtISO(endOfWeek(date)), '2026-07-26');
  assert.equal(isSameDay(date, '2026-07-21'), true);
  assert.equal(isWeekend('2026-07-25'), true);
  assert.deepEqual(
    eachDay('2026-07-20', '2026-07-22').map(fmtISO),
    ['2026-07-20', '2026-07-21', '2026-07-22']
  );
});

test('calendar helpers distinguish holidays, weekends, and working days', () => {
  assert.equal(holidayFor('2026-10-29')?.short, '29 Ekim');
  assert.equal(isWorkingDay('2026-10-29'), false);
  assert.equal(isWorkingDay('2026-07-25'), false);
  assert.equal(isWorkingDay('2026-07-22'), true);
});

test('dependency helpers normalize legacy and canonical relationships', () => {
  assert.equal(depId('task-1'), 'task-1');
  assert.equal(depId({ predecessorId: 'task-2', id: 'legacy-id' }), 'task-2');
  assert.equal(relTypeOf({ type: 'SS' }), 'SS');
  assert.equal(relTypeOf({ type: 'INVALID' }), 'FS');
  assert.deepEqual(normalizeDependency('task-3'), {
    id: 'task-3',
    predecessorId: 'task-3',
    type: 'FS',
    lagDays: 0
  });
  assert.deepEqual(normalizeDependency({ id: 'task-4', type: 'FF', lagDays: -2 }), {
    id: 'task-4',
    predecessorId: 'task-4',
    type: 'FF',
    lagDays: -2
  });
});

test('schedule metrics calculate inclusive duration and padded task ranges', () => {
  const tasks = [
    { plannedStart: '2026-07-10', plannedFinish: '2026-07-12', plannedDurationDays: 3 },
    { plannedStart: '2026-07-05', plannedFinish: '2026-07-20', plannedDurationDays: 12 }
  ];

  assert.equal(taskPlannedDurationDays(tasks[0]), 3);
  const range = getTaskDateRange(tasks, { paddingDays: 2 });
  assert.equal(fmtISO(range.start), '2026-07-03');
  assert.equal(fmtISO(range.end), '2026-07-22');

  const fallback = getTaskDateRange([], {
    fallbackStart: parseDate('2026-01-01'),
    fallbackDays: 10
  });
  assert.equal(fmtISO(fallback.start), '2026-01-01');
  assert.equal(fmtISO(fallback.end), '2026-01-11');
});

test('Gantt group summaries exclude milestones from weighted schedule progress', () => {
  const summaries = getGroupScheduleSummaries([
    ['Alpha', [
      {
        id: 'task-1',
        plannedStart: '2026-07-01',
        plannedFinish: '2026-07-02',
        plannedDurationDays: 2,
        progress: 50,
        status: 'in_progress'
      },
      {
        id: 'task-2',
        plannedStart: '2026-07-03',
        plannedFinish: '2026-07-06',
        plannedDurationDays: 4,
        status: 'done'
      },
      {
        id: 'milestone-1',
        plannedStart: '2026-07-07',
        plannedFinish: '2026-07-07',
        plannedDurationDays: 0,
        milestone: true,
        status: 'done'
      }
    ]],
    ['Milestones only', [
      {
        id: 'milestone-2',
        plannedStart: '2026-08-01',
        plannedFinish: '2026-08-01',
        plannedDurationDays: 0,
        milestone: true,
        status: 'todo'
      }
    ]]
  ]);

  assert.equal(fmtISO(summaries.Alpha.start), '2026-07-01');
  assert.equal(fmtISO(summaries.Alpha.end), '2026-07-06');
  assert.equal(summaries.Alpha.progress, 83);
  assert.equal(summaries.Alpha.items, 3);
  assert.equal(summaries.Alpha.done, 2);
  assert.equal(summaries['Milestones only'], null);
});

test('status and aggregate task statistics are deterministic for a supplied reference date', () => {
  const referenceDate = parseDate('2026-07-21');
  const tasks = [
    { id: 'done', status: 'done', targetFinish: '2026-07-01' },
    { id: 'progress', status: 'in_progress', targetFinish: '2026-07-25' },
    { id: 'late', status: 'todo', targetFinish: '2026-07-20' }
  ];

  assert.equal(getStatus(tasks[0], referenceDate).id, 'done');
  assert.equal(getStatus(tasks[1], referenceDate).id, 'in_progress');
  assert.equal(getStatus(tasks[2], referenceDate).id, 'overdue');
  assert.deepEqual(selectTaskStats(tasks, referenceDate), {
    total: 3,
    active: 2,
    inProgress: 1,
    todo: 1,
    done: 1,
    overdue: 1,
    compRate: 33
  });
});
