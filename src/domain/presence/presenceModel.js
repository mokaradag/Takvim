/**
 * Kullanıcı varlığı (presence) — ortak tanımlar.
 *
 * "Aktif" kavramı AÇIKÇA tanımlıdır ve "oturum açmış kullanıcı listesi" DEĞİLDİR:
 *
 *   Aktif = son {@link PRESENCE_ACTIVE_WINDOW_MS} içinde kimliği doğrulanmış
 *           bir nabız (heartbeat) görülmüş kullanıcı.
 *
 * Nabız yalnızca uygulama açıkken ve sekme görünürken gönderilir; olağan API
 * istekleri varlık yazmaz. Tarayıcı kapanır, ağ kesilir ya da oturum düşerse
 * nabız durur ve kullanıcı pencere dolunca listeden kendiliğinden çıkar.
 */

/** Nabız aralığı. Pencerenin yarısından kısadır: tek kayıp nabız kişiyi düşürmez. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 90000;

/** Aktiflik penceresi. */
export const PRESENCE_ACTIVE_WINDOW_MS = 180000;

/** "Son 15 dk" ölçütü ve tablo kapsamı. */
export const PRESENCE_RECENT_WINDOW_MS = 900000;

/**
 * Bu süreden uzun bir sessizlikten sonra gelen nabız YENİ oturum sayılır:
 * "aktif olduğu süre" dünden kalma bir damgayla şişmez.
 */
export const PRESENCE_SESSION_GAP_MS = 900000;

/** Aktif kullanıcı tablosunun üst sınırı. */
export const PRESENCE_LIST_LIMIT = 200;

export function isPresenceActive(lastSeenAt, now = Date.now(), windowMs = PRESENCE_ACTIVE_WINDOW_MS) {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  return Number.isFinite(seen) && now - seen <= windowMs;
}
