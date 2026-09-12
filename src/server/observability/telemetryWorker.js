import 'server-only';
import { COMPONENTS, EVENT_SEVERITIES } from '../../domain/observability/eventModel.js';
import { GAUGE_KEYS } from '../../domain/observability/metrics.js';
import { getSqlPool } from '../db/pool.js';
import { logEvent } from './structuredLogger.js';
import { newCorrelationId, withCorrelation } from './correlation.js';
import { isTelemetryEnabled, RETENTION_BATCH_SIZE, TELEMETRY_FLUSH_INTERVAL_MS, telemetryRetentionDays } from './observabilityConfig.js';
import { drainClosedBuckets, recordGauge } from './telemetryRegistry.js';
import { applyTelemetryRetention, persistTelemetryBuckets } from './telemetryRepository.js';
import {
  applyOperationalRetention,
  drainOperationalEvents,
  persistOperationalEvents,
  queueOperationalEvent
} from './operationalEventsRepository.js';
import { readResourceMetrics, startResourceMonitoring } from './resourceMetrics.js';
import { evaluateSystemAlerts, loadSystemHealth, summarizeApiWindow } from './systemHealthService.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';

/**
 * Telemetri turu.
 *
 * Süreç içinde tek bir zamanlayıcı çalışır ve her turda sırayla:
 *   1. kaynak ölçümlerini örnekler,
 *   2. KAPANMIŞ toplam kovalarını kalıcılaştırır,
 *   3. bekleyen işletim olaylarını yazar,
 *   4. sağlık yoklamalarını çalıştırıp uyarıları günceller,
 *   5. saatte bir saklama sınırını uygular.
 *
 * Tur HİÇBİR koşulda yukarı hata taşımaz; başarısız bir tur yalnızca günlüğe
 * yazılır ve bir sonraki tur normal sürer. Gözlemlenebilirlik, gözlediği
 * uygulamayı düşüremez.
 */

const WORKER_KEY = Symbol.for('mergen-rota.telemetry-worker');
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

function sampleResources(now = Date.now()) {
  const metrics = readResourceMetrics(now);
  if (metrics.rss.available) recordGauge(GAUGE_KEYS.PROCESS_RSS, metrics.rss.value, now);
  if (metrics.heapUsed.available) recordGauge(GAUGE_KEYS.PROCESS_HEAP_USED, metrics.heapUsed.value, now);
  if (metrics.heapUsedRatio.available) recordGauge(GAUGE_KEYS.PROCESS_HEAP_RATIO, metrics.heapUsedRatio.value, now);
  if (metrics.cpuPercent.available) recordGauge(GAUGE_KEYS.PROCESS_CPU, metrics.cpuPercent.value, now);
  if (metrics.eventLoopDelayMs.available) recordGauge(GAUGE_KEYS.EVENT_LOOP_DELAY, metrics.eventLoopDelayMs.value, now);
  return metrics;
}

function sampleQueueGauges(components, now = Date.now()) {
  const outlook = components.find((component) => component.key === COMPONENTS.OUTLOOK);
  const queue = outlook?.detail?.queue;
  if (!queue) return;
  recordGauge(GAUGE_KEYS.OUTLOOK_QUEUE_PENDING, Number(queue.pending || 0), now);
  recordGauge(GAUGE_KEYS.OUTLOOK_QUEUE_FAILED, Number(queue.failed || 0), now);
  const oldest = outlook?.detail?.age?.oldestUnattemptedAt;
  if (oldest) {
    const minutes = Math.max(0, (now - new Date(oldest).getTime()) / 60000);
    if (Number.isFinite(minutes)) recordGauge(GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES, minutes, now);
  } else {
    recordGauge(GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES, 0, now);
  }
}

/** Tek bir telemetri turu. Testler bunu doğrudan çağırır. */
export async function runTelemetryCycle({
  pool = null,
  now = Date.now(),
  retentionDueAt = 0
} = {}) {
  if (!isTelemetryEnabled()) return { ok: true, enabled: false };
  const summary = { ok: true, enabled: true, persisted: 0, events: 0, opened: 0, resolved: 0, retentionRan: false, schemaReady: true };
  sampleResources(now);

  let executor = pool;
  if (!executor) {
    try {
      executor = await getSqlPool();
    } catch {
      // Veritabanı erişilemiyorken tur, BELLEK ölçümlerini toplamaya devam
      // eder; kalıcılaştırma bir sonraki tura ertelenir.
      return { ...summary, ok: false, reason: 'DATABASE_UNAVAILABLE' };
    }
  }

  const health = await loadSystemHealth(executor, { now });
  sampleQueueGauges(health.components, now);

  const drained = drainClosedBuckets(now);
  const persisted = await persistTelemetryBuckets(executor, drained);
  summary.persisted = persisted.written;
  summary.schemaReady = persisted.schemaReady;

  const { events } = drainOperationalEvents();
  if (events.length) {
    const written = await persistOperationalEvents(executor, events);
    summary.events = written.written;
    summary.schemaReady = summary.schemaReady && written.schemaReady;
  }

  const alerts = await evaluateSystemAlerts(executor, {
    components: health.components,
    apiSummary: summarizeApiWindow({ now }),
    now: new Date(now)
  });
  summary.opened = alerts.opened.length;
  summary.resolved = alerts.resolved.length;
  summary.schemaReady = summary.schemaReady && alerts.schemaReady !== false;

  if (now >= retentionDueAt) {
    const cutoff = new Date(now - telemetryRetentionDays() * 24 * 60 * 60 * 1000);
    await applyTelemetryRetention(executor, { cutoff, batchSize: RETENTION_BATCH_SIZE });
    await applyOperationalRetention(executor, { cutoff, batchSize: RETENTION_BATCH_SIZE });
    summary.retentionRan = true;
  }

  summary.healthState = health.state;
  return summary;
}

export function createTelemetryWorker({
  run = runTelemetryCycle,
  intervalMs = TELEMETRY_FLUSH_INTERVAL_MS,
  log = (record) => logEvent(record)
} = {}) {
  let started = false;
  let timer = null;
  let running = null;
  let retentionDueAt = 0;
  let lastFinishedAt = null;
  let lastResult = null;

  const schedule = (delay) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = () => {
    timer = null;
    if (!started || running) return;
    const now = Date.now();
    running = withCorrelation({ correlationId: newCorrelationId(), operation: 'telemetry.cycle' },
      () => Promise.resolve().then(() => run({ now, retentionDueAt })))
      .then((result) => {
        if (result?.retentionRan) retentionDueAt = Date.now() + RETENTION_INTERVAL_MS;
        lastResult = result;
        lastFinishedAt = new Date().toISOString();
        if (result?.healthState === HEALTH_STATES.CRITICAL) {
          log({
            severity: EVENT_SEVERITIES.WARNING,
            component: COMPONENTS.APPLICATION,
            operation: 'telemetry.cycle',
            code: 'SYSTEM_HEALTH_CRITICAL',
            message: 'Sistem sağlığı kritik olarak değerlendirildi.'
          });
        }
      })
      .catch((error) => {
        lastResult = { ok: false, reason: 'TELEMETRY_CYCLE_FAILED' };
        lastFinishedAt = new Date().toISOString();
        log({
          severity: EVENT_SEVERITIES.WARNING,
          component: COMPONENTS.APPLICATION,
          operation: 'telemetry.cycle',
          code: 'TELEMETRY_CYCLE_FAILED',
          message: 'Telemetri turu tamamlanamadı.',
          error
        });
      })
      .finally(() => {
        running = null;
        if (started) schedule(intervalMs);
      });
  };

  return {
    start() {
      if (!started) { started = true; schedule(intervalMs); }
      return this;
    },
    async stop() {
      started = false;
      clearTimeout(timer);
      timer = null;
      await running;
    },
    status() {
      return { started, running: Boolean(running), intervalMs, lastFinishedAt, lastResult };
    }
  };
}

export function startTelemetryWorker() {
  if (!isTelemetryEnabled()) return null;
  if (!globalThis[WORKER_KEY]) {
    globalThis[WORKER_KEY] = createTelemetryWorker();
    startResourceMonitoring();
    queueOperationalEvent({
      severity: EVENT_SEVERITIES.INFO,
      component: COMPONENTS.APPLICATION,
      code: 'APP_STARTED',
      detail: `Süreç başlatıldı. Çalışma zamanı: ${typeof process.version === 'string' ? process.version : 'bilinmiyor'}.`
    });
  }
  return globalThis[WORKER_KEY].start();
}

export function telemetryWorkerStatus() {
  return globalThis[WORKER_KEY]?.status() || {
    started: false, running: false, intervalMs: TELEMETRY_FLUSH_INTERVAL_MS, lastFinishedAt: null, lastResult: null
  };
}

export function resetTelemetryWorkerForTests() {
  globalThis[WORKER_KEY] = undefined;
}
