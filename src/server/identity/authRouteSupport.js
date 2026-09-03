import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { isAuthDebugEnabled } from './keycloakConfig.js';
import { maskIdentityForLog } from './keycloakClaims.js';
import {
  AUTH_TRANSACTION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createSessionPayload,
  serializeCookie,
  signSessionValue
} from './keycloakSessionCookie.js';

/**
 * Kimlik doğrulama route'larının paylaştığı küçük yardımcılar.
 *
 * Çerezler burada elle serileştirilir; böylece hem yönlendirme (302) hem de
 * JSON yanıtlarında aynı HttpOnly/Secure/SameSite sözleşmesi geçerli olur.
 */

const TRANSACTION_TTL_SECONDS = 600;

export function authCookieSecurity(config, requestUrl) {
  // Yapılandırma Secure isterse her zaman Secure. Aksi hâlde yalnızca düz HTTP
  // yerel geliştirmede gevşetilir (tarayıcı http üzerinde Secure çerez yazmaz).
  if (config.sessionCookieSecure) return true;
  try {
    return new URL(requestUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

export function sessionCookieHeader(identity, { config, secure, now = Date.now() }) {
  const payload = createSessionPayload(identity, { ttlSeconds: config.sessionTtlSeconds, now });
  const value = signSessionValue(payload, config.sessionSecret);
  return serializeCookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.sessionTtlSeconds
  });
}

export function clearedCookieHeader(name, { secure }) {
  return serializeCookie(name, '', { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 0 });
}

export function transactionCookieHeader(signedValue, { secure }) {
  return serializeCookie(AUTH_TRANSACTION_COOKIE_NAME, signedValue, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: TRANSACTION_TTL_SECONDS
  });
}

// Şema adı RFC 7235'e göre BÜYÜK/KÜÇÜK HARF duyarsızdır: `bearer <jeton>`
// gönderen uyumlu bir istemci, jetonu geçerliyken bile "bozuk" sayılıyordu.
const BEARER_PATTERN = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i;

export const BEARER_REJECTIONS = Object.freeze({ MISSING: 'BEARER_MISSING', MALFORMED: 'BEARER_MALFORMED' });

/**
 * `Authorization: Bearer <jeton>` başlığını okur. Eksik olmakla bozuk olmak
 * AYRILIR: çağıran taraf bunları farklı iletilere çevirebilir. Jeton yalnızca
 * döndürülür; hiçbir koşulda günlüğe yazılmaz.
 */
export function readBearerToken(request) {
  const header = String(request?.headers?.get?.('authorization') || '').trim();
  if (!header) return { token: null, rejection: BEARER_REJECTIONS.MISSING };
  const match = BEARER_PATTERN.exec(header);
  return match ? { token: match[1], rejection: null } : { token: null, rejection: BEARER_REJECTIONS.MALFORMED };
}

export function readRequestCookie(request, name) {
  const header = request?.headers?.get?.('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function redirectResponse(location, cookieHeaders = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookieHeaders) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export function jsonResponse(body, { status = 200, cookieHeaders = [] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const cookie of cookieHeaders) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Kimlik doğrulama hataları istemciye SADELEŞTİRİLEREK döner. Ham token, tam
 * claim yükü veya iç yapılandırma değerleri yanıta veya günlüğe yazılmaz.
 */
export function authErrorResponse(error, { fallbackMessage = 'Kimlik doğrulanamadı.' } = {}) {
  const known = error instanceof ServerPersistenceError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'AUTH_FAILED';
  console.error('MERGEN ROTA AUTH ERROR:', { code, status });
  // SINIFLANDIRILMAMIŞ sunucu hatası 401 olarak SUNULMAZ.
  //
  // Bir `TypeError`, JWKS okuyucu arızası ya da sarmalanmamış altyapı hatası
  // 401/UNAUTHORIZED'a çevrildiğinde tarayıcı "oturum açılmamış" sonucunu
  // çıkarıp giriş akışını hâlâ bozuk olan sunucuya karşı yeniden başlatıyor ve
  // sağlayıcı kesintilerinde belgelenen yönlendirme döngüsü oluşuyordu. 401
  // yalnızca gerçek bir kimlik doğrulama KARARIDIR.
  return jsonResponse({
    error: {
      code,
      message: known ? error.message : fallbackMessage,
      details: null
    }
  }, { status });
}

export function debugLogIdentity(stage, identity) {
  if (!isAuthDebugEnabled()) return;
  // Yalnızca maskelenmiş alanlar; ham claim yükü asla.
  console.info(`MERGEN ROTA AUTH DEBUG [${stage}]`, maskIdentityForLog(identity));
}
