import { addDays, diffDays, fmtISO, parseDate } from '../../scheduling/dates/index.js';
import { addWorkingDays, diffWorkingDays, moveToWorkingDay } from '../../scheduling/calendars/index.js';
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
 * ise kuralın İLK yinelemesine taşınır.
 *
 * Planlanan bitiş, ÇALIŞMA GÜNÜ süresi korunarak yeniden hesaplanır. Ham takvim
 * farkı kullanıldığında Pzt–Cum takvimli bir projede Cuma→Pazartesi kayması 3
 * takvim günü sayılıyor, Pazartesi biten 2 iş günlük görev Perşembeye taşınıyor
 * ve süre sessizce 4 iş gününe çıkıyordu. Takvim verilmediğinde eski davranış
 * (ham gün farkı) sürer; bitiş her koşulda başlangıçtan önceye düşemez, aksi
 * hâlde kalıcılaştırma doğrulaması kırılırdı.
 *
 * Termin bir TAAHHÜT tarihidir, iş günü süresi taşımaz; o yüzden aynı takvim
 * günü farkıyla kayar.
 *
 * @param {object} task şablon görev
 * @param {object|string} rule kanonik kural ya da RRULE metni
 * @param {{calendar?: object|null}} [options] görevin çalışma takvimi
 * @returns {{plannedStart: string, plannedFinish?: string, targetFinish?: string, shiftDays: number}|null}
 *   Kaydırma gerekmiyorsa `null`.
 */
export function planTemplateStartAlignment(task, rule, { calendar = null } = {}) {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized || !task?.plannedStart) return null;
  const first = expandRecurrence(normalized, { start: task.plannedStart, limit: 1 })[0] || null;
  if (!first || first === task.plannedStart) return null;

  const shiftDays = diffDays(first, task.plannedStart);
  if (!Number.isFinite(shiftDays) || shiftDays <= 0) return null;

  const shifted = (value) => (value ? fmtISO(addDays(parseDate(value), shiftDays)) : value);
  const patch = { plannedStart: first, shiftDays };
  if (task.plannedFinish) {
    patch.plannedFinish = calendar
      ? alignFinishByWorkingDays(task.plannedStart, task.plannedFinish, first, calendar)
      : shifted(task.plannedFinish);
  }
  if (task.targetFinish) patch.targetFinish = shifted(task.targetFinish);
  return patch;
}

/** Bitişi, mevcut çalışma günü süresini koruyarak yeni başlangıca taşır. */
function alignFinishByWorkingDays(oldStart, oldFinish, newStart, calendar) {
  // Süre, çalışma takviminde ölçülür. Başlangıç ya da bitiş tatile denk
  // geliyorsa ölçüm en yakın iş gününden yapılır; aksi hâlde tatile düşmüş bir
  // uç, süreyi olduğundan kısa gösterirdi.
  // Başlangıç İLERİ, bitiş GERİ hizalanır. İki uç da ileri taşınınca, bitişi
  // tatile denk gelen bir görev (Pzt–Paz görev, Pzt–Cum takvimi) bitişi bir
  // sonraki Pazartesiye kayıyor ve süre beş iş gününden ALTIYA çıkıyordu; bitişi
  // geri hizalamak ölçülen süreyi görevin gerçekten çalışılan günleriyle
  // sınırlar.
  const measuredStart = fmtISO(moveToWorkingDay(parseDate(oldStart), calendar, 1));
  const measuredFinish = fmtISO(moveToWorkingDay(parseDate(oldFinish), calendar, -1));
  const workingSpan = Math.max(0, diffWorkingDays(measuredFinish, measuredStart, calendar));
  const alignedStart = moveToWorkingDay(parseDate(newStart), calendar, 1);
  const shiftedFinish = addWorkingDays(alignedStart, workingSpan, calendar);
  // Ufku aşan süre `null` bildirir; hizalanmış başlangıç en güvenli sonuçtur.
  const finish = fmtISO(shiftedFinish ?? alignedStart);
  return finish < newStart ? newStart : finish;
}
