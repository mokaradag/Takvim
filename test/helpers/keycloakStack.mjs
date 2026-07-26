/**
 * Keycloak kimlik doğrulamasını UÇTAN UCA kuran test yardımcısı.
 *
 * Zincir gerçek kodla kurulur:
 *   sentetik RSA anahtar çifti → gerçek imzalı JWT
 *   → sahte JWKS ucu (gerçek HTTP isteğiyle çekilir)
 *   → gerçek Next.js rota gövdeleri (`/api/mergen-rota/auth/*`)
 *   → gerçek imza/claim doğrulaması
 *   → gerçek HttpOnly oturum çerezi
 *   → gerçek `KeycloakIdentityProvider` → `getTrustedCurrentSicil()`
 *
 * TÜM değerler sentetiktir: hiçbir gerçek Keycloak adresi, istemci kimliği,
 * sicil, ad veya e-posta kullanılmaz.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

export const TEST_KEYCLOAK = Object.freeze({
  baseUrl: 'https://keycloak.test.internal',
  realm: 'mergen_test_realm',
  clientId: 'mergen_rota_test_client',
  get issuer() { return `${this.baseUrl}/realms/${this.realm}`; },
  get jwksUri() { return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/certs`; },
  redirectUri: 'https://rota.test.internal:8008/api/mergen-rota/auth/callback',
  postLogoutRedirectUri: 'https://rota.test.internal:8008/',
  // Sentetik, yalnızca test amaçlı imza anahtarı (gerçek bir sır değildir).
  sessionSecret: 'test-only-session-secret-0123456789abcdef0123456789abcdef'
});

export const TEST_SICIL = 900001;

const encodeSegment = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export function createSigningKey(kid = 'test-key-1') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicKey, jwk };
}

/** Gerçek RSA imzası üretir; `alg: none` gibi bozuk durumlar için de kullanılır. */
export function signJwt(payload, { key, header = {}, signature = null } = {}) {
  const fullHeader = { alg: 'RS256', typ: 'JWT', kid: key?.kid, ...header };
  const signingInput = `${encodeSegment(fullHeader)}.${encodeSegment(payload)}`;
  if (signature != null) return `${signingInput}.${signature}`;
  const digest = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' }[fullHeader.alg] || 'sha256';
  const signer = createSign(digest);
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(key.privateKey).toString('base64url')}`;
}

/** Keycloak erişim jetonu claim'lerinin sentetik karşılığı. */
export function accessTokenClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    exp: now + 300,
    iat: now,
    auth_time: now,
    jti: 'a0000000-0000-4000-8000-000000000001',
    iss: TEST_KEYCLOAK.issuer,
    aud: TEST_KEYCLOAK.clientId,
    azp: TEST_KEYCLOAK.clientId,
    typ: 'Bearer',
    scope: 'openid profile email',
    acr: '1',
    sub: 'b0000000-0000-4000-8000-000000000002',
    sid: 'c0000000-0000-4000-8000-000000000003',
    session_state: 'c0000000-0000-4000-8000-000000000003',
    preferred_username: 'test.kullanici',
    name: 'Test Kullanıcı',
    given_name: 'Test',
    family_name: 'Kullanıcı',
    email: 'test.kullanici@ornek.internal',
    email_verified: true,
    sicil: String(TEST_SICIL),
    sektor: 'Test Sektörü',
    department: 'Test Departmanı',
    mudurluk: 'Test Müdürlüğü',
    resource_access: { [TEST_KEYCLOAK.clientId]: { roles: ['app-user'] } },
    ...overrides
  };
}

export function applyKeycloakEnvironment(overrides = {}) {
  const values = {
    MERGEN_ROTA_AUTH_MODE: 'keycloak',
    MERGEN_ROTA_KEYCLOAK_BASE_URL: TEST_KEYCLOAK.baseUrl,
    MERGEN_ROTA_KEYCLOAK_REALM: TEST_KEYCLOAK.realm,
    MERGEN_ROTA_KEYCLOAK_CLIENT_ID: TEST_KEYCLOAK.clientId,
    MERGEN_ROTA_KEYCLOAK_AUDIENCE: TEST_KEYCLOAK.clientId,
    MERGEN_ROTA_KEYCLOAK_REDIRECT_URI: TEST_KEYCLOAK.redirectUri,
    MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI: TEST_KEYCLOAK.postLogoutRedirectUri,
    MERGEN_ROTA_SESSION_SECRET: TEST_KEYCLOAK.sessionSecret,
    MERGEN_ROTA_SESSION_COOKIE_SECURE: 'true',
    MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK: 'false',
    ...overrides
  };
  for (const [name, value] of Object.entries(values)) {
    if (value == null) delete process.env[name];
    else process.env[name] = String(value);
  }
  return values;
}

/**
 * JWKS ucunu gerçek `fetch` üzerinden sunar. Yalnızca beklenen adres yanıtlanır;
 * başka bir adrese çıkılırsa test açık biçimde başarısız olur.
 */
export function installJwksEndpoint(keys, { failWith = null } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    calls.push(address);
    if (address !== TEST_KEYCLOAK.jwksUri) throw new Error(`Beklenmeyen ağ isteği: ${address}`);
    if (failWith === 'network') throw new Error('JWKS ucuna ulaşılamadı');
    if (failWith === 'status') return new Response('kapalı', { status: 503 });
    return new Response(JSON.stringify({ keys: keys.map((key) => key.jwk) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; }
  };
}

/** `Set-Cookie` başlığından adı verilen çerezin ham değerini çıkarır. */
export function readSetCookie(response, name) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const match = headers.find((header) => header.startsWith(`${name}=`));
  if (!match) return null;
  const [pair, ...attributes] = match.split(';').map((part) => part.trim());
  return { raw: match, value: pair.slice(name.length + 1), attributes };
}

/** Kimlik doğrulama modüllerini temiz bir durumda yükler. */
export async function loadAuthModules() {
  registerServerOnlyShim();
  const authentication = await import('../../src/server/identity/keycloakAuthentication.js');
  const provider = await import('../../src/server/identity/keycloakIdentityProvider.js');
  const currentUser = await import('../../src/server/identity/currentUserProvider.js');
  const sessionRoute = await import('../../src/app/api/mergen-rota/auth/session/route.js');
  const logoutRoute = await import('../../src/app/api/mergen-rota/auth/logout/route.js');
  const loginRoute = await import('../../src/app/api/mergen-rota/auth/login/route.js');
  const callbackRoute = await import('../../src/app/api/mergen-rota/auth/callback/route.js');
  authentication.resetKeycloakJwksClients();
  currentUser.setCurrentUserProvider(null);
  return { authentication, provider, currentUser, sessionRoute, logoutRoute, loginRoute, callbackRoute };
}

/** Bearer jetonuyla gerçek oturum takas ucunu çağırır. */
export function sessionExchangeRequest(token, { extra = {} } = {}) {
  return new Request('https://rota.test.internal:8008/api/mergen-rota/auth/session', {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...extra.headers
    },
    body: extra.body ?? null
  });
}
