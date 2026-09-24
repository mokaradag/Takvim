import 'server-only';
import { AI_CREDENTIAL_SOURCES } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES, aiErrorDefinition, isAiErrorCode } from '../../domain/ai/aiErrorCatalog.js';
import { isKnownAiProfile } from '../../domain/ai/aiModelRegistry.js';
import { COMPONENTS, EVENT_SEVERITIES } from '../../domain/observability/eventModel.js';
import { GAUGE_KEYS, summarizeDurations } from '../../domain/observability/metrics.js';
import { logEvent } from '../observability/structuredLogger.js';
import { recordGauge, recordOperation } from '../observability/telemetryRegistry.js';

/**
 * Yapay zekâ telemetrisi (var olan kaydedici ve günlük üzerinden).
 *
 * İstem, yanıt metni, anahtar ve Sicil HİÇBİR kayda girmez. İşlem adları
 * `api.` ile başlamaz: yavaş model yanıtları API P95 uyarılarını kirletmez.
 * Her kayıt kendi hatasını yutar; bellekteki özet sınırlıdır.
 */

const STATE_KEY = Symbol.for('mergen-rota.ai-telemetry');
const LATENCY_SAMPLES = 200;
/** Sağlayıcının sağlığını anlatan sonuçlar; anahtar ya da istek kararları erişim sayılır. */
const PROVIDER_HEALTH_FAILURES = new Set([
  AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
  AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID,
  AI_ERROR_CODES.AI_TIMEOUT,
  AI_ERROR_CODES.AI_RATE_LIMITED
]);
const QUIET_CODES = new Set([
  AI_ERROR_CODES.AI_BUSY,
  AI_ERROR_CODES.AI_QUEUE_TIMEOUT,
  AI_ERROR_CODES.AI_CANCELLED
]);

function createState() {
  return {
    startedAt: new Date().toISOString(),
    requests: 0,
    succeeded: 0,
    outcomes: {},
    bySource: { [AI_CREDENTIAL_SOURCES.PERSONAL]: 0, [AI_CREDENTIAL_SOURCES.DEFAULT]: 0, [AI_CREDENTIAL_SOURCES.MISSING]: 0 },
    byProfile: {},
    providerLatencyMs: [],
    queueWaitMs: [],
    retries: 0,
    lastSuccessAt: null,
    lastFailure: null,
    lastBusyAt: null,
    provider: { lastContactAt: null, lastFailureAt: null, lastFailureCode: null, lastLatencyMs: null }
  };
}

function state() {
  globalThis[STATE_KEY] ||= createState();
  return globalThis[STATE_KEY];
}

function safely(work) {
  try {
    work();
  } catch {
    // Telemetri hatası yapay zekâ isteğini etkilemez.
  }
}

function pushSample(list, value) {
  if (value == null || !Number.isFinite(value)) return;
  list.push(Math.max(0, Math.round(value)));
  if (list.length > LATENCY_SAMPLES) list.shift();
}

function outcomeOf(code, serviceFailure) {
  if (isAiErrorCode(code)) {
    const definition = aiErrorDefinition(code);
    return { code: definition.code, serviceFailure: definition.serviceFailure };
  }
  return { code: String(code).slice(0, 60), serviceFailure: Boolean(serviceFailure) };
}

function logFailure({ outcome, source, profile, model, durationMs, attempts, details }) {
  if (QUIET_CODES.has(outcome.code)) return;
  // Kullanıcının kendi anahtarı ya da isteği kaynaklı sonuçlar hizmet sorunu değildir.
  if (!outcome.serviceFailure && source !== AI_CREDENTIAL_SOURCES.DEFAULT) return;
  const severe = outcome.code === AI_ERROR_CODES.AI_CONFIGURATION_ERROR || outcome.code === AI_ERROR_CODES.AI_INTERNAL_ERROR;
  logEvent({
    severity: severe ? EVENT_SEVERITIES.ERROR : EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.AI,
    operation: 'ai.request',
    code: outcome.code,
    message: 'Yapay zekâ isteği tamamlanamadı.',
    durationMs,
    // Alan adı bilinçli olarak `credential` içermez: ortak temizleyici o adı
    // maskeler, oysa kaynak (personal/default/missing) gizli bilgi değildir.
    context: {
      profile,
      model,
      keySource: source,
      attempts,
      providerStatus: details?.providerStatus ?? null,
      networkCode: details?.networkCode ?? null,
      reason: details?.reason ?? null
    }
  });
}

/**
 * Uçtan uca istek sonucu (sıra beklemesi dâhil). `code` yoksa istek başarılıdır;
 * `serviceFailure` yalnızca yapay zekâ kataloğu dışındaki sunucu kodları için okunur.
 */
export function recordAiRequest({
  profile, model = null, source = null, code = null, serviceFailure = false, details = null,
  durationMs, queueWaitMs = null, attempts = 1
}) {
  let outcome = null;
  safely(() => {
    outcome = code ? outcomeOf(code, serviceFailure) : null;
    const current = state();
    const now = new Date().toISOString();
    current.requests += 1;
    if (!outcome) {
      current.succeeded += 1;
      current.lastSuccessAt = now;
    } else {
      current.outcomes[outcome.code] = (current.outcomes[outcome.code] || 0) + 1;
      if (outcome.serviceFailure) current.lastFailure = { code: outcome.code, at: now };
      if (outcome.code === AI_ERROR_CODES.AI_BUSY) current.lastBusyAt = now;
    }
    if (Object.hasOwn(current.bySource, source)) current.bySource[source] += 1;
    if (isKnownAiProfile(profile)) current.byProfile[profile] = (current.byProfile[profile] || 0) + 1;
    if (attempts > 1) current.retries += attempts - 1;
    pushSample(current.queueWaitMs, queueWaitMs);
    recordOperation({
      operation: 'ai.request',
      durationMs,
      ok: !outcome?.serviceFailure,
      code: outcome?.serviceFailure ? outcome.code : null
    });
    if (queueWaitMs != null) recordOperation({ operation: 'ai.queue.wait', durationMs: queueWaitMs, ok: true });
  });
  if (outcome) safely(() => logFailure({ outcome, source, profile, model, durationMs, attempts, details }));
}

/** Kişisel anahtarın açık doğrulaması; model üretimi içermez, ayrı ölçülür. */
export function recordAiValidation({ code = null, serviceFailure = false, durationMs }) {
  safely(() => {
    const outcome = code ? outcomeOf(code, serviceFailure) : null;
    recordOperation({
      operation: 'ai.credential.validate',
      durationMs,
      ok: !outcome?.serviceFailure,
      code: outcome?.serviceFailure ? outcome.code : null
    });
  });
}

/**
 * Sağlayıcı çağrısının süresi ve erişilebilirlik izi.
 *
 * HTTP yanıtı alınan her çağrı (401 dâhil) ERİŞİM sayılır; iptal edilen çağrı
 * sağlayıcının başarımını anlatmadığı için kaydedilmez.
 */
export function recordProviderCall({ operation, latencyMs, code = null }) {
  if (code === AI_ERROR_CODES.AI_CANCELLED) return;
  safely(() => {
    const current = state();
    const unhealthy = code != null && PROVIDER_HEALTH_FAILURES.has(code);
    const now = new Date().toISOString();
    recordOperation({ operation, durationMs: latencyMs, ok: !unhealthy, code: unhealthy ? code : null });
    if (unhealthy) {
      current.provider.lastFailureAt = now;
      current.provider.lastFailureCode = code;
    } else {
      current.provider.lastContactAt = now;
      current.provider.lastLatencyMs = Math.max(0, Math.round(latencyMs));
      pushSample(current.providerLatencyMs, latencyMs);
    }
  });
}

export function recordAiRetry({ networkCode = null } = {}) {
  safely(() => {
    logEvent({
      severity: EVENT_SEVERITIES.INFO,
      component: COMPONENTS.AI,
      operation: 'ai.provider.retry',
      code: 'AI_PROVIDER_RETRY',
      message: 'Sağlayıcıya bağlantı kurulamadı; istek bir kez yeniden denendi.',
      context: { networkCode }
    });
  });
}

export function recordAiLoad({ active, queued }) {
  safely(() => {
    recordGauge(GAUGE_KEYS.AI_ACTIVE_REQUESTS, active);
    recordGauge(GAUGE_KEYS.AI_QUEUED_REQUESTS, queued);
  });
}

function percentiles(samples) {
  const summary = summarizeDurations(samples);
  return { count: summary.count, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms };
}

/** Sağlık görünümü için sınırlı özet; gizli bilgi taşımaz. */
export function aiTelemetrySnapshot() {
  const current = state();
  return {
    since: current.startedAt,
    requests: current.requests,
    succeeded: current.succeeded,
    outcomes: { ...current.outcomes },
    bySource: { ...current.bySource },
    byProfile: { ...current.byProfile },
    retries: current.retries,
    latency: {
      provider: percentiles(current.providerLatencyMs),
      queueWait: percentiles(current.queueWaitMs)
    },
    lastSuccessAt: current.lastSuccessAt,
    lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
    lastBusyAt: current.lastBusyAt,
    provider: { ...current.provider }
  };
}

export function resetAiTelemetryForTests() {
  globalThis[STATE_KEY] = createState();
}
