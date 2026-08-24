import { addDays, diffDays, parseDate, today } from '../dates/index.js';

let ganttDateRangeOverride = null;

export function setGanttDateRangeOverride(range) {
  if (!range?.start || !range?.end) {
    ganttDateRangeOverride = null;
    return null;
  }
  const start = parseDate(range.start);
  const end = parseDate(range.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return ganttDateRangeOverride;
  ganttDateRangeOverride = { start, end };
  return ganttDateRangeOverride;
}

export function clearGanttDateRangeOverride() {
  ganttDateRangeOverride = null;
}

export function taskPlannedDurationDays(task) {
  return Number.isFinite(task?.plannedDurationDays) ? Math.max(0, task.plannedDurationDays) : 0;
}

// Gantt görünümündeki eski adlandırma için geriye dönük uyum.
export const taskDurationDays = taskPlannedDurationDays;

export function calculateTaskDateRange(tasks, { paddingDays = 3, fallbackStart = today(), fallbackDays = 30 } = {}) {
  const scheduled = (tasks || []).filter((task) => task?.plannedStart && task?.plannedFinish);
  if (!scheduled.length) return { start: fallbackStart, end: addDays(fallbackStart, fallbackDays) };
  let min = parseDate(scheduled[0].plannedStart);
  let max = parseDate(scheduled[0].plannedFinish);
  scheduled.forEach((task) => {
    const start = parseDate(task.plannedStart);
    const end = parseDate(task.plannedFinish);
    if (start < min) min = start;
    if (end > max) max = end;
  });
  return { start: addDays(min, -paddingDays), end: addDays(max, paddingDays) };
}

export function getTaskDateRange(tasks, options = {}) {
  if (ganttDateRangeOverride) return { ...ganttDateRangeOverride };
  return calculateTaskDateRange(tasks, options);
}

export function getGroupScheduleSummaries(groups) {
  const summaries = {};
  groups.forEach(([groupName, items]) => {
    const scheduled = items.filter((task) => !task.milestone && task.plannedStart && task.plannedFinish);
    if (!scheduled.length) {
      summaries[groupName] = null;
      return;
    }
    let start = parseDate(scheduled[0].plannedStart);
    let end = parseDate(scheduled[0].plannedFinish);
    let totalDuration = 0;
    let weightedProgress = 0;
    scheduled.forEach((task) => {
      const taskStart = parseDate(task.plannedStart);
      const taskEnd = parseDate(task.plannedFinish);
      if (taskStart < start) start = taskStart;
      if (taskEnd > end) end = taskEnd;
      const duration = taskPlannedDurationDays(task);
      const progress = task.progress != null ? task.progress : (task.status === 'done' ? 100 : 0);
      totalDuration += duration;
      weightedProgress += duration * progress;
    });
    summaries[groupName] = {
      start,
      end,
      // Bütün görevlerin süresi 0 olduğunda ağırlıklı ortalama tanımsızdır;
      // sabit 0 yazmak, hepsi tamamlanmış bir grubu %0 gösteriyordu. Bu durumda
      // AĞIRLIKSIZ ortalamaya düşülür.
      progress: totalDuration
        ? Math.round(weightedProgress / totalDuration)
        : Math.round(scheduled.reduce((sum, task) => (
          sum + (task.progress != null ? task.progress : (task.status === 'done' ? 100 : 0))
        ), 0) / scheduled.length),
      items: items.length,
      done: items.filter((task) => task.status === 'done').length
    };
  });
  return summaries;
}

/**
 * Tamamlanan bir görevin GERÇEKLEŞEN bitiş günü.
 *
 * Planlanan bitiş yedek olarak KULLANILMAZ. Plan bir niyettir: gelecek aya
 * planlanmış ama bugün bitirilen görev, plan tarihine yazıldığında eğriye
 * gelecek ay giriyor; gecikmiş bir plan ise görevi geçmişte bitmiş gibi
 * gösteriyordu. Gerçekleşen tarih yoksa görevin ne zaman bittiği BİLİNMİYORDUR
 * ve görev kronolojik ölçümlerin dışında bırakılır (sayısı ayrıca raporlanır).
 *
 * @returns {string|null} ISO tarih ya da `null`
 */
export function taskCompletionDate(task) {
  if (!task || task.status !== 'done') return null;
  return task.actualFinish || null;
}

/** Gerçekleşen bitişi olmayan tamamlanmış görev sayısı. */
export function countUnknownCompletionDates(tasks) {
  return (tasks || []).filter((task) => task?.status === 'done' && !task.actualFinish).length;
}

export function getStatus(task, referenceDate = today()) {
  if (task.status === 'done') return { id: 'done', label: 'Tamamlandı', cls: 'status-done' };
  if (task.targetFinish && diffDays(task.targetFinish, referenceDate) < 0) return { id: 'overdue', label: 'Geciken', cls: 'status-overdue' };
  if (task.status === 'in_progress') return { id: 'in_progress', label: 'Devam ediyor', cls: 'status-progress' };
  return { id: 'todo', label: 'Yapılacak', cls: 'status-todo' };
}

export function selectTaskStats(tasks, referenceDate = today()) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const todo = tasks.filter((task) => !task.status || task.status === 'todo').length;
  const overdue = tasks.filter(
    (task) => task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDate) < 0
  ).length;
  return {
    total: tasks.length,
    active: inProgress + todo,
    inProgress,
    todo,
    done,
    overdue,
    compRate: tasks.length ? Math.round((done / tasks.length) * 100) : 0
  };
}
