import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtISO } from '../src/scheduling/dates/index.js';
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  diffWorkingDays,
  holidayFor,
  isWorkingDay,
  moveToWorkingDay,
  normalizeCalendar,
  resolveProjectCalendar,
  resolveTaskCalendar
} from '../src/scheduling/calendars/index.js';
import { applyDependencyLag } from '../src/scheduling/dependencies/index.js';

const operationsCalendar = normalizeCalendar({
  id: 'cal-operations',
  name: 'Operations',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: DEFAULT_CALENDAR.holidays
});

const calendars = [DEFAULT_CALENDAR, operationsCalendar];
const projects = [
  { id: 'p-standard', name: 'Standard', calendarId: DEFAULT_CALENDAR.id },
  { id: 'p-operations', name: 'Operations', calendarId: operationsCalendar.id }
];

test('holidays are explicit year-specific dates instead of recurring month/day entries', () => {
  assert.equal(holidayFor('2026-07-15', DEFAULT_CALENDAR)?.short, '15 Temmuz');
  assert.equal(holidayFor('2027-07-15', DEFAULT_CALENDAR), null);
});

test('standard and project-specific calendars can define different working weekdays', () => {
  assert.equal(isWorkingDay('2026-07-18', DEFAULT_CALENDAR), false);
  assert.equal(isWorkingDay('2026-07-18', operationsCalendar), true);
  assert.equal(isWorkingDay('2026-07-15', operationsCalendar), false);
});

test('working-day addition skips weekends and explicit holidays in both directions', () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-14', 1, DEFAULT_CALENDAR)), '2026-07-16');
  assert.equal(fmtISO(addWorkingDays('2026-07-17', 1, DEFAULT_CALENDAR)), '2026-07-20');
  assert.equal(fmtISO(addWorkingDays('2026-07-17', 1, operationsCalendar)), '2026-07-18');
  assert.equal(fmtISO(addWorkingDays('2026-07-20', -3, DEFAULT_CALENDAR)), '2026-07-14');
});

test('working-day difference is the inverse of working-day addition', () => {
  for (const amount of [-5, -2, -1, 0, 1, 2, 5]) {
    const shifted = addWorkingDays('2026-07-14', amount, DEFAULT_CALENDAR);
    assert.equal(diffWorkingDays(shifted, '2026-07-14', DEFAULT_CALENDAR), amount);
  }
});

test('non-working dates can be aligned to the nearest working date in either direction', () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-15', DEFAULT_CALENDAR, 1)), '2026-07-16');
  assert.equal(fmtISO(moveToWorkingDay('2026-07-15', DEFAULT_CALENDAR, -1)), '2026-07-14');
  assert.equal(fmtISO(moveToWorkingDay('2026-07-19', DEFAULT_CALENDAR, 1)), '2026-07-20');
});

test('task calendar resolution follows task override, project calendar, then fallback', () => {
  assert.equal(
    resolveTaskCalendar({ projectId: 'p-operations' }, projects, calendars).id,
    operationsCalendar.id
  );
  assert.equal(
    resolveTaskCalendar({ projectId: 'p-operations', calendarId: DEFAULT_CALENDAR.id }, projects, calendars).id,
    DEFAULT_CALENDAR.id
  );
  assert.equal(
    resolveTaskCalendar({ projectId: 'missing' }, projects, calendars).id,
    DEFAULT_CALENDAR.id
  );
  assert.equal(resolveProjectCalendar(projects[0], calendars).id, DEFAULT_CALENDAR.id);
});

test('dependency lag and lead are applied as working days', () => {
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-14', { predecessorId: 'a', type: 'FS', lagDays: 1 }, DEFAULT_CALENDAR)),
    '2026-07-16'
  );
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-17', { predecessorId: 'a', type: 'FS', lagDays: 1 }, operationsCalendar)),
    '2026-07-18'
  );
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-20', { predecessorId: 'a', type: 'FS', lagDays: -1 }, DEFAULT_CALENDAR)),
    '2026-07-17'
  );
});
