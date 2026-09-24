import 'server-only';
import { AI_CREDENTIAL_SOURCES, AI_CREDENTIAL_VALIDATION } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AI_CAPABILITIES, AI_MAX_OUTPUT_TOKENS, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import { isWithinSqlTransaction } from '../db/pool.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { readAiConfig, requireAiAvailable } from './aiConfig.js';
import {
  assertAiDirectoryMember,
  readPersonalCredentialForValidation,
  resolveAiCredential,
  storeCredentialValidation
} from './aiCredentialService.js';
import { abortableDelay, createAiDeadline, raceWithAbort } from './aiDeadline.js';
import { AiError, toAiFailure } from './aiErrors.js';
import { recordAiRequest, recordAiRetry, recordAiValidation, recordProviderCall } from './aiTelemetry.js';
import { loadAiModelRegistry } from './modelRegistryLoader.js';
import { classifyProviderStatus, isConnectFailure } from './providers/openAiCompatibleProvider.js';

/**
 * Yapay zekâ ağ geçidi — alt sistemin TEK yürütme yolu.
 *
 * Sıra şudur: güvenilir Sicil → kurumsal rehber üyeliği → yapılandırma →
 * profil çözümü → kapasite kirası → kimlik bilgisi (kira ALTINDA ve süre
 * sınırıyla) → sağlayıcı. Kira ve süre sınırı her yolda bırakılır. Ağ geçidi
 * açık bir SQL işlemi içinde çalışmayı reddeder; sağlayıcı yanıtı beklenirken
 * hiçbir SQL bağlantısı ya da işlemi tutulmaz. Olağan Rota uçları bu yola hiç
 * girmez.
 */

const MAX_PROVIDER_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_JITTER_MS = 400;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const VALIDATION_TIMEOUT_MS = 15000;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32000;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
/**
 * Belirteç TAHMİNİ. Sağlayıcının belirteçleyicisi bilinmez; tahmin bilinçli
 * olarak düşük tutulur (belirteç başına çok karakter) ki bağlama sığan bir
 * istek yanlışlıkla reddedilmesin. Yalnızca KESİNLİKLE sığmayan istek
 * kapasite ve sağlayıcı harcanmadan reddedilir.
 */
const CHARS_PER_TOKEN_ESTIMATE = 6;
const MESSAGE_OVERHEAD_TOKENS = 4;
const KNOWN_SOURCES = new Set(Object.values(AI_CREDENTIAL_SOURCES));

const DEFAULT_KEY_MESSAGES = Object.freeze({
  [AI_ERROR_CODES.AI_KEY_INVALID]: 'Kurumsal yapay zekâ anahtarı reddedildi. Sistem yöneticinize başvurun.',
  [AI_ERROR_CODES.AI_UNAUTHORIZED]: 'Kurumsal yapay zekâ anahtarının bu yeteneğe erişim yetkisi yok. Sistem yöneticinize başvurun.'
});

function assertOutsideSqlTransaction() {
  if (isWithinSqlTransaction()) {
    throw new AiError(AI_ERROR_CODES.AI_INTERNAL_ERROR, { details: { reason: 'SQL_TRANSACTION_ACTIVE' } });
  }
}

function requireRoute(registry, profile, capability) {
  const resolved = resolveModelProfile(registry, profile);
  if (!resolved.ok) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
      message: 'İstenen yapay zekâ yeteneği yapılandırılmamış.',
      details: { reason: resolved.reason, profile: String(profile ?? '').slice(0, 40) }
    });
  }
  if (!resolved.route.capabilities.includes(capability)) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'CAPABILITY_MISMATCH', profile } });
  }
  return resolved.route;
}

function requireMessages(messages) {
  const valid = Array.isArray(messages) && messages.length > 0 && messages.length <= MAX_MESSAGES
    && messages.every((message) => MESSAGE_ROLES.has(message?.role)
      && typeof message.content === 'string' && message.content.length <= MAX_MESSAGE_CHARS);
  if (!valid) throw new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { details: { reason: 'MESSAGES_INVALID' } });
  return messages.map(({ role, content }) => ({ role, content }));
}

function estimatePromptTokens(messages) {
  return messages.reduce((total, message) => total + MESSAGE_OVERHEAD_TOKENS
    + Math.ceil(message.content.length / CHARS_PER_TOKEN_ESTIMATE), 0);
}

/**
 * İstenen çıktı sınırı: çağıranın değeri profil sınırıyla, modelin bağlam
 * penceresinde istemden sonra kalan yerle ve genel üst sınırla daraltılır.
 * Profil sınırı tanımsız olsa bile çağıran bağlamı aşan bir değer isteyemez;
 * istem bağlama hiç sığmıyorsa istek sağlayıcıya gitmeden reddedilir.
 */
function outputTokenLimit(requested, route, promptTokens) {
  const remaining = route.contextTokens == null ? null : route.contextTokens - promptTokens;
  if (remaining != null && remaining < 1) {
    throw new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, {
      message: 'İstek, seçilen modelin bağlam penceresine sığmıyor.',
      details: { reason: 'PROMPT_TOO_LONG' }
    });
  }
  const asked = Number.isSafeInteger(requested) && requested > 0 ? requested : null;
  const base = asked ?? route.maxOutputTokens ?? null;
  if (base == null) return null;
  return Math.min(base, route.maxOutputTokens ?? Infinity, remaining ?? Infinity, AI_MAX_OUTPUT_TOKENS);
}

/** Anahtar kaynaklı sonuçlar hangi anahtarın reddedildiğini söyler; kurumsal anahtar için kullanıcıya yönlendirme yapılır. */
function annotateCredentialFailure(failure, source) {
  if (!(failure instanceof AiError) || !source) return failure;
  if (![AI_ERROR_CODES.AI_KEY_INVALID, AI_ERROR_CODES.AI_UNAUTHORIZED, AI_ERROR_CODES.AI_RATE_LIMITED].includes(failure.code)) {
    return failure;
  }
  failure.details = { ...failure.details, credentialSource: source };
  if (source === AI_CREDENTIAL_SOURCES.DEFAULT && DEFAULT_KEY_MESSAGES[failure.code]) {
    failure.message = DEFAULT_KEY_MESSAGES[failure.code];
  }
  return failure;
}

/** Kimlik bilgisi çözülemeden düşen istek (anahtar yok, okunamıyor) kaynağını hatadan alır. */
function failureSource(failure) {
  const source = failure?.details?.credentialSource;
  return KNOWN_SOURCES.has(source) ? source : null;
}

function isServiceFailure(error) {
  return error instanceof AiError ? error.serviceFailure : Number(error?.status) >= 500;
}

/**
 * Sağlayıcı sonucunun PAYLAŞILAN sağlığı anlatıp anlatmadığı.
 *
 * Kurumsal anahtarın reddi (401/403) herkesi etkiler: sağlık hatasıdır.
 * Kişisel anahtarın oran sınırı yalnızca o anahtarı anlatır: sağlık hatası
 * değildir. Öteki sonuçlar telemetrinin varsayılan sınıflandırmasına kalır.
 */
function healthFailureFor(source) {
  return (failure) => {
    const code = failure?.code;
    if (source === AI_CREDENTIAL_SOURCES.DEFAULT
      && (code === AI_ERROR_CODES.AI_KEY_INVALID || code === AI_ERROR_CODES.AI_UNAUTHORIZED)) return true;
    if (source === AI_CREDENTIAL_SOURCES.PERSONAL && code === AI_ERROR_CODES.AI_RATE_LIMITED) return false;
    return null;
  };
}

function modelsEndpointUnauthenticated() {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    message: 'Yapay zekâ ucu model listesini anahtarsız da verdiği için anahtar bu yolla doğrulanamıyor. Anahtarı deneme isteğiyle sınayın.',
    details: { reason: 'MODELS_ENDPOINT_UNAUTHENTICATED' }
  });
}

export function createAiGateway({
  getProvider,
  getAdmission,
  loadConfig = readAiConfig,
  loadRegistry = (config) => loadAiModelRegistry({ path: config.registryPath }),
  resolveCredential = resolveAiCredential,
  readPersonalCredential = readPersonalCredentialForValidation,
  storeValidation = storeCredentialValidation,
  currentSicil = getTrustedCurrentSicil,
  verifySicil = assertAiDirectoryMember,
  now = Date.now,
  random = Math.random
}) {
  /** Güvenilir Sicil; kurumsal rehberde yoksa hiçbir yapılandırma kararına varılmadan UNAUTHORIZED. */
  async function trustedSicil(signal) {
    const sicil = await currentSicil();
    try {
      await verifySicil(sicil, { signal });
    } catch (error) {
      // Rehber sorgusu sürerken bağlantıyı kesen istemci iç hata değil, iptaldir.
      if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
      throw error;
    }
    return sicil;
  }

  /**
   * Sağlayıcı çağrısı; yalnızca isteğin sağlayıcıya HİÇ ulaşmadığı bağlantı
   * hatalarında, kalan süre yetiyorsa ve titreşimli beklemeden sonra bir kez
   * yinelenir. Anahtar, yetki, oran sınırı, zaman aşımı ve iptal yinelenmez.
   * Yineleme, ikinci deneme GERÇEKTEN başlarken kaydedilir.
   */
  async function callProvider({ operation, deadline, invoke, context = null, healthFailure = () => null }) {
    for (let attempt = 1; ; attempt += 1) {
      if (context) context.attempts = attempt;
      const startedAt = now();
      try {
        const result = await raceWithAbort(() => invoke(deadline.signal), deadline.signal);
        recordProviderCall({ operation, latencyMs: now() - startedAt });
        return result;
      } catch (error) {
        const failure = deadline.failure() || toAiFailure(error);
        recordProviderCall({ operation, latencyMs: now() - startedAt, code: failure.code, healthFailure: healthFailure(failure) });
        const delayMs = RETRY_BASE_DELAY_MS + Math.floor(random() * RETRY_JITTER_MS);
        const retry = attempt < MAX_PROVIDER_ATTEMPTS && isConnectFailure(failure)
          && deadline.remainingMs() >= delayMs + MIN_ATTEMPT_BUDGET_MS;
        if (!retry) throw failure;
        await abortableDelay(delayMs, deadline.signal);
        recordAiRetry({ networkCode: failure.details?.networkCode ?? null });
      }
    }
  }

  /**
   * Bir sohbet profiliyle tek yanıt üretir.
   *
   * İş kodu modeli değil profili verir. `signal` istemcinin bağlantısıdır:
   * kesildiğinde sıradaki istek sıradan çıkar, süren sağlayıcı çağrısı iptal
   * edilir ve kapasite hemen bırakılır. Süre dolduktan ya da iptal edildikten
   * sonra gelen yanıt UYGULANMAZ. `requireText`, metin beklenen çağrıda boş
   * yanıtı sağlayıcı hatası sayar (sağlık izine de öyle yazılır).
   */
  async function completeChat({ profile, messages, maxOutputTokens = null, signal = null, requireText = false }) {
    const startedAt = now();
    const context = { profile, model: null, source: null, queueWaitMs: null, attempts: 0 };
    let lease = null;
    let deadline = null;
    try {
      assertOutsideSqlTransaction();
      // Kimliği doğrulanmamış ya da rehberde olmayan çağıran yapılandırma durumunu öğrenemez.
      const sicil = await trustedSicil(signal);
      const config = requireAiAvailable(loadConfig());
      const safeMessages = requireMessages(messages);
      const route = requireRoute(await loadRegistry(config), profile, AI_CAPABILITIES.CHAT);
      context.model = route.model;
      // Bağlama sığmayan istek kapasite kirası alınmadan reddedilir.
      const outputLimit = outputTokenLimit(maxOutputTokens, route, estimatePromptTokens(safeMessages));
      lease = await getAdmission(config).acquire({
        userKey: sicil,
        modelKey: route.model,
        modelLimit: route.maxConcurrency,
        signal,
        timeoutMs: config.queueTimeoutMs
      });
      context.queueWaitMs = lease.queueWaitMs;
      deadline = createAiDeadline({ timeoutMs: route.timeoutMs ?? config.requestTimeoutMs, parentSignal: signal, now });
      const credential = await raceWithAbort(
        () => resolveCredential({ sicil, config, signal: deadline.signal }),
        deadline.signal
      );
      context.source = credential.source;
      const result = await callProvider({
        operation: 'ai.provider.chat',
        deadline,
        context,
        healthFailure: healthFailureFor(credential.source),
        invoke: async (attemptSignal) => {
          const completion = await getProvider().chatCompletion({
            baseUrl: config.baseUrl,
            apiKey: credential.apiKey,
            model: route.model,
            messages: safeMessages,
            maxOutputTokens: outputLimit,
            signal: attemptSignal
          });
          if (requireText && !String(completion.text ?? '').trim()) {
            throw new AiError(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, { details: { reason: 'EMPTY_COMPLETION' } });
          }
          return completion;
        }
      });
      if (deadline.failure()) throw deadline.failure();
      const durationMs = now() - startedAt;
      recordAiRequest({ ...context, durationMs });
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        profile: route.profile,
        // Yanıtı GERÇEKTEN üreten model: ağ geçidi sessizce başka modele
        // yönlendirdiyse yapılandırılan modelden ayrı görünür.
        model: result.model || route.model,
        configuredModel: route.model,
        credentialSource: credential.source,
        durationMs,
        queueWaitMs: context.queueWaitMs
      };
    } catch (error) {
      const failure = annotateCredentialFailure(deadline?.failure() || toAiFailure(error), context.source);
      context.source ??= failureSource(failure);
      if (failure.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT && context.queueWaitMs == null) {
        context.queueWaitMs = failure.details?.queueWaitMs ?? null;
      }
      recordAiRequest({
        ...context,
        code: failure.code,
        serviceFailure: isServiceFailure(failure),
        details: failure.details,
        durationMs: now() - startedAt
      });
      throw failure;
    } finally {
      deadline?.dispose();
      lease?.release();
    }
  }

  /**
   * Kişisel anahtarı üretim yapmayan hafif bir çağrıyla sınar.
   *
   * Yalnızca KİŞİSEL anahtar denenir; kurumsal anahtara hiç dokunulmaz.
   * Erişilemeyen sağlayıcı ya da süre aşımı anahtar hakkında sonuç üretmez ve
   * kayda yazılmaz. `VALID` ancak uç anahtarı GERÇEKTEN denetliyorsa verilir:
   * aynı liste anahtarsız da dönüyorsa sonuç yapılandırma hatasıdır. Sonucun
   * yazımı da aynı süre sınırı ve iptal kapsamındadır.
   */
  async function validatePersonalCredential({ signal = null } = {}) {
    const startedAt = now();
    let lease = null;
    let deadline = null;
    try {
      assertOutsideSqlTransaction();
      const sicil = await trustedSicil(signal);
      const config = requireAiAvailable(loadConfig());
      if (!config.personalKeysSupported) {
        throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'PERSONAL_KEYS_UNSUPPORTED' } });
      }
      // Sağlayıcı düzeyindeki iş model sayacına girmez (kayıttaki hiçbir model kimliğiyle çakışmaz).
      lease = await getAdmission(config).acquire({ userKey: sicil, modelKey: null, signal, timeoutMs: config.queueTimeoutMs });
      deadline = createAiDeadline({
        timeoutMs: Math.min(VALIDATION_TIMEOUT_MS, config.requestTimeoutMs),
        parentSignal: signal,
        now
      });
      const personal = await raceWithAbort(
        () => readPersonalCredential({ sicil, config, signal: deadline.signal }),
        deadline.signal
      );
      const listModels = (apiKey) => async (attemptSignal) => {
        const { status, retryAfter = null } = await getProvider().listModels({ baseUrl: config.baseUrl, apiKey, signal: attemptSignal });
        if (status >= 200 && status < 300) return AI_CREDENTIAL_VALIDATION.VALID;
        if (status === 401) return AI_CREDENTIAL_VALIDATION.REJECTED;
        if (status === 403) return AI_CREDENTIAL_VALIDATION.FORBIDDEN;
        throw classifyProviderStatus(status, retryAfter);
      };
      const probe = (apiKey) => callProvider({
        operation: 'ai.provider.models',
        deadline,
        healthFailure: healthFailureFor(AI_CREDENTIAL_SOURCES.PERSONAL),
        invoke: listModels(apiKey)
      });
      const outcome = await probe(personal.apiKey);
      if (outcome === AI_CREDENTIAL_VALIDATION.VALID && await probe(null) === AI_CREDENTIAL_VALIDATION.VALID) {
        throw modelsEndpointUnauthenticated();
      }
      if (deadline.failure()) throw deadline.failure();
      const stored = await raceWithAbort(
        () => storeValidation({ sicil, rowVersion: personal.rowVersion, status: outcome, signal: deadline.signal }),
        deadline.signal
      );
      if (deadline.failure()) throw deadline.failure();
      recordAiValidation({ durationMs: now() - startedAt });
      // Anahtar doğrulama sürerken değiştirildiyse sonuç yeni anahtara ait değildir.
      return stored.recorded
        ? { status: outcome, stale: false, credential: stored.credential }
        : { status: null, stale: true, credential: stored.credential };
    } catch (error) {
      const failure = annotateCredentialFailure(deadline?.failure() || toAiFailure(error), AI_CREDENTIAL_SOURCES.PERSONAL);
      recordAiValidation({ code: failure.code, serviceFailure: isServiceFailure(failure), durationMs: now() - startedAt });
      throw failure;
    } finally {
      deadline?.dispose();
      lease?.release();
    }
  }

  return { completeChat, validatePersonalCredential };
}
