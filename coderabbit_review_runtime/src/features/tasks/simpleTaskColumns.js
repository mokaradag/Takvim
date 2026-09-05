/**
 * Temel Kip Görevler tablosunun sütun sözleşmesi.
 *
 * Temel Kip, Kapsamlı Kipin tam tablosunu göstermez. Görünen alanlar
 * "Hızlı Görev Tanımı" ile TOPLANAN bilgilerdir; toplanmayan (ve Temel Kipte
 * anlamı olmayan) planlama alanları listeden dışarıda kalır. Sözleşme
 * görünümden ayrı tutulur ki gerileme testleri sütun kümesini doğrudan
 * sınayabilsin.
 */

export const SIMPLE_TASK_COLUMNS = Object.freeze([
  Object.freeze({ id: 'proje', label: 'Proje', field: 'proje' }),
  Object.freeze({ id: 'task', label: 'Görev', field: 'task' }),
  Object.freeze({ id: 'keyword', label: 'Kısa açıklama', field: 'keyword' }),
  Object.freeze({ id: 'sorumlu', label: 'Sorumlular', field: 'sorumlu' }),
  Object.freeze({ id: 'priority', label: 'Öncelik', field: 'priority' }),
  Object.freeze({ id: 'status', label: 'Durum', field: 'status' }),
  Object.freeze({ id: 'targetFinish', label: 'Termin', field: 'targetFinish' })
]);

/**
 * Temel Kipte GÖSTERİLMEYEN, yalnızca Kapsamlı Kipe ait alanlar.
 *
 * Bu alanlar Hızlı Görev Tanımı'nda hiç toplanmaz; Temel Kip kullanıcısı için
 * ya boştur ya da yanıltıcıdır (ilerleme yüzdesi, efor saatleri, planlanan
 * başlangıç/bitiş, iş dağılım ağacı bağlantısı, bağımlılıklar, tekrar kuralı,
 * bütçe).
 */
export const ADVANCED_ONLY_TASK_FIELDS = Object.freeze([
  'progress',
  'plannedHours',
  'actualHours',
  'plannedStart',
  'plannedFinish',
  'plannedDurationDays',
  'remainingDurationDays',
  'actualStart',
  'actualFinish',
  'deps',
  'recurrence',
  'wbsId',
  'budget',
  'spent',
  'milestone'
]);

/** Temel Kip tablosunda bir sütun gösterilir mi? */
export function isSimpleTaskColumn(field) {
  return SIMPLE_TASK_COLUMNS.some((column) => column.field === field);
}

/**
 * Temel Kip görev kaydının GÖSTERİLEBİLİR alanları.
 *
 * Kapsamlı kipe ait alanlar bilinçli olarak DÜŞÜRÜLÜR: aynı görev kaydı iki
 * kipte de aynı veriyi taşır, yalnızca sunum sadeleşir.
 */
export function simpleTaskProjection(task) {
  const projection = {};
  for (const column of SIMPLE_TASK_COLUMNS) projection[column.field] = task?.[column.field] ?? null;
  return projection;
}
