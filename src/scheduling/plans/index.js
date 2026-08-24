import { countWorkingDays, resolveTaskCalendar } from '../calendars/index.js';
import { parseDate } from '../dates/index.js';

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function calculatePlannedDurationDays(task, { projects = [], calendars = [] } = {}) {
  if (task?.milestone) return 0;

  const start = validDate(task?.plannedStart);
  const finish = validDate(task?.plannedFinish);
  if (!start || !finish || finish < start) return null;

  const calendar = resolveTaskCalendar(task, projects, calendars);
  // Kızılötesi durum: başlangıç ve bitiş geçerli ama aralıkta hiç çalışma günü
  // yok (tek günlük hafta sonu/tatil görevi). Ham sayım 0 döndüğünde görev
  // Gantt özetlerinde kilometre taşı gibi çiziliyor ve ilerleme ağırlığı
  // sıfırlanıyordu. Kilometre taşı OLMAYAN, tarihleri geçerli bir görev en az
  // bir gün sürer.
  return Math.max(1, countWorkingDays(start, finish, calendar));
}

export function normalizeTaskPlan(task, context = {}) {
  return {
    ...task,
    plannedDurationDays: calculatePlannedDurationDays(task, context)
  };
}
