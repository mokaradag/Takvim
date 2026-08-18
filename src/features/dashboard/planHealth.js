import { diffDays, today } from '../../scheduling/dates/index.js';

/**
 * Plan sağlığı göstergeleri — Özet ve Raporlar sayfalarının ortak kaynağı.
 *
 * İki soruya yanıt verir:
 *  1. Geciken işler NE KADAR gecikti? Tek bir "9 geciken" sayısı, dün gecikmiş
 *     bir işle üç aydır bekleyen bir işi aynı kefeye koyar; PMO uygulamasında
 *     gecikme yaşlandırması (aging) bu yüzden ayrı raporlanır.
 *  2. Planın kendisi eksiksiz mi? Sorumlusu, termini ya da planlanan tarihi
 *     olmayan görev hiçbir ölçüme girmez ve sessizce kaybolur.
 *
 * Modül saftır ve tek başına sınanabilir.
 */

/** Gecikme yaşlandırma kovaları; sınırlar dahildir. */
export const OVERDUE_AGING_BUCKETS = Object.freeze([
  Object.freeze({ id: 'fresh', label: '1–7 gün', min: 1, max: 7, color: 'var(--c-amber)' }),
  Object.freeze({ id: 'stale', label: '8–30 gün', min: 8, max: 30, color: 'oklch(70% 0.16 50)' }),
  Object.freeze({ id: 'critical', label: '31–90 gün', min: 31, max: 90, color: 'var(--status-overdue)' }),
  Object.freeze({ id: 'chronic', label: '90+ gün', min: 91, max: Number.POSITIVE_INFINITY, color: 'oklch(48% 0.19 25)' })
]);

/**
 * Geciken görevleri gecikme yaşına göre kovalara ayırır.
 *
 * Gecikme ölçüsü `getStatus` ile aynıdır: tamamlanmamış ve hedef bitişi
 * referans günden önce olan görev gecikmiştir. Böylece kovaların toplamı
 * üstteki "Geciken" rozetiyle her zaman uyuşur.
 *
 * @param {Array<object>} tasks
 * @param {Date} [referenceDate]
 * @returns {{total: number, worstDays: number, buckets: Array<object>}}
 */
export function selectOverdueAging(tasks, referenceDate = today()) {
  const buckets = OVERDUE_AGING_BUCKETS.map((bucket) => ({ ...bucket, items: [] }));
  let worstDays = 0;

  for (const task of tasks || []) {
    if (!task || task.status === 'done' || !task.targetFinish) continue;
    const lateBy = -diffDays(task.targetFinish, referenceDate);
    if (lateBy < 1) continue;
    worstDays = Math.max(worstDays, lateBy);
    const bucket = buckets.find((entry) => lateBy >= entry.min && lateBy <= entry.max);
    if (bucket) bucket.items.push({ ...task, lateBy });
  }

  for (const bucket of buckets) bucket.items.sort((left, right) => right.lateBy - left.lateBy);

  return {
    total: buckets.reduce((sum, bucket) => sum + bucket.items.length, 0),
    worstDays,
    buckets: buckets.map((bucket) => ({ ...bucket, value: bucket.items.length }))
  };
}

/** Plan bütünlüğü denetimleri; her biri "eksik" görevleri toplar. */
export const PLAN_HYGIENE_CHECKS = Object.freeze([
  Object.freeze({
    id: 'assignee',
    label: 'Sorumlusuz görev',
    explain: 'Sorumlusu atanmamış görevin sahibi yoktur; ekip iş yükü tablosunda hiç görünmez.',
    isMissing: (task) => !(task.assigneeIds || []).length && !(task.sorumlu || []).length
  }),
  Object.freeze({
    id: 'targetFinish',
    label: 'Terminsiz görev',
    explain: 'Hedef bitişi olmayan görev ne gecikebilir ne de yaklaşan teslimlerde listelenebilir.',
    isMissing: (task) => !task.targetFinish
  }),
  Object.freeze({
    id: 'schedule',
    label: 'Tarihsiz görev',
    explain: 'Planlanan başlangıç veya bitişi olmayan görev Gantt ve kritik yol hesabına girmez.',
    isMissing: (task) => !task.plannedStart || !task.plannedFinish
  }),
  Object.freeze({
    id: 'wbs',
    label: 'Dağılım ağacına bağlanmamış görev',
    explain: 'Dağılım düğümü olmayan görev proje yapısı toplulaştırmalarında sayılmaz.',
    isMissing: (task) => !task.wbsId
  })
]);

/**
 * Açık (tamamlanmamış) görevler üzerinde plan bütünlüğü denetimlerini uygular.
 *
 * Tamamlanmış görevler DIŞARIDA bırakılır: kapanmış bir işin eksik terminini
 * bugün düzeltmek bir eylem üretmez, listeyi ise kullanılamaz hâle getirir.
 *
 * @returns {{openCount: number, cleanCount: number, checks: Array<object>}}
 */
export function selectPlanHygiene(tasks) {
  const open = (tasks || []).filter((task) => task && task.status !== 'done');
  const flagged = new Set();

  const checks = PLAN_HYGIENE_CHECKS.map((check) => {
    const items = open.filter((task) => check.isMissing(task));
    for (const task of items) flagged.add(task.id);
    return { id: check.id, label: check.label, explain: check.explain, value: items.length, items };
  });

  return {
    openCount: open.length,
    cleanCount: open.length - flagged.size,
    checks
  };
}
