import 'server-only';
import { MUTATION_INTENT, normalizeCommitChanges, resourceKey as key, taskMutationIntent } from './commitMutationIntent.js';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';

const ids = (values) => [...new Set(values.filter(Boolean).map(key))].sort();

/** Kod → Proje → açık WBS → açık görev. Topoloji proje satırında sıralanır. */
export async function lockCommitResources(executor, input, { preflight } = {}) {
  const changes = normalizeCommitChanges(input);
  const upserts = changes.taskUpserts || [];
  const taskIds = ids([...upserts.map((t) => t.id), ...(changes.taskDeletes || []).map((t) => t.id),
    ...upserts.flatMap((t) => t.dependencyMutation === false ? [] :
      [...(t.dependencyChanges?.upserts || t.deps || []).map((d) => d.predecessorId), ...(t.dependencyChanges?.removals || [])])]);
  const referencedParents = ids(upserts.map((t) => t.recurrenceParentId));
  const wbsIds = ids([...(changes.wbsUpserts || []).flatMap((w) => [w.id, w.parentId]), ...(changes.wbsDeletes || []).map((w) => w.id)]);
  const discover = executor.request();
  discover.input('lockTaskIds', sql.NVarChar(sql.MAX), ids([...taskIds, ...referencedParents]).join(','));
  discover.input('lockWbsIds', sql.NVarChar(sql.MAX), ids([...wbsIds, ...upserts.map((t) => t.wbsId)]).join(','));
  const discovery = await discover.query(`/* commit-resource-discovery */
    SELECT t.* FROM dbo.MR_Tasks t WITH (READCOMMITTED)
    WHERE t.TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockTaskIds, ','));
    SELECT w.* FROM dbo.MR_WBS w WITH (READCOMMITTED)
    WHERE w.WbsId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockWbsIds, ','));
  `);
  const discoveredTasks = discovery.recordsets?.[0] || [];
  const referencedWbs = discovery.recordsets?.[1] || [];
  const before = new Map(discoveredTasks.map((t) => [key(t.TaskId), t]));
  const intents = new Map(upserts.map((t) => [key(t.id), taskMutationIntent(t, before.get(key(t.id)))]));
  const mutatedWbs = ids([...wbsIds, ...upserts.filter((t) => intents.get(key(t.id)).wbs).map((t) => t.wbsId)]);
  const discoveredWbs = referencedWbs.filter((w) => mutatedWbs.includes(key(w.WbsId)));
  const topologyProjects = new Set(ids([...changes.projectUpserts, ...changes.projectDeletes].map((p) => p.id)));

  for (const t of upserts) {
    const stored = before.get(key(t.id));
    if (intents.get(key(t.id)).topology) {
      topologyProjects.add(key(t.projectId));
      if (stored) topologyProjects.add(key(stored.ProjectId));
    }
  }
  for (const t of changes.taskDeletes || []) if (before.has(key(t.id))) topologyProjects.add(key(before.get(key(t.id)).ProjectId));
  for (const w of changes.wbsUpserts || []) topologyProjects.add(key(w.projectId));
  for (const w of discoveredWbs) topologyProjects.add(key(w.ProjectId));
  const projectIds = ids([...topologyProjects, ...upserts.map((t) => t.projectId),
    ...discoveredTasks.map((t) => t.ProjectId), ...discoveredWbs.map((w) => w.ProjectId)]);
  await preflight?.({ rows: before, projectIds, intents });
  // Kod kataloğu taraması yalnızca bu tek rezervasyonun altında çalışır.
  if (topologyProjects.size) {
    const req = executor.request();
    req.input('resource', sql.NVarChar(255), 'mergen-rota:project-code:catalog');
    req.input('lockMode', sql.VarChar(32), changes.projectUpserts.length || changes.projectDeletes.length ? 'Exclusive' : 'Shared');
    const locked = await req.query(`/* commit-project-code-lock */
      DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource = @resource,
        @LockMode = @lockMode, @LockOwner = 'Transaction', @LockTimeout = 15000;
      SELECT @result AS LockResult;
    `);
    if (!(locked.recordset?.[0]?.LockResult >= 0)) throw new ServerPersistenceError('CONFLICT', 'Proje kodu eşzamanlı değiştiriliyor. Yeniden deneyin.');
  }
  // Açık kimlikler SQL yürütme planından bağımsız sırayla kilitlenir.
  for (const projectId of projectIds) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, projectId);
    const hint = topologyProjects.has(projectId) ? 'XLOCK, HOLDLOCK' : 'HOLDLOCK';
    await req.query(`/* commit-project-lock */ SELECT ProjectId FROM dbo.MR_Projects WITH (${hint}) WHERE ProjectId = @resourceId;`);
  }
  const population = executor.request();
  population.input('topologyProjectIds', sql.NVarChar(sql.MAX), [...topologyProjects].sort().join(','));
  const members = topologyProjects.size ? await population.query(`/* commit-topology-members */
    SELECT * FROM dbo.MR_Tasks WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@topologyProjectIds, ','));
  `) : {};
  const memberTasks = members.recordsets?.[0] || [];
  const deleted = new Set((changes.taskDeletes || []).map((t) => key(t.id)));
  const writeTasks = ids([...taskIds, ...memberTasks.filter((t) => deleted.has(key(t.RecurrenceParentTaskId))).map((t) => t.TaskId)]);
  const parentIds = ids(upserts.flatMap((t) => [t.recurrenceParentId, before.get(key(t.id))?.RecurrenceParentTaskId]));
  for (const wbsId of mutatedWbs) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, wbsId);
    const result = await req.query('/* commit-wbs-lock */ SELECT * FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = @resourceId;');
    const row = result.recordset?.[0];
    if (row && (!projectIds.includes(key(row.ProjectId)) || discoveredWbs.some((w) => key(w.WbsId) === wbsId && key(w.ProjectId) !== key(row.ProjectId)))) {
      throw new ServerPersistenceError('CONFLICT', 'WBS kapsamı değişti. Verileri yeniden yükleyin.');
    }
  }
  const rows = new Map(memberTasks.map((t) => [key(t.TaskId), t]));
  for (const taskId of [...parentIds.filter((value) => !writeTasks.includes(value)), ...writeTasks]) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, taskId);
    const hint = writeTasks.includes(taskId) ? 'UPDLOCK, HOLDLOCK' : 'HOLDLOCK';
    const result = await req.query(`/* commit-task-lock */ SELECT * FROM dbo.MR_Tasks WITH (${hint}) WHERE TaskId = @resourceId;`);
    const row = result.recordset?.[0];
    if (row) {
      if (!projectIds.includes(key(row.ProjectId)) || (before.has(taskId) && key(before.get(taskId).ProjectId) !== key(row.ProjectId))) {
        throw new ServerPersistenceError('CONFLICT', 'Görev kapsamı değişti. Verileri yeniden yükleyin.');
      }
      const task = upserts.find((t) => key(t.id) === taskId);
      if (task && JSON.stringify(taskMutationIntent(task, row)) !== JSON.stringify(intents.get(taskId))) {
        throw new ServerPersistenceError('CONFLICT', 'Görev değişti. Verileri yeniden yükleyin.');
      }
      rows.set(taskId, row);
    }
  }
  for (const task of upserts) Object.defineProperty(task, MUTATION_INTENT, { value: intents.get(key(task.id)), enumerable: true, configurable: true });
  if (!topologyProjects.size) return { rows, dependencies: [], projectIds, intents };
  const req = executor.request();
  req.input('lockedTopologyProjectIds', sql.NVarChar(sql.MAX), [...topologyProjects].sort().join(','));
  const result = await req.query(`/* commit-dependency-lock */
    SELECT * FROM dbo.MR_TaskDependencies WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockedTopologyProjectIds, ','))
    ORDER BY ProjectId, TaskId, PredecessorTaskId;
  `);
  return { rows, dependencies: result.recordset || [], projectIds, intents };
}
