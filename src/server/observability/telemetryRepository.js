import 'server-only';
import { sql } from '../db/pool.js';
import { METRIC_BUCKET_MS, mergeBucketSummaries } from '../../domain/observability/metrics.js';
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
const TELEMETRY_OBJECTS = /(?<![\p{L}\p{N}_@$#])(?:MR_TelemetryOperationSamples|MR_TelemetryGaugeSamples|MR_OperationalEvents|MR_OperationalAlerts)(?![\p{L}\p{N}_@$#])/iu;

export function isMissingTelemetrySchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry
    && (MISSING_SCHEMA_CODES.has(Number(entry.number)) || /Invalid object name/i.test(String(entry.message || '')))
    && TELEMETRY_OBJECTS.test(String(entry.message || '')));
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(Number(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roundOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

/**
 * Kapanmış kovaları yazar.
 *
 * @returns {Promise<{written: number, schemaReady: boolean}>}
 */
export async function persistTelemetryBuckets(executor, { operations = [], gauges = [] } = {}) {
  let written = 0;
  try {
    for (const row of operations) {
      const bucket = toDate(row.bucketStart);
      if (!bucket || !Number(row.count)) continue;
      const request = executor.request();
      request.input('bucketStart', sql.DateTime2, bucket);
      request.input('operation', sql.NVarChar(100), String(row.operation).slice(0, 100));
      request.input('sampleCount', sql.Int, Math.trunc(Number(row.count) || 0));
      request.input('errorCount', sql.Int, Math.trunc(Number(row.errorCount) || 0));
      request.input('durationSumMs', sql.BigInt, Math.round((Number(row.avgMs) || 0) * (Number(row.count) || 0)));
      request.input('durationMaxMs', sql.Int, roundOrNull(row.maxMs) ?? 0);
      request.input('p50Ms', sql.Int, roundOrNull(row.p50Ms));
      request.input('p95Ms', sql.Int, roundOrNull(row.p95Ms));
      request.input('p99Ms', sql.Int, roundOrNull(row.p99Ms));
      request.input('topFailureCode', sql.VarChar(60), row.topFailureCode ? String(row.topFailureCode).slice(0, 60) : null);
      await request.query(TELEMETRY_OPERATION_MERGE_SQL);
      written += 1;
    }
    for (const row of gauges) {
      const bucket = toDate(row.bucketStart);
      if (!bucket || !Number(row.count)) continue;
      const request = executor.request();
      request.input('bucketStart', sql.DateTime2, bucket);
      request.input('metricKey', sql.VarChar(60), String(row.metricKey).slice(0, 60));
      request.input('sampleCount', sql.Int, Math.trunc(Number(row.count) || 0));
      request.input('valueAvg', sql.Float, Number(row.avg) || 0);
      request.input('valueMin', sql.Float, Number(row.min) || 0);
      request.input('valueMax', sql.Float, Number(row.max) || 0);
      await request.query(TELEMETRY_GAUGE_MERGE_SQL);
      written += 1;
    }
    return { written, schemaReady: true };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { written, schemaReady: false };
    throw error;
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
    p50Ms: count > 0 ? Number(row.P50Weighted || 0) / count : null,
    p95Ms: count > 0 ? Number(row.P95Weighted || 0) / count : null,
    p99Ms: count > 0 ? Number(row.P99Weighted || 0) / count : null
  };
}

/** Zaman serisi. Şema yoksa boş seri ve `schemaReady: false` döner. */
export async function loadOperationSeries(executor, { since, until, bucketSeconds, operation = null }) {
  try {
    const request = executor.request();
    request.input('since', sql.DateTime2, toDate(since));
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
    request.input('since', sql.DateTime2, toDate(since));
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
          p50Ms: count > 0 ? Number(row.P50Weighted || 0) / count : null,
          p95Ms: count > 0 ? Number(row.P95Weighted || 0) / count : null,
          p99Ms: count > 0 ? Number(row.P99Weighted || 0) / count : null,
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
    request.input('since', sql.DateTime2, toDate(since));
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
        max: row.ValueMax == null ? null : Number(row.ValueMax)
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
    p99Ms: row.p99Ms
  })));
}
