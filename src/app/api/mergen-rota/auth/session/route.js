import { ServerPersistenceError } from '../../../../../server/errors.js';
import { assertKeycloakConfigured, readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { authenticateAccessToken } from '../../../../../server/identity/keycloakAuthentication.js';
import { safeDisplayIdentity } from '../../../../../server/identity/keycloakClaims.js';
import {
  authCookieSecurity,
  authErrorResponse,
  debugLogIdentity,
  jsonResponse,
  sessionCookieHeader
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

const BEARER_PATTERN = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/;

/**
 * Uyumluluk ucu: implicit akıştan gelen bir erişim jetonunu HttpOnly MERGEN
 * Rota oturumuna ÇEVİRİR.
 *
 * Jeton yalnızca `Authorization: Bearer` başlığından okunur, SUNUCUDA
 * doğrulanır ve yanıtta geri verilmez. Tarayıcı jetonu localStorage'da
 * saklamamalıdır; bu uç çağrıldıktan sonra kimlik HttpOnly çerezdedir.
 *
 * Sicil isteğin gövdesinden, sorgu dizesinden veya herhangi bir tarayıcı
 * başlığından KABUL EDİLMEZ; yalnızca doğrulanmış jeton claim'lerinden ya da
 * sunucu tarafı kurumsal rehber çözümünden gelir.
 */
export async function POST(request) {
  try {
    const config = assertKeycloakConfigured(readKeycloakConfig());
    const match = BEARER_PATTERN.exec(request.headers.get('authorization') || '');
    if (!match) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir erişim jetonu gönderilmedi.');
    }

    const identity = await authenticateAccessToken(match[1], { config });
    debugLogIdentity('session-exchange', identity);

    return jsonResponse(
      { authenticated: true, currentUser: { sicil: identity.sicil, ...safeDisplayIdentity(identity) } },
      { cookieHeaders: [sessionCookieHeader(identity, { config, secure: authCookieSecurity(config, request.url) })] }
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
