import { ServerPersistenceError } from '../../../../../server/errors.js';
import {
  KEYCLOAK_FLOWS,
  assertKeycloakConfigured,
  readKeycloakConfig
} from '../../../../../server/identity/keycloakConfig.js';
import { authenticateAccessToken } from '../../../../../server/identity/keycloakAuthentication.js';
import {
  TRANSACTION_REJECTIONS,
  inspectAuthTransaction,
  safeReturnTo
} from '../../../../../server/identity/keycloakPkce.js';
import { AUTH_TRANSACTION_COOKIE_NAME, verifySignedValue } from '../../../../../server/identity/keycloakSessionCookie.js';
import {
  BEARER_REJECTIONS,
  authCookieSecurity,
  authErrorResponse,
  clearedCookieHeader,
  debugLogIdentity,
  jsonResponse,
  readBearerToken,
  readRequestCookie,
  sessionCookieHeader
} from '../../../../../server/identity/authRouteSupport.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Implicit köprü ucu: tarayıcının URL parçasından aldığı erişim jetonunu
 * doğrulanmış, imzalı ve HttpOnly bir MERGEN Rota oturumuna çevirir.
 *
 * Bu uç genel uyumluluk ucundan (`/api/mergen-rota/auth/session`) DAHA SIKIDIR:
 * jetonun yanında, oturum açmayı bu sunucunun başlattığını kanıtlayan imzalı
 * işlem çerezi ve eşleşen `state` de zorunludur.
 *
 * Jeton doğrulaması TEK kanonik sınırda kalır: `authenticateAccessToken()`.
 * Burada hiçbir JWT doğrulaması TEKRARLANMAZ ve hiçbir kimlik verisi tarayıcıdan
 * kabul edilmez. Yanıt ne jetonu, ne claim'leri, ne de işlem yükünü döndürür.
 */

const TRANSACTION_MESSAGES = Object.freeze({
  [TRANSACTION_REJECTIONS.MISSING]: 'Oturum açma işlemi bulunamadı. Lütfen yeniden oturum açın.',
  [TRANSACTION_REJECTIONS.MALFORMED]: 'Oturum açma işlemi doğrulanamadı. Lütfen yeniden oturum açın.',
  [TRANSACTION_REJECTIONS.EXPIRED]: 'Oturum açma işleminin süresi doldu. Lütfen yeniden oturum açın.',
  [TRANSACTION_REJECTIONS.FLOW_MISMATCH]: 'Oturum açma işlemi bu akışa ait değil. Lütfen yeniden oturum açın.',
  [TRANSACTION_REJECTIONS.STATE_MISMATCH]: 'Oturum açma durumu eşleşmedi. Lütfen yeniden oturum açın.'
});

const BEARER_MESSAGES = Object.freeze({
  [BEARER_REJECTIONS.MISSING]: 'Erişim jetonu gönderilmedi.',
  [BEARER_REJECTIONS.MALFORMED]: 'Erişim jetonu biçimi geçersiz.'
});

/** İç kod ve aşama yalnızca sunucu günlüğüne gider; yanıta yazılmaz. */
function rejection(stage, internalCode, message) {
  const error = new ServerPersistenceError('UNAUTHORIZED', message);
  error.stage = stage;
  error.internalCode = internalCode;
  return error;
}

async function readState(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw rejection('body', 'BODY_MALFORMED', 'İstek gövdesi okunamadı.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw rejection('body', 'BODY_MALFORMED', 'İstek gövdesi okunamadı.');
  }
  const state = typeof payload.state === 'string' ? payload.state.trim() : '';
  if (!state) throw rejection('state', 'STATE_MISSING', 'Oturum açma durumu gönderilmedi.');
  return state;
}

export async function POST(request) {
  const config = readKeycloakConfig();
  const secure = authCookieSecurity(config, request.url);
  // İşlem tek kullanımlıktır: başarıda da başarısızlıkta da çerez temizlenir.
  const clearTransaction = clearedCookieHeader(AUTH_TRANSACTION_COOKIE_NAME, { secure });
  const rawTransaction = readRequestCookie(request, AUTH_TRANSACTION_COOKIE_NAME);
  const bearer = readBearerToken(request);

  try {
    assertKeycloakConfigured(config);
    if (config.flow !== KEYCLOAK_FLOWS.IMPLICIT_BRIDGE) {
      throw rejection('flow', 'FLOW_DISABLED', 'Implicit köprü kipi etkin değil.');
    }

    if (!rawTransaction) {
      throw rejection('transaction', TRANSACTION_REJECTIONS.MISSING, TRANSACTION_MESSAGES[TRANSACTION_REJECTIONS.MISSING]);
    }
    // İmza mevcut oturum-anahtarı makinesiyle doğrulanır; kurcalanmış çerez null döner.
    const transaction = verifySignedValue(rawTransaction, config.sessionSecret);
    if (!transaction) {
      throw rejection('transaction', TRANSACTION_REJECTIONS.MALFORMED, TRANSACTION_MESSAGES[TRANSACTION_REJECTIONS.MALFORMED]);
    }

    const state = await readState(request);
    // Süre, akış işareti ve `state` eşleşmesi (sabit zamanlı) tek yerde denetlenir.
    const transactionRejection = inspectAuthTransaction(transaction, state, { flow: KEYCLOAK_FLOWS.IMPLICIT_BRIDGE });
    if (transactionRejection) {
      throw rejection('transaction', transactionRejection, TRANSACTION_MESSAGES[transactionRejection]);
    }

    if (!bearer.token) {
      throw rejection('bearer', bearer.rejection, BEARER_MESSAGES[bearer.rejection]);
    }

    // Kanonik doğrulama sınırı: imza, issuer, kitle, azp, tür, süre, nbf,
    // algoritma, JWKS anahtarı, Sicil claim'i ve kullanıcı adı yedeği.
    const identity = await authenticateAccessToken(bearer.token, { config });
    debugLogIdentity('implicit-bridge', identity);

    return jsonResponse(
      { authenticated: true, returnTo: safeReturnTo(transaction.returnTo) },
      { cookieHeaders: [clearTransaction, sessionCookieHeader(identity, { config, secure })] }
    );
  } catch (error) {
    // Güvenli teşhis: aşama, durum, iç kod ve yalnızca VARLIK bilgisi. Jeton,
    // `state`, parça, işlem yükü veya claim'ler ASLA günlüğe yazılmaz.
    console.warn('MERGEN ROTA AUTH: implicit köprü reddi', {
      stage: error?.stage || 'unknown',
      status: error instanceof ServerPersistenceError ? error.status : 401,
      code: error?.internalCode || error?.code || 'AUTH_FAILED',
      flow: config.flow || 'invalid',
      bearerSupplied: Boolean(bearer.token),
      transactionSupplied: Boolean(rawTransaction)
    });
    const response = authErrorResponse(error, { fallbackMessage: 'Kurumsal oturum doğrulanamadı.' });
    response.headers.append('set-cookie', clearTransaction);
    return response;
  }
}
