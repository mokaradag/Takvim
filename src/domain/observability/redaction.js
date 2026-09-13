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

/**
 * Duyarlı alan adları TEK kaynakta tutulur: hem nesne anahtarı denetimi hem de
 * serileştirilmiş (JSON) gövde içindeki alan denetimi aynı listeyi kullanır.
 */
const SENSITIVE_KEY_SOURCE = 'password|passwd|secret|token|apikey|api_key|authorization|cookie|credential|connectionstring|connection_string|sessionid|session_id|jwt|bearer|privatekey|private_key|smtp_pass|pwd';

const SENSITIVE_KEY_PATTERN = new RegExp(`(${SENSITIVE_KEY_SOURCE})`, 'i');

const SENSITIVE_VALUE_PATTERNS = [
  /(?:password|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/i,
  /\b(?:Server|Data Source|Initial Catalog|User ID|Uid)\s*=\s*[^;]+;/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  // Tam `Authorization` başlığı satırı: şeması ne olursa olsun (Basic, Bearer,
  // Negotiate) değer taşınmaz.
  /\bauthorization\s*[:=]\s*\S+/i,
  // Başlıksız `Basic <base64>` belirteci. Düz İngilizce sözcükleri ("Basic
  // authentication") elemek için belirtecin base64 gibi görünmesi — yani
  // büyük/küçük harf karışık ya da rakamlı olması — aranır.
  /\bBasic\s+(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z0-9+/])[A-Za-z0-9+/]{8,}={0,2}/,
  // Serileştirilmiş kimlik alanı: `"authToken":"gizli"`.
  new RegExp(`"[A-Za-z0-9_.\\-]*(?:${SENSITIVE_KEY_SOURCE})[A-Za-z0-9_.\\-]*"\\s*:\\s*"[^"]*"`, 'i'),
  /\beyJ[A-Za-z0-9._-]{16,}\b/
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const MAX_TEXT_LENGTH = 500;
const MAX_DEPTH = 4;
const MAX_KEYS = 25;
const MAX_KEY_LENGTH = 120;

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
  // Uzun tanı metni desen taramasını büyütmez; kesilmiş kimlik bilgisi sızmaz.
  if (text.length > MAX_TEXT_LENGTH) return REDACTED;
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
  // Gezinme, gözlediği işlemi DÜŞÜRMEMELİDİR: fırlatan bir getter, iptal
  // edilmiş bir Proxy ya da bozuk bir `toString` yalnızca o dalı `null` yapar.
  // `queueOperationalEvent` bu çağrıyı kendi `try` bloğunun dışında yapar.
  try {
    return sanitizeContextValue(value, depth);
  } catch {
    return null;
  }
}

function sanitizeContextValue(value, depth) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  // `Number(bigint)` güvenli tam sayı sınırını aşan değerleri yuvarlar, yeterince
  // büyük olanı `Infinity` yapar ve JSON bunu `null`a çevirir. Ondalık metin
  // olarak taşımak tanı kimliğini bozmadan korur.
  if (typeof value === 'bigint') return value.toString();
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
    // ALAN ADI da temizlenir: serbest biçimli tanı bağlamında anahtar bir
    // e-posta adresi ya da kimlik bilgisi taşıyabilir ve bu ad günlüğe ve
    // kalıcı olay bağlamına olduğu gibi geçerdi. Duyarlılık denetimi ÖZGÜN
    // ad üzerinde yapılır: maskelenmiş ad desene uymayabilirdi.
    const safeKey = sanitizeText(key).slice(0, MAX_KEY_LENGTH) || REDACTED;
    output[safeKey] = isSensitiveKey(key) ? REDACTED : sanitizeContext(entry, depth + 1);
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
  try {
    if (!error) return null;
    if (typeof error === 'string') return { message: sanitizeText(error) };
    return {
      name: sanitizeText(error.name || 'Error').slice(0, 60),
      code: error.code == null ? null : sanitizeText(String(error.code)).slice(0, 60),
      message: sanitizeText(error.message || '')
    };
  } catch {
    return { name: 'Error', code: null, message: '' };
  }
}
