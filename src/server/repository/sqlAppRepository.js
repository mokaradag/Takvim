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
import { assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
import { mergeProjectTagAppearance, planProjectTagPropagation, projectTagNames } from '../../domain/tags/index.js';
import { formatRecurrenceRule } from '../../scheduling/recurrence/index.js';
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
  const result = await req.query(`
    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));
    DECLARE @ReadGrantedProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY);

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
       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code
    OPTION (MAXRECURSION 1000);

    SELECT t.*, v.AccessLevel
    FROM dbo.MR_Tasks t
    JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)
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
              OR EXISTS (
                SELECT 1
                FROM dbo.MR_TaskAssignees visibilityGate
                WHERE visibilityGate.TaskId = visibleTask.TaskId
                  AND (
                    visibilityGate.Sicil = @sicil
                    OR EXISTS (
                      SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                      WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibilityGate.Sicil
                    )
                  )
              )
            )
        )
    ORDER BY pd.DisplayName, pd.Sicil;
  `);

  const [projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows, snapshotRows, calendarRows, peopleRows] = result.recordsets;
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
    if (!wbs || !sameActualId(wbs.ProjectId, projectId)) {
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
  }

  const assigneeSicils = await ensurePeople(executor, task.assigneeIds || []);
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
  // Arayüz kataloğunda `normal` diye bir öncelik yoktur; varsayılan olarak
  // yazıldığında Görevler/Kanban/Raporlar sayfaları çöküyordu. Kalıcı kayıt da
  // kanonik kimliği tutar.
  req.input('priority', sql.VarChar(30), normalizePriorityId(task.priority));
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
  req.input('actorSicil', sql.Int, actor.sicil);
  const result = await req.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version)
      THROW 51009, 'STALE_TASK', 1;
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
    WHERE RecurrenceParentTaskId = @taskId;
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

async function refreshCorporateCatalog() {
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
  }, { readDurableSyncState: readCorporateWbsSyncWarmth });
}

/**
 * Kurumsal katalog tazelemeden yalnızca yetkili anlık görüntüyü okur ve
 * kullandığı yetki bağlamını da döndürür.
 *
 * Bağlam bilerek dışarı verilir: açılış isteği oturumu aynı yanıtta taşır ve
 * kişi/rol/proje erişimi ile görev-atama kapsamını hesaplayan (büyük veri
 * kümesinde pahalı) yetki sorgusu tek bir istekte İKİ kez çalışmaz.
 */
async function readSnapshotWithAuthorization() {
  const pool = await getSqlPool();
  const auth = await loadAuthorizationContext(pool);
  return { snapshot: await loadSnapshotFrom(pool, auth), auth };
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

        for (const project of changes.projectUpserts) {
          const root = changes.wbsUpserts.find((node) => sameActualId(node.projectId, project.id) && node.parentId == null) || null;
          const result = await commitProject(transaction, actor, project, root, correlationId);
          if (result.consumedRootId) consumedRootIds.add(result.consumedRootId);
          if (result.tagPlan?.length) tagPlans.push({ projectId: id(project.id), plan: result.tagPlan });
        }
        for (const node of changes.wbsUpserts) {
          if (!consumedRootIds.has(id(node.id))) await commitWbs(transaction, actor, node, correlationId);
        }
        for (const task of changes.taskUpserts) await commitTask(transaction, actor, task, correlationId);
        // Etiket yayılımı görev yazmalarından SONRA çalışır: aynı işlemde
        // istemcinin gönderdiği görevler kendi sürüm anahtarlarıyla kaydedilir,
        // ardından katalog dışında kalan CANLI satırlar hizalanır.
        const propagatedTaskIds = [];
        for (const entry of tagPlans) {
          propagatedTaskIds.push(...await propagateProjectTagChanges(transaction, actor.sicil, entry.projectId, entry.plan));
        }
        for (const entry of changes.taskDeletes) await deleteTask(transaction, actor, entry, correlationId);
        for (const entry of changes.wbsDeletes) await deleteWbs(transaction, actor, entry, correlationId);
        if (changes.projectDeletes.length) {
          throw new ServerPersistenceError('FORBIDDEN', 'Proje silme Gerçek Sistem için desteklenmiyor; projeler pasifleştirilmelidir.');
        }

        const authoritative = await loadSnapshotFrom(transaction, actor);
        const projectIds = new Set(changes.projectUpserts.map((value) => id(value.id)));
        const wbsIds = new Set([...changes.wbsUpserts.map((value) => id(value.id)), ...consumedRootIds]);
        const taskIds = new Set([...changes.taskUpserts.map((value) => id(value.id)), ...propagatedTaskIds]);
        return {
          projectUpserts: authoritative.projects.filter((value) => projectIds.has(value.id)),
          projectDeletes: [],
          wbsUpserts: authoritative.wbs.filter((value) => wbsIds.has(value.id)),
          wbsDeletes: changes.wbsDeletes.map((value) => id(value.id)),
          taskUpserts: authoritative.tasks.filter((value) => taskIds.has(value.id)),
          taskDeletes: changes.taskDeletes.map((value) => id(value.id))
        };
      });
    }
  };
}
