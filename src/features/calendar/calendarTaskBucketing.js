/** Takvim bir termin görünümüdür: her görev tek güne düşer. */
export function taskCalendarDate(task = {}) {
  return task.targetFinish || task.plannedFinish || null;
}

export function bucketCalendarTasks(tasks = []) {
  const buckets = {};
  for (const task of tasks || []) {
    const key = taskCalendarDate(task);
    if (!key) continue;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(task);
  }
  return buckets;
}
