import { holidayFor, isWorkingDay, resolveTaskCalendar } from './calendars/index.js';

const DATE_FIELDS = [
  ['plannedStart', 'Planlanan başlangıç'],
  ['plannedFinish', 'Planlanan bitiş'],
  ['targetFinish', 'Hedef bitiş']
];

export function getTaskCalendarWarnings(task, { projects = [], calendars = [] } = {}) {
  if (!task) return [];
  const calendar = resolveTaskCalendar(task, projects, calendars);
  return DATE_FIELDS.flatMap(([field, label]) => {
    const value = task[field];
    if (!value || isWorkingDay(value, calendar)) return [];
    const holiday = holidayFor(value, calendar);
    return [{
      field,
      label,
      date: value,
      type: holiday ? 'holiday' : 'weekend',
      reason: holiday?.name || 'Hafta sonu'
    }];
  });
}
