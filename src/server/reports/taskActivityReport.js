import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ACCESS_REASONS } from '../authorization/authorization.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { activityDateRange } from './activityDates.js';
import { auditAssigneeIds, taskActivityChanges } from './taskActivityChanges.js';

function invalid(message) { throw new ServerPersistenceError('MUTATION_FAILED', message); }
export function normalizeActivityQuery(input = {}, actor, now) {
  const range = activityDateRange(input, now);
  const scope = input.scope || (actor.isExecutive ? 'team' : 'visible');
  if (!['team', 'visible', 'mine'].includes(scope)) invalid('Hareket kapsamı geçersiz.');
  if (scope === 'team' && !actor.isExecutive && !actor.isSystemAdmin) throw new ServerPersistenceError('FORBIDDEN', 'Ekip raporu için yönetici kapsamı gerekir.');
  const page = Number(input.page || 0), pageSize = Number(input.pageSize || 25);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid('Sayfalama değeri geçersiz.');
  const projectId = input.projectId ? canonicalActualId(input.projectId) : null;
  if (input.projectId && !projectId) invalid('Proje filtresi geçersiz.');
  const person = input.person ? Number(input.person) : null;
  if (person != null && (!Number.isInteger(person) || person < 1 || person > 2147483647)) invalid('Kişi filtresi geçersiz.');
  const kind = input.kind || '';
  if (!['', 'created', 'updated', 'completed', 'deleted'].includes(kind)) invalid('Hareket türü geçersiz.');
  return { ...range, scope, page, pageSize, projectId, person, kind,
    ...Object.fromEntries(['directorate', 'department', 'unit'].map((field) => [field, String(input[field] || '').slice(0, 1000)])) };
}

export const TASK_ACTIVITY_SQL = `
  SELECT a.AuditId, a.OccurredAt, a.ActorSicil, a.ActorDisplayName, a.ActionCode, a.EntityId, a.ProjectId,
    COALESCE(CONVERT(varchar(36), a.CorrelationId), CONCAT('audit:', a.AuditId)) AS ActionGroup,
    t.Title AS CurrentTitle, t.TaskId AS CurrentTaskId, p.ProjectName, p.ProjectCode,
    pd.DisplayName AS CurrentActorName, pd.Directorate, pd.Department, pd.Unit,
    CASE WHEN a.ActionCode = 'DELETE' THEN 'deleted' WHEN a.ActionCode = 'CREATE' THEN 'created'
      WHEN COALESCE(JSON_VALUE(a.AfterJson, '$.Status'), JSON_VALUE(a.AfterJson, '$.status')) IN ('done', 'completed')
        AND COALESCE(JSON_VALUE(a.BeforeJson, '$.Status'), JSON_VALUE(a.BeforeJson, '$.status'), '') NOT IN ('done', 'completed')
      THEN 'completed' ELSE 'updated' END AS Kind,
    CASE WHEN COALESCE(JSON_VALUE(a.AfterJson, '$.Status'), JSON_VALUE(a.AfterJson, '$.status')) IN ('done', 'completed')
      AND COALESCE(JSON_VALUE(a.BeforeJson, '$.Status'), JSON_VALUE(a.BeforeJson, '$.status'), '') NOT IN ('done', 'completed') THEN 1 ELSE 0 END AS CompletionEvent
  INTO #TaskActivityScope
  FROM dbo.MR_AuditLog a
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = TRY_CONVERT(uniqueidentifier, a.EntityId)
  LEFT JOIN dbo.MR_Projects p ON p.ProjectId = a.ProjectId
  LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = a.ActorSicil
  OUTER APPLY (
    SELECT TOP (1) d.BeforeJson FROM dbo.MR_AuditLog d
    WHERE t.TaskId IS NULL AND d.EntityType = 'TASK' AND d.ActionCode = 'DELETE' AND d.EntityId = a.EntityId
      AND d.ProjectId = a.ProjectId ORDER BY d.OccurredAt DESC, d.AuditId DESC
  ) deleted
  WHERE a.EntityType = 'TASK' AND a.ActionCode IN ('CREATE', 'UPDATE', 'DELETE')
    AND a.OccurredAt >= @startUtc AND a.OccurredAt < @endUtc
    AND (@scope = 'visible' OR (@scope = 'mine' AND a.ActorSicil = @sicil)
      OR (@scope = 'team' AND (@isAdmin = 1 OR a.ActorSicil = @sicil OR EXISTS (
        SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = a.ActorSicil))))
    AND (@isAdmin = 1 OR (p.IsActive = 1 AND (
      (EXISTS (SELECT 1 FROM STRING_SPLIT(@visibleProjects, ',') f WHERE TRY_CONVERT(uniqueidentifier, f.value) = a.ProjectId)
        AND (t.TaskId IS NULL OR EXISTS (SELECT 1 FROM STRING_SPLIT(@visibleProjects, ',') f WHERE TRY_CONVERT(uniqueidentifier, f.value) = t.ProjectId)
          OR EXISTS (SELECT 1 FROM STRING_SPLIT(@partialTasks, ',') v WHERE TRY_CONVERT(uniqueidentifier, v.value) = t.TaskId)))
      OR (t.ProjectId = a.ProjectId AND EXISTS (SELECT 1 FROM STRING_SPLIT(@partialTasks, ',') v WHERE TRY_CONVERT(uniqueidentifier, v.value) = t.TaskId))
      OR (t.TaskId IS NULL AND (
        TRY_CONVERT(int, JSON_VALUE(deleted.BeforeJson, '$.CreatedBySicil')) = @sicil
        OR EXISTS (SELECT 1 FROM OPENJSON(deleted.BeforeJson, '$.assigneeIds') member
          WHERE TRY_CONVERT(int, member.value) = @sicil OR EXISTS (
            SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = TRY_CONVERT(int, member.value)))
      ))
    )));

  SELECT DISTINCT ActorSicil, COALESCE(CurrentActorName, ActorDisplayName, CONVERT(varchar(20), ActorSicil)) AS DisplayName,
    Directorate, Department, Unit FROM #TaskActivityScope ORDER BY DisplayName, ActorSicil;
  SELECT DISTINCT ProjectId, ProjectName, ProjectCode FROM #TaskActivityScope WHERE ProjectId IS NOT NULL ORDER BY ProjectName, ProjectId;

  SELECT ActionGroup, EntityId, ActorSicil, ProjectId, MAX(OccurredAt) AS OccurredAt, MAX(AuditId) AS LastAuditId, COUNT(*) AS EventCount,
    MAX(CompletionEvent) AS Completed,
    MAX(CASE WHEN Kind = 'deleted' THEN 1 ELSE 0 END) AS Deleted,
    MAX(CASE WHEN Kind = 'created' THEN 1 ELSE 0 END) AS Created
  INTO #TaskActivityGroups FROM #TaskActivityScope
  WHERE (@person IS NULL OR ActorSicil = @person) AND (@projectId IS NULL OR ProjectId = @projectId)
    AND (@directorate = '' OR COALESCE(NULLIF(LTRIM(RTRIM(Directorate)), ''), '__unassigned__') = @directorate)
    AND (@department = '' OR CONCAT(COALESCE(NULLIF(LTRIM(RTRIM(Directorate)), ''), '__unassigned__'), CHAR(31), LTRIM(RTRIM(Department))) = @department)
    AND (@unit = '' OR CONCAT(COALESCE(NULLIF(LTRIM(RTRIM(Directorate)), ''), '__unassigned__'), CHAR(31), LTRIM(RTRIM(Department)), CHAR(31), LTRIM(RTRIM(Unit))) = @unit)
  GROUP BY ActionGroup, EntityId, ActorSicil, ProjectId;
  DELETE FROM #TaskActivityGroups WHERE @kind <> '' AND @kind <> CASE WHEN Deleted = 1 THEN 'deleted'
    WHEN Created = 1 THEN 'created' WHEN Completed = 1 THEN 'completed' ELSE 'updated' END;
  DECLARE @total int = (SELECT COUNT(*) FROM #TaskActivityGroups);
  DECLARE @lastPage int = CASE WHEN @total = 0 THEN 0 ELSE (@total - 1) / @pageSize END;
  DECLARE @safePage int = CASE WHEN @page > @lastPage THEN @lastPage ELSE @page END;
  SELECT @total AS Total, @safePage AS Page, COUNT(DISTINCT EntityId) AS TaskCount,
    COUNT(DISTINCT ActorSicil) AS ActorCount, COUNT(DISTINCT CASE WHEN Completed = 1 THEN EntityId END) AS CompletedCount
  FROM #TaskActivityGroups;
  SELECT * INTO #TaskActivityPage FROM #TaskActivityGroups ORDER BY OccurredAt DESC, LastAuditId DESC
    OFFSET (@safePage * @pageSize) ROWS FETCH NEXT @pageSize ROWS ONLY;
  SELECT g.LastAuditId AS GroupId, g.OccurredAt AS GroupOccurredAt, g.Completed, g.Deleted, g.Created, g.EventCount, e.*
  FROM #TaskActivityPage g
  CROSS APPLY (SELECT TOP (100) s.*, detail.BeforeJson, detail.AfterJson FROM #TaskActivityScope s
    JOIN dbo.MR_AuditLog detail ON detail.AuditId = s.AuditId
    WHERE s.ActionGroup = g.ActionGroup AND s.EntityId = g.EntityId AND s.ActorSicil = g.ActorSicil
      AND (s.ProjectId = g.ProjectId OR (s.ProjectId IS NULL AND g.ProjectId IS NULL)) ORDER BY s.AuditId) e
  ORDER BY g.OccurredAt DESC, g.LastAuditId DESC, e.AuditId;
  DROP TABLE #TaskActivityPage, #TaskActivityGroups, #TaskActivityScope;
`;

export async function readTaskActivityReport(executor, actor, input = {}, now) {
  const query = normalizeActivityQuery(input, actor, now);
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('isAdmin', sql.Bit, actor.isSystemAdmin);
  const visibleProjects = new Set([...actor.effective.fullProjectIds, ...[...actor.effective.access.values()]
    .filter((entry) => entry.reasons.includes(ACCESS_REASONS.MANUAL_GRANT)).map((entry) => entry.projectId)]);
  request.input('visibleProjects', sql.NVarChar(sql.MAX), [...visibleProjects].join(','));
  request.input('partialTasks', sql.NVarChar(sql.MAX), [...actor.effective.partialTaskIds].join(','));
  for (const key of ['startUtc', 'endUtc']) request.input(key, sql.DateTime2, query[key]);
  for (const key of ['page', 'pageSize', 'person']) request.input(key, sql.Int, query[key]);
  request.input('projectId', sql.UniqueIdentifier, query.projectId);
  for (const key of ['scope', 'kind', 'directorate', 'department', 'unit']) request.input(key, sql.NVarChar(1000), query[key]);
  const result = await request.query(TASK_ACTIVITY_SQL);
  const [actorRows = [], projectRows = [], counts = [], events = []] = result.recordsets || [];
  const people = new Map();
  const ids = auditAssigneeIds(events);
  if (ids.length) {
    const names = executor.request();
    names.input('activityAssignees', sql.NVarChar(sql.MAX), ids.join(','));
    const found = await names.query(`SELECT Sicil, DisplayName FROM dbo.MR_V_PeopleDirectory
      WHERE Sicil IN (SELECT TRY_CONVERT(int, value) FROM STRING_SPLIT(@activityAssignees, ','));`);
    for (const row of found.recordset || []) people.set(String(row.Sicil), row.DisplayName);
  }
  const groups = new Map();
  for (const event of events) {
    const key = String(event.GroupId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const items = [...groups.entries()].map(([id, rows]) => {
    const last = rows[rows.length - 1];
    const change = taskActivityChanges(rows, people);
    return { id, occurredAt: new Date(last.GroupOccurredAt).toISOString(), actorId: String(last.ActorSicil),
      actorName: last.ActorDisplayName || last.CurrentActorName || `Çalışan ${last.ActorSicil}`,
      projectId: canonicalActualId(last.ProjectId), projectName: change.projectName || last.ProjectName || 'Geçmiş proje',
      projectCode: change.projectCode || last.ProjectCode || '', taskId: canonicalActualId(last.EntityId),
      taskTitle: change.title || last.CurrentTitle || 'Geçmiş görev', taskAvailable: Boolean(last.CurrentTaskId),
      changes: change.changes, detailsLimited: Number(last.EventCount) > rows.length, kind: last.Deleted ? 'deleted' : last.Created ? 'created' : last.Completed ? 'completed' : 'updated' };
  });
  const summary = counts[0] || {};
  return { items, total: Number(summary.Total || 0), page: Number(summary.Page || 0), pageSize: query.pageSize,
    summary: { tasks: Number(summary.TaskCount || 0), people: Number(summary.ActorCount || 0), completed: Number(summary.CompletedCount || 0) },
    range: { from: query.from, to: query.to, timeZone: query.timeZone }, scope: query.scope,
    canViewTeam: actor.isExecutive || actor.isSystemAdmin,
    filters: { people: actorRows.map((row) => ({ id: String(row.ActorSicil), name: row.DisplayName,
      organization: { directorate: row.Directorate, department: row.Department, unit: row.Unit } })),
    projects: projectRows.map((row) => ({ id: canonicalActualId(row.ProjectId), name: row.ProjectName || 'Geçmiş proje', code: row.ProjectCode || '' })) } };
}

export function queryTaskActivities(input) {
  return withSqlTransaction(async (executor) => readTaskActivityReport(executor, await loadAuthorizationContext(executor), input), { isolationLevel: sql.ISOLATION_LEVEL.READ_COMMITTED });
}
