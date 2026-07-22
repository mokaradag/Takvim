import { normalizeTaskReferences, normalizeTaskScheduleFields } from '../domain/validation/index.js';
import { normalizeDependency } from '../scheduling/dependencies/index.js';
import { normalizeTaskPlan } from '../scheduling/plans/index.js';
import { migrateLegacyTaskSchedule } from './migrations/legacyTaskSchedule.js';

function normalizeTaskDependency(dependency) {
  const normalized = normalizeDependency(dependency);
  const isLegacyDayLag = typeof dependency === 'object'
    && dependency !== null
    && Number.isFinite(dependency.lagDays)
    && dependency.lagValue == null
    && dependency.lagUnit == null;

  return isLegacyDayLag
    ? { ...normalized, lagValue: dependency.lagDays, lagUnit: 'day' }
    : normalized;
}

export function normalizeTaskRecord(task, context) {
  const migrated = migrateLegacyTaskSchedule(task);
  const canonical = normalizeTaskScheduleFields({
    ...migrated,
    deps: (migrated.deps || []).map(normalizeTaskDependency)
  });
  const referenced = normalizeTaskReferences(canonical, context);
  return normalizeTaskPlan(referenced, context);
}
