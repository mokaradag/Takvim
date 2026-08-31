export const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 60000;
export const MIN_AUTO_REFRESH_INTERVAL_MS = 30000;
export const MAX_AUTO_REFRESH_INTERVAL_MS = 2147483647;

/** Otomatik yenileme aralığını güvenli dağıtım sınırları içinde çözer. */
export function resolveAutomaticDataRefreshInterval(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return DEFAULT_AUTO_REFRESH_INTERVAL_MS;
  const parsed = Number(String(rawValue).trim());
  return Number.isSafeInteger(parsed)
    && parsed >= MIN_AUTO_REFRESH_INTERVAL_MS
    && parsed <= MAX_AUTO_REFRESH_INTERVAL_MS
    ? parsed
    : DEFAULT_AUTO_REFRESH_INTERVAL_MS;
}

/** Tarayıcı paketine gömülen, gizli olmayan yenileme aralığını okur. */
export function automaticDataRefreshInterval() {
  return resolveAutomaticDataRefreshInterval(
    process.env.NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS
  );
}

/** Bellek içi Demo deposu için gereksiz yoklama döngüsü kurulmaz. */
export function supportsAutomaticDataRefresh(repository) {
  return repository?.kind === 'actual-api' || repository?.kind === 'sql-server';
}

/** Kimlik ve yetki kaybı sessiz arka plan hatası olarak gizlenemez. */
export function shouldSurfaceAutomaticRefreshFailure(error) {
  return ['SESSION_REQUIRED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(String(error?.code || ''));
}

function timestampOf(value) {
  if (value == null || value === '') return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timestampNoLaterThan(value, upperBound) {
  const timestamp = typeof value === 'number' ? value : timestampOf(value);
  return Number.isFinite(timestamp) && timestamp <= upperBound ? timestamp : null;
}

/**
 * Görünürlük duyarlı, tek uçuşlu ve kendini zamanlayan veri yenileme döngüsü.
 *
 * Başarısız veya güvenlik nedeniyle atlanan denemeler de bir sonraki denemeden
 * önce tam aralık bekler; böylece eski veri sıkı bir yeniden deneme döngüsüne
 * dönüşmez.
 */
export function createAutomaticDataRefreshController({
  intervalMs = DEFAULT_AUTO_REFRESH_INTERVAL_MS,
  refresh,
  getLastRefreshedAt = () => null,
  visibilitySource = typeof document === 'undefined' ? null : document,
  timerApi = globalThis,
  now = () => Date.now()
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('Otomatik yenileme işlevi gereklidir.');
  const safeIntervalMs = resolveAutomaticDataRefreshInterval(intervalMs);
  let started = false;
  let timerId = null;
  let refreshInFlight = false;
  let firstStartedAt = null;
  let lastAttemptAt = null;
  let lastSuccessfulAt = null;

  const isVisible = () => visibilitySource?.visibilityState !== 'hidden';

  function clearTimer() {
    if (timerId == null) return;
    timerApi.clearTimeout(timerId);
    timerId = null;
  }

  function latestDataTimestamp(currentTime) {
    const refreshedAt = Math.max(
      timestampNoLaterThan(getLastRefreshedAt(), currentTime) ?? Number.NEGATIVE_INFINITY,
      timestampNoLaterThan(lastSuccessfulAt, currentTime) ?? Number.NEGATIVE_INFINITY
    );
    if (Number.isFinite(refreshedAt)) return refreshedAt;
    const boundedFirstStartedAt = timestampNoLaterThan(firstStartedAt, currentTime);
    if (boundedFirstStartedAt != null) return boundedFirstStartedAt;
    firstStartedAt = currentTime;
    return currentTime;
  }

  function nextDueAt(currentTime) {
    const dataDueAt = latestDataTimestamp(currentTime) + safeIntervalMs;
    const boundedLastAttemptAt = timestampNoLaterThan(lastAttemptAt, currentTime);
    const retryDueAt = boundedLastAttemptAt == null
      ? Number.NEGATIVE_INFINITY
      : boundedLastAttemptAt + safeIntervalMs;
    return Math.max(dataDueAt, retryDueAt);
  }

  function scheduleNext() {
    clearTimer();
    if (!started || !isVisible() || refreshInFlight) return;
    const currentTime = now();
    const delay = Math.min(
      MAX_AUTO_REFRESH_INTERVAL_MS,
      Math.max(0, nextDueAt(currentTime) - currentTime)
    );
    timerId = timerApi.setTimeout(() => {
      timerId = null;
      void refreshIfDue();
    }, delay);
  }

  async function refreshIfDue() {
    if (!started || !isVisible() || refreshInFlight) return;
    const currentTime = now();
    if (currentTime < nextDueAt(currentTime)) {
      scheduleNext();
      return;
    }

    refreshInFlight = true;
    lastAttemptAt = now();
    try {
      const result = await refresh();
      if (result?.ok && !result?.skipped) lastSuccessfulAt = now();
    } catch {
      // Yaşam döngüsü hatayı kendi durum kanalında işler; zamanlayıcı çökmemelidir.
    } finally {
      refreshInFlight = false;
      scheduleNext();
    }
  }

  function handleVisibilityChange() {
    if (!isVisible()) {
      clearTimer();
      return;
    }
    const currentTime = now();
    if (currentTime >= nextDueAt(currentTime)) void refreshIfDue();
    else scheduleNext();
  }

  function start() {
    if (started) return;
    started = true;
    if (firstStartedAt == null) firstStartedAt = now();
    visibilitySource?.addEventListener?.('visibilitychange', handleVisibilityChange);
    scheduleNext();
  }

  function stop() {
    if (!started) return;
    started = false;
    clearTimer();
    visibilitySource?.removeEventListener?.('visibilitychange', handleVisibilityChange);
  }

  return { start, stop };
}
