import { canonicalActualId, extractActualId } from '../../domain/identity/actualId.js';
import { ServerPersistenceError } from '../errors.js';

const STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'STALE'];

function invalid(message) { throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 }); }

function normalizeScheduleActualId(field, value) {
  if (!value) return null;
  const plain = canonicalActualId(value);
  if (plain) return plain;
  const prefix = field === 'taskId' ? 'task-' : 'project-';
  const text = String(value).trim();
  if (!text.toLowerCase().startsWith(prefix)) return null;
  const suffix = text.slice(prefix.length);
  const extracted = extractActualId(text);
  return extracted && canonicalActualId(suffix) === extracted ? extracted : null;
}

export function normalizeScheduleQuery(input = {}) {
  const tab = input.tab || 'pending';
  if (!['pending', 'sent', 'history', 'all'].includes(tab)) invalid('Talep sekmesi geçersiz.');
  const page = Number(input.page || 0), pageSize = Number(input.pageSize || 25);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) invalid('Sayfa numarası geçersiz.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('Sayfa boyutu 1–100 arasında olmalıdır.');
  const query = { tab, page, pageSize, search: String(input.search || '').trim().slice(0, 200) };
  for (const field of ['projectId', 'taskId']) {
    query[field] = normalizeScheduleActualId(field, input[field]);
    if (input[field] && !query[field]) invalid('Proje veya görev kimliği geçersiz.');
  }
  query.requester = String(input.requester || '').trim().slice(0, 100);
  query.status = input.status || null;
  if (query.status && !STATUSES.includes(query.status)) invalid('Talep durumu geçersiz.');
  for (const field of ['from', 'to']) {
    const value = input[field] || null;
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900 || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value)) invalid('Tarih geçersiz.');
    query[field] = value;
  }
  if (query.from && query.to && query.from > query.to) invalid('Başlangıç tarihi bitişten sonra olamaz.');
  return query;
}
