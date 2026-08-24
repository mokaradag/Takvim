import { diffDays, today } from '../../scheduling/dates/index.js';

/**
 * Personel penceresindeki "Yakın görevler" listesinin aciliyet ilkeleri.
 *
 * Görünümden ayrı tutulur: bir görevin ne kadar acil olduğu saf bir dönüşümdür
 * ve tek başına sınanabilir.
 */

const DAY_TONE = Object.freeze({
  overdue: Object.freeze({ id: 'overdue', color: 'var(--status-overdue)' }),
  soon: Object.freeze({ id: 'soon', color: 'var(--c-amber)' }),
  later: Object.freeze({ id: 'later', color: 'var(--text-muted)' })
});

/**
 * Bir görevin ilgili tarihini, kalan gününü ve aciliyet tonunu çözer.
 *
 * İlgili tarih önce HEDEF bitiştir; yoksa planlanan bitişe düşülür. İkisi de
 * yoksa görev tarihsizdir — uydurma bir tarihle listeye sokulmaz.
 *
 * GECİKME SINIFLANDIRMASI yalnızca HEDEF bitişe bakar. Uygulamanın kanonik
 * `overdue` durumu ve Ekip sayfasının "geciken" ölçümü de böyle çalışır:
 * termini olmayan bir görev gecikemez. Planlanan bitiş yalnızca NÖTR bir tarih
 * yedeğidir; aksi hâlde bu pencere kırmızı "N gün gecikti" yazarken yanındaki
 * durum rozeti "Yapılacak" diyor ve personelin geciken sayısı bu görevi hiç
 * saymıyordu.
 *
 * @param {object} task
 * @param {Date} [referenceDate]
 * @returns {{due: string|null, days: number|null, tone: object, text: string}}
 */
export function dueTone(task, referenceDate = today()) {
  const target = task?.targetFinish || null;
  const due = target || task?.plannedFinish || null;
  if (!due) return { due: null, days: null, tone: DAY_TONE.later, text: 'Tarih yok' };

  const days = diffDays(due, referenceDate);
  if (!target) {
    // Termin yok: geçmiş bir planlanan bitiş gecikme olarak sunulmaz.
    if (days < 0) return { due, days, tone: DAY_TONE.later, text: `Planlanan bitiş ${Math.abs(days)} gün önceydi` };
    if (days === 0) return { due, days, tone: DAY_TONE.later, text: 'Planlanan bitiş bugün' };
    if (days === 1) return { due, days, tone: DAY_TONE.soon, text: 'Planlanan bitiş yarın' };
    if (days <= 7) return { due, days, tone: DAY_TONE.soon, text: `Planlanan bitişe ${days} gün` };
    return { due, days, tone: DAY_TONE.later, text: `Planlanan bitişe ${days} gün` };
  }
  // Bugün biten iş de gecikme rengini alır: gün bitmeden yapılması gerekir.
  if (days < 0) return { due, days, tone: DAY_TONE.overdue, text: `${Math.abs(days)} gün gecikti` };
  if (days === 0) return { due, days, tone: DAY_TONE.overdue, text: 'Bugün' };
  if (days === 1) return { due, days, tone: DAY_TONE.soon, text: 'Yarın' };
  if (days <= 7) return { due, days, tone: DAY_TONE.soon, text: `${days} gün` };
  return { due, days, tone: DAY_TONE.later, text: `${days} gün` };
}
