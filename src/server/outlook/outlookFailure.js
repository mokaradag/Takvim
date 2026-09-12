import 'server-only';
import { safeOutlookFailureCode } from '../../domain/outlook/outlookFailures.js';
import { isMissingOutlookSchema } from './outlookStore.js';

export function outlookFailureCode(error) {
  if (isMissingOutlookSchema(error)) return 'OUTLOOK_SCHEMA_MISSING';
  const entries = [error, error?.cause, error?.originalError, error?.originalError?.info, ...(error?.precedingErrors || [])];
  for (const entry of entries) {
    if (Number(entry?.number) === 1205) return 'DATABASE_DEADLOCK';
    if (entry?.code === 'ETIMEOUT') return 'DATABASE_TIMEOUT';
    const known = safeOutlookFailureCode(entry?.code, null);
    if (known) return known;
    if (['OUTLOOK_RUN_TIMEOUT', 'OUTLOOK_LEASE_LOST'].includes(entry?.message)) return entry.message;
  }
  if (entries.some((entry) => ['ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ELOGIN', 'ECONNRESET', 'ECONNREFUSED'].includes(entry?.code))) return 'DATABASE_UNAVAILABLE';
  if (entries.some((entry) => ['EREQUEST', 'ECANCEL'].includes(entry?.code) || Number.isInteger(entry?.number))) return 'DATABASE_QUERY_FAILED';
  return 'UNEXPECTED_ERROR';
}
