import {
  AI_CREDENTIAL_OPERATION_TIMEOUT_MS,
  AI_CREDENTIAL_SOURCES,
  AI_CREDENTIAL_VALIDATION
} from '../../domain/ai/aiCredentialPolicy.js';
import { requestJson } from '../shared/jsonRequest.js';

/**
 * Yapay zekâ uçlarının istemci sarmalayıcısı.
 *
 * Tarayıcı yalnızca MERGEN Rota sunucusuyla konuşur; yapay zekâ sağlayıcısının
 * adresini ve hiçbir anahtarı bilmez. Anahtar yalnızca kaydetme isteğinin
 * gövdesinde bir kez gider; yanıtlar onu hiçbir zaman geri taşımaz.
 *
 * Başarılı (2xx) yanıt ancak beklenen biçimi taşıyorsa başarı sayılır: istek
 * sarmalayıcısı çözülemeyen gövdeyi `{}` olarak döndürür ve bir vekilin 200
 * dönen HTML sayfası ya da kesilmiş gövde aksi hâlde kartı çökertir ya da
 * sahte bir başarı gösterirdi. Eylemleri yöneten alanlar (etkin kaynak, deneme
 * durumu, anahtar künyesi) eksikse yanıt reddedilir: kart kapalı kalır.
 */

const BASE = '/api/mergen-rota/ai';
/** Sunucu anahtar işlemlerini kendi süre sınırıyla bitirir; tarayıcı ondan sonra vazgeçer. */
const CREDENTIAL_CLIENT_MARGIN_MS = 5000;
export const AI_CREDENTIAL_REQUEST_TIMEOUT_MS = AI_CREDENTIAL_OPERATION_TIMEOUT_MS + CREDENTIAL_CLIENT_MARGIN_MS;

/** Beklenen biçimde olmayan başarılı yanıt; ileti sunum katmanında seçilir. */
export const AI_INVALID_RESPONSE = 'INVALID_RESPONSE';

const SOURCES = new Set(Object.values(AI_CREDENTIAL_SOURCES));
const PROBE_SOURCES = new Set([AI_CREDENTIAL_SOURCES.PERSONAL, AI_CREDENTIAL_SOURCES.DEFAULT]);
const VALIDATION_RESULTS = new Set(Object.values(AI_CREDENTIAL_VALIDATION));

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCredentialView(credential) {
  if (!isPlainObject(credential) || typeof credential.configured !== 'boolean') return false;
  return !credential.configured || (typeof credential.readable === 'boolean' && typeof credential.hint === 'string');
}

/**
 * Durum yanıtı. Saklama durumu alanları (`schemaReady`, `personalKeysConfigured`)
 * da zorunludur: eksik göç (0016) ile bilinçli kapatılmış saklamayı ayıran
 * açıklama onlardan seçilir.
 */
function isStatusPayload(ai) {
  return isPlainObject(ai)
    && typeof ai.enabled === 'boolean'
    && typeof ai.available === 'boolean'
    && typeof ai.personalKeysSupported === 'boolean'
    && typeof ai.personalKeysConfigured === 'boolean'
    && typeof ai.defaultKeyConfigured === 'boolean'
    && typeof ai.schemaReady === 'boolean'
    && SOURCES.has(ai.effectiveSource)
    && isCredentialView(ai.credential)
    && isPlainObject(ai.probe) && typeof ai.probe.available === 'boolean';
}

/** Kayıtlı anahtarın künyesi: son dört karakter ve tarihler (tarayıcıya giden tek bilgi). */
function isCredentialMetadata(credential) {
  return isPlainObject(credential)
    && typeof credential.hint === 'string'
    && (credential.lastValidatedAt == null || nonEmptyText(credential.lastValidatedAt))
    && (credential.lastValidationStatus == null || VALIDATION_RESULTS.has(credential.lastValidationStatus));
}

/**
 * Doğrulama yanıtı. Bayat olmayan sonuç `stale: false`, sunucunun üç kalıcı
 * sonucundan biri ve o sonucun YAZILDIĞI anahtarın künyesini (aynı sonuç ve
 * doğrulama zamanıyla) taşımalıdır. Bayat sonuç `status` taşımaz; künye güncel
 * anahtarındır ya da anahtar kaldırıldıysa yoktur.
 */
function isValidationPayload(validation) {
  if (!isPlainObject(validation)) return false;
  if (validation.stale === true) {
    return validation.status == null && (validation.credential == null || isCredentialMetadata(validation.credential));
  }
  return validation.stale === false
    && VALIDATION_RESULTS.has(validation.status)
    && isCredentialMetadata(validation.credential)
    && validation.credential.lastValidationStatus === validation.status
    && nonEmptyText(validation.credential.lastValidatedAt);
}

/**
 * Deneme sonucu ancak kaynağı, profili, yapılandırılan modeli, süresi ve metni
 * taşıyorsa başarıdır. Yanıtlayan model (`model`) sağlayıcı bildirmediyse
 * `null` olabilir; varsa boş olmayan metindir.
 */
function isProbeResult(result) {
  return isPlainObject(result)
    && PROBE_SOURCES.has(result.credentialSource)
    && nonEmptyText(result.profile)
    && nonEmptyText(result.configuredModel)
    && (result.model == null || nonEmptyText(result.model))
    && Number.isFinite(result.durationMs) && result.durationMs >= 0
    && nonEmptyText(result.text);
}

async function expectPayload(pending, key, isValid) {
  const response = await pending;
  if (!response.ok || isValid(response[key])) return response;
  return { ok: false, code: AI_INVALID_RESPONSE, message: null };
}

function credentialOptions(options) {
  return { timeoutMs: AI_CREDENTIAL_REQUEST_TIMEOUT_MS, ...options };
}

export function loadAiCredentialStatusRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential`, { method: 'GET' }, credentialOptions(options)), 'ai', isStatusPayload);
}

export function saveAiCredentialRequest(apiKey, options = {}) {
  return expectPayload(
    requestJson(`${BASE}/credential`, { method: 'PUT', body: JSON.stringify({ apiKey }) }, credentialOptions(options)),
    'ai',
    isStatusPayload
  );
}

export function removeAiCredentialRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential`, { method: 'DELETE' }, credentialOptions(options)), 'ai', isStatusPayload);
}

export function validateAiCredentialRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential/validation`, { method: 'POST' }, options), 'validation', isValidationPayload);
}

export function runAiProbeRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/probe`, { method: 'POST' }, options), 'result', isProbeResult);
}
