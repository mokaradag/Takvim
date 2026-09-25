import { readKeycloakConfig } from '../../../../../server/identity/keycloakConfig.js';
import { APP_ROOT_PATH } from '../../../../../server/identity/keycloakFlows.js';
import { buildEndSessionUrl } from '../../../../../server/identity/keycloakPkce.js';
import { AUTH_TRANSACTION_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../../../../server/identity/keycloakSessionCookie.js';
import {
  authCookieSecurity,
  clearedCookieHeader,
  jsonResponse
} from '../../../../../server/identity/authRouteSupport.js';
import { isSameOriginRequest } from '../../../../../server/identity/sameOriginRequest.js';

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

function fallbackPostLogoutRedirect(config, requestUrl) {
  if (config.postLogoutRedirectUri) return config.postLogoutRedirectUri;
  return new URL(APP_ROOT_PATH, new URL(requestUrl).origin).toString();
}

/*
 * Üçüncü taraf bir sayfa, çerez temizleyen bu uca form gönderip kullanıcıyı
 * zorla oturumdan düşürebiliyordu; istek aynı kaynaktan gelmelidir (bkz.
 * `isSameOriginRequest`). Çerez temizleyen bir `GET` ucu BULUNMAZ: bağlantıya
 * tıklatmak ya da `<img src>` ile istemek yeterdi.
 */
export async function POST(request) {
  if (!isSameOriginRequest(request)) {
    return jsonResponse(
      { error: { code: 'FORBIDDEN', message: 'Oturum kapatma isteği aynı kaynaktan gelmelidir.', details: null } },
      { status: 403 }
    );
  }
  const config = readKeycloakConfig();
  const postLogoutRedirectUri = fallbackPostLogoutRedirect(config, request.url);
  const endSessionUrl = buildEndSessionUrl({
    endSessionEndpoint: config.endSessionEndpoint,
    clientId: config.clientId,
    postLogoutRedirectUri
  });
  return jsonResponse(
    { signedOut: true, endSessionUrl: endSessionUrl || postLogoutRedirectUri },
    { cookieHeaders: logoutCookies(config, request.url) }
  );
}
