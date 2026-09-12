import 'server-only';

/**
 * Gözlemlenebilirlik yapılandırması.
 *
 * Ortam değişkeni SAYISI bilinçli olarak azdır: yalnızca dağıtımdan dağıtıma
 * gerçekten değişen değerler dışarı açılır. Hepsinin makul bir varsayılanı
 * vardır, hepsi sınırlanır ve HİÇBİRİ `NEXT_PUBLIC_` ön eki taşımaz — yönetim
 * konsolu bu değerleri yalnızca yetkili uçtan öğrenir.
 */

function booleanValue(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  if (/^(1|true|yes|evet)$/i.test(text)) return true;
  if (/^(0|false|no|hayir|hayır)$/i.test(text)) return false;
  return fallback;
}

function numberValue(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function integerValue(name, fallback, bounds) {
  return Math.trunc(numberValue(name, fallback, bounds));
}

/** Telemetri toplama ve kalıcılaştırma açık mı? */
export function isTelemetryEnabled() {
  return booleanValue('MERGEN_ROTA_TELEMETRY_ENABLED', true);
}

/** Kalıcı eğilim verisinin saklama süresi (gün). */
export function telemetryRetentionDays() {
  return integerValue('MERGEN_ROTA_TELEMETRY_RETENTION_DAYS', 30, { min: 1, max: 365 });
}

/** Yönetim konsolunun sağlık yoklama aralığı (ms). */
export function adminRefreshIntervalMs() {
  return integerValue('MERGEN_ROTA_ADMIN_REFRESH_INTERVAL_MS', 10000, { min: 5000, max: 120000 });
}

/** P95 gecikme uyarı eşiği (ms). */
export function latencyAlertThresholdMs() {
  return integerValue('MERGEN_ROTA_ALERT_P95_MS', 1500, { min: 100, max: 60000 });
}

/** Uç hata oranı uyarı eşiği (0–1). */
export function errorRateAlertThreshold() {
  return numberValue('MERGEN_ROTA_ALERT_ERROR_RATE', 0.05, { min: 0.001, max: 1 });
}

/** Outlook kuyruğunda beklemenin uyarı eşiği (dakika). */
export function queueAgeAlertMinutes() {
  return integerValue('MERGEN_ROTA_ALERT_QUEUE_AGE_MINUTES', 15, { min: 1, max: 1440 });
}

/** CN43N eşitlemesinin bayat sayılacağı süre (saat). */
export function corporateSyncStaleHours() {
  return integerValue('MERGEN_ROTA_ALERT_WBS_STALE_HOURS', 24, { min: 1, max: 720 });
}

/** Değerlendirme ve yazma turunun sıklığı. Dağıtımdan dağıtıma değişmez. */
export const TELEMETRY_FLUSH_INTERVAL_MS = 60000;

/** Uyarı açmadan önce koşulun üst üste kaç turda görülmesi gerektiği. */
export const ALERT_CONSECUTIVE_OBSERVATIONS = 2;

/** Bir turda silinecek en çok satır (saklama sınırı). */
export const RETENTION_BATCH_SIZE = 5000;

/** Süreç belleği uyarı eşiği: yığın kullanım oranı. */
export const MEMORY_PRESSURE_RATIO = 0.9;

/** Yapılandırmanın tamamı — yönetim konsoluna güvenli biçimde bildirilir. */
export function observabilityConfiguration() {
  return Object.freeze({
    telemetryEnabled: isTelemetryEnabled(),
    retentionDays: telemetryRetentionDays(),
    refreshIntervalMs: adminRefreshIntervalMs(),
    thresholds: Object.freeze({
      latencyP95Ms: latencyAlertThresholdMs(),
      errorRate: errorRateAlertThreshold(),
      queueAgeMinutes: queueAgeAlertMinutes(),
      corporateSyncStaleHours: corporateSyncStaleHours(),
      memoryPressureRatio: MEMORY_PRESSURE_RATIO
    })
  });
}
