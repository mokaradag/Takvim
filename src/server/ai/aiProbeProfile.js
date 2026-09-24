import 'server-only';
import { AI_CAPABILITIES, AI_PROFILES, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import { AI_MODEL_REGISTRY_READ_TIMEOUT_MS, loadAiModelRegistry } from './modelRegistryLoader.js';

/**
 * Aşama 1 bağlantı sınamasının profili ve sunucu bütçesi.
 *
 * Ayarlar kartı sınamayı yalnızca `chat.fast` gerçekten çözülebiliyorsa açar
 * ve tarayıcı süre sınırını sunucunun GERÇEK bütçesinden kurar: dosya kaydının
 * okunması + kapasite sırası + profilin (yoksa genel) istek süre sınırı. Böylece
 * tarayıcı, sunucunun sınıflandırılmış sonucundan önce vazgeçmez.
 */

export const AI_PROBE_PROFILE = AI_PROFILES.CHAT_FAST;

function budgetMs(config, timeoutMs) {
  return (config.registryPath ? AI_MODEL_REGISTRY_READ_TIMEOUT_MS : 0) + config.queueTimeoutMs + timeoutMs;
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
  const resolved = resolveModelProfile(registry, AI_PROBE_PROFILE);
  if (!resolved.ok) return unavailable(resolved.reason);
  if (!resolved.route.capabilities.includes(AI_CAPABILITIES.CHAT)) return unavailable('CAPABILITY_MISMATCH');
  const timeoutMs = resolved.route.timeoutMs ?? config.requestTimeoutMs;
  return { available: true, reason: null, timeoutMs, budgetMs: budgetMs(config, timeoutMs) };
}
