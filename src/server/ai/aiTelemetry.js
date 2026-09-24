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
    // Paylaşılan kapasitenin dolması (küresel ya da model sınırı); sağlığı etkiler.
    lastBusyAt: null,
    lastQueueTimeoutAt: null,
    // Tek kullanıcının kendi sınırı; hizmet sağlığı değildir, yalnızca izlenir.
    lastUserLimitAt: null,
    provider: {
      lastContactAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastLatencyMs: null,
      // Milisaniye damgaları eşitlenebilir; sıra tekdüze sayaçla tutulur.
      sequence: 0,
      lastOutcome: null
    }
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

/** Paylaşılan kurumsal anahtarın bozuk olduğunu gösteren sonuçlar. */
const CORPORATE_KEY_FAILURES = new Set([AI_ERROR_CODES.AI_KEY_INVALID, AI_ERROR_CODES.AI_UNAUTHORIZED]);

function logFailure({ outcome, source, profile, model, durationMs, attempts, details }) {
  if (QUIET_CODES.has(outcome.code)) return;
  // Kullanıcının kendi anahtarı ya da isteği kaynaklı sonuçlar hizmet sorunu
  // değildir. Tek istisna reddedilen KURUMSAL anahtardır: herkesi etkiler. Kurumsal
  // anahtarla yapılmış olsa da geçersiz istek (400/413/422) işletim günlüğüne girmez.
  const corporateKeyRejected = source === AI_CREDENTIAL_SOURCES.DEFAULT && CORPORATE_KEY_FAILURES.has(outcome.code);
  if (!outcome.serviceFailure && !corporateKeyRejected) return;
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
 * Kapasite reddi ya da sıra süre aşımı PAYLAŞILAN kapasiteyi mi anlatıyor?
 *
 * Yalnızca kullanıcının kendi etkin/sıra sınırına takılan istek hizmetin dolu
 * olduğunu göstermez; küresel sıra, küresel etkin sınır ya da model sınırı
 * gösterir.
 */
function sharedCapacityPressure(details) {
  if (details?.scope === 'global') return true;
  return details?.saturation !== 'user';
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
      const capacityOutcome = outcome.code === AI_ERROR_CODES.AI_BUSY || outcome.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT;
      if (capacityOutcome && !sharedCapacityPressure(details)) current.lastUserLimitAt = now;
      else if (outcome.code === AI_ERROR_CODES.AI_BUSY) current.lastBusyAt = now;
      else if (outcome.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT) current.lastQueueTimeoutAt = now;
    }
    if (Object.hasOwn(current.bySource, source)) current.bySource[source] += 1;
    if (isKnownAiProfile(profile)) current.byProfile[profile] = (current.byProfile[profile] || 0) + 1;
    if (attempts > 1) current.retries += attempts - 1;
    // Sırada süresi dolan istek de beklemiştir: en kötü beklemeler özetten düşmez.
    pushSample(current.queueWaitMs, queueWaitMs);
    recordOperation({
      operation: 'ai.request',
      durationMs,
      ok: !outcome?.serviceFailure,
      code: outcome?.serviceFailure ? outcome.code : null
    });
    if (queueWaitMs != null) {
      const timedOut = outcome?.code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT;
      recordOperation({
        operation: 'ai.queue.wait',
        durationMs: queueWaitMs,
        ok: !timedOut,
        code: timedOut ? AI_ERROR_CODES.AI_QUEUE_TIMEOUT : null
      });
    }
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
 * Varsayılan olarak HTTP yanıtı alınan her çağrı (401 dâhil) ERİŞİM sayılır;
 * yalnızca `PROVIDER_HEALTH_FAILURES` kodları sağlık hatasıdır. Çağıran,
 * sonucun PAYLAŞILAN sağlığı anlatıp anlatmadığını bildiğinde `healthFailure`
 * ile bunu açıkça belirtir: reddedilen KURUMSAL anahtar herkesi etkilediği için
 * hatadır, KİŞİSEL anahtarın oran sınırı ise yalnızca o anahtarı anlatır.
 *
 * Gecikme, sağlık sınıfından bağımsız olarak tamamlanan her çağrı için
 * örneklenir: en yavaş (süre aşımına uğrayan) çağrılar P95'ten düşmez. İptal
 * edilen çağrı sağlayıcının başarımını anlatmadığı için kaydedilmez.
 */
export function recordProviderCall({ operation, latencyMs, code = null, healthFailure = null }) {
  if (code === AI_ERROR_CODES.AI_CANCELLED) return;
  safely(() => {
    const current = state();
    const unhealthy = typeof healthFailure === 'boolean' ? healthFailure : code != null && PROVIDER_HEALTH_FAILURES.has(code);
    const now = new Date().toISOString();
    recordOperation({ operation, durationMs: latencyMs, ok: !unhealthy, code: unhealthy ? code : null });
    current.provider.sequence += 1;
    current.provider.lastLatencyMs = Math.max(0, Math.round(latencyMs));
    pushSample(current.providerLatencyMs, latencyMs);
    if (unhealthy) {
      current.provider.lastFailureAt = now;
      current.provider.lastFailureCode = code;
      current.provider.lastOutcome = 'failure';
    } else {
      current.provider.lastContactAt = now;
      current.provider.lastOutcome = 'contact';
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
    lastQueueTimeoutAt: current.lastQueueTimeoutAt,
    lastUserLimitAt: current.lastUserLimitAt,
    provider: { ...current.provider }
  };
}

export function resetAiTelemetryForTests() {
  globalThis[STATE_KEY] = createState();
}
