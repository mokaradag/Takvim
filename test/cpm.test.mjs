import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import { buildDependencyGraph, calculateCpm } from '../src/scheduling/cpm/index.js';

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

const holidayCalendar = normalizeCalendar({
  id: 'cal-holiday',
  name: 'Holiday',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: [{ date: '2026-06-03', name: 'Test Holiday', short: 'Holiday' }]
});

const projects = [{ id: 'p1', name: 'Project', calendarId: standardCalendar.id }];
const calendars = [standardCalendar, sixDayCalendar, holidayCalendar];

function activity(id, durationDays, deps = [], extra = {}) {
  return {
    id,
    projectId: 'p1',
    task: id,
    durationDays,
    deps,
    ...extra
  };
}

function dep(predecessorId, type = 'FS', lagDays = 0) {
  return { predecessorId, type, lagDays };
}

function run(tasks, options = {}) {
  return calculateCpm(tasks, {
    projects,
    calendars,
    projectStart: '2026-06-01',
    ...options
  });
}

test('sequential FS activities produce a zero-float critical chain', () => {
  const result = run([
    activity('A', 3),
    activity('B', 2, [dep('A')])
  ]);

  assert.equal(result.projectStart, '2026-06-01');
  assert.equal(result.projectFinish, '2026-06-05');
  assert.deepEqual(result.criticalTaskIds, ['A', 'B']);
  assert.deepEqual(result.criticalPaths, [['A', 'B']]);
  assert.deepEqual(result.tasks.A, {
    id: 'A',
    calendarId: standardCalendar.id,
    durationDays: 3,
    earlyStart: '2026-06-01',
    earlyFinish: '2026-06-03',
    lateStart: '2026-06-01',
    lateFinish: '2026-06-03',
    totalFloatDays: 0,
    freeFloatDays: 0,
    isCritical: true
  });
  assert.equal(result.tasks.B.earlyStart, '2026-06-04');
  assert.equal(result.tasks.B.earlyFinish, '2026-06-05');
});

test('parallel paths calculate total/free float and identify the longer critical path', () => {
  const result = run([
    activity('A', 2),
    activity('B', 3, [dep('A')]),
    activity('C', 1, [dep('A')]),
    activity('D', 1, [dep('B'), dep('C')])
  ]);

  assert.equal(result.projectFinish, '2026-06-08');
  assert.deepEqual(result.criticalTaskIds, ['A', 'B', 'D']);
  assert.deepEqual(result.criticalPaths, [['A', 'B', 'D']]);
  assert.equal(result.tasks.C.earlyStart, '2026-06-03');
  assert.equal(result.tasks.C.lateStart, '2026-06-05');
  assert.equal(result.tasks.C.totalFloatDays, 2);
  assert.equal(result.tasks.C.freeFloatDays, 2);
  assert.equal(result.tasks.C.isCritical, false);
});

test('equal parallel paths are both returned as critical paths', () => {
  const result = run([
    activity('A', 1),
    activity('B', 2, [dep('A')]),
    activity('C', 2, [dep('A')]),
    activity('D', 1, [dep('B'), dep('C')])
  ]);

  assert.deepEqual(result.criticalTaskIds, ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.criticalPaths, [
    ['A', 'B', 'D'],
    ['A', 'C', 'D']
  ]);
});

test('forward pass supports SS, FF and SF relationships', () => {
  const result = run([
    activity('A', 3),
    activity('B', 2, [dep('A', 'SS', 1)]),
    activity('C', 2, [dep('A', 'FF')]),
    activity('D', 2, [dep('A', 'SF', 2)])
  ]);

  assert.equal(result.tasks.A.earlyStart, '2026-06-01');
  assert.equal(result.tasks.A.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.B.earlyStart, '2026-06-02');
  assert.equal(result.tasks.B.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.C.earlyStart, '2026-06-02');
  assert.equal(result.tasks.C.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.D.earlyStart, '2026-06-02');
  assert.equal(result.tasks.D.earlyFinish, '2026-06-03');
});

test('FS lag and lead are measured in working days', () => {
  const result = run([
    activity('A', 2),
    activity('Lagged', 1, [dep('A', 'FS', 1)]),
    activity('Led', 1, [dep('A', 'FS', -1)])
  ]);

  assert.equal(result.tasks.A.earlyFinish, '2026-06-02');
  assert.equal(result.tasks.Lagged.earlyStart, '2026-06-04');
  assert.equal(result.tasks.Led.earlyStart, '2026-06-02');
});

test('project holidays are skipped by CPM date calculations', () => {
  const result = calculateCpm([
    activity('A', 2, [], { calendarId: holidayCalendar.id }),
    activity('B', 1, [dep('A')], { calendarId: holidayCalendar.id })
  ], {
    projects,
    calendars,
    projectStart: '2026-06-01'
  });

  assert.equal(result.tasks.A.earlyFinish, '2026-06-02');
  assert.equal(result.tasks.B.earlyStart, '2026-06-04');
});

test('task-level calendar overrides affect successor scheduling', () => {
  const result = run([
    activity('A', 5),
    activity('B', 1, [dep('A')], { calendarId: sixDayCalendar.id })
  ]);

  assert.equal(result.tasks.A.earlyFinish, '2026-06-05');
  assert.equal(result.tasks.B.calendarId, sixDayCalendar.id);
  assert.equal(result.tasks.B.earlyStart, '2026-06-06');
  assert.equal(result.projectFinish, '2026-06-06');
});

test('duration can be derived from baseline working dates and milestones stay zero-duration', () => {
  const result = calculateCpm([
    {
      id: 'A', projectId: 'p1', task: 'A', deps: [],
      baslangicTarihi: '2026-06-01', bitisTarihi: '2026-06-05'
    },
    {
      id: 'M', projectId: 'p1', task: 'M', milestone: true,
      deps: [dep('A')], baslangicTarihi: '2026-06-08', bitisTarihi: '2026-06-08'
    }
  ], {
    projects,
    calendars,
    projectStart: '2026-06-01'
  });

  assert.equal(result.tasks.A.durationDays, 5);
  assert.equal(result.tasks.M.durationDays, 0);
  assert.equal(result.tasks.M.earlyStart, '2026-06-08');
  assert.equal(result.tasks.M.earlyFinish, '2026-06-08');
});

test('graph validation rejects missing predecessors, self-dependencies, duplicate IDs and cycles', () => {
  assert.throws(
    () => buildDependencyGraph([activity('A', 1, [dep('missing')])]),
    (error) => error.code === 'MISSING_PREDECESSOR'
  );
  assert.throws(
    () => buildDependencyGraph([activity('A', 1, [dep('A')])]),
    (error) => error.code === 'SELF_DEPENDENCY'
  );
  assert.throws(
    () => buildDependencyGraph([activity('A', 1), activity('A', 2)]),
    (error) => error.code === 'DUPLICATE_TASK_ID'
  );
  assert.throws(
    () => buildDependencyGraph([
      activity('A', 1, [dep('B')]),
      activity('B', 1, [dep('A')])
    ]),
    (error) => error.code === 'DEPENDENCY_CYCLE'
  );
});

test('invalid baseline dates are rejected when durationDays is not supplied', () => {
  assert.throws(
    () => calculateCpm([{
      id: 'A', projectId: 'p1', task: 'A', deps: [],
      baslangicTarihi: '2026-06-05', bitisTarihi: '2026-06-01'
    }], {
      projects,
      calendars,
      projectStart: '2026-06-01'
    }),
    (error) => error.code === 'INVALID_TASK_DATES'
  );
});
