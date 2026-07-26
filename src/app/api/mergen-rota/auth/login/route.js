import { assertKeycloakConfigured, readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { buildAuthorizationUrl, createAuthTransaction, safeReturnTo } from '../../../../../server/identity/keycloakPkce.js';
import { signSessionValue } from '../../../../../server/identity/keycloakSessionCookie.js';
import {
  authCookieSecurity,
  authErrorResponse,
  redirectResponse,
  transactionCookieHeader
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Authorization Code + PKCE akışının başlangıcı.
 *
 * `state` ve `code_verifier` tarayıcıya açık verilmez: imzalı, HttpOnly ve
 * kısa ömürlü bir işlem çerezinde taşınır. `returnTo` yalnızca uygulama içi
 * yol olabilir; açık yönlendirme (open redirect) engellenir.
 */
export async function GET(request) {
  try {
    const config = assertKeycloakConfigured(readKeycloakConfig());
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get('returnTo') || '/');
    const transaction = createAuthTransaction({ returnTo });
    const secure = authCookieSecurity(config, request.url);

    const redirectUri = config.redirectUri || new URL('/api/mergen-rota/auth/callback', url.origin).toString();
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: config.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri,
      scope: config.scope,
      state: transaction.state,
      codeChallenge: transaction.codeChallenge,
      codeChallengeMethod: transaction.codeChallengeMethod
    });

    const cookie = transactionCookieHeader(signSessionValue({
      state: transaction.state,
      codeVerifier: transaction.codeVerifier,
      redirectUri,
      returnTo: transaction.returnTo,
      exp: transaction.exp
    }, config.sessionSecret), { secure });

    return redirectResponse(authorizationUrl, [cookie]);
  } catch (error) {
    return authErrorResponse(error, { fallbackMessage: 'Oturum açma başlatılamadı.' });
  }
}
