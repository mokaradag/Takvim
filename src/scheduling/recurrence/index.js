import { addDays, fmtISO, parseDate } from '../dates/index.js';
import { addWorkingDays, countWorkingDays, isWorkingDay, moveToWorkingDay } from '../calendars/index.js';

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

/** RRULE gövdesinde desteklenen alanlar; başkası sessizce yok sayılmaz. */
const SUPPORTED_RULE_PARTS = Object.freeze(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL']);

/** `INTERVAL` üst sınırı; daha büyüğü seriyi pratikte üretilemez kılar. */
export const MAX_RECURRENCE_INTERVAL = 999;

function integerPart(value) {
  const body = String(value ?? '').trim();
  return /^\d+$/.test(body) ? Number(body) : null;
}

/**
 * RRULE gövdesini *katı* biçimde denetler.
 *
 * `normalizeRecurrenceRule` bilinçli olarak hoşgörülüdür: okunamayan bir alanı
 * düşürüp kuralı yine de döndürür; eski kayıtların ekranda açılabilmesi için
 * gerekli. Kalıcılaştırma sınırında ise bu hoşgörü, gönderilen kuralın
 * saklanandan başka anlama gelmesi demektir (örneğin `COUNT=0` sınırsız seriye
 * dönüşür). Yazma yolunda bu nedenle bu denetim kullanılır.
 *
 * @param {string} text RRULE gövdesi (`RRULE:` öneki isteğe bağlı)
 * @returns {string|null} sorunun Türkçe açıklaması, geçerliyse `null`
 */
export function findRecurrenceRuleIssue(text) {
  const body = String(text ?? '').trim().replace(/^RRULE:/i, '');
  if (!body) return 'Tekrar kuralı boş olamaz.';

  const values = new Map();
  for (const part of body.split(';')) {
    if (!part.trim()) return 'Tekrar kuralında boş bileşen bulunamaz.';
    const separator = part.indexOf('=');
    if (separator < 0) return `Tekrar kuralı bileşeni ad=değer biçiminde olmalıdır: ${part.trim()}`;
    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim();
    if (!SUPPORTED_RULE_PARTS.includes(key)) return `Desteklenmeyen tekrar bileşeni: ${key || part.trim()}`;
    if (values.has(key)) return `Tekrar bileşeni birden çok kez verilemez: ${key}`;
    if (!value) return `Tekrar bileşeni değersiz olamaz: ${key}`;
    values.set(key, value);
  }

  const freq = String(values.get('FREQ') ?? '').toUpperCase();
  if (!freq) return 'Tekrar kuralı FREQ bileşenini içermelidir.';
  if (!RECURRENCE_FREQUENCIES.includes(freq)) return `Desteklenmeyen tekrar sıklığı: ${freq}`;

  if (values.has('INTERVAL')) {
    const interval = integerPart(values.get('INTERVAL'));
    if (!interval || interval < 1 || interval > MAX_RECURRENCE_INTERVAL) {
      return `INTERVAL 1 ile ${MAX_RECURRENCE_INTERVAL} arasında bir tam sayı olmalıdır.`;
    }
  }

  if (values.has('BYDAY')) {
    if (freq !== 'WEEKLY') return 'BYDAY yalnızca haftalık tekrar kuralında kullanılabilir.';
    const days = values.get('BYDAY').split(',').map((day) => day.trim().toUpperCase());
    for (const day of days) {
      if (!RECURRENCE_WEEKDAYS.includes(day)) return `Geçersiz BYDAY günü: ${day || '(boş)'}`;
    }
    if (new Set(days).size !== days.length) return 'BYDAY aynı günü birden çok kez içeremez.';
  }

  if (values.has('BYMONTHDAY')) {
    if (freq !== 'MONTHLY') return 'BYMONTHDAY yalnızca aylık tekrar kuralında kullanılabilir.';
    const monthDay = integerPart(values.get('BYMONTHDAY'));
    if (!monthDay || monthDay < 1 || monthDay > 31) return 'BYMONTHDAY 1 ile 31 arasında bir tam sayı olmalıdır.';
  }

  if (values.has('COUNT') && values.has('UNTIL')) return 'COUNT ve UNTIL birlikte verilemez.';

  if (values.has('COUNT')) {
    const count = integerPart(values.get('COUNT'));
    if (!count || count < 1) return 'COUNT en az 1 olmalıdır.';
    // Açılım güvenlik tavanında durur; tavanı aşan bir COUNT hiçbir zaman
    // tamamlanamaz, bu yüzden kabul edilmez.
    if (count > MAX_RECURRENCE_OCCURRENCES) return `COUNT en fazla ${MAX_RECURRENCE_OCCURRENCES} olabilir.`;
  }

  if (values.has('UNTIL') && !isoFromCompactDate(values.get('UNTIL'))) {
    return 'UNTIL YYYYMMDD biçiminde geçerli bir tarih olmalıdır.';
  }

  return null;
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

/** Dönem taraması için üst sınır; kötü kurulmuş bir kural sonsuz dönmesin. */
const MAX_PERIOD_SCANS = MAX_RECURRENCE_OCCURRENCES * 10;

/**
 * Haftalık kuralda gün kümesi zorunludur; `BYDAY` verilmediğinde RFC 5545
 * serinin başlangıç gününü (DTSTART) varsayar. Aksi hâlde `FREQ=WEEKLY`
 * haftanın her gününe açılırdı.
 */
function weeklyDays(rule, startDate) {
  return rule.byWeekday.length ? rule.byWeekday : [RECURRENCE_WEEKDAYS[isoWeekday(startDate)]];
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Bir dönemin (gün/hafta/ay/yıl) aday tarihlerini artan sırada üretir.
 *
 * RFC 5545 takvimde bulunmayan tarihi (31 Şubat, artık olmayan yılda 29 Şubat)
 * atlamayı ve yineleme saymamayı şart koşar. Kural dışa aktarıldığında başka
 * bir takvim uygulamasıyla aynı seriyi vermesi gerektiği için burada da ayın
 * son gününe çekilmez, atlanır.
 */
function periodDates(rule, startDate, period) {
  if (rule.freq === 'DAILY') return [addDays(startDate, period * rule.interval)];

  if (rule.freq === 'WEEKLY') {
    const weekStart = addDays(startDate, period * rule.interval * 7 - isoWeekday(startDate));
    return weeklyDays(rule, startDate)
      .map((day) => addDays(weekStart, RECURRENCE_WEEKDAYS.indexOf(day)))
      .sort((a, b) => a - b);
  }

  const monthly = rule.freq === 'MONTHLY';
  const monthDay = monthly ? (rule.byMonthDay || startDate.getDate()) : startDate.getDate();
  const anchor = new Date(
    monthly ? startDate.getFullYear() : startDate.getFullYear() + period * rule.interval,
    monthly ? startDate.getMonth() + period * rule.interval : startDate.getMonth(),
    1
  );
  if (monthDay > daysInMonth(anchor.getFullYear(), anchor.getMonth())) return [];
  return [new Date(anchor.getFullYear(), anchor.getMonth(), monthDay)];
}

/**
 * Kuralın ham (çalışma takvimine göre kaydırılmamış) tarihlerini artan sırada
 * üretir. Gün gün taranmaz, dönem dönem ilerlenir: `INTERVAL` ne kadar büyük
 * olursa olsun tarama bütçesi yineleme sayısıyla orantılı kalır.
 */
function* iterateRecurrenceDates(rule, startDate) {
  for (let period = 0; period < MAX_PERIOD_SCANS; period += 1) {
    for (const date of periodDates(rule, startDate, period)) {
      if (date < startDate) continue;
      yield date;
    }
  }
}

/** Üretilecek yineleme sayısı: istenen sınır, kuralın COUNT'u ve güvenlik tavanı. */
function occurrenceCap(rule, limit) {
  const requested = Math.min(Math.max(1, limit), MAX_RECURRENCE_OCCURRENCES);
  return rule.count ? Math.min(requested, rule.count) : requested;
}

/**
 * Kuralı somut tarihlere açar.
 *
 * @param {object|string} rule kanonik kural ya da RRULE metni
 * @param {{start: string, limit?: number, horizonEnd?: string}} options
 *   `start` serinin ilk aday günüdür (ISO, RFC 5545 DTSTART). `limit`
 *   üretilecek en fazla yineleme, `horizonEnd` ise takvim ufkudur; ikisi de
 *   sonsuz kuralları sınırlamak içindir.
 * @returns {string[]} ISO tarihler, artan sırada
 */
export function expandRecurrence(rule, { start, limit = MAX_RECURRENCE_OCCURRENCES, horizonEnd = null } = {}) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized || !start) return [];

  const startDate = parseDate(start);
  const cap = occurrenceCap(normalized, limit);
  const hardEnd = horizonEnd ? parseDate(horizonEnd) : null;
  const untilDate = normalized.until ? parseDate(normalized.until) : null;

  const dates = [];
  for (const date of iterateRecurrenceDates(normalized, startDate)) {
    if (hardEnd && date > hardEnd) break;
    if (untilDate && date > untilDate) break;
    dates.push(fmtISO(date));
    if (dates.length >= cap) break;
  }
  return dates;
}

function dayGap(from, to) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}

/**
 * İki tarih arasındaki *dahil* gün sayısı. Çalışma takvimi verildiğinde iş günü
 * sayılır — `plannedDurationDays` de bu ölçüyü kullanır (bkz. scheduling/plans).
 */
function spanBetween(from, to, calendar) {
  if (calendar) return countWorkingDays(from, to, calendar);
  const gap = dayGap(from, to);
  return gap >= 0 ? gap + 1 : gap - 1;
}

/** `spanBetween` ile ölçülen dahil süreyi bir başlangıca yeniden uygular. */
function addSpan(start, span, calendar) {
  const steps = span > 0 ? span - 1 : (span < 0 ? span + 1 : 0);
  return calendar ? addWorkingDays(start, steps, calendar) : addDays(start, steps);
}

/**
 * Şablonun planlanan süresi. `plannedDurationDays` bir iş günü sayısıdır;
 * yoksa planlanan bitişten türetilir. Şablonun bitişi de yoksa süre
 * *bilinmiyordur* — yinelemeye uydurulmuş bir bitiş yazılmaz.
 */
function plannedSpanDays(template, calendar) {
  const declared = template?.plannedDurationDays;
  if (Number.isFinite(declared) && declared >= 0) return Math.round(declared);
  if (!template?.plannedFinish) return null;
  return spanBetween(template.plannedStart, template.plannedFinish, calendar);
}

/**
 * Seriden üretilecek yineleme planını hazırlar.
 *
 * Şablon görevin süresi korunur: her yineleme aynı iş günü uzunluğunda
 * planlanır. Çalışma takvimi verildiğinde tatil ve hafta sonuna denk gelen
 * yinelemeler bir sonraki iş gününe kaydırılır (`skipNonWorkingDays`).
 *
 * COUNT/UNTIL/ufuk sınırları kaydırma ve tekilleştirmeden *sonraki* kümeye
 * uygulanır: kullanıcı üç yineleme istediyse üç görev oluşur ve hiçbir görev
 * UNTIL tarihinden sonraya kalıcılaştırılmaz.
 *
 * @returns {Array<{index: number, plannedStart: string, plannedFinish: string|null,
 *   targetFinish: string|null}>}
 */
export function planRecurringOccurrences(template, rule, {
  calendar = null,
  limit = MAX_RECURRENCE_OCCURRENCES,
  horizonEnd = null,
  skipNonWorkingDays = true
} = {}) {
  const normalized = normalizeRecurrenceRule(rule);
  const start = template?.plannedStart;
  if (!normalized || !start) return [];

  const startDate = parseDate(start);
  const cap = occurrenceCap(normalized, limit);
  const hardEnd = horizonEnd ? parseDate(horizonEnd) : null;
  const untilDate = normalized.until ? parseDate(normalized.until) : null;
  const shiftCalendar = skipNonWorkingDays ? calendar : null;

  const durationSpan = plannedSpanDays(template, calendar);
  // Şablonun yönetsel terminini koru: olmayan bir termin uydurulmaz, planlanan
  // bitişten önceye konmuş bir termin de bitişe kadar ötelenmez.
  const targetSpan = template?.targetFinish ? spanBetween(start, template.targetFinish, calendar) : null;

  const seen = new Set();
  const plan = [];
  for (const date of iterateRecurrenceDates(normalized, startDate)) {
    const shifted = shiftCalendar && !isWorkingDay(date, shiftCalendar)
      ? moveToWorkingDay(date, shiftCalendar, 1)
      : date;
    if (hardEnd && shifted > hardEnd) break;
    if (untilDate && shifted > untilDate) break;

    // Kaydırma iki yinelemeyi aynı güne düşürebilir; aynı gün iki kez
    // üretilmez, buna karşılık açılım istenen sayı tamamlanana kadar sürer.
    const iso = fmtISO(shifted);
    if (seen.has(iso)) continue;
    seen.add(iso);

    plan.push({
      index: plan.length,
      plannedStart: iso,
      plannedFinish: durationSpan === null ? null : fmtISO(addSpan(shifted, durationSpan, calendar)),
      targetFinish: targetSpan === null ? null : fmtISO(addSpan(shifted, targetSpan, calendar))
    });
    if (plan.length >= cap) break;
  }
  return plan;
}

/**
 * Serinin ne üreteceğini ARAYÜZ İÇİN özetler.
 *
 * "3 yineleme" ifadesi tek başına belirsizdir: RFC 5545'te `COUNT` serinin
 * TOPLAM yineleme sayısıdır ve `DTSTART` (şablonun planlanan başlangıcı) kurala
 * uyuyorsa serinin ilk yinelemesi şablonun kendisidir. Bu durumda "3 yineleme"
 * yalnızca 2 YENİ görev demektir. Kullanıcıya hangi sayının ne anlama geldiğini
 * göstermeden bu davranış hatalı görünür.
 *
 * @param {object} template şablon görev (`plannedStart` zorunlu)
 * @param {object|string} rule kanonik kural ya da RRULE metni
 * @param {{calendar?: object, previewLimit?: number}} [options]
 * @returns {{occurrences: Array<object>, dates: string[], preview: string[],
 *   hiddenCount: number, includesTemplate: boolean, totalCount: number,
 *   generatedCount: number, unbounded: boolean}}
 */
export function summarizeRecurrencePlan(template, rule, { calendar = null, previewLimit = 8 } = {}) {
  const normalized = normalizeRecurrenceRule(rule);
  const empty = {
    occurrences: [], dates: [], preview: [], hiddenCount: 0,
    includesTemplate: false, totalCount: 0, generatedCount: 0, unbounded: false
  };
  if (!normalized || !template?.plannedStart) return empty;

  // Sınırsız kuralda tüm seri açılamaz; önizleme için bir pencere yeter.
  const unbounded = !normalized.count && !normalized.until;
  const limit = unbounded
    ? previewLimit + 1
    : Math.min(MAX_RECURRENCE_OCCURRENCES, normalized.count || MAX_RECURRENCE_OCCURRENCES);
  const occurrences = planRecurringOccurrences(template, normalized, { calendar, limit });
  const dates = occurrences.map((occurrence) => occurrence.plannedStart);
  // Şablonun kendi günü seride yer alıyorsa o gün için YENİ görev üretilmez
  // (bkz. AppStateProvider · generateTaskSeries).
  const includesTemplate = dates.includes(template.plannedStart);
  const totalCount = unbounded ? 0 : dates.length;

  return {
    occurrences,
    dates,
    preview: dates.slice(0, previewLimit),
    hiddenCount: unbounded ? 0 : Math.max(0, dates.length - previewLimit),
    includesTemplate,
    totalCount,
    generatedCount: unbounded ? 0 : Math.max(0, totalCount - (includesTemplate ? 1 : 0)),
    unbounded
  };
}
