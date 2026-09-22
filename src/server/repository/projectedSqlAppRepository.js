import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyDefaultCalendarProjection } from './calendarProjection.js';
import { readScheduleInbox } from '../schedule-change/scheduleRequestQueries.js';
import {
  isMissingNotificationInboxSchema,
  readNotificationInbox
} from '../notifications/notificationInboxQueries.js';
import { observePhase } from '../observability/observeOperation.js';

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

const EMPTY_NOTIFICATION_INBOX = Object.freeze({
  coordination: Object.freeze({ items: [], unreadCount: 0, pendingCount: 0 }),
  taskEvents: Object.freeze({ items: [], unreadCount: 0, pendingCount: 0 }),
  unreadCount: 0,
  pendingCount: 0
});

async function loadNotificationInbox(executor, auth) {
  try {
    return await readNotificationInbox(executor, auth);
  } catch (error) {
    if (isMissingNotificationInboxSchema(error)) return EMPTY_NOTIFICATION_INBOX;
    throw error;
  }
}

async function loadDefaultCalendarId(executor) {
  return observePhase('phase.snapshot.default-calendar', async () => {
    const result = await executor.request().query(`
      SELECT TOP (1) CalendarId
      FROM dbo.MR_Calendars
      WHERE IsDefault = 1 AND IsActive = 1
      ORDER BY CreatedAt, CalendarId;
    `);
    return result.recordset?.[0]?.CalendarId == null
      ? null
      : (canonicalActualId(result.recordset[0].CalendarId) ?? String(result.recordset[0].CalendarId));
  });
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
      await observePhase('phase.snapshot.catalog', () => baseRepository.refreshCorporateCatalog({ waitForColdStart: true }));
    }
    const projected = await observePhase('phase.snapshot.transaction', () => withSqlTransaction(async (transaction) => {
      const { snapshot, auth } = await baseRepository.readSnapshotWithAuthorization(transaction);
      const defaultCalendarId = await loadDefaultCalendarId(transaction);
      const scheduleInbox = await observePhase('phase.snapshot.schedule-inbox', () => loadScheduleChanges(transaction, auth));
      // Zil ikinci bir altyapı değildir: atama koordinasyonu ve görev bildirimi
      // aynı merkezde, TEK ek sorguyla ve yine sekizer satırlık önizlemeyle
      // taşınır (bkz. server/notifications/notificationInboxQueries.js).
      const notificationInbox = await observePhase(
        'phase.snapshot.notification-inbox',
        () => loadNotificationInbox(transaction, auth)
      );
      Object.assign(snapshot, applyDefaultCalendarProjection(snapshot, defaultCalendarId));
      return {
        snapshot: {
          ...snapshot,
          scheduleRequests: scheduleInbox.items,
          scheduleRequestSummary: {
            unreadCount: scheduleInbox.unreadCount,
            pendingCount: scheduleInbox.pendingCount
          },
          assignmentCoordinations: notificationInbox.coordination.items,
          taskNotifications: notificationInbox.taskEvents.items,
          notificationSummary: {
            unreadCount: notificationInbox.unreadCount,
            pendingCount: notificationInbox.pendingCount
          }
        },
        auth
      };
    }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE }));
    // Manuel Refresh önce depodaki yetkili snapshot'ı okur; ancak bundan sonra
    // tazelik zamanlayıcısını dürter. Böylece bu isteğin SERIALIZABLE okuması,
    // kendi başlattığı 38 bin satırlık eşitlemeyle kilit yarışına girmez.
    if (catalogSync === 'background-after') {
      await observePhase('phase.snapshot.catalog', () => baseRepository.refreshCorporateCatalog({ waitForColdStart: false }));
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
      return observePhase('phase.snapshot.session', async () => ({
        ...snapshot,
        session: await baseRepository.sessionContextFrom(auth)
      }));
    }
  };
}
