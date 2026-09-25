import {
  loadAiCredentialStatus,
  removeAiPersonalCredential,
  saveAiPersonalCredential
} from '../../../../../server/ai/aiCredentialService.js';
import {
  aiErrorResponse,
  aiJson,
  assertSameOriginAiRequest,
  readJsonBody
} from '../../../../../server/ai/aiRouteSupport.js';
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
 * Durum değiştiren istekler yalnızca aynı kaynaktan kabul edilir. Gövde, kimlik
 * ve rehber üyeliği doğrulandıktan SONRA ve işlemin süre sınırıyla okunur.
 * İstemci bağlantıyı keserse (`request.signal`) süren işlem iptal edilir;
 * bırakılmış bir kayıt sonradan uygulanmaz.
 */
export const GET = withRouteObservability('ai.api.credential.status', async (request) => {
  try {
    return aiJson({ ok: true, ai: await loadAiCredentialStatus({ signal: request.signal }) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});

export const PUT = withRouteObservability('ai.api.credential.save', async (request) => {
  try {
    assertSameOriginAiRequest(request);
    const ai = await saveAiPersonalCredential({
      readApiKey: async (signal) => (await readJsonBody(request, { signal })).apiKey,
      signal: request.signal
    });
    return aiJson({ ok: true, ai });
  } catch (error) {
    return aiErrorResponse(error);
  }
});

export const DELETE = withRouteObservability('ai.api.credential.delete', async (request) => {
  try {
    assertSameOriginAiRequest(request);
    return aiJson({ ok: true, ai: await removeAiPersonalCredential({ signal: request.signal }) });
  } catch (error) {
    return aiErrorResponse(error);
  }
});
