import { ServerPersistenceError } from '../../../../../server/errors.js';
import { KEYCLOAK_FLOWS, assertKeycloakConfigured, readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { authenticateAccessToken, exchangeAuthorizationCode } from '../../../../../server/identity/keycloakAuthentication.js';
import { isTransactionValid, safeReturnTo } from '../../../../../server/identity/keycloakPkce.js';
import { AUTH_TRANSACTION_COOKIE_NAME, verifySignedValue } from '../../../../../server/identity/keycloakSessionCookie.js';
import {
  authCookieSecurity,
  authErrorResponse,
  clearedCookieHeader,
  debugLogIdentity,
  readRequestCookie,
  redirectResponse,
  sessionCookieHeader
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Keycloak geri dönüş ucu.
 *
 * Kod → token takası SUNUCUDA yapılır, token sunucuda doğrulanır ve yalnızca
 * doğrulanmış Sicil HttpOnly oturum çerezine yazılır. Erişim jetonu tarayıcıya
 * hiç ulaşmaz. Yönlendirme döngüsünü önlemek için hata durumunda `/` yerine
 * açık bir hata yanıtı döner.
 */
export async function GET(request) {
  const config = readKeycloakConfig();
  const secure = authCookieSecurity(config, request.url);
  const clearTransaction = clearedCookieHeader(AUTH_TRANSACTION_COOKIE_NAME, { secure });

  try {
    assertKeycloakConfigured(config);
    const url = new URL(request.url);
    if (url.searchParams.get('error')) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Kimlik sağlayıcısı oturum açma isteğini reddetti.');
    }

    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (!code) throw new ServerPersistenceError('UNAUTHORIZED', 'Yetkilendirme kodu alınamadı.');

    const transaction = verifySignedValue(readRequestCookie(request, AUTH_TRANSACTION_COOKIE_NAME), config.sessionSecret);
    // Akış işareti zorunludur: implicit köprü işlemi bu uçta kabul EDİLMEZ.
    if (!isTransactionValid(transaction, state, { flow: KEYCLOAK_FLOWS.AUTHORIZATION_CODE })) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum açma isteği doğrulanamadı. Lütfen yeniden deneyin.');
    }

    const { accessToken } = await exchangeAuthorizationCode({
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: transaction.redirectUri,
      config
    });
    const identity = await authenticateAccessToken(accessToken, { config });
    debugLogIdentity('callback', identity);

    return redirectResponse(safeReturnTo(transaction.returnTo), [
      clearTransaction,
      sessionCookieHeader(identity, { config, secure })
    ]);
  } catch (error) {
    const response = authErrorResponse(error, { fallbackMessage: 'Oturum açma tamamlanamadı.' });
    response.headers.append('set-cookie', clearTransaction);
    return response;
  }
}
