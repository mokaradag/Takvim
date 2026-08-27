import { normalizePriorityId } from '../../domain/constants/index.js';
import { addDays, diffDays, endOfWeek, parseDate, startOfWeek, today } from '../../scheduling/dates/index.js';

export const SIMPLE_TASK_FACET_KEYS = Object.freeze(['proje', 'keyword', 'sorumlu', 'priority', 'status']);

function matchesDateFilter(iso, spec, referenceDay) {
  if (!spec) return true;
  const value = parseDate(iso);
  if (spec.mode === 'range') {
    return (!spec.from || value >= parseDate(spec.from)) && (!spec.to || value <= parseDate(spec.to));
  }
  if (spec.mode === 'before') return !spec.to || value <= parseDate(spec.to);
  if (spec.mode === 'after') return !spec.from || value >= parseDate(spec.from);
  if (spec.mode !== 'preset') return true;

  const days = diffDays(value, referenceDay);
  if (spec.preset === 'overdue') return days < 0;
  if (spec.preset === 'today') return days === 0;
  if (spec.preset === 'tomorrow') return days === 1;
  if (spec.preset === 'thisWeek') return value >= startOfWeek(referenceDay) && value <= endOfWeek(referenceDay);
  if (spec.preset === 'nextWeek') return value >= addDays(startOfWeek(referenceDay), 7) && value <= addDays(endOfWeek(referenceDay), 7);
  if (spec.preset === 'thisMonth') return value.getMonth() === referenceDay.getMonth() && value.getFullYear() === referenceDay.getFullYear();
  if (spec.preset === 'nextMonth') {
    const nextMonth = new Date(referenceDay.getFullYear(), referenceDay.getMonth() + 1, 1);
    return value.getMonth() === nextMonth.getMonth() && value.getFullYear() === nextMonth.getFullYear();
  }
  if (spec.preset === 'last7') return days >= -7 && days <= 0;
  if (spec.preset === 'last30') return days >= -30 && days <= 0;
  if (spec.preset === 'next30') return days >= 0 && days <= 30;
  return true;
}

function taskStatusValues(task, referenceDay) {
  const values = [task.status || 'todo'];
  if (task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDay) < 0) values.push('overdue');
  return values;
}

export function simpleTaskMatches(task, { search = '', filters = {} } = {}, ignoredKey = null, referenceDay = today()) {
  const query = String(search).trim().toLocaleLowerCase('tr-TR');
  if (query) {
    const haystack = [task.task, task.proje, task.projectCode, task.keyword, ...(task.sorumlu || [])]
      .map((value) => String(value || '').toLocaleLowerCase('tr-TR'));
    if (!haystack.some((value) => value.includes(query))) return false;
  }
  if (ignoredKey !== 'proje' && filters.proje?.length && !filters.proje.includes(task.projectId)) return false;
  if (ignoredKey !== 'task' && filters.task && !String(task.task || '').toLocaleLowerCase('tr-TR').includes(String(filters.task).toLocaleLowerCase('tr-TR'))) return false;
  if (ignoredKey !== 'keyword' && filters.keyword?.length && !filters.keyword.includes(String(task.keyword || '').trim())) return false;
  if (ignoredKey !== 'sorumlu' && filters.sorumlu?.length && !(task.assigneeIds || []).some((id) => filters.sorumlu.includes(String(id)))) return false;
  if (ignoredKey !== 'priority' && filters.priority?.length && !filters.priority.includes(normalizePriorityId(task.priority))) return false;
  if (ignoredKey !== 'status' && filters.status?.length && !taskStatusValues(task, referenceDay).some((value) => filters.status.includes(value))) return false;
  if (ignoredKey !== 'targetFinish' && filters.targetFinish && (!task.targetFinish || !matchesDateFilter(task.targetFinish, filters.targetFinish, referenceDay))) return false;
  return true;
}

export function simpleTaskFacetValues(tasks, state, key, referenceDay = today()) {
  const values = new Set();
  for (const task of tasks || []) {
    if (!simpleTaskMatches(task, state, key, referenceDay)) continue;
    if (key === 'proje' && task.projectId) values.add(task.projectId);
    if (key === 'keyword' && String(task.keyword || '').trim()) values.add(String(task.keyword).trim());
    if (key === 'sorumlu') for (const id of task.assigneeIds || []) values.add(String(id));
    if (key === 'priority') values.add(normalizePriorityId(task.priority));
    if (key === 'status') for (const status of taskStatusValues(task, referenceDay)) values.add(status);
  }
  return values;
}
