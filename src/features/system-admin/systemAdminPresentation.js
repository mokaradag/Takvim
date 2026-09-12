import { HEALTH_STATES, healthLabel, normalizeHealthState } from '../../domain/observability/healthModel.js';
import {
  ALERT_STATE_LABELS,
  EVENT_SEVERITIES,
  normalizeSeverity,
  severityLabel
} from '../../domain/observability/eventModel.js';
import { formatDuration, formatPercent, formatRelativeTime } from '../../domain/observability/metrics.js';

/**
 * Yönetim konsolunun sunum yardımcıları — SAF işlevler.
 *
 * Durum anlamları burada YENİDEN tanımlanmaz; ortak sağlık modelinden okunur
 * ve yalnızca görsel karşılıkları (sınıf adı, açıklama) üretilir.
 */

const HEALTH_TONE = Object.freeze({
  [HEALTH_STATES.HEALTHY]: 'ok',
  [HEALTH_STATES.WARNING]: 'warn',
  [HEALTH_STATES.CRITICAL]: 'crit',
  [HEALTH_STATES.UNKNOWN]: 'unknown',
  [HEALTH_STATES.NOT_CONFIGURED]: 'idle'
});

const SEVERITY_TONE = Object.freeze({
  [EVENT_SEVERITIES.INFO]: 'info',
  [EVENT_SEVERITIES.WARNING]: 'warn',
  [EVENT_SEVERITIES.ERROR]: 'crit',
  [EVENT_SEVERITIES.CRITICAL]: 'crit'
});

export function healthTone(state) {
  return HEALTH_TONE[normalizeHealthState(state)];
}

export function severityTone(severity) {
  return SEVERITY_TONE[normalizeSeverity(severity)];
}

export function alertStateLabel(state) {
  return ALERT_STATE_LABELS[String(state ?? '')] || 'Açık';
}

/**
 * Genel durumun bir cümlelik açıklaması.
 *
 * Veri yokluğu SAĞLIK DEĞİLDİR: bilinmeyen durum açıkça söylenir.
 */
export function healthNarrative({ state, counts = {}, attentionCount = 0 } = {}) {
  const normalized = normalizeHealthState(state);
  const measured = (counts.healthy || 0) + (counts.warning || 0) + (counts.critical || 0) + (counts.unknown || 0);
  if (normalized === HEALTH_STATES.CRITICAL) {
    return `${counts.critical || 0} bileşen kritik durumda. Öncelikli ${attentionCount} kaydı inceleyin.`;
  }
  if (normalized === HEALTH_STATES.WARNING) {
    return `${counts.warning || 0} bileşen dikkat istiyor; kritik bileşen yok.`;
  }
  if (normalized === HEALTH_STATES.UNKNOWN) {
    return `${counts.unknown || 0} bileşenin durumu ölçülemedi. Ölçülemeyen bileşen sağlıklı sayılmaz.`;
  }
  return `${counts.healthy || 0}/${measured} bileşen sağlıklı.`;
}

/** Bayat veriye ilişkin kullanıcı iletisi; boşsa uyarı gösterilmez. */
export function stalenessNotice({ stale = false, lastUpdatedAt = null, error = null, now = Date.now() } = {}) {
  if (error && lastUpdatedAt) {
    return `Son yenileme başarısız (${error.code}). Ekranda ${formatRelativeTime(lastUpdatedAt, now)} alınan son geçerli bilgi duruyor.`;
  }
  if (error) return `Bilgi alınamadı (${error.code}). Sistem durumu bilinmiyor.`;
  if (stale && lastUpdatedAt) {
    return `Bilgi ${formatRelativeTime(lastUpdatedAt, now)} güncellendi ve bayatladı.`;
  }
  return '';
}

/** Ölçüm değerini birimine göre yazar; ölçülemeyen değer "—" olur. */
export function formatMetricValue(value, unit) {
  // Hazır biçimlenmiş metinler olduğu gibi gösterilir; sayı gibi yorumlanmaz.
  if (unit === 'raw') return value == null || value === '' ? '—' : String(value);
  if (value == null || !Number.isFinite(Number(value))) return '—';
  if (unit === 'ms') return formatDuration(value);
  if (unit === 'ratio') return formatPercent(value);
  if (unit === '%') return `%${Number(value).toFixed(1)}`;
  if (unit === 'count') return new Intl.NumberFormat('tr-TR').format(Math.round(Number(value)));
  return String(value);
}

/** Temel karşılaştırmasının okunur özeti. */
export function baselineNarrative(comparison, { unit = 'ms' } = {}) {
  if (!comparison) return '';
  const change = Math.round(comparison.changeRatio * 100);
  const direction = comparison.direction === 'up' ? '+' : '';
  return `7 günlük baz: ${formatMetricValue(comparison.baseline, unit)} · ${direction}${change}%`;
}

/** Bileşen/uyarı ağırlığına göre sıralama anahtarı (büyük değer önce gösterilir). */
export function attentionSortKey(item) {
  const severity = normalizeSeverity(item?.severity);
  const weight = severity === EVENT_SEVERITIES.CRITICAL ? 4
    : severity === EVENT_SEVERITIES.ERROR ? 3
      : severity === EVENT_SEVERITIES.WARNING ? 2 : 1;
  return { weight, at: new Date(item?.lastSeenAt || 0).getTime() };
}

export { healthLabel, severityLabel, formatRelativeTime };
