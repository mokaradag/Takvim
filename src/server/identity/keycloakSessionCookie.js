import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseSicil } from './sicil.js';

/**
 * MERGEN Rota oturum çerezi.
 *
 * Keycloak access token'ı tarayıcıda TUTULMAZ. Sunucu token'ı doğruladıktan
 * sonra yalnızca Sicil ve güvenli görüntüleme alanlarını içeren, HMAC ile
 * imzalanmış kısa ömürlü bir yükü HttpOnly çereze yazar. Tarayıcı bu yükü
 * okuyamaz ve değiştiremez: imza uyuşmazsa oturum yok sayılır.
 */

export const SESSION_COOKIE_NAME = 'mergen_rota_session';
export const AUTH_TRANSACTION_COOKIE_NAME = 'mergen_rota_auth_tx';

function sign(payloadSegment, secret) {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `<base64url(payload)>.<base64url(hmac)>` */
export function signSessionValue(payload, secret) {
  if (!secret) throw new Error('Oturum imza anahtarı yapılandırılmamış.');
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${segment}.${sign(segment, secret)}`;
}

export function verifySignedValue(value, secret) {
  if (!secret || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [segment, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  if (!safeEqual(signature, sign(segment, secret))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Çerez yükü, `extractKeycloakIdentity()` ile AYNI alan adlarını kullanır.
 * Böylece hem tazeleme (oturum açma) hem de sonraki isteklerde (çerez okuma)
 * aynı kimlik biçimi oluşur ve tüketiciler tek şekil görür.
 *
 * Yük yalnızca kullanıcının kendi görüntüleme alanlarını taşır; ham erişim
 * jetonu, yenileme jetonu veya yetki bayrağı ASLA yazılmaz.
 */
export function createSessionPayload(identity, { ttlSeconds, now = Date.now() }) {
  const sicil = parseSicil(identity?.sicil);
  if (sicil == null) throw new Error('Oturum yükü geçerli bir Sicil olmadan oluşturulamaz.');
  const issuedAt = Math.floor(now / 1000);
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    v: 1,
    sicil,
    username: text(identity?.username),
    name: text(identity?.name),
    firstName: text(identity?.firstName),
    lastName: text(identity?.lastName),
    email: text(identity?.email),
    sector: text(identity?.sector),
    department: text(identity?.department),
    mudurluk: text(identity?.mudurluk),
    subject: text(identity?.subject),
    sessionId: text(identity?.sessionId),
    iat: issuedAt,
    exp: issuedAt + Math.max(60, Number(ttlSeconds) || 0)
  };
}

/**
 * Çerez yükünü doğrular. Süresi dolmuş, imzası bozuk veya Sicil'i geçersiz
 * yükler `null` döner; çağıran taraf bunu UNAUTHORIZED olarak ele almalıdır.
 */
export function readSessionPayload(cookieValue, secret, { now = Date.now() } = {}) {
  const payload = verifySignedValue(cookieValue, secret);
  if (!payload) return null;
  const sicil = parseSicil(payload.sicil);
  if (sicil == null) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (Math.floor(now / 1000) >= payload.exp) return null;
  return { ...payload, sicil };
}

/** Çerez başlığını elle üretmek gereken yerler için (Set-Cookie). */
export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}
