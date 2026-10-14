import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ServerPersistenceError } from '../errors.js';
import { sql } from '../db/pool.js';
import { MAX_COMMIT_TASK_DEPENDENCIES, MAX_COMMIT_TOTAL_DEPENDENCIES } from './commitChangeValidation.js';

export const TASK_DEPENDENCY_CONTEXT = Symbol('taskDependencyContext');

const key = (value) => canonicalActualId(value) ?? String(value || '');
const hasFullAccess = (actor, projectId) => actor.isSystemAdmin
  || actor.effective.access.get(key(projectId))?.accessLevel === 'FULL';

function canReadTask(actor, taskId, projectId) {
  return hasFullAccess(actor, projectId)
    || actor.effective.access.get(key(projectId))?.reasons.includes('MANUAL_GRANT')
    || actor.effective.partialTaskIds.has(key(taskId));
}

/** Kısmi görev ağı yalnızca görünür kenarları değiştirir; gizli kenarlar korunur. */
export async function prepareScopedTaskDependencies(executor, actor, changes) {
  const upserts = changes.taskUpserts || [];
  const scoped = upserts.filter((task) => !hasFullAccess(actor, task.projectId));
  if (!scoped.length) return changes;
  const req = executor.request();
  req.input('scopedDependencyTaskIds', sql.NVarChar(sql.MAX), scoped.map((task) => key(task.id)).sort().join(','));
  const result = await req.query(`
    SELECT TaskId, ProjectId, PredecessorTaskId, DependencyType, LagDays, LagValue, LagUnit
    FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId IN (
      SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value)))
      FROM STRING_SPLIT(@scopedDependencyTaskIds, ',')
    )
    ORDER BY TaskId, PredecessorTaskId;

    SELECT TaskId
    FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId IN (
      SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value)))
      FROM STRING_SPLIT(@scopedDependencyTaskIds, ',')
    )
    ORDER BY TaskId;
  `);
  const storedByTask = new Map();
  for (const row of result.recordset || []) {
    const taskKey = `${key(row.TaskId)}:${key(row.ProjectId)}`;
    if (!storedByTask.has(taskKey)) storedByTask.set(taskKey, []);
    storedByTask.get(taskKey).push({
      predecessorId: key(row.PredecessorTaskId), type: row.DependencyType,
      lagDays: row.LagDays, lagValue: row.LagValue, lagUnit: row.LagUnit
    });
  }
  const existingTaskIds = new Set((result.recordsets?.[1] || []).map((row) => key(row.TaskId)));
  const proposedProjects = new Map(scoped.filter((task) => !existingTaskIds.has(key(task.id)))
    .map((task) => [key(task.id), key(task.projectId)]));
  const taskUpserts = upserts.map((task) => {
    const projectId = key(task.projectId);
    if (hasFullAccess(actor, projectId)) return task;
    const stored = storedByTask.get(`${key(task.id)}:${projectId}`) || [];
    // Eski istemcinin boş PARTIAL izdüşümü içerik kaydında bağları silemez.
    if (task.dependencyMutation === false && !(task.deps || []).length) {
      return { ...task, deps: stored };
    }
    const submitted = task.deps || [];
    // Aynı işlemdeki yeni görevlerin yazma yetkisi de kalıcılaştırmada doğrulanır.
    if (submitted.some((dep) => !canReadTask(actor, dep.predecessorId, projectId)
      && proposedProjects.get(key(dep.predecessorId)) !== projectId)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Yalnızca aynı projedeki görünür görevlerle ilişki kurulabilir.');
    }
    const hidden = stored.filter((dep) => !canReadTask(actor, dep.predecessorId, projectId));
    const deps = [...submitted, ...hidden];
    if (deps.length > MAX_COMMIT_TASK_DEPENDENCIES) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Görev bağımlılık sınırı aşıldı.');
    }
    return { ...task, deps };
  });
  const dependencyCount = taskUpserts.reduce((count, task) => count + (task.deps || []).length, 0);
  if (dependencyCount > MAX_COMMIT_TOTAL_DEPENDENCIES) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'İşlem bağımlılık sınırı aşıldı.');
  }
  return { ...changes, taskUpserts };
}
