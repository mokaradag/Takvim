import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ServerPersistenceError } from '../errors.js';
import { findDependencyCycle } from './dependencyGraphValidation.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { lockCommitResources } from './commitResourceLocks.js';
import { MAX_COMMIT_TASK_DEPENDENCIES, MAX_COMMIT_TOTAL_DEPENDENCIES } from './commitChangeValidation.js';

export const DEPENDENCY_PLAN = Symbol('dependencyPlan');
export const TASK_DEPENDENCY_CONTEXT = Symbol('taskDependencyContext');
const key = (value) => canonicalActualId(value) ?? String(value || '');
const hasFullAccess = (actor, projectId) => actor.isSystemAdmin
  || actor.effective.access.get(key(projectId))?.accessLevel === 'FULL';

function canReadTask(actor, row) {
  if (!row) return false;
  return hasFullAccess(actor, row.ProjectId)
    || actor.effective.access.get(key(row.ProjectId))?.reasons.includes('MANUAL_GRANT')
    || actor.effective.partialTaskIds.has(key(row.TaskId));
}

/** Görevler önce kilitlenir; içerik kaydı ve açık ilişki deltası ayrı uygulanır. */
export async function prepareScopedTaskDependencies(executor, changes) {
  await getTrustedCurrentSicil();
  const upserts = changes.taskUpserts || [];
  const { rows, dependencies, projectIds } = await lockCommitResources(executor, changes);
  const actor = await loadAuthorizationContext(executor, { resourceProjectIds: projectIds, resourceTaskIds: [...rows.keys()] });
  const storedByTask = new Map();
  for (const row of dependencies) {
    const taskId = key(row.TaskId);
    if (!storedByTask.has(taskId)) storedByTask.set(taskId, []);
    storedByTask.get(taskId).push({ predecessorId: key(row.PredecessorTaskId), type: row.DependencyType,
      lagDays: row.LagDays, lagValue: row.LagValue, lagUnit: row.LagUnit });
  }
  const newProjects = new Map(upserts.filter((task) => !rows.has(key(task.id)))
    .map((task) => [key(task.id), key(task.projectId)]));
  const finalProjects = new Map(upserts.map((task) => [key(task.id), key(task.projectId)]));
  const deletedIds = new Set((changes.taskDeletes || []).map((t) => key(t.id)));
  const taskUpserts = upserts.map((task) => {
    const before = rows.get(key(task.id));
    const stored = storedByTask.get(key(task.id)) || [];
    if (before && !canReadTask(actor, before)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Görev bu işlem için kullanılamıyor.');
    }
    if (before && task.dependencyMutation === false) {
      if (key(before.ProjectId) !== key(task.projectId)) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Proje taşıma açık ilişki değişikliği gerektirir.');
      }
      return { ...task, deps: [], [DEPENDENCY_PLAN]: { inserts: [], updates: [], deletes: [], relocations: [] } };
    }
    const projectId = key(task.projectId);
    const delta = task.dependencyChanges;
    const submitted = delta?.upserts || task.deps || [];
    if (new Set(submitted.map((dep) => key(dep.predecessorId))).size !== submitted.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Aynı öncül görev birden fazla kez eklenemez.');
    }
    const canUpsert = (targetId) => {
      const row = rows.get(key(targetId));
      return row ? (finalProjects.get(key(targetId)) || key(row.ProjectId)) === projectId && canReadTask(actor, row)
        : newProjects.get(key(targetId)) === projectId;
    };
    // Bilinmeyen, gizli ve çapraz proje hedefleri aynı hatayı üretir.
    if (submitted.some((dep) => deletedIds.has(key(dep.predecessorId)) || !canUpsert(dep.predecessorId))) {
      throw new ServerPersistenceError('FORBIDDEN', 'İlişki hedefi bu işlem için kullanılamıyor.');
    }
    // Legacy FULL replacement is the only array-authoritative compatibility path.
    const legacyFullReplacement = !delta && hasFullAccess(actor, projectId) && (!before || hasFullAccess(actor, before.ProjectId));
    const deps = new Map((before && !legacyFullReplacement ? stored : [])
      .map((dep) => [key(dep.predecessorId), dep]));
    for (const targetId of delta?.removals || []) {
      // Görünürlüğü kaybolan hedefin eski izdüşümü ilişkiyi silemez.
      const target = rows.get(key(targetId));
      if (before && target && key(target.ProjectId) === key(before.ProjectId) && canReadTask(actor, target)) deps.delete(key(targetId));
    }
    for (const dep of submitted) deps.set(key(dep.predecessorId), dep);
    for (const deletedId of deletedIds) deps.delete(deletedId);
    if (deps.size > MAX_COMMIT_TASK_DEPENDENCIES) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Görev bağımlılık sınırı aşıldı.');
    }
    const storedMap = new Map(stored.map((dep) => [key(dep.predecessorId), dep]));
    const signature = (dep) => JSON.stringify([dep.type, Number(dep.lagDays || 0), dep.lagValue ?? null, dep.lagUnit || null]);
    const plan = {
      inserts: [...deps.values()].filter((dep) => !storedMap.has(key(dep.predecessorId))),
      updates: [...deps.values()].filter((dep) => storedMap.has(key(dep.predecessorId)) && key(before.ProjectId) === projectId &&
        signature(dep) !== signature(storedMap.get(key(dep.predecessorId)))),
      relocations: before && key(before.ProjectId) !== projectId ? dependencies
        .filter((row) => key(row.TaskId) === key(task.id) && deps.has(key(row.PredecessorTaskId)))
        .map((row) => ({ ...row, dependency: deps.get(key(row.PredecessorTaskId)),
          attributesChanged: signature(deps.get(key(row.PredecessorTaskId))) !== signature(storedMap.get(key(row.PredecessorTaskId))) })) : [],
      deletes: stored.filter((dep) => !deps.has(key(dep.predecessorId))).map((dep) => dep.predecessorId)
    };
    // deps is an integrity-only final graph; SQL persistence consumes only this plan.
    return { ...task, deps: [...deps.values()], [DEPENDENCY_PLAN]: plan };
  });
  const resulting = new Map(dependencies.map((edge) => [`${key(edge.TaskId)}:${key(edge.PredecessorTaskId)}`, {
    taskId: key(edge.TaskId), predecessorId: key(edge.PredecessorTaskId)
  }]));
  for (const task of taskUpserts) {
    const plan = task[DEPENDENCY_PLAN];
    for (const target of plan.deletes) resulting.delete(`${key(task.id)}:${key(target)}`);
    for (const dep of plan.inserts) resulting.set(`${key(task.id)}:${key(dep.predecessorId)}`, { taskId: key(task.id), predecessorId: key(dep.predecessorId) });
  }
  for (const [edgeKey, edge] of resulting) {
    if (deletedIds.has(edge.taskId) || deletedIds.has(edge.predecessorId)) { resulting.delete(edgeKey); continue; }
    const successorProject = finalProjects.get(edge.taskId) || key(rows.get(edge.taskId)?.ProjectId);
    const predecessorProject = finalProjects.get(edge.predecessorId) || key(rows.get(edge.predecessorId)?.ProjectId);
    if (!successorProject || successorProject !== predecessorProject || edge.taskId === edge.predecessorId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bağımlılık görevleri son durumda aynı projede olmalıdır.');
    }
  }
  const cycleTaskIds = findDependencyCycle([...resulting.values()]);
  if (cycleTaskIds.length) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Görev bağımlılıkları döngü oluşturamaz.');
  }
  if (taskUpserts.reduce((n, task) => n + (task.deps || []).length, 0) > MAX_COMMIT_TOTAL_DEPENDENCIES) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'İşlem bağımlılık sınırı aşıldı.');
  }
  const prepared = { ...changes, taskUpserts };
  Object.defineProperty(prepared, TASK_DEPENDENCY_CONTEXT, { value: actor });
  return prepared;
}
