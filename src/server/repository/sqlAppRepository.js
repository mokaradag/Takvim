import 'server-only';
import { randomUUID } from 'node:crypto';
import { getSqlPool, sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
import { CORPORATE_PROJECT_SYNC_SQL } from './corporateQueries.js';
import { decodeVersion, encodeVersion } from './versionTokens.js';

function id(value) { return value == null ? null : String(value); }
function date(value) { return value || null; }
function number(value) { return value == null || value === '' ? null : Number(value); }
function deleteEntry(value) { return typeof value === 'string' ? { id: value, version: null } : value; }
function normalizeChanges(changes = {}) {
  return {
    projectUpserts: changes.projectUpserts || [],
    projectDeletes: (changes.projectDeletes || []).map(deleteEntry),
    wbsUpserts: changes.wbsUpserts || [],
    wbsDeletes: (changes.wbsDeletes || []).map(deleteEntry),
    taskUpserts: changes.taskUpserts || [],
    taskDeletes: (changes.taskDeletes || []).map(deleteEntry)
  };
}
function request(executor) { return executor.request(); }
function uuid(value) {
  const normalized = value || randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek Sistem kimlikleri geçerli UUID olmalıdır.');
  }
  return normalized;
}

async function synchronizeCorporateProjects(executor, actorSicil) {
  const sync = request(executor);
  sync.input('actorSicil', sql.Int, actorSicil);
  await sync.query(CORPORATE_PROJECT_SYNC_SQL);
}

async function loadSnapshotFrom(executor, auth) {
  const req = request(executor);
  req.input('sicil', sql.Int, auth.sicil);
  req.input('isAdmin', sql.Bit, auth.isSystemAdmin);
  const result = await req.query(`
    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));
    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT p.ProjectId, 'FULL' FROM dbo.MR_Projects p WHERE @isAdmin = 1 AND p.IsActive = 1;
    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT DISTINCT p.ProjectId, 'FULL'
    FROM dbo.MR_Projects p JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = p.ProjectCode
    WHERE @isAdmin = 0 AND p.IsActive = 1 AND a.Sicil = @sicil
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects x WHERE x.ProjectId = p.ProjectId);
    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT pa.ProjectId, CASE WHEN pa.AccessLevel = 'FULL' THEN 'FULL' ELSE 'PARTIAL' END
    FROM dbo.MR_ProjectAccess pa JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND p.IsActive = 1
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects x WHERE x.ProjectId = pa.ProjectId);
    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT DISTINCT t.ProjectId, 'PARTIAL'
    FROM dbo.MR_Tasks t JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = t.TaskId
    WHERE @isAdmin = 0
      AND (ta.Sicil = @sicil OR EXISTS (SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil))
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects x WHERE x.ProjectId = t.ProjectId);

    SELECT p.*, vp.AccessLevel
    FROM dbo.MR_Projects p JOIN @VisibleProjects vp ON vp.ProjectId = p.ProjectId
    WHERE p.IsActive = 1 ORDER BY p.ProjectName;

    SELECT pt.ProjectId, pt.TagName, pt.SortOrder
    FROM dbo.MR_ProjectTags pt JOIN @VisibleProjects vp ON vp.ProjectId = pt.ProjectId
    ORDER BY pt.ProjectId, pt.SortOrder, pt.TagName;

    SELECT w.*
    FROM dbo.MR_WBS w JOIN @VisibleProjects vp ON vp.ProjectId = w.ProjectId
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code;

    SELECT t.*, vp.AccessLevel
    FROM dbo.MR_Tasks t JOIN @VisibleProjects vp ON vp.ProjectId = t.ProjectId
    WHERE vp.AccessLevel = 'FULL' OR EXISTS (
      SELECT 1 FROM dbo.MR_TaskAssignees ta
      WHERE ta.TaskId = t.TaskId AND (
        ta.Sicil = @sicil OR EXISTS (SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil)
      )
    )
    ORDER BY t.ProjectId, t.SortOrder, t.Title;

    SELECT ta.TaskId, ta.Sicil FROM dbo.MR_TaskAssignees ta
    WHERE EXISTS (SELECT 1 FROM dbo.MR_Tasks t JOIN @VisibleProjects vp ON vp.ProjectId=t.ProjectId WHERE t.TaskId=ta.TaskId AND (vp.AccessLevel='FULL' OR ta.Sicil=@sicil OR EXISTS (SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil=@sicil AND es.EmployeeSicil=ta.Sicil)));

    SELECT d.* FROM dbo.MR_TaskDependencies d JOIN @VisibleProjects vp ON vp.ProjectId=d.ProjectId WHERE vp.AccessLevel='FULL';

    SELECT b.* FROM dbo.MR_Baselines b JOIN @VisibleProjects vp ON vp.ProjectId=b.ProjectId WHERE vp.AccessLevel='FULL';
    SELECT s.* FROM dbo.MR_TaskBaselineSnapshots s JOIN dbo.MR_Baselines b ON b.BaselineId=s.BaselineId JOIN @VisibleProjects vp ON vp.ProjectId=b.ProjectId WHERE vp.AccessLevel='FULL';

    SELECT c.*, wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName
    FROM dbo.MR_Calendars c
    LEFT JOIN dbo.MR_CalendarWorkingDays wd ON wd.CalendarId=c.CalendarId
    LEFT JOIN dbo.MR_CalendarHolidays h ON h.CalendarId=c.CalendarId
    WHERE c.IsActive=1 ORDER BY c.Name, wd.Weekday, h.HolidayDate;

    SELECT * FROM dbo.MR_V_PeopleDirectory ORDER BY DisplayName, Sicil;
  `);

  const [projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows, baselineSnapshotRows, calendarRows, peopleRows] = result.recordsets;
  const tagsByProject = new Map();
  for (const row of tagRows || []) {
    const key = id(row.ProjectId);
    if (!tagsByProject.has(key)) tagsByProject.set(key, []);
    tagsByProject.get(key).push(row.TagName);
  }
  const assigneesByTask = new Map();
  for (const row of assigneeRows || []) {
    const key = id(row.TaskId);
    if (!assigneesByTask.has(key)) assigneesByTask.set(key, []);
    assigneesByTask.get(key).push(String(row.Sicil));
  }
  const depsByTask = new Map();
  for (const row of dependencyRows || []) {
    const key = id(row.TaskId);
    if (!depsByTask.has(key)) depsByTask.set(key, []);
    depsByTask.get(key).push({
      id: id(row.TaskDependencyId), predecessorId: id(row.PredecessorTaskId), type: row.DependencyType,
      lagDays: Number(row.LagDays || 0), lagValue: row.LagValue == null ? undefined : Number(row.LagValue), lagUnit: row.LagUnit || undefined
    });
  }
  const calendars = new Map();
  for (const row of calendarRows || []) {
    const key = id(row.CalendarId);
    if (!calendars.has(key)) calendars.set(key, { id: key, name: row.Name, timezone: row.TimeZone, workingDays: [], holidays: [] });
    const calendar = calendars.get(key);
    if (row.Weekday != null && !calendar.workingDays.includes(Number(row.Weekday))) calendar.workingDays.push(Number(row.Weekday));
    if (row.HolidayDate) {
      const iso = new Date(row.HolidayDate).toISOString().slice(0, 10);
      if (!calendar.holidays.some((holiday) => holiday.date === iso)) calendar.holidays.push({ date: iso, name: row.HolidayName, short: row.ShortName || undefined });
    }
  }
  return {
    calendars: [...calendars.values()],
    projects: (projectRows || []).map((row) => ({
      id: id(row.ProjectId), source: row.SourceType.toLowerCase(), code: row.ProjectCode || null, name: row.ProjectName,
      projectTypeCode: row.ProjectTypeCode || null, projectTypeName: row.ProjectTypeName || null,
      leadId: row.LeadSicil == null ? null : String(row.LeadSicil), dataDate: row.DataDate ? new Date(row.DataDate).toISOString().slice(0, 10) : null,
      color: row.ColorToken || '#3b82f6', calendarId: id(row.CalendarId), tags: tagsByProject.get(id(row.ProjectId)) || [],
      version: encodeVersion(row.RowVersion), accessLevel: row.AccessLevel,
      schedulingCapability: row.AccessLevel === 'FULL' ? 'COMPLETE' : 'SUPPRESSED_PARTIAL'
    })),
    wbs: (wbsRows || []).map((row) => ({ id: id(row.WbsId), projectId: id(row.ProjectId), parentId: id(row.ParentWbsId), code: row.Code, name: row.Name, sortOrder: row.SortOrder, version: encodeVersion(row.RowVersion) })),
    tasks: (taskRows || []).map((row) => ({
      id: id(row.TaskId), projectId: id(row.ProjectId), wbsId: id(row.WbsId), calendarId: id(row.CalendarId), task: row.Title,
      description: row.Description || '', keyword: row.Keyword || '', status: row.Status, priority: row.Priority, isMilestone: Boolean(row.IsMilestone),
      plannedStart: row.PlannedStart ? new Date(row.PlannedStart).toISOString().slice(0, 10) : null,
      plannedFinish: row.PlannedFinish ? new Date(row.PlannedFinish).toISOString().slice(0, 10) : null,
      plannedDurationDays: number(row.PlannedDurationDays), targetFinish: row.TargetFinish ? new Date(row.TargetFinish).toISOString().slice(0, 10) : null,
      actualStart: row.ActualStart ? new Date(row.ActualStart).toISOString().slice(0, 10) : null,
      actualFinish: row.ActualFinish ? new Date(row.ActualFinish).toISOString().slice(0, 10) : null,
      remainingDurationDays: number(row.RemainingDurationDays), progress: number(row.Progress), plannedHours: number(row.PlannedHours), actualHours: number(row.ActualHours),
      budget: number(row.Budget), spent: number(row.Spent), sortOrder: row.SortOrder, assigneeIds: assigneesByTask.get(id(row.TaskId)) || [], deps: depsByTask.get(id(row.TaskId)) || [], version: encodeVersion(row.RowVersion)
    })),
    baselines: (baselineRows || []).map((row) => ({ id: id(row.BaselineId), projectId: id(row.ProjectId), name: row.Name, createdAt: new Date(row.CreatedAt).toISOString(), isPrimary: Boolean(row.IsPrimary) })),
    taskBaselineSnapshots: (baselineSnapshotRows || []).map((row) => ({ baselineId: id(row.BaselineId), taskId: id(row.TaskId), plannedStart: row.PlannedStart ? new Date(row.PlannedStart).toISOString().slice(0, 10) : null, plannedFinish: row.PlannedFinish ? new Date(row.PlannedFinish).toISOString().slice(0, 10) : null, plannedDurationDays: number(row.PlannedDurationDays), calendarId: id(row.CalendarId) })),
    people: (peopleRows || []).map((row) => ({ id: String(row.Sicil), employeeNo: String(row.Sicil), name: row.DisplayName || String(row.Sicil), username: row.Username || null, role: row.JobTitle || '', team: row.Team || '', color: '#64748b', organization: { sector: row.Sector || null, directorate: row.Directorate || null, department: row.Department || null, unit: row.Unit || null } }))
  };
}

async function ensurePeople(executor, sicils) {
  const unique = [...new Set(sicils.filter(Boolean).map(Number))];
  if (!unique.length) return;
  for (const sicil of unique) {
    const req = request(executor); req.input('sicil', sql.Int, sicil);
    const found = await req.query('SELECT TOP (1) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil=@sicil;');
    if (!found.recordset.length) throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${sicil}`);
  }
}

async function audit(executor, actor, correlationId, actionCode, entityType, entityId, projectId, before, after) {
  const req = request(executor);
  req.input('actorSicil', sql.Int, actor.sicil);
  req.input('username', sql.NVarChar(255), actor.currentUser.username || null);
  req.input('displayName', sql.NVarChar(255), actor.currentUser.name || null);
  req.input('actionCode', sql.VarChar(50), actionCode);
  req.input('entityType', sql.VarChar(50), entityType);
  req.input('entityId', sql.NVarChar(100), entityId);
  req.input('projectId', sql.UniqueIdentifier, projectId || null);
  req.input('correlationId', sql.UniqueIdentifier, correlationId);
  req.input('beforeJson', sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before));
  req.input('afterJson', sql.NVarChar(sql.MAX), after == null ? null : JSON.stringify(after));
  await req.query(`INSERT dbo.MR_AuditLog(ActorSicil,ActorUsername,ActorDisplayName,ActionCode,EntityType,EntityId,ProjectId,CorrelationId,BeforeJson,AfterJson)
    VALUES(@actorSicil,@username,@displayName,@actionCode,@entityType,@entityId,@projectId,@correlationId,@beforeJson,@afterJson);`);
}

async function projectRow(executor, projectId) {
  const req=request(executor); req.input('id',sql.UniqueIdentifier,projectId);
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_Projects WHERE ProjectId=@id;')).recordset[0] || null;
}
async function wbsRow(executor, wbsId) {
  const req=request(executor); req.input('id',sql.UniqueIdentifier,wbsId);
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_WBS WHERE WbsId=@id;')).recordset[0] || null;
}
async function taskRow(executor, taskId) {
  const req=request(executor); req.input('id',sql.UniqueIdentifier,taskId);
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_Tasks WHERE TaskId=@id;')).recordset[0] || null;
}

async function commitProject(executor, actor, effective, project, correlationId) {
  const projectId = uuid(project.id);
  const before = await projectRow(executor, projectId);
  if (!before) {
    if ((project.source || project.sourceType || 'manual').toUpperCase() !== 'MANUAL') throw new ServerPersistenceError('FORBIDDEN', 'Kurumsal projeler istemci tarafından oluşturulamaz.');
    assertCanCreateManualProject(actor);
    const req=request(executor);
    req.input('id',sql.UniqueIdentifier,projectId); req.input('name',sql.NVarChar(1000),project.name); req.input('code',sql.NVarChar(255),project.code||null);
    req.input('lead',sql.Int,project.leadId ? Number(project.leadId):null); req.input('dataDate',sql.Date,date(project.dataDate)); req.input('color',sql.VarChar(50),project.color||null);
    req.input('calendar',sql.UniqueIdentifier,project.calendarId||null); req.input('actor',sql.Int,actor.sicil);
    await req.query(`INSERT dbo.MR_Projects(ProjectId,SourceType,ProjectCode,ProjectName,LeadSicil,DataDate,ColorToken,CalendarId,CreatedBySicil,UpdatedBySicil)
      VALUES(@id,'MANUAL',@code,@name,@lead,@dataDate,@color,@calendar,@actor,@actor);
      INSERT dbo.MR_WBS(ProjectId,ParentWbsId,Code,Name,SortOrder,CreatedBySicil,UpdatedBySicil) VALUES(@id,NULL,N'1',@name,0,@actor,@actor);
      INSERT dbo.MR_ProjectAccess(ProjectId,Sicil,AccessLevel,GrantSource,CreatedBySicil,UpdatedBySicil) VALUES(@id,@actor,'FULL','OWNER',@actor,@actor);`);
    await audit(executor,actor,correlationId,'CREATE','PROJECT',projectId,projectId,null,project);
  } else {
    assertProjectWriteAccess(effective, projectId);
    if (!project.version) throw new ServerPersistenceError('CONFLICT','Proje sürümü eksik.');
    const req=request(executor);
    req.input('id',sql.UniqueIdentifier,projectId); req.input('version',sql.Binary(8),decodeVersion(project.version)); req.input('actor',sql.Int,actor.sicil);
    req.input('name',sql.NVarChar(1000),project.name); req.input('code',sql.NVarChar(255),project.code||null); req.input('lead',sql.Int,project.leadId?Number(project.leadId):null);
    req.input('dataDate',sql.Date,date(project.dataDate)); req.input('color',sql.VarChar(50),project.color||null); req.input('calendar',sql.UniqueIdentifier,project.calendarId||null);
    const updated=await req.query(`UPDATE dbo.MR_Projects SET
      ProjectName=CASE WHEN SourceType='MANUAL' THEN @name ELSE ProjectName END,
      ProjectCode=CASE WHEN SourceType='MANUAL' THEN @code ELSE ProjectCode END,
      LeadSicil=@lead,DataDate=@dataDate,ColorToken=@color,CalendarId=@calendar,UpdatedAt=SYSUTCDATETIME(),UpdatedBySicil=@actor
      WHERE ProjectId=@id AND RowVersion=@version; SELECT @@ROWCOUNT AS Affected;`);
    if (!updated.recordset[0]?.Affected) throw new ServerPersistenceError('CONFLICT','Proje başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
    await audit(executor,actor,correlationId,'UPDATE','PROJECT',projectId,projectId,before,project);
  }
  const del=request(executor); del.input('projectId',sql.UniqueIdentifier,projectId); await del.query('DELETE dbo.MR_ProjectTags WHERE ProjectId=@projectId;');
  for (let index=0; index<(project.tags||[]).length; index+=1) {
    const req=request(executor); req.input('projectId',sql.UniqueIdentifier,projectId); req.input('tag',sql.NVarChar(255),project.tags[index]); req.input('sort',sql.Int,index); req.input('actor',sql.Int,actor.sicil);
    await req.query('INSERT dbo.MR_ProjectTags(ProjectId,TagName,SortOrder,CreatedBySicil) VALUES(@projectId,@tag,@sort,@actor);');
  }
}

async function commitWbs(executor, actor, effective, node, correlationId) {
  const wbsId=uuid(node.id); const projectId=uuid(node.projectId); assertProjectWriteAccess(effective,projectId); const before=await wbsRow(executor,wbsId);
  if (node.parentId) {
    const parent=await wbsRow(executor,uuid(node.parentId));
    if (!parent || id(parent.ProjectId)!==projectId) throw new ServerPersistenceError('MUTATION_FAILED','Üst WBS aynı projede bulunmalıdır.');
    let cursor=parent;
    while (cursor?.ParentWbsId) { if (id(cursor.ParentWbsId)===wbsId) throw new ServerPersistenceError('MUTATION_FAILED','WBS döngüsü oluşturulamaz.'); cursor=await wbsRow(executor,id(cursor.ParentWbsId)); }
  }
  const req=request(executor); req.input('id',sql.UniqueIdentifier,wbsId); req.input('projectId',sql.UniqueIdentifier,projectId); req.input('parentId',sql.UniqueIdentifier,node.parentId||null);
  req.input('code',sql.NVarChar(100),node.code); req.input('name',sql.NVarChar(1000),node.name); req.input('sort',sql.Int,node.sortOrder??null); req.input('actor',sql.Int,actor.sicil);
  if (!before) await req.query('INSERT dbo.MR_WBS(WbsId,ProjectId,ParentWbsId,Code,Name,SortOrder,CreatedBySicil,UpdatedBySicil) VALUES(@id,@projectId,@parentId,@code,@name,@sort,@actor,@actor);');
  else {
    req.input('version',sql.Binary(8),decodeVersion(node.version));
    const updated=await req.query('UPDATE dbo.MR_WBS SET ParentWbsId=@parentId,Code=@code,Name=@name,SortOrder=@sort,UpdatedAt=SYSUTCDATETIME(),UpdatedBySicil=@actor WHERE WbsId=@id AND RowVersion=@version; SELECT @@ROWCOUNT AS Affected;');
    if (!updated.recordset[0]?.Affected) throw new ServerPersistenceError('CONFLICT','WBS başka bir kullanıcı tarafından değiştirildi.');
  }
  await audit(executor,actor,correlationId,before?'UPDATE':'CREATE','WBS',wbsId,projectId,before,node);
}

async function commitTask(executor, actor, effective, task, correlationId) {
  const taskId=uuid(task.id); const projectId=uuid(task.projectId); assertProjectWriteAccess(effective,projectId);
  const project=await projectRow(executor,projectId); if(!project) throw new ServerPersistenceError('MUTATION_FAILED','Görev projesi bulunamadı.');
  if(task.wbsId){const wbs=await wbsRow(executor,uuid(task.wbsId)); if(!wbs||id(wbs.ProjectId)!==projectId) throw new ServerPersistenceError('MUTATION_FAILED','Görev WBS kaydı aynı projede olmalıdır.');}
  if(task.actualFinish&&!task.actualStart) throw new ServerPersistenceError('MUTATION_FAILED','Gerçek bitiş için gerçek başlangıç gereklidir.');
  if(task.isMilestone&&Number(task.plannedDurationDays||0)!==0) throw new ServerPersistenceError('MUTATION_FAILED','Kilometre taşı süresi sıfır olmalıdır.');
  await ensurePeople(executor,task.assigneeIds||[]);
  const before=await taskRow(executor,taskId); const req=request(executor);
  req.input('id',sql.UniqueIdentifier,taskId); req.input('projectId',sql.UniqueIdentifier,projectId); req.input('wbsId',sql.UniqueIdentifier,task.wbsId||null); req.input('calendarId',sql.UniqueIdentifier,task.calendarId||null);
  req.input('title',sql.NVarChar(1000),task.task||task.title); req.input('description',sql.NVarChar(sql.MAX),task.description||null); req.input('keyword',sql.NVarChar(255),task.keyword||null);
  req.input('status',sql.VarChar(30),task.status||'planned'); req.input('priority',sql.VarChar(30),task.priority||'normal'); req.input('milestone',sql.Bit,Boolean(task.isMilestone));
  req.input('plannedStart',sql.Date,date(task.plannedStart)); req.input('plannedFinish',sql.Date,date(task.plannedFinish)); req.input('plannedDuration',sql.Decimal(10,2),number(task.plannedDurationDays));
  req.input('targetFinish',sql.Date,date(task.targetFinish)); req.input('actualStart',sql.Date,date(task.actualStart)); req.input('actualFinish',sql.Date,date(task.actualFinish)); req.input('remainingDuration',sql.Decimal(10,2),number(task.remainingDurationDays));
  req.input('progress',sql.Decimal(5,2),number(task.progress)); req.input('plannedHours',sql.Decimal(12,2),number(task.plannedHours)); req.input('actualHours',sql.Decimal(12,2),number(task.actualHours));
  req.input('budget',sql.Decimal(19,4),number(task.budget)); req.input('spent',sql.Decimal(19,4),number(task.spent)); req.input('sort',sql.Int,task.sortOrder??null); req.input('actor',sql.Int,actor.sicil);
  if(!before) await req.query(`INSERT dbo.MR_Tasks(TaskId,ProjectId,WbsId,CalendarId,Title,Description,Keyword,Status,Priority,IsMilestone,PlannedStart,PlannedFinish,PlannedDurationDays,TargetFinish,ActualStart,ActualFinish,RemainingDurationDays,Progress,PlannedHours,ActualHours,Budget,Spent,SortOrder,CreatedBySicil,UpdatedBySicil)
    VALUES(@id,@projectId,@wbsId,@calendarId,@title,@description,@keyword,@status,@priority,@milestone,@plannedStart,@plannedFinish,@plannedDuration,@targetFinish,@actualStart,@actualFinish,@remainingDuration,@progress,@plannedHours,@actualHours,@budget,@spent,@sort,@actor,@actor);`);
  else {
    req.input('version',sql.Binary(8),decodeVersion(task.version));
    const updated=await req.query(`UPDATE dbo.MR_Tasks SET WbsId=@wbsId,CalendarId=@calendarId,Title=@title,Description=@description,Keyword=@keyword,Status=@status,Priority=@priority,IsMilestone=@milestone,PlannedStart=@plannedStart,PlannedFinish=@plannedFinish,PlannedDurationDays=@plannedDuration,TargetFinish=@targetFinish,ActualStart=@actualStart,ActualFinish=@actualFinish,RemainingDurationDays=@remainingDuration,Progress=@progress,PlannedHours=@plannedHours,ActualHours=@actualHours,Budget=@budget,Spent=@spent,SortOrder=@sort,UpdatedAt=SYSUTCDATETIME(),UpdatedBySicil=@actor WHERE TaskId=@id AND RowVersion=@version; SELECT @@ROWCOUNT AS Affected;`);
    if(!updated.recordset[0]?.Affected) throw new ServerPersistenceError('CONFLICT','Görev başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
  }
  const clear=request(executor); clear.input('taskId',sql.UniqueIdentifier,taskId); await clear.query('DELETE dbo.MR_TaskDependencies WHERE TaskId=@taskId; DELETE dbo.MR_TaskAssignees WHERE TaskId=@taskId;');
  for(const sicil of task.assigneeIds||[]){const a=request(executor);a.input('taskId',sql.UniqueIdentifier,taskId);a.input('sicil',sql.Int,Number(sicil));a.input('actor',sql.Int,actor.sicil);await a.query('INSERT dbo.MR_TaskAssignees(TaskId,Sicil,AssignedBySicil) VALUES(@taskId,@sicil,@actor);');}
  for(const dep of task.deps||[]){
    const predecessor=await taskRow(executor,uuid(dep.predecessorId)); if(!predecessor||id(predecessor.ProjectId)!==projectId) throw new ServerPersistenceError('MUTATION_FAILED','Bağımlılık görevleri aynı projede olmalıdır.');
    const d=request(executor);d.input('depId',sql.UniqueIdentifier,uuid(dep.id||randomUUID()));d.input('projectId',sql.UniqueIdentifier,projectId);d.input('taskId',sql.UniqueIdentifier,taskId);d.input('predId',sql.UniqueIdentifier,uuid(dep.predecessorId));d.input('type',sql.Char(2),dep.type);d.input('lagDays',sql.Decimal(10,2),Number(dep.lagDays||0));d.input('lagValue',sql.Decimal(10,2),dep.lagValue==null?null:Number(dep.lagValue));d.input('lagUnit',sql.VarChar(10),dep.lagUnit||null);d.input('actor',sql.Int,actor.sicil);
    await d.query('INSERT dbo.MR_TaskDependencies(TaskDependencyId,ProjectId,TaskId,PredecessorTaskId,DependencyType,LagDays,LagValue,LagUnit,CreatedBySicil,UpdatedBySicil) VALUES(@depId,@projectId,@taskId,@predId,@type,@lagDays,@lagValue,@lagUnit,@actor,@actor);');
  }
  await audit(executor,actor,correlationId,before?'UPDATE':'CREATE','TASK',taskId,projectId,before,task);
}

async function deleteTask(executor,actor,effective,entry,correlationId){const before=await taskRow(executor,uuid(entry.id));if(!before)return;const projectId=id(before.ProjectId);assertProjectWriteAccess(effective,projectId);const req=request(executor);req.input('id',sql.UniqueIdentifier,entry.id);req.input('version',sql.Binary(8),decodeVersion(entry.version));await req.query('DELETE dbo.MR_TaskDependencies WHERE TaskId=@id OR PredecessorTaskId=@id; DELETE dbo.MR_TaskAssignees WHERE TaskId=@id; DELETE dbo.MR_Tasks WHERE TaskId=@id AND RowVersion=@version; SELECT @@ROWCOUNT AS Affected;').then((r)=>{if(!r.recordset[0]?.Affected)throw new ServerPersistenceError('CONFLICT','Görev silinmeden önce başka bir kullanıcı tarafından değiştirildi.');});await audit(executor,actor,correlationId,'DELETE','TASK',entry.id,projectId,before,null);}
async function deleteWbs(executor,actor,effective,entry,correlationId){const before=await wbsRow(executor,uuid(entry.id));if(!before)return;const projectId=id(before.ProjectId);assertProjectWriteAccess(effective,projectId);const child=request(executor);child.input('id',sql.UniqueIdentifier,entry.id);const refs=await child.query('SELECT TOP(1) 1 AS Found FROM dbo.MR_WBS WHERE ParentWbsId=@id UNION ALL SELECT TOP(1) 1 FROM dbo.MR_Tasks WHERE WbsId=@id;');if(refs.recordset.length)throw new ServerPersistenceError('MUTATION_FAILED','Alt WBS veya görev içeren WBS silinemez.');const req=request(executor);req.input('id',sql.UniqueIdentifier,entry.id);req.input('version',sql.Binary(8),decodeVersion(entry.version));const result=await req.query('DELETE dbo.MR_WBS WHERE WbsId=@id AND RowVersion=@version; SELECT @@ROWCOUNT AS Affected;');if(!result.recordset[0]?.Affected)throw new ServerPersistenceError('CONFLICT','WBS silinmeden önce değiştirildi.');await audit(executor,actor,correlationId,'DELETE','WBS',entry.id,projectId,before,null);}

export function createSqlAppRepository() {
  return {
    kind:'sql-server',
    async loadSessionContext(){const auth=await loadAuthorizationContext();return{dataMode:'actual',currentUser:auth.currentUser,isSystemAdmin:auth.isSystemAdmin,isExecutive:auth.isExecutive,canCreateProjects:auth.canCreateProjects,projectAccess:[...auth.effective.access.values()]};},
    async loadSnapshot(){const pool=await getSqlPool();const auth=await loadAuthorizationContext(pool);if(auth.isSystemAdmin)await withSqlTransaction(async(transaction)=>synchronizeCorporateProjects(transaction,auth.sicil));return loadSnapshotFrom(pool,auth);},
    async commitChanges(input){const changes=normalizeChanges(input);return withSqlTransaction(async(transaction)=>{const actor=await loadAuthorizationContext(transaction);const correlationId=randomUUID();
      for(const project of changes.projectUpserts)await commitProject(transaction,actor,actor.effective,project,correlationId);
      for(const node of changes.wbsUpserts)await commitWbs(transaction,actor,actor.effective,node,correlationId);
      for(const task of changes.taskUpserts)await commitTask(transaction,actor,actor.effective,task,correlationId);
      for(const entry of changes.taskDeletes)await deleteTask(transaction,actor,actor.effective,entry,correlationId);
      for(const entry of changes.wbsDeletes)await deleteWbs(transaction,actor,actor.effective,entry,correlationId);
      if(changes.projectDeletes.length)throw new ServerPersistenceError('FORBIDDEN','Proje silme Gerçek Sistem için desteklenmiyor; projeler pasifleştirilmelidir.');
      const snapshot=await loadSnapshotFrom(transaction,actor);
      const projectIds=new Set(changes.projectUpserts.map((value)=>value.id));const wbsIds=new Set(changes.wbsUpserts.map((value)=>value.id));const taskIds=new Set(changes.taskUpserts.map((value)=>value.id));
      return{projectUpserts:snapshot.projects.filter((value)=>projectIds.has(value.id)),projectDeletes:[],wbsUpserts:snapshot.wbs.filter((value)=>wbsIds.has(value.id)),wbsDeletes:changes.wbsDeletes.map((value)=>value.id),taskUpserts:snapshot.tasks.filter((value)=>taskIds.has(value.id)),taskDeletes:changes.taskDeletes.map((value)=>value.id)};
    });}
  };
}
