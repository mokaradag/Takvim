import 'server-only';
import {
  COMPONENTS,
  EVENT_SEVERITIES,
  alertKey
} from '../../domain/observability/eventModel.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { ALERT_CONSECUTIVE_OBSERVATIONS } from './observabilityConfig.js';

/**
 * Otomatik uyarı kuralları.
 *
 * Kurallar SAF işlevlerdir: bileşen sağlıkları ve ölçüm özetleri girer, uyarı
 * koşulları çıkar. Böylece eşiklerin davranışı veritabanı olmadan sınanabilir.
 *
 * Çırpınma (flapping) koruması ayrı bir izleyicidedir: bir koşul, uyarı
 * açılmadan önce üst üste birkaç turda görülmelidir; çözülme de aynı şekilde
 * birkaç temiz tur ister. Böylece sınırda gezinen bir ölçüm dakikada bir uyarı
 * açıp kapatmaz.
 */

/** Eşik uyarısı için gereken EN AZ örnek sayısı; birkaç istekten eğilim çıkarılmaz. */
export const MIN_SAMPLES_FOR_RATE_ALERT = 20;

function condition(component, code, severity, summary, { scope = null, detail = null, context = null } = {}) {
  return { key: alertKey(component, code, scope), component, code, scope, severity, summary, detail, context };
}

function byKey(components = []) {
  return new Map(components.map((component) => [component.key, component]));
}

/**
 * Bileşen sağlıklarından ve API özetinden uyarı koşullarını türetir.
 *
 * @returns {Array<{key: string, component: string, code: string, severity: string, summary: string}>}
 */
export function deriveAlertConditions({ components = [], apiSummary = null, thresholds = {} } = {}) {
  const map = byKey(components);
  const conditions = [];
  const add = (value) => { if (value) conditions.push(value); };

  const database = map.get(COMPONENTS.DATABASE);
  if (database?.state === HEALTH_STATES.CRITICAL) {
    add(condition(COMPONENTS.DATABASE, 'DATABASE_UNAVAILABLE', EVENT_SEVERITIES.CRITICAL, database.message));
  } else if (database?.state === HEALTH_STATES.WARNING) {
    add(condition(COMPONENTS.DATABASE, 'DATABASE_SLOW', EVENT_SEVERITIES.WARNING, database.message,
      { detail: `Yoklama süresi: ${database.durationMs ?? '—'} ms` }));
  }

  const authentication = map.get(COMPONENTS.AUTHENTICATION);
  if (authentication?.state === HEALTH_STATES.CRITICAL) {
    add(condition(COMPONENTS.AUTHENTICATION, 'AUTHENTICATION_MISCONFIGURED', EVENT_SEVERITIES.CRITICAL,
      authentication.message, { context: authentication.detail }));
  }

  const wbs = map.get(COMPONENTS.CORPORATE_WBS);
  if (wbs?.state === HEALTH_STATES.WARNING) {
    add(condition(COMPONENTS.CORPORATE_WBS, 'CORPORATE_WBS_STALE', EVENT_SEVERITIES.WARNING, wbs.message,
      { context: { lastSyncedAt: wbs.detail?.lastSyncedAt ?? null } }));
  } else if (wbs?.state === HEALTH_STATES.UNKNOWN) {
    add(condition(COMPONENTS.CORPORATE_WBS, 'CORPORATE_WBS_SYNC_FAILED', EVENT_SEVERITIES.WARNING, wbs.message));
  }

  const smtp = map.get(COMPONENTS.SMTP);
  if (smtp?.state === HEALTH_STATES.WARNING) {
    add(condition(COMPONENTS.SMTP, 'SMTP_CONFIG_INVALID', EVENT_SEVERITIES.WARNING, smtp.message));
  }

  const outlook = map.get(COMPONENTS.OUTLOOK);
  if (outlook && outlook.state !== HEALTH_STATES.HEALTHY && outlook.state !== HEALTH_STATES.NOT_CONFIGURED) {
    const queue = outlook.detail?.queue || {};
    const worker = outlook.detail?.worker || {};
    if (outlook.state === HEALTH_STATES.CRITICAL && !worker.started) {
      add(condition(COMPONENTS.OUTLOOK, 'OUTLOOK_WORKER_STALE', EVENT_SEVERITIES.CRITICAL, outlook.message));
    } else if (outlook.state === HEALTH_STATES.CRITICAL && Number(queue.exhausted || 0) > 0) {
      add(condition(COMPONENTS.OUTLOOK, 'OUTLOOK_DELIVERY_FAILED', EVENT_SEVERITIES.CRITICAL, outlook.message,
        { context: { exhausted: Number(queue.exhausted || 0) } }));
    } else if (outlook.state === HEALTH_STATES.CRITICAL) {
      add(condition(COMPONENTS.OUTLOOK, 'OUTLOOK_WORKER_STALE', EVENT_SEVERITIES.CRITICAL, outlook.message));
    } else if (Number(queue.failed || 0) > 0 && outlook.message.includes('hata')) {
      add(condition(COMPONENTS.OUTLOOK, 'OUTLOOK_DELIVERY_FAILED', EVENT_SEVERITIES.ERROR, outlook.message,
        { context: { failed: Number(queue.failed || 0) } }));
    } else if (outlook.state === HEALTH_STATES.WARNING) {
      add(condition(COMPONENTS.OUTLOOK, 'OUTLOOK_QUEUE_AGING', EVENT_SEVERITIES.WARNING, outlook.message,
        { context: { oldestUnattemptedAt: outlook.detail?.age?.oldestUnattemptedAt ?? null } }));
    }
  }

  const reminder = map.get(COMPONENTS.REMINDER);
  if (reminder?.state === HEALTH_STATES.WARNING && reminder.detail?.lastRun?.status === 'FAILED') {
    add(condition(COMPONENTS.REMINDER, 'REMINDER_RUN_FAILED', EVENT_SEVERITIES.ERROR, reminder.message,
      { context: { failureCode: reminder.detail.lastRun.failureCode } }));
  }

  const resources = map.get(COMPONENTS.RESOURCES);
  if (resources?.state === HEALTH_STATES.WARNING) {
    add(condition(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', EVENT_SEVERITIES.WARNING, resources.message));
  }

  if (apiSummary && Number(apiSummary.count || 0) >= MIN_SAMPLES_FOR_RATE_ALERT) {
    const errorRate = Number(apiSummary.errorRate ?? 0);
    if (Number.isFinite(errorRate) && errorRate > Number(thresholds.errorRate ?? 0.05)) {
      add(condition(COMPONENTS.API, 'API_ERROR_RATE_HIGH', EVENT_SEVERITIES.ERROR,
        `Son pencerede hata oranı %${(errorRate * 100).toFixed(1)}; eşik %${(Number(thresholds.errorRate ?? 0.05) * 100).toFixed(1)}.`,
        { context: { count: Number(apiSummary.count), errorCount: Number(apiSummary.errorCount || 0) } }));
    }
    const p95 = Number(apiSummary.p95Ms);
    if (Number.isFinite(p95) && p95 > Number(thresholds.latencyP95Ms ?? 1500)) {
      add(condition(COMPONENTS.API, 'API_LATENCY_HIGH', EVENT_SEVERITIES.WARNING,
        `P95 yanıt süresi ${Math.round(p95)} ms; eşik ${Math.round(Number(thresholds.latencyP95Ms ?? 1500))} ms.`,
        { context: { p95Ms: Math.round(p95), count: Number(apiSummary.count) } }));
    }
  }

  return conditions;
}

const TRACKER_KEY = Symbol.for('mergen-rota.alert-tracker');

function trackerState() {
  globalThis[TRACKER_KEY] ||= new Map();
  return globalThis[TRACKER_KEY];
}

export function resetAlertTrackerForTests() {
  globalThis[TRACKER_KEY] = new Map();
}

/**
 * Çırpınma koruması.
 *
 * Bir koşul art arda `requiredObservations` turda görülünce açılır; görülmediği
 * turlar sayılır ve aynı sayıya ulaşınca çözülür. Tek bir geçici ölçüm ne uyarı
 * açar ne de açık bir uyarıyı erken kapatır.
 *
 * @returns {{open: Array, resolve: Array, pending: Array}}
 */
export function evaluateAlertTransitions(conditions = [], { requiredObservations = ALERT_CONSECUTIVE_OBSERVATIONS } = {}) {
  const required = Math.max(1, Math.trunc(Number(requiredObservations) || 1));
  const state = trackerState();
  const seen = new Set();
  const open = [];
  const pending = [];

  for (const item of conditions) {
    seen.add(item.key);
    const entry = state.get(item.key) || { observations: 0, clean: 0, active: false };
    entry.observations += 1;
    entry.clean = 0;
    if (entry.active || entry.observations >= required) {
      entry.active = true;
      open.push(item);
    } else {
      pending.push(item);
    }
    state.set(item.key, entry);
  }

  const resolve = [];
  for (const [key, entry] of [...state.entries()]) {
    if (seen.has(key)) continue;
    entry.clean += 1;
    entry.observations = 0;
    if (entry.clean >= required) {
      if (entry.active) resolve.push(key);
      state.delete(key);
    } else {
      state.set(key, entry);
    }
  }

  return { open, resolve, pending };
}

/** Anahtardan bileşen ve kod bilgisini geri okur (çözme çağrısı için). */
export function parseAlertKey(key) {
  const [component, code, ...scope] = String(key || '').split(':');
  return { component, code, scope: scope.length ? scope.join(':') : null };
}
