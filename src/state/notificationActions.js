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

/** Sonucu bilinmeyen bir yazma: istek gitti ama yanıt gelmedi. */
export const OUTCOME_UNKNOWN_MESSAGE = 'Sunucudan yanıt alınamadı; kararın kaydedilip kaydedilmediği doğrulanamadı. '
  + 'Güncel durum yeniden yüklendi; kaydı kontrol etmeden yeniden karar vermeyin.';
export const OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE = 'Sunucudan yanıt alınamadı; kararın kaydedilip kaydedilmediği doğrulanamadı '
  + 've güncel durum da yüklenemedi. Verileri yenileyip kaydı kontrol etmeden yeniden karar vermeyin.';

function actualModeFailure(operation, message) {
  return { ok: false, code: 'ACTUAL_MODE_REQUIRED', message, error: { kind: 'persistence', code: 'ACTUAL_MODE_REQUIRED', message, operation } };
}

function refreshFailure(reload) {
  return reload?.error || { code: reload?.code || 'REFRESH_FAILED', message: reload?.message || 'Veriler yenilenemedi.' };
}

export function createNotificationActions({
  isActualMode,
  flush,
  reloadData,
  applyStateAction,
  beginInboxRead,
  markItems,
  decideCoordination
}) {
  /**
   * Okundu / temizlendi.
   *
   * Sunucu güncel zil kutusunu aynı işlemde döndürür; yalnızca o uygulanır.
   * Okundu işareti görevleri değiştirmediği için tam anlık görüntü OKUNMAZ.
   * Eski bir sunucu kutuyu döndürmezse olağan yenilemeye düşülür.
   */
  async function markNotifications(items = [], action = 'read') {
    if (!isActualMode()) return actualModeFailure('notifications/mark', 'Bildirimler yalnızca Gerçek Sistem kipinde işaretlenebilir.');
    const notifications = items.filter((item) => item && SOURCES.has(item.source));
    if (!notifications.length) return { ok: true, value: { ok: true } };
    const inboxSequence = beginInboxRead();
    const result = await markItems(notifications, action);
    if (!result?.ok) return result;
    if (result.value?.inbox) {
      applyStateAction({ type: 'notifications/inbox-refreshed', inbox: result.value.inbox, inboxSequence });
      return result;
    }
    const reload = await reloadData({ preserveFailedTaskUpdates: true });
    return reload?.ok === false ? { ...result, refreshError: refreshFailure(reload) } : result;
  }

  /**
   * Atama koordinasyonu kararı.
   *
   * Başarı ancak sunucu işlemi kaydettikten sonra bildirilir; ardından görev
   * ve zil, karardan SONRA başlayan bir okumayla uzlaştırılır. Uzlaştırma
   * başarısızsa sonuç `refreshError` taşır ve arayüz bunu başarılı eşitleme
   * gibi göstermez. Yanıt alınamadıysa (zaman aşımı, kopan bağlantı) istek
   * YENİDEN GÖNDERİLMEZ: önce güncel durum okunur; sunucudaki sürüm denetimi
   * de aynı kararın ikinci kez uygulanmasını zaten engeller.
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
      if (result?.code === 'NETWORK') {
        const reload = await reloadData({ preserveFailedTaskUpdates: true });
        const reconciled = reload?.ok !== false;
        return {
          ok: false,
          code: 'OUTCOME_UNKNOWN',
          message: reconciled ? OUTCOME_UNKNOWN_MESSAGE : OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE,
          reconciled
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
