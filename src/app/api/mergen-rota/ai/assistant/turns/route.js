import { assistantStreamResponse } from '../../../../../../server/ai/assistant/assistantStreamResponse.js';
import { ASSISTANT_TURN_BODY_BYTES, prepareAssistantTurn } from '../../../../../../server/ai/assistant/assistantService.js';
import { aiErrorResponse, assertSameOriginAiRequest, readJsonBody } from '../../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Rota AI turu: yeni ileti, aynı turun yeniden gönderimi ya da yanıtsız son
 * turun yeniden denenmesi. Yalnızca aynı kaynaktan kabul edilir.
 *
 * Akış başlamadan önceki hatalar (oturum, yetki, gövde, kip, konuşma) olağan
 * JSON hata yanıtıyla döner. Sonrası akış protokolüyle (`accepted`, `status`,
 * `delta`, `done` | `error`) sürer. İstemci bağlantıyı keserse üretim
 * sağlayıcıya kadar iptal edilir.
 */
export const POST = withRouteObservability('ai.api.assistant.turn', async (request) => {
  let turn = null;
  try {
    assertSameOriginAiRequest(request);
    turn = await prepareAssistantTurn({
      readBody: (signal) => readJsonBody(request, { maxBytes: ASSISTANT_TURN_BODY_BYTES, signal }),
      signal: request.signal
    });
    return assistantStreamResponse(turn, { signal: request.signal });
  } catch (error) {
    turn?.claim.release();
    return aiErrorResponse(error);
  }
});
