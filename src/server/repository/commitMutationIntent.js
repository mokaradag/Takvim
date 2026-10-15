import { canonicalActualId } from '../../domain/identity/actualId.js';
import { formatRecurrenceRule } from '../../scheduling/recurrence/index.js';

export const MUTATION_INTENT = Symbol('mutationIntent');
export const resourceKey = (value) => canonicalActualId(value) ?? String(value || '');
const date = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;

export function normalizeCommitChanges(changes = {}) {
  const result = { ...changes };
  for (const kind of ['project', 'wbs', 'task']) {
    result[`${kind}Upserts`] = changes[`${kind}Upserts`] || [];
    result[`${kind}Deletes`] = (changes[`${kind}Deletes`] || []).map((entry) =>
      typeof entry === 'string' ? { id: resourceKey(entry), version: null } : { ...entry, id: resourceKey(entry.id) });
  }
  return result;
}

export function taskMutationIntent(task, before) {
  const changed = (field, stored, normalize = (value) => value ?? null) => task[field] !== undefined
    && normalize(task[field]) !== normalize(stored);
  const create = !before;
  const project = create || changed('projectId', before?.ProjectId, resourceKey);
  const wbs = create || changed('wbsId', before?.WbsId, resourceKey);
  const recurrence = create || changed('recurrence', before?.RecurrenceRule, (value) => formatRecurrenceRule(value) || null)
    || changed('recurrenceParentId', before?.RecurrenceParentTaskId, resourceKey)
    || changed('recurrenceOccurrenceDate', before?.RecurrenceOccurrenceDate, date);
  const seriesPlan = [['plannedStart', 'PlannedStart'], ['plannedFinish', 'PlannedFinish'], ['targetFinish', 'TargetFinish']]
    .some(([field, column]) => changed(field, before?.[column], date))
    || changed('plannedDurationDays', before?.PlannedDurationDays, (value) => value == null ? null : Number(value));
  const dependencies = create || project || task.dependencyMutation !== false;
  return { create, content: !create, assignees: create || task.assigneeMutation !== false,
    dependencies, project, wbs, recurrence, seriesPlan,
    topology: create || project || wbs || recurrence || seriesPlan || dependencies };
}
