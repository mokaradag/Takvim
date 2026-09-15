import 'server-only';
import { safeOutlookFailureCode } from '../../domain/outlook/outlookFailures.js';
import { isMissingOutlookSchema } from './outlookStore.js';

function errorEntries(error) {
  const entries = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && entries.length < 32) {
    const entry = pending.shift();
    if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
    pending.push(entry.cause, entry.originalError, entry.info);
    if (Array.isArray(entry.precedingErrors)) pending.push(...entry.precedingErrors.slice(0, 32));
  }
  return entries;
}

function sqlState(entry) {
  const value = entry?.sqlstate ?? entry?.state;
  return typeof value === 'string' && /^[A-Z0-9]{5}$/i.test(value) ? value.toUpperCase() : undefined;
}

export function outlookFailureCode(error, signal = null) {
  if (signal?.aborted) {
    const reason = signal.reason?.code || signal.reason?.message;
    if (['OUTLOOK_RUN_TIMEOUT', 'OUTLOOK_LEASE_LOST'].includes(reason)) return reason;
  }
  if (isMissingOutlookSchema(error)) return 'OUTLOOK_SCHEMA_MISSING';
  const entries = errorEntries(error);
  if (entries.some((entry) => Number(entry.number ?? entry.code) === 1205)) return 'DATABASE_DEADLOCK';
  if (entries.some((entry) => entry.code === 'ETIMEOUT' || ['HYT00', 'HYT01', 'S1T00'].includes(sqlState(entry)))) return 'DATABASE_TIMEOUT';
  if (entries.some((entry) => ['ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ELOGIN', 'ECONNRESET', 'ECONNREFUSED'].includes(entry.code)
    || sqlState(entry)?.startsWith('08'))) return 'DATABASE_UNAVAILABLE';
  for (const entry of entries) {
    const known = safeOutlookFailureCode(entry?.code, null);
    if (known) return known;
    if (['OUTLOOK_RUN_TIMEOUT', 'OUTLOOK_LEASE_LOST'].includes(entry?.message)) return entry.message;
  }
  if (entries.some((entry) => ['EREQUEST', 'ECANCEL'].includes(entry?.code) || Number.isInteger(entry?.number))) return 'DATABASE_QUERY_FAILED';
  return 'UNEXPECTED_ERROR';
}

const STAGES = new Set(['revalidate', 'health-before-claim', 'claim', 'delivery', 'health-after-delivery']);
const DRIVER_CODES = new Set(['EREQUEST', 'ECANCEL', 'ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ELOGIN', 'ECONNRESET', 'ECONNREFUSED', 'EARGS', 'EINJECT', 'EPARAM']);

/** Yalnız aşama ve izin verilen teknik hata alanları günlüğe çıkar. */
export function outlookFailureDiagnostic(error, stage, signal = null) {
  const entries = errorEntries(error);
  const diagnostic = { stage: STAGES.has(stage) ? stage : 'delivery', code: outlookFailureCode(error, signal) };
  const driverCode = entries.find((entry) => DRIVER_CODES.has(entry.code))?.code;
  if (driverCode) diagnostic.driverCode = driverCode;
  for (const entry of entries) {
    const number = entry.number ?? (typeof entry.code === 'number' ? entry.code : undefined);
    if (diagnostic.number == null && Number.isSafeInteger(number) && number >= 0) diagnostic.number = number;
    const state = sqlState(entry);
    if (state && !diagnostic.sqlState) diagnostic.sqlState = state;
    if (diagnostic.state == null && Number.isInteger(entry.state) && entry.state >= 0 && entry.state <= 255) diagnostic.state = entry.state;
    const severity = entry.class ?? entry.severity;
    if (diagnostic.severity == null && Number.isInteger(severity) && severity >= 0 && severity <= 25) diagnostic.severity = severity;
  }
  return diagnostic;
}
