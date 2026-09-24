import 'server-only';
import { AI_CREDENTIAL_SOURCES, AI_CREDENTIAL_VALIDATION } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AI_CAPABILITIES, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import { isWithinSqlTransaction } from '../db/pool.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { readAiConfig } from './aiConfig.js';
import {
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
 * Sıra şudur: güvenilir Sicil → yapılandırma → profil çözümü → kapasite kirası
 * → kimlik bilgisi (kira ALTINDA ve süre sınırıyla) → sağlayıcı. Kira ve süre
 * sınırı her yolda bırakılır. Ağ geçidi açık bir SQL işlemi içinde çalışmayı
 * reddeder; sağlayıcı yanıtı beklenirken hiçbir SQL bağlantısı ya da işlemi
 * tutulmaz. Olağan Rota uçları bu yola hiç girmez.
 */

const MAX_PROVIDER_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_JITTER_MS = 400;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const VALIDATION_TIMEOUT_MS = 15000;
const VALIDATION_CAPACITY_KEY = 'provider:models';
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32000;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);

const DEFAULT_KEY_MESSAGES = Object.freeze({
  [AI_ERROR_CODES.AI_KEY_INVALID]: 'Kurumsal yapay zekâ anahtarı reddedildi. Sistem yöneticinize başvurun.',
  [AI_ERROR_CODES.AI_UNAUTHORIZED]: 'Kurumsal yapay zekâ anahtarının bu yeteneğe erişim yetkisi yok. Sistem yöneticinize başvurun.'
});

function requireAvailable(config) {
  if (!config.enabled) throw new AiError(AI_ERROR_CODES.AI_DISABLED);
  if (!config.available) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'CONFIGURATION_INVALID' } });
  }
  return config;
}

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

function outputTokenLimit(requested, profileLimit) {
  const asked = Number.isSafeInteger(requested) && requested > 0 ? requested : null;
  if (asked == null) return profileLimit ?? null;
  return profileLimit == null ? asked : Math.min(asked, profileLimit);
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

function isServiceFailure(error) {
  return error instanceof AiError ? error.serviceFailure : Number(error?.status) >= 500;
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
  now = Date.now,
  random = Math.random
}) {
  /**
   * Sağlayıcı çağrısı; yalnızca isteğin sağlayıcıya HİÇ ulaşmadığı bağlantı
   * hatalarında, kalan süre yetiyorsa ve titreşimli beklemeden sonra bir kez
   * yinelenir. Anahtar, yetki, oran sınırı, zaman aşımı ve iptal yinelenmez.
   */
  async function callProvider(context, deadline, invoke) {
    for (let attempt = 1; ; attempt += 1) {
      context.attempts = attempt;
      const startedAt = now();
      try {
        const result = await raceWithAbort(() => invoke(deadline.signal), deadline.signal);
        recordProviderCall({ operation: 'ai.provider.chat', latencyMs: now() - startedAt });
        return result;
      } catch (error) {
        const failure = deadline.failure() || toAiFailure(error);
        recordProviderCall({ operation: 'ai.provider.chat', latencyMs: now() - startedAt, code: failure.code });
        const delayMs = RETRY_BASE_DELAY_MS + Math.floor(random() * RETRY_JITTER_MS);
        const retry = attempt < MAX_PROVIDER_ATTEMPTS && isConnectFailure(failure)
          && deadline.remainingMs() >= delayMs + MIN_ATTEMPT_BUDGET_MS;
        if (!retry) throw failure;
        recordAiRetry({ networkCode: failure.details?.networkCode ?? null });
        await abortableDelay(delayMs, deadline.signal);
      }
    }
  }

  /**
   * Bir sohbet profiliyle tek yanıt üretir.
   *
   * İş kodu modeli değil profili verir. `signal` istemcinin bağlantısıdır:
   * kesildiğinde sıradaki istek sıradan çıkar, süren sağlayıcı çağrısı iptal
   * edilir ve kapasite hemen bırakılır. Süre dolduktan ya da iptal edildikten
   * sonra gelen yanıt UYGULANMAZ.
   */
  async function completeChat({ profile, messages, maxOutputTokens = null, signal = null }) {
    const startedAt = now();
    const context = { profile, model: null, source: null, queueWaitMs: null, attempts: 0 };
    let lease = null;
    let deadline = null;
    try {
      assertOutsideSqlTransaction();
      // Kimliği doğrulanmamış çağıran yapılandırma durumunu öğrenemez.
      const sicil = await currentSicil();
      const config = requireAvailable(loadConfig());
      const safeMessages = requireMessages(messages);
      const route = requireRoute(await loadRegistry(config), profile, AI_CAPABILITIES.CHAT);
      context.model = route.model;
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
      const result = await callProvider(context, deadline, (attemptSignal) => getProvider().chatCompletion({
        baseUrl: config.baseUrl,
        apiKey: credential.apiKey,
        model: route.model,
        messages: safeMessages,
        maxOutputTokens: outputTokenLimit(maxOutputTokens, route.maxOutputTokens),
        signal: attemptSignal
      }));
      if (deadline.failure()) throw deadline.failure();
      const durationMs = now() - startedAt;
      recordAiRequest({ ...context, durationMs });
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        profile: route.profile,
        model: route.model,
        credentialSource: credential.source,
        durationMs,
        queueWaitMs: context.queueWaitMs
      };
    } catch (error) {
      const failure = annotateCredentialFailure(deadline?.failure() || toAiFailure(error), context.source);
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

  function validationOutcome(status) {
    if (status >= 200 && status < 300) return AI_CREDENTIAL_VALIDATION.VALID;
    if (status === 401) return AI_CREDENTIAL_VALIDATION.REJECTED;
    if (status === 403) return AI_CREDENTIAL_VALIDATION.FORBIDDEN;
    throw classifyProviderStatus(status);
  }

  /**
   * Kişisel anahtarı üretim yapmayan hafif bir çağrıyla sınar.
   *
   * Yalnızca KİŞİSEL anahtar denenir; kurumsal anahtara hiç dokunulmaz.
   * Erişilemeyen sağlayıcı ya da süre aşımı anahtar hakkında sonuç üretmez ve
   * kayda yazılmaz.
   */
  async function validatePersonalCredential({ signal = null } = {}) {
    const startedAt = now();
    let lease = null;
    let deadline = null;
    try {
      assertOutsideSqlTransaction();
      const sicil = await currentSicil();
      const config = requireAvailable(loadConfig());
      if (!config.personalKeysSupported) {
        throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'PERSONAL_KEYS_UNSUPPORTED' } });
      }
      lease = await getAdmission(config).acquire({
        userKey: sicil,
        modelKey: VALIDATION_CAPACITY_KEY,
        signal,
        timeoutMs: config.queueTimeoutMs
      });
      deadline = createAiDeadline({
        timeoutMs: Math.min(VALIDATION_TIMEOUT_MS, config.requestTimeoutMs),
        parentSignal: signal,
        now
      });
      const personal = await raceWithAbort(
        () => readPersonalCredential({ sicil, config, signal: deadline.signal }),
        deadline.signal
      );
      const providerStartedAt = now();
      let status;
      try {
        ({ status } = await raceWithAbort(
          () => getProvider().listModels({ baseUrl: config.baseUrl, apiKey: personal.apiKey, signal: deadline.signal }),
          deadline.signal
        ));
      } catch (error) {
        const failure = deadline.failure() || toAiFailure(error);
        recordProviderCall({ operation: 'ai.provider.models', latencyMs: now() - providerStartedAt, code: failure.code });
        throw failure;
      }
      let outcome = null;
      let inconclusive = null;
      try {
        outcome = validationOutcome(status);
      } catch (classified) {
        inconclusive = classified;
      }
      recordProviderCall({ operation: 'ai.provider.models', latencyMs: now() - providerStartedAt, code: inconclusive?.code ?? null });
      if (inconclusive) throw inconclusive;
      if (deadline.failure()) throw deadline.failure();
      const credential = await storeValidation({ sicil, rowVersion: personal.rowVersion, status: outcome });
      recordAiValidation({ durationMs: now() - startedAt });
      return { status: outcome, credential };
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
