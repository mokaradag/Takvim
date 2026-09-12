export function milestoneCompletion(task, patch = {}, fallbackDate = null) {
  const next = { ...task, ...patch };
  if (!(next.milestone || next.isMilestone)) return null;
  const hasStatus = Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== task.status;
  const hasDate = Object.prototype.hasOwnProperty.call(patch, 'actualFinish') && patch.actualFinish !== task.actualFinish;
  const doneStatus = (value) => ['done', 'completed', 'complete'].includes(String(value || '').toLowerCase());
  const done = hasStatus ? doneStatus(patch.status)
    : hasDate ? Boolean(patch.actualFinish) : doneStatus(next.status);
  const date = done ? (next.actualFinish || fallbackDate || null) : null;
  return { status: done ? 'done' : 'todo', progress: done ? 100 : 0, actualStart: date, actualFinish: date };
}
