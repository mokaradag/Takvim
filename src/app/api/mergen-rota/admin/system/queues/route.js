import { queueAgeAlertMinutes } from '../../../../../../server/observability/observabilityConfig.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import { sql } from '../../../../../../server/db/pool.js';
import {
  loadSystemAdminContext,
  withAdminActionLock
} from '../../../../../../server/observability/adminRequestContext.js';
import { withRouteObservability, observeOutcome } from '../../../../../../server/observability/observeOperation.js';
import { queueOperationalEvent } from '../../../../../../server/observability/operationalEventsRepository.js';
import { telemetryWorkerStatus } from '../../../../../../server/observability/telemetryWorker.js';
import {
  CORPORATE_WBS_STATE_SQL,
  OUTLOOK_QUEUE_AGE_SQL,
  OUTLOOK_QUEUE_DETAIL_SQL,
  REMINDER_RUN_STATE_SQL
} from '../../../../../../server/observability/telemetryQueries.js';
import { isCorporateWbsSourceConfigured } from '../../../../../../server/db/corporateWbsConfig.js';
import { getCorporateWbsSyncTtlMs } from '../../../../../../server/repository/corporateWbsSyncSchedule.js';
import { synchronizeCorporateWbs } from '../../../../../../server/repository/corporateWbsSync.js';
import { runOutlookCalendarOutbox } from '../../../../../../server/outlook/outlookCalendarService.js';
import {
  isOutlookCalendarEnabled,
  outlookApplicationLink,
  outlookMaxAttempts,
  outlookPollIntervalMs,
  outlookRunBudgetMs
} from '../../../../../../server/outlook/outlookConfig.js';
import { outlookQueueStatus, retryFailedOutlookDeliveries } from '../../../../../../server/outlook/outlookStore.js';
import { outlookWorkerStatus } from '../../../../../../server/outlook/outlookWorker.js';
import { loadReminderHistory, loadReminderSettings } from '../../../../../../server/reminders/reminderStore.js';
import { isMissingTaskMailSchema, taskMailQueueStatus } from '../../../../../../server/notifications/taskMailOutbox.js';
import { taskMailWorkerStatus } from '../../../../../../server/notifications/taskMailWorker.js';
import { COMPONENTS, EVENT_SEVERITIES } from '../../../../../../domain/observability/eventModel.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const QUEUE_DETAIL_LIMIT = 50;

/** Kuyruk satırının GÜVENLİ künyesi: alıcı adresi ve takvim kimliği taşınmaz. */
function queueItem(row) {
  return {
    id: Number(row.SubscriptionId),
    taskId: row.TaskId ? String(row.TaskId).toLowerCase() : null,
    operation: row.PendingMethod || null,
    attemptCount: Number(row.AttemptCount || 0),
    lastChangedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : null,
    nextAttemptAt: row.NextAttemptAt ? new Date(row.NextAttemptAt).toISOString() : null,
    failureCode: row.LastFailureCode || null,
    leaseExpiresAt: row.LeaseExpiresAt ? new Date(row.LeaseExpiresAt).toISOString() : null,
    lastDeliveredAt: row.LastDeliveredAt ? new Date(row.LastDeliveredAt).toISOString() : null
  };
}

async function loadOutlookSection(pool) {
  const enabled = isOutlookCalendarEnabled();
  const worker = outlookWorkerStatus();
  if (!enabled) {
    return { enabled, worker, queue: null, age: null, items: [], maxAttempts: outlookMaxAttempts(), pollIntervalMs: outlookPollIntervalMs() };
  }
  const maxAttempts = outlookMaxAttempts();
  const queue = await outlookQueueStatus(pool, maxAttempts);
  const ageRow = (await pool.request().query(OUTLOOK_QUEUE_AGE_SQL)).recordset?.[0] || {};
  const detailRequest = pool.request();
  detailRequest.input('limit', sql.Int, QUEUE_DETAIL_LIMIT);
  const items = (await detailRequest.query(OUTLOOK_QUEUE_DETAIL_SQL)).recordset || [];
  return {
    enabled,
    worker,
    queue,
    maxAttempts,
    pollIntervalMs: outlookPollIntervalMs(),
    age: {
      oldestUnattemptedAt: ageRow.OldestUnattemptedAt ? new Date(ageRow.OldestUnattemptedAt).toISOString() : null,
      oldestPendingChangeAt: ageRow.OldestPendingChangeAt ? new Date(ageRow.OldestPendingChangeAt).toISOString() : null,
      maxAttemptCount: ageRow.MaxAttemptCount == null ? 0 : Number(ageRow.MaxAttemptCount),
      nextAttemptAt: ageRow.NextAttemptAt ? new Date(ageRow.NextAttemptAt).toISOString() : null,
      lastDeliveredAt: ageRow.LastDeliveredAt ? new Date(ageRow.LastDeliveredAt).toISOString() : null,
      lastFailureAt: ageRow.LastFailureAt ? new Date(ageRow.LastFailureAt).toISOString() : null
    },
    itemLimit: QUEUE_DETAIL_LIMIT,
    items: items.map(queueItem)
  };
}

function isFreshTimestamp(timestamp, ttlMs, now = Date.now()) {
  if (!timestamp) return false;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && value <= now && now - value < ttlMs;
}

async function loadCorporateWbsSection(pool) {
  const configured = isCorporateWbsSourceConfigured();
  if (!configured) {
    return {
      configured,
      lastSuccessfulSyncAt: null,
      lastContentChangeAt: null,
      projectCount: 0,
      nodeCount: 0,
      mergedProjectCount: null,
      skippedProjectCount: null,
      ttlMs: getCorporateWbsSyncTtlMs(),
      fresh: false
    };
  }
  const row = (await pool.request().query(CORPORATE_WBS_STATE_SQL)).recordset?.[0] || {};
  const lastSuccessfulSyncAt = row.LastSuccessfulSyncAt ? new Date(row.LastSuccessfulSyncAt).toISOString() : null;
  const ttlMs = getCorporateWbsSyncTtlMs();
  return {
    configured,
    lastSuccessfulSyncAt,
    lastContentChangeAt: row.LastContentChangeAt ? new Date(row.LastContentChangeAt).toISOString() : null,
    projectCount: Number(row.ProjectCount || 0),
    nodeCount: Number(row.NodeCount || 0),
    mergedProjectCount: row.MergedProjectCount == null ? null : Number(row.MergedProjectCount),
    skippedProjectCount: row.SkippedProjectCount == null ? null : Number(row.SkippedProjectCount),
    ttlMs,
    fresh: isFreshTimestamp(lastSuccessfulSyncAt, ttlMs)
  };
}

async function loadReminderSection(pool) {
  const settings = await loadReminderSettings(pool);
  const history = await loadReminderHistory(pool, 10);
  const row = settings.schemaReady === false ? null : (await pool.request().query(REMINDER_RUN_STATE_SQL)).recordset?.[0];
  const lastRun = row ? {
    kind: 'AUTOMATIC', status: row.Status, failureCode: row.FailureCode || null,
    createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
    completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : null
  } : null;
  return {
    automaticEnabled: Boolean(settings.automaticEnabled),
    schemaReady: settings.schemaReady !== false,
    windowValue: settings.windowValue,
    windowUnit: settings.windowUnit,
    frequencyValue: settings.frequencyValue,
    frequencyUnit: settings.frequencyUnit,
    lastRun,
    history
  };
}

/**
 * Atama bildirimi posta kuyruğu.
 *
 * Kuyruk Outlook'tan AYRIDIR: yalnızca görev panelindeki e-posta kutusu
 * işaretlenerek kaydedilen işler buraya girer. Göç uygulanmamışsa bölüm
 * "şema eksik" der; kuyruk okunamaması kuyruklar sayfasını düşürmez.
 */
async function loadAssignmentMailSection(pool) {
  const worker = taskMailWorkerStatus();
  try {
    return { schemaReady: true, worker, queue: await taskMailQueueStatus(pool) };
  } catch (error) {
    if (isMissingTaskMailSchema(error)) return { schemaReady: false, worker, queue: null };
    // Yalnızca BU bölüm okunamadı (ör. yeni tabloya izin verilmemiş, geçici
    // hata). Hata `Promise.all` üzerinden bütün yanıtı düşürüyor; okunabilen
    // Outlook, hatırlatma ve CN43N bölümleri de "Kuyruk durumu alınamadı"
    // gösteriyordu. Kod sabittir, ham hata iletisi dışarı taşınmaz.
    return { schemaReady: true, worker, queue: null, failureCode: 'QUEUE_READ_FAILED' };
  }
}

/** Sistem Yönetimi · Kuyruklar ve İşler — YALNIZCA sistem yöneticisi. */
export const GET = withRouteObservability('api.admin.system.queues', async () => {
  try {
    const { pool } = await loadSystemAdminContext();
    const [outlook, corporateWbs, reminders, assignmentMail] = await Promise.all([
      loadOutlookSection(pool),
      loadCorporateWbsSection(pool),
      loadReminderSection(pool),
      loadAssignmentMailSection(pool)
    ]);
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      outlook,
      configuration: { thresholds: { queueAgeMinutes: queueAgeAlertMinutes() } },
      corporateWbs,
      reminders,
      assignmentMail,
      telemetryWorker: telemetryWorkerStatus()
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});

const ACTIONS = Object.freeze({
  /**
   * Outlook turu. Kuyruk semantiği DEĞİŞMEZ: tur, çalışanın kullandığı aynı
   * kiralı sahiplenme yolundan geçer, bu yüzden ikinci bir davet üretmez.
   */
  'outlook-run': async (pool) => {
    if (!isOutlookCalendarEnabled()) {
      throw new ServerPersistenceError('FORBIDDEN', 'Outlook takvim tümleştirmesi kapalı.');
    }
    const result = await observeOutcome('admin.outlook.run',
      () => runOutlookCalendarOutbox(pool, { link: outlookApplicationLink(), budgetMs: Math.min(20000, outlookRunBudgetMs()) }),
      { component: COMPONENTS.OUTLOOK });
    return { result, message: result.ok === false
      ? `Tur tamamlandı ancak sorun bildirildi (${result.reason || 'bilinmeyen'}).`
      : `Tur tamamlandı: ${result.sent || 0} gönderildi, ${result.cancelled || 0} iptal edildi, ${result.failed || 0} başarısız.` };
  },
  /**
   * Başarısız teslimatları yeniden denenebilir hâle getirir.
   *
   * Kuyruk kuşağı (`QueueSeq`) ve takvim sürümü (`Sequence`) DEĞİŞMEZ: eski bir
   * kuşak yeni niyeti ezemez, aynı davet yeniden gönderilir.
   */
  'outlook-retry': async (pool) => {
    if (!isOutlookCalendarEnabled()) {
      throw new ServerPersistenceError('FORBIDDEN', 'Outlook takvim tümleştirmesi kapalı.');
    }
    const retried = await retryFailedOutlookDeliveries(pool);
    return { result: { retried }, message: retried
      ? `${retried} başarısız teslimat yeniden denenmek üzere sıraya alındı.`
      : 'Yeniden denenecek başarısız teslimat yok.' };
  },
  /** CN43N eşitlemesi. Kaynak yapılandırılmamışsa eylem sunulmaz. */
  'wbs-sync': async (pool, actor) => {
    if (!isCorporateWbsSourceConfigured()) {
      throw new ServerPersistenceError('FORBIDDEN', 'CN43N kaynağı yapılandırılmamış.');
    }
    const result = await observeOutcome('admin.wbs.sync',
      () => synchronizeCorporateWbs(pool, actor.sicil),
      { component: COMPONENTS.CORPORATE_WBS, isFailure: (value) => value?.synchronized === false });
    return { result, message: result.synchronized
      ? `Eşitleme tamamlandı: ${result.projectCount} proje, ${result.nodeCount} düğüm (${result.mergedProjectCount} proje güncellendi).`
      : `Eşitleme çalıştırılamadı (${result.reason || 'bilinmeyen neden'}).` };
  }
});

/**
 * Yönetici eylemleri.
 *
 * Yetki sunucuda yeniden denetlenir, eylem adı beyaz listeden seçilir ve aynı
 * eylem eşzamanlı iki kez çalıştırılamaz.
 */
export const POST = withRouteObservability('api.admin.system.queues.action', async (request) => {
  try {
    const { pool, actor } = await loadSystemAdminContext();
    const body = await request.json().catch(() => null);
    const action = String(body?.action || '');
    const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Tanınmayan yönetim eylemi.', { status: 400 });
    }
    const outcome = await withAdminActionLock(action, () => handler(pool, actor), pool);
    const failed = outcome.result?.ok === false || outcome.result?.synchronized === false;
    queueOperationalEvent({
      severity: failed ? EVENT_SEVERITIES.ERROR : EVENT_SEVERITIES.INFO,
      component: COMPONENTS.APPLICATION,
      code: failed ? 'ADMIN_ACTION_FAILED' : 'ADMIN_ACTION_EXECUTED',
      summary: `${failed ? 'Yönetici eylemi başarısız' : 'Yönetici eylemi çalıştırıldı'}: ${action}`,
      detail: outcome.message
    });
    // BAŞARISIZ eylem HTTP 200 dönmez: istemci isteği başarılı sayardı ve
    // `withRouteObservability` rotayı sağlıklı ölçerdi. Gövde aynı kalır;
    // ileti yine gösterilir (bkz. features/shared/jsonRequest.js).
    return Response.json({ ok: !failed, action, ...outcome }, {
      status: failed ? 503 : 200,
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
