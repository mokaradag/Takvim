import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ServerPersistenceError } from '../errors.js';
import { sql } from '../db/pool.js';
import { MAX_COMMIT_TASK_DEPENDENCIES, MAX_COMMIT_TOTAL_DEPENDENCIES } from './commitChangeValidation.js';

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
export async function prepareScopedTaskDependencies(executor, actor, changes) {
  const upserts = changes.taskUpserts || [];
  if (!upserts.length && !(changes.taskDeletes || []).length) return changes;
  const taskIds = new Set([
    ...upserts.map((task) => key(task.id)),
    ...(changes.taskDeletes || []).map((task) => key(task.id)),
    ...upserts.flatMap((task) => [task.recurrenceParentId,
      ...(task.dependencyMutation === false ? [] : (task.dependencyChanges?.upserts || task.deps || []).map((dep) => dep.predecessorId)),
      ...(task.dependencyMutation === false && task.version ? [] : task.dependencyChanges?.removals || [])].filter(Boolean).map(key))
  ]);
  // Proje satırı bütün commit boyunca proje-içi ilişki ağı değişikliklerini
  // serileştirir. İçerik-only mevcut görev yeni bir ağ doğrulaması istemez;
  // yeni görev ve açık ilişki mutasyonları ise hedef proje satırını da kilitler.
  const dependencyProjectIds = new Set(upserts
    .filter((task) => !task.version || task.dependencyMutation !== false)
    .map((task) => key(task.projectId)));
  const req = executor.request();
  req.input('scopedDependencyTaskIds', sql.NVarChar(sql.MAX), [...taskIds].sort().join(','));
  req.input('dependencyOwnerTaskIds', sql.NVarChar(sql.MAX), [...upserts.map((task) => key(task.id)), ...(changes.taskDeletes || []).map((task) => key(task.id))].sort().join(','));
  req.input('dependencyProjectIds', sql.NVarChar(sql.MAX), [...dependencyProjectIds].sort().join(','));
  const result = await req.query(`
    SELECT ProjectId FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@dependencyProjectIds, ','))
      OR ProjectId IN (SELECT ProjectId FROM dbo.MR_Tasks
        WHERE TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@dependencyOwnerTaskIds, ',')))
    ORDER BY ProjectId;

    -- Proje satırı ağ değişikliklerini serileştirir. Burada proje nüfusunun
    -- tamamını kilitlemek yerine yalnızca bu mutasyonun gerçek görev uçları
    -- kilitlenir; sıradan içerik kaydı yüzlerce ilgisiz görevi bloke etmez.
    SELECT TaskId, ProjectId
    FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@scopedDependencyTaskIds, ','))
    ORDER BY TaskId;

    SELECT TaskId, ProjectId, PredecessorTaskId, DependencyType, LagDays, LagValue, LagUnit
    FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@scopedDependencyTaskIds, ','))
    ORDER BY TaskId, PredecessorTaskId;
  `);
  const rows = new Map((result.recordsets?.[1] || []).map((row) => [key(row.TaskId), row]));
  const storedByTask = new Map();
  for (const row of result.recordsets?.[2] || []) {
    const taskId = key(row.TaskId);
    if (!storedByTask.has(taskId)) storedByTask.set(taskId, []);
    storedByTask.get(taskId).push({ predecessorId: key(row.PredecessorTaskId), type: row.DependencyType,
      lagDays: row.LagDays, lagValue: row.LagValue, lagUnit: row.LagUnit });
  }
  const newProjects = new Map(upserts.filter((task) => !rows.has(key(task.id)))
    .map((task) => [key(task.id), key(task.projectId)]));
  const finalProjects = new Map(upserts.map((task) => [key(task.id), key(task.projectId)]));
  const taskUpserts = upserts.map((task) => {
    const before = rows.get(key(task.id));
    const stored = storedByTask.get(key(task.id)) || [];
    if (before && task.dependencyMutation === false) {
      if (key(before.ProjectId) !== key(task.projectId)) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Proje taşıma açık ilişki değişikliği gerektirir.');
      }
      return { ...task, deps: stored };
    }
    const projectId = key(task.projectId);
    const delta = task.dependencyChanges;
    const submitted = delta?.upserts || task.deps || [];
    if (new Set(submitted.map((dep) => key(dep.predecessorId))).size !== submitted.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Aynı öncül görev birden fazla kez eklenemez.');
    }
    const allowed = (targetId) => {
      const row = rows.get(key(targetId));
      return row ? (finalProjects.get(key(targetId)) || key(row.ProjectId)) === projectId && canReadTask(actor, row)
        : newProjects.get(key(targetId)) === projectId;
    };
    // Bilinmeyen, gizli ve çapraz proje hedefleri aynı hatayı üretir.
    if (submitted.some((dep) => !allowed(dep.predecessorId))) {
      throw new ServerPersistenceError('FORBIDDEN', 'İlişki hedefi bu işlem için kullanılamıyor.');
    }
    const deps = new Map((before && key(before.ProjectId) === projectId && (delta || !hasFullAccess(actor, projectId)) ? stored : [])
      .map((dep) => [key(dep.predecessorId), dep]));
    for (const targetId of delta?.removals || []) {
      // Görünürlüğü kaybolan hedefin eski izdüşümü ilişkiyi silemez.
      if (allowed(targetId)) deps.delete(key(targetId));
    }
    for (const dep of submitted) deps.set(key(dep.predecessorId), dep);
    if (deps.size > MAX_COMMIT_TASK_DEPENDENCIES) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Görev bağımlılık sınırı aşıldı.');
    }
    return { ...task, deps: [...deps.values()] };
  });
  if (taskUpserts.reduce((n, task) => n + (task.deps || []).length, 0) > MAX_COMMIT_TOTAL_DEPENDENCIES) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'İşlem bağımlılık sınırı aşıldı.');
  }
  return { ...changes, taskUpserts };
}
