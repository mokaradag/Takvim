import {
  MAX_CALENDAR_SPAN_DAYS,
  MAX_WORKING_DAY_SPAN,
  countWorkingDays,
  resolveTaskCalendar
} from '../calendars/index.js';
import { parseDate } from '../dates/index.js';

const MS_PER_DAY = 86400000;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function calculatePlannedDurationDays(task, { projects = [], calendars = [], countByWeeks = false } = {}) {
  if (task?.milestone) return 0;

  const start = validDate(task?.plannedStart);
  const finish = validDate(task?.plannedFinish);
  if (!start || !finish || finish < start) return null;

  // Sayım sınırını AŞAN aralık, KIRPILMIŞ bir süre olarak yayımlanmaz.
  // `calculatePlannedDurationDays` sonucu sunucuda `MR_Tasks.PlannedDurationDays`
  // alanına yazılır; kesilmiş bir sayı orada "kesin" muamelesi görürdü.
  // Süre bilinmiyorsa `null` döner — çağıranların zaten ele aldığı durum.
  if (Math.round((finish.getTime() - start.getTime()) / MS_PER_DAY) > MAX_CALENDAR_SPAN_DAYS) return null;

  const calendar = resolveTaskCalendar(task, projects, calendars);
  const spanDays = Math.round((finish.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (spanDays > MAX_WORKING_DAY_SPAN) {
    const weekdays = Array.isArray(calendar?.workingDays) && calendar.workingDays.length ? calendar.workingDays : [1, 2, 3, 4, 5];
    const weeklyCount = new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)).size;
    if (Math.floor(spanDays / 7) * weeklyCount - (calendar?.holidays?.length || 0) > MAX_WORKING_DAY_SPAN) return null;
  }
  // Kızılötesi durum: başlangıç ve bitiş geçerli ama aralıkta hiç çalışma günü
  // yok (tek günlük hafta sonu/tatil görevi). Ham sayım 0 döndüğünde görev
  // Gantt özetlerinde kilometre taşı gibi çiziliyor ve ilerleme ağırlığı
  // sıfırlanıyordu. Kilometre taşı OLMAYAN, tarihleri geçerli bir görev en az
  // bir gün sürer.
  const duration = Math.max(1, countWorkingDays(start, finish, calendar, { maxCount: MAX_WORKING_DAY_SPAN, byWeeks: countByWeeks }));
  // Planlama UFKUNU aşan süre de "bilinmiyor" sayılır. Bu değer doğrudan
  // `MR_Tasks.PlannedDurationDays` alanına yazılır ve CPM daha sonra onu
  // zamanlayamaz; sıradan görev yazmalarında sınır `commitScalarValidation`
  // tarafından uygulanıyordu ama zamanlama değişikliği KABUL yolu süreyi
  // buradan hesaplayıp doğrudan kalıcılaştırdığı için denetimin dışında
  // kalıyordu.
  if (duration > MAX_WORKING_DAY_SPAN) return null;
  return duration;
}

export function normalizeTaskPlan(task, context = {}) {
  const prior = context.previousTask;
  const reusable = prior && context.previousCalendar === resolveTaskCalendar(task, context.projects, context.calendars)
    && ['plannedStart', 'plannedFinish', 'milestone'].every((field) => prior[field] === task[field]);
  return {
    ...task,
    plannedDurationDays: reusable ? prior.plannedDurationDays : calculatePlannedDurationDays(task, context)
  };
}
