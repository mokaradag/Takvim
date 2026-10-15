import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ServerPersistenceError } from '../errors.js';
import { reconcileDependencyGraph, reconcileTaskDependencies } from '../../domain/dependencyGraph.js';
import { normalizeCommitChanges, MUTATION_INTENT } from './commitMutationIntent.js';
import { sql } from '../db/pool.js';
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
export async function prepareScopedTaskDependencies(executor, input) {
  const changes = normalizeCommitChanges(input);
  await getTrustedCurrentSicil();
  if (changes.projectDeletes.length) {
    const identity = await loadAuthorizationContext(executor, { resourceProjectIds: [], resourceTaskIds: [] });
    if (!identity.isSystemAdmin) throw new ServerPersistenceError('FORBIDDEN', 'Projeyi yalnızca sistem yöneticisi silebilir.');
  }
  const upserts = changes.taskUpserts || [];
  const { rows, dependencies, projectIds } = await lockCommitResources(executor, changes, {
    preflight: async ({ rows, projectIds }) => {
      const actor = await loadAuthorizationContext(executor, { resourceProjectIds: projectIds, resourceTaskIds: [...rows.keys()] });
      for (const task of [...upserts, ...changes.taskDeletes]) {
        const row = rows.get(key(task.id));
        if (row && !canReadTask(actor, row)) throw new ServerPersistenceError('FORBIDDEN', 'Görev bu işlem için kullanılamıyor.');
      }
      const creates = upserts.filter((task) => !rows.has(key(task.id)) && !hasFullAccess(actor, task.projectId));
      if (creates.length && !actor.isExecutive) {
        const req = executor.request();
        req.input('sicil', sql.Int, actor.sicil);
        req.input('createScopeProjectIds', sql.NVarChar(sql.MAX), [...new Set(creates.map((task) => key(task.projectId)))].join(','));
        const result = await req.query(`/* commit-create-scope-preflight */
          SELECT DISTINCT t.ProjectId FROM dbo.MR_Tasks t WITH (READCOMMITTED)
          JOIN dbo.MR_TaskAssignees ta WITH (READCOMMITTED) ON ta.TaskId = t.TaskId
          JOIN dbo.MR_Projects p WITH (READCOMMITTED) ON p.ProjectId = t.ProjectId AND p.IsActive = 1
          WHERE ta.Sicil = @sicil AND t.ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@createScopeProjectIds, ','));
        `);
        const allowed = new Set((result.recordset || []).map((row) => key(row.ProjectId)));
        if (creates.some((task) => !allowed.has(key(task.projectId)))) throw new ServerPersistenceError('FORBIDDEN', 'Görev bu işlem için kullanılamıyor.');
      }
    }
  });
  const actor = await loadAuthorizationContext(executor, { resourceProjectIds: projectIds, resourceTaskIds: [...rows.keys()] });
  const storedByTask = new Map();
  const storedRowsByTask = new Map();
  for (const row of dependencies) {
    const taskId = key(row.TaskId);
    if (!storedByTask.has(taskId)) { storedByTask.set(taskId, []); storedRowsByTask.set(taskId, []); }
    storedRowsByTask.get(taskId).push(row);
    storedByTask.get(taskId).push({ predecessorId: key(row.PredecessorTaskId), type: row.DependencyType,
      lagDays: row.LagDays, lagValue: row.LagValue, lagUnit: row.LagUnit });
  }
  const newProjects = new Map(upserts.filter((task) => !rows.has(key(task.id)))
    .map((task) => [key(task.id), key(task.projectId)]));
  const finalProjects = new Map(upserts.map((task) => [key(task.id), key(task.projectId)]));
  const deletedIds = new Set((changes.taskDeletes || []).map((t) => key(t.id)));
  const completeGraph = projectIds.every((projectId) => hasFullAccess(actor, projectId)
    || actor.effective.access.get(key(projectId))?.reasons.includes('MANUAL_GRANT'));
  const constraintError = (message) => new ServerPersistenceError('MUTATION_FAILED', completeGraph ? message : 'İlişki değişikliği uygulanamadı. Bağımlılık kısıtlarını kontrol edin.');
  const taskUpserts = upserts.map((task) => {
    const before = rows.get(key(task.id));
    const stored = storedByTask.get(key(task.id)) || [];
    if (before && !canReadTask(actor, before)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Görev bu işlem için kullanılamıyor.');
    }
    if (before && !task[MUTATION_INTENT].dependencies) {
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
    const removals = (delta?.removals || []).filter((targetId) => {
      const target = rows.get(key(targetId));
      return before && target && key(target.ProjectId) === key(before.ProjectId) && canReadTask(actor, target);
    });
    const reconciled = reconcileTaskDependencies(stored, { ...task,
      dependencyChanges: delta ? { ...delta, removals } : undefined
    }, { replace: legacyFullReplacement || !before, deletedIds });
    const deps = new Map(reconciled.deps.map((dep) => [key(dep.predecessorId), dep]));
    if (deps.size > MAX_COMMIT_TASK_DEPENDENCIES) {
      throw constraintError('Görev bağımlılık sınırı aşıldı.');
    }
    const updatedIds = new Set(reconciled.updates.map((dep) => key(dep.predecessorId)));
    const plan = {
      inserts: reconciled.inserts,
      updates: before && key(before.ProjectId) !== projectId ? [] : reconciled.updates,
      relocations: before && key(before.ProjectId) !== projectId ? (storedRowsByTask.get(key(task.id)) || [])
        .filter((row) => deps.has(key(row.PredecessorTaskId)))
        .map((row) => ({ ...row, dependency: deps.get(key(row.PredecessorTaskId)),
          attributesChanged: updatedIds.has(key(row.PredecessorTaskId)) })) : [],
      deletes: reconciled.deletes
    };
    // deps is an integrity-only final graph; SQL persistence consumes only this plan.
    return { ...task, dependencyMutation: task[MUTATION_INTENT].dependencies, deps: [...deps.values()], [DEPENDENCY_PLAN]: plan };
  });
  const graph = reconcileDependencyGraph({
    storedEdges: dependencies.map((edge) => ({ taskId: key(edge.TaskId), predecessorId: key(edge.PredecessorTaskId) })),
    taskProjects: new Map([...rows].map(([taskId, row]) => [taskId, key(row.ProjectId)])),
    taskUpserts, deletedIds
  });
  if (graph.invalid) throw constraintError('Bağımlılık görevleri son durumda aynı projede olmalıdır.');
  if (graph.cycle.length) throw constraintError('Görev bağımlılıkları döngü oluşturamaz.');
  if (taskUpserts.reduce((n, task) => n + (task.deps || []).length, 0) > MAX_COMMIT_TOTAL_DEPENDENCIES) {
    throw constraintError('İşlem bağımlılık sınırı aşıldı.');
  }
  const prepared = { ...changes, taskUpserts };
  Object.defineProperty(prepared, TASK_DEPENDENCY_CONTEXT, { value: actor });
  return prepared;
}
