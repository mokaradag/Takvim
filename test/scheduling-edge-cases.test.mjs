import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TR_DAYS,
  TR_MONTHS,
  TR_MONTHS_LONG,
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
  startOfWeek,
  today
} from '../src/scheduling/dates/index.js';
import {
  DEFAULT_CALENDAR,
  DEFAULT_WORKING_DAYS,
  TURKEY_HOLIDAYS_2026,
  addWorkingDays,
  calendarById,
  countWorkingDays,
  diffWorkingDays,
  holidayFor,
  isWorkingDay,
  moveToWorkingDay,
  normalizeCalendar,
  resolveProjectCalendar,
  resolveTaskCalendar
} from '../src/scheduling/calendars/index.js';
import {
  REL_TYPES,
  applyDependencyLag,
  depId,
  normalizeDependency,
  relTypeOf
} from '../src/scheduling/dependencies/index.js';
import {
  getGroupScheduleSummaries,
  getStatus,
  getTaskDateRange,
  selectTaskStats,
  taskPlannedDurationDays
} from '../src/scheduling/metrics/index.js';
import {
  calculatePlannedDurationDays,
  normalizeTaskPlan
} from '../src/scheduling/plans/index.js';

const weekdayCalendar = normalizeCalendar({
  id: 'weekday',
  name: 'Weekday',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});
const sixDayCalendar = normalizeCalendar({
  id: 'six-day',
  name: 'Six Day',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: []
});
const noWorkCalendar = normalizeCalendar({
  id: 'none',
  name: 'None',
  workingDays: [],
  holidays: []
});
const projects = [
  { id: 'p1', name: 'Project One', calendarId: weekdayCalendar.id },
  { id: 'p2', name: 'Project Two', calendarId: sixDayCalendar.id }
];
const calendars = [weekdayCalendar, sixDayCalendar];

test('date label constants expose complete Turkish month and weekday sets', () => {
  assert.equal(TR_MONTHS.length, 12);
  assert.equal(TR_MONTHS_LONG.length, 12);
  assert.equal(TR_DAYS.length, 7);
  assert.equal(TR_MONTHS[0], 'Oca');
  assert.equal(TR_MONTHS_LONG[7], 'Ağustos');
  assert.equal(TR_DAYS[6], 'Paz');
});

test('parseDate returns an existing Date instance unchanged', () => {
  const date = new Date(2026, 6, 22);
  assert.strictEqual(parseDate(date), date);
});

test('parseDate without a value returns a valid current Date', () => {
  const before = Date.now();
  const result = parseDate();
  const after = Date.now();
  assert.equal(result instanceof Date, true);
  assert.equal(result.getTime() >= before && result.getTime() <= after, true);
});

test('fmtISO pads single-digit month and day values', () => {
  assert.equal(fmtISO(new Date(2026, 0, 5)), '2026-01-05');
});

test('fmt supports every explicit project date pattern', () => {
  assert.equal(fmt('2026-08-03'), '03 Ağu');
  assert.equal(fmt('2026-08-03', 'dd MMM yyyy'), '03 Ağu 2026');
  assert.equal(fmt('2026-08-03', 'MMM yyyy'), 'Ağustos 2026');
  assert.equal(fmt('2026-08-03', 'd'), '3');
  assert.equal(fmt('2026-08-03', 'EEE d'), 'Pzt 3');
});

test('addDays crosses month, year, and leap-day boundaries', () => {
  assert.equal(fmtISO(addDays('2026-12-31', 1)), '2027-01-01');
  assert.equal(fmtISO(addDays('2028-02-28', 1)), '2028-02-29');
  assert.equal(fmtISO(addDays('2028-03-01', -1)), '2028-02-29');
});

test('diffDays preserves direction', () => {
  assert.equal(diffDays('2026-07-20', '2026-07-22'), -2);
  assert.equal(diffDays('2026-07-22', '2026-07-20'), 2);
  assert.equal(diffDays('2026-07-22', '2026-07-22'), 0);
});

test('month boundaries handle February correctly', () => {
  assert.equal(fmtISO(startOfMonth('2028-02-15')), '2028-02-01');
  assert.equal(fmtISO(endOfMonth('2028-02-15')), '2028-02-29');
  assert.equal(fmtISO(endOfMonth('2026-02-15')), '2026-02-28');
});

test('week boundaries use Monday through Sunday', () => {
  assert.equal(fmtISO(startOfWeek('2026-07-26')), '2026-07-20');
  assert.equal(fmtISO(endOfWeek('2026-07-20')), '2026-07-26');
});

test('isSameDay compares calendar fields across string and Date values', () => {
  assert.equal(isSameDay('2026-07-22', new Date(2026, 6, 22)), true);
  assert.equal(isSameDay('2026-07-22', '2026-07-23'), false);
});

test('isWeekend distinguishes Friday, Saturday, and Sunday', () => {
  assert.equal(isWeekend('2026-07-24'), false);
  assert.equal(isWeekend('2026-07-25'), true);
  assert.equal(isWeekend('2026-07-26'), true);
});

test('today returns local midnight', () => {
  const result = today();
  assert.equal(result.getHours(), 0);
  assert.equal(result.getMinutes(), 0);
  assert.equal(result.getSeconds(), 0);
  assert.equal(result.getMilliseconds(), 0);
});

test('eachDay includes both endpoints and crosses month boundaries', () => {
  assert.deepEqual(eachDay('2026-07-31', '2026-08-02').map(fmtISO), [
    '2026-07-31',
    '2026-08-01',
    '2026-08-02'
  ]);
});

test('eachDay returns an empty range when start follows end', () => {
  assert.deepEqual(eachDay('2026-08-02', '2026-07-31'), []);
});

test('default calendar constants are frozen and expose five working weekdays', () => {
  assert.equal(Object.isFrozen(DEFAULT_WORKING_DAYS), true);
  assert.equal(Object.isFrozen(TURKEY_HOLIDAYS_2026), true);
  assert.equal(Object.isFrozen(DEFAULT_CALENDAR), true);
  assert.deepEqual(DEFAULT_WORKING_DAYS, [1, 2, 3, 4, 5]);
});

test('normalizeCalendar fills defaults for missing identity fields', () => {
  const result = normalizeCalendar({ workingDays: [1], holidays: [] });
  assert.equal(result.id, DEFAULT_CALENDAR.id);
  assert.equal(result.name, DEFAULT_CALENDAR.name);
  assert.equal(result.timezone, DEFAULT_CALENDAR.timezone);
  assert.deepEqual(result.workingDays, [1]);
});

test('normalizeCalendar clones mutable arrays and holiday objects', () => {
  const input = {
    id: 'clone-test',
    workingDays: [1, 2],
    holidays: [{ date: '2026-01-02', name: 'Holiday', short: 'H' }]
  };
  const result = normalizeCalendar(input);
  assert.notStrictEqual(result.workingDays, input.workingDays);
  assert.notStrictEqual(result.holidays, input.holidays);
  assert.notStrictEqual(result.holidays[0], input.holidays[0]);
  result.workingDays.push(3);
  result.holidays[0].name = 'Changed';
  assert.deepEqual(input.workingDays, [1, 2]);
  assert.equal(input.holidays[0].name, 'Holiday');
});

test('calendarById safely handles missing collections and IDs', () => {
  assert.equal(calendarById(undefined, 'missing'), null);
  assert.equal(calendarById(calendars, 'missing'), null);
  assert.strictEqual(calendarById(calendars, 'six-day'), sixDayCalendar);
});

test('resolveProjectCalendar uses a supplied fallback for unknown calendars', () => {
  const fallback = { id: 'fallback' };
  assert.strictEqual(resolveProjectCalendar({ calendarId: 'missing' }, calendars, fallback), fallback);
});

test('resolveTaskCalendar matches projects by legacy display name when projectId is absent', () => {
  assert.equal(resolveTaskCalendar({ proje: 'Project Two' }, projects, calendars).id, 'six-day');
});

test('resolveTaskCalendar prefers a task-level calendar over project selection', () => {
  assert.equal(resolveTaskCalendar({ projectId: 'p1', calendarId: 'six-day' }, projects, calendars).id, 'six-day');
});

test('holidayFor accepts Date instances and returns null for normal days', () => {
  assert.equal(holidayFor(new Date(2026, 6, 15))?.short, '15 Temmuz');
  assert.equal(holidayFor('2026-07-16'), null);
});

test('isWorkingDay respects an explicitly empty working-day calendar', () => {
  assert.equal(isWorkingDay('2026-07-22', noWorkCalendar), false);
});

test('moveToWorkingDay treats zero direction as forward', () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-25', weekdayCalendar, 0)), '2026-07-27');
});

test('moveToWorkingDay leaves an existing working date unchanged', () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-22', weekdayCalendar, -1)), '2026-07-22');
});

test('addWorkingDays truncates fractional amounts before moving', () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-20', 2.9, weekdayCalendar)), '2026-07-22');
  assert.equal(fmtISO(addWorkingDays('2026-07-20', -2.9, weekdayCalendar)), '2026-07-16');
});

test('addWorkingDays treats non-finite amounts as zero and does not auto-align', () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-25', Number.NaN, weekdayCalendar)), '2026-07-25');
  assert.equal(fmtISO(addWorkingDays('2026-07-25', Infinity, weekdayCalendar)), '2026-07-25');
});

test('diffWorkingDays counts only working dates reached after the origin', () => {
  assert.equal(diffWorkingDays('2026-07-27', '2026-07-24', weekdayCalendar), 1);
  assert.equal(diffWorkingDays('2026-07-24', '2026-07-27', weekdayCalendar), -1);
});

test('countWorkingDays counts a same-day working date inclusively', () => {
  assert.equal(countWorkingDays('2026-07-22', '2026-07-22', weekdayCalendar), 1);
  assert.equal(countWorkingDays('2026-07-25', '2026-07-25', weekdayCalendar), 0);
});

test('countWorkingDays returns signed inclusive counts for reversed ranges', () => {
  assert.equal(countWorkingDays('2026-07-20', '2026-07-24', weekdayCalendar), 5);
  assert.equal(countWorkingDays('2026-07-24', '2026-07-20', weekdayCalendar), -5);
});

test('dependency relationship metadata contains all four supported types', () => {
  assert.deepEqual(Object.keys(REL_TYPES), ['FS', 'SS', 'FF', 'SF']);
  assert.equal(REL_TYPES.SF.code, 'SF');
});

test('depId handles nullish and legacy dependency records', () => {
  assert.equal(depId(null), null);
  assert.equal(depId(undefined), null);
  assert.equal(depId({ id: 'legacy' }), 'legacy');
  assert.equal(depId({ predecessorId: 'canonical', id: 'legacy' }), 'canonical');
});

test('relTypeOf defaults strings, nullish records, and unknown types to FS', () => {
  assert.equal(relTypeOf('task-1'), 'FS');
  assert.equal(relTypeOf(null), 'FS');
  assert.equal(relTypeOf({ type: 'XX' }), 'FS');
  assert.equal(relTypeOf({ type: 'SS' }), 'SS');
});

test('normalizeDependency preserves finite fractional and negative lag values', () => {
  assert.deepEqual(normalizeDependency({ predecessorId: 'a', type: 'FF', lagDays: -1.5 }), {
    id: 'a', predecessorId: 'a', type: 'FF', lagDays: -1.5
  });
});

test('normalizeDependency replaces non-finite lag values with zero', () => {
  assert.equal(normalizeDependency({ id: 'a', lagDays: Infinity }).lagDays, 0);
  assert.equal(normalizeDependency({ id: 'a', lagDays: Number.NaN }).lagDays, 0);
});

test('applyDependencyLag uses normalized zero lag without aligning a non-working day', () => {
  assert.equal(fmtISO(applyDependencyLag('2026-07-25', { predecessorId: 'a' }, weekdayCalendar)), '2026-07-25');
});

test('taskPlannedDurationDays clamps negatives and rejects non-finite values', () => {
  assert.equal(taskPlannedDurationDays({ plannedDurationDays: -3 }), 0);
  assert.equal(taskPlannedDurationDays({ plannedDurationDays: Infinity }), 0);
  assert.equal(taskPlannedDurationDays({}), 0);
});

test('getTaskDateRange supports zero padding', () => {
  const range = getTaskDateRange([{ plannedStart: '2026-07-10', plannedFinish: '2026-07-12' }], { paddingDays: 0 });
  assert.equal(fmtISO(range.start), '2026-07-10');
  assert.equal(fmtISO(range.end), '2026-07-12');
});

test('getTaskDateRange returns the supplied fallback Date object as start for empty data', () => {
  const fallbackStart = new Date(2026, 0, 10);
  const range = getTaskDateRange([], { fallbackStart, fallbackDays: 2 });
  assert.strictEqual(range.start, fallbackStart);
  assert.equal(fmtISO(range.end), '2026-01-12');
});

test('group summaries use explicit progress even when status is done', () => {
  const summary = getGroupScheduleSummaries([['g', [{
    plannedStart: '2026-07-01', plannedFinish: '2026-07-02', plannedDurationDays: 2, progress: 25, status: 'done'
  }]]]).g;
  assert.equal(summary.progress, 25);
  assert.equal(summary.done, 1);
});

test('group summaries return zero progress when all non-milestone durations are zero', () => {
  const summary = getGroupScheduleSummaries([['g', [{
    plannedStart: '2026-07-01', plannedFinish: '2026-07-01', plannedDurationDays: 0, progress: 100
  }]]]).g;
  assert.equal(summary.progress, 0);
});

test('done status takes precedence over overdue target dates', () => {
  assert.equal(getStatus({ status: 'done', targetFinish: '2026-01-01' }, parseDate('2026-07-22')).id, 'done');
});

test('a target finish equal to the reference date is not overdue', () => {
  assert.equal(getStatus({ status: 'todo', targetFinish: '2026-07-22' }, parseDate('2026-07-22')).id, 'todo');
});

test('unknown task status falls back to todo display state', () => {
  assert.equal(getStatus({ status: 'blocked' }, parseDate('2026-07-22')).id, 'todo');
});

test('selectTaskStats returns zero-safe aggregates for an empty task list', () => {
  assert.deepEqual(selectTaskStats([], parseDate('2026-07-22')), {
    total: 0, active: 0, inProgress: 0, todo: 0, done: 0, overdue: 0, compRate: 0
  });
});

test('selectTaskStats rounds completion rate to the nearest integer', () => {
  const stats = selectTaskStats([
    { status: 'done' },
    { status: 'done' },
    { status: 'todo' }
  ], parseDate('2026-07-22'));
  assert.equal(stats.compRate, 67);
});

test('selectTaskStats counts missing status as todo and excludes completed overdue tasks', () => {
  const stats = selectTaskStats([
    { targetFinish: '2026-07-20' },
    { status: 'done', targetFinish: '2026-07-01' }
  ], parseDate('2026-07-22'));
  assert.equal(stats.todo, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.active, 1);
});

test('calculatePlannedDurationDays returns zero for milestones before validating dates', () => {
  assert.equal(calculatePlannedDurationDays({ milestone: true, plannedStart: 'bad', plannedFinish: 'bad' }), 0);
});

test('calculatePlannedDurationDays rejects malformed and impossible dates', () => {
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026/07/20', plannedFinish: '2026-07-21' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-02-30', plannedFinish: '2026-03-01' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-22', plannedFinish: '2026-07-21' }), null);
});

test('calculatePlannedDurationDays keeps a valid weekend-only span at minimum one day', () => {
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-25', plannedFinish: '2026-07-26' }, {
    projects, calendars
  }), 1);
});

test('calculatePlannedDurationDays resolves project calendars', () => {
  assert.equal(calculatePlannedDurationDays({ projectId: 'p2', plannedStart: '2026-07-18', plannedFinish: '2026-07-18' }, {
    projects, calendars
  }), 1);
});

test('calculatePlannedDurationDays resolves task calendar overrides before project calendars', () => {
  assert.equal(calculatePlannedDurationDays({
    projectId: 'p1', calendarId: 'six-day', plannedStart: '2026-07-18', plannedFinish: '2026-07-18'
  }, { projects, calendars }), 1);
});

test('calculatePlannedDurationDays returns null when schedule dates are missing', () => {
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-20' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedFinish: '2026-07-20' }), null);
});

test('normalizeTaskPlan preserves task fields while replacing duration with a calculated value', () => {
  const original = { id: 't1', custom: 'value', plannedStart: '2026-07-20', plannedFinish: '2026-07-24' };
  const normalized = normalizeTaskPlan(original, { projects, calendars });
  assert.equal(normalized.id, 't1');
  assert.equal(normalized.custom, 'value');
  assert.equal(normalized.plannedDurationDays, 5);
  assert.notStrictEqual(normalized, original);
});
