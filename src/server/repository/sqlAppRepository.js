import 'server-only';
import { normalizeTaskLifecycle } from '../../domain/taskLifecycle.js';
import { businessDate } from '../../domain/calendar/businessDate.js';
import { resolveTaskCalendar } from '../../scheduling/calendars/index.js';
import { randomUUID } from 'node:crypto';
import { normalizePriorityId } from '../../domain/constants/index.js';
import { canonicalActualId, sameActualId } from '../../domain/identity/actualId.js';
import { CORPORATE_WBS_READ_ONLY_MESSAGE } from '../../domain/projectTypes.js';
import { buildSessionCurrentUser } from '../../domain/identity/sessionUser.js';
import { getTrustedSessionIdentity } from '../identity/currentUserProvider.js';
import { resolveAuthMode } from '../identity/keycloakConfig.js';
import { getSqlPool, sql, withSqlTransaction } from '../db/pool.js';
import { sqlIdentifier } from '../db/sqlIdentifier.js';
import { ServerPersistenceError } from '../errors.js';
import { observePhase, recordPhaseDuration } from '../observability/observeOperation.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { assertCanCreateManualProject, assertProjectWriteAccess, hasTaskAssignmentScope } from '../authorization/authorization.js';
import { mergeProjectTagAppearance, planProjectTagPropagation, projectTagNames } from '../../domain/tags/index.js';
import { formatRecurrenceRule, normalizeRecurrenceRule, planRecurringOccurrences } from '../../scheduling/recurrence/index.js';
import { calculatePlannedDurationDays } from '../../scheduling/plans/index.js';
import {
  enqueueOutlookProjectChange,
  enqueueOutlookProjectRefresh,
  enqueueOutlookTaskChange,
  enqueueOutlookTaskRemoval
} from '../outlook/outlookCommitHooks.js';
import { classifyAssigneeOrganizations } from '../assignment/crossOrganization.js';
import { resolveManagementChain } from '../assignment/managementChain.js';
import {
  closeOpenCoordinationsFor,
  recordCrossOrganizationAssignments
} from '../assignment/assignmentCoordinationStore.js';
import {
  aggregateAssignmentNotifications,
  assigneeSetDelta,
  isMissingNotificationSchema,
  writeAssignmentNotifications
} from '../notifications/taskNotificationStore.js';
import { enqueueTaskAssignmentMail } from '../notifications/taskMailOutbox.js';
import { CORPORATE_PROJECT_SYNC_SQL } from './corporateQueries.js';
import { CORPORATE_WBS_SYNC_WARMTH_SQL } from './corporateWbsQueries.js';
import { synchronizeCorporateWbs } from './corporateWbsSync.js';

const DEPENDENCY_PLANNING_VERIFIED = Symbol.for('mergen-rota.dependency-planning-verified');
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
  const changed = await sync.query(CORPORATE_PROJECT_SYNC_SQL);
  for (const row of changed.recordset || []) {
    await enqueueOutlookProjectRefresh(executor, row.ProjectId);
  }
}

async function rowById(executor, table, column, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  const safeTable = sqlIdentifier(table, 'table');
  const safeColumn = sqlIdentifier(column, 'column');
  return (await req.query(`SELECT TOP (1) * FROM dbo.${safeTable} WHERE ${safeColumn} = @id;`)).recordset[0] || null;
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
    OUTER APPLY (
      SELECT TOP (1) taskCalendar.CalendarId
      FROM dbo.MR_Calendars taskCalendar
      WHERE taskCalendar.CalendarId = @calendarId AND taskCalendar.IsActive = 1
    ) taskCalendar
    OUTER APPLY (
      SELECT TOP (1) projectCalendar.CalendarId
      FROM dbo.MR_Calendars projectCalendar
      WHERE projectCalendar.CalendarId = p.CalendarId AND projectCalendar.IsActive = 1
    ) projectCalendar
    OUTER APPLY (
      SELECT TOP (1) defaultCalendar.CalendarId
      FROM dbo.MR_Calendars defaultCalendar
      WHERE defaultCalendar.IsDefault = 1 AND defaultCalendar.IsActive = 1
      ORDER BY defaultCalendar.CreatedAt, defaultCalendar.CalendarId
    ) defaultCalendar
    JOIN dbo.MR_Calendars c
      ON c.CalendarId = COALESCE(taskCalendar.CalendarId, projectCalendar.CalendarId, defaultCalendar.CalendarId)
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
  if (!normalized.length) return normalized;

  const req = request(executor);
  req.input('sicils', sql.NVarChar(sql.MAX), normalized.join(','));
  const result = await req.query(`
    SELECT DISTINCT directory.Sicil
    FROM dbo.MR_V_PeopleDirectory directory
    JOIN (
      SELECT DISTINCT TRY_CONVERT(int, LTRIM(RTRIM(value))) AS Sicil
      FROM STRING_SPLIT(@sicils, ',')
    ) requested ON requested.Sicil = directory.Sicil
    WHERE requested.Sicil IS NOT NULL;
  `);
  const existing = new Set((result.recordset || []).map((row) => Number(row.Sicil)));
  const missing = normalized.find((sicil) => !existing.has(sicil));
  if (missing != null) {
    throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${missing}`);
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

/**
 * Ana anlık görüntü sorgusunun SQL İÇİ aşama adları.
 *
 * Aşamalar ARDIŞIKTIR (iç içe DEĞİL): toplamları `phase.snapshot.main-query.sql`
 * süresine yaklaşır. İç içe fazlarla (ör. `phase.snapshot.main-query`)
 * toplanmazlar.
 */
const SNAPSHOT_SQL_STAGES = Object.freeze({
  ScopeMs: 'phase.snapshot.main-query.sql.scope',
  TaskScopeMs: 'phase.snapshot.main-query.sql.task-scope',
  DirectoryMs: 'phase.snapshot.main-query.sql.directory',
  ResultSetsMs: 'phase.snapshot.main-query.sql.result-sets'
});

/** Aşama satırı yalnızca milisaniye taşır; kişi, görev ya da proje verisi yoktur. */
function recordSnapshotSqlStages(row, at) {
  if (!row) return;
  for (const [column, operation] of Object.entries(SNAPSHOT_SQL_STAGES)) {
    recordPhaseDuration(operation, row[column], { at });
  }
}

async function loadSnapshotFrom(executor, auth) {
  const req = request(executor);
  req.input('sicil', sql.Int, auth.sicil);
  req.input('isAdmin', sql.Bit, auth.isSystemAdmin);
  // Yönetim kapsamı YALNIZCA yönetici için doludur. `isExecutive`, aynı
  // SERIALIZABLE işlemde MR_V_ExecutiveScope üzerinde çalıştırılmış EXISTS
  // sonucudur: 0 olduğunda kapsam sorgusu tanım gereği boş döner ve HR02
  // taraması hiç yapılmaz. Kapsamın kendisi yine her istekte yeniden okunur.
  req.input('isExecutive', sql.Bit, Boolean(auth.isExecutive));
  // Görev atama kapsamı yalnızca SEÇİLEBİLİR proje listesini genişletir; görev,
  // WBS ve kişi görünürlüğü sorguları bu bayrağa hiç bakmaz.
  req.input('canAssignAllCorporate', sql.Bit, Boolean(auth.canAssignAllCorporateProjects));
  const sqlStartedAt = Date.now();
  const result = await observePhase('phase.snapshot.main-query.sql', () => req.query(`
    SET NOCOUNT ON;

    -- Toplu ara kümeler TABLO DEĞİŞKENİ değil GEÇİCİ TABLODUR. Tablo
    -- değişkeni için iyileştirici tek satır tahmin eder; görünür görev kümesi
    -- binlerce satıra ulaştığında bu tahmin sıralamaya çok küçük bellek
    -- ayırtıyor ve sıralama tempdb'ye taşıyordu.
    --
    -- Aşama saatleri yalnızca SÜRE taşır; hiçbir kişi/görev/proje verisi
    -- toplamaz (bkz. son sonuç kümesi).
    DECLARE @BatchStartedAt datetime2(7) = SYSUTCDATETIME();
    DECLARE @ScopeResolvedAt datetime2(7), @TaskScopeResolvedAt datetime2(7), @DirectoryResolvedAt datetime2(7);

    DROP TABLE IF EXISTS #VisibleProjects, #ReadGrantedProjects, #ExecutiveScope,
      #ScopedTasks, #OwnScopedProjects, #ScopeAssignedProjects, #VisibleTasks,
      #TaskAssigneeFacts, #RequiredPartialWbs, #DirectorySicils, #Directory;

    -- Proje yetkisi satırın KENDİSİNDE taşınır: READ hibesi ve kendi görev
    -- kapsamı ayrı geçici tablolar olarak tutulduğunda görev ve WBS seçimleri
    -- satır başına yeniden EXISTS çalıştırıyordu.
    CREATE TABLE #VisibleProjects(
      ProjectId uniqueidentifier PRIMARY KEY,
      AccessLevel varchar(10) NOT NULL,
      HasReadGrant bit NOT NULL DEFAULT (0),
      IsTaskScoped bit NOT NULL DEFAULT (0)
    );
    CREATE TABLE #ReadGrantedProjects(ProjectId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #ExecutiveScope(EmployeeSicil int PRIMARY KEY);
    CREATE TABLE #ScopedTasks(
      TaskId uniqueidentifier PRIMARY KEY,
      ProjectId uniqueidentifier NOT NULL,
      IsCreator bit NOT NULL,
      IsOwnAssignee bit NOT NULL,
      IsScopeAssignee bit NOT NULL
    );
    CREATE TABLE #OwnScopedProjects(ProjectId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #ScopeAssignedProjects(ProjectId uniqueidentifier PRIMARY KEY);
    -- Görev düzeyi yetki kararı BİR KEZ verilir; aşağıdaki bütün kümeler bu
    -- satırları okur ve MR_Tasks'i yeniden birleştirmez.
    CREATE TABLE #VisibleTasks(
      TaskId uniqueidentifier PRIMARY KEY,
      ProjectId uniqueidentifier NOT NULL,
      WbsId uniqueidentifier NULL,
      CreatedBySicil int NULL,
      AccessLevel varchar(10) NOT NULL,
      HasReadGrant bit NOT NULL,
      IsCreator bit NOT NULL,
      IsOwnAssignee bit NOT NULL,
      IsScopeAssignee bit NOT NULL,
      IdentityBase bit NOT NULL
    );
    CREATE TABLE #TaskAssigneeFacts(TaskId uniqueidentifier PRIMARY KEY, AssigneeCount int NOT NULL);
    CREATE TABLE #RequiredPartialWbs(WbsId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #DirectorySicils(Sicil int PRIMARY KEY, IsPublished bit NOT NULL);

    -- Aynı Sicil birden fazla yönetim kademesinde bulunabilir.
    IF @isExecutive = 1
      INSERT #ExecutiveScope(EmployeeSicil)
      SELECT DISTINCT EmployeeSicil
      FROM dbo.MR_V_ExecutiveScope
      WHERE ManagerSicil = @sicil;

    -- Kişisel kapsamdaki görevler TEK geçişte toplanır: oluşturan, kendi
    -- ataması ve yönetim kapsamındaki atama aynı satırda işaretlenir. Önceki
    -- biçim aynı dizin aramalarını proje kümeleri için ayrı ayrı yapıyor,
    -- görünürlük kararını ise bütün görev kümesi üzerinde yeniden türetiyordu.
    INSERT #ScopedTasks(TaskId, ProjectId, IsCreator, IsOwnAssignee, IsScopeAssignee)
    SELECT scoped.TaskId, MIN(scoped.ProjectId),
      CAST(MAX(scoped.IsCreator) AS bit),
      CAST(MAX(scoped.IsOwnAssignee) AS bit),
      CAST(MAX(scoped.IsScopeAssignee) AS bit)
    FROM (
      SELECT t.TaskId, t.ProjectId, 1 AS IsCreator, 0 AS IsOwnAssignee, 0 AS IsScopeAssignee
      FROM dbo.MR_Tasks t
      WHERE @isAdmin = 0 AND t.CreatedBySicil = @sicil
      UNION ALL
      SELECT t.TaskId, t.ProjectId, 0, 1, 0
      FROM dbo.MR_TaskAssignees ta
      JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
      WHERE ta.Sicil = @sicil
      UNION ALL
      SELECT t.TaskId, t.ProjectId, 0, 0, 1
      FROM #ExecutiveScope es
      JOIN dbo.MR_TaskAssignees ta ON ta.Sicil = es.EmployeeSicil
      JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
      WHERE @isAdmin = 0
    ) scoped
    GROUP BY scoped.TaskId;

    -- Kendi oluşturduğu ya da sorumlusu olduğu görevi bulunan projeler ile
    -- astının sorumlu olduğu projeler ayrı kümelerdir: ilki iş dağılım ağacı
    -- kataloğunu da açar, ikincisi yalnızca KISMİ görünürlük verir.
    IF @isAdmin = 0
    BEGIN
      INSERT #OwnScopedProjects(ProjectId)
      SELECT DISTINCT s.ProjectId FROM #ScopedTasks s WHERE s.IsCreator = 1 OR s.IsOwnAssignee = 1;

      INSERT #ScopeAssignedProjects(ProjectId)
      SELECT DISTINCT s.ProjectId FROM #ScopedTasks s WHERE s.IsScopeAssignee = 1;
    END

    IF @isAdmin = 1
      INSERT #VisibleProjects(ProjectId, AccessLevel)
      SELECT ProjectId, 'FULL'
      FROM dbo.MR_Projects
      WHERE IsActive = 1;
    ELSE
    BEGIN
      INSERT #VisibleProjects(ProjectId, AccessLevel)
      SELECT DISTINCT p.ProjectId, 'FULL'
      FROM dbo.MR_Projects p
      JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = UPPER(p.ProjectCode)
      WHERE p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil;

      INSERT #ReadGrantedProjects(ProjectId)
      SELECT pa.ProjectId
      FROM dbo.MR_ProjectAccess pa
      JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
      WHERE pa.Sicil = @sicil AND pa.IsActive = 1
        AND pa.AccessLevel = 'READ' AND p.IsActive = 1;

      INSERT #VisibleProjects(ProjectId, AccessLevel)
      SELECT p.ProjectId, 'FULL'
      FROM dbo.MR_Projects p
      WHERE p.SourceType = 'MANUAL' AND p.IsActive = 1 AND p.LeadSicil = @sicil
        AND NOT EXISTS (SELECT 1 FROM #VisibleProjects v WHERE v.ProjectId = p.ProjectId);

      INSERT #VisibleProjects(ProjectId, AccessLevel)
      SELECT pa.ProjectId, CASE WHEN pa.AccessLevel = 'FULL' THEN 'FULL' ELSE 'PARTIAL' END
      FROM dbo.MR_ProjectAccess pa
      JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
      WHERE pa.Sicil = @sicil AND pa.IsActive = 1 AND p.IsActive = 1
        AND NOT EXISTS (SELECT 1 FROM #VisibleProjects v WHERE v.ProjectId = pa.ProjectId);

      INSERT #VisibleProjects(ProjectId, AccessLevel)
      SELECT DISTINCT scoped.ProjectId, 'PARTIAL'
      FROM (
        SELECT own.ProjectId FROM #OwnScopedProjects own
        UNION
        SELECT team.ProjectId FROM #ScopeAssignedProjects team
      ) scoped
      JOIN dbo.MR_Projects p ON p.ProjectId = scoped.ProjectId
      WHERE p.IsActive = 1
        AND NOT EXISTS (SELECT 1 FROM #VisibleProjects v WHERE v.ProjectId = scoped.ProjectId);

      -- READ hibesi ve kendi görev kapsamı proje satırına yazılır. Kendi görevini
      -- oluşturan veya bu projede sorumlu olan kullanıcı, var olan WBS kataloğunu
      -- salt okunur görür; yönetim kapsamı bu kümeyi GENİŞLETMEZ.
      UPDATE v
      SET HasReadGrant = CASE WHEN EXISTS (
            SELECT 1 FROM #ReadGrantedProjects readProject WHERE readProject.ProjectId = v.ProjectId
          ) THEN 1 ELSE 0 END,
          IsTaskScoped = CASE WHEN v.AccessLevel = 'PARTIAL' AND EXISTS (
            SELECT 1 FROM #OwnScopedProjects own WHERE own.ProjectId = v.ProjectId
          ) THEN 1 ELSE 0 END
      FROM #VisibleProjects v;
    END

    DECLARE @HasFullScope bit = CASE
      WHEN @isAdmin = 1 OR EXISTS (SELECT 1 FROM #VisibleProjects WHERE AccessLevel = 'FULL') THEN 1
      ELSE 0
    END;
    DECLARE @HasPartialScope bit = CASE
      WHEN EXISTS (SELECT 1 FROM #VisibleProjects WHERE AccessLevel = 'PARTIAL') THEN 1
      ELSE 0
    END;

    SET @ScopeResolvedAt = SYSUTCDATETIME();

    -- FULL ve READ projelerinde görünürlük PROJE düzeyinde kesinleşir; kişisel
    -- kapsam hesabı bu görevler için görünürlük kararına hiç katılmaz.
    INSERT #VisibleTasks(TaskId, ProjectId, WbsId, CreatedBySicil, AccessLevel, HasReadGrant,
      IsCreator, IsOwnAssignee, IsScopeAssignee, IdentityBase)
    SELECT t.TaskId, t.ProjectId, t.WbsId, t.CreatedBySicil, v.AccessLevel, v.HasReadGrant,
      CASE WHEN t.CreatedBySicil = @sicil THEN 1 ELSE 0 END,
      COALESCE(scoped.IsOwnAssignee, 0), COALESCE(scoped.IsScopeAssignee, 0),
      -- FULL ya da READ projesinde oluşturan kimliği zaten açıktır.
      1
    FROM dbo.MR_Tasks t
    JOIN #VisibleProjects v ON v.ProjectId = t.ProjectId
      AND (v.AccessLevel = 'FULL' OR v.HasReadGrant = 1)
    LEFT JOIN #ScopedTasks scoped ON scoped.TaskId = t.TaskId;

    -- KISMİ projede görünür küme yalnızca kişisel kapsamdır: görev tablosu
    -- proje boyunca TARANMAZ, hazır kümeden anahtar aramasıyla okunur.
    IF @HasPartialScope = 1
      INSERT #VisibleTasks(TaskId, ProjectId, WbsId, CreatedBySicil, AccessLevel, HasReadGrant,
        IsCreator, IsOwnAssignee, IsScopeAssignee, IdentityBase)
      SELECT scoped.TaskId, scoped.ProjectId, t.WbsId, t.CreatedBySicil, v.AccessLevel, v.HasReadGrant,
        CASE WHEN t.CreatedBySicil = @sicil THEN 1 ELSE 0 END,
        scoped.IsOwnAssignee, scoped.IsScopeAssignee,
        CASE WHEN t.CreatedBySicil = @sicil THEN 1 ELSE 0 END
      FROM #ScopedTasks scoped
      JOIN #VisibleProjects v ON v.ProjectId = scoped.ProjectId
        AND v.AccessLevel = 'PARTIAL' AND v.HasReadGrant = 0
      JOIN dbo.MR_Tasks t ON t.TaskId = scoped.TaskId;

    -- Sorumlu SAYISI yalnızca GÖRÜNÜR görevler için toplanır. Önceki biçim
    -- görünür projedeki BÜTÜN görevleri sayıyordu; kullanıcının tek görevi
    -- bulunan kurumsal projede bu, binlerce satırlık gereksiz toplama demekti.
    INSERT #TaskAssigneeFacts(TaskId, AssigneeCount)
    SELECT ta.TaskId, COUNT(*)
    FROM dbo.MR_TaskAssignees ta
    JOIN #VisibleTasks visible ON visible.TaskId = ta.TaskId
    GROUP BY ta.TaskId;

    -- Özyinelemeli ata zinciri TEK KEZ ve yalnızca KISMİ proje varken toplanır.
    IF @HasPartialScope = 1
    BEGIN
      ;WITH RequiredPartialWbs AS (
        SELECT DISTINCT w.WbsId, w.ParentWbsId, w.ProjectId
        FROM dbo.MR_WBS w
        JOIN #VisibleTasks visible ON visible.WbsId = w.WbsId
        WHERE visible.AccessLevel = 'PARTIAL'
          AND (visible.IsOwnAssignee = 1 OR visible.IsScopeAssignee = 1)
        UNION ALL
        SELECT parent.WbsId, parent.ParentWbsId, parent.ProjectId
        FROM dbo.MR_WBS parent
        JOIN RequiredPartialWbs child ON child.ParentWbsId = parent.WbsId
        WHERE parent.ProjectId = child.ProjectId
      )
      INSERT #RequiredPartialWbs(WbsId)
      SELECT DISTINCT WbsId FROM RequiredPartialWbs
      OPTION (MAXRECURSION 1000);
    END

    SET @TaskScopeResolvedAt = SYSUTCDATETIME();

    -- Rehberde YAYINLANAN kişiler ile yalnızca ADI çözülen kişiler tek geçişte
    -- toplanır; IsPublished ikisini ayırır. Görünür görevlerin oluşturan ve
    -- sorumluları rehberde YAYINLANMAZ: ad, görev künyesi ve sorumlu satırı
    -- için çözülür, eş sorumlu gizliliği bozulmaz.
    --
    -- Görev ATAMA kapsamı açıkken yöneticinin KENDİ personeli de yayınlanır.
    -- Aksi hâlde görünür FULL projesi olmayan bir yönetici, atayabileceği
    -- çalışanı seçicide hiç bulamıyordu. Kapsam yalnızca MR_V_ExecutiveScope
    -- kadardır; görev/proje/WBS görünürlüğü değişmez.
    --
    -- Tam kapsamlı kullanıcıda rehber zaten bütünüyle döner; küme yalnızca
    -- KISITLI kapsamda anlamlıdır ve yalnızca orada hesaplanır.
    IF @HasFullScope = 0
      INSERT #DirectorySicils(Sicil, IsPublished)
      SELECT candidate.Sicil, CAST(MAX(candidate.IsPublished) AS bit)
      FROM (
        SELECT @sicil AS Sicil, 1 AS IsPublished
        UNION ALL
        SELECT es.EmployeeSicil, 1 FROM #ExecutiveScope es WHERE @canAssignAllCorporate = 1
        UNION ALL
        SELECT p.LeadSicil, 1
        FROM dbo.MR_Projects p
        JOIN #VisibleProjects v ON v.ProjectId = p.ProjectId
        UNION ALL
        SELECT visible.CreatedBySicil, 0
        FROM #VisibleTasks visible
        UNION ALL
        SELECT ta.Sicil,
          CASE WHEN visible.HasReadGrant = 1
            OR ta.Sicil = @sicil
            OR EXISTS (SELECT 1 FROM #ExecutiveScope es WHERE es.EmployeeSicil = ta.Sicil)
          THEN 1 ELSE 0 END
        FROM dbo.MR_TaskAssignees ta
        JOIN #VisibleTasks visible ON visible.TaskId = ta.TaskId
      ) candidate
      WHERE candidate.Sicil IS NOT NULL
      GROUP BY candidate.Sicil;

    -- Kişi rehberi görünümü TEK KEZ okunur. Görünüm HR02 üzerinde pencere
    -- işlevi çalıştırır; görev künyesi, sorumlu satırları ve rehber listesi
    -- ayrı ayrı başvurduğunda aynı tarama üç kez yapılıyordu.
    SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team,
           pd.Sector, pd.Directorate, pd.Department, pd.Unit
    INTO #Directory
    FROM dbo.MR_V_PeopleDirectory pd
    WHERE @HasFullScope = 1
       OR EXISTS (SELECT 1 FROM #DirectorySicils ds WHERE ds.Sicil = pd.Sicil);
    CREATE CLUSTERED INDEX IX_Directory_Sicil ON #Directory(Sicil);

    SET @DirectoryResolvedAt = SYSUTCDATETIME();

    SELECT p.*, v.AccessLevel
    FROM dbo.MR_Projects p
    JOIN #VisibleProjects v ON v.ProjectId = p.ProjectId
    WHERE p.IsActive = 1
    ORDER BY p.ProjectName;

    SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder
    FROM dbo.MR_ProjectTags pt
    JOIN #VisibleProjects v ON v.ProjectId = pt.ProjectId
    ORDER BY pt.ProjectId, pt.SortOrder, pt.TagName;

    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN #VisibleProjects v ON v.ProjectId = w.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR v.HasReadGrant = 1
       OR v.IsTaskScoped = 1
       OR EXISTS (SELECT 1 FROM #RequiredPartialWbs r WHERE r.WbsId = w.WbsId)
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code;

    -- Sorumlu SAYISI da döner. PARTIAL anlık görüntü kapsam dışı bir eş
    -- sorumlunun satırını bilinçli olarak gizler; istemci yalnızca sayıyı
    -- karşılaştırarak "gizlenmiş sorumlu var" sonucuna varabilir ve sunucunun
    -- reddedeceği bir düzenlemeyi baştan açmaz. Sayı kimlik taşımaz.
    SELECT t.*, visible.AccessLevel,
      COALESCE(facts.AssigneeCount, 0) AS AssigneeCount,
      visible.IsOwnAssignee AS IsCurrentUserAssignee,
      visible.IsCreator AS IsCurrentUserCreator,
      CASE WHEN visible.IdentityBase = 1 OR visible.IsOwnAssignee = 1
        THEN t.CreatedBySicil ELSE NULL END AS VisibleCreatedBySicil,
      CASE WHEN visible.IdentityBase = 1 OR visible.IsOwnAssignee = 1
        THEN NULLIF(LTRIM(RTRIM(creator.DisplayName)), '') ELSE NULL END AS CreatedByName
    FROM dbo.MR_Tasks t
    JOIN #VisibleTasks visible ON visible.TaskId = t.TaskId
    LEFT JOIN #TaskAssigneeFacts facts ON facts.TaskId = t.TaskId
    LEFT JOIN #Directory creator ON creator.Sicil = t.CreatedBySicil
    -- Sıralama tam belirlenimlidir: aynı seriden üretilen yinelemeler başlıkta ve
    -- sıra anahtarında eşitlenebilir; kararlı bir ek anahtar olmadan SQL bunları
    -- her yüklemede farklı sırada döndürebilir ve Kanban kendiliğinden karışırdı.
    ORDER BY t.ProjectId, t.SortOrder, t.Title, t.PlannedStart, t.TaskId;

    SELECT ta.TaskId,
      CASE WHEN auth.IdentityVisible = 1 THEN ta.Sicil ELSE NULL END AS Sicil,
      CASE WHEN NULLIF(LTRIM(RTRIM(pd.DisplayName)), '') IS NOT NULL
        THEN ta.Sicil ELSE NULL END AS AvatarEmployeeNo,
      COALESCE(
        NULLIF(LTRIM(RTRIM(pd.DisplayName)), ''),
        CASE WHEN auth.IdentityVisible = 1 THEN CONVERT(varchar(20), ta.Sicil) ELSE NULL END
      ) AS DisplayName
    FROM dbo.MR_TaskAssignees ta
    JOIN #VisibleTasks visible ON visible.TaskId = ta.TaskId
    LEFT JOIN #Directory pd ON pd.Sicil = ta.Sicil
    CROSS APPLY (
      SELECT CAST(CASE WHEN visible.IdentityBase = 1
        OR ta.Sicil = @sicil
        OR EXISTS (
          SELECT 1 FROM #ExecutiveScope es
          WHERE es.EmployeeSicil = ta.Sicil
        )
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) auth
    WHERE auth.IdentityVisible = 1 OR visible.IsOwnAssignee = 1
    ORDER BY ta.TaskId, ta.Sicil;

    SELECT d.*
    FROM dbo.MR_TaskDependencies d
    JOIN #VisibleProjects v ON v.ProjectId = d.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT b.*
    FROM dbo.MR_Baselines b
    JOIN #VisibleProjects v ON v.ProjectId = b.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT s.*
    FROM dbo.MR_TaskBaselineSnapshots s
    JOIN dbo.MR_Baselines b ON b.BaselineId = s.BaselineId
    JOIN #VisibleProjects v ON v.ProjectId = b.ProjectId
    WHERE v.AccessLevel = 'FULL';

    SELECT c.*, wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName
    FROM dbo.MR_Calendars c
    LEFT JOIN dbo.MR_CalendarWorkingDays wd ON wd.CalendarId = c.CalendarId
    LEFT JOIN dbo.MR_CalendarHolidays h ON h.CalendarId = c.CalendarId
    WHERE c.IsActive = 1
    ORDER BY c.Name, wd.Weekday, h.HolidayDate;

    SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit
    FROM #Directory pd
    WHERE @HasFullScope = 1
       OR EXISTS (SELECT 1 FROM #DirectorySicils ds WHERE ds.Sicil = pd.Sicil AND ds.IsPublished = 1)
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
    --
    -- Yetenek kapalıyken küme BOŞ dönmek zorundadır; koşul yüklem olarak
    -- yazıldığında kurumsal proje başına kök düğüm araması yine çalışıyordu.
    IF @canAssignAllCorporate = 1
      SELECT p.ProjectId, p.ProjectCode, p.ProjectName, p.ProjectTypeCode, p.ProjectTypeName,
             p.ColorToken, p.CalendarId, root.WbsId AS RootWbsId
      FROM dbo.MR_Projects p
      OUTER APPLY (
        SELECT TOP (1) w.WbsId
        FROM dbo.MR_WBS w
        WHERE w.ProjectId = p.ProjectId AND w.ParentWbsId IS NULL
        ORDER BY w.SortOrder, w.Code
      ) root
      WHERE p.SourceType = 'CORPORATE' AND p.IsActive = 1
      ORDER BY p.ProjectCode;
    ELSE
      SELECT TOP (0) p.ProjectId, p.ProjectCode, p.ProjectName, p.ProjectTypeCode, p.ProjectTypeName,
             p.ColorToken, p.CalendarId, CAST(NULL AS uniqueidentifier) AS RootWbsId
      FROM dbo.MR_Projects p;

    -- Atama kapsamındaki ÇALIŞANLAR. Sunucu, kapsam projelerinde görevin bütün
    -- sorumlularının bu kümede olmasını şart koşar; istemci kümeyi bilmeden
    -- seçiciye bütün rehberi koyuyor ve seçilen kişi kaydı garanti reddediyordu.
    -- Küme yalnızca Sicil taşır ve kişi rehberi zaten bu kişileri içerir.
    SELECT es.EmployeeSicil
    FROM #ExecutiveScope es
    WHERE @canAssignAllCorporate = 1
    ORDER BY es.EmployeeSicil;

    -- SQL İÇİ aşama süreleri. Satır yalnızca milisaniye taşır; Sicil, ad,
    -- proje, görev ya da yetki ayrıntısı İÇERMEZ. Aşamalar ardışıktır.
    SELECT DATEDIFF(millisecond, @BatchStartedAt, @ScopeResolvedAt) AS ScopeMs,
      DATEDIFF(millisecond, @ScopeResolvedAt, @TaskScopeResolvedAt) AS TaskScopeMs,
      DATEDIFF(millisecond, @TaskScopeResolvedAt, @DirectoryResolvedAt) AS DirectoryMs,
      DATEDIFF(millisecond, @DirectoryResolvedAt, SYSUTCDATETIME()) AS ResultSetsMs;

    DROP TABLE #VisibleProjects, #ReadGrantedProjects, #ExecutiveScope,
      #ScopedTasks, #OwnScopedProjects, #ScopeAssignedProjects, #VisibleTasks,
      #TaskAssigneeFacts, #RequiredPartialWbs, #DirectorySicils, #Directory;
  `));

  const [projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows,
    snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows,
    sqlStageRows] = result.recordsets;
  recordSnapshotSqlStages(sqlStageRows?.[0], sqlStartedAt);

  return observePhase(
    'phase.snapshot.main-query.projection',
    async () => projectSnapshotRecordsets({
      projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows,
      baselineRows, snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows
    })
  );
}

/**
 * SQL sonuç kümelerinden anlık görüntü yükünü kurar.
 *
 * Ayrı işlevdir: `phase.snapshot.main-query.sql` ile
 * `phase.snapshot.main-query.projection` ölçümlerinin sınırı burada nettir ve
 * SQL beklemesi ile JavaScript dönüşümü ayrı ayrı görülebilir.
 */
function projectSnapshotRecordsets({
  projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows,
  baselineRows, snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows
}) {
  const tags = new Map();
  const dependencies = new Map();
  const calendars = new Map();
  for (const row of tagRows || []) {
    const key = id(row.ProjectId);
    if (!tags.has(key)) tags.set(key, []);
    // Renk/simge boş olabilir (eski kayıtlar); alan modeli ada göre kararlı bir
    // varsayılan türetir, bu yüzden burada uydurma bir değer yazılmaz.
    tags.get(key).push({ name: row.TagName, color: row.ColorToken || null, icon: row.IconKey || null });
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

  return applyTaskAssigneeProjection({
    calendars: [...calendars.values()],
    projects: (projectRows || []).map((row) => {
      const projectId = id(row.ProjectId);
      const tagCatalog = tags.get(projectId) || [];
      return {
        id: projectId,
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
        tags: projectTagNames(tagCatalog),
        tagCatalog,
        version: encodeVersion(row.RowVersion),
        accessLevel: row.AccessLevel,
        schedulingCapability: row.AccessLevel === 'FULL' ? 'COMPLETE' : 'SUPPRESSED_PARTIAL'
      };
    }),
    wbs: (wbsRows || []).map((row) => ({
      id: id(row.WbsId),
      projectId: id(row.ProjectId),
      parentId: id(row.ParentWbsId),
      code: row.Code,
      name: row.Name,
      sortOrder: row.SortOrder,
      // Kurumsal projelerin iş dağılım ağacı CN43N kaynağından beslenir; arayüz bu
      // alanlara bakarak düzenleme eylemlerini kapatır ve kaynak bilgisini gösterir.
      source: String(row.SourceType || 'MANUAL').toLowerCase(),
      sourceKey: row.SourceKey || null,
      outlineCode: row.OutlineCode || null,
      level: row.WbsLevel == null ? null : Number(row.WbsLevel),
      statusCode: row.StatusCode || null,
      elementTypeCode: row.ElementTypeCode || null,
      version: encodeVersion(row.RowVersion)
    })),
    tasks: (taskRows || []).map((row) => {
      const visibleCreatorSicil = row.VisibleCreatedBySicil == null
        ? null
        : String(row.VisibleCreatedBySicil);
      // Kimlik kanonikleştirmesi görev başına BİR KEZ yapılır; aynı dönüşüm
      // alan başına yinelendiğinde binlerce görevde ölçülebilir iş oluyordu.
      const taskId = id(row.TaskId);
      return {
        id: taskId,
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
        // Sorumlu kimlikleri `applyTaskAssigneeProjection` tarafından aynı
        // satırlardan kurulur; burada ikinci bir eşleme tutulmaz.
        assigneeIds: [],
        // Yetkili sorumlu sayısı: `assigneeIds.length` ile farklıysa görevin
        // görünmeyen sorumluları vardır (bkz. yukarıdaki AssigneeCount).
        assigneeCount: Number(row.AssigneeCount ?? 0),
        // Kimlikleri açığa çıkarmadan görev düzeyi yazma kararını destekler.
        // Sunucu mutasyonda üyeliği yeniden, yetkili tablodan doğrular.
        isCurrentUserAssignee: Boolean(row.IsCurrentUserAssignee),
        createdBySicil: visibleCreatorSicil,
        isCurrentUserCreator: Boolean(row.IsCurrentUserCreator),
        // Ad ve Sicil birlikte yetkili kişi satırından türer. Gizli oluşturan için
        // ikisi de null kalır; panel bu durumda genel kullanıcı etiketi gösterir
        // ve kurumsal fotoğraf URL'si kuramaz.
        createdByName: row.CreatedByName == null
          ? null
          : String(row.CreatedByName).trim() || null,
        createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
        deps: dependencies.get(taskId) || [],
        version: encodeVersion(row.RowVersion)
      };
    }),
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
  }, assigneeRows);
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
  req.input('hasFullScope', sql.Bit, Boolean(auth.isSystemAdmin || auth.effective?.fullProjectIds?.size));
  req.input('canAssignAllCorporate', sql.Bit, Boolean(auth.canAssignAllCorporateProjects));
  req.input('projectIds', sql.NVarChar(sql.MAX), projectIds.join(','));
  req.input('wbsIds', sql.NVarChar(sql.MAX), wbsIds.join(','));
  req.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  const result = await req.query(`
    SET NOCOUNT ON;

    DROP TABLE IF EXISTS #RequestedProjects, #RequestedWbs, #RequestedTasks, #ExecutiveScope,
      #ScopeProjects, #ProjectRole, #TaskScopedProjects, #ProjectAuth, #TaskAssigneeFacts,
      #CreatorReadScope, #DirectoryNames;

    CREATE TABLE #RequestedProjects(ProjectId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #RequestedWbs(WbsId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #RequestedTasks(TaskId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #ExecutiveScope(EmployeeSicil int PRIMARY KEY);
    CREATE TABLE #ScopeProjects(ProjectId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #ProjectRole(
      ProjectId uniqueidentifier PRIMARY KEY,
      IsRoleFull bit NOT NULL,
      HasFullGrant bit NOT NULL,
      HasReadGrant bit NOT NULL,
      HasAnyGrant bit NOT NULL
    );
    CREATE TABLE #TaskScopedProjects(ProjectId uniqueidentifier PRIMARY KEY);
    CREATE TABLE #ProjectAuth(
      ProjectId uniqueidentifier PRIMARY KEY,
      AccessLevel varchar(10) NOT NULL,
      HasReadGrant bit NOT NULL,
      IsTaskScoped bit NOT NULL,
      IsVisible bit NOT NULL
    );
    CREATE TABLE #TaskAssigneeFacts(
      TaskId uniqueidentifier PRIMARY KEY,
      AssigneeCount int NOT NULL,
      IsOwnAssignee bit NOT NULL,
      IsScopeAssignee bit NOT NULL
    );
    CREATE TABLE #CreatorReadScope(Sicil int PRIMARY KEY);

    -- Kimlik listeleri TEK KEZ ayrıştırılır. Her deyim kendi STRING_SPLIT
    -- çağrısını yaptığında aynı metin altı kez bölünüyor ve dönüştürülmüş
    -- değer üzerinden kurulan birleştirme her seferinde yeniden tahmin ediliyordu.
    INSERT #RequestedProjects(ProjectId)
    SELECT DISTINCT parsed.Id FROM (
      SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) AS Id FROM STRING_SPLIT(@projectIds, ',')
    ) parsed WHERE parsed.Id IS NOT NULL;

    INSERT #RequestedWbs(WbsId)
    SELECT DISTINCT parsed.Id FROM (
      SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) AS Id FROM STRING_SPLIT(@wbsIds, ',')
    ) parsed WHERE parsed.Id IS NOT NULL;

    INSERT #RequestedTasks(TaskId)
    SELECT DISTINCT parsed.Id FROM (
      SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) AS Id FROM STRING_SPLIT(@taskIds, ',')
    ) parsed WHERE parsed.Id IS NOT NULL;

    -- Yönetim kapsamı TEK KEZ okunur. Aynı Sicil birden fazla kademede bulunabilir.
    INSERT #ExecutiveScope(EmployeeSicil)
    SELECT DISTINCT EmployeeSicil
    FROM dbo.MR_V_ExecutiveScope
    WHERE ManagerSicil = @sicil;

    INSERT #ScopeProjects(ProjectId)
    SELECT DISTINCT scoped.ProjectId FROM (
      SELECT rp.ProjectId FROM #RequestedProjects rp
      UNION
      SELECT w.ProjectId FROM dbo.MR_WBS w JOIN #RequestedWbs rw ON rw.WbsId = w.WbsId
      UNION
      SELECT t.ProjectId FROM dbo.MR_Tasks t JOIN #RequestedTasks rt ON rt.TaskId = t.TaskId
    ) scoped;

    -- Rol ve açık yetki kararı proje başına TEK KEZ verilir.
    INSERT #ProjectRole(ProjectId, IsRoleFull, HasFullGrant, HasReadGrant, HasAnyGrant)
    SELECT p.ProjectId,
      CASE WHEN @isAdmin = 1
        OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
          WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
        )
      THEN 1 ELSE 0 END,
      CASE WHEN accessGrant.AccessLevel = 'FULL' THEN 1 ELSE 0 END,
      CASE WHEN accessGrant.AccessLevel = 'READ' THEN 1 ELSE 0 END,
      CASE WHEN accessGrant.AccessLevel IS NOT NULL THEN 1 ELSE 0 END
    FROM dbo.MR_Projects p
    JOIN #ScopeProjects sp ON sp.ProjectId = p.ProjectId
    OUTER APPLY (
      SELECT TOP (1) pa.AccessLevel
      FROM dbo.MR_ProjectAccess pa
      WHERE pa.ProjectId = p.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
    ) accessGrant
    WHERE p.IsActive = 1;

    -- Görev tabanlı (KISMİ) görünürlük yalnızca daha ucuz kurallarla karara
    -- bağlanamayan projeler için ve dizin aramalarıyla hesaplanır; önceki biçim
    -- proje başına bütün görevleri tarayıp satır başına kapsam yoklaması yapıyordu.
    INSERT #TaskScopedProjects(ProjectId)
    SELECT DISTINCT scoped.ProjectId FROM (
      SELECT t.ProjectId
      FROM dbo.MR_Tasks t
      JOIN #ProjectRole candidate ON candidate.ProjectId = t.ProjectId
        AND candidate.IsRoleFull = 0 AND candidate.HasFullGrant = 0 AND candidate.HasReadGrant = 0
      WHERE t.CreatedBySicil = @sicil
      UNION
      SELECT t.ProjectId
      FROM dbo.MR_TaskAssignees ta
      JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
      JOIN #ProjectRole candidate ON candidate.ProjectId = t.ProjectId
        AND candidate.IsRoleFull = 0 AND candidate.HasFullGrant = 0 AND candidate.HasReadGrant = 0
      WHERE ta.Sicil = @sicil
      UNION
      SELECT t.ProjectId
      FROM #ExecutiveScope es
      JOIN dbo.MR_TaskAssignees ta ON ta.Sicil = es.EmployeeSicil
      JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
      JOIN #ProjectRole candidate ON candidate.ProjectId = t.ProjectId
        AND candidate.IsRoleFull = 0 AND candidate.HasFullGrant = 0 AND candidate.HasReadGrant = 0
    ) scoped;

    INSERT #ProjectAuth(ProjectId, AccessLevel, HasReadGrant, IsTaskScoped, IsVisible)
    SELECT r.ProjectId,
      CASE WHEN r.IsRoleFull = 1 OR r.HasFullGrant = 1 THEN 'FULL' ELSE 'PARTIAL' END,
      r.HasReadGrant,
      scoped.IsTaskScoped,
      CASE WHEN r.IsRoleFull = 1 OR r.HasAnyGrant = 1 OR scoped.IsTaskScoped = 1 THEN 1 ELSE 0 END
    FROM #ProjectRole r
    CROSS APPLY (
      SELECT CAST(CASE WHEN EXISTS (
        SELECT 1 FROM #TaskScopedProjects ts WHERE ts.ProjectId = r.ProjectId
      ) THEN 1 ELSE 0 END AS bit) AS IsTaskScoped
    ) scoped;

    -- Sorumlu sayısı, kendi sorumluluğu ve yönetim kapsamı görev başına TEK
    -- toplamada çözülür; üç ayrı bağıntılı alt sorgu yerine tek geçiş yapılır.
    INSERT #TaskAssigneeFacts(TaskId, AssigneeCount, IsOwnAssignee, IsScopeAssignee)
    SELECT rt.TaskId,
      COUNT(ta.Sicil),
      CAST(MAX(CASE WHEN ta.Sicil = @sicil THEN 1 ELSE 0 END) AS bit),
      CAST(MAX(CASE WHEN es.EmployeeSicil IS NOT NULL THEN 1 ELSE 0 END) AS bit)
    FROM #RequestedTasks rt
    LEFT JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = rt.TaskId
    LEFT JOIN #ExecutiveScope es ON es.EmployeeSicil = ta.Sicil
    GROUP BY rt.TaskId;

    -- READ yetkisi üzerinden künye açılan OLUŞTURANLAR küme olarak çözülür.
    -- Yüklem görev satırı başına çalıştığında, oluşturanın bütün atamaları ve
    -- o atamaların projeleri her satır için yeniden taranıyordu.
    INSERT #CreatorReadScope(Sicil)
    SELECT candidate.Sicil
    FROM (
      SELECT DISTINCT t.CreatedBySicil AS Sicil
      FROM dbo.MR_Tasks t
      JOIN #RequestedTasks rt ON rt.TaskId = t.TaskId
      WHERE t.CreatedBySicil IS NOT NULL
    ) candidate
    WHERE EXISTS (
      SELECT 1
      FROM dbo.MR_TaskAssignees creatorAssignment
      JOIN dbo.MR_Tasks creatorTask ON creatorTask.TaskId = creatorAssignment.TaskId
      JOIN dbo.MR_ProjectAccess creatorReadGrant ON creatorReadGrant.ProjectId = creatorTask.ProjectId
        AND creatorReadGrant.Sicil = @sicil
        AND creatorReadGrant.IsActive = 1
        AND creatorReadGrant.AccessLevel = 'READ'
      WHERE creatorAssignment.Sicil = candidate.Sicil
    );

    -- Kişi rehberi görünümü TEK KEZ, yalnızca gereken Siciller için okunur.
    SELECT needed.Sicil, NULLIF(LTRIM(RTRIM(pd.DisplayName)), '') AS DisplayName
    INTO #DirectoryNames
    FROM (
      SELECT DISTINCT t.CreatedBySicil AS Sicil
      FROM dbo.MR_Tasks t JOIN #RequestedTasks rt ON rt.TaskId = t.TaskId
      WHERE t.CreatedBySicil IS NOT NULL
      UNION
      SELECT DISTINCT ta.Sicil
      FROM dbo.MR_TaskAssignees ta JOIN #RequestedTasks rt ON rt.TaskId = ta.TaskId
    ) needed
    LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = needed.Sicil;
    CREATE CLUSTERED INDEX IX_DirectoryNames_Sicil ON #DirectoryNames(Sicil);

    SELECT p.*, pa.AccessLevel
    FROM dbo.MR_Projects p
    JOIN #RequestedProjects rp ON rp.ProjectId = p.ProjectId
    JOIN #ProjectAuth pa ON pa.ProjectId = p.ProjectId
    WHERE pa.IsVisible = 1;

    -- Etiketler de yetkili proje kümesiyle sınırlanır: görünmeyen projenin
    -- etiketleri istemciye hiç taşınmaz.
    SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder
    FROM dbo.MR_ProjectTags pt
    JOIN #RequestedProjects rp ON rp.ProjectId = pt.ProjectId
    JOIN #ProjectAuth pa ON pa.ProjectId = pt.ProjectId
    WHERE pa.IsVisible = 1
    ORDER BY pt.ProjectId, pt.SortOrder, pt.TagName;

    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN #RequestedWbs rw ON rw.WbsId = w.WbsId
    JOIN #ProjectAuth pa ON pa.ProjectId = w.ProjectId
    WHERE pa.AccessLevel = 'FULL' OR pa.HasReadGrant = 1 OR pa.IsTaskScoped = 1;

    SELECT t.*,
      facts.AssigneeCount,
      facts.IsOwnAssignee AS IsCurrentUserAssignee,
      CASE WHEN t.CreatedBySicil = @sicil THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsCurrentUserCreator,
      CASE WHEN creatorAuth.IdentityVisible = 1 THEN t.CreatedBySicil ELSE NULL END AS VisibleCreatedBySicil,
      creator.DisplayName AS CreatedByName
    FROM dbo.MR_Tasks t
    JOIN #RequestedTasks rt ON rt.TaskId = t.TaskId
    JOIN #ProjectAuth pa ON pa.ProjectId = t.ProjectId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
    JOIN #TaskAssigneeFacts facts ON facts.TaskId = t.TaskId
    CROSS APPLY (
      SELECT CAST(CASE WHEN @hasFullScope = 1
        OR t.CreatedBySicil = @sicil
        OR facts.IsOwnAssignee = 1
        OR p.LeadSicil = t.CreatedBySicil
        OR (
          @canAssignAllCorporate = 1
          AND EXISTS (
            SELECT 1 FROM #ExecutiveScope creatorScope
            WHERE creatorScope.EmployeeSicil = t.CreatedBySicil
          )
        )
        OR EXISTS (
          SELECT 1 FROM #CreatorReadScope creatorRead WHERE creatorRead.Sicil = t.CreatedBySicil
        )
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) creatorAuth
    LEFT JOIN #DirectoryNames creator
      ON creator.Sicil = t.CreatedBySicil AND creatorAuth.IdentityVisible = 1
    WHERE pa.AccessLevel = 'FULL'
      OR pa.HasReadGrant = 1
      OR t.CreatedBySicil = @sicil
      OR facts.IsOwnAssignee = 1
      OR facts.IsScopeAssignee = 1;

    SELECT ta.TaskId,
      CASE WHEN auth.IdentityVisible = 1 THEN ta.Sicil ELSE NULL END AS Sicil,
      CASE WHEN pd.DisplayName IS NOT NULL THEN ta.Sicil ELSE NULL END AS AvatarEmployeeNo,
      COALESCE(pd.DisplayName, CASE WHEN auth.IdentityVisible = 1
        THEN CONVERT(varchar(20), ta.Sicil) ELSE NULL END) AS DisplayName
    FROM dbo.MR_TaskAssignees ta
    JOIN #RequestedTasks rt ON rt.TaskId = ta.TaskId
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN #ProjectAuth pa ON pa.ProjectId = t.ProjectId
    JOIN #TaskAssigneeFacts facts ON facts.TaskId = ta.TaskId
    LEFT JOIN #DirectoryNames pd ON pd.Sicil = ta.Sicil
    CROSS APPLY (
      SELECT CAST(CASE WHEN pa.AccessLevel = 'FULL'
        OR pa.HasReadGrant = 1
        OR t.CreatedBySicil = @sicil
        OR ta.Sicil = @sicil
        OR EXISTS (
          SELECT 1 FROM #ExecutiveScope es WHERE es.EmployeeSicil = ta.Sicil
        )
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) auth
    WHERE auth.IdentityVisible = 1 OR facts.IsOwnAssignee = 1
    ORDER BY ta.TaskId, ta.Sicil;

    SELECT d.*
    FROM dbo.MR_TaskDependencies d
    JOIN #RequestedTasks rt ON rt.TaskId = d.TaskId
    JOIN #ProjectAuth pa ON pa.ProjectId = d.ProjectId
    WHERE pa.AccessLevel = 'FULL';

    DROP TABLE #RequestedProjects, #RequestedWbs, #RequestedTasks, #ExecutiveScope,
      #ScopeProjects, #ProjectRole, #TaskScopedProjects, #ProjectAuth, #TaskAssigneeFacts,
      #CreatorReadScope, #DirectoryNames;
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
      createdBySicil: row.VisibleCreatedBySicil == null ? null : String(row.VisibleCreatedBySicil),
      isCurrentUserCreator: Boolean(row.IsCurrentUserCreator),
      // Görev künyesi: kartta "kim, ne zaman oluşturdu" satırını besler.
      createdByName: row.CreatedByName == null ? null : String(row.CreatedByName).trim() || null,
      createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
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
  // Proje künyesi Outlook randevusunun açıklamasında GÖRÜNÜR; yeniden
  // adlandırma o projenin abonelerine güncelleme kuyruğu açar. Yazılan değerler
  // deyimin kendisinden bilinir; satır yeniden OKUNMAZ.
  await enqueueOutlookProjectChange(executor, projectId, before, before.SourceType === 'MANUAL'
    ? { ...before, ProjectName: project.name, ProjectCode: projectCode, LeadSicil: project.leadId ? Number(project.leadId) : null }
    : before);
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
  const fullAccess = hasFullProjectWriteAccess(actor, projectId);
  if (actor.isSystemAdmin || (fullAccess && !actor.isExecutive)) return;

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
      'Görev yalnızca kendi personelinize atanabilir; görevin en az bir sorumlusu olmalıdır.'
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
  // BOŞ DİZE de yokluk sayılır. Yalnızca `== null` denetlendiğinde, kalıcı
  // satırda NULL taşıyan bir alan (örneğin `WbsId`) istemciden boş dize olarak
  // geldiğinde `sameActualId` `false` döndürüyor, dar yazma bunu yapısal
  // değişiklik sayıp geçerli bir güncellemeyi FORBIDDEN ile reddediyordu.
  const absent = (value) => value == null || (typeof value === 'string' && !value.trim());
  if (absent(left) && absent(right)) return true;
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
 * Görev SORUMLUSUNUN doğrudan yazamadığı plan tarihleri.
 *
 * Sorumlu, kendi işinin PLANINI (`plannedStart` / `plannedFinish`) ve
 * gerçekleşen tarihlerini yönetir: işi yapan kişidir ve bu tarihler onun
 * ilerlemesini anlatır. Eskiden üç kontrollü tarihin tamamı engelleniyordu, bu
 * yüzden sıradan bir kullanıcı kendisine atanmış görevin "Güncel Plan" kartını
 * hiç düzenleyemiyordu.
 *
 * `targetFinish` (HEDEF bitiş) bir TAAHHÜTtür, kendi planı değil: görev
 * oluşturucusu ya da tam proje yetkisi olmadan değiştirilemez; sorumlu bunun
 * için tarih değişikliği talebi gönderir.
 */
const ASSIGNEE_BLOCKED_SCHEDULE_FIELDS = Object.freeze([
  ['targetFinish', 'TargetFinish']
]);

/**
 * Sıradan görev sorumlusu görev içeriğini/ilerlemesini güncelleyebilir; proje
 * yapısını, WBS'yi, atama listesini ve bağımlılık modelini yönetemez.
 * Bu denetim istemci görünümüne değil kilit altında okunmuş görev satırına
 * dayanır. Böylece eksik PARTIAL anlık görüntü yetki yükseltme aracı olamaz.
 */
function assertAssigneeWorkFieldsOnly(before, task, { allowRecurrence = false } = {}) {
  const protectedValueChange = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS.some(([field, storedField]) => (
    hasOwnField(task, field) && nullableNumber(task[field]) !== nullableNumber(before[storedField])
  ));
  const structuralChange = !sameActualId(before.ProjectId, task.projectId)
    || !sameNullableId(before.WbsId, task.wbsId)
    || Boolean(before.IsMilestone) !== Boolean(task.isMilestone || task.milestone)
    || (!allowRecurrence && hasOwnField(task, 'recurrence') && (formatRecurrenceRule(task.recurrence) || null) !== (before.RecurrenceRule || null))
    || (hasOwnField(task, 'recurrenceParentId') && !sameNullableId(before.RecurrenceParentTaskId, task.recurrenceParentId))
    || (hasOwnField(task, 'recurrenceOccurrenceDate')
      && isoDate(before.RecurrenceOccurrenceDate) !== (task.recurrenceOccurrenceDate || null))
    || (hasSubmittedField(task, 'sortOrder') && (task.sortOrder ?? null) !== (before.SortOrder ?? null))
    || Boolean(task.assigneeMutation)
    || (task.deps || []).length > 0;
  const scheduleChange = ASSIGNEE_BLOCKED_SCHEDULE_FIELDS.some(([field, storedField]) => (
    hasSubmittedField(task, field) && (task[field] || null) !== isoDate(before[storedField])
  ));
  if (structuralChange || protectedValueChange || scheduleChange) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev sorumlusu kendi plan ve gerçekleşen tarihlerini düzenleyebilir; HEDEF bitiş tarihi için tarih değişikliği talebi göndermelidir.'
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
function assertLimitedCreatorFieldsOnly(before, task, { allowAssigneeMutation = false, allowRecurrence = false } = {}) {
  const protectedValueChange = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS.some(([field, storedField]) => (
    hasOwnField(task, field) && nullableNumber(task[field]) !== nullableNumber(before[storedField])
  ));
  // GERÇEKLEŞEN tarihler oluşturucudan da esirgenmez: görevi açan kişi çoğu
  // zaman onu yürüten kişidir ve işin ne zaman başlayıp bittiğini yalnızca o
  // bilir. Engel kaldığında kendi görevinde "Gerçekleşen tarihler" kartı salt
  // okunur kalıyordu.
  const forbiddenChange = !sameActualId(before.ProjectId, task.projectId)
    || Boolean(before.IsMilestone) !== Boolean(task.isMilestone || task.milestone)
    || (!allowRecurrence && hasOwnField(task, 'recurrence') && (formatRecurrenceRule(task.recurrence) || null) !== (before.RecurrenceRule || null))
    || (hasOwnField(task, 'recurrenceParentId') && !sameNullableId(before.RecurrenceParentTaskId, task.recurrenceParentId))
    || (hasOwnField(task, 'recurrenceOccurrenceDate')
      && isoDate(before.RecurrenceOccurrenceDate) !== (task.recurrenceOccurrenceDate || null))
    || (hasSubmittedField(task, 'sortOrder') && (task.sortOrder ?? null) !== (before.SortOrder ?? null))
    || (Boolean(task.assigneeMutation) && !allowAssigneeMutation)
    || (task.deps || []).length > 0;
  if (forbiddenChange || protectedValueChange) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev oluşturucusu kendi görevinde tarih ve mevcut WBS seçimini yönetebilir; proje, sorumlu, bağımlılık, saat ve finans alanlarını yönetemez.'
    );
  }
}

/** Dar sorumlu oluşturması yalnızca görev iş alanlarını başlatabilir. */
function assertAssigneeTaskCreateFieldsOnly(task, parent = null) {
  const structuralValue = Boolean(task.isMilestone || task.milestone) !== Boolean(parent?.IsMilestone)
    || (!task.recurrenceParentId && task.sortOrder != null)
    || (!task.recurrenceParentId && task.calendarId != null)
    || (!task.recurrenceParentId && task.plannedDurationDays != null)
    || task.remainingDurationDays != null
    || (task.deps || []).length > 0;
  const protectedValue = ASSIGNEE_PROTECTED_TASK_VALUE_FIELDS.some(([field, storedField]) => {
    const inherited = parent && ['plannedHours', 'budget'].includes(field) ? parent[storedField] : null;
    return nullableNumber(task[field]) !== nullableNumber(inherited);
  });
  if (structuralValue || protectedValue) {
    throw new ServerPersistenceError(
      'FORBIDDEN',
      'Görev sorumlusu yeni kendi görevinde termin ve mevcut WBS seçebilir; sorumlu, takvim, bağımlılık, saat veya finans alanlarını yönetemez.'
    );
  }
}

async function commitTask(executor, actor, task, correlationId, { dependencyPlanningVerified = false } = {}) {
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
  const creatorCanAssign = limitedCreatorWrite && actor.isExecutive
    && (await projectRow(executor, beforeProjectId))?.SourceType === 'CORPORATE';
  const creatorAssigneeWrite = creatorCanAssign && Boolean(task.assigneeMutation);
  const assigneeWorkOnly = Boolean(before) && actorIsAssignee && !limitedCreatorWrite
    && !fullProjectWrite && !Boolean(task.assigneeMutation);
  const narrowTaskWrite = assigneeWorkOnly || limitedCreatorWrite;
  const selfRecurrence = narrowTaskWrite && !before.RecurrenceParentTaskId
    && authoritativeAssigneeSicils.length === 1 && actorIsAssignee;

  if (narrowTaskWrite && !creatorAssigneeWrite) {
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
    assertAssigneeWorkFieldsOnly(before, task, { allowRecurrence: selfRecurrence });
  } else if (limitedCreatorWrite) {
    await assertActiveProject(executor, beforeProjectId);
    assertLimitedCreatorFieldsOnly(before, task, { allowAssigneeMutation: creatorAssigneeWrite, allowRecurrence: selfRecurrence });
    if (creatorAssigneeWrite) {
      sourceProjectScope = await assertTaskProjectScope(executor, actor, beforeProjectId);
      destinationProjectScope = sourceProjectScope;
    }
  } else {
    if (beforeProjectId) sourceProjectScope = await assertTaskProjectScope(executor, actor, beforeProjectId);
    destinationProjectScope = beforeProjectId && sameActualId(beforeProjectId, projectId)
      ? sourceProjectScope
      : await assertTaskProjectScope(executor, actor, projectId, {
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
  const assigneesUnchanged = Boolean(before) && sameSicilSet(authoritativeAssigneeSicils, (task.assigneeIds || []).map(Number));
  const assigneeSicils = (narrowTaskWrite && !creatorAssigneeWrite) || assigneesUnchanged
    ? authoritativeAssigneeSicils
    : await ensurePeople(executor, task.assigneeIds || []);
  // Kaynak proje: görevin ŞU ANKİ sorumluları kapsam denetimine girer.
  if ((!narrowTaskWrite || creatorAssigneeWrite) && beforeProjectId && !hasFullProjectWriteAccess(actor, beforeProjectId)) {
    await assertAssigneeScope(executor, actor, beforeProjectId, authoritativeAssigneeSicils, sourceProjectScope);
  }
  if (!narrowTaskWrite || creatorAssigneeWrite) {
    if (!before || beforeProjectId !== projectId || !fullProjectWrite || !sameSicilSet(authoritativeAssigneeSicils, assigneeSicils)) {
      await assertAssigneeScope(executor, actor, projectId, assigneeSicils, destinationProjectScope);
    }
    if (!before && destinationProjectScope === TASK_PROJECT_SCOPES.ASSIGNEE_CREATE && !task.recurrenceParentId) {
      assertAssigneeTaskCreateFieldsOnly(task);
    }
  }
  const assigneeCreate = !before && destinationProjectScope === TASK_PROJECT_SCOPES.ASSIGNEE_CREATE;
  const auditProject = await projectRow(executor, projectId);
  if (!auditProject) {
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
  const requestedCalendarId = narrowTaskWrite ? id(before.CalendarId) : (task.calendarId || null);
  const planContext = await loadTaskPlanContext(executor, projectId, requestedCalendarId);
  const effectiveCalendarId = planContext.projects[0]?.calendarId || null;
  // Etkinliğini yitirmiş ya da artık bulunmayan görev takvimi override'ı tekrar
  // yazılmaz. NULL kalınca görev proje/varsayılan takvimini miras alır; bu da
  // plan hesaplarında kullanılan etkin fallback ile kalıcı semantiği eşitler.
  const persistedCalendarId = requestedCalendarId && sameActualId(requestedCalendarId, effectiveCalendarId)
    ? requestedCalendarId
    : null;
  const calendar = resolveTaskCalendar({ projectId, calendarId: persistedCalendarId }, planContext.projects, planContext.calendars);
  const isMilestone = narrowTaskWrite ? Boolean(before.IsMilestone) : Boolean(task.isMilestone || task.milestone);
  const canonicalStatus = (status) => ({ planned: 'todo', 'in-progress': 'in_progress' }[status] || status || 'todo');
  const previousLifecycle = {
    status: canonicalStatus(before?.Status), progress: nullableNumber(before?.Progress),
    actualStart: isoDate(before?.ActualStart), actualFinish: isoDate(before?.ActualFinish),
    milestone: isMilestone
  };
  const lifecyclePatch = Object.fromEntries(['status', 'progress', 'actualStart', 'actualFinish']
    .filter((field) => hasSubmittedField(task, field))
    .map((field) => [field, field === 'status' ? canonicalStatus(task[field]) : task[field]]));
  let lifecycle;
  try {
    lifecycle = { ...previousLifecycle, ...normalizeTaskLifecycle(previousLifecycle, {
      ...lifecyclePatch, resetActualDates: task.resetActualDates === true
    }, businessDate(new Date(), calendar.timezone)) };
  } catch (error) {
    throw new ServerPersistenceError(error.code || 'MUTATION_FAILED', error.message);
  }
  const { actualStart, actualFinish } = lifecycle;

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
  if (actualFinish && !actualStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçek bitiş için gerçek başlangıç gereklidir.');
  }
  if (actualStart && actualFinish && actualFinish < actualStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Gerçekleşen bitiş başlangıçtan önce olamaz.');
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

  const recurrenceScheduleChanged = Boolean(before) && (
    recurrenceRule !== (before.RecurrenceRule || null)
    || plannedStart !== isoDate(before.PlannedStart)
    || plannedFinish !== isoDate(before.PlannedFinish)
    || targetFinish !== isoDate(before.TargetFinish)
    || (hasSubmittedField(task, 'plannedDurationDays')
      && nullableNumber(task.plannedDurationDays) !== nullableNumber(before.PlannedDurationDays))
  );
  if (recurrenceScheduleChanged && await countRecurrenceChildren(executor, taskId)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Yinelemeler üretildikten sonra tekrar kuralı veya seri planı değiştirilemez.');
  }

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
    const parentRule = normalizeRecurrenceRule(parent.RecurrenceRule);
    if (!before && (!parentRule || !recurrenceOccurrenceDate)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Yineleme için geçerli şablon kuralı ve tekrar günü gereklidir.');
    }
    let normalizedParentCalendarId = id(parent.CalendarId);
    if (!before) {
      const parentRequestedCalendarId = id(parent.CalendarId);
      const parentContext = sameNullableId(parentRequestedCalendarId, persistedCalendarId)
        ? planContext : await loadTaskPlanContext(executor, projectId, parentRequestedCalendarId);
      const parentEffectiveCalendarId = parentContext.projects[0]?.calendarId || null;
      normalizedParentCalendarId = parentRequestedCalendarId
        && sameActualId(parentRequestedCalendarId, parentEffectiveCalendarId)
        ? parentRequestedCalendarId
        : null;
      const parentCalendar = resolveTaskCalendar(
        { projectId, calendarId: normalizedParentCalendarId },
        parentContext.projects,
        parentContext.calendars
      );
      const templateDate = isoDate(parent.RecurrenceOccurrenceDate) || isoDate(parent.PlannedStart);
      const occurrences = planRecurringOccurrences({
        plannedStart: isoDate(parent.PlannedStart), plannedFinish: isoDate(parent.PlannedFinish),
        targetFinish: isoDate(parent.TargetFinish), plannedDurationDays: nullableNumber(parent.PlannedDurationDays)
      }, parentRule, { calendar: parentCalendar }).filter((occurrence) => occurrence.occurrenceDate !== templateDate);
      const occurrence = occurrences.find((item) => item.occurrenceDate === recurrenceOccurrenceDate);
      if (!occurrence) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Tekrar günü şablonun kuralı ve çalışma takvimiyle uyumlu olmalıdır.');
      }
      const expectedDuration = calculatePlannedDurationDays({
        ...occurrence, projectId, calendarId: normalizedParentCalendarId, milestone: Boolean(parent.IsMilestone)
      }, parentContext);
      if (plannedStart !== occurrence.plannedStart || plannedFinish !== occurrence.plannedFinish
        || targetFinish !== (occurrence.targetFinish || null)
        || nullableNumber(task.plannedDurationDays) !== expectedDuration) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Yineleme planı ve süresi şablonun ürettiği tekrar günüyle uyumlu olmalıdır.');
      }
      if (await countRecurrenceChildren(executor, recurrenceParentId) >= occurrences.length) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'Tekrar oluşum sınırına ulaşıldı.');
      }
    }
    if (assigneeCreate) {
      assertAssigneeTaskCreateFieldsOnly(task, parent);
      const parentAssignees = await taskAssigneeSicils(executor, recurrenceParentId);
      if (!sameSicilSet(parentAssignees, [Number(actor.sicil)])
        || !sameSicilSet(parentAssignees, assigneeSicils)
        || !sameNullableId(parent.WbsId, wbsId)
        || !sameNullableId(normalizedParentCalendarId, persistedCalendarId)
        || (task.sortOrder != null && (parent.SortOrder == null || task.sortOrder <= parent.SortOrder))) {
        throw new ServerPersistenceError('FORBIDDEN', 'Yinelemeler yalnızca kendi görevinizin sorumlu ve yapı kapsamını devralabilir.');
      }
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
  // Sorumlu artık plan tarihlerini düzenleyebildiği için süre de YENİDEN
  // hesaplanmalıdır; kalıcı değer korunsaydı satır, tarihleriyle çelişen bir
  // süre taşırdı.
  if (assigneeWorkOnly
    && (hasSubmittedField(task, 'plannedStart') || hasSubmittedField(task, 'plannedFinish'))) {
    plannedDurationDays = calculatePlannedDurationDays({
      projectId,
      calendarId: persistedCalendarId,
      plannedStart,
      plannedFinish,
      milestone: isMilestone
    }, planContext);
  }
  if (limitedCreatorWrite || assigneeCreate) {
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
  // Dar yazmada GÖNDERİLMEYEN alan kalıcı değeri korur.
  //
  // Tarihler, WBS bağı ve ürün-dışı alanlar için bu kural zaten uygulanıyordu;
  // içerik alanları ise atlanınca varsayılana düşüyordu. Görev sorumlusunun
  // yalnızca ilerleme yazan dar bir güncellemesi bu yüzden `Status` alanını
  // `planned` değerine geri alıyor, `Keyword`, `Description`, `Progress`,
  // `RemainingDurationDays` ve `SortOrder` alanlarını da NULL'a çekiyordu.
  const preserved = (field, column, fallback = null) => {
    if (!before || !narrowTaskWrite || hasSubmittedField(task, field)) return undefined;
    return before[column] ?? fallback;
  };
  const submittedOr = (field, column, value, fallback = null) => {
    const kept = preserved(field, column, fallback);
    return kept === undefined ? value : kept;
  };
  req.input('description', sql.NVarChar(sql.MAX), submittedOr('description', 'Description', task.description || null));
  req.input('keyword', sql.NVarChar(255), submittedOr('keyword', 'Keyword', task.keyword || null));
  req.input('status', sql.VarChar(30), ({ todo: 'planned', in_progress: 'in-progress' }[lifecycle.status] || lifecycle.status));
  // Arayüz kataloğunda `normal` diye bir öncelik yoktur; varsayılan olarak
  // yazıldığında Görevler/Kanban/Raporlar sayfaları çöküyordu. Kalıcı kayıt da
  // kanonik kimliği tutar.
  req.input('priority', sql.VarChar(30), normalizePriorityId(
    submittedOr('priority', 'Priority', task.priority)
  ));
  req.input('isMilestone', sql.Bit, isMilestone);
  req.input('plannedStart', sql.Date, plannedStart);
  req.input('plannedFinish', sql.Date, plannedFinish);
  req.input('plannedDuration', sql.Decimal(10, 2), plannedDurationDays);
  req.input('targetFinish', sql.Date, targetFinish);
  // GERÇEKLEŞEN tarihler oluşturucu yazmasında da GÖNDERİLEN değeri alır;
  // yalnızca gönderilmediğinde kalıcı değer korunur (dar yazma sözleşmesi).
  // Değerler yukarıda ETKİN çift olarak çözülür ve DOĞRULANIR; burada aynı
  // çift bağlanır, aksi hâlde doğrulanan değerle yazılan değer ayrışırdı.
  req.input('actualStart', sql.Date, actualStart);
  req.input('actualFinish', sql.Date, actualFinish);
  req.input('remainingDuration', sql.Decimal(10, 2), nullableNumber(
    submittedOr('remainingDurationDays', 'RemainingDurationDays', task.remainingDurationDays)
  ));
  req.input('progress', sql.Decimal(5, 2), nullableNumber(
    lifecycle.progress
  ));
  req.input('plannedHours', sql.Decimal(12, 2), nullableNumber(narrowTaskWrite ? before.PlannedHours : task.plannedHours));
  req.input('actualHours', sql.Decimal(12, 2), nullableNumber(narrowTaskWrite ? before.ActualHours : task.actualHours));
  req.input('budget', sql.Decimal(19, 4), nullableNumber(narrowTaskWrite ? before.Budget : task.budget));
  req.input('spent', sql.Decimal(19, 4), nullableNumber(narrowTaskWrite ? before.Spent : task.spent));
  req.input('sortOrder', sql.Int, submittedOr('sortOrder', 'SortOrder', task.sortOrder ?? null));
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

  const rewriteDependencies = !dependencyPlanningVerified || task.dependencyMutation !== false;
  if (fullProjectWrite && rewriteDependencies) {
    const clear = request(executor);
    clear.input('taskId', sql.UniqueIdentifier, taskId);
    await clear.query('DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId;');
  }
  // Değişmeyen atamalar yeniden yazılmaz; atayan kişi ve tarih korunur.
  if ((!narrowTaskWrite || creatorAssigneeWrite) && !assigneesUnchanged) {
    const clear = request(executor);
    clear.input('taskId', sql.UniqueIdentifier, taskId);
    await clear.query('DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;');
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
  for (const dependency of fullProjectWrite && rewriteDependencies ? (task.deps || []) : []) {
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
  const committed = await taskRow(executor, taskId);
  // Takvim ve görünürlük değişiklikleri aynı işlemde kuyruğa yazılır.
  await enqueueOutlookTaskChange(executor, taskId,
    before ? { ...before, assigneeIds: authoritativeAssigneeSicils } : null,
    { ...committed, assigneeIds: assigneeSicils });
  const projectIdentity = { ProjectName: auditProject.ProjectName, ProjectCode: auditProject.ProjectCode };
  await audit(executor, actor, correlationId, before ? 'UPDATE' : 'CREATE', 'TASK', taskId, projectId,
    before ? { ...before, assigneeIds: authoritativeAssigneeSicils } : null,
    { ...committed, ...projectIdentity, assigneeIds: assigneeSicils });
  // Sorumlu kümesindeki YETKİLİ fark, zil bildirimi ve kurum dışı koordinasyon
  // kaydı için taşınır. Başlık/açıklama düzenlemesi boş fark üretir ve hiçbir
  // bildirim doğurmaz (bkz. server/notifications/taskNotificationStore.js).
  const delta = assigneeSetDelta(authoritativeAssigneeSicils, assigneeSicils);
  // Yinelemenin şablonu aynı kişiyi zaten taşıyorsa kurum dışı koordinasyon
  // kaydı ŞABLONDA açılmıştır: seri üretimi her yineleme için karşı yönetim
  // zincirine ayrı bir NOTICE yazıyor, zil ve Atama Koordinasyonu sekmesi
  // aynı atamanın kopyalarıyla doluyordu. Şablon aynı işlemde yazıldıysa da
  // kümesi burada zaten güncel okunur.
  const templateAssigneeSicils = recurrenceParentId && delta.added.length
    ? await taskAssigneeSicils(executor, recurrenceParentId)
    : [];
  return {
    taskId: id(taskId), projectId, beforeProjectId, wbsId: id(wbsId),
    relatedTaskIds: [...relatedTaskIds],
    assignmentChange: delta.added.length || delta.removed.length ? {
      taskId: id(taskId),
      created: !before,
      added: delta.added,
      removed: delta.removed,
      assigneeSicils,
      recurrenceParentId: recurrenceParentId ? id(recurrenceParentId) : null,
      templateAssigneeSicils,
      task: {
        title: committed?.Title ?? task.task ?? null,
        projectId,
        projectName: auditProject.ProjectName || null,
        projectCode: auditProject.ProjectCode || null,
        targetFinish: isoDate(committed?.TargetFinish),
        priority: committed?.Priority || null
      }
    } : null
  };
}

/**
 * Sorumlu değişikliklerinin YAYINI.
 *
 * Üç çıktı aynı olaydan türetilir ve aynı işlemde kalıcılaşır:
 *   · zil bildirimi (kişi başına toplanmış, etkisiz/idempotent),
 *   · kurum dışı atamanın koordinasyon kaydı ve karşı yönetim zinciri,
 *   · kullanıcı açıkça istediyse e-posta NİYETİ (teslimat arka plandadır).
 *
 * Kişi ve yönetici çözümü KÜME tabanlıdır; sorumlu başına sorgu açılmaz.
 * Göç uygulanmamış kurulumda yayın sessizce atlanır ve görev yazması etkilenmez.
 */
async function publishAssignmentChanges(executor, actor, correlationId, changes, { notifyAssignees = false } = {}) {
  if (!changes.length) return;
  const addedSicils = [...new Set(changes.flatMap((change) => change.added))];
  const notifiedSicils = [...new Set(changes.flatMap((change) => [...change.added, ...change.removed]))]
    .filter((sicil) => Number(sicil) !== Number(actor.sicil));
  if (!notifiedSicils.length) return;

  try {
    const classified = addedSicils.length
      ? await classifyAssigneeOrganizations(executor, actor.sicil, addedSicils)
      : new Map();
    const crossSicils = [...classified.values()].filter((person) => person.crossOrganization).map((person) => person.sicil);
    const chains = crossSicils.length
      ? await resolveManagementChain(executor, crossSicils, { excludeSicils: [actor.sicil] })
      : new Map();
    const crossAssignments = [];
    for (const change of changes) {
      const inherited = new Set((change.templateAssigneeSicils || []).map(Number));
      for (const sicil of change.added) {
        if (!change.created) await closeOpenCoordinationsFor(executor, actor, change.taskId, sicil);
        const person = classified.get(Number(sicil));
        if (!person?.crossOrganization) continue;
        // Yineleme, şablonun koordinasyon kaydını devralır.
        if (inherited.has(Number(sicil))) continue;
        const managerSicils = chains.get(Number(sicil)) || [];
        if (!managerSicils.length) continue;
        crossAssignments.push({
          taskId: change.taskId,
          assigneeSicil: sicil,
          assigneeSicils: change.assigneeSicils,
          assigneeName: person.name,
          assigneeOrganization: person.organizationPath,
          managerSicils,
          taskTitle: change.task.title,
          projectId: change.task.projectId,
          projectName: change.task.projectName,
          projectCode: change.task.projectCode,
          targetFinish: change.task.targetFinish
        });
      }
    }
    if (crossAssignments.length) {
      await recordCrossOrganizationAssignments(executor, actor, { correlationId, assignments: crossAssignments });
    }

    await writeAssignmentNotifications(executor, {
      actorSicil: actor.sicil,
      actorName: actor.currentUser?.name || null,
      correlationId,
      changes
    });

    if (notifyAssignees) {
      const entries = aggregateAssignmentNotifications(changes, actor.sicil).map((bucket) => ({
        taskId: bucket.taskId,
        recipientSicil: bucket.recipientSicil,
        payload: {
          kind: bucket.kind,
          taskCount: bucket.taskCount,
          taskTitle: bucket.task?.title,
          projectName: bucket.task?.projectName,
          projectCode: bucket.task?.projectCode,
          actorName: actor.currentUser?.name || null,
          priority: bucket.task?.priority,
          targetFinish: bucket.task?.targetFinish,
          changeSummary: bucket.taskCount > 1
            ? bucket.kind === 'TASK_ASSIGNED'
              ? `${bucket.taskCount} göreve sorumlu olarak eklendiniz.`
              : `${bucket.taskCount} görevdeki sorumluluğunuz kaldırıldı.`
            : bucket.kind === 'TASK_ASSIGNED'
              ? 'Göreve sorumlu olarak eklendiniz.'
              : 'Görev sorumluluğunuz kaldırıldı.'
        }
      }));
      await enqueueTaskAssignmentMail(executor, { correlationId, entries });
    }
  } catch (error) {
    if (!isMissingNotificationSchema(error)) throw error;
  }
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
    const creatorCanAssign = actor.isExecutive
      && (await projectRow(executor, projectId))?.SourceType === 'CORPORATE';
    if (creatorCanAssign && assigneeSicils.some((sicil) => Number(sicil) !== Number(actor.sicil))) {
      await assertTaskProjectAccess(executor, actor, projectId, assigneeSicils);
    } else if (assigneeSicils.some((sicil) => Number(sicil) !== Number(actor.sicil))) {
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
    IF OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests', N'U') IS NOT NULL
      UPDATE dbo.MR_TaskScheduleChangeRequests
      SET Status = 'STALE', DecidedAt = SYSUTCDATETIME(), DecisionBySicil = @actorSicil,
          DecisionMessage = N'İlgili görev silindi.'
      WHERE TaskId = @taskId AND Status = 'PENDING';
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
  // Görev artık yok: abonelerin Outlook randevusu İPTAL edilir. Abonelik satırı
  // korunur, çünkü iptal daveti için değişmez UID ve son teslim edilen künye
  // gereklidir (bkz. MR_TaskOutlookSubscriptions · DeliveredSummary).
  await enqueueOutlookTaskRemoval(executor, taskId);
  const auditProject = await projectRow(executor, projectId);
  await audit(executor, actor, correlationId, 'DELETE', 'TASK', taskId, projectId,
    { ...before, assigneeIds: assigneeSicils, ProjectName: auditProject?.ProjectName, ProjectCode: auditProject?.ProjectCode }, null);
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
  const auth = await observePhase('phase.snapshot.authorization', () => loadAuthorizationContext(connection));
  const snapshot = await observePhase('phase.snapshot.main-query', () => loadSnapshotFrom(connection, auth));
  return { snapshot, auth };
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
      const dependencyPlanningVerified = input?.[DEPENDENCY_PLANNING_VERIFIED] === true;
      const changes = normalizeChanges(input);
      return withSqlTransaction(async (transaction) => {
        const actor = await observePhase('phase.commit.authorization', () => loadAuthorizationContext(transaction));
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
        const assignmentChanges = [];
        for (const task of changes.taskUpserts) {
          const touched = await observePhase('phase.commit.task-mutation', () => commitTask(
            transaction, actor, task, correlationId, { dependencyPlanningVerified }
          ));
          if (touched.projectId) touchedTaskProjects.add(touched.projectId);
          if (touched.beforeProjectId) touchedTaskProjects.add(touched.beforeProjectId);
          if (touched.wbsId) touchedTaskWbs.add(touched.wbsId);
          for (const relatedTaskId of touched.relatedTaskIds || []) relatedTaskIds.add(relatedTaskId);
          if (touched.assignmentChange) assignmentChanges.push(touched.assignmentChange);
        }
        // Bildirim, kurum dışı koordinasyon kaydı ve isteğe bağlı posta NİYETİ
        // aynı işlemde, TEK seferde ve küme tabanlı çözümle yazılır. Hiçbir SMTP
        // çağrısı bu yolda yapılmaz (bkz. server/notifications/taskMailWorker.js).
        await observePhase('phase.commit.assignment-notifications', () => publishAssignmentChanges(
          transaction, actor, correlationId, assignmentChanges,
          { notifyAssignees: input?.notifyAssignees === true }
        ));
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
        const authoritative = await observePhase('phase.commit.authoritative-response', () => loadAuthoritativeMutationRows(
          transaction, actor, {
            projectIds: [...projectIds],
            wbsIds: [...wbsIds],
            taskIds: [...taskIds]
          }
        ));
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
