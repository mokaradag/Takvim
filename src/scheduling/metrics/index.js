import { addDays, diffDays, parseDate, today } from '../dates';

export function taskDurationDays(task) {
  return diffDays(task.bitisTarihi, task.baslangicTarihi) + 1;
}

export function getTaskDateRange(tasks, { paddingDays = 3, fallbackStart = today(), fallbackDays = 30 } = {}) {
  if (!tasks.length) return { start: fallbackStart, end: addDays(fallbackStart, fallbackDays) };
  let min = parseDate(tasks[0].baslangicTarihi);
  let max = parseDate(tasks[0].bitisTarihi);
  tasks.forEach((task) => {
    const start = parseDate(task.baslangicTarihi);
    const end = parseDate(task.bitisTarihi);
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
    let start = parseDate(scheduled[0].baslangicTarihi);
    let end = parseDate(scheduled[0].bitisTarihi);
    let totalDuration = 0;
    let weightedProgress = 0;
    scheduled.forEach((task) => {
      const taskStart = parseDate(task.baslangicTarihi);
      const taskEnd = parseDate(task.bitisTarihi);
      if (taskStart < start) start = taskStart;
      if (taskEnd > end) end = taskEnd;
      const duration = taskDurationDays(task);
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
  if (task.hedefTarih && diffDays(task.hedefTarih, referenceDate) < 0) return { id: 'overdue', label: 'Geciken', cls: 'status-overdue' };
  if (task.status === 'in_progress') return { id: 'in_progress', label: 'Devam ediyor', cls: 'status-progress' };
  return { id: 'todo', label: 'Yapılacak', cls: 'status-todo' };
}

export function selectTaskStats(tasks, referenceDate = today()) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const todo = tasks.filter((task) => !task.status || task.status === 'todo').length;
  const overdue = tasks.filter((task) => task.status !== 'done' && diffDays(task.hedefTarih, referenceDate) < 0).length;
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
