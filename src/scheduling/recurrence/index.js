import { addDays, fmtISO, parseDate } from '../dates/index.js';
import { isWorkingDay, moveToWorkingDay } from '../calendars/index.js';

/**
 * Tekrarlayan görev kuralları — RFC 5545 (iCalendar) RRULE altkümesi.
 *
 * Kendi özel biçimimizi uydurmak yerine takvim uygulamalarının (Outlook,
 * Google Takvim, Primavera P6 “recurring activity”) tamamının konuştuğu
 * standart seçildi: kural metni dışa aktarıldığında başka bir sisteme
 * olduğu gibi taşınabilir.
 *
 * Desteklenen alan kümesi bilinçli olarak dardır ve proje planlamasında
 * gerçekten kullanılan durumları kapsar:
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY   tekrar sıklığı
 *   INTERVAL=<n>                       kaç sıklıkta bir (varsayılan 1)
 *   BYDAY=MO,TU,...                    haftalık tekrarda hangi günler
 *   BYMONTHDAY=<1..31>                 aylık tekrarda ayın günü
 *   COUNT=<n> | UNTIL=<YYYYMMDD>       seri sonu (ikisi birden verilemez)
 *
 * Modül saftır: tarih aritmetiği dışında bağımlılığı yoktur ve tek başına
 * sınanabilir.
 */

export const RECURRENCE_FREQUENCIES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** RFC 5545 gün kısaltmaları; dizin 0 = Pazartesi (ISO hafta düzeni). */
export const RECURRENCE_WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

const WEEKDAY_LABELS = Object.freeze({
  MO: 'Pzt', TU: 'Sal', WE: 'Çar', TH: 'Per', FR: 'Cum', SA: 'Cmt', SU: 'Paz'
});

const FREQUENCY_LABELS = Object.freeze({
  DAILY: 'gün', WEEKLY: 'hafta', MONTHLY: 'ay', YEARLY: 'yıl'
});

// "2 haftada bir" — bulunma hâli ekleri düzensizdir, tablodan okunur.
const FREQUENCY_LOCATIVE = Object.freeze({
  DAILY: 'günde', WEEKLY: 'haftada', MONTHLY: 'ayda', YEARLY: 'yılda'
});

/** Üretilecek en fazla yineleme; kötü kurulmuş bir kural sonsuz döngüye girmesin. */
export const MAX_RECURRENCE_OCCURRENCES = 400;

function positiveInteger(value, fallback = null) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/** `YYYYMMDD` (RFC 5545) ↔ `YYYY-MM-DD` (uygulama içi) dönüşümü. */
function isoFromCompactDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function compactDateFromIso(value) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.replaceAll('-', '') : null;
}

/** Pazartesi = 0 olacak şekilde haftanın günü. */
function isoWeekday(date) {
  return (date.getDay() + 6) % 7;
}

/**
 * Kullanıcı girdisini (form nesnesi veya RRULE metni) kanonik kurala çevirir.
 *
 * @returns {{freq: string, interval: number, byWeekday: string[], byMonthDay: number|null,
 *   count: number|null, until: string|null}|null} geçersiz girdide `null`
 */
export function normalizeRecurrenceRule(input) {
  if (!input) return null;
  const source = typeof input === 'string' ? parseRecurrenceRule(input) : input;
  if (!source) return null;

  const freq = String(source.freq ?? source.FREQ ?? '').trim().toUpperCase();
  if (!RECURRENCE_FREQUENCIES.includes(freq)) return null;

  const byWeekday = (Array.isArray(source.byWeekday) ? source.byWeekday : [])
    .map((day) => String(day).trim().toUpperCase())
    .filter((day) => RECURRENCE_WEEKDAYS.includes(day));
  // Aynı gün iki kez verilirse tekilleştirilir ve hafta sırasına göre dizilir.
  const uniqueWeekdays = RECURRENCE_WEEKDAYS.filter((day) => byWeekday.includes(day));

  const byMonthDay = freq === 'MONTHLY' ? positiveInteger(source.byMonthDay) : null;
  const count = positiveInteger(source.count);
  const untilIso = String(source.until ?? '').trim();
  const until = /^\d{4}-\d{2}-\d{2}$/.test(untilIso) ? untilIso : null;

  return {
    freq,
    interval: positiveInteger(source.interval, 1) || 1,
    byWeekday: freq === 'WEEKLY' ? uniqueWeekdays : [],
    byMonthDay: byMonthDay && byMonthDay <= 31 ? byMonthDay : null,
    // COUNT ve UNTIL RFC 5545'te birlikte verilemez; COUNT önceliklidir.
    count: count || null,
    until: count ? null : until
  };
}

/** Kanonik kuralı RFC 5545 `RRULE` gövdesine çevirir. */
export function formatRecurrenceRule(rule) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return '';
  const parts = [`FREQ=${normalized.freq}`];
  if (normalized.interval > 1) parts.push(`INTERVAL=${normalized.interval}`);
  if (normalized.byWeekday.length) parts.push(`BYDAY=${normalized.byWeekday.join(',')}`);
  if (normalized.byMonthDay) parts.push(`BYMONTHDAY=${normalized.byMonthDay}`);
  if (normalized.count) parts.push(`COUNT=${normalized.count}`);
  else if (normalized.until) parts.push(`UNTIL=${compactDateFromIso(normalized.until)}`);
  return parts.join(';');
}

/** RFC 5545 `RRULE` gövdesini ayrıştırır (baştaki `RRULE:` öneki isteğe bağlıdır). */
export function parseRecurrenceRule(text) {
  const body = String(text ?? '').trim().replace(/^RRULE:/i, '');
  if (!body) return null;
  const values = {};
  for (const part of body.split(';')) {
    const [key, value] = part.split('=');
    if (!key || value === undefined) continue;
    values[key.trim().toUpperCase()] = value.trim();
  }
  if (!values.FREQ) return null;
  return {
    freq: values.FREQ,
    interval: values.INTERVAL,
    byWeekday: values.BYDAY ? values.BYDAY.split(',') : [],
    byMonthDay: values.BYMONTHDAY,
    count: values.COUNT,
    until: isoFromCompactDate(values.UNTIL)
  };
}

/** Kuralı Türkçe, insan okunur bir cümleye çevirir. */
export function describeRecurrenceRule(rule) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return 'Tekrar yok';

  const every = normalized.interval > 1
    ? `${normalized.interval} ${FREQUENCY_LOCATIVE[normalized.freq]} bir`
    : `Her ${FREQUENCY_LABELS[normalized.freq]}`;

  let base = every;
  if (normalized.freq === 'WEEKLY' && normalized.byWeekday.length) {
    const days = normalized.byWeekday.map((day) => WEEKDAY_LABELS[day]).join(', ');
    base = `${every} · ${days}`;
  }
  if (normalized.freq === 'MONTHLY' && normalized.byMonthDay) {
    base = `${every} · ayın ${normalized.byMonthDay}. günü`;
  }

  if (normalized.count) return `${base} · ${normalized.count} yineleme`;
  if (normalized.until) return `${base} · ${normalized.until} tarihine kadar`;
  return base;
}

/**
 * Yalnızca HAFTALIK kural gün gün taranır (seçili günler seyrek olabilir);
 * diğer sıklıklarda `advance` doğrudan bir sonraki yinelemeyi üretir, bu
 * yüzden ayrıca süzmeye gerek yoktur.
 */
function matchesRule(date, rule) {
  if (rule.freq !== 'WEEKLY') return true;
  if (!rule.byWeekday.length) return true;
  return rule.byWeekday.includes(RECURRENCE_WEEKDAYS[isoWeekday(date)]);
}

function clampedMonthDay(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

function advance(date, rule, start) {
  if (rule.freq === 'DAILY') return addDays(date, rule.interval);
  // Haftalık kuralda gün gün ilerlenir; hafta atlaması `weekIndex` ile uygulanır.
  if (rule.freq === 'WEEKLY') return addDays(date, 1);
  if (rule.freq === 'MONTHLY') {
    // Ayın 31'i olmayan aylarda yineleme ayın son gününe çekilir: RFC 5545
    // o ayı atlamayı öngörür, planlamada ise bir yineleme kaybetmemek daha
    // yararlıdır ve kullanıcı beklentisine uyar.
    return clampedMonthDay(date.getFullYear(), date.getMonth() + rule.interval, rule.byMonthDay || start.getDate());
  }
  return clampedMonthDay(date.getFullYear() + rule.interval, start.getMonth(), start.getDate());
}

function weekIndex(date, start) {
  const startOfWeek = addDays(start, -isoWeekday(start));
  return Math.floor(Math.round((parseDate(date).getTime() - startOfWeek.getTime()) / 86400000) / 7);
}

/**
 * Kuralı somut tarihlere açar.
 *
 * @param {object|string} rule kanonik kural ya da RRULE metni
 * @param {{start: string, limit?: number, horizonEnd?: string}} options
 *   `start` serinin ilk aday günüdür (ISO). `limit` üretilecek en fazla
 *   yineleme, `horizonEnd` ise takvim ufkudur; ikisi de sonsuz kuralları
 *   sınırlamak içindir.
 * @returns {string[]} ISO tarihler, artan sırada
 */
export function expandRecurrence(rule, { start, limit = MAX_RECURRENCE_OCCURRENCES, horizonEnd = null } = {}) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized || !start) return [];

  const startDate = parseDate(start);
  const cap = Math.min(Math.max(1, limit), MAX_RECURRENCE_OCCURRENCES);
  const hardEnd = horizonEnd ? parseDate(horizonEnd) : null;
  const untilDate = normalized.until ? parseDate(normalized.until) : null;

  const dates = [];
  let cursor = startDate;
  // Tarama adımı: kural tutmayan günlerde de ilerleriz, bu yüzden güvenlik
  // için ayrı bir yineleme sayacı tutulur.
  let guard = 0;
  const guardLimit = MAX_RECURRENCE_OCCURRENCES * 40;

  while (dates.length < cap && guard < guardLimit) {
    guard += 1;
    if (hardEnd && cursor > hardEnd) break;
    if (untilDate && cursor > untilDate) break;

    const weeklySkipped = normalized.freq === 'WEEKLY'
      && normalized.interval > 1
      && weekIndex(cursor, startDate) % normalized.interval !== 0;

    if (!weeklySkipped && matchesRule(cursor, normalized)) {
      dates.push(fmtISO(cursor));
      if (normalized.count && dates.length >= normalized.count) break;
    }

    cursor = advance(cursor, normalized, startDate);
  }

  return dates;
}

/**
 * Seriden üretilecek yineleme planını hazırlar.
 *
 * Şablon görevin süresi korunur: her yineleme aynı iş günü uzunluğunda
 * planlanır. Çalışma takvimi verildiğinde tatil ve hafta sonuna denk gelen
 * yinelemeler bir sonraki iş gününe kaydırılır (`skipNonWorkingDays`).
 *
 * @returns {Array<{index: number, plannedStart: string, plannedFinish: string, targetFinish: string}>}
 */
export function planRecurringOccurrences(template, rule, {
  calendar = null,
  limit = MAX_RECURRENCE_OCCURRENCES,
  horizonEnd = null,
  skipNonWorkingDays = true
} = {}) {
  const start = template?.plannedStart;
  if (!start) return [];

  const durationDays = Number.isFinite(template.plannedDurationDays) && template.plannedDurationDays > 0
    ? Math.round(template.plannedDurationDays)
    : Math.max(0, template.plannedFinish ? dayGap(start, template.plannedFinish) : 0);
  const targetOffset = template.targetFinish ? dayGap(start, template.targetFinish) : durationDays;

  const seen = new Set();
  const plan = [];
  for (const [index, date] of expandRecurrence(rule, { start, limit, horizonEnd }).entries()) {
    const shifted = calendar && skipNonWorkingDays && !isWorkingDay(date, calendar)
      ? fmtISO(moveToWorkingDay(date, calendar, 1))
      : date;
    // Kaydırma iki yinelemeyi aynı güne düşürebilir; aynı gün iki kez üretilmez.
    if (seen.has(shifted)) continue;
    seen.add(shifted);
    plan.push({
      index,
      plannedStart: shifted,
      plannedFinish: fmtISO(addDays(shifted, durationDays)),
      targetFinish: fmtISO(addDays(shifted, Math.max(targetOffset, durationDays)))
    });
  }
  return plan;
}

function dayGap(from, to) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}
