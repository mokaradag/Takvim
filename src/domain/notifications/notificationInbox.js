/**
 * Zil bildirim merkezinin BİRLEŞİK modeli.
 *
 * Zil tektir: tarih değişikliği talebi, atama koordinasyonu ve atama olayı aynı
 * listede, aynı okundu/temizlendi sürüm anlambilimiyle gösterilir. Her kaynak
 * kendi kalıcı tablosunda kalır; burada yalnızca ortak sıralama ve önizleme
 * kuralı vardır.
 */

export const NOTIFICATION_SOURCES = Object.freeze({
  SCHEDULE_REQUEST: 'SCHEDULE_REQUEST',
  ASSIGNMENT_COORDINATION: 'ASSIGNMENT_COORDINATION',
  TASK_EVENT: 'TASK_EVENT'
});

export const TASK_NOTIFICATION_KINDS = Object.freeze({
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_UNASSIGNED: 'TASK_UNASSIGNED'
});

/** Zil en fazla bu kadar önizleme taşır; geçmiş ayrı sayfada yüklenir. */
export const NOTIFICATION_PREVIEW_LIMIT = 8;

function timeValue(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Karar bekleyen kayıt önce; sonra en yeni olay.
 *
 * Eşitlikte ek bir anahtar ARANMAZ: her kaynak sunucudan zaten belirlenimci
 * sırayla gelir ve `Array.prototype.sort` kararlıdır; böylece birleştirme
 * kaynakların kendi sırasını bozmaz.
 */
export function compareNotifications(left, right) {
  const actionable = Number(Boolean(right?.actionable)) - Number(Boolean(left?.actionable));
  if (actionable) return actionable;
  return timeValue(right?.sortAt) - timeValue(left?.sortAt);
}

/**
 * Kaynakların önizlemelerini tek listeye indirir.
 *
 * Her kaynak zaten sunucuda sınırlı sayıda satır döndürür; burada yalnızca
 * birleştirme ve kırpma yapılır — ek istek ya da tam geçmiş yüklemesi yoktur.
 */
export function mergeNotificationPreviews(sources = [], limit = NOTIFICATION_PREVIEW_LIMIT) {
  const merged = [];
  for (const items of sources) {
    for (const item of items || []) if (item) merged.push(item);
  }
  return merged.sort(compareNotifications).slice(0, Math.max(0, limit));
}

/** Rozet sayısı bütün kaynakların okunmamış toplamıdır. */
export function totalNotificationCounts(summaries = []) {
  return summaries.reduce((total, summary) => ({
    unreadCount: total.unreadCount + Number(summary?.unreadCount || 0),
    pendingCount: total.pendingCount + Number(summary?.pendingCount || 0)
  }), { unreadCount: 0, pendingCount: 0 });
}
