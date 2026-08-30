import 'server-only';
import { randomUUID } from 'node:crypto';
import { normalizePriorityId } from '../../domain/constants/index.js';
import { canonicalActualId, sameActualId } from '../../domain/identity/actualId.js';
import { CORPORATE_WBS_READ_ONLY_MESSAGE } from '../../domain/projectTypes.js';
import { buildSessionCurrentUser } from '../../domain/identity/sessionUser.js';
import { getTrustedSessionIdentity } from '../identity/currentUserProvider.js';
import { resolveAuthMode } from '../identity/keycloakConfig.js';
import { getSqlPool, sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { assertCanCreateManualProject, assertProjectWriteAccess, hasTaskAssignmentScope } from '../authorization/authorization.js';
import { mergeProjectTagAppearance, planProjectTagPropagation, projectTagNames } from '../../domain/tags/index.js';
import { formatRecurrenceRule } from '../../scheduling/recurrence/index.js';
import { calculatePlannedDurationDays } from '../../scheduling/plans/index.js';
import { CORPORATE_PROJECT_SYNC_SQL } from './corporateQueries.js';
import { CORPORATE_WBS_SYNC_WARMTH_SQL } from './corporateWbsQueries.js';
import { synchronizeCorporateWbs } from './corporateWbsSync.js';
import { runCorporateWbsSync } from './corporateWbsSyncSchedule.js';
import { decodeVersion, encodeVersion } from './versionTokens.js';

// SQL Server GUID değerlerini büyük harf döndürür; istemci küçük harf gönderir.
// Tüm kimlikler bu iki yardımcı üzerinden kanonikleştirilir, böylece sunucudaki
// karşılaştırmalar yalnızca harf büyüklüğü farkı nedeniyle başarısız olamaz.
function id(value) { return value == null ? null : (canonicalActualId(value) ?? String(value)); }
function isoDate(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }
function nullableNumber(value) { return value == null || value === '' ? null : Number(value); }
function request(executor) { return executor.request(); }
function uuid(value = randomUUID()) {
  const normalized = canonicalActualId(value);
  if (!normalized) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek Sistem kimlikleri geçerli UUID olmalıdır.');
  }
  return normalized;
}
function isCorporateSource(value) {
  return String(value || '').toUpperCase() === 'CORPORATE';
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
async function projectRowForUpdate(executor, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK) WHERE ProjectId = @id;')).recordset[0] || null;
}
function wbsRow(executor, value) { return rowById(executor, 'MR_WBS', 'WbsId', value); }
async function wbsRowForUpdate(executor, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = @id;')).recordset[0] || null;
}
function taskRow(executor, value) { return rowById(executor, 'MR_Tasks', 'TaskId', value); }
async function taskRowForUpdate(executor, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK) WHERE TaskId = @id;')).recordset[0] || null;
}

async function loadTaskPlanContext(executor, projectId, calendarId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('calendarId', sql.UniqueIdentifier, calendarId || null);
  const result = await req.query(`
    SELECT c.CalendarId AS PlanCalendarId, c.Name, c.TimeZone,
      wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName
    FROM dbo.MR_Projects p
    CROSS APPLY (
      SELECT COALESCE(@calendarId, p.CalendarId, (
        SELECT TOP (1) defaultCalendar.CalendarId
        FROM dbo.MR_Calendars defaultCalendar
        WHERE defaultCalendar.IsDefault = 1 AND defaultCalendar.IsActive = 1
        ORDER BY defaultCalendar.CreatedAt, defaultCalendar.CalendarId
      )) AS CalendarId
    ) effective
    JOIN dbo.MR_Calendars c ON c.CalendarId = effective.CalendarId AND c.IsActive = 1
    LEFT JOIN dbo.MR_CalendarWorkingDays wd ON wd.CalendarId = c.CalendarId
    LEFT JOIN dbo.MR_CalendarHolidays h ON h.CalendarId = c.CalendarId
    WHERE p.ProjectId = @projectId;
  `);
  const rows = result.recordset || [];
  if (!rows.length) return { projects: [], calendars: [] };
  const effectiveCalendarId = id(rows[0].PlanCalendarId);
  return {
    projects: [{ id: projectId, calendarId: effectiveCalendarId }],
    calendars: [{
      id: effectiveCalendarId,
      name: rows[0].Name,
      timezone: rows[0].TimeZone,
      workingDays: [...new Set(rows.map((row) => row.Weekday).filter((value) => value != null).map(Number))],
      holidays: [...new Map(rows.filter((row) => row.HolidayDate).map((row) => {
        const date = isoDate(row.HolidayDate);
        return [date, { date, name: row.HolidayName, short: row.ShortName || row.HolidayName }];
      })).values()]
    }]
  };
}

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
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0 || sicil > 2147483647) {
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

async function assertManualProjectCodeAvailable(executor, projectCode) {
  if (!projectCode) return;
  const req = request(executor);
  req.input('projectCode', sql.NVarChar(255), projectCode);
  const result = await req.query(`
    SELECT TOP (1) reserved.ProjectCode
    FROM (
      SELECT ProjectCode FROM dbo.MR_V_CorporateProjects
      UNION
      SELECT ProjectCode FROM dbo.MR_Projects WHERE SourceType = 'CORPORATE'
    ) reserved
    WHERE UPPER(reserved.ProjectCode) = @projectCode;
  `);
  if (result.recordset.length) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Kurumsal proje kodu manuel proje için kullanılamaz.');
  }
}

async function loadSnapshotFrom(executor, auth) {
  const req = request(executor);
  req.input('sicil', sql.Int, auth.sicil);
  req.input('isAdmin', sql.Bit, auth.isSystemAdmin);
  // Görev atama kapsamı yalnızca SEÇİLEBİLİR proje listesini genişletir; görev,
  // WBS ve kişi görünürlüğü sorguları bu bayrağa hiç bakmaz.
  req.input('canAssignAllCorporate', sql.Bit, Boolean(auth.canAssignAllCorporateProjects));
  const result = await req.query(`
    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));
    DECLARE @ReadGrantedProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY);
    DECLARE @TaskScopedWbsProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY);

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT ProjectId, 'FULL'
    FROM dbo.MR_Projects
    WHERE @isAdmin = 1 AND IsActive = 1;

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT DISTINCT p.ProjectId, 'FULL'
    FROM dbo.MR_Projects p
    JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = UPPER(p.ProjectCode)
    WHERE @isAdmin = 0 AND p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = p.ProjectId);

    INSERT @ReadGrantedProjects(ProjectId)
    SELECT pa.ProjectId
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1
      AND pa.AccessLevel = 'READ' AND p.IsActive = 1;

    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT p.ProjectId, 'FULL'
    FROM dbo.MR_Projects p
    WHERE @isAdmin = 0 AND p.SourceType = 'MANUAL' AND p.IsActive = 1 AND p.LeadSicil = @sicil
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
    WHERE @isAdmin = 0 AND p.IsActive = 1
      AND (
        t.CreatedBySicil = @sicil
        OR EXISTS (
          SELECT 1
          FROM dbo.MR_TaskAssignees ta
          WHERE ta.TaskId = t.TaskId AND (
            ta.Sicil = @sicil
            OR EXISTS (
              SELECT 1 FROM dbo.MR_V_ExecutiveScope es
              WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
            )
          )
        )
      )
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    INSERT @TaskScopedWbsProjects(ProjectId)
    SELECT DISTINCT t.ProjectId
    FROM dbo.MR_Tasks t
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId AND v.AccessLevel = 'PARTIAL'
    WHERE t.CreatedBySicil = @sicil
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_TaskAssignees ta
         WHERE ta.TaskId = t.TaskId AND ta.Sicil = @sicil
       );

    DECLARE @HasFullScope bit = CASE
      WHEN @isAdmin = 1 OR EXISTS (SELECT 1 FROM @VisibleProjects WHERE AccessLevel = 'FULL') THEN 1
      ELSE 0
    END;

    SELECT p.*, v.AccessLevel
    FROM dbo.MR_Projects p
    JOIN @VisibleProjects v ON v.ProjectId = p.ProjectId
    WHERE p.IsActive = 1
    ORDER BY p.ProjectName;

    SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder
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
       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = w.ProjectId)
       -- Kendi görevini oluşturan veya bu projede sorumlu olan kullanıcı,
       -- yeni kendi görevi için var olan WBS kataloğunu salt okunur görür.
       OR EXISTS (SELECT 1 FROM @TaskScopedWbsProjects scopedProject WHERE scopedProject.ProjectId = w.ProjectId)
       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code
    OPTION (MAXRECURSION 1000);

    -- Sorumlu SAYISI da döner. PARTIAL anlık görüntü kapsam dışı bir eş
    -- sorumlunun satırını bilinçli olarak gizler; istemci yalnızca sayıyı
    -- karşılaştırarak "gizlenmiş sorumlu var" sonucuna varabilir ve sunucunun
    -- reddedeceği bir düzenlemeyi baştan açmaz. Sayı kimlik taşımaz.
    SELECT t.*, v.AccessLevel,
      (SELECT COUNT(*) FROM dbo.MR_TaskAssignees ta WHERE ta.TaskId = t.TaskId) AS AssigneeCount,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees ownAssignment
        WHERE ownAssignment.TaskId = t.TaskId AND ownAssignment.Sicil = @sicil
      ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsCurrentUserAssignee,
      CASE WHEN t.CreatedBySicil = @sicil THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsCurrentUserCreator
    FROM dbo.MR_Tasks t
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)
       OR t.CreatedBySicil = @sicil
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
    -- Sıralama tam belirlenimlidir: aynı seriden üretilen yinelemeler başlıkta ve
    -- sıra anahtarında eşitlenebilir; kararlı bir ek anahtar olmadan SQL bunları
    -- her yüklemede farklı sırada döndürebilir ve Kanban kendiliğinden karışırdı.
    ORDER BY t.ProjectId, t.SortOrder, t.Title, t.PlannedStart, t.TaskId;

    SELECT ta.TaskId, ta.Sicil
    FROM dbo.MR_TaskAssignees ta
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)
       OR t.CreatedBySicil = @sicil
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

    SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit
    FROM dbo.MR_V_PeopleDirectory pd
    WHERE @HasFullScope = 1
       OR pd.Sicil = @sicil
       -- Görev ATAMA kapsamı açıkken yöneticinin KENDİ personeli rehberde
       -- görünür. Aksi hâlde görünür FULL projesi olmayan bir yönetici,
       -- atayabileceği çalışanı seçicide hiç bulamıyordu. Kapsam yalnızca
       -- MR_V_ExecutiveScope kadardır; görev/proje/WBS görünürlüğü değişmez.
       OR (
         @canAssignAllCorporate = 1
         AND EXISTS (
           SELECT 1 FROM dbo.MR_V_ExecutiveScope es
           WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = pd.Sicil
         )
       )
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_Projects p
         JOIN @VisibleProjects v ON v.ProjectId = p.ProjectId
         WHERE p.LeadSicil = pd.Sicil
       )
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_TaskAssignees visibleAssignee
         JOIN dbo.MR_Tasks visibleTask ON visibleTask.TaskId = visibleAssignee.TaskId
         JOIN @VisibleProjects visibleProject ON visibleProject.ProjectId = visibleTask.ProjectId
         WHERE visibleAssignee.Sicil = pd.Sicil
            AND (
              EXISTS (
                SELECT 1 FROM @ReadGrantedProjects readProject
                WHERE readProject.ProjectId = visibleTask.ProjectId
              )
              OR visibleAssignee.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibleAssignee.Sicil
              )
            )
        )
    ORDER BY pd.DisplayName, pd.Sicil;

    -- Görev ATAMA kapsamı: yöneticiler (direktör/müdür/birim yöneticisi) kendi
    -- personeline HERHANGİ bir etkin CN43N projesi altında görev tanımlayabilir.
    -- Bu liste yalnızca görev tanımlarken kullanılan proje SEÇİCİSİNİ besler;
    -- görünür projeler, görevler, WBS ve kişiler kümesine hiçbir şey eklemez.
    -- Kök düğüm kimliği de döner: yeni görev, projenin kök dağılım düğümüne
    -- bağlanır ve istemci bu proje için ağacın tamamını görmez.
    -- Proje takvimi de döner: görev, proje görünür olmadan önce takvimini bu
    -- kayıttan çözer ve CalendarId olmadan genel varsayılana düşerek çalışma
    -- günü hesaplarını yanlış takvimle yapardı.
    SELECT p.ProjectId, p.ProjectCode, p.ProjectName, p.ProjectTypeCode, p.ProjectTypeName,
           p.ColorToken, p.CalendarId, root.WbsId AS RootWbsId
    FROM dbo.MR_Projects p
    OUTER APPLY (
      SELECT TOP (1) w.WbsId
      FROM dbo.MR_WBS w
      WHERE w.ProjectId = p.ProjectId AND w.ParentWbsId IS NULL
      ORDER BY w.SortOrder, w.Code
    ) root
    WHERE @canAssignAllCorporate = 1 AND p.SourceType = 'CORPORATE' AND p.IsActive = 1
    ORDER BY p.ProjectCode;

    -- Atama kapsamındaki ÇALIŞANLAR. Sunucu, kapsam projelerinde görevin bütün
    -- sorumlularının bu kümede olmasını şart koşar; istemci kümeyi bilmeden
    -- seçiciye bütün rehberi koyuyor ve seçilen kişi kaydı garanti reddediyordu.
    -- Küme yalnızca Sicil taşır ve kişi rehberi zaten bu kişileri içerir.
    SELECT es.EmployeeSicil
    FROM dbo.MR_V_ExecutiveScope es
    WHERE @canAssignAllCorporate = 1 AND es.ManagerSicil = @sicil
    ORDER BY es.EmployeeSicil;
  `);

  const [projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows, snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows] = result.recordsets;
  const tags = new Map();
  const assignees = new Map();
  const dependencies = new Map();
  const calendars = new Map();

  for (const row of tagRows || []) {
    const key = id(row.ProjectId);
    if (!tags.has(key)) tags.set(key, []);
    // Renk/simge boş olabilir (eski kayıtlar); alan modeli ada göre kararlı bir
    // varsayılan türetir, bu yüzden burada uydurma bir değer yazılmaz.
    tags.get(key).push({ name: row.TagName, color: row.ColorToken || null, icon: row.IconKey || null });
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
      // İKİ alan bilinçlidir. `tags` eski sözleşmedeki düz metin listesidir:
      // sürüm geçişi sırasında açık kalan eski istemci paketleri etiketi metin
      // sanar ve nesne aldığında proje ekranı çöker. `tagCatalog` renk ve
      // simgeyi taşıyan kanonik katalogdur; yeni arayüz bunu okur.
      tags: projectTagNames(tags.get(id(row.ProjectId)) || []),
      tagCatalog: tags.get(id(row.ProjectId)) || [],
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
      // Kurumsal projelerin dağılım ağacı CN43N kaynağından beslenir; arayüz bu
      // alanlara bakarak düzenleme eylemlerini kapatır ve kaynak bilgisini gösterir.
      source: String(row.SourceType || 'MANUAL').toLowerCase(),
      sourceKey: row.SourceKey || null,
      outlineCode: row.OutlineCode || null,
      level: row.WbsLevel == null ? null : Number(row.WbsLevel),
      statusCode: row.StatusCode || null,
      elementTypeCode: row.ElementTypeCode || null,
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
      priority: normalizePriorityId(row.Priority),
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
      // Tekrar kuralı yalnızca seri şablonunda dolu; yinelemeler üst göreve bağlıdır.
      recurrence: row.RecurrenceRule || null,
      recurrenceParentId: id(row.RecurrenceParentTaskId),
      recurrenceOccurrenceDate: isoDate(row.RecurrenceOccurrenceDate),
      sortOrder: row.SortOrder,
      assigneeIds: assignees.get(id(row.TaskId)) || [],
      // Yetkili sorumlu sayısı: `assigneeIds.length` ile farklıysa görevin
      // görünmeyen sorumluları vardır (bkz. yukarıdaki AssigneeCount).
      assigneeCount: Number(row.AssigneeCount ?? (assignees.get(id(row.TaskId)) || []).length),
      // Kimlikleri açığa çıkarmadan görev düzeyi yazma kararını destekler.
      // Sunucu mutasyonda üyeliği yeniden, yetkili tablodan doğrular.
      isCurrentUserAssignee: Boolean(row.IsCurrentUserAssignee),
      createdBySicil: row.CreatedBySicil == null ? null : String(row.CreatedBySicil),
      isCurrentUserCreator: Boolean(row.IsCurrentUserCreator),
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
    })),
    // Görev tanımlarken SEÇİLEBİLİR ek projeler. `projects` listesine
    // karışmazlar: çalışma alanı seçicisi, süzgeçler ve raporlar değişmez.
    assignableProjects: (assignableRows || []).map((row) => ({
      id: id(row.ProjectId),
      code: row.ProjectCode || null,
      name: row.ProjectName,
      projectTypeCode: row.ProjectTypeCode || null,
      projectTypeName: row.ProjectTypeName || null,
      color: row.ColorToken || 'blue',
      calendarId: id(row.CalendarId),
      rootWbsId: id(row.RootWbsId),
      accessLevel: 'ASSIGN'
    })),
    // Atama kapsamı projelerinde göreve atanabilecek çalışanların Sicilleri.
    assignmentScopeSicils: [...new Set((assignmentScopeRows || [])
      .map((row) => (row.EmployeeSicil == null ? '' : String(row.EmployeeSicil)))
      .filter(Boolean))]
  };
}

/**
 * Bir mutasyon yanıtı için yalnızca dokunulan satırların yetkili, kalıcı
 * görünümünü yükler. Önceki akış bütün proje portföyünü, WBS ağacını, görevleri,
 * kişileri, takvimleri ve baz planları yazma işlemi kapanmadan yeniden kuruyor;
 * tek görev güncellemesini büyük veri kümelerinde uzun süre kilit altında
 * tutuyordu.
 */
async function loadAuthoritativeMutationRows(executor, auth, { projectIds = [], wbsIds = [], taskIds = [] } = {}) {
  const req = request(executor);
  req.input('sicil', sql.Int, auth.sicil);
  req.input('isAdmin', sql.Bit, auth.isSystemAdmin);
  req.input('projectIds', sql.NVarChar(sql.MAX), projectIds.join(','));
  req.input('wbsIds', sql.NVarChar(sql.MAX), wbsIds.join(','));
  req.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  const result = await req.query(`
    SELECT p.*, CASE
      WHEN @isAdmin = 1
        OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
          WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
        )
        OR EXISTS (
          SELECT 1 FROM dbo.MR_ProjectAccess fullGrant
          WHERE fullGrant.ProjectId = p.ProjectId AND fullGrant.Sicil = @sicil
            AND fullGrant.IsActive = 1 AND fullGrant.AccessLevel = 'FULL'
        )
      THEN CAST('FULL' AS varchar(10)) ELSE CAST('PARTIAL' AS varchar(10))
    END AS AccessLevel
    FROM dbo.MR_Projects p
    JOIN STRING_SPLIT(@projectIds, ',') requested
      ON p.ProjectId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    WHERE p.IsActive = 1 AND (
      @isAdmin = 1
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = p.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
      )
      OR EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks visibleTask
        WHERE visibleTask.ProjectId = p.ProjectId AND (
          visibleTask.CreatedBySicil = @sicil
          OR EXISTS (
            SELECT 1 FROM dbo.MR_TaskAssignees visibleAssignment
            WHERE visibleAssignment.TaskId = visibleTask.TaskId AND (
              visibleAssignment.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibleAssignment.Sicil
              )
            )
          )
        )
      )
    );

    SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder
    FROM dbo.MR_ProjectTags pt
    JOIN STRING_SPLIT(@projectIds, ',') requested
      ON pt.ProjectId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    ORDER BY pt.ProjectId, pt.SortOrder, pt.TagName;

    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN dbo.MR_Projects p ON p.ProjectId = w.ProjectId AND p.IsActive = 1
    JOIN STRING_SPLIT(@wbsIds, ',') requested
      ON w.WbsId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    WHERE @isAdmin = 1
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = w.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
          AND pa.AccessLevel IN ('FULL', 'READ')
      )
      OR EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks visibleTask
        WHERE visibleTask.ProjectId = w.ProjectId AND (
          visibleTask.CreatedBySicil = @sicil
          OR EXISTS (
            SELECT 1 FROM dbo.MR_TaskAssignees visibleAssignment
            WHERE visibleAssignment.TaskId = visibleTask.TaskId AND (
              visibleAssignment.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibleAssignment.Sicil
              )
            )
          )
        )
      );

    SELECT t.*,
      (SELECT COUNT(*) FROM dbo.MR_TaskAssignees countAssignment WHERE countAssignment.TaskId = t.TaskId) AS AssigneeCount,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees ownAssignment
        WHERE ownAssignment.TaskId = t.TaskId AND ownAssignment.Sicil = @sicil
      ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsCurrentUserAssignee,
      CASE WHEN t.CreatedBySicil = @sicil THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsCurrentUserCreator
    FROM dbo.MR_Tasks t
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    JOIN STRING_SPLIT(@taskIds, ',') requested
      ON t.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    WHERE @isAdmin = 1
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR t.CreatedBySicil = @sicil
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
          AND pa.AccessLevel IN ('FULL', 'READ')
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees visibleAssignment
        WHERE visibleAssignment.TaskId = t.TaskId AND (
          visibleAssignment.Sicil = @sicil
          OR EXISTS (
            SELECT 1 FROM dbo.MR_V_ExecutiveScope es
            WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibleAssignment.Sicil
          )
        )
      );

    SELECT ta.TaskId,
      CASE WHEN auth.IdentityVisible = 1 THEN ta.Sicil ELSE NULL END AS Sicil,
      CASE
        WHEN auth.IdentityVisible = 1
          AND NULLIF(LTRIM(RTRIM(pd.DisplayName)), '') IS NOT NULL
        THEN ta.Sicil
        ELSE NULL
      END AS AvatarEmployeeNo,
      COALESCE(NULLIF(LTRIM(RTRIM(pd.DisplayName)), ''), CASE WHEN auth.IdentityVisible = 1
        THEN CONVERT(varchar(20), ta.Sicil) ELSE NULL END) AS DisplayName
    FROM dbo.MR_TaskAssignees ta
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = ta.Sicil
    CROSS APPLY (
      SELECT CAST(CASE WHEN @isAdmin = 1
        OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
          WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
        )
        OR EXISTS (
          SELECT 1 FROM dbo.MR_ProjectAccess pa
          WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
            AND pa.AccessLevel IN ('FULL', 'READ')
        )
        OR t.CreatedBySicil = @sicil
        OR ta.Sicil = @sicil
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_ExecutiveScope es
          WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
        )
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) auth
    JOIN STRING_SPLIT(@taskIds, ',') requested
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    WHERE auth.IdentityVisible = 1
      OR EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees ownAssignment
        WHERE ownAssignment.TaskId = ta.TaskId AND ownAssignment.Sicil = @sicil
      );

    SELECT d.*
    FROM dbo.MR_TaskDependencies d
    JOIN dbo.MR_Projects p ON p.ProjectId = d.ProjectId AND p.IsActive = 1
    JOIN STRING_SPLIT(@taskIds, ',') requested
      ON d.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(requested.value)))
    WHERE @isAdmin = 1
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = d.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL'
      );
  `);

  const [projectRows = [], tagRows = [], wbsRows = [], taskRows = [], assigneeRows = [], dependencyRows = []] = result.recordsets || [];
  const tags = new Map();
  const assignees = new Map();
  const assigneeDisplayNames = new Map();
  const assigneeAvatarIdentities = new Map();
  const dependencies = new Map();
  for (const row of tagRows) {
    const key = id(row.ProjectId);
    if (!tags.has(key)) tags.set(key, []);
    tags.get(key).push({ name: row.TagName, color: row.ColorToken || null, icon: row.IconKey || null });
  }
  for (const row of assigneeRows) {
    const key = id(row.TaskId);
    if (row.Sicil != null) {
      if (!assignees.has(key)) assignees.set(key, []);
      assignees.get(key).push(String(row.Sicil));
    }
    const displayName = row.DisplayName == null ? '' : String(row.DisplayName).trim();
    if (displayName) {
      if (!assigneeDisplayNames.has(key)) assigneeDisplayNames.set(key, []);
      assigneeDisplayNames.get(key).push(displayName);
    }
    const avatarEmployeeNo = row.AvatarEmployeeNo == null ? '' : String(row.AvatarEmployeeNo);
    if (displayName && avatarEmployeeNo) {
      if (!assigneeAvatarIdentities.has(key)) assigneeAvatarIdentities.set(key, []);
      assigneeAvatarIdentities.get(key).push({ name: displayName, employeeNo: avatarEmployeeNo });
    }
  }
  for (const row of dependencyRows) {
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

  return {
    projectUpserts: projectRows.map((row) => ({
      id: id(row.ProjectId),
      source: String(row.SourceType || 'MANUAL').toLowerCase(),
      code: row.ProjectCode || null,
      name: row.ProjectName,
      projectTypeCode: row.ProjectTypeCode || null,
      projectTypeName: row.ProjectTypeName || null,
      leadId: row.LeadSicil == null ? null : String(row.LeadSicil),
      dataDate: isoDate(row.DataDate),
      color: row.ColorToken || 'blue',
      calendarId: id(row.CalendarId),
      tags: projectTagNames(tags.get(id(row.ProjectId)) || []),
      tagCatalog: tags.get(id(row.ProjectId)) || [],
      version: encodeVersion(row.RowVersion),
      accessLevel: row.AccessLevel === 'FULL' ? 'FULL' : 'PARTIAL',
      schedulingCapability: row.AccessLevel === 'FULL' ? 'COMPLETE' : 'SUPPRESSED_PARTIAL'
    })),
    wbsUpserts: wbsRows.map((row) => ({
      id: id(row.WbsId), projectId: id(row.ProjectId), parentId: id(row.ParentWbsId),
      code: row.Code, name: row.Name, sortOrder: row.SortOrder,
      source: String(row.SourceType || 'MANUAL').toLowerCase(),
      sourceKey: row.SourceKey || null, outlineCode: row.OutlineCode || null,
      level: row.WbsLevel == null ? null : Number(row.WbsLevel),
      statusCode: row.StatusCode || null, elementTypeCode: row.ElementTypeCode || null,
      version: encodeVersion(row.RowVersion)
    })),
    taskUpserts: taskRows.map((row) => ({
      id: id(row.TaskId), projectId: id(row.ProjectId), wbsId: id(row.WbsId), calendarId: id(row.CalendarId),
      task: row.Title, description: row.Description || '', keyword: row.Keyword || '', status: row.Status,
      priority: normalizePriorityId(row.Priority), isMilestone: Boolean(row.IsMilestone), milestone: Boolean(row.IsMilestone),
      plannedStart: isoDate(row.PlannedStart), plannedFinish: isoDate(row.PlannedFinish),
      plannedDurationDays: nullableNumber(row.PlannedDurationDays), targetFinish: isoDate(row.TargetFinish),
      actualStart: isoDate(row.ActualStart), actualFinish: isoDate(row.ActualFinish),
      remainingDurationDays: nullableNumber(row.RemainingDurationDays), progress: nullableNumber(row.Progress),
      plannedHours: nullableNumber(row.PlannedHours), actualHours: nullableNumber(row.ActualHours),
      budget: nullableNumber(row.Budget), spent: nullableNumber(row.Spent),
      recurrence: row.RecurrenceRule || null, recurrenceParentId: id(row.RecurrenceParentTaskId),
      recurrenceOccurrenceDate: isoDate(row.RecurrenceOccurrenceDate), sortOrder: row.SortOrder,
      assigneeIds: assignees.get(id(row.TaskId)) || [],
      assigneeDisplayNames: assigneeDisplayNames.get(id(row.TaskId)) || [],
      assigneeAvatarIdentities: assigneeAvatarIdentities.get(id(row.TaskId)) || [],
      assigneeCount: Number(row.AssigneeCount ?? (assignees.get(id(row.TaskId)) || []).length),
      isCurrentUserAssignee: Boolean(row.IsCurrentUserAssignee),
      createdBySicil: row.CreatedBySicil == null ? null : String(row.CreatedBySicil),
      isCurrentUserCreator: Boolean(row.IsCurrentUserCreator),
      deps: dependencies.get(id(row.TaskId)) || [], version: encodeVersion(row.RowVersion)
    }))
  };
}

async function readProjectTags(executor, projectId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  const result = await req.query(`
    SELECT TagName, ColorToken, IconKey
    FROM dbo.MR_ProjectTags
    WHERE ProjectId = @projectId
    ORDER BY SortOrder, TagName;
  `);
  return (result.recordset || []).map((row) => ({ name: row.TagName, color: row.ColorToken, icon: row.IconKey }));
}

async function reconcileProjectTags(executor, actorSicil, projectId, values, renames = []) {
  // Saklanan görünüm ÖNCE okunur: eski istemci paketleri kataloğu düz metin
  // dizisi olarak geri gönderir ve renk/simge taşımaz. Doğrudan
  // kanonikleştirilseydi, yeni istemcinin kaydettiği özel renk ve simgeler
  // sürüm geçişi sırasında sessizce varsayılana döner, yani kalıcı veri
  // kaybolurdu.
  const stored = await readProjectTags(executor, projectId);
  const clear = request(executor);
  clear.input('projectId', sql.UniqueIdentifier, projectId);
  await clear.query('DELETE dbo.MR_ProjectTags WHERE ProjectId = @projectId;');
  // Etiket kataloğu alan modelinde kanonikleştirilir: düz metinler de kabul
  // edilir ve renk/simge anahtarları kapalı kümeye göre doğrulanır.
  const canonical = mergeProjectTagAppearance(values, stored);
  for (let index = 0; index < canonical.length; index += 1) {
    const tag = canonical[index];
    const req = request(executor);
    req.input('projectId', sql.UniqueIdentifier, projectId);
    req.input('tagName', sql.NVarChar(255), tag.name);
    req.input('colorToken', sql.VarChar(20), tag.color);
    req.input('iconKey', sql.VarChar(40), tag.icon);
    req.input('sortOrder', sql.Int, index);
    req.input('actorSicil', sql.Int, actorSicil);
    await req.query(`
      INSERT dbo.MR_ProjectTags(ProjectId, TagName, ColorToken, IconKey, SortOrder, CreatedBySicil)
      VALUES(@projectId, @tagName, @colorToken, @iconKey, @sortOrder, @actorSicil);
    `);
  }
  return planProjectTagPropagation({ storedTags: stored, nextTags: canonical, renames });
}

/**
 * Katalog değişikliğini CANLI görev satırlarına uygular.
 *
 * Yayılım istemcinin gördüğü görev kümesine bırakılamaz: görev yazmaları proje
 * satırının sürümünü ilerletmediği için, eşzamanlı bir kullanıcının aynı anda
 * oluşturduğu görev katalog dışında kalır ve kalıcı bir öksüz anahtar sözcük
 * doğardı. Katalog yazmasıyla AYNI işlemde çalışır.
 *
 * Ad eşleşmesi veritabanı harmanlamasına (collation) göre harf duyarsızdır;
 * `BIN2` karşılaştırması yalnızca zaten birebir aynı olan satırları eler,
 * böylece harf varyantları kanonik yazıma çekilirken gereksiz yazma olmaz.
 *
 * @returns {Promise<string[]>} güncellenen görev kimlikleri
 */
async function propagateProjectTagChanges(executor, actorSicil, projectId, plan = []) {
  const touched = [];
  for (const entry of plan) {
    const req = request(executor);
    req.input('projectId', sql.UniqueIdentifier, projectId);
    req.input('from', sql.NVarChar(255), entry.from);
    req.input('to', sql.NVarChar(255), entry.to);
    req.input('actorSicil', sql.Int, actorSicil);
    const result = await req.query(`
      UPDATE dbo.MR_Tasks
      SET Keyword = @to, UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
      OUTPUT inserted.TaskId
      WHERE ProjectId = @projectId
        AND Keyword = @from
        AND (@to IS NULL OR Keyword <> @to COLLATE Latin1_General_BIN2);
    `);
    for (const row of result.recordset || []) touched.push(id(row.TaskId));
  }
  return touched;
}

async function commitProject(executor, actor, project, rootWbs, correlationId) {
  const projectId = uuid(project.id);
  const projectCode = project.code == null ? null : (String(project.code).trim().toUpperCase() || null);
  const before = await projectRow(executor, projectId);
  if (!before) {
    if ((project.source || project.sourceType || 'manual').toUpperCase() !== 'MANUAL') {
      throw new ServerPersistenceError('FORBIDDEN', 'Kurumsal projeler istemci tarafından oluşturulamaz.');
    }
    assertCanCreateManualProject(actor);
    await assertManualProjectCodeAvailable(executor, projectCode);
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
    req.input('projectCode', sql.NVarChar(255), projectCode);
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
    const tagPlan = await reconcileProjectTags(executor, actor.sicil, projectId, project.tags, project.tagRenames);
    return { created: true, consumedRootId: authoritativeRoot.id, tagPlan };
  }

  assertProjectWriteAccess(actor.effective, projectId);
  if (before.SourceType === 'MANUAL') {
    await assertManualProjectCodeAvailable(executor, projectCode);
  }
  await ensurePeople(executor, project.leadId ? [project.leadId] : []);
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('version', sql.Binary(8), decodeVersion(project.version));
  req.input('projectCode', sql.NVarChar(255), projectCode);
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
        LeadSicil = CASE WHEN SourceType = 'MANUAL' THEN @leadSicil ELSE LeadSicil END,
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
  const tagPlan = await reconcileProjectTags(executor, actor.sicil, projectId, project.tags, project.tagRenames);
  await audit(executor, actor, correlationId, 'UPDATE', 'PROJECT', projectId, projectId, before, project);
  return { created: false, consumedRootId: null, tagPlan };
}

async function assertWbsProjectIsWritableStructure(executor, projectId) {
  const project = await projectRow(executor, projectId);
  if (!project) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'WBS projesi bulunamadı.');
  }
  if (isCorporateSource(project.SourceType)) {
    throw new ServerPersistenceError('FORBIDDEN', CORPORATE_WBS_READ_ONLY_MESSAGE);
  }
  return project;
}

async function commitWbs(executor, actor, node, correlationId) {
  const wbsId = uuid(node.id);
  const projectId = uuid(node.projectId);
  const before = await wbsRowForUpdate(executor, wbsId);
  if (before) {
    const storedProjectId = id(before.ProjectId);
    assertProjectWriteAccess(actor.effective, storedProjectId);
    if (!sameActualId(storedProjectId, projectId)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'WBS kaydı farklı bir projeye taşınamaz.');
    }
    if (isCorporateSource(before.SourceType)) {
      throw new ServerPersistenceError('FORBIDDEN', CORPORATE_WBS_READ_ONLY_MESSAGE);
    }
  } else {
    assertProjectWriteAccess(actor.effective, projectId);
  }
  // Kurumsal projelerin iş dağılım ağacı yalnızca CN43N eşitlemesiyle yazılır.
  await assertWbsProjectIsWritableStructure(executor, projectId);
  if (node.parentId) {
    let parent = await wbsRowForUpdate(executor, node.parentId);
    if (!parent || !sameActualId(parent.ProjectId, projectId)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Üst WBS aynı projede bulunmalıdır.');
    }
    while (parent) {
      if (sameActualId(parent.WbsId, wbsId)) {
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

function hasOwnField(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function hasSubmittedField(value, field) {
  return hasOwnField(value, field) && value[field] !== undefined;
}

/** Şablona bağlı yineleme sayısı. */
async function countRecurrenceChildren(executor, taskId) {
  const req = request(executor);
  req.input('parentId', sql.UniqueIdentifier, taskId);
  const result = await req.query(`
    SELECT COUNT_BIG(*) AS ChildCount
    FROM dbo.MR_Tasks
    WHERE RecurrenceParentTaskId = @parentId;
  `);
  return Number(result.recordset?.[0]?.ChildCount ?? 0);
}

/** Aynı seri gününde başka bir yineleme var mı? */
async function recurrenceOccurrenceExists(executor, parentId, occurrenceDate, taskId) {
  const req = request(executor);
  req.input('parentId', sql.UniqueIdentifier, parentId);
  req.input('occurrenceDate', sql.Date, occurrenceDate);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await req.query(`
    SELECT TOP (1) TaskId
    FROM dbo.MR_Tasks
    WHERE RecurrenceParentTaskId = @parentId
      AND RecurrenceOccurrenceDate = @occurrenceDate
      AND TaskId <> @taskId;
  `);
  return Boolean(result.recordset?.[0]);
}


/**
 * Görev yazması için proje erişimi.
 *
 * FULL erişim her zaman yeterlidir. Buna EK OLARAK direktör/müdür/birim
 * yöneticileri, kendilerine "corporateprojectaccess" verilmemiş olsa bile
 * herhangi bir ETKİN KURUMSAL proje altında KENDİ personeline görev
 * tanımlayabilir. Kapsam kasıtlı olarak dardır:
 *
 *  - yalnızca görev satırını kapsar; proje üst verisi, iş dağılım ağacı ve
 *    erişim kayıtları hâlâ FULL erişim ister,
 *  - manuel projeleri kapsamaz,
 *  - görevin BÜTÜN sorumluları yöneticinin `MR_V_ExecutiveScope` kapsamında
 *    olmalıdır — aksi hâlde yönetici, göremediği bir projeye kendi personeli
 *    olmayan kişiler için kayıt yazabilirdi.
 *
 * Görev GÖRÜNÜRLÜĞÜ bu kapsamdan etkilenmez: yönetici bu projelerin diğer
 * görevlerini görmez.
 */
/** Aktör bu projeye TAM yetkiyle mi yazıyor? (bağımlılık/WBS kararlarının ölçütü) */
function hasFullProjectWriteAccess(actor, projectId) {
  return Boolean(actor.isSystemAdmin) || actor.effective.access.get(projectId)?.accessLevel === 'FULL';
}

/** Proje ETKİN mi? Etkin olmayan proje bütün anlık görüntülerden dışlanır. */
async function assertActiveProject(executor, projectId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  const rows = await req.query(
    'SELECT TOP (1) ProjectId FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK) WHERE ProjectId = @projectId AND IsActive = 1;'
  );
  if (!rows.recordset.length) {
    throw new ServerPersistenceError('FORBIDDEN', 'Etkin olmayan bir projede görev yazılamaz.');
  }
}

/**
 * PROJE düzeyinde yetki: sorumlu listesine bakmadan verilebilen karar.
 *
 * Sorumlu doğrulamasından ÖNCE çağrılabilmesi için ayrılmıştır; aksi hâlde
 * yetkisiz bir kullanıcı, geçersiz ve geçerli sicillerin farklı hata üretmesini
 * kullanarak kurumsal rehberi yoklayabiliyordu.
 */
const TASK_PROJECT_SCOPES = Object.freeze({
  FULL: 'FULL',
  ASSIGNMENT: 'ASSIGNMENT',
  ASSIGNEE_CREATE: 'ASSIGNEE_CREATE'
});

/**
 * Kullanıcı işlem anında bu projedeki en az bir görevin yetkili sorumlusu mu?
 *
 * Kilit ipuçları üyelik satırını commit sonuna kadar korur: sorumluluk aynı
 * anda kaldırılıyorsa oluşturma eski bir istemci snapshot'ına dayanarak aradan
 * geçemez. Sorgu yalnızca task/create yolunda çağrılır.
 */
async function hasAuthoritativeAssigneeTaskCreateScope(executor, actor, projectId) {
  const scopeCheck = request(executor);
  scopeCheck.input('projectId', sql.UniqueIdentifier, projectId);
  scopeCheck.input('sicil', sql.Int, actor.sicil);
  const result = await scopeCheck.query(`
    SELECT TOP (1) ta.TaskId
    FROM dbo.MR_TaskAssignees ta WITH (UPDLOCK, HOLDLOCK)
    JOIN dbo.MR_Tasks t WITH (HOLDLOCK) ON t.TaskId = ta.TaskId
    JOIN dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK)
      ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    WHERE t.ProjectId = @projectId AND ta.Sicil = @sicil;
  `);
  return result.recordset.length > 0;
}

async function assertTaskProjectScope(executor, actor, projectId, { allowAssigneeCreate = false } = {}) {
  // Sistem yöneticisi kullanıcı bazlı yetkileri atlar ama ETKİN OLMAYAN projeye
  // yazamaz: etkin FULL yetkileri de yalnızca etkin projelerden kurulur ve
  // taşınan görev normal anlık görüntülerden tümüyle kaybolurdu.
  if (actor.isSystemAdmin) {
    await assertActiveProject(executor, projectId);
    return TASK_PROJECT_SCOPES.FULL;
  }
  if (actor.effective.access.get(projectId)?.accessLevel === 'FULL') {
    await assertActiveProject(executor, projectId);
    return TASK_PROJECT_SCOPES.FULL;
  }

  if (hasTaskAssignmentScope(actor) && actor.isExecutive) {
    const projectCheck = request(executor);
    projectCheck.input('projectId', sql.UniqueIdentifier, projectId);
    const projectRows = await projectCheck.query(`
      SELECT TOP (1) ProjectId FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)
      WHERE ProjectId = @projectId AND SourceType = 'CORPORATE' AND IsActive = 1;
    `);
    if (projectRows.recordset.length) return TASK_PROJECT_SCOPES.ASSIGNMENT;
  }

  if (allowAssigneeCreate
    && await hasAuthoritativeAssigneeTaskCreateScope(executor, actor, projectId)) {
    return TASK_PROJECT_SCOPES.ASSIGNEE_CREATE;
  }

  throw new ServerPersistenceError('FORBIDDEN', 'Bu proje için tam yazma yetkiniz yok ve dar görev oluşturma kapsamınız bulunmuyor.');
}

/** SORUMLU düzeyinde yetki: her sorumlu yöneticinin kapsamında olmalıdır. */
async function assertAssigneeScope(executor, actor, projectId, assigneeSicils, projectScope = null) {
  if (hasFullProjectWriteAccess(actor, projectId)) return;

  const sicils = [...new Set((assigneeSicils || []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (projectScope === TASK_PROJECT_SCOPES.ASSIGNEE_CREATE) {
    if (sicils.length !== 1 || sicils[0] !== Number(actor.sicil)) {
      throw new ServerPersistenceError(
        'FORBIDDEN',
        'Görev sorumlusu bu dar kapsamla yalnızca kendisini yeni göreve atayabilir.'
      );
    }
    return;
  }
  if (!sicils.length) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Yetki alanınız dışındaki bir projede görev yalnızca kendi personelinize atanabilir; görevin en az bir sorumlusu olmalıdır.'
    );
  }

  const scopeCheck = request(executor);
  scopeCheck.input('managerSicil', sql.Int, actor.sicil);
  scopeCheck.input('sicils', sql.NVarChar(sql.MAX), sicils.join(','));
  const outside = await scopeCheck.query(`
    SELECT TRY_CONVERT(int, LTRIM(RTRIM(value))) AS Sicil
    FROM STRING_SPLIT(@sicils, ',')
    WHERE TRY_CONVERT(int, LTRIM(RTRIM(value))) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dbo.MR_V_ExecutiveScope es
        WHERE es.ManagerSicil = @managerSicil
          AND es.EmployeeSicil = TRY_CONVERT(int, LTRIM(RTRIM(value)))
      );
  `);
  if (outside.recordset.length) {
    const list = outside.recordset.map((row) => row.Sicil).join(', ');
    throw new ServerPersistenceError(
      'FORBIDDEN',
      `Bu projede görev yalnızca kendi personelinize atanabilir. Yetki alanınız dışındaki sicil: ${list}`
    );
  }
}

/** Proje ve sorumlu denetimlerinin bileşimi. */
async function assertTaskProjectAccess(executor, actor, projectId, assigneeSicils) {
  const projectScope = await assertTaskProjectScope(executor, actor, projectId);
  await assertAssigneeScope(executor, actor, projectId, assigneeSicils, projectScope);
}

/**
 * Projenin KÖK iş dağılım düğümü.
 *
 * Atama kapsamıyla açılan projelerde istemciye yalnızca bu düğüm bildirilir
 * (bkz. anlık görüntüdeki `assignableProjects.rootWbsId`).
 */
async function projectRootWbsId(executor, projectId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  const result = await req.query(`
    SELECT TOP (1) WbsId FROM dbo.MR_WBS
    WHERE ProjectId = @projectId AND ParentWbsId IS NULL
    ORDER BY SortOrder, Code;
  `);
  return id(result.recordset?.[0]?.WbsId) || null;
}

/**
 * Silme, KAPSAM DIŞI görevlere de yazar mı?
 *
 * Görev silinirken yinelemeleri ayrılır ve ardıl bağımlılıkları temizlenir.
 * Bu ilişkili görevler görünmez ve yöneticinin kapsamı dışında olabilir; tam
 * yetkisi olmayan bir aktör için silme o satırlara dokunmamalıdır.
 */
async function hasRelatedTasksOutsideScope(executor, actor, taskId) {
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('managerSicil', sql.Int, actor.sicil);
  const result = await req.query(`
    SELECT TOP (1) related.TaskId
    FROM (
      SELECT TaskId FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK) WHERE RecurrenceParentTaskId = @taskId
      UNION
      SELECT TaskId FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK) WHERE PredecessorTaskId = @taskId
      UNION
      SELECT PredecessorTaskId AS TaskId
      FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)
      WHERE TaskId = @taskId
    ) related
    WHERE related.TaskId <> @taskId
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks owned
        WHERE owned.TaskId = related.TaskId
          AND owned.CreatedBySicil = @managerSicil
      )
      AND (
        NOT EXISTS (SELECT 1 FROM dbo.MR_TaskAssignees ta WITH (UPDLOCK, HOLDLOCK) WHERE ta.TaskId = related.TaskId)
        OR EXISTS (
          SELECT 1 FROM dbo.MR_TaskAssignees ta WITH (UPDLOCK, HOLDLOCK)
          WHERE ta.TaskId = related.TaskId
            AND NOT EXISTS (
              SELECT 1 FROM dbo.MR_V_ExecutiveScope es
              WHERE es.ManagerSicil = @managerSicil AND es.EmployeeSicil = ta.Sicil
            )
        )
      );
  `);
  return Boolean(result.recordset?.length);
}

/** Görevin kalıcı sorumlu sicilleri (mevcut hâli). */
async function taskAssigneeSicils(executor, taskId) {
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await req.query('SELECT Sicil FROM dbo.MR_TaskAssignees WHERE TaskId = @taskId;');
  return (result.recordset || []).map((row) => Number(row.Sicil));
}

/** Silme boyunca görev sorumlusu aralığını kilitli tutar. */
async function taskAssigneeSicilsForUpdate(executor, taskId) {
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await req.query(`
    SELECT Sicil
    FROM dbo.MR_TaskAssignees WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId = @taskId;
  `);
  return (result.recordset || []).map((row) => Number(row.Sicil));
}

/**
 * İstemcinin aynı yetki bağlamında görebileceği kalıcı görev sorumlularını
 * döndürür. Dar sorumlu güncellemesinde gelen `assigneeIds`, eksik PARTIAL
 * görünümün yetkili listeyi değiştirmesine izin vermeden bu projeksiyonla
 * karşılaştırılır.
 */
async function visibleTaskAssigneeSicils(executor, actor, taskId) {
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('sicil', sql.Int, actor.sicil);
  req.input('isAdmin', sql.Bit, actor.isSystemAdmin);
  const result = await req.query(`
    SELECT ta.Sicil
    FROM dbo.MR_TaskAssignees ta
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    WHERE ta.TaskId = @taskId AND (
      @isAdmin = 1
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
          AND pa.AccessLevel IN ('FULL', 'READ')
      )
      OR t.CreatedBySicil = @sicil
      OR ta.Sicil = @sicil
      OR EXISTS (
        SELECT 1 FROM dbo.MR_V_ExecutiveScope es
        WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
      )
    );
  `);
  return (result.recordset || []).map((row) => Number(row.Sicil));
}

/** Sicil listelerini sıra ve tekrar farklarından bağımsız karşılaştırır. */
function sameSicilSet(left = [], right = []) {
  const a = [...new Set(left.map(Number))].sort((x, y) => x - y);
  const b = [...new Set(right.map(Number))].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameNullableId(left, right) {
  if (left == null && right == null) return true;
  return sameActualId(left, right);
}

const ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS = Object.freeze([
  ['plannedHours', 'PlannedHours'],
  ['actualHours', 'ActualHours'],
  ['budget', 'Budget'],
  ['spent', 'Spent']
]);

const CONTROLLED_SCHEDULE_FIELDS = Object.freeze([
  ['plannedStart', 'PlannedStart'],
  ['plannedFinish', 'PlannedFinish'],
  ['targetFinish', 'TargetFinish']
]);

/**
 * Sıradan görev sorumlusu görev içeriğini/ilerlemesini güncelleyebilir; proje
 * yapısını, WBS'yi, atama listesini ve tekrar/dependency modelini yönetemez.
 * Bu denetim istemci görünümüne değil kilit altında okunmuş görev satırına
 * dayanır. Böylece eksik PARTIAL anlık görüntü yetki yükseltme aracı olamaz.
 */
function assertAssigneeWorkFieldsOnly(before, task) {
  const protectedValueChange = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS.some(([field, storedField]) => (
    hasOwnField(task, field) && nullableNumber(task[field]) !== nullableNumber(before[storedField])
  ));
  const structuralChange = !sameActualId(before.ProjectId, task.projectId)
    || !sameNullableId(before.WbsId, task.wbsId)
    || Boolean(before.IsMilestone) !== Boolean(task.isMilestone || task.milestone)
    || (hasOwnField(task, 'recurrence') && (formatRecurrenceRule(task.recurrence) || null) !== (before.RecurrenceRule || null))
    || (hasOwnField(task, 'recurrenceParentId') && !sameNullableId(before.RecurrenceParentTaskId, task.recurrenceParentId))
    || (hasOwnField(task, 'recurrenceOccurrenceDate')
      && isoDate(before.RecurrenceOccurrenceDate) !== (task.recurrenceOccurrenceDate || null))
    || (task.sortOrder ?? null) !== (before.SortOrder ?? null)
    || Boolean(task.assigneeMutation)
    || (task.deps || []).length > 0;
  const scheduleChange = CONTROLLED_SCHEDULE_FIELDS.some(([field, storedField]) => (
    hasSubmittedField(task, field) && (task[field] || null) !== isoDate(before[storedField])
  ));
  if (structuralChange || protectedValueChange || scheduleChange) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev sorumlusu içerik ve ilerlemeyi düzenleyebilir; kontrollü plan tarihleri için tarih değişikliği talebi göndermelidir.'
    );
  }
}

/** Tam proje veya görev oluşturucusu olmayan kapsam plan tarihlerini doğrudan yazamaz. */
function assertControlledScheduleUnchanged(before, task) {
  const changed = CONTROLLED_SCHEDULE_FIELDS.some(([field, storedField]) => (
    hasSubmittedField(task, field) && (task[field] || null) !== isoDate(before[storedField])
  ));
  if (changed) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Kontrollü plan tarihlerini yalnızca tam proje yetkilisi veya görev oluşturucusu doğrudan değiştirebilir.'
    );
  }
}

/** Görev oluşturucusunun görev-özel hakkı WBS seçimi ve kontrollü planla sınırlıdır. */
function assertLimitedCreatorFieldsOnly(before, task) {
  const protectedValueChange = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS.some(([field, storedField]) => (
    hasOwnField(task, field) && nullableNumber(task[field]) !== nullableNumber(before[storedField])
  ));
  const forbiddenChange = !sameActualId(before.ProjectId, task.projectId)
    || Boolean(before.IsMilestone) !== Boolean(task.isMilestone || task.milestone)
    || (hasSubmittedField(task, 'actualStart') && (task.actualStart || null) !== isoDate(before.ActualStart))
    || (hasSubmittedField(task, 'actualFinish') && (task.actualFinish || null) !== isoDate(before.ActualFinish))
    || (hasOwnField(task, 'recurrence') && (formatRecurrenceRule(task.recurrence) || null) !== (before.RecurrenceRule || null))
    || (hasOwnField(task, 'recurrenceParentId') && !sameNullableId(before.RecurrenceParentTaskId, task.recurrenceParentId))
    || (hasOwnField(task, 'recurrenceOccurrenceDate')
      && isoDate(before.RecurrenceOccurrenceDate) !== (task.recurrenceOccurrenceDate || null))
    || (task.sortOrder ?? null) !== (before.SortOrder ?? null)
    || Boolean(task.assigneeMutation)
    || (task.deps || []).length > 0;
  if (forbiddenChange || protectedValueChange) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev oluşturucusu kendi görevinde tarih ve mevcut WBS seçimini yönetebilir; proje, sorumlu, tekrar, bağımlılık, saat ve finans alanlarını yönetemez.'
    );
  }
}

/** Dar sorumlu oluşturması yalnızca görev iş alanlarını başlatabilir. */
function assertAssigneeTaskCreateFieldsOnly(task) {
  const structuralValue = Boolean(task.isMilestone || task.milestone)
    || Boolean(task.recurrence)
    || Boolean(task.recurrenceParentId)
    || Boolean(task.recurrenceOccurrenceDate)
    || task.sortOrder != null
    || task.calendarId != null
    || task.plannedDurationDays != null
    || task.actualStart != null
    || task.actualFinish != null
    || task.remainingDurationDays != null
    || (task.deps || []).length > 0;
  const protectedValue = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS
    .some(([field]) => task[field] != null);
  if (structuralValue || protectedValue) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev sorumlusu yeni kendi görevinde termin ve mevcut WBS seçebilir; sorumlu, takvim, tekrar, bağımlılık, saat veya finans alanlarını yönetemez.'
    );
  }
}

async function commitTask(executor, actor, task, correlationId) {
  const taskId = uuid(task.id);
  const projectId = uuid(task.projectId);
  const before = await taskRow(executor, taskId);
  const beforeProjectId = before ? id(before.ProjectId) : null;
  const authoritativeAssigneeSicils = before ? await taskAssigneeSicils(executor, taskId) : [];
  const actorIsAssignee = authoritativeAssigneeSicils.includes(Number(actor.sicil));
  const actorIsCreator = Boolean(before) && Number(before.CreatedBySicil) === Number(actor.sicil);
  const fullProjectWrite = hasFullProjectWriteAccess(actor, projectId)
    && (!beforeProjectId || hasFullProjectWriteAccess(actor, beforeProjectId));
  // Atama listesi değişmiyorsa, kalıcı MR_TaskAssignees üyeliği dar bir görev
  // yazma hakkı verir. İstemcinin görünür `assigneeIds` alt kümesi bu kararda
  // kullanılmaz ve hiçbir zaman yetkili listeyi değiştirmez.
  const limitedCreatorWrite = Boolean(before) && actorIsCreator && !fullProjectWrite;
  const assigneeWorkOnly = Boolean(before) && actorIsAssignee && !limitedCreatorWrite
    && !fullProjectWrite && !Boolean(task.assigneeMutation);
  const narrowTaskWrite = assigneeWorkOnly || limitedCreatorWrite;

  if (narrowTaskWrite) {
    const submittedAssigneeSicils = (task.assigneeIds || []).map(Number);
    const visibleAssigneeSicils = await visibleTaskAssigneeSicils(executor, actor, taskId);
    if (!sameSicilSet(submittedAssigneeSicils, visibleAssigneeSicils)) {
      throw new ServerPersistenceError(
        'FORBIDDEN',
        'Görev sorumlusu görünür sorumlu listesini değiştiremez; sorumlu değişikliği açık atama yetkisi gerektirir.'
      );
    }
  }

  // PROJE yetkisi, sorumlu doğrulamasından ÖNCE denetlenir. `ensurePeople`
  // önce çalıştığında, erişimi olmayan bir kullanıcı bilinmeyen sicil için
  // "geçersiz çalışan", var olan sicil için FORBIDDEN alıyor ve bu farkla
  // kurumsal rehberi yoklayabiliyordu.
  let sourceProjectScope = null;
  let destinationProjectScope = null;
  if (assigneeWorkOnly) {
    await assertActiveProject(executor, beforeProjectId);
    assertAssigneeWorkFieldsOnly(before, task);
  } else if (limitedCreatorWrite) {
    await assertActiveProject(executor, beforeProjectId);
    assertLimitedCreatorFieldsOnly(before, task);
  } else {
    if (beforeProjectId) sourceProjectScope = await assertTaskProjectScope(executor, actor, beforeProjectId);
    destinationProjectScope = await assertTaskProjectScope(executor, actor, projectId, {
      allowAssigneeCreate: !before
    });
    if (before && !fullProjectWrite) assertControlledScheduleUnchanged(before, task);
  }

  // Dar sorumlu yazması ürün yüzeyinden kaldırılmış saat/finans alanlarını
  // atlayabilir; diğer güncelleme türleri tam satır değiştirme sözleşmesine
  // uyar. Yetki kontrolünden SONRA denetlenmesi kayıt varlığı sızıntısını önler.
  if (before && !narrowTaskWrite) {
    const missingField = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS
      .map(([field]) => field)
      .find((field) => !hasOwnField(task, field));
    if (missingField) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        `Güncellenen görev için ${missingField} alanı gönderilmelidir.`
      );
    }
  }

  // Sorumlular sonra doğrulanır: görev atama kapsamı, yamanın SONUÇ
  // sorumlularına bakarak karar verir.
  const assigneeSicils = narrowTaskWrite
    ? authoritativeAssigneeSicils
    : await ensurePeople(executor, task.assigneeIds || []);
  // Kaynak proje: görevin ŞU ANKİ sorumluları kapsam denetimine girer.
  if (!narrowTaskWrite && beforeProjectId) {
    await assertAssigneeScope(executor, actor, beforeProjectId, authoritativeAssigneeSicils, sourceProjectScope);
  }
  if (!narrowTaskWrite) {
    await assertAssigneeScope(executor, actor, projectId, assigneeSicils, destinationProjectScope);
    if (!before && destinationProjectScope === TASK_PROJECT_SCOPES.ASSIGNEE_CREATE) {
      assertAssigneeTaskCreateFieldsOnly(task);
    }
  }
  const assigneeCreate = !before && destinationProjectScope === TASK_PROJECT_SCOPES.ASSIGNEE_CREATE;
  if (!await projectRow(executor, projectId)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Görev projesi bulunamadı.');
  }

  // Dar görev yazmaları eksik tarih alanlarını NULL saymaz. Oluşturucu tarihi
  // değiştirirse ve sorumlu yalnızca içerik yazarsa kalıcı plan korunur.
  const plannedStart = before && narrowTaskWrite && !hasSubmittedField(task, 'plannedStart')
    ? isoDate(before.PlannedStart)
    : (task.plannedStart || null);
  const plannedFinish = before && narrowTaskWrite && !hasSubmittedField(task, 'plannedFinish')
    ? isoDate(before.PlannedFinish)
    : (task.plannedFinish || null);
  const targetFinish = before && narrowTaskWrite && !hasSubmittedField(task, 'targetFinish')
    ? isoDate(before.TargetFinish)
    : (task.targetFinish || null);
  const isMilestone = narrowTaskWrite ? Boolean(before.IsMilestone) : Boolean(task.isMilestone || task.milestone);
  const persistedCalendarId = narrowTaskWrite ? id(before.CalendarId) : (task.calendarId || null);

  // Tam yetki, bu görevde nelerin YAZILABİLECEĞİNİ belirler: atama kapsamı
  // yalnızca görev satırını kapsar, iş dağılım ağacı ve bağımlılık grafiği
  // görünürlüğü vermez.
  let wbsId = before && narrowTaskWrite && !hasSubmittedField(task, 'wbsId')
    ? id(before.WbsId)
    : (task.wbsId || null);
  if (fullProjectWrite || limitedCreatorWrite
    || assigneeCreate) {
    if (wbsId) {
      const wbs = await wbsRow(executor, wbsId);
      if (!wbs || !sameActualId(wbs.ProjectId, projectId)) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Görev WBS kaydı aynı projede olmalıdır.');
      }
    }
  } else {
    // Yönetici atama kapsamında düğüm seçemez: istemciye yalnızca projenin kök
    // düğümü açılır. Dar kendi-görev oluşturması yukarıdaki ayrı daldadır.
    const allowedWbsId = before && sameActualId(before.ProjectId, projectId)
      ? id(before.WbsId)
      : await projectRootWbsId(executor, projectId);
    if (wbsId && !sameActualId(wbsId, allowedWbsId)) {
      throw new ServerPersistenceError(
        'FORBIDDEN',
        'Görev atama kapsamında iş dağılım ağacı düğümü seçilemez; görev projenin kök düğümüne bağlanır.'
      );
    }
    wbsId = wbsId || allowedWbsId;
  }
  if (task.actualFinish && !task.actualStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek bitiş için gerçek başlangıç gereklidir.');
  }
  if (plannedStart && plannedFinish && plannedFinish < plannedStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Planlanan bitiş başlangıçtan önce olamaz.');
  }
  if (!limitedCreatorWrite && !assigneeCreate && isMilestone && Number(task.plannedDurationDays || 0) !== 0) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Kilometre taşı süresi sıfır olmalıdır.');
  }

  // ── Tekrar serisi bütünlüğü ────────────────────────────────────────────────
  // Alanlar YALNIZCA gönderildiklerinde yazılır. Sürümlü güncelleme sözleşmesi
  // `recurrence`/`recurrenceParentId` alanlarını zorunlu kılmaz; eksik değeri
  // NULL saymak, eski bir istemcinin ilgisiz bir alanı düzenlemesiyle serinin
  // kuralını silmesine ya da yinelemenin şablonundan kopmasına yol açardı.
  const recurrenceRule = hasOwnField(task, 'recurrence')
    ? (formatRecurrenceRule(task.recurrence) || null)
    : (before?.RecurrenceRule ?? null);
  const recurrenceParentId = hasOwnField(task, 'recurrenceParentId')
    ? (task.recurrenceParentId ? uuid(task.recurrenceParentId) : null)
    : (before ? id(before.RecurrenceParentTaskId) : null);
  const recurrenceOccurrenceDate = hasOwnField(task, 'recurrenceOccurrenceDate')
    ? (task.recurrenceOccurrenceDate || null)
    : (before ? isoDate(before.RecurrenceOccurrenceDate) : null);

  if (recurrenceParentId) {
    // Yabancı anahtar yalnızca kimliğin var olduğunu kanıtlar. Şablonun aynı
    // projede ve gerçekten bir şablon olduğu burada doğrulanır; aksi hâlde bir
    // proje, başka bir projedeki göreve bağlanıp onun silinmesini de bloklardı.
    if (sameActualId(recurrenceParentId, taskId)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bir görev kendi tekrar şablonu olamaz.');
    }
    const parent = await taskRow(executor, recurrenceParentId);
    if (!parent) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Tekrar şablonu bulunamadı.');
    }
    if (!sameActualId(parent.ProjectId, projectId)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Yineleme, tekrar şablonuyla aynı projede olmalıdır.');
    }
    if (parent.RecurrenceParentTaskId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Tekrar şablonu başka bir serinin yinelemesi olamaz.');
    }
    if (recurrenceOccurrenceDate && await recurrenceOccurrenceExists(executor, recurrenceParentId, recurrenceOccurrenceDate, taskId)) {
      throw new ServerPersistenceError('CONFLICT', 'Bu tekrar günü için zaten bir yineleme var. Verileri yeniden yükleyin.');
    }
    if (!fullProjectWrite && !narrowTaskWrite) {
      // Şablonun YETKİLİ sorumluları da kapsamda olmalıdır. PARTIAL anlık
      // görüntü kapsam dışı bir eş sorumluyu gizler; seri üretimi yalnızca
      // görünen astı klonlar ve bu denetim olmadan öteki sorumlu her
      // yinelemeden sessizce düşerdi.
      await assertAssigneeScope(
        executor,
        actor,
        projectId,
        await taskAssigneeSicils(executor, recurrenceParentId),
        destinationProjectScope
      );
    }
  }

  const relatedTaskIds = new Set();
  const projectChanged = before && !sameActualId(before.ProjectId, projectId);
  if (projectChanged && await countRecurrenceChildren(executor, taskId)) {
    // Şablon taşınırsa yinelemeleri eski projede kalır ve seri iki projeye
    // bölünür: yeni proje "hiç yineleme yok" görüp ikinci bir seri üretebilirdi.
    throw new ServerPersistenceError(
      'MUTATION_FAILED',
      'Yinelemeleri olan bir tekrar şablonu başka projeye taşınamaz; önce yinelemeleri kaldırın.'
    );
  }
  if (projectChanged) {
    const dependencyCleanup = request(executor);
    dependencyCleanup.input('taskId', sql.UniqueIdentifier, taskId);
    const cleanup = await dependencyCleanup.query(`
      DELETE dbo.MR_TaskDependencies
      OUTPUT deleted.TaskId AS RelatedTaskId
      WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;
    `);
    for (const row of cleanup.recordset || []) {
      if (!sameActualId(row.RelatedTaskId, taskId)) relatedTaskIds.add(id(row.RelatedTaskId));
    }
  }
  let plannedDurationDays = assigneeWorkOnly
    ? nullableNumber(before.PlannedDurationDays)
    : nullableNumber(task.plannedDurationDays);
  if (limitedCreatorWrite || assigneeCreate) {
    const planContext = await loadTaskPlanContext(executor, projectId, persistedCalendarId);
    plannedDurationDays = calculatePlannedDurationDays({
      projectId,
      calendarId: persistedCalendarId,
      plannedStart,
      plannedFinish,
      milestone: isMilestone
    }, planContext);
  }
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('wbsId', sql.UniqueIdentifier, wbsId || null);
  // Varsayılan takvim istemci projeksiyonunda görev alanına doldurulabilir.
  // Dar sorumlu yazması satırın yapısal takvim geçersiz kılmasını değiştirmez.
  req.input('calendarId', sql.UniqueIdentifier, persistedCalendarId);
  req.input('title', sql.NVarChar(1000), task.task || task.title);
  req.input('description', sql.NVarChar(sql.MAX), task.description || null);
  req.input('keyword', sql.NVarChar(255), task.keyword || null);
  req.input('status', sql.VarChar(30), task.status || 'planned');
  // Arayüz kataloğunda `normal` diye bir öncelik yoktur; varsayılan olarak
  // yazıldığında Görevler/Kanban/Raporlar sayfaları çöküyordu. Kalıcı kayıt da
  // kanonik kimliği tutar.
  req.input('priority', sql.VarChar(30), normalizePriorityId(task.priority));
  req.input('isMilestone', sql.Bit, isMilestone);
  req.input('plannedStart', sql.Date, plannedStart);
  req.input('plannedFinish', sql.Date, plannedFinish);
  req.input('plannedDuration', sql.Decimal(10, 2), plannedDurationDays);
  req.input('targetFinish', sql.Date, targetFinish);
  req.input('actualStart', sql.Date, limitedCreatorWrite ? isoDate(before.ActualStart) : (task.actualStart || null));
  req.input('actualFinish', sql.Date, limitedCreatorWrite ? isoDate(before.ActualFinish) : (task.actualFinish || null));
  req.input('remainingDuration', sql.Decimal(10, 2), nullableNumber(task.remainingDurationDays));
  req.input('progress', sql.Decimal(5, 2), nullableNumber(task.progress));
  req.input('plannedHours', sql.Decimal(12, 2), nullableNumber(narrowTaskWrite ? before.PlannedHours : task.plannedHours));
  req.input('actualHours', sql.Decimal(12, 2), nullableNumber(narrowTaskWrite ? before.ActualHours : task.actualHours));
  req.input('budget', sql.Decimal(19, 4), nullableNumber(narrowTaskWrite ? before.Budget : task.budget));
  req.input('spent', sql.Decimal(19, 4), nullableNumber(narrowTaskWrite ? before.Spent : task.spent));
  req.input('sortOrder', sql.Int, task.sortOrder ?? null);
  // Kural kanonikleştirilerek yazılır: geçersiz bir RRULE metni kalıcı kayda düşmez.
  req.input('recurrenceRule', sql.NVarChar(400), recurrenceRule);
  req.input('recurrenceParentId', sql.UniqueIdentifier, recurrenceParentId);
  // Yinelemenin DEĞİŞMEZ seri kimliği: görev ertelense bile bu tarih durur,
  // böylece aynı gün ikinci kez üretilemez (bkz. UX_MR_Tasks_RecurrenceOccurrence).
  req.input('recurrenceOccurrenceDate', sql.Date, recurrenceParentId ? recurrenceOccurrenceDate : null);
  req.input('actorSicil', sql.Int, actor.sicil);

  if (!before) {
    await req.query(`
      INSERT dbo.MR_Tasks(
        TaskId, ProjectId, WbsId, CalendarId, Title, Description, Keyword, Status, Priority,
        IsMilestone, PlannedStart, PlannedFinish, PlannedDurationDays, TargetFinish,
        ActualStart, ActualFinish, RemainingDurationDays, Progress, PlannedHours, ActualHours,
        Budget, Spent, RecurrenceRule, RecurrenceParentTaskId, RecurrenceOccurrenceDate,
        SortOrder, CreatedBySicil, UpdatedBySicil
      ) VALUES(
        @taskId, @projectId, @wbsId, @calendarId, @title, @description, @keyword, @status, @priority,
        @isMilestone, @plannedStart, @plannedFinish, @plannedDuration, @targetFinish,
        @actualStart, @actualFinish, @remainingDuration, @progress, @plannedHours, @actualHours,
        @budget, @spent, @recurrenceRule, @recurrenceParentId, @recurrenceOccurrenceDate,
        @sortOrder, @actorSicil, @actorSicil
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
          Budget = @budget, Spent = @spent,
          RecurrenceRule = @recurrenceRule, RecurrenceParentTaskId = @recurrenceParentId,
          RecurrenceOccurrenceDate = @recurrenceOccurrenceDate,
          SortOrder = @sortOrder,
          UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
      WHERE TaskId = @taskId AND RowVersion = @version;
      SELECT @@ROWCOUNT AS Affected;
    `);
    if (!updated.recordset[0]?.Affected) {
      throw new ServerPersistenceError('CONFLICT', 'Görev başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
    }
  }

  // Bağımlılık satırları YALNIZCA tam yetkili yazmada değiştirilir. PARTIAL
  // anlık görüntü `MR_TaskDependencies` yüklemez; istemci `deps: []` taşır ve
  // koşulsuz silme, yöneticinin hiç göremediği öncülleri sessizce yok ederdi.
  if (!narrowTaskWrite) {
    const clear = request(executor);
    clear.input('taskId', sql.UniqueIdentifier, taskId);
    await clear.query(fullProjectWrite
      ? `
    DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId;
    DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;
  `
      : `
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
  }

  if (!fullProjectWrite && (task.deps || []).length) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev bağımlılıkları yalnızca tam proje yetkisiyle düzenlenebilir.'
    );
  }
  for (const dependency of fullProjectWrite ? (task.deps || []) : []) {
    const predecessorId = uuid(dependency.predecessorId);
    const predecessor = await taskRow(executor, predecessorId);
    if (!predecessor || !sameActualId(predecessor.ProjectId, projectId) || sameActualId(predecessorId, taskId)) {
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
  return {
    taskId: id(taskId), projectId, beforeProjectId, wbsId: id(wbsId),
    relatedTaskIds: [...relatedTaskIds]
  };
}

async function deleteTask(executor, actor, entry, correlationId) {
  const taskId = uuid(entry.id);
  const before = await taskRowForUpdate(executor, taskId);
  if (!before) return null;
  const expectedVersion = decodeVersion(entry.version);
  const projectId = id(before.ProjectId);
  const assigneeSicils = await taskAssigneeSicilsForUpdate(executor, taskId);
  const fullProjectWrite = hasFullProjectWriteAccess(actor, projectId);
  if (fullProjectWrite) {
    await assertTaskProjectAccess(executor, actor, projectId, assigneeSicils);
  } else {
    await assertActiveProject(executor, projectId);
    if (Number(before.CreatedBySicil) !== Number(actor.sicil)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Yalnızca kendi oluşturduğunuz görevleri silebilirsiniz.');
    }
    if (assigneeSicils.some((sicil) => Number(sicil) !== Number(actor.sicil))) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bu görevde başka sorumlular bulunduğu için silemezsiniz.');
    }
  }
  // Silme yalnızca bu satırı değil, yinelemelerini ve ardıllarının bağımlılık
  // satırlarını da değiştirir. Tam yetkisi olmayan aktör için bu ilişkili
  // görevlerin de kapsam içinde olduğu doğrulanır; aksi hâlde kapsam içi bir
  // görevi silmek, hiç görülmeyen görevlere yazardı.
  if (!fullProjectWrite
    && await hasRelatedTasksOutsideScope(executor, actor, taskId)) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Bu görev, yetki alanınız dışındaki görevlerle ilişkili (yineleme ya da bağımlılık). Silme işlemi tam proje yetkisi gerektirir.'
    );
  }
  if (!before.RowVersion || Buffer.compare(Buffer.from(before.RowVersion), Buffer.from(expectedVersion)) !== 0) {
    throw new ServerPersistenceError('CONFLICT', 'Görev silinmeden önce başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
  }
  const req = request(executor);
  req.input('taskId', sql.UniqueIdentifier, taskId);
  req.input('version', sql.Binary(8), expectedVersion);
  req.input('actorSicil', sql.Int, actor.sicil);
  const result = await req.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version)
      THROW 51009, 'STALE_TASK', 1;
    DECLARE @relatedTasks TABLE(TaskId uniqueidentifier);
    -- Seri şablonu silinirken üretilmiş yinelemeler AYRILIR, silinmez: her
    -- yineleme gerçek bir görevdir ve kendi ilerlemesini taşır. Ayırma
    -- yapılmasaydı kendine başvuran yabancı anahtar silmeyi tümüyle
    -- engellerdi. Seri kimliği de temizlenir: şablonu olmayan bir yinelemenin
    -- seri günü anlamsızdır.
    UPDATE dbo.MR_Tasks
    SET RecurrenceParentTaskId = NULL,
        RecurrenceOccurrenceDate = NULL,
        UpdatedAt = SYSUTCDATETIME(),
        UpdatedBySicil = @actorSicil
    OUTPUT inserted.TaskId INTO @relatedTasks(TaskId)
    WHERE RecurrenceParentTaskId = @taskId;
    DELETE dbo.MR_TaskDependencies
    OUTPUT deleted.TaskId INTO @relatedTasks(TaskId)
    WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;
    DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;
    DELETE dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version;
    SELECT @@ROWCOUNT AS Affected;
    SELECT DISTINCT TaskId FROM @relatedTasks WHERE TaskId <> @taskId;
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
  return {
    taskId: id(taskId),
    projectId,
    relatedTaskIds: (result.recordsets?.[1] || []).map((row) => id(row.TaskId))
  };
}

async function deleteWbs(executor, actor, entry, correlationId) {
  const wbsId = uuid(entry.id);
  const before = await wbsRow(executor, wbsId);
  if (!before) return;
  const projectId = id(before.ProjectId);
  assertProjectWriteAccess(actor.effective, projectId);
  if (isCorporateSource(before.SourceType)) {
    throw new ServerPersistenceError('FORBIDDEN', CORPORATE_WBS_READ_ONLY_MESSAGE);
  }
  if (before.ParentWbsId == null) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Proje kök WBS düğümü silinemez.');
  }
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

/**
 * Yalnızca boş, MANUAL projeyi sistem yöneticisi için pasifleştirir. WBS,
 * etiketler ve denetim geçmişi fiziksel olarak korunur; etkin erişim bağışları
 * aynı işlemde kapatılır. Kurumsal/CN43N kayıtları bu yoldan asla değişmez.
 */
async function deleteProject(executor, actor, entry, correlationId) {
  const projectId = uuid(entry.id);
  if (!actor.isSystemAdmin) {
    throw new ServerPersistenceError('FORBIDDEN', 'Projeyi yalnızca sistem yöneticisi silebilir.');
  }
  const before = await projectRowForUpdate(executor, projectId);
  if (!before || !before.IsActive) return [];
  if (isCorporateSource(before.SourceType)) {
    throw new ServerPersistenceError('FORBIDDEN', 'Kurumsal/CN43N projeleri uygulamadan silinemez.');
  }

  const taskCheck = request(executor);
  taskCheck.input('projectId', sql.UniqueIdentifier, projectId);
  const taskCount = Number((await taskCheck.query(`
    SELECT COUNT_BIG(*) AS TaskCount
    FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId = @projectId;
  `)).recordset?.[0]?.TaskCount ?? 0);
  if (taskCount > 0) {
    throw new ServerPersistenceError(
      'MUTATION_FAILED',
      `Bu manuel proje ${taskCount} görev içerdiği için silinemez. Önce görevleri başka projeye taşıyın veya kaldırın.`
    );
  }

  const related = request(executor);
  related.input('projectId', sql.UniqueIdentifier, projectId);
  const wbsIds = (await related.query('SELECT WbsId FROM dbo.MR_WBS WHERE ProjectId = @projectId;')).recordset
    .map((row) => id(row.WbsId));

  const grants = request(executor);
  grants.input('projectId', sql.UniqueIdentifier, projectId);
  const revokedGrants = (await grants.query(`
    SELECT Sicil, AccessLevel, GrantSource
    FROM dbo.MR_ProjectAccess
    WHERE ProjectId = @projectId AND IsActive = 1;
  `)).recordset || [];

  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  req.input('version', sql.Binary(8), decodeVersion(entry.version));
  req.input('actorSicil', sql.Int, actor.sicil);
  const result = await req.query(`
    UPDATE dbo.MR_Projects
    SET IsActive = 0, UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
    WHERE ProjectId = @projectId AND SourceType = 'MANUAL' AND IsActive = 1 AND RowVersion = @version;
    DECLARE @affected int = @@ROWCOUNT;
    UPDATE dbo.MR_ProjectAccess
    SET IsActive = 0, UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
    WHERE @affected > 0 AND ProjectId = @projectId AND IsActive = 1;
    SELECT @affected AS Affected;
  `);
  if (!result.recordset?.[0]?.Affected) {
    throw new ServerPersistenceError('CONFLICT', 'Proje silinmeden önce başka bir kullanıcı tarafından değiştirildi. Verileri yeniden yükleyin.');
  }
  await audit(executor, actor, correlationId, 'DEACTIVATE', 'PROJECT', projectId, projectId, before, null);
  for (const grant of revokedGrants) {
    await audit(
      executor,
      actor,
      correlationId,
      'DEACTIVATE',
      'PROJECT_ACCESS',
      `${projectId}:${grant.Sicil}`,
      projectId,
      {
        projectId,
        sicil: grant.Sicil,
        accessLevel: grant.AccessLevel,
        grantSource: grant.GrantSource
      },
      null
    );
  }
  return wbsIds;
}

/**
 * Kurumsal katalog (projeler + CN43N iş dağılım ağacı) tazelenir.
 *
 * Anlık görüntü okumasından ayrı bir adımdır. Böylece 38 bin satırlık CN43N
 * birleştirmesi okuma işleminin yalıtım düzeyini ve kilitlerini paylaşmaz;
 * ayrıca tazelik penceresi sayesinde art arda gelen isteklerde hiç çalışmaz.
 * Eşitleme başarısız olsa bile anlık görüntü yüklenmeye devam eder: kurumsal
 * kaynak geçici olarak erişilemez olduğunda uygulamanın tümüyle kilitlenmesi
 * kabul edilebilir değildir.
 */
/**
 * Depodaki eşitleme durumunu okur: kurumsal ağaç zaten kurulmuşsa yeniden
 * başlatmadan sonraki ilk istek de arka planda tazeler, tam turu beklemez.
 */
async function readCorporateWbsSyncWarmth() {
  const pool = await getSqlPool();
  const row = (await pool.request().query(CORPORATE_WBS_SYNC_WARMTH_SQL)).recordset?.[0] || null;
  return { syncedAt: row?.LastSyncedAt ?? null, projectCount: Number(row?.ProjectCount ?? 0) };
}

async function refreshCorporateCatalog({ waitForColdStart = true } = {}) {
  // Yetki bağlamı bilinçli olarak pencerenin İÇİNDE yüklenir: tazelik penceresi
  // açıkken istek başına tek bir fazladan sorgu bile çalışmaz.
  return runCorporateWbsSync(async () => {
    const pool = await getSqlPool();
    const auth = await loadAuthorizationContext(pool);
    await withSqlTransaction((transaction) => synchronizeCorporateProjects(transaction, auth.sicil));
    const wbs = await synchronizeCorporateWbs(pool, auth.sicil);
    // Kurumsal WBS kaynağı yapılandırılmamışsa katalog yine de tazelenmiş
    // sayılır; aksi hâlde proje eşitlemesi her istekte yeniden çalışırdı.
    // Kaynak yapılandırılmış ama erişilemiyorsa tazelik penceresi
    // İLERLETİLMEZ: aksi hâlde geçici bir kesinti, kurumsal ağacın TTL boyunca
    // (varsayılan beş dakika) hiç denenmemesine yol açardı.
    const synchronized = Boolean(wbs.synchronized) || wbs.reason === 'NOT_CONFIGURED';
    return { synchronized, refreshed: synchronized, wbs };
  }, { readDurableSyncState: readCorporateWbsSyncWarmth, waitForColdStart });
}

/**
 * Kurumsal katalog tazelemeden yalnızca yetkili anlık görüntüyü okur ve
 * kullandığı yetki bağlamını da döndürür.
 *
 * Bağlam bilerek dışarı verilir: açılış isteği oturumu aynı yanıtta taşır ve
 * kişi/rol/proje erişimi ile görev-atama kapsamını hesaplayan (büyük veri
 * kümesinde pahalı) yetki sorgusu tek bir istekte İKİ kez çalışmaz.
 */
async function readSnapshotWithAuthorization(executor = null) {
  const connection = executor || await getSqlPool();
  const auth = await loadAuthorizationContext(connection);
  return { snapshot: await loadSnapshotFrom(connection, auth), auth };
}

/** Kurumsal katalog tazelemeden yalnızca yetkili anlık görüntüyü okur. */
async function readSnapshot() {
  return (await readSnapshotWithAuthorization()).snapshot;
}

/**
 * Hazır yetki bağlamından oturum bağlamını kurar.
 *
 * Kimlik doğrulamasından gelen GÖRÜNTÜLEME alanları (ad, e-posta, Keycloak
 * departmanı) kurumsal rehber kaydının üzerine eklenir. Yetki kararları
 * buradan DEĞİL, yalnızca Sicil üzerinden türetilmeye devam eder.
 */
async function sessionContextFrom(auth) {
  const identity = await getTrustedSessionIdentity().catch(() => null);
  return {
    dataMode: 'actual',
    authMode: resolveAuthMode(),
    authenticated: true,
    currentUser: buildSessionCurrentUser(auth.currentUser, identity),
    isSystemAdmin: auth.isSystemAdmin,
    isExecutive: auth.isExecutive,
    canCreateProjects: auth.canCreateProjects,
    // Yalnızca yetenek bildirimidir; yetki kararı sunucuda yeniden verilir.
    canAssignAllCorporateProjects: Boolean(auth.canAssignAllCorporateProjects),
    projectAccess: [...auth.effective.access.values()]
  };
}

export function createSqlAppRepository() {
  return {
    kind: 'sql-server',

    async loadSessionContext() {
      return sessionContextFrom(await loadAuthorizationContext());
    },

    refreshCorporateCatalog,
    readSnapshot,
    readSnapshotWithAuthorization,
    sessionContextFrom,

    async loadSnapshot() {
      await refreshCorporateCatalog();
      return readSnapshot();
    },

    async commitChanges(input) {
      const changes = normalizeChanges(input);
      return withSqlTransaction(async (transaction) => {
        const actor = await loadAuthorizationContext(transaction);
        const correlationId = randomUUID();
        const consumedRootIds = new Set();
        const tagPlans = [];
        const touchedTaskProjects = new Set();
        const touchedTaskWbs = new Set();
        const relatedTaskIds = new Set();

        for (const project of changes.projectUpserts) {
          const root = changes.wbsUpserts.find((node) => sameActualId(node.projectId, project.id) && node.parentId == null) || null;
          const result = await commitProject(transaction, actor, project, root, correlationId);
          if (result.consumedRootId) consumedRootIds.add(result.consumedRootId);
          if (result.tagPlan?.length) tagPlans.push({ projectId: id(project.id), plan: result.tagPlan });
        }
        for (const node of changes.wbsUpserts) {
          if (!consumedRootIds.has(id(node.id))) await commitWbs(transaction, actor, node, correlationId);
        }
        for (const task of changes.taskUpserts) {
          const touched = await commitTask(transaction, actor, task, correlationId);
          if (touched.projectId) touchedTaskProjects.add(touched.projectId);
          if (touched.beforeProjectId) touchedTaskProjects.add(touched.beforeProjectId);
          if (touched.wbsId) touchedTaskWbs.add(touched.wbsId);
          for (const relatedTaskId of touched.relatedTaskIds || []) relatedTaskIds.add(relatedTaskId);
        }
        // Etiket yayılımı görev yazmalarından SONRA çalışır: aynı işlemde
        // istemcinin gönderdiği görevler kendi sürüm anahtarlarıyla kaydedilir,
        // ardından katalog dışında kalan CANLI satırlar hizalanır.
        const propagatedTaskIds = [];
        for (const entry of tagPlans) {
          propagatedTaskIds.push(...await propagateProjectTagChanges(transaction, actor.sicil, entry.projectId, entry.plan));
        }
        for (const entry of changes.taskDeletes) {
          const touched = await deleteTask(transaction, actor, entry, correlationId);
          if (touched?.projectId) touchedTaskProjects.add(touched.projectId);
          for (const relatedTaskId of touched?.relatedTaskIds || []) relatedTaskIds.add(relatedTaskId);
        }
        for (const entry of changes.wbsDeletes) await deleteWbs(transaction, actor, entry, correlationId);
        const deletedWbsIds = [];
        for (const entry of changes.projectDeletes) {
          deletedWbsIds.push(...await deleteProject(transaction, actor, entry, correlationId));
        }

        const projectIds = new Set([
          ...changes.projectUpserts.map((value) => id(value.id)),
          ...touchedTaskProjects
        ]);
        const wbsIds = new Set([
          ...changes.wbsUpserts.map((value) => id(value.id)),
          ...consumedRootIds,
          ...touchedTaskWbs
        ]);
        const taskIds = new Set([
          ...changes.taskUpserts.map((value) => id(value.id)),
          ...propagatedTaskIds,
          ...relatedTaskIds
        ]);
        const authoritative = await loadAuthoritativeMutationRows(transaction, actor, {
          projectIds: [...projectIds],
          wbsIds: [...wbsIds],
          taskIds: [...taskIds]
        });
        const invisibleChangedProjectIds = [...projectIds]
          .filter((projectId) => !authoritative.projectUpserts.some((project) => sameActualId(project.id, projectId)));
        return {
          projectUpserts: authoritative.projectUpserts,
          // Lead değişimi aktörün son FULL kaynağını kaldırmış olabilir. Geniş
          // snapshot bunu görünmez yapıyordu; hedefli yanıt da eski yetkili
          // proje nesnesini istemcide bırakmamalıdır.
          projectDeletes: [...new Set([
            ...changes.projectDeletes.map((value) => id(value.id)),
            ...invisibleChangedProjectIds
          ])],
          wbsUpserts: authoritative.wbsUpserts,
          wbsDeletes: [...new Set([...changes.wbsDeletes.map((value) => id(value.id)), ...deletedWbsIds])],
          taskUpserts: authoritative.taskUpserts,
          taskDeletes: changes.taskDeletes.map((value) => id(value.id))
        };
      });
    }
  };
}
