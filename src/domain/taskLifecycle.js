import { milestoneCompletion } from './milestoneCompletion.js';

const owns = (value, field) => Object.prototype.hasOwnProperty.call(value, field);
const fields = ['status', 'actualStart', 'actualFinish', 'progress', 'milestone', 'isMilestone'];

export function requiresActualDateReset(task = {}, patch = {}) {
  const milestone = task.milestone || task.isMilestone;
  const statusChanged = owns(patch, 'status') && patch.status !== task.status;
  const finishCleared = milestone
    && owns(patch, 'actualFinish')
    && patch.actualFinish !== task.actualFinish
    && !patch.actualFinish;
  const reset = (statusChanged && patch.status === 'todo')
    || (milestone && (finishCleared || (statusChanged && patch.status === 'in_progress')));
  return Boolean(reset && (task.actualStart || task.actualFinish));
}

export const ACTUAL_DATE_RESET_MESSAGE = 'Görev Yapılacak durumuna alınacak; gerçekleşen tarihler temizlenecek ve ilerleme %0 olacak. Onaylıyor musunuz?';

export function normalizeTaskLifecycle(task = {}, patch = {}, today) {
  if (requiresActualDateReset(task, patch) && patch.resetActualDates !== true) {
    throw Object.assign(new Error(ACTUAL_DATE_RESET_MESSAGE), { code: 'ACTUAL_DATE_RESET_CONFIRMATION_REQUIRED' });
  }
  const next = { status: 'todo', progress: null, actualStart: null, actualFinish: null, ...task, ...patch };
  const statusChanged = owns(patch, 'status') && patch.status !== task.status;
  const reset = statusChanged && next.status === 'todo' && task.status != null;
  if (reset) {
    return { ...patch, status: 'todo', actualStart: null, actualFinish: null, progress: 0 };
  }
  const milestone = (task.milestone || task.isMilestone) && !fields.some((field) => owns(patch, field))
    ? null : milestoneCompletion(task, patch, today);
  if ((task.milestone || task.isMilestone) && !milestone) return patch;
  if (milestone) return { ...patch, ...milestone };

  // Yeniden açma niyeti, tam satırdaki eski bitiş tarihinden önce gelir.
  if (statusChanged && next.status === 'in_progress') next.actualFinish = null;
  else if (next.actualFinish) next.status = 'done';

  if (next.status === 'done') {
    next.actualFinish ||= task.actualFinish || today;
    next.actualStart ||= next.actualFinish;
    next.progress = 100;
  } else {
    if (next.status === 'todo' && next.actualStart) next.status = 'in_progress';
    if (next.status === 'in_progress') next.actualStart ||= today;
  }
  if (next.actualStart && next.actualFinish && next.actualFinish < next.actualStart) {
    throw Object.assign(new Error('Gerçekleşen bitiş başlangıçtan önce olamaz.'), { code: 'TASK_ACTUAL_RANGE_INVALID' });
  }
  const resolved = Object.fromEntries(fields.slice(0, 4)
    .filter((field) => owns(patch, field) || next[field] !== (task[field] ?? null))
    .map((field) => [field, next[field]]));
  return Object.keys(resolved).length ? { ...patch, ...resolved } : patch;
}
