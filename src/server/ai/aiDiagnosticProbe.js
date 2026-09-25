import 'server-only';
import { AI_PROBE_MAX_OUTPUT_TOKENS, AI_PROBE_MESSAGES, AI_PROBE_PROFILE } from './aiProbeProfile.js';
import { getAiGateway } from './aiRuntime.js';

/**
 * Aşama 1 bağlantı sınaması.
 *
 * Alt sistemin bütün zincirini (güvenilir Sicil → kimlik bilgisi → profil →
 * sağlayıcı → kapasite → süre sınırı → telemetri) tek, küçük bir istekle
 * kanıtlar. İstem SABİTTİR: kullanıcı içeriği modele gönderilmez ve bu uç bir
 * sohbet ucuna dönüşemez. Somut model değil `chat.fast` profili istenir. Araç
 * istenmediği için boş (`content: null`) yanıt sınama sonucu değil, geçersiz
 * sağlayıcı yanıtıdır. İstek sunucunun ürettiği sabit bir istek olduğu için
 * sağlayıcının "geçersiz istek" yanıtı (400/413/422) kullanıcı hatası değil,
 * yapılandırma hatası olarak bildirilir.
 */

const PROBE_TEXT_LIMIT = 600;

export async function runAiDiagnosticProbe({ signal = null } = {}) {
  const result = await getAiGateway().completeChat({
    profile: AI_PROBE_PROFILE,
    messages: AI_PROBE_MESSAGES,
    maxOutputTokens: AI_PROBE_MAX_OUTPUT_TOKENS,
    signal,
    requireText: true,
    callerInput: false
  });
  return {
    text: String(result.text || '').trim().slice(0, PROBE_TEXT_LIMIT),
    finishReason: result.finishReason,
    profile: result.profile,
    model: result.model,
    configuredModel: result.configuredModel,
    credentialSource: result.credentialSource,
    durationMs: result.durationMs,
    queueWaitMs: result.queueWaitMs,
    usage: result.usage
  };
}
