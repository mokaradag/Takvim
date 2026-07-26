import { createHash, randomBytes } from 'node:crypto';

/**
 * Authorization Code + PKCE yardımcıları.
 *
 * `code_verifier` ve `state` tarayıcıya AÇIK olarak verilmez; imzalı, HttpOnly
 * ve kısa ömürlü bir işlem çerezinde taşınır. Callback aşamasında state
 * eşleşmezse veya işlem çerezi yoksa akış reddedilir (CSRF koruması).
 */

const DEFAULT_TRANSACTION_TTL_SECONDS = 600;

export function createRandomToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

export function createPkcePair() {
  const codeVerifier = createRandomToken(48);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

export function createAuthTransaction({ returnTo = '/', now = Date.now(), ttlSeconds = DEFAULT_TRANSACTION_TTL_SECONDS } = {}) {
  const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkcePair();
  return {
    state: createRandomToken(24),
    codeVerifier,
    codeChallenge,
    codeChallengeMethod,
    returnTo: safeReturnTo(returnTo),
    exp: Math.floor(now / 1000) + Math.max(60, ttlSeconds)
  };
}

/** Açık yönlendirme (open redirect) engeli: yalnızca uygulama içi yollar. */
export function safeReturnTo(value) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

export function isTransactionValid(transaction, state, { now = Date.now() } = {}) {
  if (!transaction || typeof transaction !== 'object') return false;
  if (typeof transaction.state !== 'string' || !transaction.state) return false;
  if (typeof transaction.codeVerifier !== 'string' || !transaction.codeVerifier) return false;
  if (typeof transaction.exp !== 'number' || Math.floor(now / 1000) >= transaction.exp) return false;
  return transaction.state === state;
}

export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod = 'S256' }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope || 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', codeChallengeMethod);
  return url.toString();
}

export function buildEndSessionUrl({ endSessionEndpoint, clientId, postLogoutRedirectUri, idTokenHint }) {
  if (!endSessionEndpoint) return null;
  const url = new URL(endSessionEndpoint);
  if (clientId) url.searchParams.set('client_id', clientId);
  if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}
