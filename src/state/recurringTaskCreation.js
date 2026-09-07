import { createClientEntityId } from '../data/clientEntityId.js';
import { resolveTaskCalendar } from '../scheduling/calendars/index.js';
import { MAX_RECURRENCE_OCCURRENCES, normalizeRecurrenceRule, planRecurringOccurrences } from '../scheduling/recurrence/index.js';
import { normalizeStateTask } from './appState.js';

export function createRecurringTasks(current, template, { limit = 60 } = {}) {
  const taskId = template.id;
  const rule = normalizeRecurrenceRule(template.recurrence);
  if (!rule || !template.plannedStart) return [];
  const calendar = resolveTaskCalendar(template, current.projects, current.calendars);

  const materialized = new Set(current.tasks
    .filter((task) => task.recurrenceParentId === taskId)
    .map((task) => task.recurrenceOccurrenceDate || task.plannedStart)
    .filter(Boolean));
  materialized.add(template.recurrenceOccurrenceDate || template.plannedStart);

  const horizon = Math.min(MAX_RECURRENCE_OCCURRENCES, materialized.size + Math.max(1, limit));
  const plan = planRecurringOccurrences(template, rule, { calendar, limit: horizon })
    .filter((occurrence) => !materialized.has(occurrence.occurrenceDate))
    .slice(0, limit);
  if (!plan.length) return [];

  const sortOrderBase = Number.isFinite(template.sortOrder) ? template.sortOrder : null;
  return plan.map((occurrence, offset) => {
    const created = normalizeStateTask({
      ...template,
      id: createClientEntityId('task'),
      version: undefined,
      recurrence: null,
      recurrenceParentId: taskId,
      recurrenceOccurrenceDate: occurrence.occurrenceDate,
      status: 'todo',
      progress: 0,
      actualStart: null,
      actualFinish: null,
      actualHours: null,
      spent: null,
      remainingDurationDays: null,
      plannedStart: occurrence.plannedStart,
      plannedFinish: occurrence.plannedFinish,
      targetFinish: occurrence.targetFinish,
      sortOrder: sortOrderBase === null ? null : sortOrderBase + offset + 1,
      deps: []
    }, current);
    return created;
  });
}

export function taskCreationWithRecurrences(current, creation) {
  const template = normalizeStateTask(creation.task, current);
  return { type: 'task/add-many', tasks: [template, ...createRecurringTasks(current, template)] };
}
