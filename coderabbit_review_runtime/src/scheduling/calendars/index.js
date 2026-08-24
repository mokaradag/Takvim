import { addDays, fmtISO, isValidDate, parseDate } from '../dates/index.js';

export const DEFAULT_WORKING_DAYS = Object.freeze([1, 2, 3, 4, 5]);

/**
 * VARSAYILAN takvimin resmî tatilleri.
 *
 * Liste yalnızca 2026'yı kapsıyordu: 2027 ve sonrasına planlanan her tarih
 * sıradan iş günü sayılıyor, `getTaskCalendarWarnings` uyarı üretmiyor ve çok
 * yıllı planlarda `addWorkingDays` kapasiteyi olduğundan fazla gösteriyordu.
 *
 * SABİT TARİHLİ ulusal bayramlar 2027 ve 2028 için de eklendi. Dinî bayramlar
 * (Ramazan, Kurban) ay takvimine bağlıdır ve resmî ilanla kesinleşir; bu yüzden
 * buraya TAHMİN yazılmaz, kurulumun kendi takvim tanımından okunur
 * (`MR_CalendarHolidays`). Kurumsal kurulumlarda proje takvimi zaten
 * veritabanından gelir; bu liste yalnızca Demo Modu ve yedek takvim içindir.
 */
export const TURKEY_HOLIDAYS_2026 = Object.freeze([
  { date: '2026-01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '2026-03-20', name: 'Ramazan Bayramı (1. Gün)', short: 'Ramazan B.' },
  { date: '2026-03-21', name: 'Ramazan Bayramı (2. Gün)', short: 'Ramazan B.' },
  { date: '2026-03-22', name: 'Ramazan Bayramı (3. Gün)', short: 'Ramazan B.' },
  { date: '2026-04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '2026-05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '2026-05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '2026-05-27', name: 'Kurban Bayramı (1. Gün)', short: 'Kurban B.' },
  { date: '2026-05-28', name: 'Kurban Bayramı (2. Gün)', short: 'Kurban B.' },
  { date: '2026-05-29', name: 'Kurban Bayramı (3. Gün)', short: 'Kurban B.' },
  { date: '2026-05-30', name: 'Kurban Bayramı (4. Gün)', short: 'Kurban B.' },
  { date: '2026-07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '2026-08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '2026-10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' },

  { date: '2027-01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '2027-04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '2027-05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '2027-05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '2027-07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '2027-08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '2027-10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' },

  { date: '2028-01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '2028-04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '2028-05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '2028-05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '2028-07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '2028-08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '2028-10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' }
]);

export const DEFAULT_CALENDAR = Object.freeze({
  id: 'cal-tr-standard-2026',
  name: 'Türkiye Standart Çalışma Takvimi 2026',
  timezone: 'Europe/Istanbul',
  workingDays: DEFAULT_WORKING_DAYS,
  holidays: TURKEY_HOLIDAYS_2026
});

/**
 * Takvim taraması için ÜST SINIR (yaklaşık on yıl).
 *
 * Çalışma günü aramaları koşulsuz `while` döngüleriydi: hiçbir gün çalışma
 * günü değilse döngü hiç bitmiyor ve tarayıcı sekmesi tamamen donuyordu.
 * Sınır, bozuk bir takvimi hatalı sonuca değil, GİRİŞ TARİHİNE düşürür.
 */
const MAX_CALENDAR_SCAN_DAYS = 3660;

function localDate(value) {
  const date = parseDate(value);
  if (!isValidDate(date)) return date;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Takvimin ÇALIŞILAN günleri.
 *
 * BOŞ liste varsayılan haftaya düşer. Sunucu, `MR_CalendarWorkingDays`
 * tablosunda satırı olmayan takvimi `workingDays: []` olarak yansıtıyor
 * (bkz. sqlAppRepository); `[] || DEFAULT_WORKING_DAYS` boş listeyi koruduğu
 * için `isWorkingDay` HER GÜN için `false` dönüyor, görev oluşturma ve
 * güncelleme sırasındaki iş günü aramaları sonsuz döngüye giriyordu.
 */
function workingDaysOf(calendar) {
  const days = calendar?.workingDays;
  return Array.isArray(days) && days.length ? days : DEFAULT_WORKING_DAYS;
}

export function normalizeCalendar(calendar = DEFAULT_CALENDAR) {
  return {
    id: calendar.id || DEFAULT_CALENDAR.id,
    name: calendar.name || DEFAULT_CALENDAR.name,
    timezone: calendar.timezone || DEFAULT_CALENDAR.timezone,
    workingDays: [...workingDaysOf(calendar)],
    holidays: (calendar.holidays || []).map((holiday) => ({ ...holiday }))
  };
}

export function calendarById(calendars, calendarId) {
  return (calendars || []).find((calendar) => calendar.id === calendarId) || null;
}

export function resolveProjectCalendar(project, calendars, fallback = DEFAULT_CALENDAR) {
  return calendarById(calendars, project?.calendarId) || fallback;
}

export function resolveTaskCalendar(task, projects, calendars, fallback = DEFAULT_CALENDAR) {
  const taskCalendar = calendarById(calendars, task?.calendarId);
  if (taskCalendar) return taskCalendar;
  const project = (projects || []).find((item) => item.id === task?.projectId || item.name === task?.proje) || null;
  return resolveProjectCalendar(project, calendars, fallback);
}

export function holidayFor(value, calendar = DEFAULT_CALENDAR) {
  const date = localDate(value);
  if (!isValidDate(date)) return null;
  const key = fmtISO(date);
  return (calendar?.holidays || []).find((holiday) => holiday.date === key) || null;
}

export function isWorkingDay(value, calendar = DEFAULT_CALENDAR) {
  const date = localDate(value);
  // Çözülemeyen tarih çalışma günü DEĞİLDİR; aramalar bu durumu sınırla ayıklar.
  if (!isValidDate(date)) return false;
  return workingDaysOf(calendar).includes(date.getDay()) && !holidayFor(date, calendar);
}

/**
 * Verilen günü en yakın ÇALIŞMA gününe taşır.
 *
 * Tarama sınırlıdır: çözülemeyen bir tarih ya da hiçbir günü çalışma günü
 * olmayan bir takvim, girişin kendisiyle döner. Sınırsız arama, "Yeni görev"
 * düğmesine basıldığında uygulamayı kilitliyordu.
 */
export function moveToWorkingDay(value, calendar = DEFAULT_CALENDAR, direction = 1) {
  const step = direction < 0 ? -1 : 1;
  const origin = localDate(value);
  if (!isValidDate(origin)) return origin;

  let current = origin;
  for (let scanned = 0; scanned <= MAX_CALENDAR_SCAN_DAYS; scanned += 1) {
    if (isWorkingDay(current, calendar)) return current;
    current = addDays(current, step);
  }
  return origin;
}

export function addWorkingDays(value, amount, calendar = DEFAULT_CALENDAR) {
  const numericAmount = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  const origin = localDate(value);
  if (numericAmount === 0 || !isValidDate(origin)) return origin;

  const direction = numericAmount < 0 ? -1 : 1;
  let remaining = Math.abs(numericAmount);
  let current = origin;
  let scanned = 0;

  while (remaining > 0) {
    // Tarama sınırı: çalışma günü bulunamayan takvimde döngü sonsuza gitmez.
    if (scanned >= MAX_CALENDAR_SCAN_DAYS) return origin;
    scanned += 1;
    current = addDays(current, direction);
    if (isWorkingDay(current, calendar)) remaining -= 1;
  }

  return current;
}

export function diffWorkingDays(a, b, calendar = DEFAULT_CALENDAR) {
  const target = localDate(a);
  let current = localDate(b);
  // Geçersiz tarihte `getTime()` NaN'dir: eşitlik hiç sağlanmaz ve döngü
  // sonsuza kadar sürerdi.
  if (!isValidDate(target) || !isValidDate(current)) return 0;

  const targetTime = target.getTime();
  const currentTime = current.getTime();
  if (targetTime === currentTime) return 0;

  const direction = targetTime > currentTime ? 1 : -1;
  let difference = 0;
  let scanned = 0;

  while (current.getTime() !== targetTime) {
    if (scanned >= MAX_CALENDAR_SCAN_DAYS) break;
    scanned += 1;
    current = addDays(current, direction);
    if (isWorkingDay(current, calendar)) difference += direction;
  }

  return difference;
}

export function countWorkingDays(start, end, calendar = DEFAULT_CALENDAR) {
  let first = localDate(start);
  let last = localDate(end);
  if (!isValidDate(first) || !isValidDate(last)) return 0;
  let sign = 1;

  if (first > last) {
    [first, last] = [last, first];
    sign = -1;
  }

  let count = 0;
  let current = first;
  let scanned = 0;
  while (current <= last) {
    if (scanned >= MAX_CALENDAR_SCAN_DAYS) break;
    scanned += 1;
    if (isWorkingDay(current, calendar)) count += 1;
    current = addDays(current, 1);
  }

  return count * sign;
}
