import { addDays, diffDays, parseDate, today } from '../dates/index.js';

export function taskPlannedDurationDays(task) {
  return Number.isFinite(task?.plannedDurationDays) ? Math.max(0, task.plannedDurationDays) : 0;
}

export function getTaskDateRange(tasks, { paddingDays = 3, fallbackStart = today(), fallbackDays = 30 } = {}) {
  if (!tasks.length) return { start: fallbackStart, end: addDays(fallbackStart, fallbackDays) };
  let min = parseDate(tasks[0].plannedStart);
  let max = parseDate(tasks[0].plannedFinish);
  tasks.forEach((task) => {
    const start = parseDate(task.plannedStart);
    const end = parseDate(task.plannedFinish);
    if (start < min) min = start;
    if (end > max) max = end;
  });
  return { start: addDays(min, -paddingDays), end: addDays(max, paddingDays) };
}

export function getGroupScheduleSummaries(groups) {
  const summaries = {};
  groups.forEach(([groupName, items]) => {
    const scheduled = items.filter((task) => !task.milestone);
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
      progress: totalDuration ? Math.round(weightedProgress / totalDuration) : 0,
      items: items.length,
      done: items.filter((task) => task.status === 'done').length
    };
  });
  return summaries;
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
