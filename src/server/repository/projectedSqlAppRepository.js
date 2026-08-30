import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyDefaultCalendarProjection } from './calendarProjection.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';
import { listScheduleChanges } from '../schedule-change/scheduleChangeStore.js';

function missingScheduleRequestSchema(error) {
  return Number(error?.number) === 208
    && String(error?.message || '').includes('MR_TaskScheduleChangeRequests');
}

async function loadScheduleChanges(executor, auth) {
  try {
    return await listScheduleChanges(executor, auth);
  } catch (error) {
    // Uygulama paketi göçten önce açılırsa eski kurulum kullanılabilir kalır;
    // başka bütün SQL hataları yine görünür biçimde yükseltilir.
    if (missingScheduleRequestSchema(error)) return [];
    throw error;
  }
}

/** Görünür görevlerin kimlik ve görev kapsamlı ad izdüşümü. */
async function loadVisibleTaskAssignees(executor, taskIds, auth) {
  if (!taskIds.length) return [];

  const request = executor.request();
  request.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  request.input('sicil', sql.Int, auth?.sicil ?? null);
  request.input('isAdmin', sql.Bit, Boolean(auth?.isSystemAdmin));
  const result = await request.query(`
    SELECT ta.TaskId,
      CASE WHEN auth.IdentityVisible = 1 THEN ta.Sicil ELSE NULL END AS Sicil,
      CASE
        WHEN NULLIF(LTRIM(RTRIM(pd.DisplayName)), '') IS NOT NULL THEN ta.Sicil
        ELSE NULL
      END AS AvatarEmployeeNo,
      COALESCE(
        NULLIF(LTRIM(RTRIM(pd.DisplayName)), ''),
        CASE WHEN auth.IdentityVisible = 1 THEN CONVERT(varchar(20), ta.Sicil) ELSE NULL END
      ) AS DisplayName
    FROM dbo.MR_TaskAssignees ta
    JOIN STRING_SPLIT(@taskIds, ',') visible
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(visible.value)))
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
    LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = ta.Sicil
    CROSS APPLY (
      SELECT CAST(CASE WHEN @isAdmin = 1
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
          WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
        )
        OR EXISTS (
          SELECT 1 FROM dbo.MR_ProjectAccess pa
          WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
            AND pa.AccessLevel IN ('FULL', 'READ')
        )
        OR (p.SourceType = 'MANUAL' AND p.IsActive = 1 AND p.LeadSicil = @sicil)
        OR t.CreatedBySicil = @sicil
        OR ta.Sicil = @sicil
        OR EXISTS (
          SELECT 1 FROM dbo.MR_V_ExecutiveScope es
          WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
        )
      THEN 1 ELSE 0 END AS bit) AS IdentityVisible
    ) auth
    WHERE auth.IdentityVisible = 1
       OR EXISTS (
         SELECT 1 FROM dbo.MR_TaskAssignees ownAssignment
         WHERE ownAssignment.TaskId = ta.TaskId AND ownAssignment.Sicil = @sicil
       )
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
      const taskIds = [...new Set((snapshot.tasks || []).map((task) => String(task.id)).filter(Boolean))];
      const assigneeRows = await loadVisibleTaskAssignees(transaction, taskIds, auth);
      const defaultCalendarId = await loadDefaultCalendarId(transaction);
      const scheduleRequests = await loadScheduleChanges(transaction, auth);
      Object.assign(snapshot, applyDefaultCalendarProjection(snapshot, defaultCalendarId));
      return {
        snapshot: { ...applyTaskAssigneeProjection(snapshot, assigneeRows), scheduleRequests },
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
