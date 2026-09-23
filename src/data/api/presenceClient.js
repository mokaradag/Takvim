import { requestJson } from './scheduleChangeClient.js';

/**
 * Kullanıcı nabzının istemcisi.
 *
 * Nabız olağan API isteklerine bağlı DEĞİLDİR: yalnızca uygulama açık ve sekme
 * görünürken, sabit aralıkla gönderilir (bkz. hooks/usePresenceHeartbeat.js).
 */
export function sendPresenceHeartbeat() {
  return requestJson('/api/mergen-rota/presence/heartbeat', { method: 'POST', body: '{}' });
}
