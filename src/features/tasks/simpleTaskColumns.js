/**
 * Basit Mod Görevler tablosunun sütun sözleşmesi.
 *
 * Basit Mod, Gelişmiş Modun tam tablosunu göstermez. Görünen alanlar
 * "Hızlı Görev Tanımı" ile TOPLANAN bilgilerdir; toplanmayan (ve Basit Modda
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

/** Basit görev tablosunun boş arama ve sütun süzgeci durumu. */
export function createEmptySimpleTaskFilterState() {
  return {
    search: '',
    filters: {
      proje: [], task: '', keyword: [], sorumlu: [], priority: [], status: [], targetFinish: null
    }
  };
}

/**
 * Basit Modda GÖSTERİLMEYEN, yalnızca Gelişmiş Moda ait alanlar.
 *
 * Bu alanlar Hızlı Görev Tanımı'nda hiç toplanmaz; Basit Mod kullanıcısı için
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

/** Basit Mod tablosunda bir sütun gösterilir mi? */
export function isSimpleTaskColumn(field) {
  return SIMPLE_TASK_COLUMNS.some((column) => column.field === field);
}

/**
 * Basit görev kaydının GÖSTERİLEBİLİR alanları.
 *
 * Gelişmiş moda ait alanlar bilinçli olarak DÜŞÜRÜLÜR: aynı görev kaydı iki
 * modda da aynı veriyi taşır, yalnızca sunum sadeleşir.
 */
export function simpleTaskProjection(task) {
  const projection = {};
  for (const column of SIMPLE_TASK_COLUMNS) projection[column.field] = task?.[column.field] ?? null;
  return projection;
}
