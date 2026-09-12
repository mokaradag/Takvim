import { safeErrorResponse } from '../../../../../../server/errors.js';
import { loadSystemAdminContext } from '../../../../../../server/observability/adminRequestContext.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';
import { readResourceMetrics } from '../../../../../../server/observability/resourceMetrics.js';
import {
  loadGaugeSeries,
  loadOperationBreakdown,
  loadOperationSeries,
  summarizeSeries
} from '../../../../../../server/observability/telemetryRepository.js';
import { summarizeApiWindow } from '../../../../../../server/observability/systemHealthService.js';
import { observabilityConfiguration } from '../../../../../../server/observability/observabilityConfig.js';
import {
  BASELINE_MIN_SAMPLES,
  GAUGE_KEYS,
  compareToBaseline,
  timeRange
} from '../../../../../../domain/observability/metrics.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GAUGE_SERIES_KEYS = [
  GAUGE_KEYS.PROCESS_HEAP_USED,
  GAUGE_KEYS.PROCESS_RSS,
  GAUGE_KEYS.PROCESS_CPU,
  GAUGE_KEYS.EVENT_LOOP_DELAY,
  GAUGE_KEYS.OUTLOOK_QUEUE_PENDING,
  GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES
];

/**
 * Sistem Yönetimi · Performans.
 *
 * Zaman aralığı SUNUCUDA sınırlanır: istemciden gelen serbest bir aralık
 * değeri kabul edilmez, yalnızca tanımlı dört pencereden biri kullanılır.
 * Böylece sorgu maliyeti öngörülebilir kalır.
 */
export const GET = withRouteObservability('api.admin.system.performance', async (request) => {
  try {
    const { pool } = await loadSystemAdminContext();
    const url = new URL(request.url, 'http://mergen-rota.invalid');
    const range = timeRange(url.searchParams.get('range'));
    const now = Date.now();
    const since = new Date(now - range.durationMs);
    const until = new Date(now);
    const bucketSeconds = Math.round(range.bucketMs / 1000);

    const [series, breakdown, gauges, baselineSeries] = await Promise.all([
      loadOperationSeries(pool, { since, until, bucketSeconds }),
      loadOperationBreakdown(pool, { since, until, limit: 25 }),
      loadGaugeSeries(pool, { since, until, bucketSeconds, metricKeys: GAUGE_SERIES_KEYS }),
      loadOperationSeries(pool, {
        since: new Date(now - BASELINE_WINDOW_MS),
        until,
        bucketSeconds: 6 * 3600
      })
    ]);

    const summary = summarizeSeries(series.series);
    const baseline = summarizeSeries(baselineSeries.series);

    return Response.json({
      ok: true,
      range: { id: range.id, label: range.label, durationMs: range.durationMs, bucketMs: range.bucketMs },
      // Kalıcı şema yoksa grafik "veri yok" DEĞİL, "ölçüm henüz toplanmıyor"
      // olarak gösterilir: eksik yükseltme sessizce sağlıklı görünmemelidir.
      schemaReady: series.schemaReady && breakdown.schemaReady && gauges.schemaReady,
      configuration: observabilityConfiguration(),
      summary,
      baseline: {
        windowMs: BASELINE_WINDOW_MS,
        minSamples: BASELINE_MIN_SAMPLES,
        p95: compareToBaseline(summary.p95Ms, baseline.p95Ms, { baselineSamples: baseline.count }),
        errorRate: compareToBaseline(summary.errorRate, baseline.errorRate, { baselineSamples: baseline.count }),
        sampleCount: baseline.count
      },
      series: series.series,
      operations: breakdown.operations,
      gauges: gauges.series,
      // Güncel pencere henüz kalıcılaştırılmamış olabilir; bellekteki toplam
      // "şu anda ne oluyor" sorusunu yanıtlar.
      live: summarizeApiWindow({ now }),
      resources: readResourceMetrics(now)
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
