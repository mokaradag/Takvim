import { requestJson } from './scheduleChangeClient.js';

/**
 * Atama koordinasyonu uçlarının istemcisi.
 *
 * Ortak zaman aşımı ve hata sözleşmesi paylaşılan sarmalayıcıdadır; ikinci bir
 * istemci yazılmaz. İstemci anahtarları yalnızca arayüzdür: yetki her çağrıda
 * sunucuda yeniden doğrulanır.
 */

const BASE = '/api/mergen-rota/assignment-coordination';

export function submitAssignmentCoordination(input) {
  return requestJson(BASE, { method: 'POST', body: JSON.stringify(input) });
}

export function decideAssignmentCoordinationRequest(coordinationId, input) {
  return requestJson(`${BASE}/${encodeURIComponent(coordinationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function fetchAssignmentCoordinations(query = {}) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value != null && value !== '')
  );
  return requestJson(`${BASE}?${params}`, { method: 'GET' });
}

/** Zil bildirimlerini okundu/temizlendi işaretler (kaynak karışık olabilir). */
export function markNotificationItems(notifications, action = 'read') {
  return requestJson('/api/mergen-rota/notifications', {
    method: 'PATCH',
    body: JSON.stringify({
      action,
      notifications: notifications.map(({ id, version, source }) => ({ id, version, source }))
    })
  });
}
