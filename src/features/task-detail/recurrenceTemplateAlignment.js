import { addDays, diffDays, fmtISO, parseDate } from '../../scheduling/dates/index.js';
import { expandRecurrence, normalizeRecurrenceRule } from '../../scheduling/recurrence/index.js';

/**
 * Şablonun başlangıcını (RFC 5545 `DTSTART`) tekrar kuralıyla eşitler.
 *
 * RFC 5545, `DTSTART` kuralla senkron değilken yineleme kümesini TANIMSIZ sayar.
 * Uygulama kuralın dışında kalan şablon gününü seriye almıyor ama kuralı yine de
 * RRULE olarak gösterip dışa aktarıyordu: aynı kuralı okuyan başka bir takvim
 * uygulaması seriyi farklı açabilirdi.
 *
 * Bu yüzden gün seçimi kullanıcının serbestliğinde kalır, şablonun başlangıcı
 * ise kuralın İLK yinelemesine taşınır. Planlanan bitiş ve termin aynı gün
 * farkıyla kaydırılır; aksi hâlde bitiş başlangıçtan önceye düşüp kalıcılaştırma
 * doğrulamasını kırardı.
 *
 * @param {object} task şablon görev
 * @param {object|string} rule kanonik kural ya da RRULE metni
 * @returns {{plannedStart: string, plannedFinish?: string, targetFinish?: string, shiftDays: number}|null}
 *   Kaydırma gerekmiyorsa `null`.
 */
export function planTemplateStartAlignment(task, rule) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized || !task?.plannedStart) return null;
  const first = expandRecurrence(normalized, { start: task.plannedStart, limit: 1 })[0] || null;
  if (!first || first === task.plannedStart) return null;

  const shiftDays = diffDays(first, task.plannedStart);
  if (!Number.isFinite(shiftDays) || shiftDays <= 0) return null;

  const shifted = (value) => (value ? fmtISO(addDays(parseDate(value), shiftDays)) : value);
  const patch = { plannedStart: first, shiftDays };
  if (task.plannedFinish) patch.plannedFinish = shifted(task.plannedFinish);
  if (task.targetFinish) patch.targetFinish = shifted(task.targetFinish);
  return patch;
}
