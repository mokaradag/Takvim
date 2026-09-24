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
 * sahte bir başarı gösterirdi.
 */

const BASE = '/api/mergen-rota/ai';

/** Beklenen biçimde olmayan başarılı yanıt; ileti sunum katmanında seçilir. */
export const AI_INVALID_RESPONSE = 'INVALID_RESPONSE';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStatusPayload(ai) {
  return isPlainObject(ai) && typeof ai.enabled === 'boolean' && typeof ai.available === 'boolean'
    && isPlainObject(ai.credential);
}

function isValidationPayload(validation) {
  return isPlainObject(validation)
    && (validation.status == null || typeof validation.status === 'string')
    && (validation.status != null || validation.stale === true);
}

async function expectPayload(pending, key, isValid) {
  const response = await pending;
  if (!response.ok || isValid(response[key])) return response;
  return { ok: false, code: AI_INVALID_RESPONSE, message: null };
}

export function loadAiCredentialStatusRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential`, { method: 'GET' }, options), 'ai', isStatusPayload);
}

export function saveAiCredentialRequest(apiKey, options = {}) {
  return expectPayload(requestJson(`${BASE}/credential`, { method: 'PUT', body: JSON.stringify({ apiKey }) }, options), 'ai', isStatusPayload);
}

export function removeAiCredentialRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential`, { method: 'DELETE' }, options), 'ai', isStatusPayload);
}

export function validateAiCredentialRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/credential/validation`, { method: 'POST' }, options), 'validation', isValidationPayload);
}

export function runAiProbeRequest(options = {}) {
  return expectPayload(requestJson(`${BASE}/probe`, { method: 'POST' }, options), 'result', isPlainObject);
}
