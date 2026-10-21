import { claimableContract, equivalentCarriers, METRICS, metricEntityType, metricEntry, metricPaths, NAMING_METRICS, PROPERTY_METRICS, RELATED_NAMING_METRICS, rowCollections, semanticCarrierKey } from './claimableEvidence.js';
import { createEvidenceFacts, FACT_LIMITS } from './evidenceFacts.js';
import { canonicalActualId } from '../identity/actualId.js';
import { scaledDecimal } from '../numbers/fixedDecimal.js';
import {
  canonicalField,
  carrierAvailable,
  collectionComplete,
  collectionTotalPaths,
  collectionTotalMetric,
  concreteCollections,
  insideRowCollection,
  metricDimensionsMatch,
  presentCollection,
  provesEmptyCollection,
  readLater,
  rowKey,
  scalarKey
} from './evidencePopulation.js';
export { presentCollection } from './evidencePopulation.js';

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
export const REQUEST_LIMITS = Object.freeze({ maxMetrics: 8, maxEntities: 4, maxRankLimit: 10, maxPreviousResultRows: 50 });

/** Önceki sonuç yalnızca sunucunun doğruladığı sınırlı görev kimliklerini taşır; veri ya da yetki değildir. */
export function taskResultScope(value) {
  if (!value || value.type !== 'task' || Object.keys(value).some(key => !['type', 'taskIds'].includes(key))
    || !Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > REQUEST_LIMITS.maxPreviousResultRows) return null;
  const taskIds = value.taskIds.map(canonicalActualId);
  if (taskIds.some(id => !id) || new Set(taskIds).size !== taskIds.length) return null;
  return Object.freeze({ type: 'task', taskIds: Object.freeze(taskIds) });
}

/** Sıralanamayan ölçme birimleri: metin, sınıf, bayrak, tanım, birimi satıra göre değişen ya da ondalık metin değerler. */
const UNORDERED_MEASURES = new Set(['text', 'enum', 'boolean', 'definition', 'lag', 'value', 'currency-unspecified']);

export function rankableMeasure(measure) {
  return typeof measure === 'string' && !UNORDERED_MEASURES.has(measure);
}

/** Satırın kimlik alanı, bildirilen varlık türüne göre. */
export const ENTITY_ID_FIELDS = Object.freeze({ project: 'projectId', task: 'taskId', person: 'sicil', wbs: 'wbsId', baseline: 'baselineId' });

/** Aynı nüfusa birlikte uygulanan mevcut seçiciler; karşılaştırma öznesi değildir. */
const JOINT_SELECTORS = Object.freeze({
  rota_task_search: ['project', 'person', 'wbs'], rota_task_analytics: ['project', 'person', 'wbs'],
  rota_workload_summary: ['project', 'person'], rota_wbs_inspect: ['project', 'wbs'], rota_baseline_compare: ['project', 'baseline']
});

export function conjunctiveEntities(request) {
  const entities = request.entities || [];
  if (new Set((request.bindings || []).map((binding) => binding.entity)).size > 1) return false;
  return entities.length > 1 && new Set(entities.map((entity) => entity.type)).size === entities.length
    && entities.every((entity) => JOINT_SELECTORS[request.population?.tool]?.includes(entity.type));
}

/** Doğrulama, boş alan çizimi ve seçim aynı ölçü/varlık bağını kullanır. */
export function metricAllowedForRow(request, metric, source, row, collection = null) {
  const fields = (request.fields || []).filter((field) => field.metric === metric);
  if (collection && fields.length && !fields.some((field) => field.tool === source.tool
    && field.path.startsWith(`data.${collection}.*.`))) return false;
  const bindings = (request.bindings || []).filter((binding) => binding.metric === metric);
  if (!bindings.length) return true;
  return bindings.some((binding) => {
    const entity = request.entities[binding.entity];
    if (!entity) return false;
    const field = ENTITY_ID_FIELDS[entity.type];
    const id = row?.[field] ?? row?.[entity.type]?.[field];
    return id != null ? entityKey(entity.type, id) === entityKey(entity.type, entity.bound ?? entity.id)
      : source.selectors?.some((selector) => entityKey(selector.type, selector.id) === entityKey(entity.type, entity.bound ?? entity.id));
  });
}

const sortedJson = (value) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));

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
 * Üreticinin satırda OKUYUP boşken yazmadığı tekil özellikler (kısa yük). Yalnızca bu
 * alanlarda yazılmamış alan boşluk kanıtıdır; kayıtta yeri olsa da üreticinin okumadığı
 * alan (ör. öncül satırındaki termin) okunmamıştır, boş değildir.
 */
const OMITTED_WHEN_EMPTY = Object.freeze({
  rota_task_search: { tasks: ['keyword', 'targetFinish', 'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'progressPercent',
    'createdAt', 'updatedAt', 'overdueDays', 'project.code'] },
  rota_project_search: { matches: ['code', 'lead'] },
  rota_person_search: { people: ['jobTitle'] },
  rota_portfolio_summary: { projects: ['code'] },
  rota_baseline_compare: { mostSlipped: ['targetFinish'] },
  rota_schedule_requests: { items: ['decidedAt', 'project.code'] },
  rota_assignment_requests: { items: ['requestedAssigneeOrganization', 'suggestedAssignee', 'targetFinish', 'decidedBy', 'decidedAt', 'project.code'] },
  rota_activity_search: { items: ['project.code'] },
  rota_notifications: { 'taskEvents.latest': ['by'] },
  rota_outlook_status: { items: ['deliveredCalendarDate', 'lastDeliveredAt', 'failure.code', 'failure.message'] }
});

/**
 * Satır alanının TEK durum tanımı: değer var, alan BOŞ (açık null, boş çok değerli alan, ör.
 * sorumlusu olmayan görev: `assignees: []`, ya da üreticinin okuyup boşken yazmadığı özellik)
 * ya da alan YOK (okunmamış). Boş alan bir değerdir (yalnızca kısaltılmamış kanıtta); olmayan
 * alan ölçüyü taşımaz. Hazırlık, doğrulama, çizim ve tazelik bu durumu kullanır.
 */
export function rowFieldState(tool, collection, row, field) {
  if (!carrierAvailable({ tool }, `data.${collection}.*.${field}`, row)) return 'absent';
  const parts = field.split('.');
  const values = pathValues(row, parts);
  if (values.some((value) => value !== null)) return 'value';
  if (values.length) return 'empty';
  const star = parts.indexOf('*');
  if (star < 0) return row && typeof row === 'object' && OMITTED_WHEN_EMPTY[tool]?.[collection]?.includes(field) ? 'empty' : 'absent';
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

/** Ayrı anlamlı satır taşıyıcıları kayıt boş olsa da SQL'den önce bağlanır. */
export function unboundCarrierMetrics(request) {
  const tool = request.population?.tool;
  if (!tool) return [];
  const collections = request.population.collection ? [request.population.collection] : listCollections(tool, request.metrics);
  return request.metrics.filter((metric) => {
    if ((request.fields || []).some((field) => field.metric === metric)) return false;
    const paths = metricPaths(tool, metric).filter((path) => metricEntry(tool, path.replace(/^data\./, ''))?.property
      && (request.operation === 'value' || collections.some((collection) => path.startsWith(`data.${collection}.*.`))));
    return paths.length > 1 && !equivalentCarriers(tool, paths);
  });
}

/** Sıralama alanı kayıtlı tek taşıyıcıdır; boş özellik ile eksik sayaç ayrıdır. */
function rankField(request, tool, canonical, rows) {
  const bound = (request.fields || []).filter((field) => field.metric === request.rank.metric && field.tool === tool);
  const fields = rowMetricFields(tool, canonical, request.rank.metric).filter((field) => !bound.length
    || bound.some((binding) => binding.path === `data.${canonical}.*.${field}`));
  const written = fields.filter((field) => rows.some((row) => fieldValue(row, field) !== undefined));
  return written.length === 1 ? written[0] : fields.length === 1 ? fields[0] : null;
}

/** Tek somut koleksiyonun ölçüye göre başı: `limit` satır ve sınırdaki eşitler (kanıttaki değerlerden). */
function rankPlan(request, source, collection) {
  const rows = valueAt(source.envelope, collection.collection);
  if (!Array.isArray(rows)) return null;
  const field = rankField(request, source.tool, collection.canonical, rows);
  if (!field || rows.some((row) => rowFieldState(source.tool, collection.canonical, row, field) === 'absent')) return null;
  const direction = request.rank.order === 'asc' ? 1 : -1;
  const rankValue = (value) => METRICS[request.rank.metric] === 'hours' ? scaledDecimal(value, 2) : value;
  const ranked = rows.map((row, index) => ({ index, value: rankValue(fieldValue(row, field)) }))
    .filter((item) => item.value != null)
    .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0) * direction || left.index - right.index);
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
 * Sıralama yanıtı: tek okumanın tek somut koleksiyonunda ölçüye göre baştaki
 * `limit` satır ve onlarla eşit değerdeki satırlar. Tam koleksiyonu sunucu
 * değerlerden sıralar; kesilmiş koleksiyonda yalnızca aracın aynı ölçüyle
 * sıraladığı ilk sayfa ve sınır kanıtı kabul edilir. Sayfalar birleştirilmez.
 */
function rankedIndexes(request, source, collection, selected) {
  const plan = rankPlan(request, source, collection);
  if (!plan) return null;
  const { rows, ranked, boundary, order, direction, rankValue } = plan;
  const expected = new Set(order);
  if (expected.size !== selected.size || [...expected].some((index) => !selected.has(index))) return null;
  if (collectionComplete(source, collection.canonical)) return order;
  const sorted = source.sortedBy?.metric === request.rank.metric && source.sortedBy?.order === request.rank.order && source.firstPage === true;
  if (!sorted) return null;
  if (ranked[expected.size]) return order;
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
  return !conjunctiveEntities(request) && (request.entities || []).length > 1 && new Set(request.metrics.filter((metric) => !NAMING_METRICS.has(metric))).size > 1;
}

/* ── Tazelik ──────────────────────────────────────────────── */

/** Kanıtın satırının adlandırdığı varlık ya da seçicisi: varlığın kendi özelliğinin sahibi. */
export function propertyOwner(source, field, type) {
  if (!type || !ENTITY_ID_FIELDS[type]) return null;
  const row = factCollections(source.tool, field).findLast((item) => item.kind === 'row');
  const object = row ? valueAt(source.envelope, row.path) : null;
  const id = object?.[ENTITY_ID_FIELDS[type]] ?? object?.[type]?.[ENTITY_ID_FIELDS[type]]
    ?? (type === 'task' ? object?.templateTaskId ?? object?.seriesTaskId : null);
  if (id != null) return entityKey(type, id);
  if (row) return null;
  if (type === 'task' && source.tool === 'rota_recurrence_inspect') {
    const taskId = source.envelope?.data?.series?.templateTaskId ?? source.envelope?.data?.task?.taskId;
    if (taskId != null) return entityKey(type, taskId);
  }
  const selector = (source.selectors || []).find((item) => item.type === type);
  return selector ? entityKey(type, selector.id) : null;
}

/**
 * Daha yeni okumanın özellik durumları (değer ya da açık boşluk): yalnızca eski olguyu eskitmek için
 * kullanılır. Kısaltılmış yükte kalan değer de günceldir; kısaltılmış yük boşluk KANITI olmasa da
 * (bkz. emptyPropertyProofs) eskitmesi yalnızca doğrulamayı daraltır.
 */
function propertyStates(source, metric) {
  const states = [];
  const visit = (value, parts, path, full) => {
    if (!parts.length) {
      if (value !== undefined && carrierAvailable(source, path.replace(/^\./, ''))) states.push({ field: path, key: semanticCarrierKey(source.tool, full) });
      return;
    }
    const [head, ...tail] = parts;
    if (head === '*') {
      if (!Array.isArray(value)) return;
      if (!value.length) states.push({ field: `${path}.${parts.map((part) => part === '*' ? '0' : part).join('.')}`, key: semanticCarrierKey(source.tool, full) });
      else value.forEach((item, index) => visit(item, tail, `${path}.${index}`, full));
    } else if (value && typeof value === 'object') {
      if (Object.hasOwn(value, head)) visit(value[head], tail, `${path}.${head}`, full);
      else if (!tail.length) {
        const field = `${path}.${head}`.replace(/^\./, '');
        const row = factRow(source.tool, field);
        const relative = row && full.slice(`data.${row.canonical}.*.`.length);
        if (row?.kind === 'row' && rowFieldState(source.tool, row.canonical, valueAt(source.envelope, row.path), relative) === 'empty') {
          states.push({ field, key: semanticCarrierKey(source.tool, full) });
        }
      }
    }
  };
  for (const path of metricPaths(source.tool, metric)) {
    if (metricEntry(source.tool, path.replace(/^data\./, ''))?.property) visit(source.envelope, path.split('.'), '', path);
  }
  return states.map((state) => ({ ...state, field: state.field.replace(/^\./, '') }));
}

/** Görev sayımlarının araçlar arası tek açık eşdeğerlik sınıfı; başka sayımlar araca bağlıdır. */
const TASK_COUNT_TOOLS = new Set(['rota_task_search', 'rota_task_analytics', 'rota_project_detail', 'rota_task_detail', 'rota_workload_summary']);

/**
 * Tek tazelik kuralı: olgunun niceliği turda daha sonra yeniden okunduysa eski olgu
 * kullanılamaz. Olgu yanıttaki rolüyle değerlendirilir: liste/sıralama satırı aynı
 * aracın aynı satır nüfusunun daha sonraki HER okumasıyla (tam olmasa da); varlığın
 * kendi özelliği aynı varlığın aynı anlamsal özelliğini (açık boşluğu dâhil) taşıyan
 * okumayla; toplam aynı nüfusun aynı taşıyıcısıyla eskir. Okumalar karşılaştırılmaz.
 */
export function factSuperseded(evidence, source, fact, { rows = false } = {}) {
  const metric = fact.semantic?.metric;
  const row = factRow(source.tool, fact.field);
  const type = metricEntityType(metric);
  const owner = fact.semantic?.property && !(rows && row?.kind === 'row') ? propertyOwner(source, fact.field, type) : null;
  const carrier = semanticCarrierKey(source.tool, fact.field);
  for (const newer of evidence.values()) {
    if (newer === source || !readLater(newer, source)) continue;
    if (owner) {
      if (propertyStates(newer, metric).some((item) => item.key === carrier && propertyOwner(newer, item.field, type) === owner)) return true;
      continue;
    }
    if (newer.unsupported?.length) continue;
    if (row?.kind === 'row') {
      if (newer.tool === source.tool && rowKey(newer, row.canonical) === rowKey(source, row.canonical)) return true;
      continue;
    }
    if (scalarKey(newer, metric) !== scalarKey(source, metric)) continue;
    const taskCounts = !row && newer.tool !== source.tool && metric?.startsWith('tasks.') && TASK_COUNT_TOOLS.has(source.tool) && TASK_COUNT_TOOLS.has(newer.tool);
    if ((newer.facts || []).some((item) => item.semantic?.metric === metric && (taskCounts ? !factRow(newer.tool, item.field)
      : newer.tool === source.tool && equivalentCarriers(source.tool, [fact.field, item.field])))) return true;
  }
  return false;
}

/** Boş alan da olgudur: aynı tek tazelik kuralıyla eskir (daha yeni değer ya da okuma eski boşluğu geçersiz kılar). */
export function emptyFieldCurrent(evidence, source, field, metric, rows) {
  const property = metricEntry(source.tool, canonicalField(field).replace(/^data\./, ''))?.property === true;
  return !factSuperseded(evidence, source, { field, semantic: { metric, property } }, { rows });
}

/**
 * Bağlı varlığın satır dışı çok değerli özelliğinin açık boşluğu (ör. sorumlusu olmayan görevin
 * ayrıntısında `task.assignees: []`): `[{ field, owner }]`. Kısaltılmamış kanıt, alan bağı,
 * ölçü/varlık bağı ve tazelik uygulanır; doğrulama ve sunucu seçimi bu tanımı paylaşır.
 */
export function emptyPropertyProofs(request, entities, source, metric, evidence) {
  const type = metricEntityType(metric);
  if (!ENTITY_ID_FIELDS[type] || source.envelope?.data?.sizeNote != null) return [];
  const declared = (request.fields || []).filter((item) => item.metric === metric);
  const allowed = (request.bindings || []).filter((item) => item.metric === metric).map((item) => entities[item.entity]).filter(Boolean);
  const owners = (allowed.length ? allowed : entities).filter((entity) => entity.type === type && entity.bound != null)
    .map((entity) => entityKey(type, entity.bound));
  return metricPaths(source.tool, metric).flatMap((path) => {
    const star = path.indexOf('.*');
    if (star < 0 || insideRowCollection(source.tool, path) || metricEntry(source.tool, path.slice(5))?.property !== true
      || (declared.length && !declared.some((item) => item.tool === source.tool && item.path === path))) return [];
    const container = valueAt(source.envelope, path.slice(0, star));
    if (!Array.isArray(container) || container.length) return [];
    const field = path.replace(/\*/g, '0');
    const owner = propertyOwner(source, field, type);
    return owner && owners.includes(owner) && emptyFieldCurrent(evidence, source, field, metric, false) ? [{ field, owner }] : [];
  });
}

/** Boş nüfus kanıtı satır nüfusu ve onun sayımıdır; ikisine de aynı tazelik kuralı uygulanır. */
function emptyProofSuperseded(evidence, source, canonical) {
  const metric = collectionTotalMetric(source.tool, canonical);
  return [...evidence.values()].some((newer) => newer !== source && readLater(newer, source) && !newer.unsupported?.length
    && newer.tool === source.tool && rowKey(newer, canonical) === rowKey(source, canonical))
    || Boolean(metric) && collectionTotalPaths(source.tool, canonical)
      .some((path) => factSuperseded(evidence, source, { field: path, semantic: { metric } }));
}

const rowDimensions = (source) => source.rowDimensionsMatch ?? source.dimensionsMatch;

/* ── Boş nüfus ────────────────────────────────────────────── */

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
    return [{ source, metrics: rowMetrics, collections: compatible, stale: compatible.some((canonical) => emptyProofSuperseded(evidence, source, canonical)) }];
  });
}

/* ── Satır bütünlüğü ──────────────────────────────────────── */

/**
 * Seçilen satırların her biri, taşıyabildiği istenen ölçünün olgusunu da taşıyor mu?
 * Değeri olan satır ölçünün olgusunu ister; çok değerli alanı boş olan satır
 * (kısaltılmamış kanıtta) ölçüyü boş değeriyle taşır; alanı olmayan satır taşımaz.
 */
function rowMetricComplete(entry, metric, request, evidence, rowsAnswer) {
  const prefix = `data.${entry.row.canonical}.*.`;
  const bound = (request.fields || []).filter((field) => field.metric === metric && field.tool === entry.source.tool && field.path.startsWith(prefix));
  const fields = bound.length ? bound.map((field) => field.path.slice(prefix.length)) : rowMetricFields(entry.source.tool, entry.row.canonical, metric);
  const rows = valueAt(entry.source.envelope, entry.row.collection) || [];
  const untrimmed = entry.source.envelope?.data?.sizeNote == null;
  return [...entry.indexes].every((index) => {
    const row = rows[index];
    if (!row) return false;
    if (!metricAllowedForRow(request, metric, entry.source, row, entry.row.canonical)) return true;
    const states = fields.map((field) => rowFieldState(entry.source.tool, entry.row.canonical, row, field));
    const empty = (field, position) => untrimmed && states[position] === 'empty'
      && emptyFieldCurrent(evidence, entry.source, `${entry.row.collection}.${index}.${field.replace(/\*/g, '0')}`, metric, rowsAnswer);
    if (bound.length) return fields.every((field, position) => states[position] === 'value'
      ? entry.metrics.get(index)?.has(semanticCarrierKey(entry.source.tool, `${prefix}${field}`))
      : empty(field, position));
    const present = fields.filter((field, position) => states[position] !== 'absent');
    if (present.length > 1 && !equivalentCarriers(entry.source.tool, present.map((field) => `${prefix}${field}`))) return false;
    if (states.includes('value')) return entry.metrics.get(index)?.has(metric) === true;
    return fields.some(empty);
  });
}

/**
 * Seçilen satırların hiçbiri ölçünün değerini taşımıyor ama hepsinde ölçünün alanı
 * (kısaltılmamış ve güncel kanıtta) açıkça boşsa ölçü boş değeriyle verilmiştir.
 */
function emptyRowMetric(metric, rowGroups, request, evidence, rowsAnswer) {
  const carrying = rowGroups.filter((entry) => rowMetricFields(entry.source.tool, entry.row.canonical, metric).length);
  return carrying.length > 0 && carrying.every((entry) => rowMetricComplete(entry, metric, request, evidence, rowsAnswer));
}

/** Açık alan bağı, seçilen satırların hepsinde o alan güncel olarak boşsa ya da koleksiyon boşsa boşta karşılanır. */
function fieldVacuous(binding, rowGroups, empty, evidence, rowsAnswer) {
  return rowCollections(binding.tool).some((collection) => {
    const prefix = `data.${collection}.*.`;
    if (!binding.path.startsWith(prefix)) return false;
    if (empty.some((item) => item.source.tool === binding.tool && item.collections.includes(collection))) return true;
    const relative = binding.path.slice(prefix.length);
    const entries = rowGroups.filter((entry) => entry.source.tool === binding.tool && entry.row.canonical === collection);
    return entries.length > 0 && entries.every((entry) => entry.source.envelope?.data?.sizeNote == null && [...entry.indexes]
      .every((index) => rowFieldState(binding.tool, collection, (valueAt(entry.source.envelope, entry.row.collection) || [])[index], relative) === 'empty'
        && emptyFieldCurrent(evidence, entry.source, `${entry.row.collection}.${index}.${relative.replace(/\*/g, '0')}`, binding.metric, rowsAnswer)));
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
  if (unboundCarrierMetrics(request).length) return fail('FIELD_BINDING_REQUIRED');
  evidence = new Map([...evidence].map(([id, source]) => [id, { ...source, id }]));
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
    if (!carrierAvailable(source, fact.field)) return fail('METRIC_MISSING');
    const substantive = metrics.has(semantic.metric);
    if (!substantive && !semantic.context) return fail('UNDECLARED_METRIC');
    const factRows = factCollections(source.tool, fact.field);
    const row = factRows.findLast((item) => item.kind === 'row') || factRows[0] || null;
    const rowObject = row ? valueAt(source.envelope, row.path) : null;
    const rowEntities = rowObject && typeof rowObject === 'object'
      ? Object.entries(ENTITY_ID_FIELDS).filter(([type, field]) => (rowObject[field] ?? rowObject[type]?.[field]) != null)
        .map(([type, field]) => entityKey(type, rowObject[field] ?? rowObject[type]?.[field])) : [];
    const conflictingRow = rowEntities.some((key) => !boundKeys.has(key)
      && entities.some((entity) => key.startsWith(`${entity.type}:`)));
    const named = row?.kind === 'row' && rowEntities.some((entity) => boundKeys.has(entity));
    // Değer isteğinde bağlı varlığın kendi özelliği (adlandırılan satır ya da
    // seçicinin kaydı) nüfus koşulundan bağımsızdır; toplamlar ve sayımlar değildir.
    // Kaydın satır dışı çok değerli özelliği (ör. projenin etiketleri) satır değildir: yine kaydın kendi özelliğidir.
    const inRow = row?.kind === 'row';
    const ownProperty = semantic.property === true && (request.operation === 'value' || !inRow)
      && (named || ((!inRow || row.path === fact.field) && source.selectors.length > 0));
    const group = request.operation === 'value' && row?.kind === 'row' && !named ? groupScope(fact) : null;
    const selectors = [...source.selectors, ...(group?.selectors || [])];
    if (selectors.some(({ type, id }) => !boundKeys.has(entityKey(type, id)))) return fail('ENTITY_MISMATCH');
    if (substantive) {
      const fieldBindings = declaredFields.filter((item) => item.metric === semantic.metric);
      const path = fact.field.startsWith('data.') ? canonicalField(fact.field) : fact.field;
      const binding = fieldBindings.find((item) => item.tool === source.tool && item.path === path);
      // Satır olgusu satır nüfusunu (gruplama dâhil), toplam yalnızca toplamın nüfusunu belirleyen boyutları ister.
      // Değer isteğinde anahtarı bildirilen koşulu bağlayan grup satırı bildirilen nüfusun kendisidir.
      const dimensionsMatch = metricDimensionsMatch(source, request, semantic.metric, row?.kind === 'row' && !group);
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
      const propertyType = semantic.property && (request.operation === 'value' || ownProperty) ? metricEntityType(semantic.metric) : null;
      const propertyId = rowObject?.[ENTITY_ID_FIELDS[propertyType]] ?? rowObject?.[propertyType]?.[ENTITY_ID_FIELDS[propertyType]];
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
    // Tek tazelik kuralı her seçilen olguya uygulanır: adlandıran bağlam da eskimiş okumadan gelemez.
    if (factSuperseded(evidence, source, fact, { rows })) return fail('STALE_EVIDENCE');
    for (const item of factRows) {
      if (sourceCollections(source) && item.kind === 'row' && !sourceCollections(source).includes(item.canonical)) continue;
      const key = `${evidenceId}|${item.collection}`;
      if (!collections.has(key)) collections.set(key, { evidenceId, source, row: item, indexes: new Set(), metrics: new Map(), bound: true });
      const entry = collections.get(key);
      entry.indexes.add(item.index);
      if (substantive && conflictingRow) entry.conflicting = true;
      if (substantive) entry.metrics.set(item.index, (entry.metrics.get(item.index) || new Set()).add(semantic.metric).add(semanticCarrierKey(source.tool, fact.field)));
      if (item.kind === 'row' && request.operation === 'value') {
        const grouped = group && group.facets !== null && (Object.keys(group.facets).length > 0 || group.selectors.length > 0);
        if (!named && !grouped) entry.bound = false;
      }
    }
  }
  const rowGroups = [...collections.values()].filter((entry) => entry.row.kind === 'row');
  // Boş özellik de kendi varlığına bağlıdır; başka satıra boş değer eklenemez.
  for (const entry of rowGroups) for (const index of entry.indexes) for (const metric of metrics) {
    const object = valueAt(entry.source.envelope, entry.row.path.replace(/\.\d+$/, `.${index}`));
    if (!metricAllowedForRow(request, metric, entry.source, object, entry.row.canonical) || entry.source.envelope?.data?.sizeNote != null) continue;
    const prefix = `data.${entry.row.canonical}.*.`;
    const fields = rowMetricFields(entry.source.tool, entry.row.canonical, metric).filter((field) => !declaredFields.some((item) => item.metric === metric)
      || declaredFields.some((item) => item.metric === metric && item.tool === entry.source.tool && item.path === `${prefix}${field}`));
    if (!fields.length || !fields.every((field) => rowFieldState(entry.source.tool, entry.row.canonical, object, field) === 'empty'
      && emptyFieldCurrent(evidence, entry.source, `${entry.row.collection}.${index}.${field.replace(/\*/g, '0')}`, metric, rows))) continue;
    const owner = propertyOwner(entry.source, `${entry.row.collection}.${index}.${fields[0]}`, metricEntityType(metric));
    if (!owner || !boundKeys.has(owner)) continue;
    referenced.add(owner);
    if (!metricEntities.has(metric)) metricEntities.set(metric, new Set());
    metricEntities.get(metric).add(owner);
  }
  // Atfedilen kanıtta bağlı varlığın satır dışı çok değerli özelliği açıkça boşsa ölçü boş değeriyle verilmiştir.
  // Boşluk kendi sahibinindir: başka varlığın değeri onu, onun boşluğu başka varlığın değerini karşılamaz.
  const cited = [...new Set(facts.map(({ evidenceId }) => evidenceId))].map((id) => evidence.get(id));
  const emptyProperties = [...metrics].flatMap((metric) => cited
    .flatMap((source) => emptyPropertyProofs(request, entities, source, metric, evidence).map((proof) => ({ ...proof, metric, source }))))
    .filter(({ metric, owner }, index, all) => !metricEntities.get(metric)?.has(owner)
      && all.findIndex((other) => other.metric === metric && other.owner === owner) === index);
  for (const { metric, owner } of emptyProperties) {
    referenced.add(owner);
    if (!metricEntities.has(metric)) metricEntities.set(metric, new Set());
    metricEntities.get(metric).add(owner);
  }
  // Çizim doğrulanmış boş özellikleri kullanır; JavaScript özelliğinin yokluğundan boşluk çıkarılmaz.
  const passed = (extra) => ({ ok: true, issues: [], ...extra,
    ...(emptyProperties.length ? { emptyProperties: emptyProperties.map(({ source, field, metric }) => ({ evidenceId: source.id, field, metric })) } : {}) });
  const empty = rows && !rowGroups.length ? emptyRowSources(request, facts, evidence) : [];
  if (empty.some((item) => item.stale)) return fail('STALE_EVIDENCE');
  const vacuous = new Set([...empty.flatMap(({ metrics: covered }) => covered), ...emptyProperties.map(({ metric }) => metric)]);
  for (const { source } of empty) for (const selector of source.selectors) if (boundKeys.has(entityKey(selector.type, selector.id))) referenced.add(entityKey(selector.type, selector.id));
  if ([...metrics].some((metric) => !represented.has(metric) && !vacuous.has(metric) && !emptyRowMetric(metric, rowGroups, request, evidence, rows))) return fail('METRIC_MISSING');
  // Bildirilen her alan bağı bir yükümlülüktür; aynı ölçünün başka bir alanı onun yerine geçmez.
  if (declaredFields.some((binding) => !satisfiedFields.has(binding) && !fieldVacuous(binding, rowGroups, empty, evidence, rows)
    && !emptyProperties.some(({ metric, source, field }) => metric === binding.metric && source.tool === binding.tool && canonicalField(field) === binding.path))) return fail('METRIC_MISSING');
  if ([...boundKeys].some((key) => !referenced.has(key))) return fail('ENTITY_MISSING');
  if (bindingsRequired(request) && request.metrics.some((metric) => !NAMING_METRICS.has(metric) && !bindings.some((binding) => binding.metric === metric))) return fail('ENTITY_METRIC_AMBIGUOUS');
  // Bağsız, kesişim olmayan çok varlıklı değer isteğinde ölçen her ölçü, uygulandığı HER varlıkta
  // (değer ya da doğrulanmış boşlukla) verilir; bir varlığın adı başka varlığın değerinin yerine geçmez.
  if (request.operation === 'value' && boundKeys.size > 1 && !conjunctiveEntities(request)) {
    for (const metric of metrics) {
      // Yalnızca boş nüfus ölçüyü bütün varlıklar için karşılar; sahibine ait boşluk sahibinin değeridir.
      // Kaydın kendi adı kaydın anılmasıyla verilir; başka kaydın adı (görevin projesi) sahibinin ölçülen özelliğidir.
      if ((NAMING_METRICS.has(metric) && !RELATED_NAMING_METRICS.has(metric)) || empty.some(({ metrics: covered }) => covered.includes(metric))
        || bindings.some((binding) => binding.metric === metric)) continue;
      // Özellik sahibinin türündeki varlıklarda, toplam ve sayım kendi türünde (ör. tekrar sayımı her projede) verilir.
      const type = PROPERTY_METRICS.has(metric) ? metricEntityType(metric) : String(metric).split('.')[0];
      const expected = entities.filter((entity) => !REQUEST_ENTITY_TYPES.includes(type) || entity.type === type);
      if (expected.some((entity) => !metricEntities.get(metric)?.has(entityKey(entity.type, entity.bound)))) return fail('ENTITY_MISSING');
    }
  }
  // Verilen her ölçü/varlık bağı, ölçü ve varlık sayısından bağımsız olarak uygulanır.
  for (const binding of bindings) {
    const entity = entities[binding.entity];
    if (!entity || !metricEntities.get(binding.metric)?.has(entityKey(entity.type, entity.bound))) return fail('ENTITY_MISSING');
  }
  for (const [metric, keys] of metricEntities) {
    const allowed = bindings.filter((binding) => binding.metric === metric);
    if (!allowed.length) continue;
    for (const key of keys) {
      if (boundKeys.has(key) && !allowed.some((binding) => entityKey(entities[binding.entity].type, entities[binding.entity].bound) === key)
        && !conjunctiveEntities(request)) return fail('ENTITY_MISMATCH');
    }
  }
  for (const entry of collections.values()) {
    const list = valueAt(entry.source.envelope, entry.row.collection);
    const size = Array.isArray(list) ? list.length : 0;
    // Çok değerli alan her istekte bütündür; satırların tamlığı istek türüne bağlıdır.
    if (entry.row.kind === 'list' && entry.indexes.size !== size) return fail('PARTIAL_VALUE_LIST');
    // Bütünlük ölçü başınadır: bir ölçünün seçilen öğesi, başka ölçünün eksik öğesinin yerini tutmaz.
    if (entry.row.kind === 'list') {
      const canonical = `data.${entry.row.canonical}.*`;
      for (const metric of metrics) {
        if (![...entry.metrics.values()].some((carried) => carried.has(metric))) continue;
        // Koleksiyonun kendi olgularıyla denetlenir: kanıtın sınırlı olgu dizini son öğeleri taşımayabilir; sınıra ulaşan koleksiyon tam kanıtlanamaz.
        const fields = metricPaths(entry.source.tool, metric).filter((path) => path === canonical || path.startsWith(`${canonical}.`))
          .map((path) => `${entry.row.collection}${path.slice(`data.${entry.row.canonical}`.length)}`);
        const own = createEvidenceFacts(entry.source.envelope, { prefix: entry.source.envelope?.factScope, fields });
        if (own.length >= FACT_LIMITS.maxFacts) return fail('PARTIAL_VALUE_LIST');
        const missing = own.some((fact) => fact.semantic?.metric === metric
          && factCollections(entry.source.tool, fact.field).some((item) => item.collection === entry.row.collection && !entry.metrics.get(item.index)?.has(metric)));
        if (missing) return fail('PARTIAL_VALUE_LIST');
      }
    }
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
        populations.set(`${evidenceId}|${canonical}`, { evidenceId, source, row: { canonical } });
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
      if (rowGroups.some((entry) => !rowMetricComplete(entry, metric, request, evidence, rows))) return fail('METRIC_MISSING');
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
    if (!rowGroups.length) return empty.length ? passed({ empty: [...new Set(empty.map((item) => item.source.id))] }) : fail('RANK_MISMATCH');
    // Sıralama tek okumanın tek somut koleksiyonudur; sayfa ve iç içe kümeler birleştirilmez.
    if (rowGroups.length !== 1) return fail('RANK_MISMATCH');
    const [entry] = rowGroups;
    const indexes = rankedIndexes(request, entry.source, entry.row, entry.indexes);
    if (!indexes) return fail('RANK_MISMATCH');
    return passed({ rankOrder: { evidenceId: entry.evidenceId, collection: entry.row.collection, indexes } });
  }
  // Boş nüfusun yanıtı: anlatı "eşleşen kayıt yok" der (yalnızca tamlık bayrağı değil).
  return passed(empty.length ? { empty: [...new Set(empty.map((item) => item.source.id))] } : {});
}
