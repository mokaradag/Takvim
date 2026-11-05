import { dateMatchesFilter } from '../../components/dateMatchesFilter.js';
import { numericMatchesFilter } from '../../components/numericMatchesFilter.js';
import { taskDurationDays } from '../../scheduling/metrics/index.js';

export const GANTT_CPM_DATE_KEYS = Object.freeze([
  'earlyStart',
  'earlyFinish',
  'lateStart',
  'lateFinish'
]);
export const GANTT_NUMERIC_KEYS = Object.freeze(['totalFloat', 'freeFloat', 'duration']);

export function createGanttColumnFilters() {
  return {
    task: '',
    proje: [],
    sorumlu: [],
    priority: [],
    status: [],
    progress: null,
    plannedStart: null,
    plannedFinish: null,
    targetFinish: null,
    ...Object.fromEntries([...GANTT_CPM_DATE_KEYS, ...GANTT_NUMERIC_KEYS].map((key) => [key, null]))
  };
}

/** Çizim, sıralama ve süzme aynı kaynağı okur; eksik sayılar sıfıra çevrilmez. */
export function ganttColumnValue(task, key, schedule) {
  if (key === 'duration')
    return Number.isFinite(task?.plannedDurationDays) ? taskDurationDays(task) : null;
  if (key === 'totalFloat' || key === 'freeFloat') {
    const value = schedule?.[`${key}Days`];
    return Number.isFinite(value) ? value : null;
  }
  return schedule?.[key] ?? null;
}

/** CPM yalnızca Gantt'a aittir; ortak görev fasetleri bu hesaplara bağlanmaz. */
export function ganttMatchesDerivedFilters(task, filters, schedule) {
  return (
    GANTT_CPM_DATE_KEYS.every(
      (key) =>
        !filters[key] || dateMatchesFilter(ganttColumnValue(task, key, schedule), filters[key])
    ) &&
    GANTT_NUMERIC_KEYS.every(
      (key) =>
        !filters[key] || numericMatchesFilter(ganttColumnValue(task, key, schedule), filters[key])
    )
  );
}
