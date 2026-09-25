/**
 * Yapay zekâ kimlik bilgisi kuralları — saf, sunucu ile istemcinin ortak kaynağı.
 *
 * Çözümleme kuralı tektir: Sicil'in kişisel anahtarı VARSA o kullanılır;
 * yoksa kurumsal varsayılan anahtar; ikisi de yoksa anahtar eksiktir. Kişisel
 * anahtarın başarısızlığı (401, 403, 429, zaman aşımı, ağ hatası) kurumsal
 * anahtara geçiş nedeni DEĞİLDİR; bu işlevler yalnızca VARLIĞA bakar.
 */

export const AI_CREDENTIAL_SOURCES = Object.freeze({
  PERSONAL: 'personal',
  DEFAULT: 'default',
  MISSING: 'missing'
});

const AI_CREDENTIAL_SOURCE_LABELS = Object.freeze({
  [AI_CREDENTIAL_SOURCES.PERSONAL]: 'Kişisel anahtar',
  [AI_CREDENTIAL_SOURCES.DEFAULT]: 'Kurumsal anahtar',
  [AI_CREDENTIAL_SOURCES.MISSING]: 'Anahtar yok'
});

/** Açık doğrulamanın kalıcı sonucu; erişilemeyen sağlayıcı sonuç ÜRETMEZ. */
export const AI_CREDENTIAL_VALIDATION = Object.freeze({
  VALID: 'VALID',
  REJECTED: 'REJECTED',
  FORBIDDEN: 'FORBIDDEN'
});

export const API_KEY_MIN_LENGTH = 16;
export const API_KEY_MAX_LENGTH = 512;

/**
 * Anahtar durumunu okuma, kaydetme ve kaldırma işlemlerinin sunucudaki
 * uçtan uca süre sınırı (SQL + model kaydı). İstemci süresi bundan uzundur:
 * sonucu sunucu belirler, tarayıcı sunucudan önce vazgeçmez.
 */
export const AI_CREDENTIAL_OPERATION_TIMEOUT_MS = 15000;

/**
 * Kayıtlı anahtar kullanılamıyorsa nedeni; tarayıcı doğru açıklamayı seçer.
 * `AI_DISABLED`: özellik kapalıyken okunabilirlik sınanmaz (künye korunur).
 * `RECORD_INVALID`: şifreli kayıt doğrulama etiketinden geçmedi (bozuk kayıt).
 */
export const AI_CREDENTIAL_UNREADABLE_REASONS = Object.freeze({
  AI_DISABLED: 'AI_DISABLED',
  PERSONAL_KEYS_DISABLED: 'PERSONAL_KEYS_DISABLED',
  MASTER_KEY_CHANGED: 'MASTER_KEY_CHANGED',
  RECORD_INVALID: 'RECORD_INVALID'
});

const API_KEY_FORMAT_MESSAGES = Object.freeze({
  EMPTY: 'API anahtarı boş olamaz.',
  TOO_SHORT: `API anahtarı en az ${API_KEY_MIN_LENGTH} karakter olmalıdır.`,
  TOO_LONG: `API anahtarı en fazla ${API_KEY_MAX_LENGTH} karakter olabilir.`,
  INVALID_CHARACTERS: 'API anahtarı boşluk ya da görünmeyen karakter içeremez.'
});

export function selectCredentialSource({ personalKeyStored = false, defaultKeyConfigured = false } = {}) {
  if (personalKeyStored) return AI_CREDENTIAL_SOURCES.PERSONAL;
  if (defaultKeyConfigured) return AI_CREDENTIAL_SOURCES.DEFAULT;
  return AI_CREDENTIAL_SOURCES.MISSING;
}

export function credentialSourceLabel(source) {
  return AI_CREDENTIAL_SOURCE_LABELS[source] || AI_CREDENTIAL_SOURCE_LABELS[AI_CREDENTIAL_SOURCES.MISSING];
}

/**
 * Baştaki/sondaki boşluk (kopyalama artığı) kırpılır; anahtar yazdırılabilir
 * ASCII olmalıdır.
 *
 * @returns {{ok: true, value: string} | {ok: false, reason: string, message: string}}
 */
export function normalizeApiKeyInput(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const fail = (reason) => ({ ok: false, reason, message: API_KEY_FORMAT_MESSAGES[reason] });
  if (!text) return fail('EMPTY');
  if (!/^[\x21-\x7E]+$/.test(text)) return fail('INVALID_CHARACTERS');
  if (text.length < API_KEY_MIN_LENGTH) return fail('TOO_SHORT');
  if (text.length > API_KEY_MAX_LENGTH) return fail('TOO_LONG');
  return { ok: true, value: text };
}

/** Gösterim için yalnızca son dört karakter saklanır; anahtarın kendisi hiçbir zaman. */
export function apiKeyHint(normalizedKey) {
  return String(normalizedKey ?? '').slice(-4);
}
