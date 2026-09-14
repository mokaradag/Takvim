import 'server-only';
import { METRIC_BUCKET_MS, bucketStart, summarizeDurations } from '../../domain/observability/metrics.js';

/**
 * Bellek içi, SINIRLI telemetri toplayıcısı.
 *
 * Her istek için SQL satırı yazmak, gözlemlenebilirliği üretimde yeni bir yük
 * kaynağına dönüştürürdü. Bu yüzden yüksek sıklıklı gözlemler önce bellekte
 * beş dakikalık kovalarda toplanır; yalnızca KAPANMIŞ kovaların özeti
 * kalıcılaştırılır (bkz. telemetryRepository.js).
 *
 * Bütün sınırlar açıktır:
 *  - kova başına işlem adı sayısı,
 *  - işlem başına saklanan süre örneği sayısı (rezervuar örneklemesi),
 *  - bellekte tutulan kova sayısı,
 *  - son işletim olayları halkası.
 *
 * Sınır aşıldığında sayaçlar çalışmaya devam eder; yalnızca örnek AYRINTISI
 * seyrelir. Toplayıcı hiçbir koşulda sınırsız büyümez.
 */

const MAX_OPERATIONS_PER_BUCKET = 120;
const MAX_SAMPLES_PER_OPERATION = 400;
const MAX_BUCKETS_IN_MEMORY = 36;
const MAX_RECENT_EVENTS = 60;
const MAX_GAUGES_PER_BUCKET = 40;
/** Kalıcılaştırılamayan kova özetlerinin SINIRLI yeniden deneme kuyruğu. */
const MAX_SPOOLED_ROWS = 500;

const REGISTRY_KEY = Symbol.for('mergen-rota.telemetry-registry');

function createState() {
  return {
    buckets: new Map(),
    recentEvents: [],
    startedAt: Date.now(),
    droppedOperations: 0,
    // Sınır aşımı nedeniyle YİTİRİLEN telemetri sessiz kalmaz: sayaçlar
    // yönetim konsoluna bildirilir, eksik geçmiş görünmez kalmaz.
    droppedBuckets: 0,
    droppedSpoolRows: 0,
    spool: { operations: [], gauges: [] }
  };
}

let flushCounter = 0;

/** Boşaltma kimliği: aynı özet yeniden denendiğinde DEĞİŞMEZ. */
function nextFlushId() {
  flushCounter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${flushCounter.toString(36)}`.slice(0, 64);
}

function state() {
  globalThis[REGISTRY_KEY] ||= createState();
  return globalThis[REGISTRY_KEY];
}

function bucketFor(timestamp) {
  const store = state();
  const key = bucketStart(timestamp, METRIC_BUCKET_MS);
  if (key == null) return null;
  if (!store.buckets.has(key)) {
    store.buckets.set(key, { bucketStart: key, operations: new Map(), gauges: new Map() });
    // En eski kovalar düşürülür: kalıcılaştırma turu çalışmasa bile bellek
    // sınırı korunur. Düşürme SESSİZ değildir — sayaç, yöneticinin 30 günlük
    // geçmişteki boşluğu fark edebilmesi için bildirilir.
    while (store.buckets.size > MAX_BUCKETS_IN_MEMORY) {
      const oldest = Math.min(...store.buckets.keys());
      store.buckets.delete(oldest);
      store.droppedBuckets += 1;
    }
  }
  return store.buckets.get(key);
}

/**
 * Rezervuar örneklemesi.
 *
 * Sınıra ulaşıldığında yeni örnek, azalan olasılıkla rastgele bir eskisinin
 * yerine yazılır. Böylece sabit bellekte yansız bir dağılım korunur; ilk 400
 * isteği saklayıp gerisini atmak, yavaşlamayı tam da yoğunlukta gizlerdi.
 */
function addSample(entry, durationMs) {
  entry.observed += 1;
  if (entry.samples.length < MAX_SAMPLES_PER_OPERATION) {
    entry.samples.push(durationMs);
    return;
  }
  const index = Math.floor(Math.random() * entry.observed);
  if (index < MAX_SAMPLES_PER_OPERATION) entry.samples[index] = durationMs;
}

export function normalizeOperationName(value) {
  return String(value ?? 'unknown').trim().slice(0, 100) || 'unknown';
}

/**
 * Bir işlemin sonucunu kaydeder.
 *
 * @param {{operation: string, durationMs: number, ok?: boolean, code?: string|null, at?: number}} input
 */
export function recordOperation({ operation, durationMs, ok = true, code = null, at = Date.now() } = {}) {
  const bucket = bucketFor(at);
  if (!bucket) return;
  const name = normalizeOperationName(operation);
  if (!bucket.operations.has(name)) {
    if (bucket.operations.size >= MAX_OPERATIONS_PER_BUCKET) {
      state().droppedOperations += 1;
      return;
    }
    bucket.operations.set(name, { count: 0, errorCount: 0, observed: 0, samples: [], sumMs: 0, maxMs: 0, codes: new Map() });
  }
  const entry = bucket.operations.get(name);
  const duration = Math.max(0, Number(durationMs) || 0);
  entry.count += 1;
  entry.sumMs += duration;
  entry.maxMs = Math.max(entry.maxMs, duration);
  addSample(entry, duration);
  if (!ok) {
    entry.errorCount += 1;
    const key = String(code || 'UNKNOWN').slice(0, 60);
    entry.codes.set(key, (entry.codes.get(key) || 0) + 1);
  }
}

/** Anlık ölçüm (bellek, kuyruk derinliği gibi) kaydeder. */
export function recordGauge(metricKey, value, at = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  const bucket = bucketFor(at);
  if (!bucket) return;
  const key = String(metricKey ?? '').trim().slice(0, 60);
  if (!key) return;
  if (!bucket.gauges.has(key)) {
    if (bucket.gauges.size >= MAX_GAUGES_PER_BUCKET) return;
    bucket.gauges.set(key, { count: 0, sum: 0, min: numeric, max: numeric });
  }
  const entry = bucket.gauges.get(key);
  entry.count += 1;
  entry.sum += numeric;
  entry.min = Math.min(entry.min, numeric);
  entry.max = Math.max(entry.max, numeric);
}

/**
 * İşletim akışına bir satır ekler (yalnızca bellek).
 *
 * Kalıcı olaylar SQL tarafındadır; bu halka, sunucu yeniden başlayana kadar
 * süren "az önce ne oldu" akışını besler ve her zaman sınırlıdır.
 */
export function recordFeedEntry(entry) {
  const store = state();
  store.recentEvents.unshift({ ...entry, at: entry?.at || new Date().toISOString() });
  if (store.recentEvents.length > MAX_RECENT_EVENTS) store.recentEvents.length = MAX_RECENT_EVENTS;
}

export function recentFeed(limit = 20) {
  return state().recentEvents.slice(0, Math.max(1, Math.min(Number(limit) || 20, MAX_RECENT_EVENTS)));
}

function summarizeEntry(name, entry) {
  const durations = summarizeDurations(entry.samples);
  return {
    operation: name,
    count: entry.count,
    errorCount: entry.errorCount,
    errorRate: entry.count > 0 ? entry.errorCount / entry.count : 0,
    avgMs: entry.count > 0 ? entry.sumMs / entry.count : null,
    maxMs: entry.count > 0 ? entry.maxMs : null,
    p50Ms: durations.p50Ms,
    p95Ms: durations.p95Ms,
    p99Ms: durations.p99Ms,
    sampleCount: entry.samples.length,
    topFailureCode: [...entry.codes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null
  };
}

/** Bellekteki kovaların işlem özetleri (kalıcılaştırılmamış güncel pencere dâhil). */
export function snapshotOperations({ sinceMs = null } = {}) {
  const rows = [];
  for (const bucket of state().buckets.values()) {
    if (sinceMs != null && bucket.bucketStart + METRIC_BUCKET_MS <= sinceMs) continue;
    for (const [name, entry] of bucket.operations) {
      rows.push({ bucketStart: bucket.bucketStart, ...summarizeEntry(name, entry) });
    }
  }
  return rows.sort((left, right) => left.bucketStart - right.bucketStart);
}

export function snapshotGauges({ sinceMs = null } = {}) {
  const rows = [];
  for (const bucket of state().buckets.values()) {
    if (sinceMs != null && bucket.bucketStart + METRIC_BUCKET_MS <= sinceMs) continue;
    for (const [key, entry] of bucket.gauges) {
      rows.push({
        bucketStart: bucket.bucketStart,
        metricKey: key,
        count: entry.count,
        avg: entry.count > 0 ? entry.sum / entry.count : null,
        min: entry.min,
        max: entry.max
      });
    }
  }
  return rows.sort((left, right) => left.bucketStart - right.bucketStart);
}

/**
 * KAPANMIŞ kovaları kalıcılaştırma için devreder ve bellekten düşürür.
 *
 * Güncel kova açık bırakılır: yarım bir kovayı yazıp sonra güncellemek, aynı
 * satırı dakikada bir yeniden yazmak demekti.
 */
export function drainClosedBuckets(now = Date.now()) {
  const store = state();
  const currentBucket = bucketStart(now, METRIC_BUCKET_MS);
  // Önceki turda yazılamayan satırlar ÖNCE gönderilir: en eski ölçüm önce
  // kalıcılaşır ve yeniden deneme kuyruğu birikmez.
  const operations = store.spool.operations.splice(0, store.spool.operations.length);
  const gauges = store.spool.gauges.splice(0, store.spool.gauges.length);
  for (const [key, bucket] of [...store.buckets.entries()].sort((left, right) => left[0] - right[0])) {
    if (key >= currentBucket) continue;
    for (const [name, entry] of bucket.operations) {
      operations.push({ bucketStart: key, flushId: nextFlushId(), ...summarizeEntry(name, entry) });
    }
    for (const [metricKey, entry] of bucket.gauges) {
      gauges.push({
        bucketStart: key,
        metricKey,
        flushId: nextFlushId(),
        count: entry.count,
        avg: entry.count > 0 ? entry.sum / entry.count : null,
        min: entry.min,
        max: entry.max
      });
    }
    store.buckets.delete(key);
  }
  return { operations, gauges };
}

/**
 * Kalıcılaştırılamayan kova özetlerini SINIRLI yeniden deneme kuyruğuna alır.
 *
 * Bir sonraki tur bunları yeniden yazmayı dener; böylece veritabanı kesintisi
 * 30 günlük geçmişte SESSİZ bir boşluk bırakmaz. Kuyruk da sınırlıdır: taşan
 * satırlar sayılır ve yönetim konsoluna bildirilir.
 */
export function spoolUnpersistedBuckets({ operations = [], gauges = [] } = {}) {
  const store = state();
  const append = (target, rows) => {
    for (const row of rows) {
      if (target.length >= MAX_SPOOLED_ROWS) {
        store.droppedSpoolRows += 1;
        continue;
      }
      target.push(row);
    }
  };
  append(store.spool.operations, operations);
  append(store.spool.gauges, gauges);
  return {
    operations: store.spool.operations.length,
    gauges: store.spool.gauges.length
  };
}

/**
 * Yitirilen telemetri sayaçlarını OKUR VE SIFIRLAR.
 *
 * Sıfırlama bilinçlidir: aynı kayıp her turda yeniden bildirilirse yönetici
 * yeni bir kaybı eskisinden ayıramaz.
 */
export function consumeTelemetryLossCounters({ reset = true } = {}) {
  const store = state();
  const counters = {
    droppedOperations: store.droppedOperations,
    droppedBuckets: store.droppedBuckets,
    droppedSpoolRows: store.droppedSpoolRows
  };
  if (reset) {
    store.droppedOperations = 0;
    store.droppedBuckets = 0;
    store.droppedSpoolRows = 0;
  }
  return counters;
}

/** Yeniden deneme kuyruğunun anlık büyüklüğü (tanı ve sınama için). */
export function spooledBucketCount() {
  const store = state();
  return { operations: store.spool.operations.length, gauges: store.spool.gauges.length };
}

export function registryStartedAt() {
  return state().startedAt;
}

/** Testler ve veri kipi değişimi için toplayıcıyı sıfırlar. */
export function resetTelemetryRegistryForTests() {
  globalThis[REGISTRY_KEY] = createState();
}

export const TELEMETRY_LIMITS = Object.freeze({
  MAX_OPERATIONS_PER_BUCKET,
  MAX_SAMPLES_PER_OPERATION,
  MAX_BUCKETS_IN_MEMORY,
  MAX_RECENT_EVENTS,
  MAX_GAUGES_PER_BUCKET,
  MAX_SPOOLED_ROWS
});
