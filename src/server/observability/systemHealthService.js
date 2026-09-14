import 'server-only';
import {
  ADMIN_TABS,
  COMPONENTS,
  componentTab,
  eventAction,
  normalizeSeverity,
  severityToHealthState,
  severityWeight
} from '../../domain/observability/eventModel.js';
import {
  HEALTH_STATES,
  describeComponent,
  summarizeHealth,
  worseHealthState
} from '../../domain/observability/healthModel.js';
import { GAUGE_KEYS, METRIC_BUCKET_MS, mergeBucketSummaries } from '../../domain/observability/metrics.js';
import {
  loadActiveAlertKeys,
  loadOperationalAlerts,
  resolveOperationalAlert,
  upsertOperationalAlert
} from './operationalEventsRepository.js';
import {
  deriveAlertConditions,
  deriveUnmeasuredAlertKeys,
  evaluateAlertTransitions,
  parseAlertKey
} from './alertRules.js';
import { MEMORY_PRESSURE_RATIO, observabilityConfiguration } from './observabilityConfig.js';
import {
  probeApplication,
  probeAuthentication,
  probeCorporateDirectory,
  probeCorporateWbs,
  probeDatabase,
  probeOutlook,
  probeReminders,
  probeResources,
  probeSmtp
} from './healthProbes.js';
import { recentFeed, registryStartedAt, snapshotGauges, snapshotOperations } from './telemetryRegistry.js';

/**
 * Sistem sağlığının derlenmesi.
 *
 * Genel bakış isteği HAFİFTİR: birkaç küçük yoklama sorgusu, dizinli bir uyarı
 * okuması ve BELLEKTEKİ ölçüm toplamları. Otuz günlük geçmiş yalnızca Performans
 * sekmesinde, daha seyrek yenilenen ayrı bir uçtan okunur.
 */

/** Genel bakışın ölçüm penceresi: son 15 dakika. */
export const OVERVIEW_WINDOW_MS = 15 * 60 * 1000;

/** API özetine giren işlem ön eki. */
const API_OPERATION_PREFIX = 'api.';

function apiRows(rows) {
  return rows.filter((row) => String(row.operation || '').startsWith(API_OPERATION_PREFIX));
}

/** Bellekteki kovalardan son pencerenin API özeti. */
export function summarizeApiWindow({ now = Date.now(), windowMs = OVERVIEW_WINDOW_MS } = {}) {
  const rows = apiRows(snapshotOperations({ sinceMs: now - windowMs }));
  return { ...mergeBucketSummaries(rows), windowMs, operations: rows.length };
}

/** Bellekteki kovaları grafik serisine çevirir (SQL'e gitmeden mini eğilim). */
export function memoryTrendSeries({ now = Date.now(), windowMs = 3 * 60 * 60 * 1000 } = {}) {
  const since = now - windowMs;
  const operations = apiRows(snapshotOperations({ sinceMs: since }));
  const byBucket = new Map();
  for (const row of operations) {
    if (!byBucket.has(row.bucketStart)) byBucket.set(row.bucketStart, []);
    byBucket.get(row.bucketStart).push(row);
  }
  const latency = [];
  const errorRate = [];
  for (const [bucket, rows] of [...byBucket.entries()].sort((left, right) => left[0] - right[0])) {
    const merged = mergeBucketSummaries(rows);
    const at = new Date(bucket).toISOString();
    latency.push({ bucketStart: at, value: merged.p95Ms });
    errorRate.push({ bucketStart: at, value: merged.errorRate });
  }
  const gauges = snapshotGauges({ sinceMs: since });
  const gaugeSeries = (metricKey) => gauges
    .filter((row) => row.metricKey === metricKey)
    .map((row) => ({ bucketStart: new Date(row.bucketStart).toISOString(), value: row.avg }));

  return {
    bucketMs: METRIC_BUCKET_MS,
    latencyP95: latency,
    errorRate,
    memory: gaugeSeries(GAUGE_KEYS.PROCESS_HEAP_USED),
    queueDepth: gaugeSeries(GAUGE_KEYS.OUTLOOK_QUEUE_PENDING)
  };
}

/**
 * Bütün bileşen yoklamalarını çalıştırır.
 *
 * Yoklamalar birbirini BEKLETMEZ ve biri hata verirse ötekiler yine sonuç
 * üretir: tek bir bağımlılığın kesintisi bütün sağlık tablosunu karartmaz.
 */
export async function loadSystemHealth(executor, { now = Date.now() } = {}) {
  const [database, directory, wbs, outlook, reminders] = await Promise.all([
    probeDatabase(executor, { now }),
    probeCorporateDirectory(executor, { now }),
    probeCorporateWbs(executor, { now }),
    probeOutlook(executor, { now }),
    probeReminders(executor, { now })
  ]);
  const components = [
    probeApplication({ startedAt: new Date(registryStartedAt()).toISOString() }),
    database,
    directory,
    wbs,
    probeAuthentication({ now }),
    probeSmtp({ now }),
    outlook,
    reminders,
    probeResources({ memoryPressureRatio: MEMORY_PRESSURE_RATIO })
  ].map((component) => describeComponent(component, { now }));

  return { ...summarizeHealth(components), components, generatedAt: new Date(now).toISOString() };
}

/**
 * Uyarıları değerlendirir: koşul açılır/güncellenir, düzelen koşul çözülür.
 *
 * Çözme, koşulun geçerli yenilemede GÖRÜNMEMESİNE değil, art arda temiz
 * gözlemlere dayanır (bkz. alertRules.js).
 */
export async function evaluateSystemAlerts(executor, { components = [], apiSummary = null, now = new Date() } = {}) {
  const { thresholds } = observabilityConfiguration();
  const conditions = deriveAlertConditions({ components, apiSummary, thresholds });
  // Kalıcı açık küme izleyiciye tohumlanır: süreç yeniden başladığında bile
  // düzelen bir koşul çözüm anahtarını üretebilmelidir.
  const active = await loadActiveAlertKeys(executor);
  const { open, resolve, pending } = evaluateAlertTransitions(conditions, {
    activeKeys: active.keys,
    unmeasuredKeys: deriveUnmeasuredAlertKeys({ components, apiSummary })
  });
  const opened = [];
  const resolved = [];

  for (const item of open) {
    const result = await upsertOperationalAlert(executor, {
      component: item.component,
      code: item.code,
      scope: item.scope,
      severity: item.severity,
      summary: item.summary,
      detail: item.detail,
      context: item.context,
      observedAt: now
    });
    if (!result.schemaReady) return { schemaReady: false, opened, resolved, pending: pending.length };
    if (result.created) opened.push(item.key);
  }

  for (const key of resolve) {
    const parsed = parseAlertKey(key);
    const result = await resolveOperationalAlert(executor, {
      component: parsed.component,
      code: parsed.code,
      scope: parsed.scope,
      resolvedAt: now
    });
    if (!result.schemaReady) return { schemaReady: false, opened, resolved, pending: pending.length };
    if (result.resolved) resolved.push(key);
  }

  return { schemaReady: true, opened, resolved, pending: pending.length };
}

function alertToAttentionItem(alert) {
  return {
    id: `alert-${alert.id}`,
    kind: 'ALERT',
    alertId: alert.id,
    severity: alert.severity,
    component: alert.component,
    code: alert.code,
    summary: alert.summary,
    detail: alert.detail,
    occurrenceCount: alert.occurrenceCount,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    active: alert.state !== 'RESOLVED',
    state: alert.state,
    action: alert.action || eventAction(alert.code),
    tab: componentTab(alert.component)
  };
}

function componentToAttentionItem(component) {
  const severity = component.state === HEALTH_STATES.CRITICAL ? 'CRITICAL' : 'WARNING';
  return {
    id: `component-${component.key}`,
    kind: 'COMPONENT',
    alertId: null,
    severity,
    component: component.key,
    code: null,
    summary: `${component.label}: ${component.message}`,
    detail: null,
    occurrenceCount: 1,
    firstSeenAt: component.lastCheckedAt,
    lastSeenAt: component.lastCheckedAt,
    active: true,
    state: 'OPEN',
    action: null,
    tab: component.tab || ADMIN_TABS.OVERVIEW
  };
}

/**
 * "Dikkat Gerektirenler" listesi.
 *
 * Kalıcı uyarılar önceliklidir; henüz uyarıya dönüşmemiş (çırpınma koruması
 * nedeniyle bekleyen) sağlıksız bileşenler de gösterilir ki yönetici sorunu
 * uyarı eşiğinden önce görebilsin. Sıralama ağırlık, sonra tazelik.
 */
export function buildAttentionItems({ alerts = [], components = [] } = {}) {
  const items = alerts.filter((alert) => alert.state !== 'RESOLVED').map(alertToAttentionItem);
  // Kapsama, BİLEŞEN ADINA değil AĞIRLIĞA göre belirlenir: Outlook'un açık bir
  // kuyruk uyarısı varken çalışanı kritiğe düşerse, ilgisiz uyarı kritik
  // bileşen satırını gizlememelidir.
  const coveredWeight = new Map();
  for (const item of items) {
    const weight = severityWeight(item.severity);
    coveredWeight.set(item.component, Math.max(coveredWeight.get(item.component) ?? 0, weight));
  }
  for (const component of components) {
    if (component.state !== HEALTH_STATES.CRITICAL && component.state !== HEALTH_STATES.WARNING) continue;
    const item = componentToAttentionItem(component);
    if (severityWeight(item.severity) <= (coveredWeight.get(component.key) ?? 0)) continue;
    items.push(item);
  }
  return items.sort((left, right) => {
    const weight = severityWeight(right.severity) - severityWeight(left.severity);
    if (weight !== 0) return weight;
    return new Date(right.lastSeenAt || 0).getTime() - new Date(left.lastSeenAt || 0).getTime();
  });
}

/**
 * Genel bakış yanıtını derler.
 *
 * Uyarılar okunamazsa sağlık tablosu YİNE gösterilir; eksik parça açıkça
 * "bilinmiyor" olarak işaretlenir, sessizce sağlıklı sayılmaz.
 */
export async function loadSystemOverview(executor, { now = Date.now() } = {}) {
  const health = await loadSystemHealth(executor, { now });
  const apiSummary = summarizeApiWindow({ now });
  const alertResult = await loadOperationalAlerts(executor, {
    activeOnly: true,
    since: new Date(now - 7 * 24 * 60 * 60 * 1000),
    limit: 50
  });

  const alertSeverityState = alertResult.alerts.reduce(
    (state, alert) => worseHealthState(state, severityToHealthState(normalizeSeverity(alert.severity))),
    HEALTH_STATES.HEALTHY
  );

  return {
    generatedAt: health.generatedAt,
    // Genel durum, bileşen sağlıkları İLE açık uyarıların ağırlığından türetilir.
    state: worseHealthState(health.state, alertSeverityState),
    counts: health.counts,
    components: health.components,
    attention: buildAttentionItems({ alerts: alertResult.alerts, components: health.components }),
    alertsSchemaReady: alertResult.schemaReady,
    api: apiSummary,
    trends: memoryTrendSeries({ now }),
    feed: recentFeed(15),
    outlook: health.components.find((component) => component.key === COMPONENTS.OUTLOOK)?.detail || null
  };
}
