/**
 * Sistem sağlığının TEK kaynağı.
 *
 * Durum anlamları, önceliği ve bayatlık kuralı burada tanımlanır; sunucu
 * (sağlık servisi, uyarı kuralları) ve istemci (Sistem Yönetimi konsolu) aynı
 * modülü kullanır. Kural iki katmanda ayrı ayrı yazılsaydı ekran, sunucunun
 * "Kritik" saydığı bir bileşeni "Dikkat" gösterebilirdi.
 *
 * Temel ilke: VERİ ALINAMAMASI SAĞLIK DEĞİLDİR. Ölçülemeyen bileşen
 * `UNKNOWN`, ölçülmüş ama eskimiş bilgi `stale` olarak taşınır.
 */

export const HEALTH_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN',
  /** Bileşen bilinçli olarak yapılandırılmamış: toplam sağlığı düşürmez. */
  NOT_CONFIGURED: 'NOT_CONFIGURED'
});

/** Toplama önceliği; büyük değer daha ağır basar. */
const HEALTH_WEIGHT = Object.freeze({
  [HEALTH_STATES.NOT_CONFIGURED]: 0,
  [HEALTH_STATES.HEALTHY]: 1,
  [HEALTH_STATES.UNKNOWN]: 2,
  [HEALTH_STATES.WARNING]: 3,
  [HEALTH_STATES.CRITICAL]: 4
});

export const HEALTH_LABELS = Object.freeze({
  [HEALTH_STATES.HEALTHY]: 'Sağlıklı',
  [HEALTH_STATES.WARNING]: 'Dikkat',
  [HEALTH_STATES.CRITICAL]: 'Kritik',
  [HEALTH_STATES.UNKNOWN]: 'Bilinmiyor',
  [HEALTH_STATES.NOT_CONFIGURED]: 'Yapılandırılmamış'
});

/** Bileşen yanıtının en fazla ne kadar eskiyebileceği (ms). */
export const DEFAULT_STALE_AFTER_MS = 90000;

export function isHealthState(value) {
  return Object.hasOwn(HEALTH_WEIGHT, String(value ?? ''));
}

export function normalizeHealthState(value) {
  return isHealthState(value) ? String(value) : HEALTH_STATES.UNKNOWN;
}

export function healthLabel(state) {
  return HEALTH_LABELS[normalizeHealthState(state)];
}

export function healthWeight(state) {
  return HEALTH_WEIGHT[normalizeHealthState(state)];
}

/** İki durumdan daha ağır olanı. */
export function worseHealthState(left, right) {
  return healthWeight(left) >= healthWeight(right) ? normalizeHealthState(left) : normalizeHealthState(right);
}

/**
 * Bileşen durumlarından genel durumu türetir.
 *
 * Yapılandırılmamış bileşenler toplamaya KATILMAZ; hiç ölçülebilir bileşen
 * yoksa sonuç `UNKNOWN` olur — boş liste "sağlıklı" değildir.
 */
export function aggregateHealthState(components = []) {
  const states = components
    .map((component) => normalizeHealthState(component?.state))
    .filter((state) => state !== HEALTH_STATES.NOT_CONFIGURED);
  if (!states.length) return HEALTH_STATES.UNKNOWN;
  return states.reduce(worseHealthState, HEALTH_STATES.HEALTHY);
}

/** Genel durum + sayımlar. Başlık şeridi ve genel bakış aynı özeti kullanır. */
export function summarizeHealth(components = []) {
  const counts = {
    total: components.length,
    healthy: 0,
    warning: 0,
    critical: 0,
    unknown: 0,
    notConfigured: 0
  };
  for (const component of components) {
    const state = normalizeHealthState(component?.state);
    if (state === HEALTH_STATES.HEALTHY) counts.healthy += 1;
    else if (state === HEALTH_STATES.WARNING) counts.warning += 1;
    else if (state === HEALTH_STATES.CRITICAL) counts.critical += 1;
    else if (state === HEALTH_STATES.NOT_CONFIGURED) counts.notConfigured += 1;
    else counts.unknown += 1;
  }
  return { state: aggregateHealthState(components), counts };
}

/**
 * Bilgi bayatladı mı?
 *
 * `observedAt` yoksa bayatlık KARARI VERİLEMEZ: `null` döner ve çağıran bunu
 * "bilinmiyor" olarak gösterir; "taze" saymaz.
 */
export function isStale(observedAt, now = Date.now(), maxAgeMs = DEFAULT_STALE_AFTER_MS) {
  const observed = toEpochMs(observedAt);
  if (observed == null) return null;
  const reference = toEpochMs(now) ?? Date.now();
  return reference - observed > Math.max(0, Number(maxAgeMs) || 0);
}

/** ISO metin, `Date` ya da sayıyı epoch milisaniyeye çevirir. */
export function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/**
 * Bir bileşen tanımını kanonikleştirir.
 *
 * Sunucu bileşeni `state` olmadan bildirdiyse sonuç `UNKNOWN`'dır. Bayat
 * bilgi taşıyan SAĞLIKLI bileşen `stale` bayrağını korur ama durumu
 * düşürülmez: son bilinen değer ile şu anki sağlık ayrı bilgilerdir.
 */
export function describeComponent(component = {}, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const state = normalizeHealthState(component.state);
  const observedAt = component.lastCheckedAt ?? component.lastSuccessAt ?? null;
  const stale = isStale(observedAt, now, staleAfterMs);
  return {
    key: String(component.key || ''),
    label: String(component.label || ''),
    state,
    stateLabel: healthLabel(state),
    message: component.message || '',
    lastSuccessAt: component.lastSuccessAt ?? null,
    lastCheckedAt: component.lastCheckedAt ?? null,
    durationMs: Number.isFinite(component.durationMs) ? component.durationMs : null,
    stale: stale === true,
    staleness: stale,
    tab: component.tab || null,
    detail: component.detail || null
  };
}
