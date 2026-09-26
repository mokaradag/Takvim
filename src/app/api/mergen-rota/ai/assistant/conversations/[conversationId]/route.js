import {
  deleteAssistantConversation,
  loadAssistantConversation
} from '../../../../../../../server/ai/assistant/assistantService.js';
import { aiErrorResponse, aiJson, assertSameOriginAiRequest } from '../../../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Tek konuşma: okuma ve silme. Sahiplik sunucuda, oturumdaki kullanıcıyla
 * denetlenir; başka bir kullanıcının konuşması var olmayan konuşmayla aynı
 * yanıtı (404) alır. Silme yalnızca aynı kaynaktan kabul edilir.
 */
export const GET = withRouteObservability('ai.api.assistant.conversation.load', async (request, context) => {
  try {
    return aiJson({
      ok: true,
      ...(await loadAssistantConversation({ conversationId: context?.params?.conversationId, signal: request.signal }))
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
});

export const DELETE = withRouteObservability('ai.api.assistant.conversation.delete', async (request, context) => {
  try {
    assertSameOriginAiRequest(request);
    return aiJson({
      ok: true,
      ...(await deleteAssistantConversation({ conversationId: context?.params?.conversationId, signal: request.signal }))
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
