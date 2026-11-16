import { isIsoDay } from './isoDay.js';

/**
 * Aşama H — TÜRLÜ DÖNEM (zaman penceresi) sözleşmesi.
 *
 * Dönem, kullanıcı cümlesinden düzenli ifadeyle çıkarılmaz: model kapalı sözlükten bir dönem adı (ya da açık tarih çifti)
 * bildirir, sunucu onu Türkiye gününe (`Europe/Istanbul`; "bugün" çağıranın verdiği iş günüdür) göre BELİRLENİMCİ olarak
 * somut `dateFrom`/`dateTo` çiftine çevirir. Bu modül saftır: saat okumaz, yalnızca takvim aritmetiği yapar.
 *
 * Kurallar:
 *   - Takvim haftası pazartesi başlar, pazar biter (Türkiye iş takvimi; ISO 8601 ile aynı).
 *   - Takvim haftası ile kayan pencere birbirinin yerine geçmez: `this_week` içinde bulunulan pazartesi–pazar haftasıdır,
 *     `last_7_days` bugün DAHİL geriye doğru yedi gündür.
 *   - `last_N_days` bugünü içerir (bugün ve önceki N−1 gün); `next_N_days` bugünü içerir (bugün ve sonraki N−1 gün). Bu,
 *     Görev Hareketleri raporunun ve termin süzgeçlerinin mevcut tanımıdır.
 *   - Karşılaştırma dönemi (`previousWindow`) aynı türün bir önceki dönemidir: haftanın öncesi önceki hafta, ayın öncesi
 *     önceki ay, kayan N günün öncesi ondan hemen önceki N gün, açık tarih aralığının öncesi aynı uzunlukta hemen önceki aralık.
 */

/** Dönem sözlüğü: geçmiş, içinde bulunulan ve gelecek pencereler. `all_time` dönem değildir ("dönem yok"). */
export const TEMPORAL_WINDOWS = Object.freeze(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
  'last_7_days', 'last_14_days', 'last_30_days', 'next_7_days', 'next_14_days', 'next_30_days']);
/** Karşılaştırma dönemi olarak yazılabilen değerler: adlı pencere ya da "bir önceki eşdeğer dönem". */
export const COMPARE_WINDOWS = Object.freeze(['previous', ...TEMPORAL_WINDOWS]);
/** Dizinin kova boyu. */
export const SERIES_BUCKETS = Object.freeze(['week', 'month']);
/** Tek dizide en çok kova (çizgi grafiğin nokta sınırı; araçların satır sınırının içinde). Sınır aşılırsa dizi kurulmaz, daha kaba kova kullanılır. */
export const SERIES_LIMITS = Object.freeze({ maxBuckets: 24, maxRangeDays: 366, weekRangeDays: 92 });

const DAY_MS = 86400000;
const ROLLING = Object.freeze({ last_7_days: -7, last_14_days: -14, last_30_days: -30, next_7_days: 7, next_14_days: 14, next_30_days: 30 });

const time = (day) => Date.parse(`${day}T00:00:00Z`);
const iso = (value) => new Date(value).toISOString().slice(0, 10);

/** Güne takvim günü ekler (negatif de olabilir). */
export function shiftDay(day, count) {
  return iso(time(day) + count * DAY_MS);
}

/** `to − from` takvim günü. */
export function dayDistance(from, to) {
  return Math.round((time(to) - time(from)) / DAY_MS);
}

/** Dönemin gün sayısı (iki uç dâhil). */
export function windowLength(range) {
  return dayDistance(range.dateFrom, range.dateTo) + 1;
}

/** Günün takvim haftasının pazartesisi. */
export function weekStart(day) {
  const weekday = (new Date(time(day)).getUTCDay() + 6) % 7;
  return shiftDay(day, -weekday);
}

/** Günün ayının ilk günü. */
export function monthStart(day) {
  return `${day.slice(0, 7)}-01`;
}

/** Ayın son günü. */
export function monthEnd(day) {
  const start = new Date(time(monthStart(day)));
  return iso(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
}

/** Ayın ilk gününe ay ekler (yıl sınırı dâhil). */
function shiftMonth(day, count) {
  const start = new Date(time(monthStart(day)));
  return iso(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + count, 1));
}

/**
 * Adlı dönemin somut tarih çifti. Bilinmeyen ad ya da geçersiz gün `null` döner (çağıran reddeder; sessiz varsayılan yoktur).
 */
export function resolveWindow(window, today) {
  if (!isIsoDay(today)) return null;
  switch (window) {
    case 'today': return { dateFrom: today, dateTo: today };
    case 'yesterday': return { dateFrom: shiftDay(today, -1), dateTo: shiftDay(today, -1) };
    case 'this_week': { const from = weekStart(today); return { dateFrom: from, dateTo: shiftDay(from, 6) }; }
    case 'last_week': { const from = shiftDay(weekStart(today), -7); return { dateFrom: from, dateTo: shiftDay(from, 6) }; }
    case 'this_month': return { dateFrom: monthStart(today), dateTo: monthEnd(today) };
    case 'last_month': { const from = shiftMonth(today, -1); return { dateFrom: from, dateTo: monthEnd(from) }; }
    default: {
      if (!Object.hasOwn(ROLLING, window)) return null;
      const span = ROLLING[window];
      return span < 0 ? { dateFrom: shiftDay(today, span + 1), dateTo: today } : { dateFrom: today, dateTo: shiftDay(today, span - 1) };
    }
  }
}

/** Aralık tam bir takvim ayı mı (ayın ilk gününden son gününe)? */
function wholeMonth(range) {
  return range.dateFrom === monthStart(range.dateFrom) && range.dateTo === monthEnd(range.dateFrom);
}

/** Aralık tam bir takvim haftası mı (pazartesi–pazar)? */
function wholeWeek(range) {
  return range.dateFrom === weekStart(range.dateFrom) && dayDistance(range.dateFrom, range.dateTo) === 6;
}

/**
 * Bir önceki eşdeğer dönem. Tam takvim ayı önceki takvim ayıyla (gün sayıları farklı olabilir; aynı TÜR dönemdir), tam takvim
 * haftası önceki haftayla, başka her aralık aynı uzunlukta hemen önceki aralıkla eşleşir.
 */
export function previousWindow(range, { rolling = false } = {}) {
  if (!range || !isIsoDay(range.dateFrom) || !isIsoDay(range.dateTo) || range.dateFrom > range.dateTo) return null;
  // Kayan dönem ("son 30 gün") takvim ayına denk gelse de öncesi aynı uzunlukta aralıktır (önceki ay değil).
  if (!rolling && wholeMonth(range)) { const from = shiftMonth(range.dateFrom, -1); return { dateFrom: from, dateTo: monthEnd(from) }; }
  const length = windowLength(range);
  return { dateFrom: shiftDay(range.dateFrom, -length), dateTo: shiftDay(range.dateFrom, -1) };
}

/**
 * Dönemin bugüne göre konumu: `past` (son günü bugünden önce), `future` (ilk günü bugünden sonra) ya da `current` (bugünü içerir).
 * `current` dönemde `elapsedDays` bugün dâhil geçen gün sayısıdır; dönem henüz bitmemiştir (`open: true`) ve tam dönemle
 * karşılaştırıldığında bu fark söylenmelidir.
 */
export function windowPosition(range, today) {
  if (!range || !isIsoDay(today)) return null;
  const length = windowLength(range);
  if (range.dateTo < today) return { position: 'past', length, elapsedDays: length, open: false };
  if (range.dateFrom > today) return { position: 'future', length, elapsedDays: 0, open: true };
  const elapsedDays = dayDistance(range.dateFrom, today) + 1;
  return { position: 'current', length, elapsedDays, open: true };
}

/** Dönemin türü (anlatım ve karşılaştırılabilirlik için): gün, takvim haftası, takvim ayı ya da gün sayılı aralık. */
export function windowKind(range) {
  if (!range) return null;
  if (range.dateFrom === range.dateTo) return 'day';
  if (wholeWeek(range)) return 'week';
  if (wholeMonth(range)) return 'month';
  return 'range';
}

/**
 * İki dönem aynı türde ve karşılaştırılabilir uzunlukta mı? Takvim ayları gün sayıları farklı olsa da aynı türdür; başka
 * türlerde gün sayısı eşit olmalıdır. Karşılaştırılamayan çiftte yüzde değişim söylenmez (sayılar yan yana verilir, fark açıklanır).
 */
export function comparableWindows(left, right) {
  // Gün sayısı eşit iki dönem her zaman karşılaştırılabilir (kayan 30 gün, bir takvim ayına denk gelse de).
  if (windowLength(left) === windowLength(right)) return true;
  const kinds = [windowKind(left), windowKind(right)];
  return Boolean(kinds[0]) && kinds[0] === kinds[1] && kinds[0] === 'month';
}

/** İki aralık en az bir günü paylaşıyor mu? */
export function windowsOverlap(left, right) {
  return left.dateFrom <= right.dateTo && right.dateFrom <= left.dateTo;
}

/**
 * Dizinin kova boyu: açıkça istenmişse o; değilse aralık yaklaşık bir çeyreğe (92 gün) kadar haftalık, daha uzunsa aylık.
 */
export function defaultBucket(range, requested = null) {
  if (SERIES_BUCKETS.includes(requested)) return requested;
  return windowLength(range) <= SERIES_LIMITS.weekRangeDays ? 'week' : 'month';
}

/** Günün kova anahtarı: haftada haftanın pazartesisi (`YYYY-MM-DD`), ayda `YYYY-MM`. */
export function bucketKey(day, bucket) {
  return bucket === 'month' ? day.slice(0, 7) : weekStart(day);
}

/**
 * Aralığın kronolojik kovaları (boş kovalar dâhil: dizi süreklidir, eksik hafta sıfırdır — bilinmeyen değildir, çünkü sayım
 * aynı okumanın bütün nüfusundandır). Uçlardaki kova aralıkla kesişiyorsa `partial` işaretlenir (tam hafta/ay değildir).
 * Kova sayısı sınırı aşarsa `null` (dizi kurulmaz).
 */
export function seriesBuckets(range, bucket, today = null) {
  if (!range || !SERIES_BUCKETS.includes(bucket) || windowLength(range) > SERIES_LIMITS.maxRangeDays) return null;
  const out = [];
  let cursor = bucket === 'month' ? monthStart(range.dateFrom) : weekStart(range.dateFrom);
  while (cursor <= range.dateTo) {
    const end = bucket === 'month' ? monthEnd(cursor) : shiftDay(cursor, 6);
    const from = cursor < range.dateFrom ? range.dateFrom : cursor;
    const to = end > range.dateTo ? range.dateTo : end;
    out.push(Object.freeze({ key: bucketKey(cursor, bucket), dateFrom: from, dateTo: to, partial: from !== cursor || to !== end || Boolean(today && to >= today) }));
    if (out.length > SERIES_LIMITS.maxBuckets) return null;
    cursor = shiftDay(end, 1);
  }
  return Object.freeze(out);
}

const MONTHS_TR = Object.freeze(['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']);
const MONTHS_EN = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const monthName = (day, locale) => (locale === 'en' ? MONTHS_EN : MONTHS_TR)[Number(day.slice(5, 7)) - 1];
const dayNumber = (day) => String(Number(day.slice(8, 10)));

/**
 * Aralığın okunabilir yazımı: "9–15 Kasım 2026", "28 Aralık 2026 – 3 Ocak 2027", "Ekim 2026" (tam ay), "14 Kasım 2026" (tek gün).
 * Yıl her zaman yazılır: yıl sınırını aşan dönemlerde belirsizlik kalmaz.
 */
export function rangeLabel(range, locale = 'tr') {
  const { dateFrom: from, dateTo: to } = range;
  const year = (day) => day.slice(0, 4);
  if (from === to) return `${dayNumber(from)} ${monthName(from, locale)} ${year(from)}`;
  if (wholeMonth(range)) return `${monthName(from, locale)} ${year(from)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayNumber(from)}–${dayNumber(to)} ${monthName(from, locale)} ${year(from)}`;
  if (year(from) === year(to)) return `${dayNumber(from)} ${monthName(from, locale)} – ${dayNumber(to)} ${monthName(to, locale)} ${year(to)}`;
  return `${dayNumber(from)} ${monthName(from, locale)} ${year(from)} – ${dayNumber(to)} ${monthName(to, locale)} ${year(to)}`;
}

/** Kova etiketi: haftada haftanın aralığı ("9–15 Kas"), ayda ay adı ve yılı ("Kasım 2026"). Grafikte kısa, tabloda aynı. */
export function bucketLabel(bucket, kind, locale = 'tr') {
  if (kind === 'month') return `${monthName(`${bucket.key}-01`, locale)} ${bucket.key.slice(0, 4)}`;
  const short = (day) => `${dayNumber(day)} ${monthName(day, locale).slice(0, 3)}`;
  // Tek günlük (uçtaki kısmi) kova tek gündür: "16–16 Kas" değil "16 Kas".
  if (bucket.dateFrom === bucket.dateTo) return short(bucket.dateFrom);
  return bucket.dateFrom.slice(0, 7) === bucket.dateTo.slice(0, 7) ? `${dayNumber(bucket.dateFrom)}–${short(bucket.dateTo)}` : `${short(bucket.dateFrom)} – ${short(bucket.dateTo)}`;
}

/**
 * Sunucunun Türkçe ürettiği kova etiketinin İngilizce karşılığı ("3–9 Ağu" → "3–9 Aug", "Kasım 2026" → "November 2026"). Etiket
 * veridir değil sunucu metnidir; yalnızca ay adları çevrilir, sayılar ve aralık aynen kalır.
 */
export function englishBucketLabel(label) {
  return String(label).split(' ').map((token) => {
    const month = MONTHS_TR.indexOf(token);
    if (month >= 0) return MONTHS_EN[month];
    const short = MONTHS_TR.findIndex((name) => name.slice(0, 3) === token);
    return short >= 0 ? MONTHS_EN[short].slice(0, 3) : token;
  }).join(' ');
}

const WINDOW_NAMES = Object.freeze({
  today: ['bugün', 'today'], yesterday: ['dün', 'yesterday'], this_week: ['bu hafta', 'this week'], last_week: ['geçen hafta', 'last week'],
  this_month: ['bu ay', 'this month'], last_month: ['geçen ay', 'last month'], last_7_days: ['son 7 gün', 'the last 7 days'],
  last_14_days: ['son 14 gün', 'the last 14 days'], last_30_days: ['son 30 gün', 'the last 30 days'], next_7_days: ['önümüzdeki 7 gün', 'the next 7 days'],
  next_14_days: ['önümüzdeki 14 gün', 'the next 14 days'], next_30_days: ['önümüzdeki 30 gün', 'the next 30 days']
});

const WINDOW_ADVERBS = Object.freeze({
  today: ['bugün', 'today'], yesterday: ['dün', 'yesterday'], this_week: ['bu hafta', 'this week'], last_week: ['geçen hafta', 'last week'],
  this_month: ['bu ay', 'this month'], last_month: ['geçen ay', 'last month'], last_7_days: ['son 7 günde', 'in the last 7 days'],
  last_14_days: ['son 14 günde', 'in the last 14 days'], last_30_days: ['son 30 günde', 'in the last 30 days'], next_7_days: ['önümüzdeki 7 günde', 'in the next 7 days'],
  next_14_days: ['önümüzdeki 14 günde', 'in the next 14 days'], next_30_days: ['önümüzdeki 30 günde', 'in the next 30 days']
});

/**
 * Dönemin cümle içindeki zarf biçimi ("geçen hafta (2–8 Kasım 2026)", "son 14 günde (…)", adı yoksa "1–15 Ekim 2026 döneminde").
 * `preferred`: modelin bildirdiği adlı dönem; yalnızca aynı günleri gösteriyorsa kullanılır (pazar günü "bu hafta" ile "son 7 gün"
 * aynı günlerdir: kullanıcının sorduğu ad korunur). Ad yalnızca tarih eşitliğinden çıkar.
 */
export function windowAdverb(range, today, locale = 'tr', preferred = null) {
  const matches = (window) => { const resolved = window && resolveWindow(window, today); return Boolean(resolved && resolved.dateFrom === range.dateFrom && resolved.dateTo === range.dateTo); };
  const window = matches(preferred) ? preferred : namedWindow(range, today);
  const label = rangeLabel(range, locale);
  const lang = locale === 'en' ? 1 : 0;
  if (window) return `${WINDOW_ADVERBS[window][lang]} (${label})`;
  if (lang) {
    if (range.dateFrom === range.dateTo) return `on ${label}`;
    if (wholeMonth(range)) return `in ${label}`;
    const sameYear = range.dateFrom.slice(0, 4) === range.dateTo.slice(0, 4);
    const sameMonth = range.dateFrom.slice(0, 7) === range.dateTo.slice(0, 7);
    const from = sameMonth ? dayNumber(range.dateFrom) : `${dayNumber(range.dateFrom)} ${monthName(range.dateFrom, 'en')}${sameYear ? '' : ` ${range.dateFrom.slice(0, 4)}`}`;
    return `between ${from} and ${dayNumber(range.dateTo)} ${monthName(range.dateTo, 'en')} ${range.dateTo.slice(0, 4)}`;
  }
  return range.dateFrom === range.dateTo ? `${label} günü` : `${label} döneminde`;
}

/** Adlı dönemin sunucu adı ("geçen hafta"); bilinmeyen adda `null`. */
export function windowName(window, locale = 'tr') {
  return WINDOW_NAMES[window]?.[locale === 'en' ? 1 : 0] || null;
}

/**
 * Somut aralığın bugüne göre adı: aralık bir adlı dönemle BİREBİR aynı günleri gösteriyorsa o ad (ör. açık tarihlerle yazılmış
 * geçen hafta da "geçen hafta"dır); değilse `null`. Ad yalnızca tarih eşitliğinden çıkar; kullanıcı metni okunmaz.
 */
export function namedWindow(range, today) {
  if (!range || !isIsoDay(today)) return null;
  return TEMPORAL_WINDOWS.find((window) => {
    const resolved = resolveWindow(window, today);
    return resolved.dateFrom === range.dateFrom && resolved.dateTo === range.dateTo;
  }) || null;
}

/** Dönemin anlatımdaki tam yazımı: "geçen hafta (2–8 Kasım 2026)" ya da adı yoksa yalnızca aralık. */
export function windowPhrase(range, today, locale = 'tr') {
  const name = windowName(namedWindow(range, today), locale);
  const label = rangeLabel(range, locale);
  return name ? `${name} (${label})` : label;
}
