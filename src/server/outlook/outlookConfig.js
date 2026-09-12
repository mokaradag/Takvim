import 'server-only';
import { publicRotaPath } from '../../lib/publicPath.js';

/**
 * Outlook takvim tümleştirmesinin yapılandırması — YALNIZCA sunucu tarafı.
 *
 * SMTP ayarları yeniden kullanılır; burada yalnızca özelliğe ait birkaç sınır
 * tanımlanır. Hiçbir değer `NEXT_PUBLIC_` ön eki taşımaz ve hiçbiri gizli bilgi
 * değildir.
 */

let reportedInvalidOrigin = '';

function booleanValue(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  if (/^(1|true|yes|evet)$/i.test(text)) return true;
  if (/^(0|false|no|hayir|hayır)$/i.test(text)) return false;
  return false;
}

function integerValue(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isLocalDevelopmentHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function safeWebOrigin(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return parsed.origin;
    if (parsed.protocol === 'http:' && isLocalDevelopmentHost(parsed.hostname)) return parsed.origin;
    return '';
  } catch {
    return '';
  }
}

function reportInvalidPublicOrigin(configured) {
  const key = String(configured || '').trim();
  if (!key || reportedInvalidOrigin === key) return;
  reportedInvalidOrigin = key;
  console.error('[outlook] MERGEN_ROTA_PUBLIC_ORIGIN geçersiz', {
    code: 'OUTLOOK_PUBLIC_ORIGIN_INVALID',
    requirement: 'Üretimde HTTPS; HTTP yalnız localhost/loopback geliştirmede kabul edilir.'
  });
}

/**
 * Tek istekte Outlook'a eklenebilecek EN ÇOK görev sayısı.
 *
 * Varsayılan 25'tir: her görev kendi SMTP iletisini alır ve kurumsal sunucu
 * tek bir kullanıcı isteği yüzünden onlarca eşzamanlı teslimatla
 * yüklenmemelidir. Üst sınır 50'de tutulur.
 */
export function outlookBulkLimit() {
  return integerValue('MERGEN_ROTA_OUTLOOK_BULK_LIMIT', 25, { min: 1, max: 50 });
}

/** Zamanlanmış turda tek seferde işlenecek bekleyen teslimat sayısı. */
export function outlookOutboxBatchSize() {
  return integerValue('MERGEN_ROTA_OUTLOOK_OUTBOX_BATCH', 25, { min: 1, max: 200 });
}

/** Kalıcı sağlık hatası bildirilmeye başlanacak deneme sayısı. */
export function outlookMaxAttempts() {
  return integerValue('MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS', 6, { min: 1, max: 20 });
}

export function outlookRunBudgetMs() {
  return integerValue('MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS', 45000, { min: 1000, max: 240000 });
}

export function outlookPollIntervalMs() {
  return integerValue('MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS', 5000, { min: 1000, max: 60000 });
}

/** Özellik açık mı? Kapalıyken uçlar 403 döner ve arayüz eylemi göstermez. */
export function isOutlookCalendarEnabled() {
  return booleanValue('MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED', true);
}

/**
 * Başarısız denemenin bir sonraki hakkı (saniye).
 *
 * Üstel geri çekilme: 1, 2, 4, 8 … dakika, en çok bir saat.
 */
export function outlookRetryDelaySeconds(attemptCount) {
  const attempt = Math.max(1, Math.trunc(Number(attemptCount) || 1));
  return Math.min(3600, 60 * (2 ** Math.min(attempt - 1, 6)));
}

/**
 * Uygulamaya dönüş bağlantısı.
 *
 * Üretim adresi KODA GÖMÜLMEZ: kanonik ön ek `publicRotaPath` ile, köken ise
 * ya sunucu tarafı `MERGEN_ROTA_PUBLIC_ORIGIN` ile ya da isteğin kendi
 * kökeniyle çözülür (Keycloak implicit yönlendirmesiyle aynı ilke). Dağıtılmış
 * ortamlarda HTTPS zorunludur; düz HTTP yalnız localhost/loopback geliştirme
 * kökenleri için kabul edilir. Geçersiz yapılandırılmış köken güvenli istek
 * kökenine düşebilir ama sunucu günlüğüne açık yapılandırma hatası yazılır.
 *
 * @param {string|URL|null} requestUrl istekten türetilecek köken
 * @returns {string|null} tam adres ya da köken bilinmiyorsa `null`
 */
export function outlookApplicationLink(requestUrl = null) {
  const configured = String(process.env.MERGEN_ROTA_PUBLIC_ORIGIN ?? '').trim();
  let origin = '';
  if (configured) {
    origin = safeWebOrigin(configured);
    if (!origin) reportInvalidPublicOrigin(configured);
    else reportedInvalidOrigin = '';
  } else {
    reportedInvalidOrigin = '';
  }
  if (!origin && requestUrl) origin = safeWebOrigin(requestUrl);
  if (!origin) return null;
  return `${origin}${publicRotaPath('/')}`;
}
