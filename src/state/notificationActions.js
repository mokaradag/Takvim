import { NOTIFICATION_SOURCES } from '../domain/notifications/notificationInbox.js';

/**
 * Zil ve Talepler yüzeylerinin ORTAK yazma eylemleri.
 *
 * Zil, Talepler sekmeleri ve Atama Koordinasyonu aynı yolu kullanır; her
 * yüzeyin kendi yeniden yükleme kuralı kalmaz. Bağımlılıklar dışarıdan verilir:
 * böylece yarış ve belirsiz sonuç senaryoları React olmadan, denetlenen
 * sözlerle sınanabilir.
 */

const SOURCES = new Set(Object.values(NOTIFICATION_SOURCES));
const AMBIGUOUS_OUTCOME_CODES = new Set(['NETWORK', 'REQUEST_TIMEOUT']);

/** Sonucu bilinmeyen bir yazma: istek gitti ama yanıt gelmedi. */
export const OUTCOME_UNKNOWN_MESSAGE = 'Sunucudan yanıt alınamadı; kararın kaydedilip kaydedilmediği doğrulanamadı. '
  + 'Güncel durum yeniden yüklendi; kaydı kontrol etmeden yeniden karar vermeyin.';
export const OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE = 'Sunucudan yanıt alınamadı; kararın kaydedilip kaydedilmediği doğrulanamadı '
  + 've güncel durum doğrulanamadı. Verileri yenileyip kaydı kontrol etmeden yeniden karar vermeyin.';

function actualModeFailure(operation, message) {
  return { ok: false, code: 'ACTUAL_MODE_REQUIRED', message, error: { kind: 'persistence', code: 'ACTUAL_MODE_REQUIRED', message, operation } };
}

function refreshFailure(reload) {
  return reload?.error || { code: reload?.code || 'REFRESH_FAILED', message: reload?.message || 'Veriler yenilenemedi.' };
}

function findCoordinationInSnapshot(reload, coordinationId) {
  const list = reload?.snapshot?.assignmentCoordinations;
  if (!Array.isArray(list)) return null;
  return list.find((item) => item && String(item.id) === String(coordinationId)) || null;
}

export function createNotificationActions({
  isActualMode,
  flush,
  reloadData,
  applyStateAction,
  beginInboxRead,
  getInboxSequence = null,
  markItems,
  decideCoordination
}) {
  // Örtüşen okundu/temizlendi istekleri sıraya alınır: istemci başlangıç
  // sırasının sunucu işleme sırasından ayrışması engellenir.
  let markQueue = Promise.resolve();

  function enqueueMark(work) {
    const run = markQueue.then(work, work);
    markQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Okundu / temizlendi.
   *
   * Sunucu güncel zil kutusunu aynı işlemde döndürür; yalnızca o uygulanır.
   * İşaret sürerken daha yüksek sıra numaralı bir anlık görüntü okuması
   * başlamışsa (işaret işlenmeden önce okumuş olabilir) işaret sonrası bir
   * uzlaştırma okuması yapılır. Belirsiz ağ/zaman aşımı hatalarında da
   * işlenen işaretin kaybolmaması için güncel durum okunur, ancak hata sonucu
   * gizlenmez.
   */
  function markNotifications(items = [], action = 'read') {
    if (!isActualMode()) return Promise.resolve(actualModeFailure('notifications/mark', 'Bildirimler yalnızca Gerçek Sistem kipinde işaretlenebilir.'));
    const notifications = items.filter((item) => item && SOURCES.has(item.source));
    if (!notifications.length) return Promise.resolve({ ok: true, value: { ok: true } });
    return enqueueMark(async () => {
      const inboxSequence = beginInboxRead();
      const result = await markItems(notifications, action);
      if (!result?.ok) {
        if (AMBIGUOUS_OUTCOME_CODES.has(result?.code)) {
          const reload = await reloadData({ preserveFailedTaskUpdates: true });
          if (reload?.ok === false) beginInboxRead();
        }
        return result;
      }
      if (result.value?.inbox) {
        const superseded = typeof getInboxSequence === 'function' && getInboxSequence() > inboxSequence;
        applyStateAction({ type: 'notifications/inbox-refreshed', inbox: result.value.inbox, inboxSequence });
        if (superseded) {
          const reload = await reloadData({ preserveFailedTaskUpdates: true });
          return reload?.ok === false ? { ...result, refreshError: refreshFailure(reload) } : result;
        }
        return result;
      }
      const reload = await reloadData({ preserveFailedTaskUpdates: true });
      return reload?.ok === false ? { ...result, refreshError: refreshFailure(reload) } : result;
    });
  }

  /**
   * Atama koordinasyonu kararı.
   *
   * Başarı ancak sunucu işlemi kaydettikten sonra bildirilir; ardından görev
   * ve zil, karardan SONRA başlayan bir okumayla uzlaştırılır. Uzlaştırma
   * başarısızsa sonuç `refreshError` taşır ve arayüz bunu başarılı eşitleme
   * gibi göstermez. Yanıt alınamadıysa (zaman aşımı, kopan bağlantı) istek
   * YENİDEN GÖNDERİLMEZ: güncel durum okunur; ancak karar öncesi sürümle aynı
   * kalan veya listede gözlenemeyen bir okuma kesin uzlaştırma sayılmaz.
   */
  async function decideAssignmentCoordination(coordinationId, input) {
    if (!isActualMode()) {
      return actualModeFailure('assignment-coordination/decide', 'Atama koordinasyonu yalnızca Gerçek Sistem kipinde kullanılabilir.');
    }
    const flushed = await flush();
    if (flushed && flushed.ok === false) {
      return { ok: false, code: flushed.error?.code || 'FLUSH_FAILED', message: flushed.error?.message || 'Bekleyen değişiklikler kaydedilemedi.' };
    }
    const result = await decideCoordination(coordinationId, input);
    if (!result?.ok) {
      if (AMBIGUOUS_OUTCOME_CODES.has(result?.code)) {
        const reload = await reloadData({ preserveFailedTaskUpdates: true });
        const observed = reload?.ok !== false ? findCoordinationInSnapshot(reload, coordinationId) : null;
        // Kesin uzlaştırma yalnızca karar sonrası farklı bir sunucu sürümü
        // gözlendiğinde kabul edilir; karar öncesi erken okuma uzlaşmış sayılmaz.
        const versionAdvanced = Boolean(
          observed && observed.version && (!input?.version || observed.version !== input.version)
        );
        const reconciled = reload?.ok !== false && versionAdvanced;
        return {
          ok: false,
          code: 'OUTCOME_UNKNOWN',
          message: reconciled ? OUTCOME_UNKNOWN_MESSAGE : OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE,
          reconciled,
          ...(reconciled ? { record: observed } : {})
        };
      }
      // Sürüm çakışmasında elde tutulan kayıt bayattır; güncel hâli okunur.
      if (result?.code === 'CONFLICT') await reloadData({ preserveFailedTaskUpdates: true });
      return result;
    }
    const reload = await reloadData({ preserveFailedTaskUpdates: true });
    return reload?.ok === false ? { ...result, refreshError: refreshFailure(reload) } : result;
  }

  return { markNotifications, decideAssignmentCoordination };
}
