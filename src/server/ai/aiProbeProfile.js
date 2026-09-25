import 'server-only';
import { AI_CAPABILITIES, AI_PROFILES, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import { AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS } from './aiDeadline.js';
import { AI_MODEL_REGISTRY_READ_TIMEOUT_MS, loadAiModelRegistry } from './modelRegistryLoader.js';

/**
 * Aşama 1 bağlantı sınamasının profili ve sunucu bütçesi.
 *
 * Ayarlar kartı sınamayı yalnızca `chat.fast` gerçekten çözülebiliyorsa açar
 * ve tarayıcı süre sınırını sunucunun GERÇEK bütçesinden kurar: kira öncesi
 * rehber denetimi + dosya kaydının okunması + kapasite sırası + profilin (yoksa
 * genel) istek süre sınırı. Böylece tarayıcı, sunucunun sınıflandırılmış
 * sonucundan önce vazgeçmez.
 */

export const AI_PROBE_PROFILE = AI_PROFILES.CHAT_FAST;

/** Sınamanın SABİT istemi ve çıktı sınırı; kullanıcı içeriği modele gönderilmez. */
export const AI_PROBE_MAX_OUTPUT_TOKENS = 64;
export const AI_PROBE_MESSAGES = Object.freeze([
  Object.freeze({
    role: 'system',
    content: 'MERGEN Rota bağlantı sınamasına yanıt veriyorsun. Yalnızca tek kısa Türkçe cümleyle yanıt ver.'
  }),
  Object.freeze({ role: 'user', content: 'Bağlantı sınaması: kısa bir selam yaz.' })
]);

/**
 * Sabit sınamanın bağlamda gerektirdiği yerin ÜST sınırı. Bayt düzeyinde
 * çalışan belirteçleyicilerde her belirteç en az bir bayttır; sohbet şablonunun
 * ileti başına eklediği belirteçler için cömert bir pay bırakılır. İstem sabit
 * olduğundan bu bir tahmin değil, kesin bir üst sınırdır: bağlam penceresi
 * bundan küçük bir modelde sınama sunulmaz.
 */
const MESSAGE_TEMPLATE_TOKENS = 16;
export const AI_PROBE_CONTEXT_TOKENS = AI_PROBE_MESSAGES
  .reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8') + MESSAGE_TEMPLATE_TOKENS, 0)
  + AI_PROBE_MAX_OUTPUT_TOKENS;

function budgetMs(config, timeoutMs) {
  return AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS + (config.registryPath ? AI_MODEL_REGISTRY_READ_TIMEOUT_MS : 0)
    + config.queueTimeoutMs + timeoutMs;
}

/**
 * Sınamanın rotası: `chat.fast` çözülmeli, sohbet yeteneği taşımalı ve
 * modelin bilinen bağlam penceresi sabit sınamayı alabilmelidir. Sağlık
 * görünümü ve bağlantı testi de aynı kuralı kullanır; profil kullanılamıyorsa
 * Aşama 1'in tek yürütme yolu çalışmaz.
 */
export function resolveAiProbeRoute(registry) {
  const resolved = resolveModelProfile(registry, AI_PROBE_PROFILE);
  if (!resolved.ok) return resolved;
  if (!resolved.route.capabilities.includes(AI_CAPABILITIES.CHAT)) return { ok: false, reason: 'CAPABILITY_MISMATCH' };
  if (resolved.route.contextTokens != null && resolved.route.contextTokens < AI_PROBE_CONTEXT_TOKENS) {
    return { ok: false, reason: 'CONTEXT_TOO_SMALL' };
  }
  return resolved;
}

/** `{ available, reason, timeoutMs, budgetMs }`; kayıt okunamazsa sınama kapalıdır. */
export async function describeAiProbe(config) {
  const unavailable = (reason) => ({
    available: false,
    reason,
    timeoutMs: config.requestTimeoutMs,
    budgetMs: budgetMs(config, config.requestTimeoutMs)
  });
  if (!config.available) return unavailable('CONFIGURATION_INVALID');
  let registry;
  try {
    registry = await loadAiModelRegistry({ path: config.registryPath });
  } catch {
    return unavailable('MODEL_REGISTRY_INVALID');
  }
  const resolved = resolveAiProbeRoute(registry);
  if (!resolved.ok) return unavailable(resolved.reason);
  const timeoutMs = resolved.route.timeoutMs ?? config.requestTimeoutMs;
  return { available: true, reason: null, timeoutMs, budgetMs: budgetMs(config, timeoutMs) };
}
