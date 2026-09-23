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

/**
 * Kilit bu süre tazelenmezse başka bir sekme devralır.
 *
 * Önder kilidi her nabızda tazeler; süre, bir nabız aralığına kısa bir pay
 * ekler. Önceki değer (iki nabız aralığı = aktiflik penceresinin TAMAMI) ile
 * donan bir önderin yerine geçmek, izleyicinin yoklama aralığı da eklenince
 * 4,5 dakikaya çıkıyor ve etkin kullanıcı listeden geçici olarak düşüyordu.
 */
export const PRESENCE_LEADER_TTL_MS = PRESENCE_HEARTBEAT_INTERVAL_MS + 30000;

/**
 * Önder OLMAYAN görünür sekmenin kilidi yoklama aralığı.
 *
 * Yoklama yalnızca yerel depoyu okur, ağ isteği göndermez. Donan önderin son
 * nabzından devralmaya kadar geçen en uzun süre `TTL + bu aralık` kadardır ve
 * aktiflik penceresinin içinde kalır.
 */
export const PRESENCE_FOLLOWER_POLL_MS = 15000;

/**
 * En kötü durumda iki nabız arasındaki boşluk (donan önder → devralan sekme).
 * Aktiflik penceresinden kısa olmalıdır; aksi hâlde etkin kullanıcı listeden
 * geçici olarak düşer.
 */
export const PRESENCE_WORST_CASE_GAP_MS = PRESENCE_LEADER_TTL_MS + PRESENCE_FOLLOWER_POLL_MS;

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

/**
 * Sekme gizlenirken ya da kapanırken kilidi bırakmalı mı?
 *
 * Yalnızca kilit BU sekmeye aitse: başka bir sekmenin önderliği silinmez.
 * Bırakılmayan kilit, görünür bir sekmenin devralmasını TTL dolana dek
 * geciktiriyordu.
 */
export function shouldReleasePresenceLock(lock, tabId) {
  return Boolean(lock) && lock.tabId === String(tabId);
}

/**
 * Sonraki yoklamaya kadar beklenecek süre.
 *
 * Önder nabız aralığıyla gönderir; görünür izleyici kilidi daha sık yoklar ki
 * donan önderin yerine aktiflik penceresi dolmadan geçebilsin. Gizli sekme
 * yoklamaz: görünür olduğunda `visibilitychange` hemen bir tur başlatır.
 */
export function nextPresenceTickDelay({ leader, hidden, intervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS }) {
  if (leader || hidden) return intervalMs;
  return Math.min(intervalMs, PRESENCE_FOLLOWER_POLL_MS);
}
