import 'server-only';
import { AI_CREDENTIAL_SOURCES, AI_CREDENTIAL_VALIDATION } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AI_CAPABILITIES, AI_MAX_OUTPUT_TOKENS, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import { isWithinSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { readAiConfig, requireAiAvailable } from './aiConfig.js';
import {
  assertAiDirectoryMember,
  readPersonalCredentialForValidation,
  resolveAiCredential,
  storeCredentialValidation
} from './aiCredentialService.js';
import {
  AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS,
  AI_VALIDATION_TIMEOUT_MS,
  abortableDelay,
  createAiDeadline,
  raceWithAbort
} from './aiDeadline.js';
import { AiError, isAiError, toAiFailure } from './aiErrors.js';
import { recordAiRequest, recordAiRetry, recordAiStream, recordAiValidation, recordProviderCall } from './aiTelemetry.js';
import { loadAiModelRegistry } from './modelRegistryLoader.js';
import { classifyProviderStatus, createControlApiKey, isConnectFailure, streamInterrupted } from './providers/openAiCompatibleProvider.js';

/**
 * Yapay zekâ ağ geçidi — alt sistemin TEK yürütme yolu.
 *
 * Sıra şudur: güvenilir Sicil → kurumsal rehber üyeliği (kendi süre sınırıyla
 * ve sınırlı eşzamanlılıkla) → yapılandırma → profil çözümü → kapasite kirası
 * → kimlik bilgisi (kira ALTINDA ve süre sınırıyla) → sağlayıcı. Kira ve süre
 * sınırı her yolda bırakılır. Ağ geçidi açık bir SQL işlemi içinde çalışmayı
 * reddeder; sağlayıcı yanıtı beklenirken hiçbir SQL bağlantısı ya da işlemi
 * tutulmaz. Olağan Rota uçları bu yola hiç girmez.
 */

const MAX_PROVIDER_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_JITTER_MS = 400;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32000;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
/**
 * Ne çağıranın ne de profilin çıktı sınırı verdiği sohbette kullanılan sınır.
 * İstek her zaman bir `max_tokens` taşır: sağlayıcının kendi (bağlamın
 * tamamına varabilen) varsayılanı genel üst sınırı aşamaz.
 */
const DEFAULT_OUTPUT_TOKENS = 1024;
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

function directoryTimeout() {
  return new ServerPersistenceError(
    'DATABASE_UNAVAILABLE',
    'Kurumsal personel kaynağı süre sınırında yanıt vermedi. Biraz sonra yeniden deneyin.',
    { details: { reason: 'DIRECTORY_PREFLIGHT_TIMEOUT' } }
  );
}

/**
 * Kapasite kirasından önceki iş (ör. dosya kaydının okunması) istemcinin
 * iptalini izler: bağlantısını kesen istemci, alttaki G/Ç iptal edilemese bile
 * hemen `AI_CANCELLED` alır.
 */
async function untilCancelled(work, signal) {
  if (!signal) return work();
  try {
    return await raceWithAbort(work, signal);
  } catch (error) {
    if (signal.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
    throw error;
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

/**
 * İstenen çıktı sınırı. Sağlayıcının belirteçleyicisi bilinmediği için istem
 * uzunluğu TAHMİN edilmez ve bu tahminle kabul/ret ya da bağlam ayırma kararı
 * verilmez: bağlama sığmayan istemi sağlayıcı kendi belirteçleyicisiyle
 * reddeder. Sınır yalnızca KESİN değerlerle daraltılır: çağıranın değeri, profil
 * sınırı, modelin bağlam penceresi ve genel üst sınır. Çağıran da profil de
 * sınır vermediyse sınırlı bir varsayılan kullanılır; istek hiçbir zaman
 * sınırsız gitmez.
 */
function outputTokenLimit(requested, route) {
  const asked = Number.isSafeInteger(requested) && requested > 0 ? requested : null;
  return Math.min(
    asked ?? route.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
    route.maxOutputTokens ?? Infinity,
    route.contextTokens ?? Infinity,
    AI_MAX_OUTPUT_TOKENS
  );
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

/**
 * Sabit (sunucunun ürettiği) istek sağlayıcıca geçersiz sayıldıysa (400/413/422)
 * bu kullanıcı girdisi değil, model ya da uç yapılandırmasının sorunudur
 * (kaldırılmış model, desteklenmeyen parametre, uyumsuz ağ geçidi).
 */
function fixedRequestRejected(error) {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    message: 'Yapay zekâ hizmeti sunucunun ürettiği sabit isteği reddetti. Model ve uç yapılandırmasını denetleyin.',
    details: { reason: 'PROVIDER_REJECTED_FIXED_REQUEST', providerStatus: error.details?.providerStatus ?? null }
  });
}

/** Sabit `GET /models` isteğinin 2xx/401/403 dışı yanıtı; 400/413/422 yapılandırma hatasıdır. */
function fixedModelsFailure(status, retryAfter) {
  const failure = classifyProviderStatus(status, retryAfter);
  return failure.code === AI_ERROR_CODES.AI_REQUEST_INVALID ? fixedRequestRejected(failure) : failure;
}

function modelsEndpointUnauthenticated() {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    message: 'Yapay zekâ ucu model listesini geçersiz bir anahtarla da verdiği için anahtar bu yolla doğrulanamıyor. Anahtarı deneme isteğiyle sınayın.',
    details: { reason: 'MODELS_ENDPOINT_UNAUTHENTICATED' }
  });
}

/** Akışın sonucu (telemetri): tamamlandı, iptal, süre aşımı, yarıda kesildi ya da başlamadan başarısız. */
function streamOutcome(failure, emitted) {
  if (!failure) return 'completed';
  if (failure.code === AI_ERROR_CODES.AI_CANCELLED) return 'cancelled';
  if (failure.code === AI_ERROR_CODES.AI_TIMEOUT) return 'timeout';
  return emitted ? 'interrupted' : 'failed';
}

/**
 * Sağlayıcı çağrısının sinyali: süre sınırını/iptali izler ve akış hangi yolla
 * biterse bitsin kesilir. Böylece hiç okunmamış ya da yarıda bırakılmış bir
 * yanıt gövdesi bağlantıyı açık tutamaz.
 */
function linkAbort(signal, controller) {
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Bildirim geri çağrısının hatası akışı bozmaz. */
function notify(callback, value) {
  try {
    callback?.(value);
  } catch {
    // Gözlemci hatası üretimi etkilemez.
  }
}

/** Doğrulama sonucu sağlayıcı açısından BAŞARISIZ bir HTTP işlemidir (401/403). */
function validationFailureCode(outcome) {
  if (outcome === AI_CREDENTIAL_VALIDATION.REJECTED) return AI_ERROR_CODES.AI_KEY_INVALID;
  if (outcome === AI_CREDENTIAL_VALIDATION.FORBIDDEN) return AI_ERROR_CODES.AI_UNAUTHORIZED;
  return null;
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
  /**
   * Güvenilir Sicil; kurumsal rehberde yoksa hiçbir yapılandırma kararına
   * varılmadan UNAUTHORIZED. Denetim kira öncesinde yapıldığı için kendi süre
   * sınırıyla çalışır (istemci süreleri bu bütçeyi de kapsar).
   */
  async function trustedSicil(signal) {
    const sicil = await currentSicil();
    const preflight = createAiDeadline({ timeoutMs: AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS, parentSignal: signal, now });
    try {
      await raceWithAbort(() => verifySicil(sicil, { signal: preflight.signal }), preflight.signal);
    } catch (error) {
      const failure = preflight.failure();
      // Rehber sorgusu sürerken bağlantıyı kesen istemci iç hata değil, iptaldir.
      if (failure?.code === AI_ERROR_CODES.AI_CANCELLED) throw failure;
      if (failure) throw directoryTimeout();
      throw error;
    } finally {
      preflight.dispose();
    }
    return sicil;
  }

  /**
   * Sağlayıcı çağrısı; yalnızca isteğin sağlayıcıya HİÇ ulaşmadığı bağlantı
   * hatalarında, kalan süre yetiyorsa ve titreşimli beklemeden sonra bir kez
   * yinelenir. Anahtar, yetki, oran sınırı, zaman aşımı ve iptal yinelenmez.
   * Yineleme, ikinci deneme GERÇEKTEN başlarken kaydedilir.
   *
   * `failureCodeOf(result)`, sonucu anlamlı olsa da sağlayıcı açısından
   * başarısız olan bir HTTP işlemini (ör. doğrulamada 401) bildirir: işlem
   * ölçümü o kodla başarısız kaydedilir, sonuç yine çağırana döner.
   */
  async function callProvider({
    operation, deadline, invoke, source = null, context = null, healthFailure = () => null, failureCodeOf = () => null
  }) {
    for (let attempt = 1; ; attempt += 1) {
      if (context) context.attempts = attempt;
      const startedAt = now();
      try {
        const result = await raceWithAbort(() => invoke(deadline.signal), deadline.signal);
        const code = failureCodeOf(result);
        recordProviderCall({
          operation,
          latencyMs: now() - startedAt,
          source,
          ...(code ? { code, healthFailure: healthFailure({ code }) } : {})
        });
        return result;
      } catch (error) {
        const failure = deadline.failure() || toAiFailure(error);
        recordProviderCall({ operation, latencyMs: now() - startedAt, code: failure.code, healthFailure: healthFailure(failure), source });
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
   * `callerInput: false`, iletilerin sunucunun ürettiği sabit bir istek
   * olduğunu söyler: sağlayıcının 400/413/422 yanıtı kullanıcı hatası değil,
   * yapılandırma hatasıdır.
   */
  async function completeChat({ profile, messages, maxOutputTokens = null, signal = null, requireText = false, callerInput = true }) {
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
      const route = requireRoute(await untilCancelled(() => loadRegistry(config), signal), profile, AI_CAPABILITIES.CHAT);
      context.model = route.model;
      const outputLimit = outputTokenLimit(maxOutputTokens, route);
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
        source: credential.source,
        healthFailure: healthFailureFor(credential.source),
        invoke: async (attemptSignal) => {
          let completion;
          try {
            completion = await getProvider().chatCompletion({
              baseUrl: config.baseUrl,
              apiKey: credential.apiKey,
              model: route.model,
              messages: safeMessages,
              maxOutputTokens: outputLimit,
              signal: attemptSignal
            });
          } catch (error) {
            if (!callerInput && isAiError(error) && error.code === AI_ERROR_CODES.AI_REQUEST_INVALID) throw fixedRequestRejected(error);
            throw error;
          }
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
        // Yanıtı GERÇEKTEN üreten model, yalnızca sağlayıcının bildirdiğidir:
        // bildirmediyse `null` kalır ve yapılandırılan model onun yerine
        // yazılmaz. Ağ geçidi sessizce başka modele yönlendirdiyse ikisi ayrışır.
        model: result.model ?? null,
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
   * Akışlı sağlayıcı bağlantısı. Yalnızca BAĞLANTI evresi yinelenebilir ve kural
   * `callProvider` ile aynıdır: isteğin sağlayıcıya hiç ulaşmadığı bağlantı
   * hataları, bir kez, kalan süre yetiyorsa. Bu evrede kullanıcıya henüz metin
   * gitmemiştir; yanıt başladıktan sonraki hiçbir hata yinelenmez (aynı yanıt
   * baştan ikinci kez üretilmez).
   */
  async function connectStream({ deadline, context, source, healthFailure, invoke }) {
    for (let attempt = 1; ; attempt += 1) {
      context.attempts = attempt;
      const startedAt = now();
      try {
        return { opened: await raceWithAbort(invoke, deadline.signal), startedAt };
      } catch (error) {
        const failure = deadline.failure() || toAiFailure(error);
        recordProviderCall({ operation: 'ai.provider.stream', latencyMs: now() - startedAt, code: failure.code, healthFailure: healthFailure(failure), source });
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
   * Bir sohbet profiliyle yanıtı AKIŞ olarak üretir.
   *
   * `completeChat` ile aynı sıra ve güvenceler geçerlidir: güvenilir Sicil →
   * rehber üyeliği → yapılandırma → profil → kapasite kirası → süre sınırı →
   * kimlik bilgisi → sağlayıcı. Kapasite kirası akış BOYUNCA tutulur ve akış
   * tamamlandığında, hata verdiğinde, süresi dolduğunda ya da iptal edildiğinde
   * tam bir kez bırakılır. Görünür her metin parçası `onText` ile iletilir;
   * çağıranın geri basıncı (`onText` sözü) süre sınırına bağlıdır. `onStatus`
   * yalnızca gerçek evre geçişlerini bildirir (`generating`, `thinking`).
   *
   * Yanıt başladıktan sonra oluşan hata `details.partial: true` taşır; bu
   * yanıt otomatik olarak yeniden istenmez. Sonuç tam metni döndürür; süre
   * dolduktan ya da iptal edildikten sonra gelen parça uygulanmaz.
   */
  async function streamChat({ profile, messages, maxOutputTokens = null, signal = null, onStatus = null, onText }) {
    const startedAt = now();
    const context = { profile, model: null, source: null, queueWaitMs: null, attempts: 0 };
    const progress = { emitted: false, reasoning: false, firstTokenMs: null, providerStartMs: null, providerStartedAt: null, recorded: false };
    const providerScope = new AbortController();
    let lease = null;
    let deadline = null;
    let unlink = null;
    try {
      assertOutsideSqlTransaction();
      const sicil = await trustedSicil(signal);
      const config = requireAiAvailable(loadConfig());
      const safeMessages = requireMessages(messages);
      const route = requireRoute(await untilCancelled(() => loadRegistry(config), signal), profile, AI_CAPABILITIES.CHAT);
      context.model = route.model;
      const outputLimit = outputTokenLimit(maxOutputTokens, route);
      lease = await getAdmission(config).acquire({
        userKey: sicil,
        modelKey: route.model,
        modelLimit: route.maxConcurrency,
        signal,
        timeoutMs: config.queueTimeoutMs
      });
      context.queueWaitMs = lease.queueWaitMs;
      deadline = createAiDeadline({ timeoutMs: route.timeoutMs ?? config.requestTimeoutMs, parentSignal: signal, now });
      unlink = linkAbort(deadline.signal, providerScope);
      const credential = await raceWithAbort(
        () => resolveCredential({ sicil, config, signal: deadline.signal }),
        deadline.signal
      );
      context.source = credential.source;
      const { opened, startedAt: providerStartedAt } = await connectStream({
        deadline,
        context,
        source: credential.source,
        healthFailure: healthFailureFor(credential.source),
        invoke: () => getProvider().streamChatCompletion({
          baseUrl: config.baseUrl,
          apiKey: credential.apiKey,
          model: route.model,
          messages: safeMessages,
          maxOutputTokens: outputLimit,
          signal: providerScope.signal
        })
      });
      progress.providerStartedAt = providerStartedAt;
      progress.providerStartMs = now() - providerStartedAt;
      notify(onStatus, { phase: 'generating' });
      const chunks = [];
      let final = null;
      const iterator = opened.events[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await raceWithAbort(() => iterator.next(), deadline.signal);
          if (step.done) break;
          const event = step.value;
          if (event.type === 'text') {
            if (!progress.emitted) {
              progress.emitted = true;
              progress.firstTokenMs = now() - startedAt;
            }
            chunks.push(event.text);
            await raceWithAbort(() => onText(event.text), deadline.signal);
          } else if (event.type === 'reasoning' && !progress.reasoning) {
            progress.reasoning = true;
            notify(onStatus, { phase: 'thinking' });
          } else if (event.type === 'done') {
            final = event;
          }
        }
      } finally {
        // Beklenmez: sinyale uymayan bir sağlayıcı kapasiteyi ve çağıranı tutamaz.
        iterator.return?.()?.catch?.(() => {});
      }
      if (deadline.failure()) throw deadline.failure();
      if (!final) throw streamInterrupted('STREAM_TRUNCATED');
      const text = chunks.join('').trim();
      if (!text) {
        throw new AiError(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, {
          details: { reason: 'EMPTY_COMPLETION', finishReason: final.finishReason ?? null }
        });
      }
      const generationMs = now() - providerStartedAt;
      recordProviderCall({ operation: 'ai.provider.stream', latencyMs: generationMs, source: credential.source });
      progress.recorded = true;
      const durationMs = now() - startedAt;
      recordAiRequest({ ...context, durationMs });
      recordAiStream({
        outcome: streamOutcome(null, true),
        firstTokenMs: progress.firstTokenMs,
        providerStartMs: progress.providerStartMs,
        generationMs
      });
      return {
        text,
        finishReason: final.finishReason ?? null,
        usage: final.usage ?? null,
        profile: route.profile,
        // Yanıtı GERÇEKTEN üreten model yalnızca sağlayıcının bildirdiğidir.
        model: final.model ?? null,
        configuredModel: route.model,
        credentialSource: credential.source,
        durationMs,
        queueWaitMs: context.queueWaitMs,
        firstTokenMs: progress.firstTokenMs
      };
    } catch (error) {
      const failure = annotateCredentialFailure(deadline?.failure() || toAiFailure(error), context.source);
      context.source ??= failureSource(failure);
      if (failure.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT && context.queueWaitMs == null) {
        context.queueWaitMs = failure.details?.queueWaitMs ?? null;
      }
      if (progress.providerStartedAt != null && !progress.recorded) {
        recordProviderCall({
          operation: 'ai.provider.stream',
          latencyMs: now() - progress.providerStartedAt,
          code: failure.code,
          healthFailure: healthFailureFor(context.source)(failure),
          source: context.source
        });
      }
      recordAiRequest({
        ...context,
        code: failure.code,
        serviceFailure: isServiceFailure(failure),
        details: failure.details,
        durationMs: now() - startedAt
      });
      recordAiStream({
        outcome: streamOutcome(failure, progress.emitted),
        firstTokenMs: progress.firstTokenMs,
        providerStartMs: progress.providerStartMs
      });
      if (progress.emitted && isAiError(failure)) failure.details = { ...failure.details, partial: true };
      throw failure;
    } finally {
      unlink?.();
      providerScope.abort();
      deadline?.dispose();
      lease?.release();
    }
  }

  /**
   * Kişisel anahtarı üretim yapmayan hafif bir çağrıyla sınar.
   *
   * Yalnızca KİŞİSEL anahtar denenir; kurumsal anahtara hiç dokunulmaz.
   * Erişilemeyen sağlayıcı ya da süre aşımı anahtar hakkında sonuç üretmez ve
   * kayda yazılmaz. `VALID` ancak uç GÖNDERİLEN anahtarı gerçekten denetliyorsa
   * verilir: aynı istek rastgele bir denetim anahtarıyla yinelenir. Yalnızca
   * kimlik doğrulamaya özgü ret (401/403) denetimi kanıtlar; denetim anahtarıyla
   * da geçerli liste dönüyorsa sonuç yapılandırma hatasıdır; geri kalan her
   * yanıt (408, 429, 5xx, geçersiz gövde…) sonucu belirsiz bırakır ve kayda
   * yazılmaz. Sabit isteğin 400/413/422 ile reddi yapılandırma hatasıdır.
   * Sonucun yazımı da aynı süre sınırı ve iptal kapsamındadır. Kapasite reddi ve
   * sıra beklemesi sohbetteki gibi ölçülür; sağlayıcının reddettiği her HTTP
   * işlemi (401/403 dâhil) başarısız işlem olarak ölçülür.
   */
  async function validatePersonalCredential({ signal = null } = {}) {
    const startedAt = now();
    const personalSource = AI_CREDENTIAL_SOURCES.PERSONAL;
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
        timeoutMs: Math.min(AI_VALIDATION_TIMEOUT_MS, config.requestTimeoutMs),
        parentSignal: signal,
        now
      });
      const personal = await raceWithAbort(
        () => readPersonalCredential({ sicil, config, signal: deadline.signal }),
        deadline.signal
      );
      const baseUrl = config.baseUrl;
      const outcome = await callProvider({
        operation: 'ai.provider.models',
        deadline,
        source: personalSource,
        healthFailure: healthFailureFor(personalSource),
        failureCodeOf: validationFailureCode,
        invoke: async (attemptSignal) => {
          const { status, retryAfter = null } = await getProvider().listModels({ baseUrl, apiKey: personal.apiKey, signal: attemptSignal });
          if (status >= 200 && status < 300) return AI_CREDENTIAL_VALIDATION.VALID;
          if (status === 401) return AI_CREDENTIAL_VALIDATION.REJECTED;
          if (status === 403) return AI_CREDENTIAL_VALIDATION.FORBIDDEN;
          throw fixedModelsFailure(status, retryAfter);
        }
      });
      if (outcome === AI_CREDENTIAL_VALIDATION.VALID) {
        const control = await callProvider({
          operation: 'ai.provider.models',
          deadline,
          healthFailure: healthFailureFor(personalSource),
          // Denetim anahtarının reddi beklenen sonuçtur ama HTTP işlemi başarısızdır.
          failureCodeOf: (result) => (result.enforced ? classifyProviderStatus(result.status).code : null),
          invoke: async (attemptSignal) => {
            const { status, retryAfter = null } = await getProvider().listModels({
              baseUrl,
              apiKey: createControlApiKey(),
              signal: attemptSignal
            });
            if (status === 401 || status === 403) return { enforced: true, status };
            if (status >= 200 && status < 300) return { enforced: false, status };
            throw fixedModelsFailure(status, retryAfter);
          }
        });
        if (!control.enforced) throw modelsEndpointUnauthenticated();
      }
      if (deadline.failure()) throw deadline.failure();
      const stored = await raceWithAbort(
        () => storeValidation({ sicil, keyNonce: personal.keyNonce, status: outcome, signal: deadline.signal }),
        deadline.signal
      );
      if (deadline.failure()) throw deadline.failure();
      recordAiValidation({ durationMs: now() - startedAt, queueWaitMs: lease.queueWaitMs });
      // Anahtar doğrulama sürerken değiştirildiyse sonuç yeni anahtara ait değildir.
      return stored.recorded
        ? { status: outcome, stale: false, credential: stored.credential }
        : { status: null, stale: true, credential: stored.credential };
    } catch (error) {
      const failure = annotateCredentialFailure(deadline?.failure() || toAiFailure(error), personalSource);
      const queueWaitMs = lease?.queueWaitMs
        ?? (failure.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT ? failure.details?.queueWaitMs ?? null : null);
      recordAiValidation({
        code: failure.code,
        serviceFailure: isServiceFailure(failure),
        details: failure.details,
        queueWaitMs,
        durationMs: now() - startedAt
      });
      throw failure;
    } finally {
      deadline?.dispose();
      lease?.release();
    }
  }

  return { completeChat, streamChat, validatePersonalCredential };
}
