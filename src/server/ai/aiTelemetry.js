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
/**
 * Sağlayıcının sağlığını anlatan sonuçlar; anahtar ya da istek kararları erişim
 * sayılır. Sağlayıcının bulunamayan uç/model ya da yönlendirme yanıtı (ve
 * sabit deneme isteğinin reddi) dağıtım yapılandırmasının hatasıdır: herkesi
 * etkiler.
 */
const PROVIDER_HEALTH_FAILURES = new Set([
  AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
  AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID,
  AI_ERROR_CODES.AI_TIMEOUT,
  AI_ERROR_CODES.AI_RATE_LIMITED,
  AI_ERROR_CODES.AI_CONFIGURATION_ERROR
]);
/** Kurumsal anahtarla yapılan çağrının, kurumsal anahtara bağlı herkesi etkileyen sonuçları. */
const DEFAULT_KEY_FAILURES = new Set([
  AI_ERROR_CODES.AI_KEY_INVALID,
  AI_ERROR_CODES.AI_UNAUTHORIZED,
  AI_ERROR_CODES.AI_RATE_LIMITED
]);
const CAPACITY_CODES = new Set([AI_ERROR_CODES.AI_BUSY, AI_ERROR_CODES.AI_QUEUE_TIMEOUT]);
/** Paylaşılan kurumsal anahtarın reddedildiğini gösteren sonuçlar. */
const CORPORATE_KEY_FAILURES = new Set([AI_ERROR_CODES.AI_KEY_INVALID, AI_ERROR_CODES.AI_UNAUTHORIZED]);
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
    // Akışlı yanıtlar: algılanan hız (ilk metin) ve üretim süresi örnekleri ile sonuç sayaçları.
    firstTokenMs: [],
    streamGenerationMs: [],
    streams: { completed: 0, cancelled: 0, timeout: 0, interrupted: 0, failed: 0 },
    assistantTurns: { completed: 0, failed: 0, cancelled: 0, lastFailure: null },
    // Rota verisi araçları: yalnızca araç adı, sonuç sınıfı ve süre (içerik YOK).
    tools: { calls: 0, byOutcome: {}, byTool: {}, latencyMs: [], lastFailure: null },
    // Kanıta dayalı yanıtların sonucu: grounded (kanıtlı), direct (araçsız), failed (doğrulanamadı).
    grounding: { grounded: 0, general_redirect: 0, clarification: 0, not_found: 0, unavailable: 0, failed: 0, repaired: 0, disclosed: 0, rounds: [], evidence: [],
      escalations: { total: 0, byReason: {}, byOutcome: {} } },
    // Görünür çıktı üretmeden biten model çağrıları (tanı günlüğe yazılır).
    emptyCompletions: 0,
    retries: 0,
    lastSuccessAt: null,
    // Hizmet hatası (sağlayıcı öncesi de olabilir: rehber, anahtar tablosu, iç
    // hata). Sıra sayacı taşır: daha sonraki başarılı bir istek onu geride bırakır.
    lastFailure: null,
    // Uçtan uca istek ve doğrulama sonuçlarının tekdüze sırası.
    requestSequence: 0,
    lastOkSequence: 0,
    // Paylaşılan yapay zekâ kapasitesinin dolması (küresel ya da model sınırı); sağlığı etkiler.
    lastBusyAt: null,
    lastQueueTimeoutAt: null,
    // Kira ÖNCESİ rehber denetiminin (SQL) sınırlı kapısının dolması: yapay zekâ
    // kapasitesinden ayrı bir darboğazdır, ayrı bildirilir.
    lastDirectoryBusyAt: null,
    // Tek kullanıcının kendi sınırı; hizmet sağlığı değildir, yalnızca izlenir.
    lastUserLimitAt: null,
    provider: {
      lastContactAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastLatencyMs: null,
      // Milisaniye damgaları eşitlenebilir; sıra tekdüze sayaçla tutulur.
      sequence: 0,
      lastOutcome: null,
      // Kurumsal anahtarın son reddi ayrı tutulur: kişisel anahtarla yapılan
      // başarılı bir çağrı sağlayıcıya erişimi kanıtlar ama kurumsal anahtarla
      // çalışan kullanıcıların sorununu gidermez. Yalnızca kurumsal anahtarla
      // yapılan başarılı bir çağrı bu kaydı temizler.
      defaultKey: { lastFailureAt: null, lastFailureCode: null }
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

/**
 * Kapasite reddi ya da sıra süre aşımı PAYLAŞILAN kapasiteyi mi anlatıyor?
 *
 * Yalnızca kullanıcının kendi etkin/sıra sınırına takılan istek hizmetin dolu
 * olduğunu göstermez; küresel sıra, küresel etkin sınır, model sınırı ya da
 * rehber denetiminin sınırlı sırası gösterir.
 */
function sharedCapacityPressure(details) {
  if (details?.scope === 'global') return true;
  return details?.saturation !== 'user';
}

/**
 * Sonucun HİZMET hatası olup olmadığı; katalog varsayılanı kaynağa göre
 * düzeltilir: kişisel anahtarın oran sınırı yalnızca o anahtarı, kullanıcının
 * kendi etkin/sıra sınırı yalnızca o kullanıcıyı anlatır (hizmet hatası
 * değildir); reddedilen KURUMSAL anahtar (401/403) ise kişisel anahtarı olmayan
 * herkesi etkiler (hizmet hatasıdır).
 */
function outcomeOf(code, serviceFailure, { source = null, details = null } = {}) {
  if (!isAiErrorCode(code)) return { code: String(code).slice(0, 60), serviceFailure: Boolean(serviceFailure) };
  const definition = aiErrorDefinition(code);
  if (definition.code === AI_ERROR_CODES.AI_RATE_LIMITED && source === AI_CREDENTIAL_SOURCES.PERSONAL) {
    return { code: definition.code, serviceFailure: false };
  }
  if (source === AI_CREDENTIAL_SOURCES.DEFAULT && CORPORATE_KEY_FAILURES.has(definition.code)) {
    return { code: definition.code, serviceFailure: true };
  }
  if (CAPACITY_CODES.has(definition.code) && !sharedCapacityPressure(details)) {
    return { code: definition.code, serviceFailure: false };
  }
  return { code: definition.code, serviceFailure: definition.serviceFailure };
}

/**
 * Kapasite sonucunu paylaşılan baskı ya da kullanıcının kendi sınırı olarak
 * işaretler. Rehber denetimi kapısının dolması yapay zekâ kapasitesiyle
 * karıştırılmaz: o istekler kapasite denetimine hiç ulaşmamıştır.
 */
function noteCapacityOutcome(current, code, details, at) {
  if (!CAPACITY_CODES.has(code)) return;
  if (!sharedCapacityPressure(details)) current.lastUserLimitAt = at;
  else if (details?.saturation === 'directory') current.lastDirectoryBusyAt = at;
  else if (code === AI_ERROR_CODES.AI_BUSY) current.lastBusyAt = at;
  else current.lastQueueTimeoutAt = at;
}

/** Uçtan uca sonucu sıraya yazar; hizmet hatası sıra numarasıyla saklanır. */
function noteServiceOutcome(current, outcome, at) {
  current.requestSequence += 1;
  if (!outcome) current.lastOkSequence = current.requestSequence;
  else if (outcome.serviceFailure) current.lastFailure = { code: outcome.code, at, sequence: current.requestSequence };
}

/** Sıra beklemesi (süresi dolan bekleme dâhil) özet ve işlem ölçümüne girer. */
function recordQueueWait(current, { queueWaitMs, code }) {
  if (queueWaitMs == null) return;
  pushSample(current.queueWaitMs, queueWaitMs);
  const timedOut = code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT;
  recordOperation({
    operation: 'ai.queue.wait',
    durationMs: queueWaitMs,
    ok: !timedOut,
    code: timedOut ? AI_ERROR_CODES.AI_QUEUE_TIMEOUT : null
  });
}

function logFailure({ outcome, source, profile, model, durationMs, attempts, details }) {
  if (QUIET_CODES.has(outcome.code)) return;
  // Kullanıcının kendi anahtarı ya da isteği kaynaklı sonuçlar hizmet sorunu
  // değildir; reddedilen KURUMSAL anahtar ise hizmet hatası olarak sınıflanır
  // (bkz. `outcomeOf`). Kurumsal anahtarla yapılmış olsa da geçersiz istek
  // (400/413/422) işletim günlüğüne girmez.
  if (!outcome.serviceFailure) return;
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
 * `serviceFailure` yalnızca yapay zekâ kataloğu dışındaki sunucu kodları için
 * okunur. Yinelemeler burada değil, gerçekleştikleri anda (`recordAiRetry`)
 * sayılır.
 */
const recordedFailures = new WeakSet();

export function recordAiRequest({
  profile, model = null, source = null, code = null, serviceFailure = false, details = null,
  durationMs, queueWaitMs = null, attempts = 1, error = null
}) {
  let outcome = null;
  safely(() => {
    outcome = code ? outcomeOf(code, serviceFailure, { source, details }) : null;
    const current = state();
    const now = new Date().toISOString();
    current.requests += 1;
    noteServiceOutcome(current, outcome, now);
    if (!outcome) {
      current.succeeded += 1;
      current.lastSuccessAt = now;
    } else {
      current.outcomes[outcome.code] = (current.outcomes[outcome.code] || 0) + 1;
      noteCapacityOutcome(current, outcome.code, details, now);
    }
    if (Object.hasOwn(current.bySource, source)) current.bySource[source] += 1;
    if (isKnownAiProfile(profile)) current.byProfile[profile] = (current.byProfile[profile] || 0) + 1;
    recordOperation({
      operation: 'ai.request',
      durationMs,
      ok: !outcome?.serviceFailure,
      code: outcome?.serviceFailure ? outcome.code : null
    });
    // Sırada süresi dolan istek de beklemiştir: en kötü beklemeler özetten düşmez.
    recordQueueWait(current, { queueWaitMs, code: outcome?.code });
  });
  if (outcome) safely(() => {
    logFailure({ outcome, source, profile, model, durationMs, attempts, details });
    if (error && typeof error === 'object') recordedFailures.add(error);
  });
}

/**
 * Kişisel anahtarın açık doğrulaması; model üretimi içermez, ayrı ölçülür.
 * Aynı kapasite denetimini paylaştığı için kapasite reddi ve sıra beklemesi
 * sohbet isteğiyle aynı biçimde (paylaşılan baskı / kullanıcı sınırı) izlenir.
 */
export function recordAiValidation({ code = null, serviceFailure = false, details = null, queueWaitMs = null, durationMs }) {
  safely(() => {
    const current = state();
    const outcome = code ? outcomeOf(code, serviceFailure, { source: AI_CREDENTIAL_SOURCES.PERSONAL, details }) : null;
    const now = new Date().toISOString();
    noteServiceOutcome(current, outcome, now);
    if (outcome) noteCapacityOutcome(current, outcome.code, details, now);
    recordOperation({
      operation: 'ai.credential.validate',
      durationMs,
      ok: !outcome?.serviceFailure,
      code: outcome?.serviceFailure ? outcome.code : null
    });
    recordQueueWait(current, { queueWaitMs, code: outcome?.code });
  });
}

/**
 * Sağlayıcı çağrısının süresi ve erişilebilirlik izi.
 *
 * İşlem ölçümü (`recordOperation`) çağrının GERÇEK sonucunu anlatır: sağlayıcının
 * reddettiği her çağrı (kişisel anahtarın 401'i dâhil) başarısızdır. Sağlık izi
 * ise ayrı bir sorudur: varsayılan olarak HTTP yanıtı alınan her çağrı ERİŞİM
 * sayılır; yalnızca `PROVIDER_HEALTH_FAILURES` kodları sağlık hatasıdır. Çağıran,
 * sonucun PAYLAŞILAN sağlığı anlatıp anlatmadığını bildiğinde `healthFailure`
 * ile bunu açıkça belirtir: reddedilen KURUMSAL anahtar herkesi etkilediği için
 * hatadır, KİŞİSEL anahtarın oran sınırı ise yalnızca o anahtarı anlatır.
 *
 * `source` kurumsal anahtarsa sonuç kurumsal anahtarın izine de yazılır; o iz
 * yalnızca kurumsal anahtarın KABUL EDİLDİĞİ bir çağrıyla temizlenir.
 * `contact: false`, yanıtın paylaşılan yolun çalıştığını KANITLAMADIĞINI söyler
 * (ör. geçersiz anahtarla da verilen model listesi): gecikme örneklenir ama
 * erişim kaydedilmez. `keyAccepted` anahtarın kabulünü erişimden ayrı bildirir
 * (varsayılanı: başarılı ve erişim sayılan çağrı); `healthCode`, HTTP işlemi
 * başarılı olsa da paylaşılan yolu bozan sorunun (ör. modelin uçta olmaması)
 * sağlık izine yazılacak kodudur.
 *
 * Gecikme, sağlık sınıfından bağımsız olarak tamamlanan her çağrı için
 * örneklenir: en yavaş (süre aşımına uğrayan) çağrılar P95'ten düşmez. İptal
 * edilen çağrı sağlayıcının başarımını anlatmadığı için kaydedilmez.
 */
export function recordProviderCall({
  operation, latencyMs, code = null, healthFailure = null, healthCode = null, source = null, contact = true, keyAccepted = null
}) {
  if (code === AI_ERROR_CODES.AI_CANCELLED) return;
  safely(() => {
    const current = state();
    const unhealthy = typeof healthFailure === 'boolean' ? healthFailure : code != null && PROVIDER_HEALTH_FAILURES.has(code);
    const now = new Date().toISOString();
    recordOperation({ operation, durationMs: latencyMs, ok: code == null, code: code ?? null });
    current.provider.sequence += 1;
    current.provider.lastLatencyMs = Math.max(0, Math.round(latencyMs));
    pushSample(current.providerLatencyMs, latencyMs);
    if (source === AI_CREDENTIAL_SOURCES.DEFAULT) {
      if (keyAccepted ?? (code == null && contact)) current.provider.defaultKey = { lastFailureAt: null, lastFailureCode: null };
      else if (DEFAULT_KEY_FAILURES.has(code)) current.provider.defaultKey = { lastFailureAt: now, lastFailureCode: code };
    }
    if (unhealthy) {
      current.provider.lastFailureAt = now;
      current.provider.lastFailureCode = healthCode ?? code;
      current.provider.lastOutcome = 'failure';
    } else if (contact) {
      current.provider.lastContactAt = now;
      current.provider.lastOutcome = 'contact';
    }
  });
}

/**
 * Akışlı yanıtın algılanan hızı ve sonucu. Ölçümler içerik TAŞIMAZ.
 *
 * - `firstTokenMs`: isteğin ağ geçidine girişinden ilk GÖRÜNÜR metin parçasına
 *   kadar (rehber denetimi, sıra ve sağlayıcının ilk yanıtı dâhil) —
 *   `ai.stream.first_token`.
 * - `providerStartMs`: sağlayıcı çağrısından başarılı HTTP yanıtına kadar —
 *   `ai.stream.provider_start`.
 * - `generationMs`: sağlayıcı çağrısından akışın tamamlanmasına kadar (yalnızca
 *   tamamlanan akışlar; işlem ölçümü `ai.provider.stream` ile ayrıca yazılır).
 * - `outcome`: `completed`, `cancelled`, `timeout`, `interrupted` (metin
 *   başladıktan sonra kesildi) ya da `failed` (metin başlamadan başarısız).
 */
export function recordAiStream({ outcome, firstTokenMs = null, providerStartMs = null, generationMs = null }) {
  safely(() => {
    const current = state();
    if (Object.hasOwn(current.streams, outcome)) current.streams[outcome] += 1;
    if (firstTokenMs != null && Number.isFinite(firstTokenMs)) {
      pushSample(current.firstTokenMs, firstTokenMs);
      recordOperation({ operation: 'ai.stream.first_token', durationMs: firstTokenMs, ok: true });
    }
    if (providerStartMs != null && Number.isFinite(providerStartMs)) {
      recordOperation({ operation: 'ai.stream.provider_start', durationMs: providerStartMs, ok: true });
    }
    if (generationMs != null) pushSample(current.streamGenerationMs, generationMs);
  });
}

/** Yineleme GERÇEKTEN başlarken sayılır ve günlüğe yazılır (sohbet ve doğrulama için aynı). */
export function recordAiRetry({ networkCode = null } = {}) {
  safely(() => {
    state().retries += 1;
  });
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

/** Etkin ve sıradaki istek sayısı (tur aralığının zaman ağırlıklı ortalaması; bkz. aiRuntime.sampleAiLoad). */
export function recordAiLoad({ active, queued }, at = Date.now()) {
  safely(() => {
    recordGauge(GAUGE_KEYS.AI_ACTIVE_REQUESTS, active, at);
    recordGauge(GAUGE_KEYS.AI_QUEUED_REQUESTS, queued, at);
  });
}

function percentiles(samples) {
  const summary = summarizeDurations(samples);
  return { count: summary.count, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms };
}

function countPercentiles(samples) {
  const { count, p50Ms, p95Ms } = percentiles(samples);
  return { count, p50Count: p50Ms, p95Count: p95Ms };
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
      queueWait: percentiles(current.queueWaitMs),
      firstToken: percentiles(current.firstTokenMs),
      streamGeneration: percentiles(current.streamGenerationMs)
    },
    streams: { ...current.streams },
    assistantTurns: { ...current.assistantTurns, lastFailure: current.assistantTurns.lastFailure ? { ...current.assistantTurns.lastFailure } : null },
    tools: {
      calls: current.tools.calls,
      byOutcome: { ...current.tools.byOutcome },
      byTool: Object.fromEntries(Object.entries(current.tools.byTool).map(([name, entry]) => [name, { ...entry }])),
      latency: percentiles(current.tools.latencyMs),
      lastFailure: current.tools.lastFailure ? { ...current.tools.lastFailure } : null
    },
    grounding: {
      grounded: current.grounding.grounded,
      general_redirect: current.grounding.general_redirect,
      clarification: current.grounding.clarification,
      not_found: current.grounding.not_found,
      unavailable: current.grounding.unavailable,
      failed: current.grounding.failed,
      repaired: current.grounding.repaired,
      disclosed: current.grounding.disclosed,
      rounds: countPercentiles(current.grounding.rounds),
      evidence: countPercentiles(current.grounding.evidence),
      escalations: {
        total: current.grounding.escalations.total,
        byReason: { ...current.grounding.escalations.byReason },
        byOutcome: { ...current.grounding.escalations.byOutcome }
      }
    },
    emptyCompletions: current.emptyCompletions,
    lastSuccessAt: current.lastSuccessAt,
    lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
    requestSequence: current.requestSequence,
    lastOkSequence: current.lastOkSequence,
    lastBusyAt: current.lastBusyAt,
    lastQueueTimeoutAt: current.lastQueueTimeoutAt,
    lastDirectoryBusyAt: current.lastDirectoryBusyAt,
    lastUserLimitAt: current.lastUserLimitAt,
    provider: { ...current.provider, defaultKey: { ...current.provider.defaultKey } }
  };
}

export function resetAiTelemetryForTests() {
  globalThis[STATE_KEY] = createState();
}

/**
 * Model üretimi ve yanıt kalıcılığı birlikte sonuçlandıktan sonra çağrılır.
 *
 * Her sonuç sayılır; ancak yalnızca HİZMET hatası (paylaşılan anahtarın reddi,
 * sağlayıcı/kalıcılık arızası, iç hata) sağlık görünümüne "son tur hatası"
 * olarak girer ve işletim günlüğüne yazılır. Kullanıcının kendi anahtarı ya da
 * isteği kaynaklı sonuçlar (geçersiz kişisel anahtar, kişisel oran sınırı,
 * reddedilen istek, silinmiş konuşma) herkese hizmet sorunu gibi görünmez;
 * sınıflandırma `recordAiRequest` ile aynıdır (`outcomeOf`).
 */
export function recordAssistantTurn({ code = null, source = null, details = null, serviceFailure = false, durationMs = 0, error = null }) {
  let outcome = null;
  safely(() => {
    const turns = state().assistantTurns;
    const cancelled = code === AI_ERROR_CODES.AI_CANCELLED;
    outcome = code && !cancelled ? outcomeOf(code, serviceFailure, { source, details }) : null;
    turns[code ? (cancelled ? 'cancelled' : 'failed') : 'completed'] += 1;
    if (!code) turns.lastFailure = null;
    else if (outcome?.serviceFailure) turns.lastFailure = { code: outcome.code, at: new Date().toISOString() };
    recordOperation({ operation: 'ai.assistant.turn', durationMs, ok: !outcome?.serviceFailure, code: outcome?.serviceFailure ? outcome.code : null });
  });
  if (outcome?.serviceFailure && !QUIET_CODES.has(outcome.code) && !recordedFailures.has(error)) {
    safely(() => logEvent({
      severity: [AI_ERROR_CODES.AI_CONFIGURATION_ERROR, AI_ERROR_CODES.AI_INTERNAL_ERROR, 'DATABASE_UNAVAILABLE'].includes(outcome.code)
        ? EVENT_SEVERITIES.ERROR : EVENT_SEVERITIES.WARNING, component: COMPONENTS.AI,
      operation: 'ai.assistant.turn', code: outcome.code, message: 'Bilgin turu tamamlanamadı.'
    }));
  }
}

/** Araç sonucu sınıfları: model ya da kullanıcı kaynaklı olanlar hizmet hatası değildir. */
const TOOL_SERVICE_FAILURES = new Set(['TIMEOUT', 'BUSY', 'DATABASE_UNAVAILABLE', 'INTERNAL']);
const MAX_TRACKED_TOOLS = 40;

/**
 * Tek araç çağrısı. Kayıt YALNIZCA araç adını, sonuç kodunu, süreyi ve sonuç
 * boyutunu taşır; bağımsız değişken, sonuç içeriği, Sicil ya da SQL taşımaz.
 */
export function recordAiToolCall({ tool, code = null, durationMs = 0, resultBytes = 0 }) {
  const failure = code != null && TOOL_SERVICE_FAILURES.has(code);
  safely(() => {
    const current = state().tools;
    const name = /^rota_[a-z_]{3,60}$/.test(String(tool)) ? String(tool) : 'unknown';
    current.calls += 1;
    const outcome = code || 'OK';
    current.byOutcome[outcome] = (current.byOutcome[outcome] || 0) + 1;
    if (current.byTool[name] || Object.keys(current.byTool).length < MAX_TRACKED_TOOLS) {
      const entry = current.byTool[name] ||= { calls: 0, failures: 0, lastLatencyMs: null, lastResultBytes: null };
      entry.calls += 1;
      if (failure) entry.failures += 1;
      entry.lastLatencyMs = Math.max(0, Math.round(durationMs));
      entry.lastResultBytes = Math.max(0, Math.round(resultBytes));
    }
    pushSample(current.latencyMs, durationMs);
    if (failure) current.lastFailure = { tool: name, code, at: new Date().toISOString() };
    recordOperation({ operation: 'ai.tool.call', durationMs, ok: !failure, code: failure ? code : null });
  });
  if (code === 'INTERNAL') {
    safely(() => logEvent({
      severity: EVENT_SEVERITIES.ERROR,
      component: COMPONENTS.AI,
      operation: 'ai.tool.call',
      code: 'AI_TOOL_INTERNAL_ERROR',
      message: 'Bilgin aracı beklenmeyen bir hatayla sonuçlandı.',
      durationMs,
      context: { tool: /^rota_[a-z_]{3,60}$/.test(String(tool)) ? String(tool) : 'unknown' }
    }));
  }
}

const SAFE_MODEL = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const safeModel = (value) => (SAFE_MODEL.test(String(value ?? '')) ? String(value) : null);
const safeCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const millis = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/**
 * Görünür çıktı üretmeden biten model çağrısı. Yalnızca bitiş nedeni, belirteç
 * sayıları, süreler ve hangi olay türlerinin geldiği yazılır; istem, araç
 * verisi ya da model metni yazılmaz.
 */
export function recordEmptyCompletion({ profile, model = null, diagnostics = {} }) {
  safely(() => { state().emptyCompletions += 1; });
  safely(() => logEvent({
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.AI,
    operation: 'ai.provider.empty_completion',
    code: 'AI_EMPTY_COMPLETION',
    message: 'Model görünür bir yanıt üretmeden durdu.',
    durationMs: millis(diagnostics.providerMs),
    context: {
      profile: isKnownAiProfile(profile) ? profile : null,
      model: safeModel(model),
      finishReason: typeof diagnostics.finishReason === 'string' ? diagnostics.finishReason.slice(0, 40) : null,
      usage: {
        input: safeCount(diagnostics.usage?.input),
        reasoning: safeCount(diagnostics.usage?.reasoning),
        completion: safeCount(diagnostics.usage?.completion),
        visible: safeCount(diagnostics.usage?.visible)
      },
      toolCalls: diagnostics.toolCalls === true,
      firstEventMs: millis(diagnostics.firstEventMs),
      providerMs: millis(diagnostics.providerMs),
      reasoningReceived: diagnostics.reasoningReceived === true,
      textReceived: diagnostics.textReceived === true
    }
  }));
}

const ESCALATION_REASONS = new Set(['VERIFICATION_FAILED', 'LENGTH', 'EMPTY_COMPLETION']);
const ESCALATION_OUTCOMES = new Set(['grounded', 'clarification', 'not_found', 'unavailable', 'general_redirect', 'failed', 'error']);

/**
 * Standart kipteki kanıta dayalı turun Derin düşünme ile sonlandırılması:
 * istenen kip, kullanılan modeller, neden, kanıtın yeniden kullanılıp
 * kullanılmadığı ve son sonuç (içerik taşımaz).
 */
export function recordGroundedEscalation({ requestedMode, models = [], reason, toolsReused = false, outcome }) {
  const safeReason = ESCALATION_REASONS.has(reason) ? reason : 'OTHER';
  const safeOutcome = ESCALATION_OUTCOMES.has(outcome) ? outcome : 'other';
  safely(() => {
    const current = state().grounding.escalations;
    current.total += 1;
    current.byReason[safeReason] = (current.byReason[safeReason] || 0) + 1;
    current.byOutcome[safeOutcome] = (current.byOutcome[safeOutcome] || 0) + 1;
  });
  safely(() => logEvent({
    severity: EVENT_SEVERITIES.INFO,
    component: COMPONENTS.AI,
    operation: 'ai.grounded.escalation',
    code: 'AI_GROUNDED_ESCALATION',
    message: 'Standart kipteki Rota verisi yanıtı Derin düşünme ile sonlandırıldı.',
    context: {
      requestedMode: ['standard', 'deep'].includes(requestedMode) ? requestedMode : null,
      models: [...new Set(models.map(safeModel).filter(Boolean))].slice(0, 4),
      reason: safeReason,
      toolsReused: toolsReused === true,
      outcome: safeOutcome
    }
  }));
}

/** Kanıta dayalı yanıtın sonucu (içerik taşımaz). */
export function recordGroundedAnswer({ outcome, rounds = 0, evidence = 0, repaired = false, disclosed = false }) {
  safely(() => {
    const current = state().grounding;
    if (Object.hasOwn(current, outcome) && typeof current[outcome] === 'number') current[outcome] += 1;
    if (repaired) current.repaired += 1;
    if (disclosed) current.disclosed += 1;
    pushSample(current.rounds, rounds);
    pushSample(current.evidence, evidence);
  });
}
