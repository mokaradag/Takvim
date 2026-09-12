import 'server-only';
import { sql } from '../db/pool.js';
import {
  ALERT_STATES,
  COMPONENTS,
  EVENT_SEVERITIES,
  alertKey as buildAlertKey,
  eventAction,
  eventSummary,
  normalizeSeverity
} from '../../domain/observability/eventModel.js';
import { sanitizeContext, sanitizeText } from '../../domain/observability/redaction.js';
import { recordFeedEntry } from './telemetryRegistry.js';
import { currentCorrelationId } from './correlation.js';
import { isMissingTelemetrySchema } from './telemetryRepository.js';
import {
  OPERATIONAL_ALERT_ACKNOWLEDGE_SQL,
  OPERATIONAL_ALERT_LIST_SQL,
  OPERATIONAL_ALERT_RESOLVE_SQL,
  OPERATIONAL_ALERT_RETENTION_SQL,
  OPERATIONAL_ALERT_UPSERT_SQL,
  OPERATIONAL_EVENT_INSERT_SQL,
  OPERATIONAL_EVENT_PAGE_SQL,
  OPERATIONAL_EVENT_RETENTION_SQL
} from './telemetryQueries.js';

/**
 * İşletim olayları ve uyarıların kalıcı katmanı.
 *
 * Olaylar önce SINIRLI bir bellek kuyruğunda toplanır; kalıcılaştırma turu
 * aynı olayı tek satırda birleştirerek yazar. Sekiz yüz özdeş SMTP hatası, sekiz
 * yüz satır değil, sayacı sekiz yüz olan tek bir satır üretir.
 */

const MAX_PENDING_EVENTS = 200;
const MAX_DETAIL_LENGTH = 1000;
const MAX_CONTEXT_LENGTH = 2000;
const BUFFER_KEY = Symbol.for('mergen-rota.operational-event-buffer');

function buffer() {
  globalThis[BUFFER_KEY] ||= { pending: [], dropped: 0 };
  return globalThis[BUFFER_KEY];
}

function contextJson(context) {
  const safe = sanitizeContext(context);
  if (!safe || (typeof safe === 'object' && !Object.keys(safe).length)) return null;
  try {
    return JSON.stringify(safe).slice(0, MAX_CONTEXT_LENGTH);
  } catch {
    return null;
  }
}

/**
 * Olayı kuyruğa alır.
 *
 * Çağıran hiçbir zaman beklemez ve hata almaz: kuyruk doluysa olay düşürülür,
 * sayaç artar. Telemetri, uygulamanın gecikmesine karışmaz.
 */
export function queueOperationalEvent({
  severity = EVENT_SEVERITIES.INFO,
  component = COMPONENTS.APPLICATION,
  code = 'OPERATION_FAILED',
  summary = '',
  detail = null,
  correlationId = null,
  context = null,
  at = new Date()
} = {}) {
  const store = buffer();
  const occurredAt = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const event = {
    severity: normalizeSeverity(severity),
    component: String(component).slice(0, 40),
    code: String(code).slice(0, 60),
    summary: sanitizeText(eventSummary(code, summary)).slice(0, 300),
    detail: detail == null ? null : sanitizeText(detail).slice(0, MAX_DETAIL_LENGTH),
    correlationId: correlationId || currentCorrelationId(),
    contextJson: contextJson(context),
    occurredAt: occurredAt.toISOString(),
    occurrenceCount: 1
  };
  if (store.pending.length >= MAX_PENDING_EVENTS) {
    store.dropped += 1;
  } else {
    store.pending.push(event);
  }
  recordFeedEntry({
    at: event.occurredAt,
    severity: event.severity,
    component: event.component,
    code: event.code,
    summary: event.summary
  });
  return event;
}

/**
 * Kuyruğu boşaltır ve ÖZDEŞ olayları tek satırda toplar.
 *
 * @returns {{events: Array, dropped: number}}
 */
export function drainOperationalEvents() {
  const store = buffer();
  const pending = store.pending;
  const dropped = store.dropped;
  store.pending = [];
  store.dropped = 0;

  const merged = new Map();
  for (const event of pending) {
    const key = `${event.severity}:${event.component}:${event.code}:${event.summary}`;
    if (!merged.has(key)) {
      merged.set(key, { ...event });
      continue;
    }
    const existing = merged.get(key);
    existing.occurrenceCount += 1;
    // Son gözlem anı ve son ilişkilendirme kimliği korunur: yönetici en taze
    // örneğin izine ulaşabilmelidir.
    existing.occurredAt = event.occurredAt;
    existing.correlationId = event.correlationId || existing.correlationId;
    existing.detail = event.detail || existing.detail;
  }
  return { events: [...merged.values()], dropped };
}

export function pendingOperationalEventCount() {
  return buffer().pending.length;
}

export function resetOperationalEventBufferForTests() {
  globalThis[BUFFER_KEY] = { pending: [], dropped: 0 };
}

export async function persistOperationalEvents(executor, events = []) {
  let written = 0;
  try {
    for (const event of events) {
      const request = executor.request();
      request.input('occurredAt', sql.DateTime2, new Date(event.occurredAt));
      request.input('severity', sql.VarChar(10), event.severity);
      request.input('component', sql.VarChar(40), event.component);
      request.input('eventCode', sql.VarChar(60), event.code);
      request.input('summary', sql.NVarChar(300), event.summary);
      request.input('detail', sql.NVarChar(MAX_DETAIL_LENGTH), event.detail);
      request.input('correlationId', sql.VarChar(64), event.correlationId);
      request.input('occurrenceCount', sql.Int, Math.max(1, Math.trunc(Number(event.occurrenceCount) || 1)));
      request.input('contextJson', sql.NVarChar(MAX_CONTEXT_LENGTH), event.contextJson);
      await request.query(OPERATIONAL_EVENT_INSERT_SQL);
      written += 1;
    }
    return { written, schemaReady: true };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { written, schemaReady: false };
    throw error;
  }
}

function parseContext(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function eventRow(row) {
  const code = String(row.EventCode || '');
  return {
    id: Number(row.OperationalEventId),
    occurredAt: row.OccurredAt ? new Date(row.OccurredAt).toISOString() : null,
    severity: normalizeSeverity(row.Severity),
    component: String(row.Component || ''),
    code,
    summary: String(row.Summary || ''),
    detail: row.Detail || null,
    correlationId: row.CorrelationId || null,
    occurrenceCount: Number(row.OccurrenceCount || 1),
    context: parseContext(row.ContextJson),
    action: eventAction(code)
  };
}

/** Sayfalı olay listesi. Süzgeçlerin tümü isteğe bağlıdır. */
export async function loadOperationalEvents(executor, {
  since,
  severity = null,
  component = null,
  code = null,
  search = null,
  offset = 0,
  limit = 25
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, 100000));
  try {
    const request = executor.request();
    request.input('since', sql.DateTime2, since instanceof Date ? since : new Date(since));
    request.input('severity', sql.VarChar(10), severity ? normalizeSeverity(severity) : null);
    request.input('component', sql.VarChar(40), component ? String(component).slice(0, 40) : null);
    request.input('eventCode', sql.VarChar(60), code ? String(code).slice(0, 60) : null);
    request.input('search', sql.NVarChar(120), search ? `%${String(search).replace(/[%_[]/g, ' ').trim().slice(0, 80)}%` : null);
    request.input('offset', sql.Int, safeOffset);
    request.input('limit', sql.Int, safeLimit);
    const result = await request.query(OPERATIONAL_EVENT_PAGE_SQL);
    const rows = result.recordset || [];
    return {
      schemaReady: true,
      total: rows.length ? Number(rows[0].TotalCount || rows.length) : 0,
      offset: safeOffset,
      limit: safeLimit,
      events: rows.map(eventRow)
    };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) {
      return { schemaReady: false, total: 0, offset: safeOffset, limit: safeLimit, events: [] };
    }
    throw error;
  }
}

function alertRow(row) {
  const code = String(row.EventCode || '');
  return {
    id: Number(row.OperationalAlertId),
    alertKey: String(row.AlertKey || ''),
    severity: normalizeSeverity(row.Severity),
    component: String(row.Component || ''),
    code,
    summary: String(row.Summary || ''),
    detail: row.Detail || null,
    state: String(row.State || ALERT_STATES.OPEN),
    occurrenceCount: Number(row.OccurrenceCount || 1),
    firstSeenAt: row.FirstSeenAt ? new Date(row.FirstSeenAt).toISOString() : null,
    lastSeenAt: row.LastSeenAt ? new Date(row.LastSeenAt).toISOString() : null,
    acknowledgedAt: row.AcknowledgedAt ? new Date(row.AcknowledgedAt).toISOString() : null,
    acknowledgedBySicil: row.AcknowledgedBySicil == null ? null : Number(row.AcknowledgedBySicil),
    resolvedAt: row.ResolvedAt ? new Date(row.ResolvedAt).toISOString() : null,
    correlationId: row.CorrelationId || null,
    context: parseContext(row.ContextJson),
    action: eventAction(code)
  };
}

/** Uyarıyı açar ya da var olanın sayacını ilerletir. */
export async function upsertOperationalAlert(executor, {
  component,
  code,
  scope = null,
  severity,
  summary = '',
  detail = null,
  context = null,
  correlationId = null,
  occurrenceCount = 1,
  observedAt = new Date()
}) {
  const key = buildAlertKey(component, code, scope);
  try {
    const request = executor.request();
    request.input('alertKey', sql.VarChar(200), key);
    request.input('severity', sql.VarChar(10), normalizeSeverity(severity));
    request.input('component', sql.VarChar(40), String(component).slice(0, 40));
    request.input('eventCode', sql.VarChar(60), String(code).slice(0, 60));
    request.input('summary', sql.NVarChar(300), sanitizeText(eventSummary(code, summary)).slice(0, 300));
    request.input('detail', sql.NVarChar(MAX_DETAIL_LENGTH), detail == null ? null : sanitizeText(detail).slice(0, MAX_DETAIL_LENGTH));
    request.input('contextJson', sql.NVarChar(MAX_CONTEXT_LENGTH), contextJson(context));
    request.input('correlationId', sql.VarChar(64), correlationId || currentCorrelationId());
    request.input('occurrenceCount', sql.Int, Math.max(1, Math.trunc(Number(occurrenceCount) || 1)));
    request.input('observedAt', sql.DateTime2, observedAt instanceof Date ? observedAt : new Date(observedAt));
    const result = await request.query(OPERATIONAL_ALERT_UPSERT_SQL);
    const row = result.recordset?.[0] || {};
    return {
      schemaReady: true,
      alertKey: key,
      created: String(row.MergeAction || '').toUpperCase() === 'INSERT',
      id: row.OperationalAlertId == null ? null : Number(row.OperationalAlertId),
      state: row.State || ALERT_STATES.OPEN,
      occurrenceCount: Number(row.OccurrenceCount || 1)
    };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, alertKey: key, created: false, id: null };
    throw error;
  }
}

/** Koşul gerçekten düzeldiğinde uyarıyı çözer. */
export async function resolveOperationalAlert(executor, { component, code, scope = null, resolvedAt = new Date() }) {
  const key = buildAlertKey(component, code, scope);
  try {
    const request = executor.request();
    request.input('alertKey', sql.VarChar(200), key);
    request.input('resolvedAt', sql.DateTime2, resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt));
    const result = await request.query(OPERATIONAL_ALERT_RESOLVE_SQL);
    const row = result.recordset?.[0];
    return { schemaReady: true, alertKey: key, resolved: Boolean(row), summary: row?.Summary || null };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, alertKey: key, resolved: false };
    throw error;
  }
}

export async function acknowledgeOperationalAlert(executor, { alertId, actorSicil, acknowledgedAt = new Date() }) {
  try {
    const request = executor.request();
    request.input('alertId', sql.BigInt, Math.trunc(Number(alertId) || 0));
    request.input('actorSicil', sql.Int, actorSicil == null ? null : Math.trunc(Number(actorSicil)));
    request.input('acknowledgedAt', sql.DateTime2, acknowledgedAt instanceof Date ? acknowledgedAt : new Date(acknowledgedAt));
    const result = await request.query(OPERATIONAL_ALERT_ACKNOWLEDGE_SQL);
    const row = result.recordset?.[0];
    return { schemaReady: true, acknowledged: Boolean(row), state: row?.State || null };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, acknowledged: false, state: null };
    throw error;
  }
}

export async function loadOperationalAlerts(executor, { activeOnly = true, component = null, since, limit = 50 } = {}) {
  try {
    const request = executor.request();
    request.input('activeOnly', sql.Bit, activeOnly ? 1 : 0);
    request.input('component', sql.VarChar(40), component ? String(component).slice(0, 40) : null);
    request.input('since', sql.DateTime2, since instanceof Date ? since : new Date(since || Date.now() - 7 * 24 * 60 * 60 * 1000));
    request.input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 50, 200)));
    const result = await request.query(OPERATIONAL_ALERT_LIST_SQL);
    return { schemaReady: true, alerts: (result.recordset || []).map(alertRow) };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, alerts: [] };
    throw error;
  }
}

/** Olay ve çözülmüş uyarı saklama sınırı. */
export async function applyOperationalRetention(executor, { cutoff, batchSize = 5000 }) {
  let deleted = 0;
  try {
    for (const statement of [OPERATIONAL_EVENT_RETENTION_SQL, OPERATIONAL_ALERT_RETENTION_SQL]) {
      const request = executor.request();
      request.input('cutoff', sql.DateTime2, cutoff instanceof Date ? cutoff : new Date(cutoff));
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
