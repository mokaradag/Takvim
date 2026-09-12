/**
 * Yönetim konsolunun yenileme kuralları — SAF işlevler.
 *
 * Kurallar bileşenden ayrı tutulur ki tarayıcı olmadan sınanabilsinler:
 * üst üste binen istek olmaması, sekme gizliyken yoklamanın durması, dönüşte
 * bayat veriyi hemen tazelemek ve geçici bir hatanın SON GEÇERLİ durumu
 * silmemesi.
 */

/** Geçerli yenilemenin üzerinden geçen süre eşiği: aralığın üç katı. */
export const STALE_FACTOR = 3;

export function staleAfterMs(intervalMs) {
  return Math.max(15000, Math.trunc(Number(intervalMs) || 10000) * STALE_FACTOR);
}

/** Gizli sekmede yoklama yapılmaz; kapalı kaynak da yoklanmaz. */
export function shouldPoll({ hidden = false, enabled = true, inFlight = false } = {}) {
  return Boolean(enabled) && !hidden && !inFlight;
}

export function isDataStale({ lastUpdatedAt = null, now = Date.now(), intervalMs = 10000 } = {}) {
  if (lastUpdatedAt == null) return false;
  return now - lastUpdatedAt > staleAfterMs(intervalMs);
}

/** Sekmeye dönüldüğünde: veri bayatsa hemen yenilenir, tazeyse beklenir. */
export function shouldRefreshOnReturn({ hidden = false, lastUpdatedAt = null, now = Date.now(), intervalMs = 10000 } = {}) {
  if (hidden) return false;
  if (lastUpdatedAt == null) return true;
  return isDataStale({ lastUpdatedAt, now, intervalMs });
}

/**
 * Yanıtı geçerli duruma katar.
 *
 * Başarısız yanıt veriyi SİLMEZ: son bilinen değer kalır, üzerine hata bilgisi
 * eklenir ve tazelik damgası ilerletilmez. Böylece "son bilinen değer" ile
 * "şu anda sağlıklı" birbirine karışmaz.
 */
export function mergeResourceState(previous = {}, response = null, { now = Date.now() } = {}) {
  if (!response) return previous;
  if (response.ok) {
    return { data: response, error: null, lastUpdatedAt: now, failureCount: 0 };
  }
  return {
    data: previous.data ?? null,
    error: { code: response.code || 'REQUEST_FAILED', message: response.message || 'Veri alınamadı.' },
    lastUpdatedAt: previous.lastUpdatedAt ?? null,
    failureCount: (previous.failureCount || 0) + 1
  };
}
