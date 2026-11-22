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

async function fetchCoordinationQuery(query, isValid) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value != null && value !== '')
  );
  const result = await requestJson(`${BASE}?${params}`, { method: 'GET' });
  return validateRead(result, isValid);
}

export function fetchAssignmentCoordinations(query = {}) {
  return fetchCoordinationQuery(query,
    (value) => isValidRequestInboxResponse(value) && Number.isSafeInteger(value.counts.all) && value.counts.all >= 0);
}

export function fetchAssignmentCoordination(coordinationId) {
  return fetchCoordinationQuery({ coordinationId }, (value) => value?.record === null
    || (value?.record?.id === coordinationId && typeof value.record.status === 'string'
      && typeof value.record.version === 'string' && Array.isArray(value.record.allowedDecisions)));
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

function isValidRequestInboxResponse(value) {
  return Boolean(
    value && typeof value === 'object'
    && Array.isArray(value.items)
    && value.counts && typeof value.counts === 'object'
    && Number.isFinite(Number(value.total))
    && Number.isFinite(Number(value.page))
    && Number.isFinite(Number(value.pageSize)) && Number(value.pageSize) > 0
  );
}

function validateRead(result, isValid) {
  if (result.ok && !isValid(result.value)) {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'Sunucu yanıtı geçersiz.' };
  }
  return result;
}

/** Talepler · Gelenler / Gönderdiklerim / Geçmiş birleşik sayfası. */
export async function fetchRequestInbox(query = {}) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value != null && value !== '')
  );
  const result = await requestJson(`/api/mergen-rota/notifications?${params}`, { method: 'GET' });
  return validateRead(result, isValidRequestInboxResponse);
}
