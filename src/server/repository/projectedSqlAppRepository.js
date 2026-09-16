import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ACCESS_REASONS } from '../authorization/authorization.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyDefaultCalendarProjection } from './calendarProjection.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';
import { readScheduleInbox } from '../schedule-change/scheduleRequestQueries.js';

function missingScheduleRequestSchema(error) {
  const number = Number(error?.number);
  const message = String(error?.message || '');
  if (number === 208) {
    return ['MR_TaskScheduleChangeRequests', 'MR_ScheduleRequestNotifications']
      .some((name) => message.includes(name));
  }
  if (number === 207) {
    return ['TaskTitleSnapshot', 'ProjectIdSnapshot', 'ProjectNameSnapshot', 'ProjectCodeSnapshot']
      .some((name) => message.includes(name));
  }
  return false;
}

async function loadScheduleChanges(executor, auth) {
  try {
    return await readScheduleInbox(executor, auth);
  } catch (error) {
    // Uygulama paketi göçten önce açılırsa eski kurulum kullanılabilir kalır;
    // başka bütün SQL hataları yine görünür biçimde yükseltilir.
    if (missingScheduleRequestSchema(error)) return { items: [], unreadCount: 0, pendingCount: 0 };
    throw error;
  }
}

function normalizedId(value) {
  return value == null ? '' : (canonicalActualId(value) ?? String(value));
}

function hasBroadIdentityVisibility(auth, projectId) {
  if (auth?.isSystemAdmin) return true;
  const access = auth?.effective?.access?.get?.(normalizedId(projectId));
  if (!access) return false;
  return access.accessLevel === 'FULL'
    || (access.reasons || []).includes(ACCESS_REASONS.MANUAL_GRANT);
}

export function assigneeProjectionScopes(tasks, auth) {
  const taskIds = [];
  const identityVisibleTaskIds = [];
  const coAssigneeTaskIds = [];

  for (const task of tasks || []) {
    const taskId = normalizedId(task?.id);
    if (!taskId) continue;
    taskIds.push(taskId);
    if (hasBroadIdentityVisibility(auth, task.projectId) || task.isCurrentUserCreator) {
      identityVisibleTaskIds.push(taskId);
    }
    if (task.isCurrentUserAssignee) coAssigneeTaskIds.push(taskId);
  }

  return {
    taskIds: [...new Set(taskIds)],
    identityVisibleTaskIds: [...new Set(identityVisibleTaskIds)],
    coAssigneeTaskIds: [...new Set(coAssigneeTaskIds)]
  };
}

/** Görünür görevlerin sorumlu kimliklerini mevcut yetki bağlamıyla tamamlar. */
async function loadVisibleTaskAssignees(executor, tasks, auth) {
  const scopes = assigneeProjectionScopes(tasks, auth);
  if (!scopes.taskIds.length) return [];

  const request = executor.request();
  request.input('taskIds', sql.NVarChar(sql.MAX), scopes.taskIds.join(','));
  request.input('identityVisibleTaskIds', sql.NVarChar(sql.MAX), scopes.identityVisibleTaskIds.join(','));
  request.input('coAssigneeTaskIds', sql.NVarChar(sql.MAX), scopes.coAssigneeTaskIds.join(','));
  request.input('sicil', sql.Int, auth?.sicil ?? null);
  request.input('isExecutive', sql.Bit, Boolean(auth?.isExecutive));
  const result = await request.query(`
    SELECT ta.TaskId,
      CASE WHEN visibility.IdentityVisible = 1 THEN ta.Sicil ELSE NULL END AS Sicil,
      CASE
        WHEN NULLIF(LTRIM(RTRIM(pd.DisplayName)), '') IS NOT NULL THEN ta.Sicil
        ELSE NULL
      END AS AvatarEmployeeNo,
      COALESCE(
        NULLIF(LTRIM(RTRIM(pd.DisplayName)), ''),
        CASE WHEN visibility.IdentityVisible = 1 THEN CONVERT(varchar(20), ta.Sicil) ELSE NULL END
      ) AS DisplayName
    FROM dbo.MR_TaskAssignees ta
    JOIN STRING_SPLIT(@taskIds, ',') visible
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(visible.value)))
    LEFT JOIN STRING_SPLIT(@identityVisibleTaskIds, ',') identityVisibleTask
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(identityVisibleTask.value)))
    LEFT JOIN STRING_SPLIT(@coAssigneeTaskIds, ',') coAssigneeTask
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(coAssigneeTask.value)))
    LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = ta.Sicil
    LEFT JOIN (
      SELECT DISTINCT EmployeeSicil
      FROM dbo.MR_V_ExecutiveScope
      WHERE @isExecutive = 1 AND ManagerSicil = @sicil
    ) executive ON executive.EmployeeSicil = ta.Sicil
    CROSS APPLY (
      SELECT CAST(CASE WHEN identityVisibleTask.value IS NOT NULL
        OR ta.Sicil = @sicil
        OR executive.EmployeeSicil IS NOT NULL
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) visibility
    WHERE visibility.IdentityVisible = 1
       OR coAssigneeTask.value IS NOT NULL
    ORDER BY ta.TaskId, ta.Sicil;
  `);
  return result.recordset || [];
}

async function loadDefaultCalendarId(executor) {
  const result = await executor.request().query(`
    SELECT TOP (1) CalendarId
    FROM dbo.MR_Calendars
    WHERE IsDefault = 1 AND IsActive = 1
    ORDER BY CreatedAt, CalendarId;
  `);
  return result.recordset?.[0]?.CalendarId == null
    ? null
    : (canonicalActualId(result.recordset[0].CalendarId) ?? String(result.recordset[0].CalendarId));
}

export function createProjectedSqlAppRepository() {
  const baseRepository = createBaseSqlAppRepository();

  async function readProjectedSnapshot({ catalogSync = 'blocking-before' } = {}) {
    // Kurumsal katalog tazelemesi bilinçli olarak işlemin DIŞINDA çalışır.
    // Aynı işlemin içinde çalıştığında CN43N birleştirmesi SERIALIZABLE
    // yalıtımını devralıyor, 38 bin satırlık MR_WBS üzerinde aralık kilitleri
    // biriktiriyor ve tek bir anlık görüntü isteğini otuz saniyenin üzerine
    // çıkarıyordu. İşlemin içinde yalnızca okumalar kalır.
    if (catalogSync === 'blocking-before') {
      await baseRepository.refreshCorporateCatalog({ waitForColdStart: true });
    }
    const projected = await withSqlTransaction(async (transaction) => {
      const { snapshot, auth } = await baseRepository.readSnapshotWithAuthorization(transaction);
      const assigneeRows = await loadVisibleTaskAssignees(transaction, snapshot.tasks, auth);
      const defaultCalendarId = await loadDefaultCalendarId(transaction);
      const scheduleInbox = await loadScheduleChanges(transaction, auth);
      Object.assign(snapshot, applyDefaultCalendarProjection(snapshot, defaultCalendarId));
      return {
        snapshot: { ...applyTaskAssigneeProjection(snapshot, assigneeRows), scheduleRequests: scheduleInbox.items, scheduleRequestSummary: { unreadCount: scheduleInbox.unreadCount, pendingCount: scheduleInbox.pendingCount } },
        auth
      };
    }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
    // Manuel Refresh önce depodaki yetkili snapshot'ı okur; ancak bundan sonra
    // tazelik zamanlayıcısını dürter. Böylece bu isteğin SERIALIZABLE okuması,
    // kendi başlattığı 38 bin satırlık eşitlemeyle kilit yarışına girmez.
    if (catalogSync === 'background-after') {
      await baseRepository.refreshCorporateCatalog({ waitForColdStart: false });
    }
    return projected;
  }

  return {
    ...baseRepository,
    async loadSnapshot(options = {}) {
      return (await readProjectedSnapshot(options)).snapshot;
    },

    /**
     * Açılış isteği: anlık görüntü ve oturum bağlamı tek yanıtta döner.
     *
     * Oturum, anlık görüntünün YETKİ BAĞLAMINDAN kurulur; ayrı bir
     * `loadSessionContext()` çağrısı kişi/rol/proje erişimi ve görev-atama
     * kapsamını aynı istekte ikinci kez sorgulardı.
     */
    async loadSnapshotWithSession(options = {}) {
      const { snapshot, auth } = await readProjectedSnapshot(options);
      return { ...snapshot, session: await baseRepository.sessionContextFrom(auth) };
    }
  };
}
