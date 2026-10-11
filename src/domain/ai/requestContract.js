import { claimableContract, METRICS, metricEntry, NAMING_METRICS, rowCollections } from './claimableEvidence.js';
import { scaledDecimal } from '../numbers/fixedDecimal.js';
import {
  canonicalField,
  collectionComplete,
  collectionTotalPaths,
  concreteCollections,
  populationKey,
  provesEmptyCollection,
  readLater,
  rowKey,
  scalarKey
} from './evidencePopulation.js';

export { concreteCollections, provesEmptyCollection } from './evidencePopulation.js';

/**
 * Rota AI istek sözleşmesi — modelin veri okumadan bildirdiği türlü istek ile
 * seçilen olguların BELİRLENİMCİ uyumu.
 *
 * Sunucu Türkçe ya da İngilizce cümleyi yorumlamaz: sorunun anlamı modelin
 * yapılandırılmış bildirimidir (`operation`, `metrics`, `entities`, `filters`,
 * `population`, `fields`, `bindings`, `rank`). Burada yalnızca nesnel
 * değişmezler denetlenir ve her biri bir YÜKÜMLÜLÜKTÜR: istenen her ölçü, her
 * açık alan bağı ve her ölçü/varlık bağı karşılanır; istenmeyen ölçü yanıt
 * olamaz; olgunun nüfusu bildirilen nüfusla birebir aynıdır; liste nüfusun
 * bütün satırlarını, sıralama sıralamanın başını kapsar; daha yeni aynı
 * nüfusun yerine geçtiği kanıt kullanılamaz. Nüfus, tamlık, toplam ve tazelik
 * kuralları sunucu seçimiyle ortaktır (evidencePopulation.js). Doğal dil
 * anlamının daha iyi çıkarımı Aşama 4'ün işidir.
 */

export const REQUEST_OPERATIONS = Object.freeze(['value', 'list', 'rank']);
export const REQUEST_ENTITY_TYPES = Object.freeze(['project', 'task', 'person', 'wbs', 'baseline']);
export const REQUEST_LIMITS = Object.freeze({ maxMetrics: 8, maxEntities: 4, maxRankLimit: 10 });

/** Sıralanamayan ölçme birimleri: metin, sınıf, bayrak, tanım, birimi satıra göre değişen ya da ondalık metin değerler. */
const UNORDERED_MEASURES = new Set(['text', 'enum', 'boolean', 'definition', 'lag', 'value', 'currency-unspecified']);

export function rankableMeasure(measure) {
  return typeof measure === 'string' && !UNORDERED_MEASURES.has(measure);
}

/** Satırın kimlik alanı, bildirilen varlık türüne göre. */
export const ENTITY_ID_FIELDS = Object.freeze({ project: 'projectId', task: 'taskId', person: 'sicil', wbs: 'wbsId', baseline: 'baselineId' });

const sortedJson = (value) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
const TASK_COUNT_TOOLS = new Set(['rota_task_search', 'rota_task_analytics', 'rota_project_detail', 'rota_task_detail']);

/**
 * Olgunun kayıt satırı: kayıt defterindeki en içteki satır koleksiyonu.
 * Kaydın çok değerli alanı satır değildir; `list` döner.
 */
export function factRow(tool, field) {
  const rows = factCollections(tool, field);
  return rows.findLast((row) => row.kind === 'row') || rows[0] || null;
}

function factCollections(tool, field) {
  const parts = String(field).split('.');
  if (parts[0] !== 'data') return [];
  return parts.flatMap((part, index) => {
    if (index <= 1 || !/^\d+$/.test(part)) return [];
    const canonical = parts.slice(1, index).map((item) => /^\d+$/.test(item) ? '*' : item).join('.');
    return [{
      kind: rowCollections(tool).includes(canonical) ? 'row' : 'list',
      canonical,
      collection: parts.slice(0, index).join('.'),
      index: Number(part),
      path: parts.slice(0, index + 1).join('.')
    }];
  });
}

function valueAt(envelope, path) {
  return String(path).split('.').slice(1).reduce((value, key) => value?.[key], envelope?.data);
}

/**
 * `value` isteğinde grup satırı, grubun boyutu bildirilen bir koşul ya da
 * varlıkla adlandırılabiliyorsa bağlıdır. Adlandırılamayan grup `facets: null`.
 */
function groupScope(fact) {
  const key = fact.semantic?.group?.key;
  if (key == null) return null;
  switch (fact.semantic?.groupBy) {
    case 'status': return { facets: { status: [key] }, selectors: [] };
    case 'priority': return { facets: { priority: [key] }, selectors: [] };
    case 'deadline':
      if (key === 'done') return { facets: { status: ['done'] }, selectors: [] };
      return ['overdue', 'due_today', 'no_target_finish'].includes(key) ? { facets: { deadline: key }, selectors: [] } : { facets: null, selectors: [] };
    case 'assignee':
      if (key === 'unassigned') return { facets: { assignee: 'unassigned' }, selectors: [] };
      return /^sicil:\d+$/.test(key) ? { facets: {}, selectors: [{ type: 'person', id: String(Number(key.slice(6))) }] } : { facets: null, selectors: [] };
    case 'project': return key === 'other' ? { facets: null, selectors: [] } : { facets: {}, selectors: [{ type: 'project', id: key }] };
    case 'target_month': {
      if (!/^\d{4}-\d{2}$/.test(key)) return { facets: null, selectors: [] };
      const last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);
      return { facets: { dateField: 'targetFinish', dateFrom: `${key}-01`, dateTo: last }, selectors: [] };
    }
    default: return { facets: null, selectors: [] };
  }
}

const fieldValue = (row, field) => field.split('.').reduce((value, key) => value?.[key], row);
function pathValues(value, parts) {
  if (!parts.length) return value === undefined ? [] : [value];
  const [head, ...rest] = parts;
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => pathValues(item, rest)) : [];
  return value && typeof value === 'object' ? pathValues(value[head], rest) : [];
}

/**
 * Satır alanının durumu: değer var, alan BOŞ (değeri null ya da yazılmamış tekil varlık
 * özelliği, ör. hedef bitişi olmayan görev; ya da çok değerli alan boş, ör. sorumlusu
 * olmayan görev: `assignees: []`) ya da alan hiç yok (yazılmamış sayaç ya da çok değerli alan). Boş alan bir
 * değerdir (yalnızca kısaltılmamış kanıtta); olmayan alan ölçüyü taşımaz.
 */
function rowFieldState(tool, collection, row, field) {
  const parts = field.split('.');
  const values = pathValues(row, parts);
  if (values.some((value) => value !== null)) return 'value';
  if (values.length) return 'empty';
  const star = parts.indexOf('*');
  // Araçlar boş tekil varlık özelliğini (ör. hedef bitişi olmayan görev) satıra yazmaz; sayaçlar her zaman yazılır.
  if (star < 0) return metricEntry(tool, `${collection}.*.${field}`)?.property === true ? 'empty' : 'absent';
  const container = parts.slice(0, star).reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), row);
  return Array.isArray(container) && container.length === 0 ? 'empty' : 'absent';
}

/** Koleksiyonun satırlarında bir ölçüyü taşıyan kanonik alanlar. */
export function rowMetricFields(tool, collection, metric) {
  const prefix = `${collection}.*.`;
  return claimableContract(tool).paths
    .filter((path) => path.startsWith(prefix) && metricEntry(tool, path)?.metric === metric)
    .map((path) => path.slice(prefix.length));
}

/**
 * Aynı okumada aynı türden satırları taşıyan ve birlikte listelenebilen kardeş koleksiyonlar
 * (ör. bir görevin öncülleri ve ardılları). Başka koleksiyonlar birlikte örtük liste olamaz.
 */
const LISTED_TOGETHER = Object.freeze({
  rota_dependency_inspect: [['predecessors', 'successors']],
  rota_notifications: [['scheduleRequests.latest', 'assignmentCoordination.latest', 'taskEvents.latest']]
});

/**
 * Bildirilmemiş liste koleksiyonu: bildirilen her satır ölçüsünü taşıyan koleksiyon. Birden çoksa
 * yalnızca kayıtlı kardeş koleksiyonlar birlikte listedir (her biri tam listelenir); aksi hâlde boş.
 */
export function listCollections(tool, metrics, collections = rowCollections(tool)) {
  const rowMetrics = metrics.filter((metric) => collections.some((collection) => rowMetricFields(tool, collection, metric).length));
  if (!rowMetrics.length) return [];
  const fitting = collections.filter((collection) => rowMetrics.every((metric) => rowMetricFields(tool, collection, metric).length));
  if (fitting.length < 2) return fitting;
  return (LISTED_TOGETHER[tool] || []).some((family) => fitting.every((collection) => family.includes(collection))) ? fitting : [];
}

/**
 * İç içe koleksiyonun tek kayıt biçimindeki üst kaydının kendi özelliği mi (ör. görevle okunan tek serinin
 * kuralı, yinelemelerinin listesinde)? Üst kaydın sayımları değil, yalnızca kayıtlı özellikleri.
 */
export function parentProperty(tool, collection, path) {
  const text = String(collection || '');
  if (!text.includes('.') || text.includes('*') || String(path).includes('*')) return false;
  const parent = `data.${text.slice(0, text.lastIndexOf('.'))}.`;
  return path.startsWith(parent) && !path.startsWith(`data.${text}.`) && metricEntry(tool, path.slice(5))?.property === true;
}

/** Kanıtın bildirilen satır koleksiyonları (nüfus aracı değilse ya da değer isteğinde null). */
export const sourceCollections = (source) => (source?.collection == null ? null : [].concat(source.collection));

/** Satır sıralamasının ölçü alanı: koleksiyonda o ölçüyü taşıyan ve satırlarda bulunan tek kanonik yol. */
function rankField(tool, collection, metric, rows) {
  const fields = rowMetricFields(tool, collection, metric).filter((field) => rows.some((row) => fieldValue(row, field) !== undefined));
  return fields.length === 1 ? fields[0] : null;
}

/** Koleksiyonun ölçüye göre başı: `limit` satır ve sınırdaki eşitler (kanıttaki değerlerden). */
function rankPlan(request, source, collection) {
  const rows = valueAt(source.envelope, collection.collection);
  const field = Array.isArray(rows) ? rankField(source.tool, collection.canonical, request.rank.metric, rows) : null;
  if (!field) return null;
  const direction = request.rank.order === 'asc' ? 1 : -1;
  const rankValue = (value) => METRICS[request.rank.metric] === 'hours' ? scaledDecimal(value, 2) : value;
  const value = (row) => rankValue(fieldValue(row, field));
  const ranked = rows.map((row, index) => ({ index, value: value(row) }))
    .filter((item) => item.value != null)
    .sort((left, right) => {
      return (left.value < right.value ? -1 : left.value > right.value ? 1 : 0) * direction || left.index - right.index;
    });
  const limit = Math.min(request.rank.limit || 1, ranked.length);
  if (!limit) return null;
  const boundary = ranked[limit - 1].value;
  const order = ranked.filter((item, position) => position < limit || item.value === boundary).map((item) => item.index);
  return { rows, ranked, boundary, order, direction, rankValue };
}

/** Sıralama isteğinin bu kanıtta beklenen satır indisleri; seçim yine `verifyRequestedFacts` ile doğrulanır. */
export function rankedRowIndexes(request, tool, envelope, canonical, concrete = canonical) {
  return rankPlan(request, { tool, envelope }, { canonical, collection: `data.${concrete}` })?.order || null;
}

/**
 * Sıralama yanıtı: seçilen satırlar, koleksiyonun ölçüye göre başındaki
 * `limit` satır ve onlarla eşit değerdeki satırlardır. Sunucu sıralamayı
 * kanıttaki değerlerden kendisi kurar; kesilmiş koleksiyonda yalnızca aynı
 * ölçüyle sunucuda sıralanmış ilk sayfa kabul edilir.
 */
function rankedIndexes(request, source, collection, selected) {
  const plan = rankPlan(request, source, collection);
  if (!plan) return null;
  const { rows, ranked, boundary, order, direction, rankValue } = plan;
  const expected = new Set(order);
  if (expected.size !== selected.size || [...expected].some((index) => !selected.has(index))) return null;
  if (collectionComplete(source, collection.canonical)) return order;
  // Kesilmiş koleksiyon: sunucu aynı ölçüyle sıralamışsa ilk sayfa bütün nüfusun başıdır.
  const sorted = source.sortedBy?.metric === request.rank.metric && source.sortedBy?.order === request.rank.order && source.firstPage === true;
  if (!sorted) return null;
  const beyond = ranked[expected.size];
  if (beyond) return order;
  const proof = source.envelope.rankingBoundary;
  const nextValue = rankValue(proof?.nextValue);
  return proof?.collection === collection.canonical && proof.metric === request.rank.metric
    && proof.order === request.rank.order && proof.returnedCount === rows.length
    && (proof.nextValue === null || (ranked.length >= (request.rank.limit || 1) && nextValue != null && typeof nextValue === typeof boundary
      && (nextValue < boundary ? -1 : nextValue > boundary ? 1 : 0) * direction > 0)) ? order : null;
}

export function entityKey(type, id) {
  return `${type}:${String(id).toLowerCase()}`;
}

/** İki varlıklı ve iki ölçülü istekte her ölçünün varlığı açıkça bağlanmalıdır. */
export function bindingsRequired(request) {
  // Kaydı adlandıran ölçü (ör. project.name) her varlığın kendi adıdır; eşleme belirsizliği yalnızca ölçen ölçülerdedir.
  return (request.entities || []).length > 1 && new Set(request.metrics.filter((metric) => !NAMING_METRICS.has(metric))).size > 1;
}

/* ── Tazelik ──────────────────────────────────────────────── */

/** Kanıtın satırının adlandırdığı varlık ya da seçicisi: varlığın kendi özelliğinin sahibi. */
function propertyOwner(source, field, type) {
  if (!type || !ENTITY_ID_FIELDS[type]) return null;
  const row = factCollections(source.tool, field).findLast((item) => item.kind === 'row');
  const object = row ? valueAt(source.envelope, row.path) : null;
  const id = object?.[ENTITY_ID_FIELDS[type]];
  if (id != null) return entityKey(type, id);
  if (row) return null;
  const selector = (source.selectors || []).find((item) => item.type === type);
  return selector ? entityKey(type, selector.id) : null;
}

/**
 * Seçilen olgunun yerine aynı turda daha yeni bir kanıt geçti mi? Sınıf
 * (evidencePopulation.js): satır kümesi yalnızca aynı nüfusun daha yeni TAM
 * okumasıyla, toplam aynı nüfusun herhangi bir daha yeni okumasıyla, varlığın
 * özelliği aynı varlığın aynı özelliğiyle eskir.
 */
export function factSuperseded(evidence, source, fact, { property = null } = {}) {
  const metric = fact.semantic?.metric;
  const row = factRow(source.tool, fact.field);
  for (const newer of evidence.values()) {
    if (newer === source || !readLater(newer, source)) continue;
    if (property) {
      const [type, owner] = property;
      const sameProperty = (newer.facts || []).some((item) => item.semantic?.metric === metric
        && (newer.tool === source.tool ? canonicalField(item.field) === canonicalField(fact.field) : item.field.split('.').at(-1) === fact.field.split('.').at(-1))
        && propertyOwner(newer, item.field, type) === owner);
      if (sameProperty) return true;
      continue;
    }
    if (newer.unsupported?.length) continue;
    if (row?.kind === 'row') {
      if (newer.tool === source.tool && rowKey(newer, row.canonical) === rowKey(source, row.canonical) && collectionComplete(newer, row.canonical)) return true;
      continue;
    }
    if (scalarKey(newer) !== scalarKey(source)) continue;
    const sameCarrier = (newer.facts || []).some((item) => item.semantic?.metric === metric && (newer.tool === source.tool
      ? canonicalField(item.field) === canonicalField(fact.field)
      : !factRow(newer.tool, item.field) && !row && metric.startsWith('tasks.') && TASK_COUNT_TOOLS.has(source.tool) && TASK_COUNT_TOOLS.has(newer.tool)));
    if (sameCarrier) return true;
  }
  return false;
}

/** Boş nüfus kanıtı bir sayımdır: aynı aracın aynı nüfusu daha yeni bir okumada yeniden okunduysa eskimiştir. */
function emptyProofSuperseded(evidence, source) {
  const key = populationKey(source, Object.fromEntries(Object.entries(source.snapshotDimensions || {}).filter(([name]) => !['sort', 'textFields'].includes(name))));
  return [...evidence.values()].some((newer) => newer !== source && readLater(newer, source) && newer.tool === source.tool
    && populationKey(newer, Object.fromEntries(Object.entries(newer.snapshotDimensions || {}).filter(([name]) => !['sort', 'textFields'].includes(name)))) === key);
}

const rowDimensions = (source) => source.rowDimensionsMatch ?? source.dimensionsMatch;

/* ── Boş nüfus ────────────────────────────────────────────── */

/** Koleksiyon bu kanıtta var mı (iç içe koleksiyonda dış dizinin varlığı yeter)? */
export function presentCollection(envelope, canonical) {
  if (concreteCollections(envelope, canonical).length) return true;
  const parts = canonical.split('.');
  const outer = parts.indexOf('*');
  return outer > 0 && Array.isArray(valueAt(envelope, `data.${parts.slice(0, outer).join('.')}`));
}

/**
 * Atfedilen kanıtlardan nüfusun BOŞ olduğunu kanıtlayanlar. Yalnızca bildirilen
 * nüfusla aynı kanıt sayılır; kanıtlanan her koleksiyon satır ölçülerini taşır.
 */
function emptyRowSources(request, facts, evidence) {
  const ids = [...new Set(facts.map(({ evidenceId }) => evidenceId))];
  return ids.flatMap((evidenceId) => {
    const source = evidence.get(evidenceId);
    if (!source || source.populationMatch === false || rowDimensions(source) === false || source.sortMatch === false || source.unsupported.length
      || sortedJson(source.facets) !== sortedJson(source.declared)) return [];
    const active = (sourceCollections(source) || rowCollections(source.tool)).filter((collection) => presentCollection(source.envelope, collection));
    const rowMetrics = request.metrics.filter((metric) => active.some((collection) => rowMetricFields(source.tool, collection, metric).length > 0));
    const compatible = active.filter((collection) => rowMetrics.length && rowMetrics.every((metric) => rowMetricFields(source.tool, collection, metric).length > 0));
    if (!compatible.length || compatible.some((collection) => !provesEmptyCollection(source, collection))) return [];
    return [{ source, metrics: rowMetrics, collections: compatible, stale: emptyProofSuperseded(evidence, source) }];
  });
}

/* ── Satır bütünlüğü ──────────────────────────────────────── */

/**
 * Seçilen satırların her biri, taşıyabildiği istenen ölçünün olgusunu da taşıyor mu?
 * Değeri olan satır ölçünün olgusunu ister; çok değerli alanı boş olan satır
 * (kısaltılmamış kanıtta) ölçüyü boş değeriyle taşır; alanı olmayan satır taşımaz.
 */
function rowMetricComplete(entry, metric) {
  const fields = rowMetricFields(entry.source.tool, entry.row.canonical, metric);
  const rows = valueAt(entry.source.envelope, entry.row.collection) || [];
  const untrimmed = entry.source.envelope?.data?.sizeNote == null;
  return [...entry.indexes].every((index) => {
    const row = rows[index];
    if (!row) return false;
    const states = fields.map((field) => rowFieldState(entry.source.tool, entry.row.canonical, row, field));
    if (states.includes('value')) return entry.metrics.get(index)?.has(metric) === true;
    return untrimmed && states.includes('empty');
  });
}

/**
 * Seçilen satırların hiçbiri ölçünün değerini taşımıyor ama hepsinde ölçünün çok
 * değerli alanı (kısaltılmamış kanıtta) boşsa ölçü boş değeriyle verilmiştir.
 */
function emptyRowMetric(metric, rowGroups) {
  const carrying = rowGroups.filter((entry) => rowMetricFields(entry.source.tool, entry.row.canonical, metric).length);
  return carrying.length > 0 && carrying.every((entry) => rowMetricComplete(entry, metric));
}

/** Açık alan bağı, seçilen satırların hepsinde o alan boş çok değerliyse ya da koleksiyon boşsa boşta karşılanır. */
function fieldVacuous(binding, rowGroups, empty) {
  return rowCollections(binding.tool).some((collection) => {
    const prefix = `data.${collection}.*.`;
    if (!binding.path.startsWith(prefix)) return false;
    if (empty.some((item) => item.source.tool === binding.tool && item.collections.includes(collection))) return true;
    const relative = binding.path.slice(prefix.length);
    const entries = rowGroups.filter((entry) => entry.source.tool === binding.tool && entry.row.canonical === collection);
    return entries.length > 0 && entries.every((entry) => entry.source.envelope?.data?.sizeNote == null && [...entry.indexes]
      .every((index) => rowFieldState(binding.tool, collection, (valueAt(entry.source.envelope, entry.row.collection) || [])[index], relative) === 'empty'));
  });
}

/* ── Doğrulama ────────────────────────────────────────────── */

/**
 * Seçilen olguların bildirilen isteğe uyumu: `{ ok, issues }`.
 *
 * `evidence`: kanıt kimliği → `{ tool, envelope, facets, declared, unsupported,
 * selectors, sortedBy, firstPage, snapshotDimensions, populationMatch,
 * dimensionsMatch, sortMatch, collection }`. `facets` kanıtın yürütülen nüfus
 * koşulları, `declared` istenen koşulların bu araçtaki karşılığı, `unsupported`
 * aracın ifade edemediği istenen koşullardır; hepsini sunucu hesaplar.
 */
export function verifyRequestedFacts(request, facts, evidence) {
  const fail = (code) => ({ ok: false, issues: [{ code }] });
  if (!request || !Array.isArray(request.metrics) || !REQUEST_OPERATIONS.includes(request.operation)) return fail('REQUEST_DECLARATION_REQUIRED');
  const entities = request.entities || [];
  if (entities.some((entity) => entity.bound == null)) return fail('ENTITY_UNRESOLVED');
  const boundKeys = new Set(entities.map((entity) => entityKey(entity.type, entity.bound)));
  const metrics = new Set(request.metrics);
  const declaredFields = request.fields || [];
  const bindings = request.bindings || [];
  const rows = ['list', 'rank'].includes(request.operation);
  const represented = new Set();
  const referenced = new Set();
  const collections = new Map();
  const metricEntities = new Map();
  const satisfiedFields = new Set();
  const scalars = [];
  for (const { evidenceId, fact } of facts) {
    const source = evidence.get(evidenceId);
    if (!source) return fail('UNKNOWN_FACT_REFERENCE');
    const semantic = fact.semantic || {};
    const substantive = metrics.has(semantic.metric);
    if (!substantive && !semantic.context) return fail('UNDECLARED_METRIC');
    const factRows = factCollections(source.tool, fact.field);
    const row = factRows.findLast((item) => item.kind === 'row') || factRows[0] || null;
    const rowObject = row ? valueAt(source.envelope, row.path) : null;
    const rowEntities = rowObject && typeof rowObject === 'object'
      ? Object.entries(ENTITY_ID_FIELDS).filter(([, field]) => rowObject[field] != null).map(([type, field]) => entityKey(type, rowObject[field])) : [];
    const conflictingRow = rowEntities.some((key) => !boundKeys.has(key)
      && entities.some((entity) => key.startsWith(`${entity.type}:`)));
    const named = row?.kind === 'row' && rowEntities.some((entity) => boundKeys.has(entity));
    // Değer isteğinde bağlı varlığın kendi özelliği (adlandırılan satır ya da
    // seçicinin kaydı) nüfus koşulundan bağımsızdır; toplamlar ve sayımlar değildir.
    const ownProperty = semantic.property === true && (request.operation === 'value' || !row)
      && (named || ((!row || row.path === fact.field) && source.selectors.length > 0));
    const group = request.operation === 'value' && row?.kind === 'row' && !named ? groupScope(fact) : null;
    const selectors = [...source.selectors, ...(group?.selectors || [])];
    if (selectors.some(({ type, id }) => !boundKeys.has(entityKey(type, id)))) return fail('ENTITY_MISMATCH');
    if (substantive) {
      const fieldBindings = declaredFields.filter((item) => item.metric === semantic.metric);
      const path = fact.field.startsWith('data.') ? canonicalField(fact.field) : fact.field;
      const binding = fieldBindings.find((item) => item.tool === source.tool && item.path === path);
      // Satır olgusu satır nüfusunu (gruplama dâhil), toplam yalnızca toplamın nüfusunu belirleyen boyutları ister.
      // Değer isteğinde anahtarı bildirilen koşulu bağlayan grup satırı bildirilen nüfusun kendisidir.
      const dimensionsMatch = row?.kind === 'row' && !group ? rowDimensions(source) : source.dimensionsMatch;
      if (!ownProperty && ((source.populationMatch === false && !binding) || dimensionsMatch === false || source.sortMatch === false)) return fail('POPULATION_MISMATCH');
      if (sourceCollections(source) && row?.kind === 'row' && !sourceCollections(source).includes(row.canonical)) return fail('POPULATION_MISMATCH');
      if (fieldBindings.length && !binding) return fail('POPULATION_MISMATCH');
      if (binding) satisfiedFields.add(binding);
      if (!ownProperty) {
        if (group && group.facets === null) return fail('POPULATION_MISMATCH');
        const effective = { ...source.facets, ...(group?.facets || {}) };
        if (source.unsupported.some((key) => !Object.hasOwn(group?.facets || {}, key))) return fail('POPULATION_MISMATCH');
        if (sortedJson(effective) !== sortedJson(source.declared)) return fail('POPULATION_MISMATCH');
      }
      represented.add(semantic.metric);
      const propertyType = semantic.property && (request.operation === 'value' || ownProperty) ? semantic.metric?.split('.')[0] : null;
      const propertyId = rowObject?.[ENTITY_ID_FIELDS[propertyType]];
      const owner = ownProperty ? propertyOwner(source, fact.field, propertyType) : null;
      if (factSuperseded(evidence, source, fact, { property: owner ? [propertyType, owner] : null })) return fail('STALE_EVIDENCE');
      if (rows && !ownProperty && !row) scalars.push({ evidenceId, source, path });
      // Varlık yalnızca ölçü taşıyan olguyla karşılanır; ad ya da etiket bağlamı yetmez.
      const reference = ({ type, id }) => {
        const key = entityKey(type, id);
        if (propertyId == null || type !== propertyType || key === entityKey(type, propertyId)) {
          referenced.add(key);
          if (!propertyType || !REQUEST_ENTITY_TYPES.includes(propertyType) || type === propertyType) {
            if (!metricEntities.has(semantic.metric)) metricEntities.set(semantic.metric, new Set());
            metricEntities.get(semantic.metric).add(key);
          }
        }
      };
      for (const selector of selectors) reference(selector);
      if (source.envelope?.entity?.id && REQUEST_ENTITY_TYPES.includes(source.envelope.entity.type)) {
        reference(source.envelope.entity);
      }
      rowEntities.forEach((key) => reference({ type: key.split(':')[0], id: key.slice(key.indexOf(':') + 1) }));
    }
    for (const item of factRows) {
      if (sourceCollections(source) && item.kind === 'row' && !sourceCollections(source).includes(item.canonical)) continue;
      const key = `${evidenceId}|${item.collection}`;
      if (!collections.has(key)) collections.set(key, { evidenceId, source, row: item, indexes: new Set(), metrics: new Map(), bound: true });
      const entry = collections.get(key);
      entry.indexes.add(item.index);
      if (substantive && conflictingRow) entry.conflicting = true;
      if (substantive) entry.metrics.set(item.index, (entry.metrics.get(item.index) || new Set()).add(semantic.metric));
      if (item.kind === 'row' && request.operation === 'value') {
        const grouped = group && group.facets !== null && (Object.keys(group.facets).length > 0 || group.selectors.length > 0);
        if (!named && !grouped) entry.bound = false;
      }
    }
  }
  const rowGroups = [...collections.values()].filter((entry) => entry.row.kind === 'row');
  const empty = rows && !rowGroups.length ? emptyRowSources(request, facts, evidence) : [];
  if (empty.some((item) => item.stale)) return fail('STALE_EVIDENCE');
  const vacuous = new Set(empty.flatMap(({ metrics: covered }) => covered));
  for (const { source } of empty) for (const selector of source.selectors) if (boundKeys.has(entityKey(selector.type, selector.id))) referenced.add(entityKey(selector.type, selector.id));
  if ([...metrics].some((metric) => !represented.has(metric) && !vacuous.has(metric) && !emptyRowMetric(metric, rowGroups))) return fail('METRIC_MISSING');
  // Bildirilen her alan bağı bir yükümlülüktür; aynı ölçünün başka bir alanı onun yerine geçmez.
  if (declaredFields.some((binding) => !satisfiedFields.has(binding) && !fieldVacuous(binding, rowGroups, empty))) return fail('METRIC_MISSING');
  if ([...boundKeys].some((key) => !referenced.has(key))) return fail('ENTITY_MISSING');
  if (bindingsRequired(request) && request.metrics.some((metric) => !bindings.some((binding) => binding.metric === metric))) return fail('ENTITY_METRIC_AMBIGUOUS');
  // Verilen her ölçü/varlık bağı, ölçü ve varlık sayısından bağımsız olarak uygulanır.
  for (const binding of bindings) {
    const entity = entities[binding.entity];
    if (!entity || !metricEntities.get(binding.metric)?.has(entityKey(entity.type, entity.bound))) return fail('ENTITY_MISSING');
  }
  for (const [metric, keys] of metricEntities) {
    const allowed = bindings.filter((binding) => binding.metric === metric);
    if (!allowed.length) continue;
    for (const key of keys) {
      if (boundKeys.has(key) && !allowed.some((binding) => entityKey(entities[binding.entity].type, entities[binding.entity].bound) === key)) return fail('ENTITY_MISMATCH');
    }
  }
  for (const entry of collections.values()) {
    const list = valueAt(entry.source.envelope, entry.row.collection);
    const size = Array.isArray(list) ? list.length : 0;
    // Çok değerli alan her istekte bütündür; satırların tamlığı istek türüne bağlıdır.
    if (entry.row.kind === 'list' && entry.indexes.size !== size) return fail('PARTIAL_VALUE_LIST');
    if (entry.row.kind !== 'row') continue;
    if (request.operation === 'value' && (entry.conflicting || (!entry.bound
      && (size !== 1 || !collectionComplete(entry.source, entry.row.canonical))))) return fail('ROW_SELECTION_UNBOUND');
  }
  if (request.operation === 'list') {
    // Bütün satırların istendiği liste yalnızca TAM bir nüfustan kurulur ve
    // nüfusun her somut kümesini (iç içe koleksiyonda seçilmeyen üst satırlar dâhil) kapsar.
    // Birden çok koleksiyonlu listede kanıttaki her bildirilen koleksiyon (boşsa boş olarak) listelenir.
    const populations = new Map(rowGroups.map((entry) => [`${entry.evidenceId}|${entry.row.canonical}`, entry]));
    const listed = new Map(rowGroups.map((entry) => [entry.evidenceId, entry.source]));
    for (const [evidenceId, source] of listed) {
      for (const canonical of sourceCollections(source) || []) {
        if (presentCollection(source.envelope, canonical)) populations.set(`${evidenceId}|${canonical}`, { evidenceId, source, row: { canonical } });
      }
    }
    for (const { evidenceId, source, row } of populations.values()) {
      if (!collectionComplete(source, row.canonical)) return fail('LIST_INCOMPLETE');
      for (const concrete of concreteCollections(source.envelope, row.canonical)) {
        const selected = collections.get(`${evidenceId}|${concrete.collection}`);
        if ((selected?.indexes.size || 0) !== concrete.rows.length) return fail('LIST_INCOMPLETE');
      }
    }
  }
  // Liste ve sıralama satırların yanıtıdır: satırların taşıyabildiği istenen ölçü
  // her satırda bulunmalıdır; genel bir toplam satırların değerinin yerine geçmez.
  if (rows) {
    const rowMetrics = [...metrics].filter((metric) => rowGroups.some((entry) =>
      rowMetricFields(entry.source.tool, entry.row.canonical, metric).length > 0));
    if (rowGroups.length && !rowMetrics.length) return fail('METRIC_MISSING');
    for (const metric of rowMetrics) {
      if (rowGroups.some((entry) => !rowMetricComplete(entry, metric))) return fail('METRIC_MISSING');
    }
    // Satırlarla birlikte verilen toplam, aynı kanıtta o satır koleksiyonunu sayan toplam olmalıdır;
    // boş nüfusta yalnızca boşluğu kanıtlayan kanıtın toplamı aynı nüfusu anlatır.
    for (const { evidenceId, source, path } of scalars) {
      if (!rowGroups.length && !empty.length) break;
      const counted = rowGroups.length
        ? rowGroups.some((entry) => entry.evidenceId === evidenceId && (collectionTotalPaths(source.tool, entry.row.canonical).includes(path)
          || parentProperty(source.tool, entry.row.canonical, path)))
        : empty.some((item) => item.source === source);
      if (!counted) return fail('POPULATION_MISMATCH');
    }
  }
  if (request.operation === 'list' && !rowGroups.length && !empty.length) return fail('LIST_ROWS_REQUIRED');
  if (request.operation === 'rank') {
    // Satırsız kanıt yalnızca nüfus boşken sıralamanın yanıtıdır.
    if (!rowGroups.length) return empty.length ? { ok: true, issues: [], empty: [...new Set(empty.map((item) => item.source.id))] } : fail('RANK_MISMATCH');
    if (rowGroups.length !== 1) return fail('RANK_MISMATCH');
    const [entry] = rowGroups;
    const indexes = rankedIndexes(request, entry.source, entry.row, entry.indexes);
    if (!indexes) return fail('RANK_MISMATCH');
    return { ok: true, issues: [], rankOrder: { evidenceId: entry.evidenceId, collection: entry.row.collection, indexes } };
  }
  // Boş nüfusun yanıtı: anlatı "eşleşen kayıt yok" der (yalnızca tamlık bayrağı değil).
  return empty.length ? { ok: true, issues: [], empty: [...new Set(empty.map((item) => item.source.id))] } : { ok: true, issues: [] };
}
