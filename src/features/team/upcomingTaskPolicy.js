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
 * @param {object} task
 * @param {Date} [referenceDate]
 * @returns {{due: string|null, days: number|null, tone: object, text: string}}
 */
export function dueTone(task, referenceDate = today()) {
  const due = task?.targetFinish || task?.plannedFinish || null;
  if (!due) return { due: null, days: null, tone: DAY_TONE.later, text: 'Tarih yok' };

  const days = diffDays(due, referenceDate);
  // Bugün biten iş de gecikme rengini alır: gün bitmeden yapılması gerekir.
  if (days < 0) return { due, days, tone: DAY_TONE.overdue, text: `${Math.abs(days)} gün gecikti` };
  if (days === 0) return { due, days, tone: DAY_TONE.overdue, text: 'Bugün' };
  if (days === 1) return { due, days, tone: DAY_TONE.soon, text: 'Yarın' };
  if (days <= 7) return { due, days, tone: DAY_TONE.soon, text: `${days} gün` };
  return { due, days, tone: DAY_TONE.later, text: `${days} gün` };
}
