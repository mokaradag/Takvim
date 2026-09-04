import { diffDays, fmt } from '../../scheduling/dates/index.js';

export const SCHEDULE_DATE_ROWS = Object.freeze([
  { key: 'plannedStart', label: 'Planlanan başlangıç' },
  { key: 'plannedFinish', label: 'Planlanan bitiş' },
  { key: 'targetFinish', label: 'Hedef bitiş' }
]);

/**
 * Talep penceresinde SORULACAK tarih satırları.
 *
 * Sorumlu kendi plan ve gerçekleşen tarihlerini panelden doğrudan yazar; ondan
 * yalnızca doğrudan değiştiremediği tarih istenir. Bütün satırlar her koşulda
 * gösterildiğinde kullanıcı, zaten kendi düzenleyebildiği tarihler için de
 * onay bekleyen bir talep açıyordu.
 */
export function scheduleProposalRows(fields = null) {
  if (!Array.isArray(fields) || !fields.length) return SCHEDULE_DATE_ROWS;
  const allowed = new Set(fields.map(String));
  const rows = SCHEDULE_DATE_ROWS.filter((row) => allowed.has(row.key));
  return rows.length ? rows : SCHEDULE_DATE_ROWS;
}

export function scheduleDifferenceSummary(current = {}, proposed = {}, rows = SCHEDULE_DATE_ROWS) {
  return (rows || SCHEDULE_DATE_ROWS).flatMap(({ key, label }) => {
    const before = current[key] || null;
    const after = proposed[key] || null;
    if (before === after) return [];
    const delta = before && after ? diffDays(after, before) : null;
    const deltaText = delta == null || delta === 0 ? '' : ` · ${delta > 0 ? '+' : ''}${delta} gün`;
    return [`${label}: ${before ? fmt(before, 'dd MMM') : '—'} → ${after ? fmt(after, 'dd MMM') : '—'}${deltaText}`];
  });
}

export function requestDates(request = {}, prefix) {
  return {
    plannedStart: request[`${prefix}PlannedStart`] || null,
    plannedFinish: request[`${prefix}PlannedFinish`] || null,
    targetFinish: request[`${prefix}TargetFinish`] || null
  };
}

/**
 * Görev yeniden yüklendiğinde yalnızca kullanıcının değiştirmediği öneri
 * alanlarını güncel planla eşitler. Böylece açık pencere eski tarihleri geri
 * yazmaz; bilinçli kullanıcı taslağı da kaybolmaz.
 */
export function reconcileScheduleProposal(current = {}, proposed = {}, dirtyFields = new Set()) {
  return Object.fromEntries(SCHEDULE_DATE_ROWS.map(({ key }) => [
    key,
    dirtyFields.has(key) ? (proposed[key] || null) : (current[key] || null)
  ]));
}
