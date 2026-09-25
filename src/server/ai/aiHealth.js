import 'server-only';
import { AI_CREDENTIAL_SOURCES } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { AI_CONFIG_NAMES, aiConfigurationSummary, readAiConfig } from './aiConfig.js';
import { checkAiCredentialSchema } from './aiCredentialService.js';
import { aiCredentialSchemaState } from './aiCredentialStore.js';
import { createAiDeadline, raceWithAbort } from './aiDeadline.js';
import { isAiError } from './aiErrors.js';
import { resolveAiProbeRoute } from './aiProbeProfile.js';
import { aiRuntimeLoad, getAiProvider } from './aiRuntime.js';
import { aiTelemetrySnapshot, recordProviderCall } from './aiTelemetry.js';
import { aiModelRegistryState, cachedAiModelRegistry, loadAiModelRegistry } from './modelRegistryLoader.js';
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
  // Sağlayıcıya ERİŞİM (reddedilen çağrı dâhil) başarılı işlem değildir:
  // bileşenin "son başarılı işlem" alanı uçtan uca başarılı yapay zekâ
  // isteğinin anıdır; erişim anı ayrıntıda (`telemetry.provider`) kalır.
  const lastContactAt = telemetry.provider.lastContactAt;
  const lastSuccessAt = telemetry.lastSuccessAt;
  const warning = (message) => ({ state: HEALTH_STATES.WARNING, message, detail, lastSuccessAt });
  const unknown = (message) => ({ state: HEALTH_STATES.UNKNOWN, message, detail, lastSuccessAt });

  if (config.issues.length) {
    return { state: HEALTH_STATES.WARNING, message: 'Yapay zekâ yapılandırması eksik ya da hatalı.', detail };
  }
  if (registry.status === 'error') {
    return { state: HEALTH_STATES.WARNING, message: 'Model kaydı geçersiz ya da okunamadı.', detail };
  }
  // Kişisel anahtar saklama açıksa tablosu, kurumsal anahtar istekleri
  // yürütebilse de ayrıca doğrulanır: tablo yoksa kullanıcılar anahtar ekleyemez.
  if (config.personalKeysSupported && credentialSchema.ready === false) {
    return warning(personalKeysOnly(config)
      ? 'Kişisel anahtar tablosu (0016) kurulmamış ve kurumsal anahtar tanımlı değil; yapay zekâ kullanılamıyor.'
      : 'Kişisel anahtar tablosu (0016) kurulmamış; kişisel anahtar kaydedilemiyor, istekler yalnızca kurumsal anahtarla yapılabiliyor.');
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
  // Kurumsal anahtarın reddi ayrı izlenir: kişisel anahtarla yapılan başarılı
  // bir çağrı, kurumsal anahtara bağlı kullanıcıların sorununu gizlemez. Yalnızca
  // kurumsal anahtarla yapılan başarılı bir çağrı bu uyarıyı kaldırır.
  const defaultKey = telemetry.provider.defaultKey || {};
  const defaultKeyFailureAt = epoch(defaultKey.lastFailureAt);
  if (config.defaultKeyConfigured && defaultKeyFailureAt != null && now - defaultKeyFailureAt <= CONTACT_FRESHNESS_MS) {
    return warning(defaultKey.lastFailureCode === AI_ERROR_CODES.AI_RATE_LIMITED
      ? `Kurumsal anahtar sağlayıcının istek sınırına ulaştı (${defaultKey.lastFailureCode}). ${loadText}`
      : `Kurumsal anahtar son kullanımında reddedildi (${defaultKey.lastFailureCode}); kişisel anahtarı olmayan kullanıcıların istekleri başarısız olur. ${loadText}`);
  }
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
  // Kayıt geçerli olsa da `chat.fast` çıkarılmış ya da kapatılmış olabilir:
  // Aşama 1'in tek yürütme yolu çalışmazken bileşen sağlıklı görünmez.
  const probeRoute = resolveAiProbeRoute(cachedAiModelRegistry());
  if (!probeRoute.ok) {
    return warning(`Hızlı sohbet profili (chat.fast) kullanılamıyor (${probeRoute.reason}); bağlantı sınaması çalışmaz. ${loadText}`);
  }
  if (config.personalKeysSupported && credentialSchema.ready !== true) {
    return unknown(`Kişisel anahtar tablosu henüz doğrulanmadı; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`);
  }
  const contactAt = epoch(lastContactAt);
  if (contactAt != null && now - contactAt <= CONTACT_FRESHNESS_MS) {
    return { state: HEALTH_STATES.HEALTHY, message: `Sağlayıcı yanıt veriyor. ${loadText}`, detail, lastSuccessAt };
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
 * Uca ulaşıldıktan sonra kurulumun kullanılabilirliğini tamamlar: kalan ayar
 * sorunları bildirilir, model kaydı okunur, sınama profili (`chat.fast`)
 * çözülmeli ve uç model listesini verdiyse modeli listede bulunmalıdır;
 * kişisel anahtar saklama açıksa (kurumsal anahtar tanımlı olsa da) anahtar
 * tablosunun kurulu olduğu doğrulanır. Hepsi testin TEK süre sınırı
 * altındadır; sonuç önbelleğe yazılır, sağlık görünümü bunu G/Ç yapmadan okur.
 */
async function verifySetup(config, deadline, models) {
  // Kurumsal anahtarın biçimi sağlayıcı çağrısından önce sınandı; kalan her
  // ayar sorunu (ör. geçersiz sınır, yer tutucu ana anahtar) kurulumu
  // kullanılamaz kılar: istekler AI_CONFIGURATION_ERROR alır.
  if (config.issues.length) {
    return { code: 'CONFIGURATION_INVALID', message: 'Uca ulaşıldı ancak yapay zekâ yapılandırması eksik ya da hatalı.' };
  }
  let registry;
  try {
    registry = await raceWithAbort(() => loadAiModelRegistry({ path: config.registryPath }), deadline.signal);
  } catch (error) {
    if (deadline.failure()) throw deadline.failure();
    return { code: 'MODEL_REGISTRY_INVALID', message: 'Uca ulaşıldı ancak model kaydı geçersiz ya da okunamadı.' };
  }
  const probeRoute = resolveAiProbeRoute(registry);
  if (!probeRoute.ok) {
    return {
      code: 'PROBE_PROFILE_UNAVAILABLE',
      message: `Uca ulaşıldı ancak hızlı sohbet profili (chat.fast) kullanılamıyor (${probeRoute.reason}); bağlantı sınaması çalışmaz.`
    };
  }
  if (models && !models.includes(probeRoute.route.model)) {
    return {
      code: 'PROBE_MODEL_MISSING',
      modelMissing: true,
      message: `Uca ulaşıldı ancak hızlı sohbet profilinin modeli (${probeRoute.route.model}) uçtaki model listesinde yok.`
    };
  }
  // Kişisel anahtar saklama açıksa tablo, kurumsal anahtar tanımlı olsa da doğrulanır.
  if (!config.personalKeysSupported) return null;
  try {
    const ready = await raceWithAbort(() => checkAiCredentialSchema({ signal: deadline.signal }), deadline.signal);
    return ready ? null : {
      code: 'CREDENTIAL_SCHEMA_MISSING',
      message: personalKeysOnly(config)
        ? 'Uca ulaşıldı ancak kişisel anahtar tablosu (0016) kurulmamış; kurumsal anahtar da tanımlı değil.'
        : 'Uca ulaşıldı ancak kişisel anahtar tablosu (0016) kurulmamış; kişisel anahtarlar kaydedilemez.'
    };
  } catch {
    if (deadline.failure()) throw deadline.failure();
    return { code: 'CREDENTIAL_SCHEMA_UNVERIFIED', message: 'Uca ulaşıldı ancak kişisel anahtar tablosu doğrulanamadı.' };
  }
}

function listModels(config, apiKey, deadline) {
  return raceWithAbort(
    () => getAiProvider().listModels({ baseUrl: config.baseUrl, apiKey, signal: deadline.signal }),
    deadline.signal
  );
}

/**
 * Anahtarsız istek model listesini veriyor mu? Yalnızca 2xx ve geçerli liste
 * "evet"tir; anahtarsız isteğe dönen her başka yanıt (401, 404, oturum açma
 * sayfası) ucun anahtarı denetlediğini gösterir.
 */
async function servesWithoutKey(config, deadline) {
  try {
    const { status } = await listModels(config, null, deadline);
    return status >= 200 && status < 300;
  } catch (error) {
    if (!deadline.failure() && isAiError(error) && error.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID) return false;
    throw error;
  }
}

/** Uca ulaşılamadı, süre doldu ya da test iptal edildi: sonuç ve sağlık izi. */
function unreachable(error, deadline, latencyMs, source) {
  const failure = deadline.failure();
  if (failure?.code === AI_ERROR_CODES.AI_CANCELLED) {
    return { ok: false, cancelled: true, code: 'PROBE_CANCELLED', message: 'Bağlantı testi iptal edildi.' };
  }
  if (failure) {
    recordProviderCall({ operation: 'ai.provider.models', latencyMs, code: AI_ERROR_CODES.AI_TIMEOUT, source });
    return { ok: false, code: 'PROBE_TIMEOUT', message: 'Uç süre sınırında yanıt vermedi.' };
  }
  if (isAiError(error) && error.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID) {
    recordProviderCall({ operation: 'ai.provider.models', latencyMs, code: error.code, healthFailure: true, source });
    return { ok: false, code: 'MODEL_LIST_INVALID', message: 'Uç geçerli bir model listesi döndürmedi.' };
  }
  recordProviderCall({ operation: 'ai.provider.models', latencyMs, code: AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, source });
  const code = String(error?.details?.networkCode || error?.code || 'PROBE_FAILED').slice(0, 60);
  return { ok: false, code, message: 'Uca ulaşılamadı.' };
}

/**
 * Yıkıcı olmayan bağlantı testi: model üretmeyen `GET /models`.
 *
 * Testin TAMAMI (sağlayıcı çağrıları, kayıt okuması, şema denetimi) tek bir süre
 * sınırı altındadır ve yöneticinin isteğini (`signal`) izler: sayfadan ayrılan
 * yöneticinin testi sağlayıcı işini ve süreç içi kilidi bekletmez; iptal edilen
 * test sonuç olarak kaydedilmez. Bildirilen süre kurulum doğrulamasını da
 * kapsar; sağlayıcı gecikmesi ayrıca ölçülür.
 *
 * Kurumsal anahtar tanımlıysa o kullanılır; hata yanıtının HTTP durumu dışında
 * hiçbir bilgisi okunmaz. Bu test PAYLAŞILAN yolu sınar: reddedilen kurumsal
 * anahtar, bulunamayan uç ya da geçersiz istek sağlık hatası olarak kaydedilir.
 * Kurumsal anahtarla alınan liste ancak uç anahtarsız isteği reddediyorsa
 * anahtarın kanıtıdır; liste herkese açıksa anahtar bu testle doğrulanamaz ve
 * test başarılı sayılmaz.
 */
export async function testAiProviderConnection({ timeoutMs = CONNECTION_TEST_TIMEOUT_MS, signal = null } = {}) {
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
  const startedAt = Date.now();
  const finish = (result) => ({ ...result, durationMs: Date.now() - startedAt });
  const source = config.defaultKeyConfigured ? AI_CREDENTIAL_SOURCES.DEFAULT : null;
  const deadline = createAiDeadline({ timeoutMs, parentSignal: signal });
  let latencyMs = 0;
  try {
    let listed;
    let success;
    try {
      listed = await listModels(config, config.defaultApiKey, deadline);
      latencyMs = Date.now() - startedAt;
      if (listed.status >= 200 && listed.status < 300 && config.defaultKeyConfigured && await servesWithoutKey(config, deadline)) {
        recordProviderCall({ operation: 'ai.provider.models', latencyMs, source, contact: false });
        return finish({
          ok: false,
          code: 'DEFAULT_KEY_UNVERIFIED',
          message: 'Uca ulaşıldı ancak model listesi anahtarsız da verildiği için kurumsal anahtar bu testle doğrulanamadı. Anahtarı Ayarlar sayfasındaki deneme isteğiyle sınayın.'
        });
      }
    } catch (error) {
      return finish(unreachable(error, deadline, latencyMs || Date.now() - startedAt, source));
    }
    const { status } = listed;
    if (status >= 200 && status < 300) {
      success = { ok: true, code: null, models: listed.models ?? [] };
    } else if ((status === 401 || status === 403) && !config.defaultKeyConfigured) {
      success = { ok: true, code: 'AUTHENTICATION_REQUIRED', models: null, message: 'Uca ulaşıldı; kurumsal anahtar tanımlı olmadığından anahtar sınanmadı.' };
    } else {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs, code: classifyProviderStatus(status).code, healthFailure: true, source });
      return finish(status === 401 || status === 403
        ? { ok: false, code: 'DEFAULT_KEY_REJECTED', message: 'Uca ulaşıldı ancak kurumsal anahtar reddedildi.' }
        : { ok: false, code: `HTTP_${status}`, message: 'Uç beklenmeyen bir yanıt verdi.' });
    }
    let setupProblem;
    try {
      setupProblem = await verifySetup(config, deadline, success.models);
    } catch {
      recordProviderCall({ operation: 'ai.provider.models', latencyMs, source: status >= 200 && status < 300 ? source : null });
      return finish(deadline.failure()?.code === AI_ERROR_CODES.AI_CANCELLED
        ? { ok: false, cancelled: true, code: 'PROBE_CANCELLED', message: 'Bağlantı testi iptal edildi.' }
        : { ok: false, code: 'PROBE_TIMEOUT', message: 'Uca ulaşıldı ancak kurulum doğrulaması süre sınırında tamamlanamadı.' });
    }
    if (setupProblem?.modelMissing) {
      // Uç yanıt veriyor ama tek Aşama 1 yolu (chat.fast) kullanılamıyor: sağlıklı temas sayılmaz.
      recordProviderCall({ operation: 'ai.provider.models', latencyMs, code: AI_ERROR_CODES.AI_CONFIGURATION_ERROR, healthFailure: true });
      return finish({ ok: false, code: setupProblem.code, message: setupProblem.message });
    }
    recordProviderCall({ operation: 'ai.provider.models', latencyMs, source: status >= 200 && status < 300 ? source : null });
    if (setupProblem) return finish({ ok: false, code: setupProblem.code, message: setupProblem.message });
    return finish({
      ok: true,
      code: success.code,
      message: success.message || `Bağlantı doğrulandı (${Date.now() - startedAt} ms).`
    });
  } finally {
    deadline.dispose();
  }
}
