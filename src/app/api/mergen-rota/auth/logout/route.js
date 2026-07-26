import { readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { buildEndSessionUrl } from '../../../../../server/identity/keycloakPkce.js';
import { AUTH_TRANSACTION_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../../../../server/identity/keycloakSessionCookie.js';
import {
  authCookieSecurity,
  clearedCookieHeader,
  jsonResponse,
  redirectResponse
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Oturumu kapatır.
 *
 * MERGEN Rota oturum çerezi HER DURUMDA temizlenir; Keycloak yapılandırması
 * eksik olsa bile yerel oturum kapanır. Keycloak `end_session` ucu tanımlıysa
 * kullanıcı oraya yönlendirilerek kimlik sağlayıcısı oturumu da sonlandırılır.
 */
function logoutCookies(config, requestUrl) {
  const secure = authCookieSecurity(config, requestUrl);
  return [
    clearedCookieHeader(SESSION_COOKIE_NAME, { secure }),
    clearedCookieHeader(AUTH_TRANSACTION_COOKIE_NAME, { secure })
  ];
}

export async function POST(request) {
  const config = readKeycloakConfig();
  const url = new URL(request.url);
  const postLogoutRedirectUri = config.postLogoutRedirectUri || new URL('/', url.origin).toString();
  const endSessionUrl = buildEndSessionUrl({
    endSessionEndpoint: config.endSessionEndpoint,
    clientId: config.clientId,
    postLogoutRedirectUri
  });
  // İstemci yönlendirmeyi kendisi yapar; böylece fetch tabanlı çıkış akışında
  // yönlendirme döngüsü oluşmaz.
  return jsonResponse(
    { signedOut: true, endSessionUrl: endSessionUrl || postLogoutRedirectUri },
    { cookieHeaders: logoutCookies(config, request.url) }
  );
}

export async function GET(request) {
  const config = readKeycloakConfig();
  const url = new URL(request.url);
  const postLogoutRedirectUri = config.postLogoutRedirectUri || new URL('/', url.origin).toString();
  const endSessionUrl = buildEndSessionUrl({
    endSessionEndpoint: config.endSessionEndpoint,
    clientId: config.clientId,
    postLogoutRedirectUri
  });
  return redirectResponse(endSessionUrl || postLogoutRedirectUri, logoutCookies(config, request.url));
}
