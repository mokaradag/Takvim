import { ServerPersistenceError } from '../../../../../server/errors.js';
import { assertKeycloakConfigured, readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { authenticateAccessToken } from '../../../../../server/identity/keycloakAuthentication.js';
import { safeDisplayIdentity } from '../../../../../server/identity/keycloakClaims.js';
import {
  authCookieSecurity,
  authErrorResponse,
  debugLogIdentity,
  jsonResponse,
  readBearerToken,
  sessionCookieHeader
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Uyumluluk ucu: implicit akıştan gelen bir erişim jetonunu HttpOnly MERGEN
 * Rota oturumuna ÇEVİRİR.
 *
 * Bu genel uç DEĞİŞMEDİ ve zayıflatılmadı. Implicit köprü akışı kendi adanmış
 * ucunu kullanır (`POST /api/mergen-rota/auth/implicit-session`); orada ayrıca
 * imzalı işlem çerezi ve `state` eşleşmesi de aranır.
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
    const { token } = readBearerToken(request);
    if (!token) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir erişim jetonu gönderilmedi.');
    }

    const identity = await authenticateAccessToken(token, { config });
    debugLogIdentity('session-exchange', identity);

    return jsonResponse(
      { authenticated: true, currentUser: { sicil: identity.sicil, ...safeDisplayIdentity(identity) } },
      { cookieHeaders: [sessionCookieHeader(identity, { config, secure: authCookieSecurity(config, request.url) })] }
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
