import { milestoneCompletion } from '../domain/milestoneCompletion.js';
import { normalizeTaskReferences, normalizeTaskScheduleFields } from '../domain/validation/index.js';
import { resolveTaskCalendar } from '../scheduling/calendars/index.js';
import { normalizeDependency } from '../scheduling/dependencies/index.js';
import { normalizeTaskPlan } from '../scheduling/plans/index.js';
import { migrateLegacyTaskSchedule } from './migrations/legacyTaskSchedule.js';

export function normalizeTaskRecord(task, context) {
  const migrated = migrateLegacyTaskSchedule(task);
  // Gecikme birimi görevin KENDİ takvimiyle iş gününe çevrilir. Varsayılan
  // takvimle çevrilen `lagDays`, altı günlük bir takvimde zamanlamanın
  // uyguladığı tarihle uyuşmuyordu.
  const calendar = resolveTaskCalendar(migrated, context?.projects, context?.calendars);
  const canonical = normalizeTaskScheduleFields({
    ...migrated,
    ...milestoneCompletion(migrated),
    deps: (migrated.deps || []).map((dependency) => normalizeDependency(dependency, calendar))
  });
  const referenced = normalizeTaskReferences(canonical, context);
  return normalizeTaskPlan(referenced, context);
}
