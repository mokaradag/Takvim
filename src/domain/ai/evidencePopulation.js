import { metricEntry, metricPaths, rowCollections } from './claimableEvidence.js';

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

/** Her bildirilen iç koleksiyon vardır; boş üst dizi açık boşluk kanıtıdır. */
export function presentCollection(envelope, canonical) {
  function visit(value, parts) {
    if (!parts.length) return Array.isArray(value);
    const [head, ...tail] = parts;
    return head === '*' ? Array.isArray(value) && value.every((item) => visit(item, tail))
      : value != null && typeof value === 'object' && Object.hasOwn(value, head) && visit(value[head], tail);
  }
  return visit(envelope?.data, String(canonical).split('.'));
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

/** Her kayıtlı koleksiyonun sınırlı kanıt üretim yolu; modele gönderilmez. */
const COLLECTION_CAPABILITIES = Object.freeze({
  rota_task_search: { tasks: 'page' }, rota_project_search: { matches: 'preview' }, rota_person_search: { people: 'preview' },
  rota_task_analytics: { groups: { kind: 'internal-page', ranking: 'dynamic' }, 'overdueAging.buckets': 'bounded' },
  rota_project_detail: {}, rota_task_detail: {},
  rota_portfolio_summary: { projects: 'internal-page' }, rota_wbs_inspect: { nodes: 'internal-page' },
  rota_workload_summary: { people: { kind: 'internal-page', ranking: 'dynamic' } },
  rota_baseline_compare: { availableBaselines: 'preview', mostSlipped: { kind: 'internal-page', ranking: { metric: 'task.varianceDays', order: 'desc' } } },
  rota_dependency_inspect: { predecessors: 'bounded', successors: 'bounded', mostConnected: { kind: 'internal-page', ranking: { metric: 'dependencies.relationCount', order: 'desc' } } },
  rota_recurrence_inspect: { series: { kind: 'internal-page', ranking: 'dynamic' }, 'series.next': { kind: 'internal-page', ranking: 'dynamic' }, 'series.*.next': 'preview' },
  rota_calendar_inspect: { holidays: 'bounded' }, rota_activity_search: { items: 'page' },
  rota_schedule_requests: { items: 'page' }, rota_assignment_requests: { items: 'page' },
  rota_notifications: { 'scheduleRequests.latest': 'preview', 'assignmentCoordination.latest': 'preview', 'taskEvents.latest': 'preview' },
  rota_outlook_status: { items: 'preview' }, rota_data_quality: { checks: 'bounded', 'completedWithoutActualFinish.examples': 'preview' }
});

export function collectionCapability(tool, canonical) {
  const capability = COLLECTION_CAPABILITIES[tool]?.[canonical];
  return capability?.kind || capability || null;
}

export function collectionRanking(tool, canonical, rank) {
  const ranking = COLLECTION_CAPABILITIES[tool]?.[canonical]?.ranking;
  return ranking === 'dynamic' ? rank : ranking || null;
}

export function internalPageRequired(request, tool, canonical = request?.population?.collection) {
  return ['list', 'rank'].includes(request?.operation) && request.population?.tool === tool
    && collectionCapability(tool, canonical) === 'internal-page';
}

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

/** Son tamamlanma özelliği, tamamlanma tarihleri eksikken kesin değildir. */
export function carrierAvailable(source, field, row = null) {
  const metric = metricEntry(source.tool, canonicalField(field).replace(/^data\./, ''))?.metric;
  if (source.tool === 'rota_data_quality' && metric === 'quality.examples') {
    const parts = String(field).split('.');
    const parent = parts[1] === 'checks' ? (row?.examples ? row : source.envelope?.data?.checks?.[Number(parts[2])])
      : source.envelope?.data?.completedWithoutActualFinish;
    if (parent && Array.isArray(parent.examples)) return parent.count === parent.examples.length;
  }
  if (source.tool === 'rota_activity_search' && ['activity.changes', 'activity.changeBefore', 'activity.changeAfter'].includes(metric)) {
    const item = row || source.envelope?.data?.items?.[Number(String(field).split('.')[2])];
    return Boolean(item) && !item.detailsLimited && !(metric === 'activity.changes' && Number(item.moreChanges || 0) > 0);
  }
  if (!['recurrence.lastCompletedFinish', 'recurrence.lastCompletedOccurrence'].includes(metric)) return true;
  const parent = String(field).split('.lastCompleted')[0];
  return (row || valueAt(source.envelope, parent))?.completionDatesComplete !== false;
}

/**
 * Koleksiyona özgü tamlık: zarfın genel `complete` bayrağı başka boyutların
 * (ör. tekrar serisinde geçmiş bitiş tarihleri) eksikliğini de taşır. Kuralı
 * olmayan koleksiyonda zarfın tamlığı geçerlidir.
 */
const COLLECTION_COMPLETENESS = Object.freeze({
  rota_activity_search: {
    items: (envelope) => envelope.totalCount === envelope.data?.items?.length && envelope.returnedCount === envelope.data.items.length
  },
  rota_data_quality: {
    checks: (envelope) => Array.isArray(envelope.data?.checks),
    'completedWithoutActualFinish.examples': (envelope) => envelope.data?.completedWithoutActualFinish?.count === envelope.data?.completedWithoutActualFinish?.examples?.length
  },
  rota_recurrence_inspect: {
    series: (envelope) => Array.isArray(envelope.data?.series) && envelope.totalCount === envelope.data.series.length,
    'series.next': (envelope) => envelope.data?.series?.nextTruncated === false,
    'series.*.next': (envelope) => Array.isArray(envelope.data?.series) && envelope.totalCount === envelope.data.series.length
      && envelope.data.series.every((series) => series?.nextTruncated === false)
  },
  rota_baseline_compare: {
    availableBaselines: (envelope) => envelope.data?.availableBaselinesTruncated === false,
    mostSlipped: (envelope) => Array.isArray(envelope.data?.mostSlipped) && envelope.returnedCount === envelope.totalCount
      && envelope.returnedCount === envelope.data.mostSlipped.length
  },
  // Gruplama yapılmamış analizin boş `groups` dizisi bir grup nüfusu değildir.
  rota_task_analytics: { groups: (envelope) => envelope.complete === true && envelope.truncated !== true && envelope.data?.groupBy != null }
});

/** İstenen koleksiyonun bütün satırları bu kanıtta mı? Sonraki sayfa ve boyutla kısaltılmış sonuç tam değildir. */
export function collectionComplete(source, canonical) {
  const envelope = source?.envelope;
  if (!envelope || source.firstPage !== true || !untrimmed(envelope) || !presentCollection(envelope, canonical)) return false;
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

export const BREAKDOWN_FILTERS = Object.freeze({
  'tasks.overdue': { deadline: 'overdue' },
  'tasks.dueToday': { deadline: 'due_today' },
  'tasks.dueNext7Days': { deadline: 'due_next_7_days' },
  'tasks.openWithoutTargetFinish': { deadline: 'no_target_finish' },
  'tasks.inProgress': { status: ['in_progress'] },
  'tasks.todo': { status: ['todo'] },
  'tasks.done': { status: ['done'] },
  'tasks.open': { status: ['todo', 'in_progress'] }
});

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
/** Üyeliği değiştiren boyutlar; izdüşüm izni tek başına nüfus değildir. */
export function populationDimensions(source, kind = 'scalar', metric = null) {
  const dimensions = source.snapshotDimensions || {};
  const result = {};
  if (source.tool === 'rota_wbs_inspect') result.depth = dimensions.depth ?? 2;
  if (['rota_schedule_requests', 'rota_assignment_requests'].includes(source.tool) && source.facets?.text) {
    result.textFields = [...(dimensions.textFields || [])].sort();
  }
  if (source.tool === 'rota_task_analytics' && (kind === 'rows' || metric === 'tasks.groupCount')) result.groupBy = dimensions.groupBy ?? null;
  if (kind === 'rows') {
    if (source.tool === 'rota_task_search') result.sort = dimensions.sort || (source.facets?.deadline === 'overdue' ? 'overdue_days_desc' : 'target_finish_asc');
    else if (source.tool === 'rota_portfolio_summary') result.sort = dimensions.sort || 'overdue_desc';
    else if (dimensions.sort != null) result.sort = dimensions.sort;
  }
  return result;
}

/** Aynı boyut kuralları bildirime uygunluğu ve tazeliği belirler. */
export function metricDimensionsMatch(source, request, metric, rows = false) {
  if ((rows ? source.rowDimensionsMatch ?? source.dimensionsMatch : source.dimensionsMatch) === false) return false;
  if (request.population?.tool !== source.tool) return true;
  const declared = { ...source, snapshotDimensions: request.population };
  return stableJson(populationDimensions(source, rows ? 'rows' : 'scalar', metric))
    === stableJson(populationDimensions(declared, rows ? 'rows' : 'scalar', metric));
}

/**
 * Yürütücü okumaları sırayla yapar. Yalnızca gerçekten paylaşılan maddileştirilmiş
 * görüntü aynı andır; model tur numarası görüntü kimliği değildir.
 */
export function readLater(newer, older) {
  if (newer.snapshot && newer.snapshot === older.snapshot) return false;
  const round = (newer.round ?? newer.ordinal) - (older.round ?? older.ordinal);
  return round > 0 || round === 0 && newer.ordinal > older.ordinal;
}

export function scalarKey(source, metric = null) {
  const definition = BREAKDOWN_FILTERS[metric];
  const facets = { ...(source.facets || {}) };
  for (const [key, required] of Object.entries(definition || {})) {
    if (Array.isArray(required)) facets[key] = (facets[key] || required).filter((value) => required.includes(value)).sort();
    else if (facets[key] == null || facets[key] === required) facets[key] = required;
  }
  return populationKey({ ...source, facets }, populationDimensions(source, 'scalar', metric));
}

export function rowKey(source, canonical) {
  return `${canonical}|${populationKey(source, populationDimensions(source, 'rows'))}`;
}
