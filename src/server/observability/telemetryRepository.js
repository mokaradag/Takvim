import 'server-only';
import { sql } from '../db/pool.js';
import { METRIC_BUCKET_MS, mergeBucketSummaries } from '../../domain/observability/metrics.js';
import { applicationInstanceId } from './observabilityConfig.js';
import {
  TELEMETRY_GAUGE_MERGE_SQL,
  TELEMETRY_GAUGE_RETENTION_SQL,
  TELEMETRY_GAUGE_SERIES_SQL,
  TELEMETRY_OPERATION_BREAKDOWN_SQL,
  TELEMETRY_OPERATION_MERGE_SQL,
  TELEMETRY_OPERATION_RETENTION_SQL,
  TELEMETRY_OPERATION_SERIES_SQL
} from './telemetryQueries.js';

/**
 * Telemetri toplamlarının KALICI katmanı.
 *
 * Kalıcılaştırma isteğe bağlıdır: 0012 yükseltmesi uygulanmamışsa okuma boş,
 * yazma sessiz geçer ve uygulama çalışmaya devam eder. Gözlemlenebilirlik
 * gözlediği sistemi düşürmez.
 */

const MISSING_SCHEMA_CODES = new Set([207, 208, 2812]);
const MISSING_COLUMN_CODE = 207;
const TELEMETRY_OBJECTS = /(?<![\p{L}\p{N}_@$#])(?:MR_TelemetryOperationSamples|MR_TelemetryGaugeSamples|MR_OperationalEvents|MR_OperationalAlerts)(?![\p{L}\p{N}_@$#])/iu;
/**
 * Gözlemlenebilirlik şemasına ÖZGÜ sütun adları.
 *
 * `Invalid column name 'InstanceId'.` iletisi tablo adını TAŞIMAZ: yarım
 * uygulanmış bir 0012 göçünde nesne adı aranan sınıflandırıcı hatayı reddeder,
 * okuma ve yazma `schemaReady: false` yerine fırlatırdı. Liste yalnızca bu
 * şemada bulunan adları içerir; başka bir tablonun hatası eksik telemetri
 * şeması sayılmaz.
 */
const TELEMETRY_COLUMNS = /(?<![\p{L}\p{N}_@$#])(?:InstanceId|LastFlushId|BucketStart|MetricKey|AggregationKey|AlertKey|SampleCount|ErrorCount|DurationSumMs|DurationMaxMs|P50Ms|P95Ms|P99Ms|TopFailureCode|ValueAvg|ValueMin|ValueMax|OperationalEventId|OperationalAlertId)(?![\p{L}\p{N}_@$#])/iu;

function isMissingTelemetryEntry(entry) {
  const message = String(entry.message || '');
  const number = Number(entry.number);
  if (TELEMETRY_OBJECTS.test(message)
    && (MISSING_SCHEMA_CODES.has(number) || /Invalid object name/i.test(message))) return true;
  return (number === MISSING_COLUMN_CODE || /Invalid column name/i.test(message))
    && TELEMETRY_COLUMNS.test(message);
}

export function isMissingTelemetrySchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry && isMissingTelemetryEntry(entry));
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(Number(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function alignedSince(value) {
  const date = toDate(value);
  return date ? new Date(Math.floor(date.getTime() / METRIC_BUCKET_MS) * METRIC_BUCKET_MS) : null;
}

function roundOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

/**
 * Boşaltma kimliği.
 *
 * Kova özeti bellekte üretilirken ALINIR ve yeniden denemede AYNI kalır; MERGE
 * bu kimliği görünce satırı ikinci kez uygulamaz. Kimliği olmayan eski bir
 * satır için kova/ad/süreç üçlüsünden kararlı bir kimlik türetilir.
 */
function flushIdentity(row, instanceId) {
  const explicit = row?.flushId == null ? '' : String(row.flushId).trim();
  if (explicit) return explicit.slice(0, 64);
  const name = row?.operation ?? row?.metricKey ?? '';
  return `${instanceId}:${row?.bucketStart ?? ''}:${name}`.slice(0, 64);
}

/**
 * Yüzdelik değerini ÖLÇÜLEN örnek sayısına böler.
 *
 * Ölçülemeyen (NULL) yüzdelikler paya sıfır katar; paydada da sayılmamalıdır.
 * Aksi halde tek bir ölçümsüz kova, birleşik gecikmeyi olduğundan düşük gösterir.
 */
function weightedPercentile(weighted, samples, fallbackCount) {
  const denominator = samples == null ? Number(fallbackCount || 0) : Number(samples || 0);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Number(weighted || 0) / denominator;
}

/**
 * Kapanmış kovaları yazar.
 *
 * Yazma YARIDA kalabilir (veritabanı kesintisi, eksik şema). Bu yüzden işlev
 * hata FIRLATMAZ; hangi satırların yazılmadığını tam olarak bildirir ve çağıran
 * yalnızca onları yeniden kuyruklar. Yazılmış bir satırı yeniden göndermek,
 * MERGE sayıları TOPLADIĞI için çift sayıma yol açardı.
 *
 * Her satır kararlı bir `flushId` taşır: aynı satır yeniden denendiğinde MERGE
 * onu ikinci kez uygulamaz (bkz. telemetryQueries.js).
 *
 * @returns {Promise<{written: number, schemaReady: boolean,
 *   pending: {operations: Array, gauges: Array}, error: Error|null}>}
 */
export async function persistTelemetryBuckets(executor, { operations = [], gauges = [] } = {}) {
  const instanceId = applicationInstanceId();
  const pending = { operations: [...operations], gauges: [...gauges] };
  let written = 0;

  const writeOperation = async (row) => {
    const bucket = toDate(row.bucketStart);
    if (!bucket || !Number(row.count)) return false;
    const request = executor.request();
    request.input('bucketStart', sql.DateTime2, bucket);
    request.input('operation', sql.NVarChar(100), String(row.operation).slice(0, 100));
    request.input('instanceId', sql.VarChar(64), instanceId);
    request.input('sampleCount', sql.Int, Math.trunc(Number(row.count) || 0));
    request.input('errorCount', sql.Int, Math.trunc(Number(row.errorCount) || 0));
    request.input('durationSumMs', sql.BigInt, Math.round((Number(row.avgMs) || 0) * (Number(row.count) || 0)));
    request.input('durationMaxMs', sql.Int, roundOrNull(row.maxMs) ?? 0);
    request.input('p50Ms', sql.Int, roundOrNull(row.p50Ms));
    request.input('p95Ms', sql.Int, roundOrNull(row.p95Ms));
    request.input('p99Ms', sql.Int, roundOrNull(row.p99Ms));
    request.input('topFailureCode', sql.VarChar(60), row.topFailureCode ? String(row.topFailureCode).slice(0, 60) : null);
    request.input('flushId', sql.VarChar(64), flushIdentity(row, instanceId));
    await request.query(TELEMETRY_OPERATION_MERGE_SQL);
    return true;
  };

  const writeGauge = async (row) => {
    const bucket = toDate(row.bucketStart);
    if (!bucket || !Number(row.count)) return false;
    const request = executor.request();
    request.input('bucketStart', sql.DateTime2, bucket);
    request.input('metricKey', sql.VarChar(60), String(row.metricKey).slice(0, 60));
    request.input('instanceId', sql.VarChar(64), instanceId);
    request.input('sampleCount', sql.Int, Math.trunc(Number(row.count) || 0));
    request.input('valueAvg', sql.Float, Number(row.avg) || 0);
    request.input('valueMin', sql.Float, Number(row.min) || 0);
    request.input('valueMax', sql.Float, Number(row.max) || 0);
    request.input('flushId', sql.VarChar(64), flushIdentity(row, instanceId));
    await request.query(TELEMETRY_GAUGE_MERGE_SQL);
    return true;
  };

  // Satır ancak YAZILDIKTAN sonra bekleyenler listesinden düşer; hata anında
  // liste tam olarak yazılmayanları içerir.
  const drain = async (rows, write) => {
    while (rows.length) {
      const applied = await write(rows[0]);
      rows.shift();
      if (applied) written += 1;
    }
  };

  try {
    await drain(pending.operations, writeOperation);
    await drain(pending.gauges, writeGauge);
    return { written, schemaReady: true, pending: { operations: [], gauges: [] }, error: null };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { written, schemaReady: false, pending, error: null };
    return { written, schemaReady: true, pending, error };
  }
}

function seriesRow(row, bucketSeconds) {
  const count = Number(row.SampleCount || 0);
  const errorCount = Number(row.ErrorCount || 0);
  return {
    bucketStart: new Date(row.BucketStart).toISOString(),
    bucketSeconds,
    count,
    errorCount,
    errorRate: count > 0 ? errorCount / count : 0,
    avgMs: count > 0 ? Number(row.DurationSumMs || 0) / count : null,
    maxMs: row.DurationMaxMs == null ? null : Number(row.DurationMaxMs),
    p50Ms: weightedPercentile(row.P50Weighted, row.P50Samples, count),
    p95Ms: weightedPercentile(row.P95Weighted, row.P95Samples, count),
    p99Ms: weightedPercentile(row.P99Weighted, row.P99Samples, count),
    // Birden çok kaynak kovadan türetilen yüzdelik, birleşik örneklerin gerçek
    // yüzdeliği DEĞİLDİR; arayüz bunu yaklaşık olarak sunar.
    percentilesApproximate: Number(row.SourceRowCount || 0) > 1
  };
}

/** Zaman serisi. Şema yoksa boş seri ve `schemaReady: false` döner. */
export async function loadOperationSeries(executor, { since, until, bucketSeconds, operation = null }) {
  try {
    const request = executor.request();
    request.input('since', sql.DateTime2, alignedSince(since));
    request.input('until', sql.DateTime2, toDate(until));
    request.input('bucketSeconds', sql.Int, Math.max(60, Math.trunc(Number(bucketSeconds) || METRIC_BUCKET_MS / 1000)));
    request.input('operation', sql.NVarChar(100), operation ? String(operation).slice(0, 100) : null);
    const result = await request.query(TELEMETRY_OPERATION_SERIES_SQL);
    const seconds = Math.max(60, Math.trunc(Number(bucketSeconds) || METRIC_BUCKET_MS / 1000));
    return { schemaReady: true, series: (result.recordset || []).map((row) => seriesRow(row, seconds)) };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, series: [] };
    throw error;
  }
}

/** İşlem kırılımı (Yavaş İşlemler). */
export async function loadOperationBreakdown(executor, { since, until, limit = 25 }) {
  try {
    const request = executor.request();
    request.input('since', sql.DateTime2, alignedSince(since));
    request.input('until', sql.DateTime2, toDate(until));
    request.input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 25, 100)));
    const result = await request.query(TELEMETRY_OPERATION_BREAKDOWN_SQL);
    return {
      schemaReady: true,
      operations: (result.recordset || []).map((row) => {
        const count = Number(row.SampleCount || 0);
        const errorCount = Number(row.ErrorCount || 0);
        return {
          operation: String(row.Operation),
          count,
          errorCount,
          errorRate: count > 0 ? errorCount / count : 0,
          avgMs: count > 0 ? Number(row.DurationSumMs || 0) / count : null,
          maxMs: row.DurationMaxMs == null ? null : Number(row.DurationMaxMs),
          p50Ms: weightedPercentile(row.P50Weighted, row.P50Samples, count),
          p95Ms: weightedPercentile(row.P95Weighted, row.P95Samples, count),
          p99Ms: weightedPercentile(row.P99Weighted, row.P99Samples, count),
          percentilesApproximate: Number(row.SourceRowCount || 0) > 1,
          lastSeenAt: row.LastSeenAt ? new Date(row.LastSeenAt).toISOString() : null
        };
      })
    };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, operations: [] };
    throw error;
  }
}

/** Anlık ölçüm serileri; anahtar başına ayrı dizi döner. */
export async function loadGaugeSeries(executor, { since, until, bucketSeconds, metricKeys = [] }) {
  const keys = [...new Set(metricKeys.map((key) => String(key).trim()).filter(Boolean))];
  if (!keys.length) return { schemaReady: true, series: {} };
  try {
    const request = executor.request();
    request.input('since', sql.DateTime2, alignedSince(since));
    request.input('until', sql.DateTime2, toDate(until));
    request.input('bucketSeconds', sql.Int, Math.max(60, Math.trunc(Number(bucketSeconds) || METRIC_BUCKET_MS / 1000)));
    request.input('metricKeys', sql.NVarChar(500), keys.join(','));
    const result = await request.query(TELEMETRY_GAUGE_SERIES_SQL);
    const series = Object.fromEntries(keys.map((key) => [key, []]));
    for (const row of result.recordset || []) {
      const key = String(row.MetricKey);
      if (!series[key]) series[key] = [];
      const count = Number(row.SampleCount || 0);
      series[key].push({
        bucketStart: new Date(row.BucketStart).toISOString(),
        value: count > 0 ? Number(row.ValueWeighted || 0) / count : null,
        min: row.ValueMin == null ? null : Number(row.ValueMin),
        max: row.ValueMax == null ? null : Number(row.ValueMax),
        // Birden çok süreç yazdığında değer SÜREÇLER ARASI ortalamadır; tek bir
        // sürecin ölçüsü gibi okunmamalıdır.
        instanceCount: row.InstanceCount == null ? 1 : Number(row.InstanceCount)
      });
    }
    return { schemaReady: true, series };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, series: {} };
    throw error;
  }
}

/**
 * Saklama sınırının uygulanması.
 *
 * Her turda SINIRLI sayıda satır silinir; uzun bir tablo kilidi yerine birkaç
 * tur boyunca ilerleyen küçük silmeler yapılır.
 */
export async function applyTelemetryRetention(executor, { cutoff, batchSize = 5000 }) {
  const statements = [
    TELEMETRY_OPERATION_RETENTION_SQL,
    TELEMETRY_GAUGE_RETENTION_SQL
  ];
  let deleted = 0;
  try {
    for (const statement of statements) {
      const request = executor.request();
      request.input('cutoff', sql.DateTime2, toDate(cutoff));
      request.input('batchSize', sql.Int, Math.max(100, Math.min(Number(batchSize) || 5000, 50000)));
      const result = await request.query(statement);
      deleted += Number(result?.rowsAffected?.[0] || 0);
    }
    return { deleted, schemaReady: true };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { deleted, schemaReady: false };
    throw error;
  }
}

/** Seri satırlarını tek bir özete indirger (temel karşılaştırması için). */
export function summarizeSeries(series = []) {
  return mergeBucketSummaries(series.map((row) => ({
    count: row.count,
    errorCount: row.errorCount,
    avgMs: row.avgMs,
    maxMs: row.maxMs,
    p50Ms: row.p50Ms,
    p95Ms: row.p95Ms,
    p99Ms: row.p99Ms,
    percentilesApproximate: row.percentilesApproximate === true
  })));
}
