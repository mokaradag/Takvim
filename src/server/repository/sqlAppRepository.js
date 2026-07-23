import 'server-only';
import { randomUUID } from 'node:crypto';
import { getSqlPool, sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
import { CORPORATE_PROJECT_SYNC_SQL } from './corporateQueries.js';
import { decodeVersion, encodeVersion } from './versionTokens.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function id(value) { return value == null ? null : String(value); }
function isoDate(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }
function nullableNumber(value) { return value == null || value === '' ? null : Number(value); }
function request(executor) { return executor.request(); }
function uuid(value = randomUUID()) {
  const normalized = String(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek Sistem kimlikleri geçerli UUID olmalıdır.');
  }
  return normalized;
}
function normalizeDelete(value) {
  return typeof value === 'string' ? { id: value, version: null } : value;
}
function normalizeChanges(changes = {}) {
  return {
    projectUpserts: changes.projectUpserts || [],
    projectDeletes: (changes.projectDeletes || []).map(normalizeDelete),
    wbsUpserts: changes.wbsUpserts || [],
    wbsDeletes: (changes.wbsDeletes || []).map(normalizeDelete),
    taskUpserts: changes.taskUpserts || [],
    taskDeletes: (changes.taskDeletes || []).map(normalizeDelete)
  };
}

async function synchronizeCorporateProjects(executor, actorSicil) {
  const sync = request(executor);
  sync.input('actorSicil', sql.Int, actorSicil);
  await sync.query(CORPORATE_PROJECT_SYNC_SQL);
}

async function rowById(executor, table, column, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query(`SELECT TOP (1) * FROM dbo.${table} WHERE ${column} = @id;`)).recordset[0] || null;
}
function projectRow(executor, value) { return rowById(executor, 'MR_Projects', 'ProjectId', value); }
function wbsRow(executor, value) { return rowById(executor, 'MR_WBS', 'WbsId', value); }
async function wbsRowForUpdate(executor, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = @id;')).recordset[0] || null;
}
function taskRow(executor, value) { return rowById(executor, 'MR_Tasks', 'TaskId', value); }

async function audit(executor, actor, correlationId, actionCode, entityType, entityId, projectId, before, after) {
  const req = request(executor);
  req.input('actorSicil', sql.Int, actor.sicil);
  req.input('username', sql.NVarChar(255), actor.currentUser.username || null);
  req.input('displayName', sql.NVarChar(255), actor.currentUser.name || null);
  req.input('actionCode', sql.VarChar(50), actionCode);
  req.input('entityType', sql.VarChar(50), entityType);
  req.input('entityId', sql.NVarChar(100), String(entityId));
  req.input('projectId', sql.UniqueIdentifier, projectId || null);
  req.input('correlationId', sql.UniqueIdentifier, correlationId);
  req.input('beforeJson', sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before));
  req.input('afterJson', sql.NVarChar(sql.MAX), after == null ? null : JSON.stringify(after));
  await req.query(`
    INSERT dbo.MR_AuditLog(
      ActorSicil, ActorUsername, ActorDisplayName, ActionCode, EntityType,
      EntityId, ProjectId, CorrelationId, BeforeJson, AfterJson
    ) VALUES(
      @actorSicil, @username, @displayName, @actionCode, @entityType,
      @entityId, @projectId, @correlationId, @beforeJson, @afterJson
    );
  `);
}

function normalizeSicils(sicils) {
  const normalized = [];
  for (const value of sicils || []) {
    const text = value == null ? '' : String(value).trim();
    const sicil = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${text || value}`);
    }
    if (!normalized.includes(sicil)) normalized.push(sicil);
  }
  return normalized;
}

async function ensurePeople(executor, sicils) {
  const normalized = normalizeSicils(sicils);
  for (const sicil of normalized) {
    const req = request(executor);
    req.input('sicil', sql.Int, sicil);
    const result = await req.query('SELECT TOP (1) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil;');
    if (!result.recordset.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${sicil}`);
    }
  }
  return normalized;
}

async function loadSnapshotFrom(executor, auth) {
  const req = request(executor);
  req.input('sicil', sql.Int, auth.sicil);
  req.input('isAdmin', sql.Bit, auth.isSystemAdmin);
  const result = await req.query(`
    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT ProjectId, 'FULL'
    FROM dbo.MR_Projects
    WHERE @isAdmin = 1 AND IsActive = 1;

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT DISTINCT p.ProjectId, 'FULL'
    FROM dbo.MR_Projects p
    JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = p.ProjectCode
    WHERE @isAdmin = 0 AND p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = p.ProjectId);

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT pa.ProjectId, CASE WHEN pa.AccessLevel = 'FULL' THEN 'FULL' ELSE 'PARTIAL' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND p.IsActive = 1
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = pa.ProjectId);

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT DISTINCT t.ProjectId, 'PARTIAL'
    FROM dbo.MR_Tasks t
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
    JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = t.TaskId
    WHERE @isAdmin = 0 AND p.IsActive = 1
      AND (
        ta.Sicil = @sicil
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_ExecutiveScope es
          WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
        )
      )
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    SELECT p.*, v.AccessLevel
    FROM dbo.MR_Projects p
    JOIN @VisibleProjects v ON v.ProjectId = p.ProjectId
    WHERE p.IsActive = 1
    ORDER BY p.ProjectName;

    SELECT pt.ProjectId, pt.TagName, pt.SortOrder
    FROM dbo.MR_ProjectTags pt
    JOIN @VisibleProjects v ON v.ProjectId = pt.ProjectId
    ORDER BY pt.ProjectId, pt.SortOrder, pt.TagName;

    ;WITH RequiredPartialWbs AS (
      SELECT DISTINCT w.WbsId, w.ParentWbsId, w.ProjectId
      FROM dbo.MR_WBS w
      JOIN dbo.MR_Tasks t ON t.WbsId = w.WbsId
      JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
      WHERE v.AccessLevel = 'PARTIAL'
        AND EXISTS (
          SELECT 1
          FROM dbo.MR_TaskAssignees ta
          WHERE ta.TaskId = t.TaskId
            AND (
              ta.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
              )
            )
        )
      UNION ALL
      SELECT parent.WbsId, parent.ParentWbsId, parent.ProjectId
      FROM dbo.MR_WBS parent
      JOIN RequiredPartialWbs child ON child.ParentWbsId = parent.WbsId
      WHERE parent.ProjectId = child.ProjectId
    )
    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN @VisibleProjects v ON v.ProjectId = w.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code
    OPTION (MAXRECURSION 1000);

    SELECT t.*, v.AccessLevel
    FROM dbo.MR_Tasks t
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_TaskAssignees ta
         WHERE ta.TaskId = t.TaskId
           AND (
             ta.Sicil = @sicil
             OR EXISTS (
               SELECT 1 FROM dbo.MR_V_ExecutiveScope es
               WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
             )
           )
       )
    ORDER BY t.ProjectId, t.SortOrder, t.Title;

    SELECT ta.TaskId, ta.Sicil
    FROM dbo.MR_TaskAssignees ta
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR ta.Sicil = @sicil
       OR EXISTS (
         SELECT 1 FROM dbo.MR_V_ExecutiveScope es
         WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
       );

    SELECT d.*
    FROM dbo.MR_TaskDependencies d
    JOIN @VisibleProjects v ON v.ProjectId = d.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT b.*
    FROM dbo.MR_Baselines b
    JOIN @VisibleProjects v ON v.ProjectId = b.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT s.*
    FROM dbo.MR_TaskBaselineSnapshots s
    JOIN dbo.MR_Baselines b ON b.BaselineId = s.BaselineId
    JOIN @VisibleProjects v ON v.ProjectId = b.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT c.*, wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName
    FROM dbo.MR_Calendars c
    LEFT JOIN dbo.MR_CalendarWorkingDays wd ON wd.CalendarId = c.CalendarId
    LEFT JOIN dbo.MR_CalendarHolidays h ON h.CalendarId = c.CalendarId
    WHERE c.IsActive = 1
    ORDER BY c.Name, wd.Weekday, h.HolidayDate;

    SELECT Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit
    FROM dbo.MR_V_PeopleDirectory
    ORDER BY DisplayName, Sicil;
  `);

  const [projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows, snapshotRows, calendarRows, peopleRows] = result.recordsets;
  const tags = new Map();
  const assignees = new Map();
  const dependencies = new Map();
  const calendars = new Map();

  for (const row of tagRows || []) {
    const key = id(row.ProjectId);
    if (!tags.has(key)) tags.set(key, []);
    tags.get(key).push(row.TagName);
  }
  for (const row of assigneeRows || []) {
    const key = id(row.TaskId);
    if (!assignees.has(key)) assignees.set(key, []);
    assignees.get(key).push(String(row.Sicil));
  }
  for (const row of dependencyRows || []) {
    const key = id(row.TaskId);
    if (!dependencies.has(key)) dependencies.set(key, []);
    dependencies.get(key).push({
      id: id(row.TaskDependencyId),
      predecessorId: id(row.PredecessorTaskId),
      type: row.DependencyType,
      lagDays: Number(row.LagDays || 0),
      lagValue: row.LagValue == null ? undefined : Number(row.LagValue),
      lagUnit: row.LagUnit || undefined
    });
  }
  for (const row of calendarRows || []) {
    const key = id(row.CalendarId);
    if (!calendars.has(key)) {
      calendars.set(key, { id: key, name: row.Name, timezone: row.TimeZone, workingDays: [], holidays: [] });
    }
    const calendar = calendars.get(key);
    if (row.Weekday != null && !calendar.workingDays.includes(Number(row.Weekday))) {
      calendar.workingDays.push(Number(row.Weekday));
    }
    if (row.HolidayDate) {
      const date = isoDate(row.HolidayDate);
      if (!calendar.holidays.some((holiday) => holiday.date === date)) {
        calendar.holidays.push({ date, name: row.HolidayName, short: row.ShortName || undefined });
      }
    }
  }

  return {
    calendars: [...calendars.values()],
    projects: (projectRows || []).map((row) => ({
      id: id(row.ProjectId),
      source: row.SourceType.toLowerCase(),
      code: row.ProjectCode || null,
      name: row.ProjectName,
      projectTypeCode: row.ProjectTypeCode || null,
      projectTypeName: row.ProjectTypeName || null,
      leadId: row.LeadSicil == null ? null : String(row.LeadSicil),
      dataDate: isoDate(row.DataDate),
      color: row.ColorToken || 'blue',
      calendarId: id(row.CalendarId),
      tags: tags.get(id(row.ProjectId)) || [],
      version: encodeVersion(row.RowVersion),
      accessLevel: row.AccessLevel,
      schedulingCapability: row.AccessLevel === 'FULL' ? 'COMPLETE' : 'SUPPRESSED_PARTIAL'
    })),
    wbs: (wbsRows || []).map((row) => ({
      id: id(row.WbsId),
      projectId: id(row.ProjectId),
      parentId: id(row.ParentWbsId),
      code: row.Code,
      name: row.Name,
      sortOrder: row.SortOrder,
      version: encodeVersion(row.RowVersion)
    })),
    tasks: (taskRows || []).map((row) => ({
      id: id(row.TaskId),
      projectId: id(row.ProjectId),
      wbsId: id(row.WbsId),
      calendarId: id(row.CalendarId),
      task: row.Title,
      description: row.Description || '',
      keyword: row.Keyword || '',
      status: row.Status,
      priority: row.Priority,
      isMilestone: Boolean(row.IsMilestone),
      milestone: Boolean(row.IsMilestone),
      plannedStart: isoDate(row.PlannedStart),
      plannedFinish: isoDate(row.PlannedFinish),
      plannedDurationDays: nullableNumber(row.PlannedDurationDays),
      targetFinish: isoDate(row.TargetFinish),
      actualStart: isoDate(row.ActualStart),
      actualFinish: isoDate(row.ActualFinish),
      remainingDurationDays: nullableNumber(row.RemainingDurationDays),
      progress: nullableNumber(row.Progress),
      plannedHours: nullableNumber(row.PlannedHours),
      actualHours: nullableNumber(row.ActualHours),
      budget: nullableNumber(row.Budget),
      spent: nullableNumber(row.Spent),
      sortOrder: row.SortOrder,
      assigneeIds: assignees.get(id(row.TaskId)) || [],
      deps: dependencies.get(id(row.TaskId)) || [],
      version: encodeVersion(row.RowVersion)
    })),
    baselines: (baselineRows || []).map((row) => ({
      id: id(row.BaselineId), projectId: id(row.ProjectId), name: row.Name,
      createdAt: new Date(row.CreatedAt).toISOString(), isPrimary: Boolean(row.IsPrimary)
    })),
    taskBaselineSnapshots: (snapshotRows || []).map((row) => ({
      baselineId: id(row.BaselineId), taskId: id(row.TaskId),
      plannedStart: isoDate(row.PlannedStart), plannedFinish: isoDate(row.PlannedFinish),
      plannedDurationDays: nullableNumber(row.PlannedDurationDays), calendarId: id(row.CalendarId)
    })),
    people: (peopleRows || []).map((row) => ({
      id: String(row.Sicil), employeeNo: String(row.Sicil), name: row.DisplayName || String(row.Sicil),
      username: row.Username || null, role: row.JobTitle || '', team: row.Team || '', color: '#64748b',
      organization: {
        sector: row.Sector || null, directorate: row.Directorate || null,
        department: row.Department || null, unit: row.Unit || null
      }
    }))
  };
}

async function reconcileProjectTags(executor, actorSicil, projectId, values) {
  const clear = request(executor);
  clear.input('projectId', sql.UniqueIdentifier, projectId);
  await clear.query('DELETE dbo.MR_ProjectTags WHERE ProjectId = @projectId;');
  for (let index = 0; index < (values || []).length; index += 1) {
    const req = request(executor);
    req.input('projectId', sql.UniqueIdentifier, projectId);
    req.input('tagName', sql.NVarChar(255), values[index]);
    req.input('sortOrder', sql.Int, index);
    req.input('actorSicil', sql.Int, actorSicil);
    await req.query(`
      INSERT dbo.MR_ProjectTags(ProjectId, TagName, SortOrder, CreatedBySicil)
      VALUES(@projectId, @tagName, @sortOrder, @actorSicil);
    `);
  }
}

async function commitProject(executor, actor, project, rootWbs, correlationId) {
  const projectId = uuid(project.id);
  const before = await projectRow(executor, projectId);
  if (!before) {
    if ((project.source || project.sourceType || 'manual').toUpperCase() !== 'MANUAL') {
      throw new ServerPersistenceError('FORBIDDEN', 'Kurumsal projeler istemci tarafından oluşturulamaz.');
    }
    assertCanCreateManualProject(actor);
    await ensurePeople(executor, project.leadId ? [project.leadId] : []);
    const authoritativeRoot = {
      id: uuid(rootWbs?.id || randomUUID()),
      projectId,
      parentId: null,
      code: rootWbs?.code || '1',
      name: rootWbs?.name || project.name,
      sortOrder: rootWbs?.sortOrder ?? 1
    };
    const req = request(executor);
    req.input('projectId', sql.UniqueIdentifier, projectId);
    req.input('projectCode', sql.NVarChar(255), project.code || null);
    req.input('projectName', sql.NVarChar(1000), project.name);
    req.input('leadSicil', sql.Int, project.leadId ? Number(project.leadId) : null);
    req.input('dataDate', sql.Date, project.dataDate || null);
    req.input('colorToken', sql.VarChar(50), project.color || null);
    req.input('calendarId', sql.UniqueIdentifier, project.calendarId || null);
    req.input('rootWbsId', sql.UniqueIdentifier, authoritativeRoot.id);
    req.input('rootCode', sql.NVarChar(100), authoritativeRoot.code);
    req.input('rootName', sql.NVarChar(1000), authoritativeRoot.name);
    req.input('rootSort', sql.Int, authoritativeRoot.sortOrder);
    req.input('actorSicil', sql.Int, actor.sicil);
    await req.query(`
      INSERT dbo.MR_Projects(
        ProjectId, SourceType, ProjectCode, ProjectName, LeadSicil, DataDate,
        ColorToken, CalendarId, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @projectId, 'MANUAL', @projectCode, @projectName, @leadSicil, @dataDate,
        @colorToken, @calendarId, @actorSicil, @actorSicil
      );
      INSERT dbo.MR_WBS(
        WbsId, ProjectId, ParentWbsId, Code, Name, SortOrder, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @rootWbsId, @projectId, NULL, @rootCode, @rootName, @rootSort, @actorSicil, @actorSicil
      );
      INSERT dbo.MR_ProjectAccess(
        ProjectId, Sicil, AccessLevel, GrantSource, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @projectId, @actorSicil, 'FULL', 'OWNER', @actorSicil, @actorSicil
      );
    `);
    actor.effective.access.set(projectId, { projectId, accessLevel: 'FULL', reasons: ['MANUAL_OWNER'] });
    actor.effective.fullProjectIds.add(projectId);
    await audit(executor, actor, correlationId, 'CREATE', 'PROJECT', projectId, projectId, null, project);
    await audit(executor, actor, correlationId, 'CREATE', 'WBS', authoritativeRoot.id, projectId, null, authoritativeRoot);
    await audit(executor, actor, correlationId, 'CREATE', 'PROJECT_ACCESS', `${projectId}:${actor.sicil}`, projectId, null, {
      projectId, sicil: actor.sicil, accessLevel: 'FULL', grantSource: 'OWNER'
    });
    await reconcileProjectTags(executor, actor.sicil, projectId, project.tags);
    return { created: true, consumedRootId: authoritativeRoot.id };
  }

  assertProjectWriteAccess(actor.effective, projectId);
  await ensurePeople(executor, project.leadId ? [project.leadId] : []);
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('version', sql.Binary(8), decodeVersion(project.version));
  req.input('projectCode', sql.NVarChar(255), project.code || null);
  req.input('projectName', sql.NVarChar(1000), project.name);
  req.input('leadSicil', sql.Int, project.leadId ? Number(project.leadId) : null);
  req.input('dataDate', sql.Date, project.dataDate || null);
  req.input('colorToken', sql.VarChar(50), project.color || null);
  req.input('calendarId', sql.UniqueIdentifier, project.calendarId || null);
  req.input('actorSicil', sql.Int, actor.sicil);
  const updated = await req.query(`
    UPDATE dbo.MR_Projects
    SET ProjectName = CASE WHEN SourceType = 'MANUAL' THEN @projectName ELSE ProjectName END,
        ProjectCode = CASE WHEN SourceType = 'MANUAL' THEN @projectCode ELSE ProjectCode END,
        LeadSicil = @leadSicil,
        DataDate = @dataDate,
        ColorToken = @colorToken,
        CalendarId = @calendarId,
        UpdatedAt = SYSUTCDATETIME(),
        UpdatedBySicil = @actorSicil
    WHERE ProjectId = @projectId AND RowVersion = @version;
    SELECT @@ROWCOUNT AS Affected;
  `);
  if (!updated.recordset[0]?.Affected) {
    throw new ServerPersistenceError('CONFLICT', 'Proje başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
  }
  await reconcileProjectTags(executor, actor.sicil, projectId, project.tags);
  await audit(executor, actor, correlationId, 'UPDATE', 'PROJECT', projectId, projectId, before, project);
  return { created: false, consumedRootId: null };
}

async function commitWbs(executor, actor, node, correlationId) {
  const wbsId = uuid(node.id);
  const projectId = uuid(node.projectId);
  const before = await wbsRowForUpdate(executor, wbsId);
  if (before) {
    const storedProjectId = id(before.ProjectId);
    assertProjectWriteAccess(actor.effective, storedProjectId);
    if (storedProjectId !== projectId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'WBS kaydı farklı bir projeye taşınamaz.');
    }
  } else {
    assertProjectWriteAccess(actor.effective, projectId);
  }
  if (node.parentId) {
    let parent = await wbsRowForUpdate(executor, node.parentId);
    if (!parent || id(parent.ProjectId) !== projectId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Üst WBS aynı projede bulunmalıdır.');
    }
    while (parent) {
      if (id(parent.WbsId) === wbsId) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'WBS döngüsü oluşturulamaz.');
      }
      parent = parent.ParentWbsId ? await wbsRowForUpdate(executor, parent.ParentWbsId) : null;
    }
  }
  const req = request(executor);
  req.input('wbsId', sql.UniqueIdentifier, wbsId);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('parentWbsId', sql.UniqueIdentifier, node.parentId || null);
  req.input('code', sql.NVarChar(100), node.code);
  req.input('name', sql.NVarChar(1000), node.name);
  req.input('sortOrder', sql.Int, node.sortOrder ?? null);
  req.input('actorSicil', sql.Int, actor.sicil);
  if (!before) {
    await req.query(`
      INSERT dbo.MR_WBS(WbsId, ProjectId, ParentWbsId, Code, Name, SortOrder, CreatedBySicil, UpdatedBySicil)
      VALUES(@wbsId, @projectId, @parentWbsId, @code, @name, @sortOrder, @actorSicil, @actorSicil);
    `);
  } else {
    req.input('version', sql.Binary(8), decodeVersion(node.version));
    const updated = await req.query(`
      UPDATE dbo.MR_WBS
      SET ParentWbsId = @parentWbsId, Code = @code, Name = @name, SortOrder = @sortOrder,
          UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
      WHERE WbsId = @wbsId AND RowVersion = @version;
      SELECT @@ROWCOUNT AS Affected;
    `);
    if (!updated.recordset[0]?.Affected) {
      throw new ServerPersistenceError('CONFLICT', 'WBS başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
    }
  }
  await audit(executor, actor, correlationId, before ? 'UPDATE' : 'CREATE', 'WBS', wbsId, projectId, before, node);
}

async function commitTask(executor, actor, task, correlationId) {
  const taskId = uuid(task.id);
  const projectId = uuid(task.projectId);
  const before = await taskRow(executor, taskId);
  if (before) assertProjectWriteAccess(actor.effective, id(before.ProjectId));
  assertProjectWriteAccess(actor.effective, projectId);
  if (!await projectRow(executor, projectId)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Görev projesi bulunamadı.');
  }
  if (task.wbsId) {
    const wbs = await wbsRow(executor, task.wbsId);
    if (!wbs || id(wbs.ProjectId) !== projectId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Görev WBS kaydı aynı projede olmalıdır.');
    }
  }
  if (task.actualFinish && !task.actualStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek bitiş için gerçek başlangıç gereklidir.');
  }
  if (task.plannedStart && task.plannedFinish && task.plannedFinish < task.plannedStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Planlanan bitiş başlangıçtan önce olamaz.');
  }
  if ((task.isMilestone || task.milestone) && Number(task.plannedDurationDays || 0) !== 0) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Kilometre taşı süresi sıfır olmalıdır.');
  }
  const assigneeSicils = await ensurePeople(executor, task.assigneeIds || []);
  const projectChanged = before && id(before.ProjectId) !== projectId;
  if (projectChanged) {
    const dependencyCleanup = request(executor);
    dependencyCleanup.input('taskId', sql.UniqueIdentifier, taskId);
    await dependencyCleanup.query(`
      DELETE dbo.MR_TaskDependencies
      WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;
    `);
  }
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('wbsId', sql.UniqueIdentifier, task.wbsId || null);
  req.input('calendarId', sql.UniqueIdentifier, task.calendarId || null);
  req.input('title', sql.NVarChar(1000), task.task || task.title);
  req.input('description', sql.NVarChar(sql.MAX), task.description || null);
  req.input('keyword', sql.NVarChar(255), task.keyword || null);
  req.input('status', sql.VarChar(30), task.status || 'planned');
  req.input('priority', sql.VarChar(30), task.priority || 'normal');
  req.input('isMilestone', sql.Bit, Boolean(task.isMilestone || task.milestone));
  req.input('plannedStart', sql.Date, task.plannedStart || null);
  req.input('plannedFinish', sql.Date, task.plannedFinish || null);
  req.input('plannedDuration', sql.Decimal(10, 2), nullableNumber(task.plannedDurationDays));
  req.input('targetFinish', sql.Date, task.targetFinish || null);
  req.input('actualStart', sql.Date, task.actualStart || null);
  req.input('actualFinish', sql.Date, task.actualFinish || null);
  req.input('remainingDuration', sql.Decimal(10, 2), nullableNumber(task.remainingDurationDays));
  req.input('progress', sql.Decimal(5, 2), nullableNumber(task.progress));
  req.input('plannedHours', sql.Decimal(12, 2), nullableNumber(task.plannedHours));
  req.input('actualHours', sql.Decimal(12, 2), nullableNumber(task.actualHours));
  req.input('budget', sql.Decimal(19, 4), nullableNumber(task.budget));
  req.input('spent', sql.Decimal(19, 4), nullableNumber(task.spent));
  req.input('sortOrder', sql.Int, task.sortOrder ?? null);
  req.input('actorSicil', sql.Int, actor.sicil);

  if (!before) {
    await req.query(`
      INSERT dbo.MR_Tasks(
        TaskId, ProjectId, WbsId, CalendarId, Title, Description, Keyword, Status, Priority,
        IsMilestone, PlannedStart, PlannedFinish, PlannedDurationDays, TargetFinish,
        ActualStart, ActualFinish, RemainingDurationDays, Progress, PlannedHours, ActualHours,
        Budget, Spent, SortOrder, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @taskId, @projectId, @wbsId, @calendarId, @title, @description, @keyword, @status, @priority,
        @isMilestone, @plannedStart, @plannedFinish, @plannedDuration, @targetFinish,
        @actualStart, @actualFinish, @remainingDuration, @progress, @plannedHours, @actualHours,
        @budget, @spent, @sortOrder, @actorSicil, @actorSicil
      );
    `);
  } else {
    req.input('version', sql.Binary(8), decodeVersion(task.version));
    const updated = await req.query(`
      UPDATE dbo.MR_Tasks
      SET ProjectId = @projectId, WbsId = @wbsId, CalendarId = @calendarId, Title = @title,
          Description = @description, Keyword = @keyword, Status = @status, Priority = @priority,
          IsMilestone = @isMilestone, PlannedStart = @plannedStart, PlannedFinish = @plannedFinish,
          PlannedDurationDays = @plannedDuration, TargetFinish = @targetFinish,
          ActualStart = @actualStart, ActualFinish = @actualFinish,
          RemainingDurationDays = @remainingDuration, Progress = @progress,
          PlannedHours = @plannedHours, ActualHours = @actualHours,
          Budget = @budget, Spent = @spent, SortOrder = @sortOrder,
          UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
      WHERE TaskId = @taskId AND RowVersion = @version;
      SELECT @@ROWCOUNT AS Affected;
    `);
    if (!updated.recordset[0]?.Affected) {
      throw new ServerPersistenceError('CONFLICT', 'Görev başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
    }
  }

  const clear = request(executor);
  clear.input('taskId', sql.UniqueIdentifier, taskId);
  await clear.query(`
    DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId;
    DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;
  `);

  for (const sicil of assigneeSicils) {
    const assignment = request(executor);
    assignment.input('taskId', sql.UniqueIdentifier, taskId);
    assignment.input('sicil', sql.Int, Number(sicil));
    assignment.input('actorSicil', sql.Int, actor.sicil);
    await assignment.query(`
      INSERT dbo.MR_TaskAssignees(TaskId, Sicil, AssignedBySicil)
      VALUES(@taskId, @sicil, @actorSicil);
    `);
  }

  for (const dependency of task.deps || []) {
    const predecessorId = uuid(dependency.predecessorId);
    const predecessor = await taskRow(executor, predecessorId);
    if (!predecessor || id(predecessor.ProjectId) !== projectId || predecessorId === taskId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bağımlılık görevleri aynı projede ve birbirinden farklı olmalıdır.');
    }
    const dep = request(executor);
    dep.input('dependencyId', sql.UniqueIdentifier, randomUUID());
    dep.input('projectId', sql.UniqueIdentifier, projectId);
    dep.input('taskId', sql.UniqueIdentifier, taskId);
    dep.input('predecessorId', sql.UniqueIdentifier, predecessorId);
    dep.input('type', sql.Char(2), dependency.type);
    dep.input('lagDays', sql.Decimal(10, 2), Number(dependency.lagDays || 0));
    dep.input('lagValue', sql.Decimal(10, 2), dependency.lagValue == null ? null : Number(dependency.lagValue));
    dep.input('lagUnit', sql.VarChar(10), dependency.lagUnit || null);
    dep.input('actorSicil', sql.Int, actor.sicil);
    await dep.query(`
      INSERT dbo.MR_TaskDependencies(
        TaskDependencyId, ProjectId, TaskId, PredecessorTaskId,
        DependencyType, LagDays, LagValue, LagUnit, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @dependencyId, @projectId, @taskId, @predecessorId,
        @type, @lagDays, @lagValue, @lagUnit, @actorSicil, @actorSicil
      );
    `);
  }
  await audit(executor, actor, correlationId, before ? 'UPDATE' : 'CREATE', 'TASK', taskId, projectId, before, task);
}

async function deleteTask(executor, actor, entry, correlationId) {
  const taskId = uuid(entry.id);
  const before = await taskRow(executor, taskId);
  if (!before) return;
  const projectId = id(before.ProjectId);
  assertProjectWriteAccess(actor.effective, projectId);
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('version', sql.Binary(8), decodeVersion(entry.version));
  const result = await req.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version)
      THROW 51009, 'STALE_TASK', 1;
    DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;
    DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;
    DELETE dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version;
    SELECT @@ROWCOUNT AS Affected;
  `).catch((error) => {
    if (error?.message?.includes('STALE_TASK')) {
      throw new ServerPersistenceError('CONFLICT', 'Görev silinmeden önce başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
    }
    throw error;
  });
  if (!result.recordset[0]?.Affected) {
    throw new ServerPersistenceError('CONFLICT', 'Görev silinemedi. Verileri yeniden yükleyin.');
  }
  await audit(executor, actor, correlationId, 'DELETE', 'TASK', taskId, projectId, before, null);
}

async function deleteWbs(executor, actor, entry, correlationId) {
  const wbsId = uuid(entry.id);
  const before = await wbsRow(executor, wbsId);
  if (!before) return;
  const projectId = id(before.ProjectId);
  assertProjectWriteAccess(actor.effective, projectId);
  const refs = request(executor);
  refs.input('wbsId', sql.UniqueIdentifier, wbsId);
  const referenced = await refs.query(`
    SELECT TOP (1) 1 AS Found FROM dbo.MR_WBS WHERE ParentWbsId = @wbsId
    UNION ALL
    SELECT TOP (1) 1 AS Found FROM dbo.MR_Tasks WHERE WbsId = @wbsId;
  `);
  if (referenced.recordset.length) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Alt WBS veya görev içeren WBS silinemez.');
  }
  const req = request(executor);
  req.input('wbsId', sql.UniqueIdentifier, wbsId);
  req.input('version', sql.Binary(8), decodeVersion(entry.version));
  const result = await req.query(`
    DELETE dbo.MR_WBS WHERE WbsId = @wbsId AND RowVersion = @version;
    SELECT @@ROWCOUNT AS Affected;
  `);
  if (!result.recordset[0]?.Affected) {
    throw new ServerPersistenceError('CONFLICT', 'WBS silinmeden önce başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
  }
  await audit(executor, actor, correlationId, 'DELETE', 'WBS', wbsId, projectId, before, null);
}

export function createSqlAppRepository() {
  return {
    kind: 'sql-server',

    async loadSessionContext() {
      const auth = await loadAuthorizationContext();
      return {
        dataMode: 'actual',
        currentUser: auth.currentUser,
        isSystemAdmin: auth.isSystemAdmin,
        isExecutive: auth.isExecutive,
        canCreateProjects: auth.canCreateProjects,
        projectAccess: [...auth.effective.access.values()]
      };
    },

    async loadSnapshot() {
      const pool = await getSqlPool();
      const auth = await loadAuthorizationContext(pool);
      await withSqlTransaction((transaction) => synchronizeCorporateProjects(transaction, auth.sicil));
      const refreshedAuth = await loadAuthorizationContext(pool);
      return loadSnapshotFrom(pool, refreshedAuth);
    },

    async commitChanges(input) {
      const changes = normalizeChanges(input);
      return withSqlTransaction(async (transaction) => {
        const actor = await loadAuthorizationContext(transaction);
        const correlationId = randomUUID();
        const consumedRootIds = new Set();

        for (const project of changes.projectUpserts) {
          const root = changes.wbsUpserts.find((node) => node.projectId === project.id && node.parentId == null) || null;
          const result = await commitProject(transaction, actor, project, root, correlationId);
          if (result.consumedRootId) consumedRootIds.add(result.consumedRootId);
        }
        for (const node of changes.wbsUpserts) {
          if (!consumedRootIds.has(node.id)) await commitWbs(transaction, actor, node, correlationId);
        }
        for (const task of changes.taskUpserts) await commitTask(transaction, actor, task, correlationId);
        for (const entry of changes.taskDeletes) await deleteTask(transaction, actor, entry, correlationId);
        for (const entry of changes.wbsDeletes) await deleteWbs(transaction, actor, entry, correlationId);
        if (changes.projectDeletes.length) {
          throw new ServerPersistenceError('FORBIDDEN', 'Proje silme Gerçek Sistem için desteklenmiyor; projeler pasifleştirilmelidir.');
        }

        const authoritative = await loadSnapshotFrom(transaction, actor);
        const projectIds = new Set(changes.projectUpserts.map((value) => value.id));
        const wbsIds = new Set(changes.wbsUpserts.map((value) => value.id));
        const taskIds = new Set(changes.taskUpserts.map((value) => value.id));
        return {
          projectUpserts: authoritative.projects.filter((value) => projectIds.has(value.id)),
          projectDeletes: [],
          wbsUpserts: authoritative.wbs.filter((value) => wbsIds.has(value.id)),
          wbsDeletes: changes.wbsDeletes.map((value) => value.id),
          taskUpserts: authoritative.tasks.filter((value) => taskIds.has(value.id)),
          taskDeletes: changes.taskDeletes.map((value) => value.id)
        };
      });
    }
  };
}
