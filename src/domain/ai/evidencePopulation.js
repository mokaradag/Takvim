import { metricPaths, rowCollections } from './claimableEvidence.js';

/**
 * Kanıt nüfusunun ORTAK kuralları: koleksiyonun somut satır kümeleri,
 * koleksiyona özgü tamlık, koleksiyonu sayan toplamlar, boşluk kanıtı ve
 * tazelik sınıfları. Sunucunun belirlenimci seçimi, model seçiminin
 * doğrulaması ve Derin düşünmeye devir kararı aynı kuralları kullanır; böylece
 * iki yol aynı kanıt hakkında farklı sonuca varamaz.
 */

/** Olgu yolunun kanonik biçimi: dizi indisleri `*` olur (`data.` öneki korunur). */
export function canonicalField(field) {
  return String(field).split('.').map((part) => /^\d+$/.test(part) ? '*' : part).join('.');
}

/** Kanonik koleksiyonun bütün somut satır kümeleri (iç içe koleksiyonda her üst satır için ayrı). */
export function concreteCollections(envelope, canonical) {
  const found = [];
  function visit(value, parts, path, parent = null) {
    if (!parts.length) { if (Array.isArray(value)) found.push({ canonical, collection: path, rows: value, parent }); return; }
    const [head, ...tail] = parts;
    if (head === '*') {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, tail, `${path}.${index}`, item));
    } else if (value && typeof value === 'object') visit(value[head], tail, `${path}.${head}`, value);
  }
  visit(envelope?.data, String(canonical).split('.'), 'data');
  return found;
}

/**
 * Koleksiyonun satır sayısını veren ölçü. Liste ya da sıralama yanıtında
 * satırlarla birlikte yalnızca AYNI kanıttaki bu toplam verilebilir; başka bir
 * nüfusun toplamı (ör. seri sayısı ile yineleme satırları) satırların sayısı değildir.
 */
const COLLECTION_TOTALS = Object.freeze({
  rota_task_search: { tasks: 'tasks.total' }, rota_project_search: { matches: 'projects.total' }, rota_person_search: { people: 'people.total' },
  rota_portfolio_summary: { projects: 'projects.total' }, rota_wbs_inspect: { nodes: 'wbs.nodes' },
  rota_task_analytics: { groups: 'tasks.groupCount' }, rota_workload_summary: { people: 'people.total' },
  rota_baseline_compare: { mostSlipped: 'baseline.compared' }, rota_activity_search: { items: 'activity.events' },
  rota_schedule_requests: { items: 'requests.total' }, rota_assignment_requests: { items: 'requests.total' },
  rota_calendar_inspect: { holidays: 'calendar.holidays' }, rota_outlook_status: { items: 'subscriptions.active' },
  rota_recurrence_inspect: { series: 'recurrence.entries', 'series.next': 'recurrence.upcomingOccurrences' }
});

/** Yol aracın bir satır koleksiyonunun içinde mi (grup, proje, görev satırı…)? */
export const insideRowCollection = (tool, path) => rowCollections(tool).some((row) => path.startsWith(`data.${row}.`));

export function collectionTotalMetric(tool, canonical) {
  return COLLECTION_TOTALS[tool]?.[canonical] || null;
}

/**
 * Koleksiyonun toplamını taşıyan satır dışı kanonik yollar (ör. `totalCount`, `data.nodeCount`). Tek kaydın
 * iç koleksiyonunun toplamı o kaydın alanıdır (ör. görevle okunan tek serinin `series.upcomingCount`).
 */
export function collectionTotalPaths(tool, canonical) {
  const metric = collectionTotalMetric(tool, canonical);
  const text = String(canonical);
  const parent = text.includes('.') && !text.includes('*') ? `data.${text.slice(0, text.lastIndexOf('.'))}.` : null;
  return metric ? metricPaths(tool, metric).filter((path) => !path.includes('*') && (!insideRowCollection(tool, path) || (parent && path.startsWith(parent)))) : [];
}

const valueAt = (envelope, path) => String(path).split('.').slice(1).reduce((value, key) => value?.[key], envelope?.data);
const untrimmed = (envelope) => envelope?.data?.sizeNote == null;

/**
 * Koleksiyona özgü tamlık: zarfın genel `complete` bayrağı başka boyutların
 * (ör. tekrar serisinde geçmiş bitiş tarihleri) eksikliğini de taşır. Kuralı
 * olmayan koleksiyonda zarfın tamlığı geçerlidir.
 */
const COLLECTION_COMPLETENESS = Object.freeze({
  rota_recurrence_inspect: {
    // Seri satırlarının son tamamlanma alanı gerçek bitiş tarihlerine dayanır; yaklaşan önizlemenin kısalması seri kümesini eksiltmez.
    series: (envelope) => Array.isArray(envelope.data?.series) && envelope.totalCount === envelope.data.series.length
      && envelope.data.series.every((series) => series?.completionDatesComplete !== false),
    'series.next': (envelope) => envelope.data?.series?.nextTruncated === false,
    'series.*.next': (envelope) => Array.isArray(envelope.data?.series) && envelope.totalCount === envelope.data.series.length
      && envelope.data.series.every((series) => series?.nextTruncated === false)
  },
  rota_baseline_compare: { availableBaselines: (envelope) => envelope.data?.availableBaselinesTruncated === false },
  // Gruplama yapılmamış analizin boş `groups` dizisi bir grup nüfusu değildir.
  rota_task_analytics: { groups: (envelope) => envelope.complete === true && envelope.truncated !== true && envelope.data?.groupBy != null }
});

/** İstenen koleksiyonun bütün satırları bu kanıtta mı? Sonraki sayfa ve boyutla kısaltılmış sonuç tam değildir. */
export function collectionComplete(source, canonical) {
  const envelope = source?.envelope;
  if (!envelope || source.firstPage !== true || !untrimmed(envelope)) return false;
  const rule = COLLECTION_COMPLETENESS[source.tool]?.[canonical];
  return rule ? rule(envelope) === true : envelope.complete === true && envelope.truncated !== true;
}

/**
 * Boşluk kanıtında sıfır olması gereken sayaçlar. Koleksiyonun kendi toplamı
 * yoksa zarfın nüfusu sayan toplamı (bağımlılık ilişkileri) ya da her üst satırın
 * yaklaşan yineleme sayısı kullanılır.
 */
const EMPTY_COUNTERS = Object.freeze({
  rota_dependency_inspect: { mostConnected: (envelope) => [envelope.totalCount] },
  rota_recurrence_inspect: {
    'series.next': (envelope) => [envelope.data?.series?.upcomingCount],
    'series.*.next': (envelope) => (envelope.data?.series || []).map((series) => series?.upcomingCount)
  }
});

function emptyCounters(source, canonical) {
  const rule = EMPTY_COUNTERS[source.tool]?.[canonical];
  if (rule) return rule(source.envelope);
  return collectionTotalPaths(source.tool, canonical).map((path) => (path === 'totalCount' ? source.envelope.totalCount : valueAt(source.envelope, path)))
    .filter((value) => value !== undefined);
}

/**
 * Kanıt bu koleksiyonun nüfusunun BOŞ olduğunu kanıtlıyor mu? Koleksiyon bu
 * kanıtta tam olmalı, hiçbir somut kümesi satır taşımamalı ve koleksiyonun
 * sayaçları sıfır olmalıdır. İç içe koleksiyonda üst dizinin boşluğu da kanıttır.
 */
export function provesEmptyCollection(source, canonical) {
  if (!collectionComplete(source, canonical)) return false;
  const collections = concreteCollections(source.envelope, canonical);
  if (collections.some(({ rows }) => rows.length !== 0)) return false;
  if (!collections.length) {
    const parts = String(canonical).split('.');
    const outer = parts.indexOf('*');
    if (outer < 0) return false;
    const parent = valueAt(source.envelope, `data.${parts.slice(0, outer).join('.')}`);
    if (!Array.isArray(parent) || parent.length !== 0) return false;
  }
  return emptyCounters(source, canonical).every((value) => value === 0);
}

/** Bütün somut kümelerin satırları, kanıttaki sırasıyla. */
export function collectionRows(envelope, canonical) {
  return concreteCollections(envelope, canonical)
    .flatMap(({ collection, rows }) => rows.map((row, index) => ({ collection, index, row })));
}

/* ── Tazelik ────────────────────────────────────────────────
 * Aynı turda aynı nüfusun yeniden okunması eski kaydı geçersiz kılabilir; hangi
 * yeni okumanın eskisinin YERİNE geçtiği olgunun sınıfına bağlıdır:
 *  - `scalar`: toplam ve sayımlar her sayfada kesindir; aynı nüfusun daha yeni
 *    okuması (sayfası ne olursa olsun) eskisinin yerine geçer.
 *  - `rows`: satır kümesi yalnızca daha yeni TAM okumayla (aynı nüfus, aynı sıra
 *    ve boyutlar) değişir; sonraki sayfa ya da eksik okuma tam kümeyi eskitmez.
 *  - `property`: varlığın kendi özelliği, aynı varlığın aynı özelliğini taşıyan
 *    daha yeni herhangi bir okumayla eskir.
 */

const stableJson = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

/** Nüfus anahtarı: kanonik koşullar ve seçiciler; `dimensions` verilirse onlar da. */
export function populationKey(source, dimensions = null) {
  const selectors = [...(source.selectors || [])].map(({ type, id }) => `${type}:${String(id).toLowerCase()}`).sort();
  return stableJson({ facets: source.facets || {}, selectors, ...(dimensions ? { dimensions } : {}) });
}

/**
 * Toplamların nüfusunu değiştiren boyutlar: WBS derinliği listelenen düğümleri,
 * talep listesinde korumalı metin alanları aramanın kapsamını belirler; sıra ve
 * gruplama toplamı değiştirmez (sunucunun uygunluk denetimiyle aynı ayrım).
 */
const SCALAR_DIMENSIONS = Object.freeze({ rota_wbs_inspect: ['depth'], rota_schedule_requests: ['textFields'], rota_assignment_requests: ['textFields'] });

/**
 * Daha yeni okuma: kesinlikle daha sonraki bir araç turunda. Aynı turdaki eşdeğer
 * okumalar aynı andır; biri diğerinin yerine geçmez (sıra numarası tek başına tazelik değildir).
 */
export function readLater(newer, older) {
  return (newer.round ?? newer.ordinal) > (older.round ?? older.ordinal);
}

export function scalarKey(source) {
  const keep = SCALAR_DIMENSIONS[source.tool] || [];
  const dimensions = Object.fromEntries(Object.entries(source.snapshotDimensions || {}).filter(([key]) => keep.includes(key)));
  return populationKey(source, dimensions);
}

export function rowKey(source, canonical) {
  return `${canonical}|${populationKey(source, source.snapshotDimensions || {})}`;
}
