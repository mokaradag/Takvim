import { TR_DAYS, TR_MONTHS_LONG } from '../scheduling/dates/index.js';

export const TURKISH_CALENDAR_WEEKDAYS = Object.freeze([...TR_DAYS]);

function isoFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function todayIso() {
  return isoFromDate(new Date());
}

export function isDateWithinLimits(value, { minDate = '', maxDate = '' } = {}) {
  if (!parseIsoDate(value)) return false;
  if (minDate && value < minDate) return false;
  if (maxDate && value > maxDate) return false;
  return true;
}

export function dateLimitMessage(value, { minDate = '', maxDate = '', formatDate = (date) => date } = {}) {
  if (minDate && value < minDate) return `Tarih ${formatDate(minDate)} tarihinden önce olamaz.`;
  if (maxDate && value > maxDate) return `Tarih ${formatDate(maxDate)} tarihinden sonra olamaz.`;
  return '';
}

export function resolveCalendarMonth(value, { minDate = '', maxDate = '', fallback = todayIso() } = {}) {
  let resolved = parseIsoDate(value) ? value : fallback;
  if (minDate && resolved < minDate) resolved = minDate;
  if (maxDate && resolved > maxDate) resolved = maxDate;
  const date = parseIsoDate(resolved) || new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

export function shiftCalendarMonth(monthValue, amount) {
  const date = parseIsoDate(monthValue) || new Date();
  return isoFromDate(new Date(date.getFullYear(), date.getMonth() + amount, 1));
}

export function calendarMonthLabel(monthValue) {
  const date = parseIsoDate(monthValue) || new Date();
  return `${TR_MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
}

export function calendarMonthHasSelectableDate(monthValue, { minDate = '', maxDate = '' } = {}) {
  const start = parseIsoDate(monthValue);
  if (!start) return false;
  const monthStart = isoFromDate(new Date(start.getFullYear(), start.getMonth(), 1));
  const monthEnd = isoFromDate(new Date(start.getFullYear(), start.getMonth() + 1, 0));
  return (!minDate || monthEnd >= minDate) && (!maxDate || monthStart <= maxDate);
}

/** Pazartesiyle başlayan altı haftalık Türkçe takvim ızgarası. */
export function buildCalendarMonth(monthValue) {
  const monthStart = parseIsoDate(monthValue) || new Date();
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;

  return Array.from({ length: 42 }, (unused, index) => {
    const date = new Date(year, month, 1 - mondayOffset + index);
    return {
      iso: isoFromDate(date),
      day: date.getDate(),
      month: date.getMonth(),
      year: date.getFullYear(),
      label: `${date.getDate()} ${TR_MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`,
      inCurrentMonth: date.getMonth() === month
    };
  });
}
