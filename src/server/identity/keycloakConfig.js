import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import {
  DEFAULT_KEYCLOAK_FLOW,
  KEYCLOAK_FLOWS,
  SUPPORTED_KEYCLOAK_FLOWS,
  parseKeycloakFlow
} from './keycloakFlows.js';

/**
 * Keycloak yapılandırması YALNIZCA sunucu tarafı environment değerlerinden
 * okunur. Hiçbir alan `NEXT_PUBLIC_` ile açığa çıkarılmaz; istemci ne client
 * secret'ı ne de token endpoint'ini görür.
 */

export const AUTH_MODES = Object.freeze({ KEYCLOAK: 'keycloak', DEVELOPMENT: 'development' });

// Akış sabitleri yapılandırma modülü üzerinden de sunulur; tüketiciler tek yerden okur.
export { DEFAULT_KEYCLOAK_FLOW, KEYCLOAK_FLOWS, SUPPORTED_KEYCLOAK_FLOWS, parseKeycloakFlow };

const DEFAULT_ALLOWED_ALGORITHMS = Object.freeze(['RS256']);
const SUPPORTED_ALGORITHMS = new Set(['RS256', 'RS384', 'RS512']);
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_JWKS_MIN_REFRESH_MS = 30 * 1000;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

function text(value) {
  return String(value ?? '').trim();
}

function flag(value, fallback) {
  const raw = text(value).toLowerCase();
  if (!raw) return fallback;
  if (/^(1|true|yes|on)$/.test(raw)) return true;
  if (/^(0|false|no|off)$/.test(raw)) return false;
  return fallback;
}

/** Sıfır dahil; hız sınırı bilinçli olarak kapatılabilir. */
function nonNegativeInteger(value, fallback) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const raw = text(value);
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** `a; b, c` biçimindeki listeleri normalize eder. */
export function splitList(value) {
  return text(value)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/**
 * `SSO_KEYCLOAK_URL` iki biçimde verilebilir: yalnız sunucu adresi
 * (`https://kimlik.ornek.internal`) veya doğrudan issuer adresi
 * (`https://kimlik.ornek.internal/realms/<realm>`). İkisi de aynı issuer'a
 * çözülür; realm iki kez eklenmez.
 */
export function deriveIssuerUrl(baseUrl, realm) {
  const base = stripTrailingSlash(text(baseUrl));
  const realmName = text(realm);
  if (!base) return '';
  if (/\/realms\/[^/]+$/.test(base)) return base;
  if (!realmName) return '';
  return `${base}/realms/${encodeURIComponent(realmName)}`;
}

export function readKeycloakConfig(env = process.env) {
  const baseUrl = text(env.MERGEN_ROTA_KEYCLOAK_BASE_URL);
  const realm = text(env.MERGEN_ROTA_KEYCLOAK_REALM);
  const clientId = text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_ID);
  const issuerUrl = deriveIssuerUrl(baseUrl, realm);
  const configuredAlgorithms = splitList(env.MERGEN_ROTA_KEYCLOAK_ALLOWED_ALGORITHMS)
    .map((item) => item.toUpperCase())
    .filter((item) => SUPPORTED_ALGORITHMS.has(item));
  const audience = splitList(env.MERGEN_ROTA_KEYCLOAK_AUDIENCE);

  return {
    baseUrl,
    realm,
    clientId,
    clientSecret: text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET) || null,
    // Seçili akış. Tanınmayan bir değer `null` kalır ve doğrulamada AÇIK bir
    // hataya dönüşür; sessizce başka bir akışa düşülmez.
    flow: parseKeycloakFlow(env.MERGEN_ROTA_KEYCLOAK_FLOW),
    // Ham değer yalnızca teşhis içindir (hangi değerin reddedildiğini görmek için).
    flowRequested: text(env.MERGEN_ROTA_KEYCLOAK_FLOW),
    issuerUrl,
    authorizationEndpoint: issuerUrl ? `${issuerUrl}/protocol/openid-connect/auth` : '',
    tokenEndpoint: issuerUrl ? `${issuerUrl}/protocol/openid-connect/token` : '',
    endSessionEndpoint: issuerUrl ? `${issuerUrl}/protocol/openid-connect/logout` : '',
    jwksUri: text(env.MERGEN_ROTA_KEYCLOAK_JWKS_URL)
      || (issuerUrl ? `${issuerUrl}/protocol/openid-connect/certs` : ''),
    // Authorization Code + PKCE geri dönüş adresi. Implicit köprü bu değeri
    // ASLA kullanmaz; iki akışın adresleri birbirine karışmaz.
    redirectUri: text(env.MERGEN_ROTA_KEYCLOAK_REDIRECT_URI),
    // Implicit köprünün tarayıcı geri dönüş adresi. Boşsa istek kökünden
    // türetilir; üretimde Keycloak kaydıyla birebir aynı değer verilmelidir.
    implicitRedirectUri: text(env.MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI),
    postLogoutRedirectUri: text(env.MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI),
    scope: text(env.MERGEN_ROTA_KEYCLOAK_SCOPE) || 'openid profile email',
    // Beklenen kitle açıkça verilmediyse client id'nin kendisi beklenir.
    expectedAudience: audience.length ? audience : (clientId ? [clientId] : []),
    expectedAuthorizedParty: text(env.MERGEN_ROTA_KEYCLOAK_AUTHORIZED_PARTY) || clientId,
    allowedAlgorithms: configuredAlgorithms.length ? configuredAlgorithms : [...DEFAULT_ALLOWED_ALGORITHMS],
    clockToleranceSeconds: positiveInteger(env.MERGEN_ROTA_KEYCLOAK_CLOCK_TOLERANCE_SECONDS, DEFAULT_CLOCK_TOLERANCE_SECONDS),
    jwksCacheTtlMs: positiveInteger(env.MERGEN_ROTA_KEYCLOAK_JWKS_CACHE_TTL_MS, DEFAULT_JWKS_CACHE_TTL_MS),
    // Bilinmeyen `kid` görüldüğünde yapılan yenilemenin hız sınırı: geçersiz
    // jeton akını JWKS ucunu yormasın, ama anahtar rotasyonu da tıkanmasın.
    jwksMinRefreshMs: nonNegativeInteger(env.MERGEN_ROTA_KEYCLOAK_JWKS_MIN_REFRESH_MS, DEFAULT_JWKS_MIN_REFRESH_MS),
    usernameSicilFallbackEnabled: flag(env.MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK, true),
    sessionSecret: text(env.MERGEN_ROTA_SESSION_SECRET),
    sessionTtlSeconds: positiveInteger(env.MERGEN_ROTA_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
    sessionCookieSecure: flag(env.MERGEN_ROTA_SESSION_COOKIE_SECURE, true)
  };
}

/**
 * Yapılandırma eksikse Keycloak hiç denenmez; sessizce başka kimliğe düşülmez.
 *
 * Doğrulama AKIŞA DUYARLIDIR:
 *   • Her iki akış da issuer, istemci kimliği, JWKS adresi ve oturum imza
 *     anahtarını zorunlu kılar (jeton her hâlükârda sunucuda doğrulanır).
 *   • Hiçbir akış istemci secret'ını ZORUNLU KILMAZ. Authorization Code'da
 *     secret yalnızca gizli istemci için gerekir; implicit köprüde jeton
 *     endpoint'i hiç kullanılmadığı için secret hiç istenmez.
 *   • Implicit köprünün geri dönüş adresi açıkça verilebilir ya da istek
 *     kökünden türetilir; bu yüzden burada zorunlu değildir.
 */
export function keycloakConfigurationIssues(config) {
  const issues = [];
  if (!config.baseUrl) issues.push('MERGEN_ROTA_KEYCLOAK_BASE_URL');
  if (!config.issuerUrl) issues.push('MERGEN_ROTA_KEYCLOAK_REALM');
  if (!config.clientId) issues.push('MERGEN_ROTA_KEYCLOAK_CLIENT_ID');
  if (!config.jwksUri) issues.push('MERGEN_ROTA_KEYCLOAK_JWKS_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 32) issues.push('MERGEN_ROTA_SESSION_SECRET');
  // Tanınmayan akış değeri sessizce yok sayılmaz; yapılandırma hatasıdır.
  if (!config.flow) issues.push('MERGEN_ROTA_KEYCLOAK_FLOW');
  return issues;
}

export function assertKeycloakConfigured(config = readKeycloakConfig()) {
  const issues = keycloakConfigurationIssues(config);
  if (issues.length) {
    // Eksik anahtar ADLARI güvenlidir; değerleri asla dışarı verilmez.
    throw new ServerPersistenceError(
      'UNAUTHORIZED',
      'Keycloak kimlik doğrulaması yapılandırılmamış. Sunucu yöneticinizle görüşün.',
      { details: { missing: issues } }
    );
  }
  return config;
}

/**
 * Etkin kimlik kipi yalnızca sunucu yapılandırmasından seçilir. Varsayılan
 * Keycloak'tır; geçici geliştirme kimliği AÇIKÇA istenmelidir ve kendi
 * anahtarıyla ayrıca etkinleştirilmediği sürece yine de çalışmaz.
 */
export function resolveAuthMode(env = process.env) {
  const requested = text(env.MERGEN_ROTA_AUTH_MODE).toLowerCase();
  return requested === AUTH_MODES.DEVELOPMENT ? AUTH_MODES.DEVELOPMENT : AUTH_MODES.KEYCLOAK;
}

/** Ayrıntılı kimlik günlüğü; yalnızca maskelenmiş alanlar yazılır. */
export function isAuthDebugEnabled(env = process.env) {
  return flag(env.MERGEN_ROTA_AUTH_DEBUG, false);
}
