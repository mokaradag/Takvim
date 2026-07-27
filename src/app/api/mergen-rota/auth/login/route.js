import {
  KEYCLOAK_FLOWS,
  assertKeycloakConfigured,
  readKeycloakConfig
} from '../../../../../server/identity/keycloakConfig.js';
import {
  APP_ROOT_PATH,
  AUTHORIZATION_CALLBACK_PATH,
  IMPLICIT_CALLBACK_PATH
} from '../../../../../server/identity/keycloakFlows.js';
import {
  buildAuthorizationUrl,
  buildImplicitAuthorizationUrl,
  createAuthTransaction,
  createImplicitAuthTransaction,
  safeReturnTo
} from '../../../../../server/identity/keycloakPkce.js';
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
 * Oturum açma akışının başlangıcı.
 *
 * Etkin akış YALNIZCA sunucu yapılandırmasından (`MERGEN_ROTA_KEYCLOAK_FLOW`)
 * seçilir; tarayıcı akışı değiştiremez.
 */
function authorizationCodeRedirect({ config, requestUrl, returnTo, secure }) {
  const transaction = createAuthTransaction({ returnTo });
  const redirectUri = config.redirectUri
    || new URL(AUTHORIZATION_CALLBACK_PATH, requestUrl.origin).toString();

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
    flow: transaction.flow,
    state: transaction.state,
    codeVerifier: transaction.codeVerifier,
    redirectUri,
    returnTo: transaction.returnTo,
    exp: transaction.exp
  }, config.sessionSecret), { secure });

  return redirectResponse(authorizationUrl, [cookie]);
}

function implicitBridgeRedirect({ config, requestUrl, returnTo, secure }) {
  const transaction = createImplicitAuthTransaction({ returnTo });
  const redirectUri = config.implicitRedirectUri
    || new URL(IMPLICIT_CALLBACK_PATH, requestUrl.origin).toString();

  const authorizationUrl = buildImplicitAuthorizationUrl({
    authorizationEndpoint: config.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri,
    scope: config.scope,
    state: transaction.state
  });

  const cookie = transactionCookieHeader(signSessionValue({
    flow: transaction.flow,
    state: transaction.state,
    returnTo: transaction.returnTo,
    exp: transaction.exp
  }, config.sessionSecret), { secure });

  return redirectResponse(authorizationUrl, [cookie]);
}

export async function GET(request) {
  try {
    const config = assertKeycloakConfigured(readKeycloakConfig());
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get('returnTo') || APP_ROOT_PATH);
    const secure = authCookieSecurity(config, request.url);

    return config.flow === KEYCLOAK_FLOWS.IMPLICIT_BRIDGE
      ? implicitBridgeRedirect({ config, requestUrl: url, returnTo, secure })
      : authorizationCodeRedirect({ config, requestUrl: url, returnTo, secure });
  } catch (error) {
    return authErrorResponse(error, { fallbackMessage: 'Oturum açma başlatılamadı.' });
  }
}
