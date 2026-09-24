import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { probeDeadline } from '../observability/boundedExecution.js';
import { AI_CONFIG_NAMES, aiConfigurationSummary, readAiConfig } from './aiConfig.js';
import { checkAiCredentialSchema } from './aiCredentialService.js';
import { aiCredentialSchemaState } from './aiCredentialStore.js';
import { raceWithAbort } from './aiDeadline.js';
import { isAiError } from './aiErrors.js';
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

/** Kurumsal anahtar yokken tek kimlik bilgisi kaynağı kişisel anahtar tablosudur (0016). */
function personalKeysOnly(config) {
  return config.personalKeysSupported && !config.defaultKeyConfigured;
}

/** Bileşen durumu + güvenli ayrıntı; `state`, `message`, `detail`, `lastSuccessAt` döner. */
export function aiHealthComponent({ now = Date.now() } = {}) {
  const config = readAiConfig();
  const configuration = aiConfigurationSummary(config);
  if (!config.enabled) {
    // Geçersiz bir etkinleştirme değeri (ör. `tru`) bilinçli kapatmadan ayrılır.
    return config.issues.length
      ? { state: HEALTH_STATES.WARNING, message: 'Yapay zekâ etkinleştirme ayarı geçersiz; özellik kapalı sayılıyor.', detail: { configuration } }
      : { state: HEALTH_STATES.NOT_CONFIGURED, message: 'Yapay zekâ özellikleri kapalı.', detail: { configuration } };
  }
  const registry = registryView(config);
  const load = aiRuntimeLoad() || idleLoad(config);
  const telemetry = aiTelemetrySnapshot();
  const credentialSchema = aiCredentialSchemaState();
  const detail = { configuration, registry, load, telemetry, credentialSchema: { ready: credentialSchema.ready } };
  const loadText = `Etkin ${load.active}/${load.limits.maxActive}, sırada ${load.queued}/${load.limits.maxQueued}.`;
  const lastContactAt = telemetry.provider.lastContactAt;
  const warning = (message) => ({ state: HEALTH_STATES.WARNING, message, detail, lastSuccessAt: lastContactAt });
  const unknown = (message) => ({ state: HEALTH_STATES.UNKNOWN, message, detail, lastSuccessAt: lastContactAt });

  if (config.issues.length) {
    return { state: HEALTH_STATES.WARNING, message: 'Yapay zekâ yapılandırması eksik ya da hatalı.', detail };
  }
  if (registry.status === 'error') {
    return { state: HEALTH_STATES.WARNING, message: 'Model kaydı geçersiz ya da okunamadı.', detail };
  }
  if (personalKeysOnly(config) && credentialSchema.ready === false) {
    return warning('Kişisel anahtar tablosu (0016) kurulmamış ve kurumsal anahtar tanımlı değil; yapay zekâ kullanılamıyor.');
  }
  // Yalnızca PAYLAŞILAN kapasitenin dolması uyarıdır; tek kullanıcının kendi
  // sınırı telemetride sayılır ama hizmetin dolu olduğunu göstermez.
  const recent = (value) => {
    const at = epoch(value);
    return at != null && now - at <= BUSY_ATTENTION_WINDOW_MS;
  };
  if (recent(telemetry.lastBusyAt)) return warning(`Kapasite doldu; bazı istekler geri çevrildi. ${loadText}`);
  if (recent(telemetry.lastQueueTimeoutAt)) return warning(`Kapasite yetersiz; bazı istekler sırada beklerken süre doldu. ${loadText}`);
  const queuePressure = load.limits.maxQueued > 0 && load.queued >= Math.ceil(load.limits.maxQueued * QUEUE_PRESSURE_RATIO);
  if (queuePressure) return warning(`Sıra dolmak üzere; henüz geri çevrilen istek yok. ${loadText}`);
  // Son sonuç damgalarla değil sıra sayacıyla belirlenir: aynı milisaniyedeki
  // başarı ve hata sırası karışmaz. Hata da başarı gibi yalnızca tazeyken
  // kanıttır: bayat bir hata süreç ömrü boyunca uyarı olarak kalmaz, durum
  // aşağıda "bilinmiyor"a düşer.
  const failureAt = epoch(telemetry.provider.lastFailureAt);
  if (telemetry.provider.lastOutcome === 'failure' && failureAt != null && now - failureAt <= CONTACT_FRESHNESS_MS) {
    return warning(`Son sağlayıcı çağrısı başarısız (${telemetry.provider.lastFailureCode}). ${loadText}`);
  }
  if (registry.status !== 'ready') {
    return unknown(`Model kaydı henüz yüklenmedi; ilk yapay zekâ isteğinde ya da bağlantı testinde okunur. ${loadText}`);
  }
  if (personalKeysOnly(config) && credentialSchema.ready !== true) {
    return unknown(`Kişisel anahtar tablosu henüz doğrulanmadı; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`);
  }
  const contactAt = epoch(lastContactAt);
  if (contactAt != null && now - contactAt <= CONTACT_FRESHNESS_MS) {
    return { state: HEALTH_STATES.HEALTHY, message: `Sağlayıcı yanıt veriyor. ${loadText}`, detail, lastSuccessAt: lastContactAt };
  }
  return unknown(`Sağlayıcıya yakın zamanda erişilmedi; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`);
}

/** Entegrasyonlar kartının alanları; adres, yol ve anahtar taşımaz. */
export function aiIntegrationCard() {
  const config = readAiConfig();
  if (!config.enabled && !config.issues.length) {
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
 * Uca ulaşıldıktan sonra kurulumun kullanılabilirliğini tamamlar: dosya
 * kaydı okunur (kendi süre sınırıyla) ve kurumsal anahtar yoksa kişisel
 * anahtar tablosunun kurulu olduğu doğrulanır. Sonuç önbelleğe yazılır; sağlık
 * görünümü bunu G/Ç yapmadan okur.
 */
async function verifySetup(config, timeoutMs) {
  if (config.registryPath) {
    try {
      await loadAiModelRegistry({ path: config.registryPath });
    } catch {
      return { code: 'MODEL_REGISTRY_INVALID', message: 'Uca ulaşıldı ancak model kaydı geçersiz ya da okunamadı.' };
    }
  }
  if (!personalKeysOnly(config)) return null;
  const deadline = probeDeadline(timeoutMs);
  try {
    const ready = await raceWithAbort(() => checkAiCredentialSchema({ signal: deadline.signal }), deadline.signal);
    return ready ? null : {
      code: 'CREDENTIAL_SCHEMA_MISSING',
      message: 'Uca ulaşıldı ancak kişisel anahtar tablosu (0016) kurulmamış; kurumsal anahtar da tanımlı değil.'
    };
  } catch {
    return { code: 'CREDENTIAL_SCHEMA_UNVERIFIED', message: 'Uca ulaşıldı ancak kişisel anahtar tablosu doğrulanamadı.' };
  } finally {
    deadline.close();
  }
}

/**
 * Yıkıcı olmayan bağlantı testi: model üretmeyen, süre sınırlı `GET /models`.
 *
 * Kurumsal anahtar tanımlıysa o kullanılır; hata yanıtının HTTP durumu dışında
 * hiçbir bilgisi okunmaz. Bu test PAYLAŞILAN yolu sınar: reddedilen kurumsal
 * anahtar, bulunamayan uç ya da geçersiz istek sağlık hatası olarak kaydedilir.
 */
export async function testAiProviderConnection({ timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = {}) {
  const config = readAiConfig();
  if (!config.enabled) {
    return config.issues.length
      ? { ok: false, durationMs: 0, code: 'CONFIGURATION_INVALID', message: 'Yapay zekâ etkinleştirme ayarı geçersiz.' }
      : { ok: false, durationMs: 0, code: AI_ERROR_CODES.AI_DISABLED, message: 'Yapay zekâ özellikleri kapalı.' };
  }
  if (!config.baseUrl) return { ok: false, durationMs: 0, code: 'NOT_CONFIGURED', message: 'Yapay zekâ ucu yapılandırılmamış.' };
  // Tanımlı ama geçersiz kurumsal anahtar "anahtar yok" sayılıp anahtarsız
  // istekle sınanmaz: test başarılı görünür, oysa her istek yapılandırma
  // hatası alırdı.
  if (config.issues.includes(AI_CONFIG_NAMES.DEFAULT_API_KEY)) {
    return { ok: false, durationMs: 0, code: 'DEFAULT_KEY_INVALID', message: 'Kurumsal anahtarın biçimi geçersiz; bağlantı sınanmadı.' };
  }
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  let durationMs;
  let outcome = null;
  try {
    const { status } = await raceWithAbort(
      () => getAiProvider().listModels({ baseUrl: config.baseUrl, apiKey: config.defaultApiKey, signal: deadline.signal }),
      deadline.signal
    );
    durationMs = Date.now() - startedAt;
    if (status >= 200 && status < 300) {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs });
      outcome = { ok: true, durationMs, code: null, message: `Bağlantı doğrulandı (${durationMs} ms).` };
    } else if ((status === 401 || status === 403) && !config.defaultKeyConfigured) {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs });
      outcome = { ok: true, durationMs, code: 'AUTHENTICATION_REQUIRED', message: 'Uca ulaşıldı; kurumsal anahtar tanımlı olmadığından anahtar sınanmadı.' };
    } else {
      recordProviderCall({
        operation: 'ai.provider.models',
        latencyMs: durationMs,
        code: classifyProviderStatus(status).code,
        healthFailure: true
      });
      return status === 401 || status === 403
        ? { ok: false, durationMs, code: 'DEFAULT_KEY_REJECTED', message: 'Uca ulaşıldı ancak kurumsal anahtar reddedildi.' }
        : { ok: false, durationMs, code: `HTTP_${status}`, message: 'Uç beklenmeyen bir yanıt verdi.' };
    }
  } catch (error) {
    durationMs = Date.now() - startedAt;
    const timedOut = deadline.signal.aborted;
    if (!timedOut && isAiError(error) && error.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID) {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: durationMs, code: error.code, healthFailure: true });
      return { ok: false, durationMs, code: 'MODEL_LIST_INVALID', message: 'Uç geçerli bir model listesi döndürmedi.' };
    }
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
  const setupProblem = await verifySetup(config, timeoutMs);
  return setupProblem ? { ok: false, durationMs, ...setupProblem } : outcome;
}
