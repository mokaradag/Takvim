import {
  loadAiCredentialStatus,
  removeAiPersonalCredential,
  saveAiPersonalCredential
} from '../../../../../server/ai/aiCredentialService.js';
import { aiErrorResponse, aiJson, readJsonBody } from '../../../../../server/ai/aiRouteSupport.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Kişisel yapay zekâ anahtarı.
 *
 * Sahip her zaman oturumdaki Sicil'dir; gövdede, sorguda ya da başlıkta gelen
 * hiçbir kimlik okunmaz. Yanıt anahtarı ya da şifreli hâlini asla taşımaz.
 */
export const GET = withRouteObservability('ai.api.credential.status', async () => {
  try {
    return aiJson({ ok: true, ai: await loadAiCredentialStatus() });
  } catch (error) {
    return aiErrorResponse(error);
  }
});

export const PUT = withRouteObservability('ai.api.credential.save', async (request) => {
  try {
    const body = await readJsonBody(request);
    return aiJson({ ok: true, ai: await saveAiPersonalCredential({ apiKey: body.apiKey }) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});

export const DELETE = withRouteObservability('ai.api.credential.delete', async () => {
  try {
    return aiJson({ ok: true, ai: await removeAiPersonalCredential() });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
