// Açık dosya yolu: Node ESM dizin içe aktarımını çözmez ve bu modül doğrudan
// sınanır.
import { addDays, fmtISO, parseDate } from '../../scheduling/dates/index.js';

/** Özet ve Raporlar sayfalarının ortak tarih aralığı süzgeci. */

export const DATE_RANGE_PRESETS = Object.freeze([
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'last90', label: 'Son 90 gün' },
  { id: 'thisYear', label: 'Bu yıl' },
  { id: 'all', label: 'Tümü' },
  { id: 'custom', label: 'Özel' }
]);

export const DEFAULT_DATE_RANGE_PRESET = 'all';

export function resolveDateRangePreset(preset, referenceDate) {
  const today = parseDate(referenceDate);
  if (!today || Number.isNaN(today.getTime())) return null;
  if (preset === 'last30') return { start: fmtISO(addDays(today, -29)), end: fmtISO(today) };
  if (preset === 'last90') return { start: fmtISO(addDays(today, -89)), end: fmtISO(today) };
  if (preset === 'thisYear') {
    return {
      start: fmtISO(new Date(today.getFullYear(), 0, 1)),
      end: fmtISO(new Date(today.getFullYear(), 11, 31))
    };
  }
  return null;
}

function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsed = parseDate(day);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return fmtISO(parsed) === day ? day : null;
}

export function taskActivityWindow(task) {
  const candidates = [
    isoDay(task?.plannedStart),
    isoDay(task?.actualStart),
    isoDay(task?.plannedFinish),
    isoDay(task?.actualFinish),
    isoDay(task?.targetFinish)
  ].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort();
  return { start: candidates[0], end: candidates[candidates.length - 1] };
}

export function taskMatchesDateRange(task, range) {
  if (!range?.start || !range?.end) return true;
  const window = taskActivityWindow(task);
  if (!window) return true;
  return window.start <= range.end && window.end >= range.start;
}

export function filterTasksByDateRange(tasks, range) {
  const source = tasks || [];
  const organizationIds = Array.isArray(range?.organizationTaskIds)
    ? new Set(range.organizationTaskIds.map((id) => String(id)))
    : null;
  const scoped = organizationIds
    ? source.filter((task) => organizationIds.has(String(task.id)))
    : source;
  if (!range?.start || !range?.end) return scoped;
  return scoped.filter((task) => taskMatchesDateRange(task, range));
}

function withOrganizationScope(selection, range) {
  if (!Array.isArray(selection?.organizationTaskIds)) return range;
  return { ...(range || {}), organizationTaskIds: selection.organizationTaskIds };
}

export function resolveDateRangeSelection(selection, referenceDate) {
  const preset = selection?.preset || DEFAULT_DATE_RANGE_PRESET;
  if (preset === 'custom') {
    const start = isoDay(selection?.start);
    const end = isoDay(selection?.end);
    if (!start || !end || start > end) return withOrganizationScope(selection, null);
    return withOrganizationScope(selection, { start, end });
  }
  return withOrganizationScope(selection, resolveDateRangePreset(preset, referenceDate));
}

export function describeDateRange(range) {
  if (!range?.start || !range?.end) return 'Tüm zamanlar';
  return `${range.start} – ${range.end}`;
}
