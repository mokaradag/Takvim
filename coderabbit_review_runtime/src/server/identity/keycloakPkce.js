import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { KEYCLOAK_FLOWS } from './keycloakFlows.js';

/**
 * Oturum açma işlemi (transaction) yardımcıları.
 *
 * Hem Authorization Code + PKCE hem de implicit köprü akışı aynı imzalı,
 * HttpOnly ve kısa ömürlü işlem çerezini kullanır. `code_verifier` ve `state`
 * tarayıcıya AÇIK olarak verilmez. Callback aşamasında state eşleşmezse veya
 * işlem çerezi yoksa akış reddedilir (CSRF koruması).
 *
 * İşlem yükü her zaman bir `flow` işareti taşır: bir akışın geri dönüşü
 * ötekinin işlemiyle ASLA tamamlanamaz.
 */

const DEFAULT_TRANSACTION_TTL_SECONDS = 600;

/** İşlem reddi nedenleri; çağıran taraf bunları ayrı iletilere çevirir. */
export const TRANSACTION_REJECTIONS = Object.freeze({
  MISSING: 'TRANSACTION_MISSING',
  MALFORMED: 'TRANSACTION_MALFORMED',
  EXPIRED: 'TRANSACTION_EXPIRED',
  FLOW_MISMATCH: 'TRANSACTION_FLOW_MISMATCH',
  STATE_MISMATCH: 'TRANSACTION_STATE_MISMATCH'
});

export function createRandomToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

export function createPkcePair() {
  const codeVerifier = createRandomToken(48);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

function expiresAt(now, ttlSeconds) {
  return Math.floor(now / 1000) + Math.max(60, ttlSeconds);
}

export function createAuthTransaction({ returnTo = '/', now = Date.now(), ttlSeconds = DEFAULT_TRANSACTION_TTL_SECONDS } = {}) {
  const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkcePair();
  return {
    flow: KEYCLOAK_FLOWS.AUTHORIZATION_CODE,
    state: createRandomToken(24),
    codeVerifier,
    codeChallenge,
    codeChallengeMethod,
    returnTo: safeReturnTo(returnTo),
    exp: expiresAt(now, ttlSeconds)
  };
}

/**
 * Implicit köprü işlemi. PKCE `code_verifier` ÜRETİLMEZ ve saklanmaz: jeton
 * endpoint'i bu akışta hiç kullanılmadığı için doğrulayıcının bir karşılığı
 * yoktur.
 */
export function createImplicitAuthTransaction({ returnTo = '/', now = Date.now(), ttlSeconds = DEFAULT_TRANSACTION_TTL_SECONDS } = {}) {
  return {
    flow: KEYCLOAK_FLOWS.IMPLICIT_BRIDGE,
    state: createRandomToken(24),
    returnTo: safeReturnTo(returnTo),
    exp: expiresAt(now, ttlSeconds)
  };
}

/** Açık yönlendirme (open redirect) engeli: yalnızca uygulama içi yollar. */
export function safeReturnTo(value) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

/** Sabit zamanlı karşılaştırma; uzunluk farkı erken çıkışla ele alınır. */
function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * İşlemi doğrular ve reddedildiyse NEDENİNİ döndürür (`null` = geçerli).
 * Akış işareti zorunludur: implicit bir işlem Authorization Code callback'i
 * tarafından, kod işlemi de implicit köprü tarafından kabul edilmez.
 */
export function inspectAuthTransaction(transaction, state, {
  now = Date.now(),
  flow = KEYCLOAK_FLOWS.AUTHORIZATION_CODE
} = {}) {
  if (transaction == null) return TRANSACTION_REJECTIONS.MISSING;
  if (typeof transaction !== 'object' || Array.isArray(transaction)) return TRANSACTION_REJECTIONS.MALFORMED;
  if (transaction.flow !== flow) return TRANSACTION_REJECTIONS.FLOW_MISMATCH;
  if (typeof transaction.state !== 'string' || !transaction.state) return TRANSACTION_REJECTIONS.MALFORMED;
  if (flow === KEYCLOAK_FLOWS.AUTHORIZATION_CODE
    && (typeof transaction.codeVerifier !== 'string' || !transaction.codeVerifier)) {
    return TRANSACTION_REJECTIONS.MALFORMED;
  }
  if (typeof transaction.exp !== 'number' || !Number.isFinite(transaction.exp)) return TRANSACTION_REJECTIONS.MALFORMED;
  if (Math.floor(now / 1000) >= transaction.exp) return TRANSACTION_REJECTIONS.EXPIRED;
  if (typeof state !== 'string' || !state) return TRANSACTION_REJECTIONS.STATE_MISMATCH;
  return constantTimeEquals(transaction.state, state) ? null : TRANSACTION_REJECTIONS.STATE_MISMATCH;
}

export function isTransactionValid(transaction, state, options = {}) {
  return inspectAuthTransaction(transaction, state, options) === null;
}

/**
 * Yetkilendirme adresini üretir. Akışa göre değişen tek şey `response_type`,
 * `response_mode` ve PKCE parametreleridir; adres kurma mantığı tektir.
 *
 * `code_challenge` verilmediğinde PKCE parametreleri HİÇ eklenmez: implicit
 * köprü isteği PKCE taşımaz. İstemci secret'ı bu adrese hiçbir koşulda yazılmaz.
 */
export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  scope,
  state,
  responseType = 'code',
  responseMode = '',
  codeChallenge = '',
  codeChallengeMethod = 'S256'
}) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', responseType);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope || 'openid profile email');
  url.searchParams.set('state', state);
  if (responseMode) url.searchParams.set('response_mode', responseMode);
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', codeChallengeMethod);
  }
  return url.toString();
}

/** Implicit köprü: jeton URL parçasında (fragment) döner, kod hiç istenmez. */
export function buildImplicitAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scope, state }) {
  return buildAuthorizationUrl({
    authorizationEndpoint,
    clientId,
    redirectUri,
    scope,
    state,
    responseType: 'token',
    responseMode: 'fragment'
  });
}

export function buildEndSessionUrl({ endSessionEndpoint, clientId, postLogoutRedirectUri, idTokenHint }) {
  if (!endSessionEndpoint) return null;
  const url = new URL(endSessionEndpoint);
  if (clientId) url.searchParams.set('client_id', clientId);
  if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}
