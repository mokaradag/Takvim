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
import { classifyProviderStatus, createControlApiKey } from './providers/openAiCompatibleProvider.js';

/**
 * Yapay zekâ sağlığı — Sistem Yönetimi için.
 *
 * Sağlık hesabı HİÇBİR ağ ya da dosya işlemi BEKLEMEZ; yanıt vermeyen bir uç
 * sayfayı askıda bırakamaz. Ağa çıkan tek işlem, yöneticinin başlattığı süre
 * sınırlı bağlantı testidir. İsteğe bağlı yetenek olduğundan hiçbir zaman
 * KRİTİK bildirilmez.
 */

const CONTACT_FRESHNESS_MS = 15 * 60 * 1000;
/** Tablonun kurulu olduğunu gösteren olumlu gözlem bu süreden eskiyse kanıt sayılmaz. */
const SCHEMA_FRESHNESS_MS = 15 * 60 * 1000;
const BUSY_ATTENTION_WINDOW_MS = 5 * 60 * 1000;
/** Kapasite sonuçları kendi pencerelerinde bildirilir; hizmet hatası denetimine girmez. */
const CAPACITY_CODES = new Set([AI_ERROR_CODES.AI_BUSY, AI_ERROR_CODES.AI_QUEUE_TIMEOUT]);
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
  const detail = {
    configuration,
    registry,
    load,
    telemetry,
    credentialSchema: { ready: credentialSchema.ready, observedAt: credentialSchema.observedAt }
  };
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
  // Rehber denetimi kapısı yapay zekâ kapasitesinden ÖNCE gelir: geri çevrilen
  // istekler etkin/sıra sayaçlarına hiç girmediği için o sayaçlar gösterilmez.
  if (recent(telemetry.lastDirectoryBusyAt)) {
    return warning('Kurumsal personel denetiminin (SQL) sınırlı kapasitesi doldu; bazı yapay zekâ istekleri kapasite denetimine ulaşmadan geri çevrildi. Veritabanı yanıt sürelerini denetleyin.');
  }
  if (recent(telemetry.lastBusyAt)) return warning(`Kapasite doldu; bazı istekler geri çevrildi. ${loadText}`);
  if (recent(telemetry.lastQueueTimeoutAt)) return warning(`Kapasite yetersiz; bazı istekler sırada beklerken süre doldu. ${loadText}`);
  const queuePressure = load.limits.maxQueued > 0 && load.queued >= Math.ceil(load.limits.maxQueued * QUEUE_PRESSURE_RATIO);
  if (queuePressure) return warning(`Sıra dolmak üzere; henüz geri çevrilen istek yok. ${loadText}`);
  // Kurumsal anahtarın reddi ayrı izlenir: kişisel anahtarla yapılan başarılı
  // bir çağrı, kurumsal anahtara bağlı kullanıcıların sorununu gizlemez. Ret
  // (401/403) YAŞLANARAK kalkmaz; yalnızca kurumsal anahtarın kabul edildiği bir
  // çağrı bu uyarıyı kaldırır. Geçici olan oran sınırı (429) ise tazeyken uyarıdır.
  const defaultKey = telemetry.provider.defaultKey || {};
  const defaultKeyFailureAt = epoch(defaultKey.lastFailureAt);
  if (config.defaultKeyConfigured && defaultKeyFailureAt != null) {
    if (defaultKey.lastFailureCode !== AI_ERROR_CODES.AI_RATE_LIMITED) {
      return warning(`Kurumsal anahtar son kullanımında reddedildi (${defaultKey.lastFailureCode}); kişisel anahtarı olmayan kullanıcıların istekleri başarısız olur. ${loadText}`);
    }
    if (now - defaultKeyFailureAt <= CONTACT_FRESHNESS_MS) {
      return warning(`Kurumsal anahtar sağlayıcının istek sınırına ulaştı (${defaultKey.lastFailureCode}). ${loadText}`);
    }
  }
  // Son sonuç damgalarla değil sıra sayacıyla belirlenir: aynı milisaniyedeki
  // başarı ve hata sırası karışmaz. Hata da başarı gibi yalnızca tazeyken
  // kanıttır: bayat bir hata süreç ömrü boyunca uyarı olarak kalmaz, durum
  // aşağıda "bilinmiyor"a düşer.
  const failureAt = epoch(telemetry.provider.lastFailureAt);
  if (telemetry.provider.lastOutcome === 'failure' && failureAt != null && now - failureAt <= CONTACT_FRESHNESS_MS) {
    return warning(`Son sağlayıcı çağrısı başarısız (${telemetry.provider.lastFailureCode}). ${loadText}`);
  }
  // Sağlayıcıya ulaşmadan düşen hizmet hataları (rehber sorgusu, anahtar
  // tablosu, iç hata) da sağlıklı görünmez: ondan sonra başarılı bir istek ya da
  // doğrulama gelmediyse ve hata tazeyse uyarıdır.
  const serviceFailure = telemetry.lastFailure;
  const serviceFailureAt = epoch(serviceFailure?.at);
  if (serviceFailure && !CAPACITY_CODES.has(serviceFailure.code)
    && Number(serviceFailure.sequence) > Number(telemetry.lastOkSequence || 0)
    && serviceFailureAt != null && now - serviceFailureAt <= CONTACT_FRESHNESS_MS) {
    return warning(`Son yapay zekâ isteği hizmet hatasıyla sonuçlandı (${serviceFailure.code}). ${loadText}`);
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
  // Tablonun kurulu olduğu gözlemi de kalıcı değildir: tablo sonradan
  // kaldırılabilir ya da yetkisi alınabilir. Eski bir olumlu gözlem kanıt sayılmaz.
  const schemaObservedAt = epoch(credentialSchema.observedAt);
  const schemaFresh = schemaObservedAt != null && now - schemaObservedAt <= SCHEMA_FRESHNESS_MS;
  if (config.personalKeysSupported && (credentialSchema.ready !== true || !schemaFresh)) {
    return unknown(credentialSchema.ready === true
      ? `Kişisel anahtar tablosu yakın zamanda doğrulanmadı; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`
      : `Kişisel anahtar tablosu henüz doğrulanmadı; Entegrasyonlar sekmesinden bağlantıyı sınayın. ${loadText}`);
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

/** Tek `GET /models` çağrısı ve KENDİ gecikmesi; hata fırlatılmaz, sonuçla döner. */
async function timedListModels(config, apiKey, deadline) {
  const startedAt = Date.now();
  try {
    const listed = await listModels(config, apiKey, deadline);
    return { listed, error: null, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { listed: null, error, latencyMs: Date.now() - startedAt };
  }
}

const isSuccess = (status) => status >= 200 && status < 300;

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
 * Kurumsal anahtarla alınan liste GÖNDERİLEN anahtarın kanıtı mı? Aynı istek
 * rastgele bir denetim anahtarıyla yinelenir. Yalnızca kimlik doğrulamaya özgü
 * ret (401/403) anahtarın denetlendiğini kanıtlar; denetim anahtarıyla da liste
 * dönüyorsa uç anahtarı denetlemiyordur; geri kalan her yanıt sonucu belirsiz
 * bırakır. Denetim çağrısı kendi gecikmesi ve gerçek HTTP sonucuyla ölçülür;
 * beklenen reddi sağlık hatası değildir. `null`, denetimin kanıtladığını söyler.
 */
async function verifyKeyEnforced(config, deadline) {
  const control = await timedListModels(config, createControlApiKey(), deadline);
  if (control.error) return { result: unreachable(control.error, deadline, control.latencyMs, null) };
  const { status } = control.listed;
  if (status === 401 || status === 403) {
    recordProviderCall({
      operation: 'ai.provider.models',
      latencyMs: control.latencyMs,
      code: classifyProviderStatus(status).code,
      healthFailure: false
    });
    return null;
  }
  if (isSuccess(status)) {
    recordProviderCall({ operation: 'ai.provider.models', latencyMs: control.latencyMs, contact: false });
    return {
      result: {
        ok: false,
        code: 'DEFAULT_KEY_UNVERIFIED',
        message: 'Uca ulaşıldı ancak model listesi geçersiz bir anahtarla da verildiği için kurumsal anahtar bu testle doğrulanamadı. Anahtarı Ayarlar sayfasındaki deneme isteğiyle sınayın.'
      }
    };
  }
  recordProviderCall({ operation: 'ai.provider.models', latencyMs: control.latencyMs, code: classifyProviderStatus(status).code });
  return {
    result: {
      ok: false,
      code: 'DEFAULT_KEY_UNVERIFIED',
      message: `Uca ulaşıldı ancak anahtar denetimi sınanamadı (HTTP ${status}); kurumsal anahtar bu testle doğrulanamadı. Biraz sonra yeniden deneyin.`
    }
  };
}

/**
 * Yıkıcı olmayan bağlantı testi: model üretmeyen `GET /models`.
 *
 * Testin TAMAMI (sağlayıcı çağrıları, kayıt okuması, şema denetimi) tek bir süre
 * sınırı altındadır ve yöneticinin isteğini (`signal`) izler: sayfadan ayrılan
 * yöneticinin testi sağlayıcı işini ve süreç içi kilidi bekletmez; iptal edilen
 * test sonuç olarak kaydedilmez. Bildirilen süre kurulum doğrulamasını da
 * kapsar; her sağlayıcı çağrısı kendi gecikmesi ve GERÇEK HTTP sonucuyla ayrıca
 * ölçülür.
 *
 * Kurumsal anahtar tanımlıysa o kullanılır; hata yanıtının HTTP durumu dışında
 * hiçbir bilgisi okunmaz. Bu test PAYLAŞILAN yolu sınar: reddedilen kurumsal
 * anahtar, bulunamayan uç ya da geçersiz istek sağlık hatası olarak kaydedilir.
 * Kurumsal anahtarla alınan liste ancak uç geçersiz bir denetim anahtarını
 * 401/403 ile reddediyorsa anahtarın kanıtıdır. Kurumsal anahtar yokken
 * anahtarsız isteğe dönen 401 ucun erişilebilir olduğunu ve kimlik istediğini
 * gösterir; 403 ise bir erişim/ağ politikası reddi olabileceği için başarı
 * sayılmaz.
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
  const operation = 'ai.provider.models';
  const deadline = createAiDeadline({ timeoutMs, parentSignal: signal });
  try {
    const keyed = await timedListModels(config, config.defaultApiKey, deadline);
    if (keyed.error) return finish(unreachable(keyed.error, deadline, keyed.latencyMs, source));
    const { status } = keyed.listed;
    const listedOk = isSuccess(status);
    let success;
    if (listedOk) {
      if (config.defaultKeyConfigured) {
        const unverified = await verifyKeyEnforced(config, deadline);
        if (unverified) {
          // Kurumsal anahtarın kabulü kanıtlanmadı: erişim de anahtar kabulü de kaydedilmez.
          recordProviderCall({ operation, latencyMs: keyed.latencyMs, source, contact: false, keyAccepted: false });
          return finish(unverified.result);
        }
      }
      success = { ok: true, code: null, models: keyed.listed.models ?? [] };
    } else if (status === 401 && !config.defaultKeyConfigured) {
      // Uç erişilebilir ve kimlik istiyor: HTTP işlemi başarısızdır, sağlık izi erişimdir.
      recordProviderCall({ operation, latencyMs: keyed.latencyMs, code: classifyProviderStatus(status).code, healthFailure: false });
      success = { ok: true, code: 'AUTHENTICATION_REQUIRED', models: null, message: 'Uca ulaşıldı; kurumsal anahtar tanımlı olmadığından anahtar sınanmadı.' };
    } else {
      recordProviderCall({ operation, latencyMs: keyed.latencyMs, code: classifyProviderStatus(status).code, healthFailure: true, source });
      if (status === 401 || status === 403) {
        return finish(config.defaultKeyConfigured
          ? { ok: false, code: 'DEFAULT_KEY_REJECTED', message: 'Uca ulaşıldı ancak kurumsal anahtar reddedildi.' }
          : { ok: false, code: 'ACCESS_FORBIDDEN', message: 'Uç anahtarsız isteği 403 ile reddetti; bu bir erişim ya da ağ politikası reddi olabilir. Kişisel anahtarla deneme isteği gönderip doğrulayın.' });
      }
      return finish({ ok: false, code: `HTTP_${status}`, message: 'Uç beklenmeyen bir yanıt verdi.' });
    }
    // Kurumsal anahtarla alınan (ve denetimi kanıtlanan) liste: HTTP işlemi başarılıdır.
    const recordKeyed = (extra = {}) => {
      if (listedOk) recordProviderCall({ operation, latencyMs: keyed.latencyMs, source, ...extra });
    };
    let setupProblem;
    try {
      setupProblem = await verifySetup(config, deadline, success.models);
    } catch {
      recordKeyed();
      return finish(deadline.failure()?.code === AI_ERROR_CODES.AI_CANCELLED
        ? { ok: false, cancelled: true, code: 'PROBE_CANCELLED', message: 'Bağlantı testi iptal edildi.' }
        : { ok: false, code: 'PROBE_TIMEOUT', message: 'Uca ulaşıldı ancak kurulum doğrulaması süre sınırında tamamlanamadı.' });
    }
    if (setupProblem?.modelMissing) {
      // Uç yanıt veriyor ve kurumsal anahtar kabul edildi, ama tek Aşama 1 yolu
      // (chat.fast) kullanılamıyor: anahtarın eski reddi temizlenir, sağlıklı
      // temas ise sayılmaz; sağlık izi asıl sorunu (yapılandırma) gösterir.
      recordKeyed({ keyAccepted: true, healthFailure: true, healthCode: AI_ERROR_CODES.AI_CONFIGURATION_ERROR });
      return finish({ ok: false, code: setupProblem.code, message: setupProblem.message });
    }
    recordKeyed();
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
