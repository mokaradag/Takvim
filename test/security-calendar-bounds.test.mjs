import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePlannedDurationDays, normalizeTaskPlan } from '../src/scheduling/plans/index.js';
import { MAX_WORKING_DAY_SPAN, meterCalendarScans } from '../src/scheduling/calendars/index.js';
import { calculateCpm, CPM_CALENDAR_SCAN_BUDGET_DAYS } from '../src/scheduling/cpm/engine.js';
import { addDays, fmtISO } from '../src/scheduling/dates/index.js';

test('excessive ordinary duration is rejected before any calendar-day scan', () => {
  const calendar = { id: 'calendar', workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const task = { plannedStart: '2026-01-01', plannedFinish: '2300-01-01', calendarId: calendar.id };
  assert.equal(meterCalendarScans({ remainingDays: 0 }, () => calculatePlannedDurationDays(task, { calendars: [calendar] })), null);
  const sparse = { ...calendar, workingDays: [1] }, start = '2026-08-17';
  assert.equal(calculatePlannedDurationDays({ ...task, plannedStart: start, plannedFinish: fmtISO(addDays(start, (MAX_WORKING_DAY_SPAN - 1) * 7)) }, { calendars: [sparse] }), MAX_WORKING_DAY_SPAN);
});

test('unchanged snapshot plans reuse duration only while the resolved calendar is unchanged', () => {
  const calendar = { id: 'calendar', workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const task = { plannedStart: '2026-08-17', plannedFinish: '2026-08-21', calendarId: calendar.id, milestone: false };
  const previousTask = normalizeTaskPlan(task, { calendars: [calendar] }), context = { calendars: [calendar], previousTask, previousCalendar: calendar };
  const unchanged = meterCalendarScans({ remainingDays: 0 }, () => normalizeTaskPlan({ ...task, description: 'changed note' }, context));
  assert.equal(unchanged.plannedDurationDays, 5);
  assert.equal(normalizeTaskPlan(task, { ...context, calendars: [{ ...calendar, holidays: [{ date: '2026-08-18' }] }] }).plannedDurationDays, 4);
});

test('all CPM lag passes consume one fixed aggregate calendar allowance', () => {
  let reads = 0;
  const calendar = { id: 'calendar', get workingDays() { reads += 1; return [1, 2, 3, 4, 5]; }, holidays: [] };
  const root = { id: 'root', milestone: true, plannedDurationDays: 0, plannedStart: '2026-08-17', calendarId: calendar.id };
  const successors = Array.from({ length: 200 }, (_, index) => ({ ...root, id: `task-${index}`, deps: [{ predecessorId: root.id, type: 'FS', lagDays: MAX_WORKING_DAY_SPAN }] }));
  assert.throws(() => calculateCpm([root, ...successors], { calendars: [calendar] }), { code: 'CALENDAR_WORK_BUDGET_EXCEEDED' });
  assert.ok(reads >= CPM_CALENDAR_SCAN_BUDGET_DAYS); assert.ok(reads <= CPM_CALENDAR_SCAN_BUDGET_DAYS + successors.length * 10, `bounded reads: ${reads}`);
  assert.equal(calculateCpm([root, successors[0]], { calendars: [calendar] }).orderedTaskIds.length, 2);
});
