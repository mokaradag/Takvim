import { PRESENCE_HEARTBEAT_INTERVAL_MS } from './presenceModel.js';

/**
 * Sekmeler arası nabız önderliği — SAF kurallar.
 *
 * Aynı tarayıcıda açık on sekme, on kat nabız isteği göndermemelidir. Sekmeler
 * paylaşılan bir kilit üzerinden tek bir önder seçer; önder kilidi tazeler.
 * Önderin sekmesi kapanır ya da donarsa kilit bayatlar ve başka bir sekme
 * devralır.
 *
 * Kurallar burada, tarayıcı bağlantısı `hooks/usePresenceHeartbeat.js`
 * içindedir; böylece davranış tarayıcı olmadan sınanabilir.
 */

/** Kilit bu süre tazelenmezse başka bir sekme devralır. */
export const PRESENCE_LEADER_TTL_MS = PRESENCE_HEARTBEAT_INTERVAL_MS * 2;

export const PRESENCE_LEADER_STORAGE_KEY = 'mergen_rota_presence_leader_v1';

export function parsePresenceLock(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    const tabId = String(parsed?.tabId || '');
    const at = Number(parsed?.at);
    return tabId && Number.isFinite(at) ? { tabId, at } : null;
  } catch {
    return null;
  }
}

export function serializePresenceLock(tabId, now) {
  return JSON.stringify({ tabId: String(tabId), at: Number(now) });
}

/**
 * Bu sekme nabzı göndermeli mi?
 *
 * Kilit yoksa, kilit bu sekmeye aitse ya da kilit bayatladıysa evet.
 */
export function shouldClaimPresenceLeadership(lock, tabId, now, ttlMs = PRESENCE_LEADER_TTL_MS) {
  if (!lock) return true;
  if (lock.tabId === String(tabId)) return true;
  return !Number.isFinite(lock.at) || now - lock.at > ttlMs;
}
