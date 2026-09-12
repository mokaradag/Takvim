/**
 * Tanı verisinin temizlenmesi.
 *
 * Gözlemlenebilirlik, gizli bilgiyi yönetici ekranına ya da günlüğe taşıyan
 * yeni bir sızıntı yolu OLMAMALIDIR. Bu modül tek kanonik temizleyicidir:
 * yapılandırılmış günlükler, kalıcı olay bağlamı ve uç yanıtları aynı kuralı
 * kullanır.
 *
 * Kural iki yönlüdür:
 *  - ADI duyarlı olan alanlar değerine bakılmadan maskelenir,
 *  - DEĞERİ duyarlı desene uyan metinler (bağlantı dizesi, jeton, e-posta,
 *    `Authorization` başlığı) anahtarı masum olsa da maskelenir.
 */

export const REDACTED = '[gizlendi]';

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|apikey|api_key|authorization|cookie|credential|connectionstring|connection_string|sessionid|session_id|jwt|bearer|privatekey|private_key|smtp_pass|pwd)/i;

const SENSITIVE_VALUE_PATTERNS = [
  /(?:password|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/i,
  /\b(?:Server|Data Source|Initial Catalog|User ID|Uid)\s*=\s*[^;]+;/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\beyJ[A-Za-z0-9._-]{16,}\b/
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const MAX_TEXT_LENGTH = 500;
const MAX_DEPTH = 4;
const MAX_KEYS = 25;

/** Adres yerel kısmının yalnızca ilk harfi bırakılır; posta kutusu açığa çıkmaz. */
export function maskEmailAddresses(text) {
  return String(text).replace(EMAIL_PATTERN, (address) => {
    const [local, domain] = address.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  });
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key ?? ''));
}

/** Metin içeriğini temizler: gizli desenler ve e-posta adresleri maskelenir. */
export function sanitizeText(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return REDACTED;
  return maskEmailAddresses(text).slice(0, MAX_TEXT_LENGTH);
}

/**
 * Serbest biçimli tanı bağlamını temizler.
 *
 * Derinlik, anahtar sayısı ve metin uzunluğu SINIRLIDIR: telemetri, ham istek
 * gövdesi taşıyarak kendisi bir sorun kaynağına dönüşmemelidir.
 */
export function sanitizeContext(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return sanitizeText(value);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((entry) => sanitizeContext(entry, depth + 1));
  }
  if (typeof value !== 'object') return null;

  const output = {};
  let written = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (written >= MAX_KEYS) break;
    written += 1;
    output[key] = isSensitiveKey(key) ? REDACTED : sanitizeContext(entry, depth + 1);
  }
  return output;
}

/**
 * Hatadan GÜVENLİ tanı özeti üretir.
 *
 * Yığın izi (stack) taşınmaz: dosya yolları ve sorgu metinleri sızabilir.
 * Yalnızca hata türü, kararlı kod ve temizlenmiş ileti kalır.
 */
export function sanitizeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: sanitizeText(error) };
  return {
    name: sanitizeText(error.name || 'Error').slice(0, 60),
    code: error.code == null ? null : sanitizeText(String(error.code)).slice(0, 60),
    message: sanitizeText(error.message || '')
  };
}
