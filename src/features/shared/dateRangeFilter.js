// Açık dosya yolu: Node ESM dizin içe aktarımını çözmez ve bu modül doğrudan
// sınanır.
import { addDays, fmtISO, parseDate } from '../../scheduling/dates/index.js';

/**
 * Özet ve Raporlar sayfalarının ORTAK tarih aralığı süzgeci.
 *
 * Her iki sayfa da çalışma alanının TAMAMINI özetliyordu: kurulum yaşlandıkça
 * kartlar, halkalar ve tablolar yıllar önce kapanmış görevleri de sayıyor,
 * "geçen ay ne oldu" sorusu okunamaz hâle geliyordu. Aralık, görevin ETKİN
 * OLDUĞU pencereyle kesişime bakar: bir görev seçilen aralıkta herhangi bir gün
 * açıksa sayılır.
 *
 * Mantık burada, çizimden AYRI tutulur; iki sayfa da aynı kuralı uygular ve
 * kural sınanabilir kalır.
 */

/** Süzgeç ön ayarları. `all` süzgeci kapatır. */
export const DATE_RANGE_PRESETS = Object.freeze([
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'last90', label: 'Son 90 gün' },
  { id: 'thisYear', label: 'Bu yıl' },
  { id: 'all', label: 'Tümü' },
  { id: 'custom', label: 'Özel' }
]);

export const DEFAULT_DATE_RANGE_PRESET = 'all';

/**
 * Ön ayarı somut bir aralığa çevirir.
 *
 * @param {string} preset ön ayar kimliği
 * @param {Date|string} referenceDate bugünün yerine geçen referans gün
 * @returns {{start: string, end: string}|null} `null` = süzgeç yok
 */
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

/**
 * Geçerli bir ISO gün değeri mi?
 *
 * TAŞAN takvim günü reddedilir. `parseDate('2026-02-30')` hata vermez, 2 Mart
 * 2026'ya TAŞAR ve sonlu bir zaman damgası taşır; yalnızca `getTime()`
 * denetlenirse böyle bir değer geçerli sayılır. Sonuç, kullanıcının
 * göremeyeceği bir tutarsızlıktır: `2026-02-30` → `2026-03-01` özel aralığı,
 * normalleşmiş başlangıcı bitişinden SONRA olmasına rağmen kabul edilirdi.
 * Bu yüzden çözümlenen tarihin aynı güne geri biçimlenmesi şart koşulur.
 */
function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsed = parseDate(day);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return fmtISO(parsed) === day ? day : null;
}

/**
 * Görevin ETKİN olduğu pencere.
 *
 * Plan tarihleri esastır; eksikse hedef ve gerçekleşen tarihler devreye girer.
 * Hiçbir tarihi olmayan görev `null` döner ve aralık süzgecinden ETKİLENMEZ:
 * tarihsiz bir kayıt sessizce kaybolsaydı toplamlar açıklanamaz biçimde
 * düşerdi.
 */
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

/** Görev pencere ile KESİŞİYOR mu? */
export function taskMatchesDateRange(task, range) {
  if (!range?.start || !range?.end) return true;
  const window = taskActivityWindow(task);
  // Tarihsiz görev her aralıkta görünür (bkz. `taskActivityWindow`).
  if (!window) return true;
  return window.start <= range.end && window.end >= range.start;
}

/** Görev listesini aralığa göre süzer. */
export function filterTasksByDateRange(tasks, range) {
  if (!range?.start || !range?.end) return tasks || [];
  return (tasks || []).filter((task) => taskMatchesDateRange(task, range));
}

/**
 * Denetimin durumundan uygulanacak aralığı üretir.
 *
 * @param {{preset: string, start: string, end: string}} selection
 * @param {Date|string} referenceDate
 */
export function resolveDateRangeSelection(selection, referenceDate) {
  const preset = selection?.preset || DEFAULT_DATE_RANGE_PRESET;
  if (preset === 'custom') {
    const start = isoDay(selection?.start);
    const end = isoDay(selection?.end);
    // Yarım bırakılmış özel aralık süzmez: kullanıcı ikinci tarihi girerken
    // tablo bir anlığına boşalmamalıdır.
    if (!start || !end || start > end) return null;
    return { start, end };
  }
  return resolveDateRangePreset(preset, referenceDate);
}

/** Aralığı insan okunur biçimde özetler. */
export function describeDateRange(range) {
  if (!range?.start || !range?.end) return 'Tüm zamanlar';
  return `${range.start} – ${range.end}`;
}
