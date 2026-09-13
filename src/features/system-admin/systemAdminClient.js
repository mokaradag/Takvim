import { requestJson } from '../shared/jsonRequest.js';

/**
 * Sistem Yönetimi uçlarının istemci sarmalayıcısı.
 *
 * Ortak zaman aşımı, iptal ve hata sözleşmesi paylaşılan katmandadır
 * (bkz. features/shared/jsonRequest.js); ikinci bir istemci yazılmaz.
 */

const BASE = '/api/mergen-rota/admin/system';

export function loadSystemOverviewRequest(options = {}) {
  return requestJson(`${BASE}/overview`, { method: 'GET' }, options);
}

export function loadSystemPerformanceRequest(range, options = {}) {
  return requestJson(`${BASE}/performance?range=${encodeURIComponent(range)}`, { method: 'GET' }, options);
}

export function loadSystemQueuesRequest(options = {}) {
  return requestJson(`${BASE}/queues`, { method: 'GET' }, options);
}

export function runQueueActionRequest(action, options = {}) {
  return requestJson(`${BASE}/queues`, { method: 'POST', body: JSON.stringify({ action }) }, options);
}

export function loadSystemEventsRequest(query = {}, options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return requestJson(`${BASE}/events${suffix ? `?${suffix}` : ''}`, { method: 'GET' }, options);
}

export function acknowledgeAlertRequest(alertId, options = {}) {
  return requestJson(`${BASE}/events`, {
    method: 'POST',
    body: JSON.stringify({ action: 'acknowledge', alertId })
  }, options);
}

export function loadSystemIntegrationsRequest(options = {}) {
  return requestJson(`${BASE}/integrations`, { method: 'GET' }, options);
}

export function testIntegrationRequest(integrationId, options = {}) {
  return requestJson(`${BASE}/integrations`, {
    method: 'POST',
    body: JSON.stringify({ integrationId })
  }, options);
}
