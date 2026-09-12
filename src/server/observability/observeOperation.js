import 'server-only';
import { COMPONENTS, EVENT_SEVERITIES } from '../../domain/observability/eventModel.js';
import { acceptedCorrelationId, currentCorrelationId, newCorrelationId, withCorrelation } from './correlation.js';
import { recordOperation } from './telemetryRegistry.js';
import { logEvent } from './structuredLogger.js';

/**
 * Ölçüm ve ilişkilendirmenin TEK giriş noktası.
 *
 * Gözlemlenebilirlik uygulamaya sızmaz: ölçüm sarmalayıcısı işlevin dönüşünü
 * ve hatasını olduğu gibi geçirir, kendi hatasını YUTAR. Telemetri bir
 * işlemi bozamaz.
 */

const CORRELATION_HEADER = 'x-mergen-rota-correlation-id';

function failureCode(error) {
  if (!error) return null;
  const code = error.code ?? error.name ?? null;
  return code == null ? 'UNEXPECTED_ERROR' : String(code).slice(0, 60);
}

function safely(work) {
  try { work(); } catch { /* telemetri hatası uygulamayı etkilemez */ }
}

/**
 * Bir zaman uyumsuz işlemi ölçer.
 *
 * @param {string} operation kararlı işlem adı (ör. `api.commit`)
 * @param {() => Promise<any>} work
 * @param {{component?: string, context?: object, logSuccess?: boolean}} options
 */
export async function observeOperation(operation, work, { component = COMPONENTS.API, context = null, logSuccess = false } = {}) {
  const startedAt = Date.now();
  try {
    const result = await work();
    const durationMs = Date.now() - startedAt;
    safely(() => {
      recordOperation({ operation, durationMs, ok: true, at: startedAt });
      if (logSuccess) {
        logEvent({ severity: EVENT_SEVERITIES.INFO, component, operation, durationMs, context });
      }
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    safely(() => {
      recordOperation({ operation, durationMs, ok: false, code: failureCode(error), at: startedAt });
      logEvent({
        severity: EVENT_SEVERITIES.ERROR,
        component,
        operation,
        code: failureCode(error),
        message: 'İşlem hata ile sonuçlandı.',
        durationMs,
        context,
        error
      });
    });
    throw error;
  }
}

/**
 * Sonucu HATA FIRLATMADAN bildiren turlar için ölçüm.
 *
 * Outlook ve hatırlatma turları `{ ok: false, reason }` döner; başarısızlık
 * yine de hata oranına yazılmalıdır.
 */
export async function observeOutcome(operation, work, { component = COMPONENTS.API, isFailure = (result) => result?.ok === false } = {}) {
  const startedAt = Date.now();
  try {
    const result = await work();
    const durationMs = Date.now() - startedAt;
    safely(() => {
      const failed = Boolean(isFailure(result));
      recordOperation({
        operation,
        durationMs,
        ok: !failed,
        code: failed ? String(result?.reason || 'UNKNOWN').slice(0, 60) : null,
        at: startedAt
      });
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    safely(() => {
      recordOperation({ operation, durationMs, ok: false, code: failureCode(error), at: startedAt });
      logEvent({ severity: EVENT_SEVERITIES.ERROR, component, operation, code: failureCode(error), durationMs, error });
    });
    throw error;
  }
}

/**
 * Bir Next.js rota işleyicisini ölçüm ve ilişkilendirme bağlamına sarar.
 *
 * İmza korunur: işleyici aynı argümanları alır, aynı `Response` değerini
 * döndürür. Yanıt başlığına ilişkilendirme kimliği eklenir; yönetici bir
 * olaydan ilgili isteğin izine ulaşabilir.
 */
export function withRouteObservability(operation, handler, { component = COMPONENTS.API } = {}) {
  return async function observedRouteHandler(request, ...rest) {
    const correlationId = acceptedCorrelationId(request?.headers?.get?.(CORRELATION_HEADER)) || newCorrelationId();
    return withCorrelation({ correlationId, operation }, async () => {
      const startedAt = Date.now();
      let response;
      try {
        response = await handler(request, ...rest);
      } catch (error) {
        safely(() => {
          recordOperation({ operation, durationMs: Date.now() - startedAt, ok: false, code: failureCode(error), at: startedAt });
          logEvent({
            severity: EVENT_SEVERITIES.ERROR,
            component,
            operation,
            code: failureCode(error),
            correlationId,
            durationMs: Date.now() - startedAt,
            error
          });
        });
        throw error;
      }
      const durationMs = Date.now() - startedAt;
      const status = Number(response?.status ?? 200);
      safely(() => {
        // 4xx İSTEMCİ kararıdır (yetki, doğrulama); hata oranı sunucu
        // sağlığını anlatmalıdır, bu yüzden yalnızca 5xx hata sayılır.
        recordOperation({
          operation,
          durationMs,
          ok: status < 500,
          code: status >= 500 ? `HTTP_${status}` : null,
          at: startedAt
        });
      });
      try {
        response?.headers?.set?.(CORRELATION_HEADER, correlationId);
      } catch { /* dondurulmuş başlık kümesi yanıtı bozmaz */ }
      return response;
    });
  };
}

export { CORRELATION_HEADER, currentCorrelationId };
