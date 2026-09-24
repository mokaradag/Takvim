import { aiErrorResponse, aiJson } from '../../../../../../server/ai/aiRouteSupport.js';
import { getAiGateway } from '../../../../../../server/ai/aiRuntime.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Kişisel anahtarın açık doğrulaması.
 *
 * Model üretimi yapılmaz; yalnızca KİŞİSEL anahtar sınanır. İstemci bağlantıyı
 * keserse sağlayıcı çağrısı da iptal edilir.
 */
export const POST = withRouteObservability('ai.api.credential.validate', async (request) => {
  try {
    const validation = await getAiGateway().validatePersonalCredential({ signal: request.signal });
    return aiJson({ ok: true, validation });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
