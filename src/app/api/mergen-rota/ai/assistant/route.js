import { loadAssistantReadiness } from '../../../../../server/ai/assistant/assistantService.js';
import { aiErrorResponse, aiJson } from '../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Rota AI hazırlık durumu.
 *
 * Kimlik ve rehber üyeliği doğrulandıktan sonra yalnızca kullanılabilirlik,
 * nedeni ve kiplerin (Standart / Derin düşünme) açık olup olmadığı döner;
 * adres, anahtar ya da model adı dönmez.
 */
export const GET = withRouteObservability('ai.api.assistant.readiness', async (request) => {
  try {
    return aiJson({ ok: true, assistant: await loadAssistantReadiness({ signal: request.signal }) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
