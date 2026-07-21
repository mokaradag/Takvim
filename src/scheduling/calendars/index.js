import { addDays, fmtISO, parseDate } from '../dates/index.js';

export const DEFAULT_WORKING_DAYS = Object.freeze([1, 2, 3, 4, 5]);

export const TURKEY_HOLIDAYS_2026 = Object.freeze([
  { date: '2026-01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '2026-03-20', name: 'Ramazan Bayramı (1. Gün)', short: 'Ramazan B.' },
  { date: '2026-03-21', name: 'Ramazan Bayramı (2. Gün)', short: 'Ramazan B.' },
  { date: '2026-03-22', name: 'Ramazan Bayramı (3. Gün)', short: 'Ramazan B.' },
  { date: '2026-04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '2026-05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '2026-05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '2026-05-27', name: 'Kurban Bayramı (1. Gün)', short: 'Kurban B.' },
  { date: '2026-05-28', name: 'Kurban Bayramı (2. Gün)', short: 'Kurban B.' },
  { date: '2026-05-29', name: 'Kurban Bayramı (3. Gün)', short: 'Kurban B.' },
  { date: '2026-05-30', name: 'Kurban Bayramı (4. Gün)', short: 'Kurban B.' },
  { date: '2026-07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '2026-08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '2026-10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' }
]);

export const DEFAULT_CALENDAR = Object.freeze({
  id: 'cal-tr-standard-2026',
  name: 'Türkiye Standart Çalışma Takvimi 2026',
  timezone: 'Europe/Istanbul',
  workingDays: DEFAULT_WORKING_DAYS,
  holidays: TURKEY_HOLIDAYS_2026
});

function localDate(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function normalizeCalendar(calendar = DEFAULT_CALENDAR) {
  return {
    id: calendar.id || DEFAULT_CALENDAR.id,
    name: calendar.name || DEFAULT_CALENDAR.name,
    timezone: calendar.timezone || DEFAULT_CALENDAR.timezone,
    workingDays: [...(calendar.workingDays || DEFAULT_WORKING_DAYS)],
    holidays: (calendar.holidays || []).map((holiday) => ({ ...holiday }))
  };
}

export function calendarById(calendars, calendarId) {
  return (calendars || []).find((calendar) => calendar.id === calendarId) || null;
}

export function resolveProjectCalendar(project, calendars, fallback = DEFAULT_CALENDAR) {
  return calendarById(calendars, project?.calendarId) || fallback;
}

export function resolveTaskCalendar(task, projects, calendars, fallback = DEFAULT_CALENDAR) {
  const taskCalendar = calendarById(calendars, task?.calendarId);
  if (taskCalendar) return taskCalendar;
  const project = (projects || []).find((item) => item.id === task?.projectId || item.name === task?.proje) || null;
  return resolveProjectCalendar(project, calendars, fallback);
}

export function holidayFor(value, calendar = DEFAULT_CALENDAR) {
  const key = fmtISO(localDate(value));
  return (calendar?.holidays || []).find((holiday) => holiday.date === key) || null;
}

export function isWorkingDay(value, calendar = DEFAULT_CALENDAR) {
  const date = localDate(value);
  const workingDays = calendar?.workingDays || DEFAULT_WORKING_DAYS;
  return workingDays.includes(date.getDay()) && !holidayFor(date, calendar);
}

export function moveToWorkingDay(value, calendar = DEFAULT_CALENDAR, direction = 1) {
  const step = direction < 0 ? -1 : 1;
  let current = localDate(value);
  while (!isWorkingDay(current, calendar)) current = addDays(current, step);
  return current;
}

export function addWorkingDays(value, amount, calendar = DEFAULT_CALENDAR) {
  const numericAmount = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  if (numericAmount === 0) return localDate(value);

  const direction = numericAmount < 0 ? -1 : 1;
  let remaining = Math.abs(numericAmount);
  let current = localDate(value);

  while (remaining > 0) {
    current = addDays(current, direction);
    if (isWorkingDay(current, calendar)) remaining -= 1;
  }

  return current;
}

export function diffWorkingDays(a, b, calendar = DEFAULT_CALENDAR) {
  const target = localDate(a);
  let current = localDate(b);
  const targetTime = target.getTime();
  const currentTime = current.getTime();
  if (targetTime === currentTime) return 0;

  const direction = targetTime > currentTime ? 1 : -1;
  let difference = 0;

  while (current.getTime() !== targetTime) {
    current = addDays(current, direction);
    if (isWorkingDay(current, calendar)) difference += direction;
  }

  return difference;
}
