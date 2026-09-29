import { listAssistantConversations } from '../../../../../../server/ai/assistant/assistantService.js';
import { aiErrorResponse, aiJson } from '../../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Oturumdaki kullanıcının son konuşmaları (son etkinliğe göre, ilk sayfa).
 * Sonraki sayfa `before/[cursor]` ucundadır; ileti gövdeleri listede taşınmaz.
 */
export const GET = withRouteObservability('ai.api.assistant.conversations.list', async (request) => {
  try {
    return aiJson({ ok: true, ...(await listAssistantConversations({ signal: request.signal })) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
