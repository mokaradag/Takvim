import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';

const key = (value) => canonicalActualId(value) ?? String(value || '');
const ids = (values) => [...new Set(values.filter(Boolean).map(key))].sort();

/** Discover without retaining locks, then acquire Projects → WBS → Tasks → edges.
 * Project metadata writes use X, topology writes U, ordinary saves only S.
 * Recheck discovered ownership after locking; never expand the plan out of order.
 */
export async function lockCommitResources(executor, changes) {
  const upserts = changes.taskUpserts || [];
  const taskIds = ids([...upserts.map((t) => t.id), ...(changes.taskDeletes || []).map((t) => t.id),
    ...upserts.flatMap((t) => [t.recurrenceParentId, ...(t.dependencyMutation === false ? [] :
      [...(t.dependencyChanges?.upserts || t.deps || []).map((d) => d.predecessorId), ...(t.dependencyChanges?.removals || [])])])]);
  const wbsIds = ids([...(changes.wbsUpserts || []).flatMap((w) => [w.id, w.parentId]), ...(changes.wbsDeletes || []).map((w) => w.id), ...upserts.map((t) => t.wbsId)]);
  const projectCodes = [...new Set((changes.projectUpserts || []).map((p) => String(p.code || '').trim().toUpperCase()).filter(Boolean))].sort();
  const discover = executor.request();
  discover.input('lockTaskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  discover.input('lockWbsIds', sql.NVarChar(sql.MAX), wbsIds.join(','));
  discover.input('lockProjectCodes', sql.NVarChar(sql.MAX), JSON.stringify(projectCodes));
  const discovery = await discover.query(`/* commit-resource-discovery */
    SELECT t.* FROM dbo.MR_Tasks t WITH (READCOMMITTED)
    WHERE t.TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockTaskIds, ','))
      OR t.RecurrenceParentTaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockTaskIds, ','))
      OR t.TaskId IN (SELECT ownTask.RecurrenceParentTaskId FROM dbo.MR_Tasks ownTask WITH (READCOMMITTED)
        WHERE ownTask.TaskId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockTaskIds, ',')));
    SELECT w.* FROM dbo.MR_WBS w WITH (READCOMMITTED)
    WHERE w.WbsId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockWbsIds, ','));
    SELECT ProjectId FROM dbo.MR_Projects WITH (READCOMMITTED)
    WHERE UPPER(ProjectCode) IN (SELECT value FROM OPENJSON(@lockProjectCodes));
  `);
  const discoveredTasks = discovery.recordsets?.[0] || [];
  const discoveredWbs = discovery.recordsets?.[1] || [];
  const codeOwners = ids((discovery.recordsets?.[2] || []).map((p) => p.ProjectId));
  const before = new Map(discoveredTasks.map((t) => [key(t.TaskId), t]));
  const exclusiveProjects = new Set(ids([...(changes.projectUpserts || []), ...(changes.projectDeletes || [])].map((p) => p.id)));
  const topologyProjects = new Set(exclusiveProjects);
  for (const t of upserts) {
    const stored = before.get(key(t.id));
    if (!stored || t.dependencyMutation !== false || key(stored.ProjectId) !== key(t.projectId)) {
      topologyProjects.add(key(t.projectId));
      if (stored) topologyProjects.add(key(stored.ProjectId));
    }
  }
  for (const t of changes.taskDeletes || []) if (before.has(key(t.id))) topologyProjects.add(key(before.get(key(t.id)).ProjectId));
  for (const w of changes.wbsUpserts || []) topologyProjects.add(key(w.projectId));
  if ((changes.wbsUpserts || []).length || (changes.wbsDeletes || []).length) {
    for (const w of discoveredWbs) topologyProjects.add(key(w.ProjectId));
  }
  const projectIds = ids([...topologyProjects, ...codeOwners, ...upserts.map((t) => t.projectId),
    ...discoveredTasks.map((t) => t.ProjectId), ...discoveredWbs.map((w) => w.ProjectId)]);
  const population = executor.request();
  population.input('topologyProjectIds', sql.NVarChar(sql.MAX), [...topologyProjects].sort().join(','));
  const members = await population.query(`/* commit-topology-members */
    SELECT TaskId, ProjectId FROM dbo.MR_Tasks WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@topologyProjectIds, ','));
    SELECT WbsId, ProjectId FROM dbo.MR_WBS WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@topologyProjectIds, ','));
  `);
  // Project-code uniqueness is a Project resource too; reserve its canonical
  // keys before any row locks, including the missing-code insertion case.
  for (const code of projectCodes) {
    const req = executor.request();
    req.input('resource', sql.NVarChar(255), `mergen-rota:project-code:${code}`.slice(0, 255));
    const locked = await req.query(`/* commit-project-code-lock */
      DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource = @resource,
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
      SELECT @result AS LockResult;
    `);
    if (!(locked.recordset?.[0]?.LockResult >= 0)) throw new ServerPersistenceError('CONFLICT', 'Proje kodu eşzamanlı değiştiriliyor. Yeniden deneyin.');
  }
  if (projectCodes.length) {
    const current = await discover.query(`/* commit-code-owners */ SELECT ProjectId FROM dbo.MR_Projects WITH (READCOMMITTED)
      WHERE UPPER(ProjectCode) IN (SELECT value FROM OPENJSON(@lockProjectCodes));`);
    if (JSON.stringify(codeOwners) !== JSON.stringify(ids((current.recordset || []).map((p) => p.ProjectId)))) {
      throw new ServerPersistenceError('CONFLICT', 'Proje kodu kapsamı değişti. Yeniden deneyin.');
    }
  }
  // One request per identifier makes acquisition order independent of SQL's sort plan.
  for (const projectId of projectIds) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, projectId);
    const hint = exclusiveProjects.has(projectId) ? 'XLOCK, HOLDLOCK' : (topologyProjects.has(projectId) || codeOwners.includes(projectId)) ? 'UPDLOCK, HOLDLOCK' : 'HOLDLOCK';
    await req.query(`/* commit-project-lock */ SELECT ProjectId FROM dbo.MR_Projects WITH (${hint}) WHERE ProjectId = @resourceId;`);
  }
  const stableMembers = await population.query(`/* commit-topology-members */
    SELECT TaskId, ProjectId FROM dbo.MR_Tasks WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@topologyProjectIds, ','));
    SELECT WbsId, ProjectId FROM dbo.MR_WBS WITH (READCOMMITTED)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@topologyProjectIds, ','));
  `);
  const membership = (result) => JSON.stringify([
    ids((result.recordsets?.[0] || []).map((t) => t.TaskId)), ids((result.recordsets?.[1] || []).map((w) => w.WbsId))
  ]);
  if (membership(members) !== membership(stableMembers)) {
    throw new ServerPersistenceError('CONFLICT', 'Proje kapsamı değişti. Verileri yeniden yükleyin.');
  }
  for (const wbsId of ids([...wbsIds, ...discoveredWbs.map((w) => w.WbsId), ...(members.recordsets?.[1] || []).map((w) => w.WbsId)])) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, wbsId);
    await req.query('/* commit-wbs-lock */ SELECT WbsId FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = @resourceId;');
  }
  const rows = new Map();
  for (const taskId of ids([...taskIds, ...discoveredTasks.map((t) => t.TaskId), ...(members.recordsets?.[0] || []).map((t) => t.TaskId)])) {
    const req = executor.request();
    req.input('resourceId', sql.UniqueIdentifier, taskId);
    const result = await req.query('/* commit-task-lock */ SELECT * FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK) WHERE TaskId = @resourceId;');
    const row = result.recordset?.[0];
    if (row) {
      if (!projectIds.includes(key(row.ProjectId)) || (before.has(taskId) && key(before.get(taskId).ProjectId) !== key(row.ProjectId))) {
        throw new ServerPersistenceError('CONFLICT', 'Görev kapsamı değişti. Verileri yeniden yükleyin.');
      }
      rows.set(taskId, row);
    }
  }
  if (!topologyProjects.size) return { rows, dependencies: [], projectIds };
  const req = executor.request();
  req.input('lockedTopologyProjectIds', sql.NVarChar(sql.MAX), [...topologyProjects].sort().join(','));
  const result = await req.query(`/* commit-dependency-lock */
    SELECT * FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId IN (SELECT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(@lockedTopologyProjectIds, ','))
    ORDER BY ProjectId, TaskId, PredecessorTaskId;
  `);
  return { rows, dependencies: result.recordset || [], projectIds };
}
