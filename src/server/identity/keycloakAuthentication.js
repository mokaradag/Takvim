import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { assertKeycloakConfigured, readKeycloakConfig } from './keycloakConfig.js';
import { extractKeycloakIdentity, maskIdentityForLog } from './keycloakClaims.js';
import { createKeycloakJwksClient } from './keycloakJwks.js';
import { verifyKeycloakToken } from './keycloakToken.js';
import { resolveSicilFromUsername } from './resolveSicilFromUsername.js';

/**
 * Token doğrulama + kimlik çözümü orkestrasyonu.
 *
 * Doğrulama SUNUCUDA yapılır. Sicil sırasıyla şu şekilde çözülür:
 *   1. Doğrulanmış `sicil` claim'i (güvenilen birincil anahtar),
 *   2. (isteğe bağlı) `preferred_username` → HR02 kurumsal kullanıcı adı → Sicil,
 *   3. Hiçbiri çözülmezse UNAUTHORIZED.
 *
 * Keycloak `resource_access` rollerinden SYSTEM_ADMIN TÜRETİLMEZ; yetkilendirme
 * MR_UserRoles ve proje erişim modelinde kalır.
 */

const jwksClients = new Map();

function jwksClientFor(config) {
  const cached = jwksClients.get(config.jwksUri);
  if (cached) return cached;
  const client = createKeycloakJwksClient({
    jwksUri: config.jwksUri,
    cacheTtlMs: config.jwksCacheTtlMs,
    minRefreshIntervalMs: config.jwksMinRefreshMs
  });
  jwksClients.set(config.jwksUri, client);
  return client;
}

/** Test yalıtımı için; üretim akışında çağrılmaz. */
export function resetKeycloakJwksClients() {
  jwksClients.clear();
}

function unauthorized(message, details = null) {
  return new ServerPersistenceError('UNAUTHORIZED', message, details ? { details } : undefined);
}

export async function authenticateAccessToken(token, {
  config = readKeycloakConfig(),
  jwks = null,
  now = Date.now(),
  resolveSicil = resolveSicilFromUsername,
  logger = console
} = {}) {
  assertKeycloakConfigured(config);
  const client = jwks || jwksClientFor(config);

  let claims;
  try {
    claims = await verifyKeycloakToken(token, {
      resolveKey: (kid) => client.getSigningKey(kid),
      issuer: config.issuerUrl,
      expectedAudience: config.expectedAudience,
      expectedAuthorizedParty: config.expectedAuthorizedParty,
      allowedAlgorithms: config.allowedAlgorithms,
      clockToleranceSeconds: config.clockToleranceSeconds,
      now
    });
  } catch (error) {
    // Ham token ASLA günlüğe yazılmaz; yalnızca reddetme nedeni tutulur.
    logger?.warn?.('MERGEN ROTA AUTH: token reddedildi', { reason: error?.reason || 'TOKEN_REJECTED' });
    throw unauthorized('Kimlik doğrulanamadı. Lütfen yeniden oturum açın.');
  }

  const identity = extractKeycloakIdentity(claims, { clientId: config.clientId });
  if (identity.sicil != null) return identity;

  if (!config.usernameSicilFallbackEnabled || !identity.username) {
    logger?.warn?.('MERGEN ROTA AUTH: Sicil çözülemedi', maskIdentityForLog(identity));
    throw unauthorized('Kurumsal Sicil bilgisi çözülemedi. Sistem yöneticinizle görüşün.');
  }

  let resolved = null;
  try {
    resolved = await resolveSicil(identity.username);
  } catch (error) {
    logger?.error?.('MERGEN ROTA AUTH: kullanıcı adı → Sicil çözümü başarısız', { reason: error?.code || 'LOOKUP_FAILED' });
    throw unauthorized('Kurumsal Sicil bilgisi çözülemedi. Lütfen daha sonra yeniden deneyin.');
  }
  if (resolved == null) {
    logger?.warn?.('MERGEN ROTA AUTH: kullanıcı adı kurumsal rehberde tekil eşleşmedi', maskIdentityForLog(identity));
    throw unauthorized('Kurumsal Sicil bilgisi çözülemedi. Sistem yöneticinizle görüşün.');
  }
  return { ...identity, sicil: resolved, sicilSource: 'directory-username' };
}

/**
 * Authorization Code akışında yetkilendirme kodunu token ile takas eder.
 * `client_secret` yalnızca gizli istemci yapılandırıldığında gönderilir;
 * public istemcide PKCE `code_verifier` yeterlidir.
 */
export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  config = readKeycloakConfig(),
  fetchImpl = (...args) => globalThis.fetch(...args)
}) {
  assertKeycloakConfigured(config);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  let response;
  try {
    response = await fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString()
    });
  } catch (cause) {
    throw new ServerPersistenceError('DATABASE_UNAVAILABLE', 'Kimlik sağlayıcısına ulaşılamadı.', { cause });
  }
  if (!response?.ok) throw unauthorized('Kimlik sağlayıcısı yetkilendirme kodunu kabul etmedi.');

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw unauthorized('Kimlik sağlayıcısı yanıtı okunamadı.');
  }
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) throw unauthorized('Kimlik sağlayıcısı erişim jetonu döndürmedi.');
  return { accessToken, idToken: typeof payload?.id_token === 'string' ? payload.id_token : null };
}
