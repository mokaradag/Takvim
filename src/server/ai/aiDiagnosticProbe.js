import 'server-only';
import { AI_PROBE_PROFILE } from './aiProbeProfile.js';
import { getAiGateway } from './aiRuntime.js';

/**
 * Aşama 1 bağlantı sınaması.
 *
 * Alt sistemin bütün zincirini (güvenilir Sicil → kimlik bilgisi → profil →
 * sağlayıcı → kapasite → süre sınırı → telemetri) tek, küçük bir istekle
 * kanıtlar. İstem SABİTTİR: kullanıcı içeriği modele gönderilmez ve bu uç bir
 * sohbet ucuna dönüşemez. Somut model değil `chat.fast` profili istenir. Araç
 * istenmediği için boş (`content: null`) yanıt sınama sonucu değil, geçersiz
 * sağlayıcı yanıtıdır.
 */

const PROBE_MAX_OUTPUT_TOKENS = 64;
const PROBE_TEXT_LIMIT = 600;

const PROBE_MESSAGES = Object.freeze([
  Object.freeze({
    role: 'system',
    content: 'MERGEN Rota bağlantı sınamasına yanıt veriyorsun. Yalnızca tek kısa Türkçe cümleyle yanıt ver.'
  }),
  Object.freeze({ role: 'user', content: 'Bağlantı sınaması: kısa bir selam yaz.' })
]);

export async function runAiDiagnosticProbe({ signal = null } = {}) {
  const result = await getAiGateway().completeChat({
    profile: AI_PROBE_PROFILE,
    messages: PROBE_MESSAGES,
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    signal,
    requireText: true
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
