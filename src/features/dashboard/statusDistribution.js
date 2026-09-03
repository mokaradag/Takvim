import { getStatus } from '../../scheduling/metrics/index.js';
import { today } from '../../scheduling/dates/index.js';

/**
 * Özet sayfasındaki "Durum dağılımı" halkasının veri kaynağı.
 *
 * Halka grafiği yalnızca BİRBİRİNİ DIŞLAYAN kovalarla doğru çizilir. Önceki
 * hesap "Yapılacak" ve "Devam eden" kovalarını durum alanından, "Geciken"
 * kovasını ise hedef tarihinden türetiyordu; geciken bir görev aynı anda iki
 * kovaya birden düştüğü için dilimlerin toplamı görev sayısını aşıyor, halka
 * 360 dereceyi geçip kendi üzerine biniyordu (44 görev için 54 birim).
 *
 * Burada kova, uygulamanın her yerinde kullanılan tek doğruluk kaynağı olan
 * `getStatus` üzerinden belirlenir: bir görev tam olarak bir kovaya girer ve
 * dilimlerin toplamı her zaman görev sayısına eşittir.
 */

export const STATUS_DISTRIBUTION_BUCKETS = Object.freeze([
  Object.freeze({
    id: 'done',
    label: 'Tamamlanan',
    color: 'var(--status-done)',
    explain: 'Durumu “Tamamlandı” olarak işaretlenmiş görevler.'
  }),
  Object.freeze({
    id: 'in_progress',
    label: 'Devam eden',
    color: 'var(--status-progress)',
    explain: 'Aktif olarak üzerinde çalışılan, hedef tarihi geçmemiş görevler.'
  }),
  Object.freeze({
    id: 'todo',
    label: 'Yapılacak',
    color: 'var(--status-todo)',
    explain: 'Henüz başlanmamış, hedef tarihi geçmemiş görevler.'
  }),
  Object.freeze({
    id: 'overdue',
    label: 'Geciken',
    color: 'var(--status-overdue)',
    explain: 'Hedef tarihi geçmiş ve hâlâ tamamlanmamış görevler.'
  })
]);

/**
 * Görevleri birbirini dışlayan durum kovalarına ayırır.
 *
 * @param {Array<object>} tasks görev listesi
 * @param {Date} [referenceDate] gecikme karşılaştırması için referans gün
 * @returns {{ total: number, segments: Array<object>, completionRate: number }}
 *   `segments` yalnızca değeri sıfırdan büyük kovaları içerir ve değerlerinin
 *   toplamı her zaman `total` değerine eşittir.
 */
export function selectStatusDistribution(tasks, referenceDate = today()) {
  const list = Array.isArray(tasks) ? tasks : [];
  const items = new Map(STATUS_DISTRIBUTION_BUCKETS.map((bucket) => [bucket.id, []]));

  for (const task of list) {
    if (!task) continue;
    const bucketId = getStatus(task, referenceDate).id;
    (items.get(bucketId) || items.get('todo')).push(task);
  }

  const done = items.get('done').length;
  const segments = STATUS_DISTRIBUTION_BUCKETS
    .map((bucket) => ({ ...bucket, value: items.get(bucket.id).length, items: items.get(bucket.id) }))
    .filter((segment) => segment.value > 0);
  // `total`, SINIFLANDIRILAN görev sayısıdır. `list.length` kullanıldığında
  // döngünün atladığı boş girdiler de sayılıyor, belgelenen "dilim değerlerinin
  // toplamı her zaman total'e eşittir" kuralı bozuluyordu: halkada açıklanamayan
  // bir boşluk kalıyor ve tamamlanma oranı şişmiş bir paydaya bölünüyordu.
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return {
    total,
    segments,
    completionRate: total ? Math.round((done / total) * 100) : 0
  };
}
