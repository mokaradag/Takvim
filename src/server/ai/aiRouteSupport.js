import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { COMPONENTS, EVENT_SEVERITIES } from '../../domain/observability/eventModel.js';
import { safeErrorResponse, ServerPersistenceError } from '../errors.js';
import { isSameOriginRequest } from '../identity/sameOriginRequest.js';
import { logEvent } from '../observability/structuredLogger.js';
import { AiError, isAiError } from './aiErrors.js';

/**
 * Yapay zekâ uçlarının ortak yanıt ve gövde yardımcıları.
 *
 * Yanıtlar önbelleğe alınmaz. Hata gövdesi var olan sözleşmeyi izler
 * (`{ error: { code, message, details } }`); yeniden denenebilir sonuçlar
 * `Retry-After` başlığı taşır.
 */

const NO_STORE = Object.freeze({ 'cache-control': 'no-store' });
const MAX_BODY_BYTES = 8192;

export function aiJson(body, { status = 200 } = {}) {
  return Response.json(body, { status, headers: NO_STORE });
}

function invalidBody(reason) {
  return new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { details: { reason } });
}

/**
 * Durum değiştiren her yapay zekâ isteği aynı kaynaktan gelmelidir.
 *
 * Gövdesiz `POST /probe` ve `POST /credential/validation` basit (ön denetimsiz)
 * isteklerdir: `SameSite=Lax` çerezi aynı sitedeki kardeş bir kaynağın
 * formuyla da gider ve kullanıcının anahtarıyla sağlayıcı çağrısı ya da kapasite
 * tüketimi tetiklenebilirdi. Denetim oturum çözümünden ÖNCE yapılır.
 */
export function assertSameOriginAiRequest(request) {
  if (!isSameOriginRequest(request)) {
    throw new ServerPersistenceError('FORBIDDEN', 'Yapay zekâ isteği aynı kaynaktan gelmelidir.');
  }
}

/**
 * JSON gövdesini SINIRLI okur.
 *
 * Ayrıştırma hatası günlüğe yazılmaz ve yanıta taşınmaz: çalışma zamanının
 * JSON hata iletisi gövdenin bir parçasını (ör. bir API anahtarını) içerebilir.
 * İstemcinin gövde gönderirken bağlantıyı kesmesi iç hata değil, kararlı bir
 * istek sonucudur.
 *
 * `signal` işlemin süre sınırıdır: gövdeyi yavaşça damlatan istemci, okumayı
 * sınırın ötesinde tutamaz. Sinyal kesilince okuyucu iptal edilir ve
 * `signal.reason` fırlatılır.
 */
export async function readJsonBody(request, { maxBytes = MAX_BODY_BYTES, signal = null } = {}) {
  if (!/^application\/json\b/i.test(String(request.headers.get('content-type') || ''))) throw invalidBody('CONTENT_TYPE');
  signal?.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) throw invalidBody('EMPTY_BODY');
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch {
        signal?.throwIfAborted();
        throw invalidBody('BODY_INTERRUPTED');
      }
      // İptal edilen okuyucu bekleyen okumayı `done` ile bitirir; bu bir gövde sonu değildir.
      signal?.throwIfAborted();
      const { done, value } = step;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw invalidBody('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidBody('MALFORMED_JSON');
  return parsed;
}

function aiErrorBody(error) {
  return { error: { code: error.code, message: error.message, details: error.details ?? null } };
}

export function aiErrorResponse(error) {
  if (isAiError(error)) {
    const headers = { ...NO_STORE };
    if (error.retryAfterMs) headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
    return Response.json(aiErrorBody(error), { status: error.status, headers });
  }
  // Oturum, yetki ve veritabanı hataları var olan sözleşmeyle döner; önbellek
  // anlamı öteki yapay zekâ yanıtlarıyla aynıdır.
  if (error instanceof ServerPersistenceError) {
    const response = safeErrorResponse(error);
    response.headers.set('cache-control', 'no-store');
    return response;
  }
  logEvent({
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.AI,
    operation: 'ai.api',
    code: AI_ERROR_CODES.AI_INTERNAL_ERROR,
    message: 'Yapay zekâ ucunda beklenmeyen hata.',
    error
  });
  const internal = new AiError(AI_ERROR_CODES.AI_INTERNAL_ERROR);
  return Response.json(aiErrorBody(internal), { status: internal.status, headers: NO_STORE });
}
