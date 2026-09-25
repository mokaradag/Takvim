import { runAiDiagnosticProbe } from '../../../../../server/ai/aiDiagnosticProbe.js';
import { aiErrorResponse, aiJson, assertSameOriginAiRequest } from '../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Aşama 1 bağlantı sınaması.
 *
 * Sabit, küçük bir istekle alt sistemin bütün zincirini kanıtlar. İstemci
 * bağlantıyı keserse (`request.signal`) sıradaki istek sıradan çıkar, süren
 * sağlayıcı çağrısı iptal edilir ve kapasite bırakılır. Gövdesiz bir POST
 * olduğu için yalnızca aynı kaynaktan kabul edilir.
 */
export const POST = withRouteObservability('ai.api.probe', async (request) => {
  try {
    assertSameOriginAiRequest(request);
    return aiJson({ ok: true, result: await runAiDiagnosticProbe({ signal: request.signal }) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
