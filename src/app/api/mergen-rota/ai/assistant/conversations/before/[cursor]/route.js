import { listAssistantConversations } from '../../../../../../../../server/ai/assistant/assistantService.js';
import { aiErrorResponse, aiJson } from '../../../../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Konuşma listesinin sonraki sayfası. İmleç yalnızca sıralama konumunu taşır;
 * sorgu her zaman oturumdaki kullanıcının konuşmalarıyla sınırlıdır.
 */
export const GET = withRouteObservability('ai.api.assistant.conversations.page', async (request, context) => {
  try {
    return aiJson({ ok: true, ...(await listAssistantConversations({ cursor: context?.params?.cursor ?? '', signal: request.signal })) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
