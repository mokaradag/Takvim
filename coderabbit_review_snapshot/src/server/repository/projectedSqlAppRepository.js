import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyDefaultCalendarProjection } from './calendarProjection.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';

/**
 * Görünür görevlerin sorumluları.
 *
 * Tamamlama YALNIZCA zaten yetkilendirilmiş görev kimlikleri için yapılır; buna
 * ek olarak satır düzeyinde GÖRÜNÜRLÜK kuralı da uygulanır ve kural anlık
 * görüntüdekiyle birebir aynıdır (bkz. sqlAppRepository · loadSnapshotFrom):
 * tam proje yetkisi, `READ` bağışı, kişinin kendisi ya da yöneticinin
 * `MR_V_ExecutiveScope` kapsamı.
 *
 * Süzgeç olmadan bu tamamlama, KISMİ anlık görüntünün bilinçli olarak gizlediği
 * eş sorumluları geri getiriyordu: bir astıyla birlikte kapsam dışı bir
 * çalışana atanmış görevde, o çalışanın Sicili tarayıcıya sızıyordu.
 */
async function loadVisibleTaskAssignees(executor, taskIds, auth) {
  if (!taskIds.length) return [];

  const request = executor.request();
  request.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  request.input('sicil', sql.Int, auth?.sicil ?? null);
  request.input('isAdmin', sql.Bit, Boolean(auth?.isSystemAdmin));
  const result = await request.query(`
    SELECT ta.TaskId, ta.Sicil
    FROM dbo.MR_TaskAssignees ta
    JOIN STRING_SPLIT(@taskIds, ',') visible
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(visible.value)))
    JOIN dbo.MR_Tasks t ON t.TaskId = ta.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
    WHERE @isAdmin = 1
       OR EXISTS (
         SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
         WHERE a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
       )
       OR EXISTS (
         SELECT 1 FROM dbo.MR_ProjectAccess pa
         WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
           AND pa.AccessLevel IN ('FULL', 'READ')
       )
       OR ta.Sicil = @sicil
       OR EXISTS (
         SELECT 1 FROM dbo.MR_V_ExecutiveScope es
         WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
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

  async function readProjectedSnapshot() {
    // Kurumsal katalog tazelemesi bilinçli olarak işlemin DIŞINDA çalışır.
    // Aynı işlemin içinde çalıştığında CN43N birleştirmesi SERIALIZABLE
    // yalıtımını devralıyor, 38 bin satırlık MR_WBS üzerinde aralık kilitleri
    // biriktiriyor ve tek bir anlık görüntü isteğini otuz saniyenin üzerine
    // çıkarıyordu. İşlemin içinde yalnızca okumalar kalır.
    await baseRepository.refreshCorporateCatalog();
    return withSqlTransaction(async (transaction) => {
      const { snapshot, auth } = await baseRepository.readSnapshotWithAuthorization();
      const taskIds = [...new Set((snapshot.tasks || []).map((task) => String(task.id)).filter(Boolean))];
      const assigneeRows = await loadVisibleTaskAssignees(transaction, taskIds, auth);
      const defaultCalendarId = await loadDefaultCalendarId(transaction);
      Object.assign(snapshot, applyDefaultCalendarProjection(snapshot, defaultCalendarId));
      return { snapshot: applyTaskAssigneeProjection(snapshot, assigneeRows), auth };
    }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
  }

  return {
    ...baseRepository,
    async loadSnapshot() {
      return (await readProjectedSnapshot()).snapshot;
    },

    /**
     * Açılış isteği: anlık görüntü ve oturum bağlamı tek yanıtta döner.
     *
     * Oturum, anlık görüntünün YETKİ BAĞLAMINDAN kurulur; ayrı bir
     * `loadSessionContext()` çağrısı kişi/rol/proje erişimi ve görev-atama
     * kapsamını aynı istekte ikinci kez sorgulardı.
     */
    async loadSnapshotWithSession() {
      const { snapshot, auth } = await readProjectedSnapshot();
      return { ...snapshot, session: await baseRepository.sessionContextFrom(auth) };
    }
  };
}
