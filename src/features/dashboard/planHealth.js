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
  // Etiket sınıflandırmayla birebir uyuşur: 90 gün geciken iş bir üstteki
  // kovadadır, bu kova 91. günde başlar.
  Object.freeze({ id: 'chronic', label: '91+ gün', min: 91, max: Number.POSITIVE_INFINITY, color: 'oklch(48% 0.19 25)' })
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
    // Çözülemeyen `targetFinish` NaN üretir ve `NaN < 1` yanlış olduğu için
    // eskiden bu koruma devreye girmiyordu: `worstDays` NaN'e sabitleniyor,
    // kova araması boş dönüyor ve gösterge panelinde "en büyük gecikme" NaN
    // olarak çiziliyordu.
    if (!Number.isFinite(lateBy) || lateBy < 1) continue;
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

/**
 * Kişi dizinini kimlik ve ada göre indeksler.
 *
 * Dizin verilmezse `null` döner ve sorumlu çözümü yalnızca alanın dolu olup
 * olmadığına bakar: dizini olmayan bir çağıran için eski davranış korunur.
 */
function buildPeopleIndex(people) {
  if (!Array.isArray(people) || !people.length) return null;
  const byId = new Set();
  const byName = new Map();
  for (const person of people) {
    if (!person) continue;
    if (person.id != null) byId.add(String(person.id));
    const name = String(person.name || '').trim().toLocaleLowerCase('tr-TR');
    if (name) byName.set(name, (byName.get(name) || 0) + 1);
  }
  return { byId, byName };
}

/** Göreve gerçekten çözülebilen sorumlu sayısı. */
function resolvedAssigneeCount(task, context = {}) {
  const index = context?.peopleIndex || null;
  const ids = (task?.assigneeIds || []).map((value) => String(value));
  const names = (task?.sorumlu || []).map((value) => String(value || '').trim());
  if (!index) return ids.length ? new Set(ids.filter(Boolean)).size : new Set(names.filter(Boolean)).size;
  const resolved = new Set();
  for (const id of ids) if (index.byId.has(id)) resolved.add(`id:${id}`);
  if (ids.length || task?.assigneeIdsCanonical) return resolved.size;
  for (const name of names) {
    const key = name.toLocaleLowerCase('tr-TR');
    if (key && index.byName.get(key) === 1) resolved.add(`name:${key}`);
  }
  return resolved.size;
}

/** Plan bütünlüğü denetimleri; her biri "eksik" görevleri toplar. */
export const PLAN_HYGIENE_CHECKS = Object.freeze([
  Object.freeze({
    id: 'assignee',
    label: 'Sorumlusuz görev',
    explain: 'Sorumlusu atanmamış görevin sahibi yoktur; ekip iş yükü tablosunda hiç görünmez.',
    // Alanın DOLU olması yetmez: Ekip sayfası sorumluları kişi dizininden
    // çözer ve eşleşmeyen referansları düşürür. Eski bir Sicil ya da artık
    // kimseye karşılık gelmeyen bir ad, bu denetim yalnızca alana baksaydı
    // "sağlıklı" görünür, görev ise iş yükü tablosundan tam olarak bu
    // açıklamanın uyardığı gibi kaybolurdu.
    isMissing: (task, context) => !resolvedAssigneeCount(task, context)
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
export function selectPlanHygiene(tasks, people = null) {
  const open = (tasks || []).filter((task) => task && task.status !== 'done');
  const flagged = new Set();
  const context = { peopleIndex: buildPeopleIndex(people) };

  const checks = PLAN_HYGIENE_CHECKS.map((check) => {
    const items = open.filter((task) => check.isMissing(task, context));
    for (const task of items) flagged.add(task.id);
    return { id: check.id, label: check.label, explain: check.explain, value: items.length, items };
  });

  return {
    openCount: open.length,
    cleanCount: open.length - flagged.size,
    checks
  };
}
