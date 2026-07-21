import { normalizeTaskReferences, normalizeTaskScheduleFields } from '../domain/validation/index.js';
import { normalizeDependency } from '../scheduling/dependencies/index.js';
import { normalizeTaskPlan } from '../scheduling/plans/index.js';
import { migrateLegacyTaskSchedule } from './migrations/legacyTaskSchedule.js';

export function normalizeTaskRecord(task, context) {
  const migrated = migrateLegacyTaskSchedule(task);
  const canonical = normalizeTaskScheduleFields({
    ...migrated,
    deps: (migrated.deps || []).map(normalizeDependency)
  });
  const referenced = normalizeTaskReferences(canonical, context);
  return normalizeTaskPlan(referenced, context);
}
