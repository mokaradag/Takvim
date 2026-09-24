import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { probeDeadline } from '../observability/boundedExecution.js';
import { aiConfigurationSummary, readAiConfig } from './aiConfig.js';
import { raceWithAbort } from './aiDeadline.js';
import { aiRuntimeLoad, getAiProvider } from './aiRuntime.js';
import { aiTelemetrySnapshot, recordProviderCall } from './aiTelemetry.js';
import { aiModelRegistryState, loadAiModelRegistry } from './modelRegistryLoader.js';
import { classifyProviderStatus } from './providers/openAiCompatibleProvider.js';

/**
 * Yapay zekâ sağlığı — Sistem Yönetimi için.
 *
 * Sağlık hesabı HİÇBİR ağ ya da dosya işlemi BEKLEMEZ; yanıt vermeyen bir uç
 * sayfayı askıda bırakamaz. Ağa çıkan tek işlem, yöneticinin başlattığı süre
 * sınırlı bağlantı testidir. İsteğe bağlı yetenek olduğundan hiçbir zaman
 * KRİTİK bildirilmez.
 */

const CONTACT_FRESHNESS_MS = 15 * 60 * 1000;
const BUSY_ATTENTION_WINDOW_MS = 5 * 60 * 1000;
const QUEUE_PRESSURE_RATIO = 0.8;
const CONNECTION_TEST_TIMEOUT_MS = 6000;

function idleLoad(config) {
  return {
    active: 0,
    queued: 0,
    activeUsers: 0,
    queuedUsers: 0,
    limits: { ...config.limits },
    counters: { admitted: 0, rejectedBusy: 0, queueTimeouts: 0, cancelledWhileQueued: 0 }
  };
}

function epoch(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function registryView(config) {
  // Varsayılan kayıt G/Ç gerektirmez; dosya kaydı ilk yapay zekâ isteğinde yüklenir.
  if (!config.registryPath) loadAiModelRegistry({ path: null }).catch(() => {});
  return aiModelRegistryState();
}

/** Bileşen durumu + güvenli ayrıntı; `state`, `message`, `detail`, `lastSuccessAt` döner. */
export function aiHealthComponent({ now = Date.now() } = {}) {
  const config = readAiConfig();
  const configuration = aiConfigurationSummary(config);
  if (!config.enabled) {
    return { state: HEALTH_STATES.NOT_CONFIGURED, message: 'Yapay zekâ özellikleri kapalı.', detail: { configuration } };
  }
  const registry = registryView(config);
  const load = aiRuntimeLoad() || idleLoad(config);
  const telemetry = aiTelemetrySnapshot();
  const detail = { configuration, registry, load, telemetry };
  const loadText = `Etkin ${load.active}/${load.limits.maxActive}, sırada ${load.queued}/${load.limits.maxQueued}.`;
  const lastContactAt = telemetry.provider.lastContactAt;

  if (config.issues.length) {
    return { state: HEALTH_STATES.WARNING, message: 'Yapay zekâ yapılandırması eksik ya da hatalı.', detail };
  }
  if (registry.status === 'error') {
    return { state: HEALTH_STATES.WARNING, message: 'Model kaydı geçersiz ya da okunamadı.', detail };
  }
  const queuePressure = load.limits.maxQueued > 0 && load.queued >= Math.ceil(load.limits.maxQueued * QUEUE_PRESSURE_RATIO);
  const busyAt = epoch(telemetry.lastBusyAt);
  if (queuePressure || (busyAt != null && now - busyAt <= BUSY_ATTENTION_WINDOW_MS)) {
    return { state: HEALTH_STATES.WARNING, message: `Kapasite doldu; bazı istekler geri çevrildi. ${loadText}`, detail, lastSuccessAt: lastContactAt };
  }
  const contactAt = epoch(lastContactAt);
  const failureAt = epoch(telemetry.provider.lastFailureAt);
  if (failureAt != null && (contactAt == null || failureAt > contactAt)) {
    return {
      state: HEALTH_STATES.WARNING,
      message: `Son sağlayıcı çağrısı başarısız (${telemetry.provider.lastFailureCode}). ${loadText}`,
      detail,
      lastSuccessAt: lastContactAt
    };
  }
  if (contactAt != null && now - contactAt <= CONTACT_FRESHNESS_MS) {
    return { state: HEALTH_STATES.HEALTHY, message: `Sağlayıcı yanıt veriyor. ${loadText}`, detail, lastSuccessAt: lastContactAt };
  }
  return {
    state: HEALTH_STATES.UNKNOWN,
    message: `Sağlayıcıya yakın zamanda erişilmedi; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`,
    detail,
    lastSuccessAt: lastContactAt
  };
}

/** Entegrasyonlar kartının alanları; adres, yol ve anahtar taşımaz. */
export function aiIntegrationCard() {
  const config = readAiConfig();
  if (!config.enabled) {
    return { configured: false, state: HEALTH_STATES.NOT_CONFIGURED, message: 'Yapay zekâ özellikleri kapalı.', testable: false };
  }
  if (config.issues.length) {
    return {
      configured: false,
      state: HEALTH_STATES.WARNING,
      message: 'Yapılandırma eksik ya da hatalı.',
      detail: { missing: [...config.issues] },
      testable: Boolean(config.baseUrl)
    };
  }
  const health = aiHealthComponent();
  return {
    configured: true,
    state: health.state,
    message: `İstekler OpenAI uyumlu kurum içi uca gider. ${health.message}`,
    testable: true
  };
}

/**
 * Yıkıcı olmayan bağlantı testi: model üretmeyen, süre sınırlı `GET /models`.
 *
 * Kurumsal anahtar tanımlıysa o kullanılır; yanıtın HTTP durumu dışında
 * hiçbir bilgisi okunmaz.
 */
export async function testAiProviderConnection({ timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = {}) {
  const config = readAiConfig();
  if (!config.enabled) return { ok: false, durationMs: 0, code: AI_ERROR_CODES.AI_DISABLED, message: 'Yapay zekâ özellikleri kapalı.' };
  if (!config.baseUrl) return { ok: false, durationMs: 0, code: 'NOT_CONFIGURED', message: 'Yapay zekâ ucu yapılandırılmamış.' };
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const { status } = await raceWithAbort(
      () => getAiProvider().listModels({ baseUrl: config.baseUrl, apiKey: config.defaultApiKey, signal: deadline.signal }),
      deadline.signal
    );
    const durationMs = Date.now() - startedAt;
    if (status >= 200 && status < 300) {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs });
      return { ok: true, durationMs, code: null, message: `Bağlantı doğrulandı (${durationMs} ms).` };
    }
    if (status === 401 || status === 403) {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs });
      return config.defaultKeyConfigured
        ? { ok: false, durationMs, code: 'DEFAULT_KEY_REJECTED', message: 'Uca ulaşıldı ancak kurumsal anahtar reddedildi.' }
        : { ok: true, durationMs, code: 'AUTHENTICATION_REQUIRED', message: 'Uca ulaşıldı; kurumsal anahtar tanımlı olmadığından anahtar sınanmadı.' };
    }
    recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs, code: classifyProviderStatus(status).code });
    return { ok: false, durationMs, code: `HTTP_${status}`, message: 'Uç beklenmeyen bir yanıt verdi.' };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const timedOut = deadline.signal.aborted;
    recordProviderCall({
      operation: 'ai.provider.models',
      latencyMs: durationMs,
      code: timedOut ? AI_ERROR_CODES.AI_TIMEOUT : AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE
    });
    const code = timedOut ? 'PROBE_TIMEOUT' : String(error?.details?.networkCode || error?.code || 'PROBE_FAILED').slice(0, 60);
    return { ok: false, durationMs, code, message: 'Uca ulaşılamadı.' };
  } finally {
    deadline.close();
  }
}
