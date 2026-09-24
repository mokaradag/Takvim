import { requestJson } from '../shared/jsonRequest.js';

/**
 * Yapay zekâ uçlarının istemci sarmalayıcısı.
 *
 * Tarayıcı yalnızca MERGEN Rota sunucusuyla konuşur; yapay zekâ sağlayıcısının
 * adresini ve hiçbir anahtarı bilmez. Anahtar yalnızca kaydetme isteğinin
 * gövdesinde bir kez gider; yanıtlar onu hiçbir zaman geri taşımaz.
 */

const BASE = '/api/mergen-rota/ai';

export function loadAiCredentialStatusRequest(options = {}) {
  return requestJson(`${BASE}/credential`, { method: 'GET' }, options);
}

export function saveAiCredentialRequest(apiKey, options = {}) {
  return requestJson(`${BASE}/credential`, { method: 'PUT', body: JSON.stringify({ apiKey }) }, options);
}

export function removeAiCredentialRequest(options = {}) {
  return requestJson(`${BASE}/credential`, { method: 'DELETE' }, options);
}

export function validateAiCredentialRequest(options = {}) {
  return requestJson(`${BASE}/credential/validation`, { method: 'POST' }, options);
}

export function runAiProbeRequest(options = {}) {
  return requestJson(`${BASE}/probe`, { method: 'POST' }, options);
}
