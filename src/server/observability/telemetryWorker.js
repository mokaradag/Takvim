import 'server-only';
import { COMPONENTS, EVENT_SEVERITIES } from '../../domain/observability/eventModel.js';
import { GAUGE_KEYS } from '../../domain/observability/metrics.js';
import { getSqlPool } from '../db/pool.js';
import { logEvent } from './structuredLogger.js';
import { newCorrelationId, withCorrelation } from './correlation.js';
import { isTelemetryEnabled, RETENTION_BATCH_SIZE, TELEMETRY_FLUSH_INTERVAL_MS, telemetryRetentionDays } from './observabilityConfig.js';
import {
  consumeTelemetryLossCounters,
  drainClosedBuckets,
  recordGauge,
  spoolUnpersistedBuckets
} from './telemetryRegistry.js';
import { applyTelemetryRetention, persistTelemetryBuckets } from './telemetryRepository.js';
import {
  applyOperationalRetention,
  drainOperationalEvents,
  persistOperationalEvents,
  queueOperationalEvent,
  restoreOperationalEvents,
  restoreDroppedEventCount
} from './operationalEventsRepository.js';
import { readResourceMetrics, resetEventLoopSample, startResourceMonitoring } from './resourceMetrics.js';
import { evaluateSystemAlerts, loadSystemHealth, summarizeApiWindow } from './systemHealthService.js';
import { sanitizeError } from '../../domain/observability/redaction.js';
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
const MAX_RETENTION_BATCHES = 20;
const RETENTION_BUDGET_MS = 5000;

function sampleResources(now = Date.now()) {
  // CPU temel okumasının SAHİBİ bu zamanlanmış örneklemedir; sağlık yoklaması
  // ve yönetim isteği temeli ilerletmez (bkz. resourceMetrics.js).
  const metrics = readResourceMetrics(now, { sampleCpu: true });
  if (metrics.rss.available) recordGauge(GAUGE_KEYS.PROCESS_RSS, metrics.rss.value, now);
  if (metrics.heapUsed.available) recordGauge(GAUGE_KEYS.PROCESS_HEAP_USED, metrics.heapUsed.value, now);
  if (metrics.heapUsedRatio.available) recordGauge(GAUGE_KEYS.PROCESS_HEAP_RATIO, metrics.heapUsedRatio.value, now);
  if (metrics.cpuPercent.available) recordGauge(GAUGE_KEYS.PROCESS_CPU, metrics.cpuPercent.value, now);
  if (metrics.eventLoopDelayMs.available) recordGauge(GAUGE_KEYS.EVENT_LOOP_DELAY, metrics.eventLoopDelayMs.value, now);
  resetEventLoopSample();
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

/**
 * Sınır aşımından yitirilen telemetriyi bildirir.
 *
 * Kayıp SAYILIR ve tek bir işletim olayına dönüşür: yönetici, ekrandaki
 * geçmişin eksik olduğunu ancak bu kayıttan anlayabilir. Kayıp yoksa hiçbir
 * olay üretilmez — sağlıklı sistem sessizdir.
 *
 * @returns {number} bu turda yitirilen kayıt sayısı
 */
function reportTelemetryLoss({ droppedEvents = 0 } = {}) {
  const counters = consumeTelemetryLossCounters({ reset: false });
  const total = Number(droppedEvents || 0)
    + counters.droppedOperations + counters.droppedBuckets + counters.droppedSpoolRows;
  if (total <= 0) return 0;
  const accepted = queueOperationalEvent({
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.APPLICATION,
    code: 'TELEMETRY_DATA_DROPPED',
    detail: 'Sınır aşıldığı için bir bölüm telemetri kaydedilemedi; geçmişte boşluk olabilir.',
    context: {
      droppedEvents: Number(droppedEvents || 0),
      droppedOperations: counters.droppedOperations,
      droppedBuckets: counters.droppedBuckets,
      droppedSpoolRows: counters.droppedSpoolRows
    }
  });
  if (!accepted) {
    restoreDroppedEventCount(droppedEvents);
    return 0;
  }
  consumeTelemetryLossCounters();
  return total;
}

/** Tek bir telemetri turu. Testler bunu doğrudan çağırır. */
export async function runTelemetryCycle({
  pool = null,
  now = Date.now(),
  retentionDueAt = 0
} = {}) {
  if (!isTelemetryEnabled()) return { ok: true, enabled: false };
  const summary = { ok: true, enabled: true, persisted: 0, events: 0, opened: 0, resolved: 0, retentionRan: false, schemaReady: true };
  const fail = (phase, error) => {
    summary.ok = false;
    summary.reason = 'TELEMETRY_CYCLE_FAILED';
    (summary.failures ||= []).push({ phase, error: sanitizeError(error) });
  };
  const attempt = async (phase, work, fallback) => {
    try { return await work(); } catch (error) { fail(phase, error); return fallback; }
  };
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

  const health = await attempt('health', () => loadSystemHealth(executor, { now }), { state: HEALTH_STATES.UNKNOWN, components: [] });
  summary.healthState = health.state;
  sampleQueueGauges(health.components, now);

  // API özeti KAPANMIŞ kovalar bellekten düşürülmeden önce alınır: boşaltma
  // kovaları sildikten sonra okunan özet, penceredeki hataları ve gecikmeleri
  // görmez ve `API_ERROR_RATE_HIGH` / `API_LATENCY_HIGH` hiç açılmazdı.
  const apiSummary = summarizeApiWindow({ now });

  const drained = drainClosedBuckets(now);
  const persisted = await attempt('telemetry', () => persistTelemetryBuckets(executor, drained),
    { written: 0, schemaReady: true, pending: drained });
  summary.persisted = persisted.written;
  summary.schemaReady = persisted.schemaReady;
  // Yazılamayan satırlar SINIRLI yeniden deneme kuyruğunda kalır: bir
  // veritabanı kesintisi 30 günlük geçmişte sessiz bir boşluk bırakmamalıdır.
  const spooled = spoolUnpersistedBuckets(persisted.pending);
  summary.spooled = spooled.operations + spooled.gauges;

  const { events, dropped: droppedEvents } = drainOperationalEvents();
  let eventError = null;
  if (events.length) {
    const written = await attempt('events', () => persistOperationalEvents(executor, events),
      { written: 0, schemaReady: true, pending: events });
    summary.events = written.written;
    summary.schemaReady = summary.schemaReady && written.schemaReady;
    // Yazılamayan olaylar KUYRUKTA kalır; kesinti sonrasında gereken olay
    // kayıtları kaybolmaz.
    if (written.pending.length) summary.pendingEvents = restoreOperationalEvents(written.pending);
    eventError = written.error;
  }

  // Sınır aşımından YİTİRİLEN telemetri sessizce geçmez; eksik geçmiş, konsolda
  // açık bir kayıt olarak görünür.
  summary.droppedTelemetry = reportTelemetryLoss({ droppedEvents });

  if (persisted.error) fail('telemetry', persisted.error);
  if (eventError) fail('events', eventError);

  const alerts = await attempt('alerts', () => evaluateSystemAlerts(executor, {
    components: health.components,
    apiSummary,
    now: new Date(now)
  }), null);
  if (alerts) {
    summary.opened = alerts.opened.length;
    summary.resolved = alerts.resolved.length;
    summary.schemaReady = summary.schemaReady && alerts.schemaReady !== false;
  }

  if (now >= retentionDueAt) {
    const cutoff = new Date(now - telemetryRetentionDays() * 24 * 60 * 60 * 1000);
    const startedAt = Date.now();
    summary.retentionComplete = false;
    summary.retentionDeleted = 0;
    for (let batch = 0; batch < MAX_RETENTION_BATCHES; batch += 1) {
      const telemetry = await attempt('telemetry-retention', () => applyTelemetryRetention(executor, { cutoff, batchSize: RETENTION_BATCH_SIZE }), null);
      const operational = await attempt('event-retention', () => applyOperationalRetention(executor, { cutoff, batchSize: RETENTION_BATCH_SIZE }), null);
      if (!telemetry || !operational) break;
      summary.retentionDeleted += telemetry.deleted + operational.deleted;
      summary.schemaReady = summary.schemaReady && telemetry.schemaReady && operational.schemaReady;
      if (!telemetry.schemaReady || !operational.schemaReady) break;
      if (telemetry.deleted + operational.deleted === 0) {
        summary.retentionComplete = true;
        break;
      }
      if (Date.now() - startedAt >= RETENTION_BUDGET_MS) break;
    }
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
        if (result?.retentionRan && result.retentionComplete) retentionDueAt = Date.now() + RETENTION_INTERVAL_MS;
        if (result?.ok === false) {
          log({
            severity: EVENT_SEVERITIES.WARNING, component: COMPONENTS.APPLICATION,
            operation: 'telemetry.cycle', code: result.reason || 'TELEMETRY_CYCLE_FAILED',
            message: 'Telemetri turu sorun bildirdi.', context: { failures: result.failures || [] }
          });
        }
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

/**
 * Testler için çalışanı durdurur ve tekil örneği temizler.
 *
 * Durdurma BEKLENİR: yalnızca tekil örneği silmek, çalışan kapanışının hâlâ
 * `started = true` görmesine ve sonraki testler sırasında SQL çalıştırıp yeni
 * turlar zamanlamasına yol açardı.
 */
export async function resetTelemetryWorkerForTests() {
  const worker = globalThis[WORKER_KEY];
  globalThis[WORKER_KEY] = undefined;
  if (worker?.stop) await worker.stop();
}
