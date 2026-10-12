import 'server-only';
import { EVIDENCE_TEXT_FIELDS, metricEntityType, metricEntry, metricPaths, NAMING_METRICS, rowCollections } from '../../../domain/ai/claimableEvidence.js';
import { BREAKDOWN_FILTERS, collectionTotalMetric, insideRowCollection, populationDimensions } from '../../../domain/ai/evidencePopulation.js';
import { bindingsRequired, conjunctiveEntities, listCollections, parentProperty, REQUEST_ENTITY_TYPES, rowMetricFields, unboundCarrierMetrics } from '../../../domain/ai/requestContract.js';
import { METRICS } from '../../../domain/ai/claimableEvidence.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { effectivePageSize } from './rota/rotaToolSupport.js';
import { addDays, normalizeTaskFilters } from './rota/taskFacts.js';
import { parseToolArguments } from './toolArguments.js';
import { getRotaTool, toolCatalogForModel } from './toolRegistry.js';
import { containmentText, populationArguments } from './toolScope.js';

/**
 * Rota isteğinin TEK nüfus kimliği.
 *
 * Bir aracın yürütülen bağımsız değişkenleri ile bildirilen istek aynı
 * kanonik biçime çevrilir: koşullar (`facets`), varlık seçicileri ve boyutlar
 * (sıra, gruplama, WBS derinliği, korumalı metin alanları). Verilmeyen boyut
 * aracın varsayılanıdır; joker değildir. İstek veri okunmadan önce planın kendi
 * nüfus çağrılarıyla tamamlanır: istekte verilmeyen koşul ve boyut çağrıdan
 * alınır, çelişen ya da belirsiz olan reddedilir. Böylece SQL çalışmadan önce
 * nüfusun anlamı türlü istekte eksiksiz bulunur ve sonraki her denetim
 * (sunucu seçimi, model seçiminin doğrulaması, tazelik, devir kararı) aynı
 * kimliği karşılaştırır.
 */

const FAMILY_KEYS = Object.freeze({
  task: ['status', 'priority', 'deadline', 'dateField', 'dateFrom', 'dateTo', 'period', 'assignee', 'createdByMe', 'milestone', 'text'],
  projectSearch: ['text'],
  personSearch: ['text'],
  workflow: ['tab', 'workflowStatus', 'dateFrom', 'dateTo', 'period', 'text'],
  portfolio: ['source', 'includeEmpty'],
  activity: ['dateFrom', 'dateTo', 'period', 'activityScope', 'activityKind'],
  calendar: ['dateFrom', 'dateTo', 'period']
});
const FAMILIES = Object.freeze({
  rota_task_search: 'task', rota_task_analytics: 'task', rota_project_search: 'projectSearch', rota_person_search: 'personSearch',
  rota_schedule_requests: 'workflow', rota_assignment_requests: 'workflow',
  rota_portfolio_summary: 'portfolio', rota_activity_search: 'activity', rota_calendar_inspect: 'calendar'
});
const WORKFLOW_TOOLS = new Set(['rota_schedule_requests', 'rota_assignment_requests']);
const TASK_SORT_RANKS = Object.freeze({
  overdue_days_desc: ['task.overdueDays', 'desc'], target_finish_asc: ['task.targetFinish', 'asc'], target_finish_desc: ['task.targetFinish', 'desc'],
  planned_start_asc: ['task.plannedStart', 'asc'], updated_desc: ['task.updatedAt', 'desc']
});
const PORTFOLIO_SORT_RANKS = Object.freeze({ overdue_desc: ['tasks.overdue', 'desc'], open_desc: ['tasks.open', 'desc'], due_soon_desc: ['tasks.dueNext7Days', 'desc'] });
const PERIODS = Object.freeze(['today', 'yesterday', 'last_7_days']);

export const REQUEST_PERIODS = PERIODS;

export function periodWindow(period, today) {
  if (period === 'yesterday') return { dateFrom: addDays(today, -1), dateTo: addDays(today, -1) };
  if (period === 'last_7_days') return { dateFrom: addDays(today, -6), dateTo: today };
  return period === 'today' ? { dateFrom: today, dateTo: today } : {};
}

export function toolFamily(tool) {
  return FAMILIES[tool] || null;
}

export function familyKeys(tool) {
  return FAMILY_KEYS[FAMILIES[tool]] || [];
}

const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && !(Array.isArray(item) && !item.length)));
const sorted = (values) => (values?.length ? [...values].sort() : null);
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Aracın bağımsız değişken adlarıyla değerlerden kanonik nüfus koşulları.
 * Arama metni her zaman nüfus koşuludur; ad çözümü için yapılan aramanın
 * satırı, değer isteğinde adlandırılan varlık olarak doğrulanır.
 */
export function canonicalFacets(family, values, today) {
  const searchText = (text) => (text ? containmentText(text) || null : null);
  switch (family) {
    case 'task': {
      const filters = normalizeTaskFilters({ ...values, ...periodWindow(values.period, today), period: undefined });
      return compact({ status: sorted(filters.statuses), priority: sorted(filters.priorities), deadline: filters.deadline,
        dateField: filters.dateField, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
        assignee: ['me', 'unassigned'].includes(filters.assignee) ? filters.assignee : null, createdByMe: filters.createdByMe || null,
        milestone: filters.milestone, text: searchText(filters.text) });
    }
    case 'projectSearch':
    case 'personSearch':
      return compact({ text: searchText(values.text) });
    case 'workflow': {
      const window = { dateFrom: values.dateFrom || null, dateTo: values.dateTo || null, ...periodWindow(values.period, today) };
      return compact({ tab: values.tab && values.tab !== 'all' ? values.tab : null, workflowStatus: values.status || null, ...window,
        text: values.text ? containmentText(values.text) : null });
    }
    case 'portfolio':
      return compact({ source: values.source && values.source !== 'all' ? values.source : null, includeEmpty: values.includeEmpty === false ? false : null });
    case 'activity': {
      const window = populationArguments('rota_activity_search', { ...values, ...periodWindow(values.period, today),
        period: values.period || values.dateFrom ? 'custom' : undefined }, today);
      const fallback = window.dateFrom === today && window.dateTo === today;
      return compact({ dateFrom: fallback ? null : window.dateFrom, dateTo: fallback ? null : window.dateTo,
        activityScope: window.scope && window.scope !== 'visible' ? window.scope : null, activityKind: values.kind || null });
    }
    case 'calendar': {
      const window = populationArguments('rota_calendar_inspect', { ...values, ...periodWindow(values.period, today) }, today);
      const fallback = window.dateFrom === today && window.dateTo === addDays(today, 29);
      return compact({ dateFrom: fallback ? null : window.dateFrom, dateTo: fallback ? null : window.dateTo });
    }
    default:
      return {};
  }
}

/** İstenen koşulların aracın bağımsız değişken adlarına çevirisi. */
export function declaredValues(family, filters) {
  if (family === 'workflow') return { tab: filters.tab, status: filters.workflowStatus, dateFrom: filters.dateFrom, dateTo: filters.dateTo, period: filters.period, text: filters.text };
  if (family === 'activity') return { dateFrom: filters.dateFrom, dateTo: filters.dateTo, period: filters.period, scope: filters.activityScope, kind: filters.activityKind };
  return filters;
}

export function declaredFacets(tool, filters, today) {
  const family = FAMILIES[tool] || null;
  return canonicalFacets(family, declaredValues(family, filters || {}), today);
}

export function selectorsOf(args) {
  return [
    ...(args.projectId ? [{ type: 'project', id: args.projectId }] : []),
    ...(args.taskId ? [{ type: 'task', id: args.taskId }] : []),
    ...(args.personSicil != null ? [{ type: 'person', id: String(args.personSicil) }] : []),
    ...(args.wbsId ? [{ type: 'wbs', id: args.wbsId }] : []),
    ...(args.baselineId ? [{ type: 'baseline', id: args.baselineId }] : [])
  ];
}

/** Aracın varsayılan sırası; görev aramasında gecikme koşulu sırayı belirler. */
function defaultSort(tool, values) {
  if (tool === 'rota_task_search') return values.deadline === 'overdue' ? 'overdue_days_desc' : 'target_finish_asc';
  if (tool === 'rota_portfolio_summary') return 'overdue_desc';
  return null;
}

/**
 * Kanonik boyutlar (varsayılanlar uygulanmış): sıra yalnızca sıralanabilir
 * araçta, gruplama yalnızca analizde, derinlik yalnızca WBS'de; korumalı metin
 * alanları her araçta (boş küme varsayılandır).
 */
export function canonicalDimensions(tool, values = {}) {
  const parameters = getRotaTool(tool)?.parameters.properties || {};
  return {
    ...(parameters.sort ? { sort: values.sort || defaultSort(tool, values) } : {}),
    ...(tool === 'rota_task_analytics' ? { groupBy: values.groupBy || null } : {}),
    ...(tool === 'rota_wbs_inspect' ? { depth: values.depth || 2 } : {}),
    textFields: [...(values.textFields || [])].sort()
  };
}

/**
 * Nüfusu belirleyen boyutlar. Toplamlar için WBS derinliği listelenen düğümleri,
 * metin aramalı talep listesinde korumalı alanlar aramanın kapsamını belirler.
 * Satırlar için ayrıca gruplama grup satırlarını belirler; sıra yalnızca satır
 * yanıtında (liste/sıralama) anlamlıdır ve ayrıca karşılaştırılır. Tazelik
 * (evidencePopulation.js) aynı ayrımı kullanır.
 */
function scalarDimensions(tool, dimensions, facets) {
  return populationDimensions({ tool, snapshotDimensions: dimensions, facets });
}

function rowDimensions(tool, dimensions, facets) {
  const { sort, ...membership } = populationDimensions({ tool, snapshotDimensions: dimensions, facets }, 'rows');
  return membership;
}

/** Bildirilen nüfusun bu araçtaki kanonik boyutları (istenmeyen boyut araç varsayılanıdır). */
export function requestDimensions(request, tool) {
  const population = request.population?.tool === tool ? request.population : {};
  return canonicalDimensions(tool, { ...declaredValues(FAMILIES[tool] || null, request.filters || {}),
    sort: population.sort, groupBy: population.groupBy, depth: population.depth, textFields: population.textFields });
}

export function sortedBy(tool, dimensions) {
  const pair = tool === 'rota_task_search' ? TASK_SORT_RANKS[dimensions.sort]
    : tool === 'rota_portfolio_summary' ? PORTFOLIO_SORT_RANKS[dimensions.sort]
      : tool === 'rota_workload_summary' ? ['tasks.open', 'desc']
        : tool === 'rota_baseline_compare' ? ['task.varianceDays', 'desc']
          : tool === 'rota_dependency_inspect' ? ['dependencies.relationCount', 'desc'] : null;
  return pair ? { metric: pair[0], order: pair[1] } : null;
}

/**
 * Kanıtın nüfusu ile bildirilen nüfusun karşılaştırması. Nüfus aracı
 * dışındaki kanıt yalnızca koşulları bakımından karşılaştırılır (alan bağı ya
 * da varlığın kendi özelliği olarak kullanılır).
 */
export function populationAgreement(request, tool, args, today) {
  const dimensions = canonicalDimensions(tool, args);
  const facets = canonicalFacets(FAMILIES[tool] || null, args, today);
  const population = request.population;
  if (population && population.tool !== tool) return { dimensions, facets, populationMatch: false, dimensionsMatch: true, rowDimensionsMatch: true, sortMatch: true };
  // Nüfus aracı bildirilmemişse (yalnızca eski bildirim) boyutlar araç varsayılanıdır; joker değildir.
  const declared = requestDimensions(request, tool);
  return {
    dimensions,
    facets,
    populationMatch: true,
    dimensionsMatch: same(scalarDimensions(tool, dimensions, facets), scalarDimensions(tool, declared, facets)),
    rowDimensionsMatch: same(rowDimensions(tool, dimensions, facets), rowDimensions(tool, declared, facets)),
    // Sıra yalnızca listenin yanıtıdır; sıralama değerlerden yeniden kurulur, kesilmiş sayfada `sortedBy` ile denetlenir.
    sortMatch: request.operation !== 'list' || same(dimensions.sort ?? null, declared.sort ?? null)
  };
}

/* ── Planın nüfusuyla tamamlama ─────────────────────────────── */

const REQUEST_ENTITY_LIMIT = 4;

const propertyType = (metric) => {
  const type = metricEntityType(metric);
  return REQUEST_ENTITY_TYPES.includes(type) ? type : null;
};

/** Ölçü bildirilen bir varlığın kendi özelliği olarak (nüfus aracından bağımsız) okunabilir mi? */
function entityProperty(request, metric) {
  const type = propertyType(metric);
  if (!type || !request.entities.some((entity) => entity.type === type)) return false;
  return toolCatalogForModel().some((tool) => metricPaths(tool.name, metric)
    .some((path) => metricEntry(tool.name, path.startsWith('data.') ? path.slice(5) : path)?.property));
}

const carriesMetric = (tool, metric) => metricPaths(tool, metric).length > 0;
/** Ölçünün bu araçtaki korumalı serbest metin alanları (ör. açıklama). */
const textLeaves = (tool, metric) => metricPaths(tool, metric).map((path) => path.split('.').at(-1)).filter((leaf) => EVIDENCE_TEXT_FIELDS.includes(leaf));

/**
 * Nüfus aracının taşımadığı, bildirilen bir varlığın kendi özelliği: o varlığı seçen taşıyıcı araç
 * (ör. görevin açıklaması için rota_task_detail) `{ tool, type, param, textFields }`; yoksa null.
 */
function propertyCarrier(request, metric, selected = null) {
  const type = propertyType(metric);
  const explicit = (request.fields || []).filter((field) => field.metric === metric && (!selected || field.tool === selected)).map((field) => field.tool);
  if (!type || !request.population?.tool || (!explicit.length && carriesMetric(request.population.tool, metric))
    || explicit.includes(request.population.tool) || !request.entities.some((entity) => entity.type === type)) return null;
  const param = SELECTOR_PARAMS[type];
  const tool = (explicit.length ? explicit : carriers(metric)).find((name) => Object.hasOwn(getRotaTool(name).parameters.properties, param));
  return tool ? { tool, type, param, textFields: textLeaves(tool, metric) } : null;
}

/** İsteğin veri okunmadan açtığı korumalı metin alanları: nüfusunki ve varlık özelliği okumalarınınki. */
export function requestTextFields(request) {
  const fields = [...(request.population?.textFields || []), ...request.metrics.flatMap((metric) =>
    [...new Set(request.fields.filter((field) => field.metric === metric).map((field) => field.tool)), null]
      .flatMap((tool) => propertyCarrier(request, metric, tool)?.textFields || []))];
  return [...new Set(fields)].sort();
}
const carriers = (metric) => toolCatalogForModel().filter((tool) => carriesMetric(tool.name, metric)).map((tool) => tool.name);
const freeText = (key) => key === 'text';

/**
 * İsteği planın kendi nüfus çağrılarıyla veri okunmadan önce tamamlar ve
 * aracın ifade edemeyeceği istekleri reddeder: `{ request, problems, hints }`.
 * `calls` ayrıştırılmış çağrılardır (`{ name, args }`).
 */
/**
 * Kırılım sayımlarının kayıtlı tanımı: görev nüfusunun bu koşulla daraltılmış toplamı.
 * Analiz ve görev araması aynı yüklemleri kullanır (taskFacts: isOverdue, deadlineMatches,
 * durum kuralları); kimlik bir özellik sınamasıyla korunur.
 */
export { BREAKDOWN_FILTERS } from '../../../domain/ai/evidencePopulation.js';

/**
 * Nüfus aracı kırılımı taşımıyor ama toplamı taşıyorsa ve nüfus kırılımın tanımlayan
 * koşulunu zaten içeriyorsa kırılım sayımı o nüfusun toplamıdır (yeniden adlandırma; nüfus değişmez).
 */
function breakdownTotals(tool, metrics, filters, today) {
  const renamed = new Map();
  if (FAMILIES[tool] !== 'task' || !carriesMetric(tool, 'tasks.total')) return { list: metrics, renamed };
  const facets = canonicalFacets('task', filters, today);
  for (const metric of metrics) {
    const definition = BREAKDOWN_FILTERS[metric];
    if (!definition || carriesMetric(tool, metric)) continue;
    const required = canonicalFacets('task', definition, today);
    if (Object.entries(required).every(([key, value]) => same(facets[key], value))) renamed.set(metric, 'tasks.total');
  }
  return { list: [...new Set(metrics.map((metric) => renamed.get(metric) || metric))], renamed };
}

/** Aracın okunabilmesi için gereken seçici türleri: şemada zorunlu seçici ya da aracın "biri gerekli" kuralı. */
const EITHER_SELECTORS = Object.freeze({ rota_dependency_inspect: ['task', 'project'] });
function requiredSelectorTypes(tool) {
  if (EITHER_SELECTORS[tool]) return EITHER_SELECTORS[tool];
  const required = getRotaTool(tool).parameters.required || [];
  return Object.entries(SELECTOR_PARAMS).filter(([, param]) => required.includes(param)).map(([type]) => type);
}

/** Gruplama boyutunun görev ölçüsü: grup satırının etiketi bu ölçünün değeridir. */
const GROUP_METRICS = Object.freeze({ status: 'task.status', priority: 'task.priority', project: 'task.project', assignee: 'task.assignees', target_month: 'task.targetFinish' });

/** Kayıt türüne karşılık gelen gruplama boyutları ve o kaydı adlandıran ölçüler. */
const ENTITY_GROUPS = Object.freeze({ project: { type: 'project', names: ['project.name', 'project.code'] }, assignee: { type: 'person', names: ['person.name'] } });

/**
 * Seçiciyle tek kayıt döndüren aracın satır koleksiyonları okumanın biçimine bağlıdır: görevle
 * okunan tekrar incelemesi tek seridir (`series.next`), görevsiz okuma seri listesidir.
 * Aynı nüfusun öteki biçimdeki adı bu biçime çevrilir.
 */
const SELECTED_SHAPES = Object.freeze({
  rota_recurrence_inspect: { type: 'task', single: ['series.next'], plural: ['series', 'series.*.next'], counterparts: { 'series.*.next': 'series.next', 'series.next': 'series.*.next' } }
});

function shapeCollections(tool, entities) {
  const shape = SELECTED_SHAPES[tool];
  if (!shape) return rowCollections(tool);
  return entities.some((entity) => entity.type === shape.type) ? shape.single : shape.plural;
}

/**
 * Adla kimlik çözen arama araçları ve çözdükleri varlık türü. Görev araması bağlam ya da
 * nüfus da olabildiği için yalnızca proje ve kişi araması bir varlık çözümü sayılır.
 */
const NAME_RESOLVERS = Object.freeze({ rota_project_search: 'project', rota_person_search: 'person' });

/** Arama metni aynı türde bildirilen bir varlığın adıyla örtüşüyor mu? */
function resolvesDeclared(type, text, entities) {
  const names = entities.filter((entity) => entity.type === type && entity.text).map((entity) => containmentText(entity.text));
  return names.some((name) => name && (name.includes(text) || text.includes(name)));
}

export function completeRequest(request, calls, { today, allowedTextFields = [] }) {
  const problems = [];
  const hints = [];
  const filters = { ...request.filters };
  let population = request.population ? { ...request.population } : null;
  const entities = [...request.entities];
  if (!population) {
    // Nüfus aracı planın çağırdığı ve istenen toplamları taşıyıp bildirilen koşulları ifade edebilen tek araçtır;
    // bildirilen varlığın kendi özelliği nüfustan bağımsızdır. Yalnızca özellik istenirse ilk taşıyan çağrı yeterlidir.
    const active = Object.entries(request.filters).filter(([, value]) => value != null).map(([key]) => key);
    const aggregates = request.metrics.filter((metric) => !entityProperty(request, metric));
    const tools = [...new Set(calls.map((call) => call.name))].filter((tool) => (aggregates.length ? aggregates : request.metrics)
      .every((metric) => carriesMetric(tool, metric)) && active.every((key) => familyKeys(tool).includes(key)));
    if (tools.length === 1 || (tools.length && !aggregates.length)) population = { tool: tools[0] };
    else {
      problems.push('$.population:required');
      hints.push(`population.tool: ${[...new Set(request.metrics.flatMap(carriers))].slice(0, 8).join('|') || '-'}`);
      return { request, problems, hints };
    }
  }
  // Kimlikler, koleksiyon ve gruplama biçimi hesaplanmadan önce varlığa yükseltilir.
  for (const call of calls.filter((call) => call.name === population.tool)) {
    for (const selector of selectorsOf(call.args)) {
      const id = selector.type === 'person' ? String(selector.id) : canonicalActualId(selector.id);
      if (entities.some((entity) => entity.type === selector.type && (entity.id === id || entity.text))) continue;
      if (entities.length >= REQUEST_ENTITY_LIMIT) problems.push('$.entities:maxItems');
      else entities.push(Object.freeze({ type: selector.type, id, text: null }));
    }
  }
  // Gruplama yalnızca görev analizinde vardır: aynı görev koşullarıyla bildirilen gruplama analizin grup satırlarıdır.
  if (population.groupBy && FAMILIES[population.tool] === 'task' && !Object.hasOwn(getRotaTool(population.tool).parameters.properties, 'groupBy')) {
    const { sort, collection, ...rest } = population;
    population = { ...rest, tool: 'rota_task_analytics', ...(request.operation !== 'value' ? { collection: 'groups' } : {}) };
  }
  // Adı geçen kayıtların türüne göre gruplama (ör. iki proje ve groupBy project) o kayıtların kendi toplamlarıdır:
  // varlık başına okunan nüfusta tek grup vardır. İstek varlık başına değerdir; kaydın adı ölçü değil öznedir.
  let operation = request.operation;
  let groupedNames = [];
  const entityGroup = ENTITY_GROUPS[population.groupBy];
  if (entityGroup && operation === 'list' && population.tool === 'rota_task_analytics' && entities.some((entity) => entity.type === entityGroup.type)) {
    const { groupBy, collection, sort, ...rest } = population;
    population = rest;
    operation = 'value';
    groupedNames = [GROUP_METRICS[groupBy], ...entityGroup.names];
  }
  // Gruplamanın ürettiği tek satır koleksiyonu grup satırlarıdır.
  if (population.groupBy && population.tool === 'rota_task_analytics' && operation !== 'value' && !population.collection) population.collection = 'groups';
  const tool = population.tool;
  const definition = getRotaTool(tool);
  const collections = rowCollections(tool);
  // Bildirilen satır ölçülerini taşıyan tek koleksiyon bildirilmiş sayılır; birden çok kardeş koleksiyon listede hepsidir.
  const shaped = shapeCollections(tool, entities);
  const counterpart = SELECTED_SHAPES[tool]?.counterparts[population.collection];
  if (population.collection && !shaped.includes(population.collection) && shaped.includes(counterpart)) population.collection = counterpart;
  if (operation !== 'value' && !population.collection) {
    const fitting = listCollections(tool, request.metrics, shaped);
    if (fitting.length === 1) population.collection = fitting[0];
  }
  // Planın nüfus çağrıları: istekte verilmeyen koşul ve boyutlar onlardan alınır; çelişki ve belirsizlik reddedilir.
  const own = calls.filter((call) => call.name === tool);
  const family = FAMILIES[tool] || null;
  if (own.length) {
    const declared = canonicalFacets(family, declaredValues(family, filters), today);
    const executed = own.map((call) => canonicalFacets(family, call.args, today));
    for (const key of new Set(executed.flatMap((facets) => Object.keys(facets)).concat(Object.keys(declared)))) {
      const values = executed.map((facets) => facets[key]);
      if (Object.hasOwn(declared, key)) {
        if (values.some((value) => !same(value, declared[key]))) {
          problems.push(`$.filters.${key}:conflict`);
          if (!freeText(key) && values[0] != null) hints.push(`filters.${key}: ${JSON.stringify(values[0])} (çağrıyla aynı olmalı)`);
        }
      } else if (values.every((value) => same(value, values[0]))) {
        filters[key] = values[0];
      } else if (!values.includes(undefined)) {
        // Koşulsuz (varsayılan) çağrı varsa istek varsayılan nüfustur; diğer çağrılar bağlamdır.
        problems.push(`$.filters.${key}:ambiguous`);
      }
    }
    const dimensions = own.map((call) => canonicalDimensions(tool, call.args));
    for (const key of ['sort', 'groupBy', 'depth', 'textFields']) {
      if (!Object.hasOwn(dimensions[0], key)) continue;
      const values = dimensions.map((item) => item[key]);
      if (population[key] != null) {
        const declared = canonicalDimensions(tool, { ...declaredValues(family, filters), [key]: population[key] })[key];
        if (values.some((value) => !same(value, declared))) {
          problems.push(`$.population.${key}:conflict`);
          hints.push(`population.${key}: ${JSON.stringify(values[0])} (çağrıyla aynı olmalı)`);
        }
      } else if (values.every((value) => same(value, values[0]))) {
        if (key !== 'textFields' || values[0].length) population[key] = values[0];
      } else {
        // Varsayılan boyutlu bir nüfus çağrısı varsa istek varsayılandır; aksi hâlde boyut açıkça bildirilmelidir.
        const fallback = canonicalDimensions(tool, declaredValues(family, filters))[key];
        if (!values.some((value) => same(value, fallback))) problems.push(`$.population.${key}:ambiguous`);
      }
    }
  }
  // Korumalı serbest metin ölçüsü (ör. task.description) yalnızca o alan açılarak okunur: alan nüfus okumasının boyutudur.
  const textual = request.metrics.flatMap((metric) => textLeaves(tool, metric));
  if (textual.length && definition.parameters.properties.textFields) population.textFields = [...new Set([...(population.textFields || []), ...textual])].sort();
  // Gruplanan boyutun ölçüsü (ör. önceliğe göre gruplamada task.priority) grup satırının etiketidir; ayrı ölçü değildir.
  const grouped = GROUP_METRICS[population.groupBy];
  const ungrouped = request.metrics.filter((metric) => !groupedNames.includes(metric));
  const named = ungrouped.length ? ungrouped : request.metrics;
  const declaredMetrics = grouped && !carriesMetric(tool, grouped) && named.length > 1 ? named.filter((metric) => metric !== grouped) : named;
  // Kırılım sayımı (ör. tasks.overdue) tanımlayan koşulu zaten taşıyan nüfusta o nüfusun toplamıdır.
  const metrics = breakdownTotals(tool, declaredMetrics, filters, today);
  // Adla arama yapan çağrı (nüfus aracı değilse) bildirilen bir varlığı çözer; çözdüğü varlık bildirilmemişse
  // okunan kimlikle yapılacak her izleme çağrısı bildirilen nüfusun dışında kalır: istek veri okunmadan düzeltilir.
  const undeclared = calls.filter((call) => call.name !== tool && NAME_RESOLVERS[call.name] && typeof call.args?.text === 'string' && call.args.text.trim()
    && !resolvesDeclared(NAME_RESOLVERS[call.name], containmentText(call.args.text), entities));
  if (undeclared.length) {
    problems.push('$.entities:undeclared');
    hints.push(...[...new Set(undeclared.map((call) => NAME_RESOLVERS[call.name]))]
      .map((type) => `request.entities: [{"type":"${type}","text":"<kullanıcının yazdığı ad>"}] ekle (adla aranan ${type} bildirilen varlıktır)`));
  }
  // Aynı ad hem proje/kişi varlığı hem görev başlığı araması olamaz: filters.text yalnızca görev başlığında arar.
  if (typeof filters.text === 'string' && entities.some((entity) => ['project', 'person'].includes(entity.type) && entity.text
    && containmentText(entity.text) === containmentText(filters.text))) {
    problems.push('$.filters.text:entity');
    hints.push('filters.text: proje ya da kişi adı entities içinde bildirilir; filters.text yalnızca görev başlığında aranan metindir (gerekmiyorsa kaldır)');
  }
  // Seçicisiz okunamayan nüfus aracı (ör. bağımlılıklar görev ya da proje ister) bildirilen bir varlık gerektirir.
  const selectorTypes = requiredSelectorTypes(tool);
  if (selectorTypes.length && !entities.some((entity) => selectorTypes.includes(entity.type))) {
    problems.push('$.entities:required');
    hints.push(`${tool} bir ${selectorTypes.join(' ya da ')} seçicisi ister: request.entities: [{"type":"${selectorTypes.join('|')}","text":"<kullanıcının yazdığı ad>"}]`);
  }
  // Kişinin görevleri kişi seçicisiyle okunur; "benim" ya da "sorumsuz" koşulu aynı nüfusta onunla çelişir.
  if (filters.assignee != null && entities.some((entity) => entity.type === 'person') && Object.hasOwn(definition.parameters.properties, 'personSicil')) {
    problems.push('$.filters.assignee:entity');
    hints.push('filters.assignee: adı geçen kişinin görevleri için yazılmaz; kişi request.entities ile bildirilir, sunucu onu seçici yapar');
  }
  const renamed = (metric) => metrics.renamed.get(metric) || metric;
  if (request.rank && !population.sort) {
    const sort = rankSort(tool, { ...request.rank, metric: renamed(request.rank.metric) });
    if (sort) population.sort = sort;
  }
  const completed = Object.freeze({ ...request, operation, metrics: Object.freeze(metrics.list), filters: Object.freeze(filters), entities: Object.freeze(entities),
    fields: Object.freeze((request.fields || []).map((field) => {
      if (renamed(field.metric) === field.metric) return field;
      const paths = metricPaths(tool, renamed(field.metric)).filter((path) => !insideRowCollection(tool, path));
      const path = paths.find((path) => path === 'totalCount') || paths[0];
      return Object.freeze({ ...field, metric: renamed(field.metric), tool, ...(path ? { path } : {}) });
    })),
    bindings: Object.freeze((request.bindings || []).map((binding) => Object.freeze({ ...binding, metric: renamed(binding.metric) }))),
    ...(request.rank ? { rank: Object.freeze({ ...request.rank, metric: renamed(request.rank.metric) }) } : {}),
    population: Object.freeze(Object.fromEntries(Object.entries(population).filter(([, value]) => value != null))) });
  const capability = requestCapabilityProblems(completed, { allowedTextFields });
  return { request: completed, problems: [...problems, ...capability.problems], hints: [...hints, ...capability.hints] };
}

/**
 * Nüfus aracının ifade edemediği ya da kanıtın hiçbir zaman karşılayamayacağı
 * istek veri okunmadan reddedilir; ipuçları yalnızca kayıt defterinden türetilir.
 */
export function requestCapabilityProblems(request, { allowedTextFields = [] } = {}) {
  const problems = [];
  const hints = [];
  const carrierHint = (name, metric) => `${metric}: fields ile istenen kayıtlı alanı bağla; ${name}: ${metricPaths(name, metric).join('|')}`;
  for (const field of request.fields || []) {
    if (!request.metrics.includes(field.metric) || metricEntry(field.tool, field.path.replace(/^data\./, ''))?.metric !== field.metric) problems.push('$.fields:metric');
  }
  for (const binding of request.bindings || []) {
    if (!request.metrics.includes(binding.metric) || !request.entities[binding.entity]) problems.push('$.bindings:metric');
  }
  const population = request.population;
  if (!population) return { problems: ['$.population:required'], hints };
  const tool = getRotaTool(population.tool);
  const parameters = tool.parameters.properties;
  for (const metric of unboundCarrierMetrics(request)) {
    problems.push('$.fields:required');
    hints.push(carrierHint(tool.name, metric));
  }
  for (const metric of request.metrics.filter((metric) => !carriesMetric(tool.name, metric))) {
    const carrier = propertyCarrier(request, metric);
    if (carrier && unboundCarrierMetrics({ ...request, metrics: [metric], population: { tool: carrier.tool } }).length) {
      problems.push('$.fields:required');
      hints.push(carrierHint(carrier.tool, metric));
    }
  }
  const collections = rowCollections(tool.name);
  const sorts = parameters.sort?.enum || [];
  const shaped = shapeCollections(tool.name, request.entities);
  if (population.collection && !collections.includes(population.collection)) problems.push('$.population.collection:unknown');
  else if (population.collection && !shaped.includes(population.collection)) problems.push('$.population.collection:shape');
  const lists = request.operation === 'list' && !population.collection ? listCollections(tool.name, request.metrics, shaped) : [];
  const multiple = lists.length > 1;
  if (request.operation !== 'value' && !population.collection && !multiple) problems.push('$.population.collection:required');
  if (problems.some((problem) => problem.startsWith('$.population.collection'))) {
    hints.push(`population.collection (${tool.name}): ${shaped.join('|') || '-'}${request.operation === 'value' ? '; value isteğinde gerekmez' : ''}`);
  }
  if (population.sort && !sorts.includes(population.sort)) {
    problems.push('$.population.sort:unsupported');
    hints.push(`population.sort (${tool.name}): ${sorts.join('|') || '-'}`);
  }
  if (population.groupBy && tool.name !== 'rota_task_analytics') {
    problems.push('$.population.groupBy:unsupported');
    hints.push('population.groupBy yalnızca rota_task_analytics nüfusundadır: population {"tool":"rota_task_analytics","collection":"groups","groupBy":"..."} ve grup sayıları (ör. tasks.total)');
  }
  // İş dağılım listesinde derinlik açıkça bildirilir: varsayılan sessizce ağacı keser.
  if (tool.name === 'rota_wbs_inspect' && request.operation !== 'value' && !population.depth) {
    problems.push('$.population.depth:required');
    hints.push('population.depth: 1-4 (kullanıcının istediği düzey sayısı; belirtmediyse 2)');
  }
  if (population.depth && tool.name !== 'rota_wbs_inspect') {
    problems.push('$.population.depth:unsupported');
    hints.push('population.depth yalnızca rota_wbs_inspect nüfusundadır (collection nodes)');
  }
  if (requestTextFields(request).some((field) => !allowedTextFields.includes(field))) {
    problems.push('$.population.textFields:not-authorized');
    hints.push('population.textFields: kullanıcı bu turda serbest metni açmadı; bu alan okunamaz (kullanıcıya "Notlar ve iletiler" anahtarını öner)');
  }
  const active = Object.entries(request.filters).filter(([, value]) => value != null).map(([key]) => key);
  const fieldTools = (metric) => [...new Set((request.fields || []).filter((field) => field.metric === metric).map((field) => field.tool))];
  request.metrics.forEach((metric, index) => {
    const bound = fieldTools(metric);
    const property = entityProperty(request, metric);
    if (!bound.length && !carriesMetric(tool.name, metric) && !property) {
      problems.push(`$.metrics[${index}]:population`);
      hints.push(`${metric}: ${tool.name} taşımaz; taşıyan araçlar ${carriers(metric).join('|') || '-'}`);
      // Varlığın kendi özelliği o varlığı seçen araçtan okunur; sunucu adı kendisi çözer.
      const type = propertyType(metric);
      const selecting = type && RESOLVERS[type] ? carriers(metric).filter((name) => Object.hasOwn(getRotaTool(name).parameters.properties, SELECTOR_PARAMS[type])) : [];
      if (selecting.length) hints.push(`${metric}: ${type} özelliği; population.tool ${selecting[0]} ve request.entities: [{"type":"${type}","text":"<kullanıcının yazdığı ad>"}] bildir (ölçüyü SİLME; kimliği sunucu bulur)`);
      return;
    }
    // Toplam, sayım ve satır alanı nüfus koşullarının tamamını ifade edebilen araçtan gelmelidir;
    // değer isteğinde bildirilen varlığın kendi özelliği koşullardan bağımsızdır.
    // Değer isteğinde bir varlığın kendi özelliği (ör. task.status) yalnızca o varlık bildirilirse satırdan okunabilir.
    const type = propertyType(metric);
    if (request.operation === 'value' && type && !request.entities.some((entity) => entity.type === type)
      && metricPaths(tool.name, metric).length && metricPaths(tool.name, metric).every((path) => shaped.some((collection) => path.startsWith(`data.${collection}.`)))) {
      problems.push(`$.metrics[${index}]:entity`);
      hints.push(`${metric}: ${type} özelliği; request.entities: [{"type":"${type}","text":"<kullanıcının yazdığı ad>"}] bildir (birden çok kayıt isteniyorsa operation list)`);
      return;
    }
    // Satır ölçüsünün tek koleksiyonu olması, tek değeri olduğu anlamına gelmez.
    const rowHomes = collections.filter((collection) => rowMetricFields(tool.name, collection, metric).length);
    if (request.operation === 'value' && !type && rowHomes.length > 0
      && (bound.length ? request.fields.filter((field) => field.metric === metric).map((field) => field.path) : metricPaths(tool.name, metric))
        .every((path) => shaped.some((collection) => path.startsWith(`data.${collection}.`)))) {
      problems.push(`$.metrics[${index}]:rows`);
      hints.push(`${metric}: yalnızca ${rowHomes.join('|')} satırlarında; operation list (ya da rank)`);
      return;
    }
    const sources = (bound.length ? bound : [tool.name]).filter((name) => carriesMetric(name, metric));
    const aggregate = sources.some((name) => metricPaths(name, metric).some((path) => !isProperty(name, path)));
    const ownCarrier = property && !aggregate && (request.operation === 'value' || sources.every((name) => metricPaths(name, metric)
      .filter((path) => !bound.length || request.fields.some((field) => field.metric === metric && field.tool === name && field.path === path))
      .every((path) => !insideRowCollection(name, path))));
    if (!sources.length || ownCarrier) return;
    for (const name of sources) {
      const unsupported = active.filter((key) => !familyKeys(name).includes(key));
      if (unsupported.length) {
        problems.push(...unsupported.map((key) => `$.filters.${key}:unsupported`));
        hints.push(`filters (${name}): ${familyKeys(name).join('|') || 'koşul yok'}`);
        // Metinle aramayan araçta adı geçen kayıt, aracın seçicisi olan varlık olarak bildirilir.
        const selecting = Object.entries(SELECTOR_PARAMS).filter(([, param]) => Object.hasOwn(getRotaTool(name).parameters.properties, param)).map(([type]) => type);
        if (unsupported.includes('text') && selecting.length) {
          hints.push(`filters.text: ${name} metinle aramaz; adı geçen kayıt request.entities: [{"type":"${selecting.join('|')}","text":"<kullanıcının yazdığı ad>"}] ile bildirilir`);
        }
      }
    }
  });
  if (population.collection && request.operation !== 'value') {
    const rowMetrics = request.metrics.filter((metric) => rowMetricFields(tool.name, population.collection, metric).length);
    if (!rowMetrics.length) {
      problems.push('$.metrics:rows');
      hints.push(`${population.collection} satır ölçüleri: ${rowMetricsOf(tool.name, population.collection).slice(0, 10).join('|')}`);
    }
    const total = collectionTotalMetric(tool.name, population.collection);
    request.metrics.forEach((metric, index) => {
      if (rowMetrics.includes(metric) || metric === total || entityProperty(request, metric)
        || metricPaths(tool.name, metric).some((path) => parentProperty(tool.name, population.collection, path))) return;
      problems.push(`$.metrics[${index}]:not-row-total`);
      hints.push(`${metric}: ${population.collection} satırlarının alanı ya da sayısı değil${total ? `; satır sayısı ${total}` : ''}`);
    });
    if (request.rank && !rowMetrics.includes(request.rank.metric)) problems.push('$.rank.metric:rows');
  }
  if (multiple) {
    // Birden çok koleksiyonlu liste yalnızca satır alanlarıdır; tek koleksiyonun toplamı bütün listenin sayısı değildir.
    request.metrics.forEach((metric, index) => {
      if (lists.every((collection) => rowMetricFields(tool.name, collection, metric).length) || entityProperty(request, metric)) return;
      problems.push(`$.metrics[${index}]:not-row-total`);
      hints.push(`${metric}: ${lists.join('|')} satırlarının alanı değil`);
    });
  }
  if (bindingsRequired(request) && request.metrics.some((metric) => !NAMING_METRICS.has(metric) && !request.bindings.some((binding) => binding.metric === metric))) {
    problems.push('$.bindings:required');
    hints.push('bindings: her ölçü için {metric, entity} (entity, entities dizisindeki sıra)');
  }
  // Yalnızca bir varlık türünün özelliği olan ölçü başka türden varlığa bağlanamaz.
  for (const binding of request.bindings || []) {
    const type = propertyType(binding.metric);
    const entity = request.entities[binding.entity];
    const propertyOnly = carriers(binding.metric).every((name) => metricPaths(name, binding.metric).every((path) => isProperty(name, path)));
    if (entity && type && propertyOnly && entity.type !== type) problems.push('$.bindings:type');
  }
  return { problems: [...new Set(problems)], hints: [...new Set(hints)] };
}

function isProperty(tool, path) {
  return metricEntry(tool, path.startsWith('data.') ? path.slice(5) : path)?.property === true;
}

function rowMetricsOf(tool, collection) {
  return Object.keys(METRICS).filter((metric) => rowMetricFields(tool, collection, metric).length);
}

/* ── Bildirimden türetilen okumalar ─────────────────────────
 * Zayıf model anlamı (işlem, ölçüler, nüfus aracı, varlıklar, koşullar) bildirir;
 * okumanın bağımsız değişkenleri yalnızca bildirimden kurulabilir. Sunucu adla
 * bildirilen varlığı önce çözer, varlıklar bağlanınca nüfus okumasını yapar. Kurulan
 * çağrı model çağrısıyla aynı ön denetimden ve nüfus kimliğinden geçer.
 */

const SELECTOR_PARAMS = Object.freeze({ project: 'projectId', task: 'taskId', person: 'personSicil', wbs: 'wbsId', baseline: 'baselineId' });
const RESOLVERS = Object.freeze({ project: 'rota_project_search', person: 'rota_person_search', task: 'rota_task_search' });
/** Projenin içindeki kaydın adı projenin kataloğunda çözülür (tam katalog: en derin düzey, en büyük sayfa). */
const CATALOG_RESOLVERS = Object.freeze({ wbs: 'rota_wbs_inspect', baseline: 'rota_baseline_compare' });
const PROJECT_SCOPED = new Set(['task', 'wbs', 'baseline']);
/** Farklı varlıklara bağlanan ölçüler karşılaştırmadır; bağlanmayan varlık ortak bağlamdır. */
const comparisonSubjects = (request) => new Set((request.bindings || []).map((binding) => binding.entity));

const stableArgs = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

/**
 * Turda yürütülen okumanın kanonik kimliği: koşullar, varlık seçicileri, varsayılanları
 * uygulanmış boyutlar, sayfa ve sayfa boyu. Aynı nüfusu farklı yazılmış bağımsız
 * değişkenlerle okuyan çağrı aynı okumadır; küçük sayfa ise eksik okumadır ve sunucu
 * bildirilen nüfusu bir kez tam okuyabilir.
 */
export function readKey(name, args, today) {
  const selectors = selectorsOf(args).map(({ type, id }) => `${type}:${String(id).toLowerCase()}`).sort();
  const represented = new Set([...familyKeys(name), ...(FAMILIES[name] === 'workflow' ? ['status'] : []),
    ...(FAMILIES[name] === 'activity' ? ['scope', 'kind'] : []), ...Object.values(SELECTOR_PARAMS), 'sort', 'groupBy', 'depth', 'textFields', 'cursor', 'limit']);
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => !represented.has(key)));
  return `${name}:${stableArgs({ today, facets: canonicalFacets(FAMILIES[name] || null, args, today), selectors,
    dimensions: canonicalDimensions(name, args), extra, cursor: args.cursor ?? null,
    limit: effectivePageSize(getRotaTool(name)?.parameters?.properties?.limit, args) })}`;
}

/** Sıralama isteğinin aracın sırası: sıralama ölçüsü ve yönü aracın sıra kayıtlarından biriyle eşleşmelidir. */
function rankSort(tool, rank) {
  if (!rank) return null;
  const table = tool === 'rota_task_search' ? TASK_SORT_RANKS : tool === 'rota_portfolio_summary' ? PORTFOLIO_SORT_RANKS : {};
  return Object.entries(table).find(([, [metric, order]]) => metric === rank.metric && order === rank.order)?.[0] || null;
}

function parsedRead(tool, args) {
  try { return parseToolArguments(tool.parameters, JSON.stringify(args)); } catch { return null; }
}

/**
 * `bound`: isteğin varlıkları ve bağlandıkları kimlik (bindRequestEntities). Sonuç
 * `[{ name, args }]`; kurulamıyorsa ya da hepsi zaten yürütüldüyse boş.
 */
export function derivedReads(request, bound, { today, attempted = new Set() } = {}) {
  if (!request?.population?.tool) return [];
  const key = (call) => readKey(call.name, call.args, today);
  const fresh = (calls) => calls.filter((call, index) => !attempted.has(key(call)) && calls.findIndex((other) => key(other) === key(call)) === index);
  const unresolved = bound.filter((entity) => !entity.bound && entity.text);
  if (unresolved.length) {
    // Karşılaştırma değilse tek bildirilen projenin görev, WBS ve baz plan adı o projede, proje bağlandıktan sonra çözülür.
    const projects = bound.filter((entity) => entity.type === 'project');
    const project = projects.length === 1 && comparisonSubjects(request).size < 2 ? projects[0] : null;
    return fresh(unresolved.flatMap((entity) => {
      const scoped = PROJECT_SCOPED.has(entity.type) && project;
      if (scoped && project.bound == null) return [];
      const catalog = CATALOG_RESOLVERS[entity.type];
      const resolver = getRotaTool(catalog || RESOLVERS[entity.type] || '');
      if (!resolver || (catalog && !scoped)) return [];
      const properties = resolver.parameters.properties;
      const args = parsedRead(resolver, catalog
        ? { projectId: project.bound, ...(properties.depth ? { depth: properties.depth.maximum } : {}), ...(properties.limit ? { limit: properties.limit.maximum } : {}) }
        : { text: entity.query || entity.text, ...(scoped && properties.projectId ? { projectId: project.bound } : {}) });
      return args ? [{ name: resolver.name, args }] : [];
    }));
  }
  const tool = getRotaTool(request.population.tool);
  const properties = tool.parameters.properties;
  const family = FAMILIES[tool.name] || null;
  const base = {};
  const values = declaredValues(family, request.filters);
  // Dönem parametresi olmayan araçlarda aynı pencere tarih aralığına çevrilir.
  const windowed = values.period && !Object.hasOwn(properties, 'period') ? { ...values, ...periodWindow(values.period, today), period: undefined } : values;
  for (const [key, value] of Object.entries(windowed)) {
    if (value == null) continue;
    if (!Object.hasOwn(properties, key)) return [];
    base[key] = value;
  }
  const population = request.population;
  const sort = population.sort ?? rankSort(tool.name, request.rank);
  if (sort && properties.sort) base.sort = sort;
  if (population.groupBy && properties.groupBy) base.groupBy = population.groupBy;
  if (population.depth && properties.depth) base.depth = population.depth;
  if (population.textFields?.length && properties.textFields) base.textFields = population.textFields;
  // Liste nüfusun bütün satırlarıdır: aracın en büyük sayfasıyla bir kez okunur; sayfalar birleştirilmez.
  if (request.operation === 'list' && properties.limit?.maximum) base.limit = properties.limit.maximum;
  const selectors = new Map();
  for (const entity of bound) {
    const param = SELECTOR_PARAMS[entity.type];
    if (!param || !Object.hasOwn(properties, param) || entity.bound == null) continue;
    selectors.set(param, [...new Set([...(selectors.get(param) || []), entity.type === 'person' ? Number(entity.bound) : entity.bound])]);
  }
  const multiple = [...selectors].filter(([, ids]) => ids.length > 1);
  const subjects = comparisonSubjects(request);
  const comparisons = !conjunctiveEntities(request) && subjects.size > 1;
  if (multiple.length > 1 && !comparisons) return [];
  const single = Object.fromEntries([...selectors].filter(([, ids]) => ids.length === 1).map(([param, [id]]) => [param, id]));
  // Karşılaştırmada ortak bağlam seçicisi okumadan düşürülürse nüfus genişler, eklenirse doğrulanamaz: okuma türetilmez.
  const context = comparisons && bound.some((entity, index) => !subjects.has(index) && entity.bound != null
    && Object.hasOwn(properties, SELECTOR_PARAMS[entity.type] || ''));
  const candidates = context ? [] : comparisons ? [...new Set(request.bindings.filter((binding) => carriesMetric(tool.name, binding.metric)
    && (!request.fields.some((field) => field.metric === binding.metric) || request.fields.some((field) => field.metric === binding.metric && field.tool === tool.name)))
    .map((binding) => binding.entity))].flatMap((index) => {
    const entity = bound[index];
    const param = SELECTOR_PARAMS[entity?.type];
    return param && Object.hasOwn(properties, param) && entity.bound != null
      ? [{ ...base, [param]: entity.type === 'person' ? Number(entity.bound) : entity.bound }] : [];
  }) : multiple.length ? multiple[0][1].map((id) => ({ ...base, ...single, [multiple[0][0]]: id })) : [{ ...base, ...single }];
  const declared = declaredFacets(tool.name, request.filters, today);
  const reads = candidates.flatMap((candidate) => {
    const args = parsedRead(tool, candidate);
    if (!args) return [];
    // Seçiciyle birleşince geçersizleşen koşul (ör. kişi seçicisiyle "assignee: me") okuma değildir; tur hatası da değildir.
    let agreement;
    try { agreement = populationAgreement(request, tool.name, args, today); } catch { return []; }
    if (!agreement.populationMatch || agreement.dimensionsMatch === false || agreement.rowDimensionsMatch === false || agreement.sortMatch === false
      || !same(agreement.facets, declared)) return [];
    return [{ name: tool.name, args }];
  });
  // Bağlı varlığın nüfus aracında bulunmayan kendi özelliği, o varlığı seçen taşıyıcı araçtan okunur.
  const ownReads = request.metrics.flatMap((metric) => [...new Set(request.fields.filter((field) => field.metric === metric
    && field.tool !== request.population.tool).map((field) => field.tool)), null].flatMap((selected) => {
    const carrier = propertyCarrier(request, metric, selected);
    if (!carrier) return [];
    const bindings = request.bindings.filter((binding) => binding.metric === metric);
    return bound.filter((entity, index) => entity.type === carrier.type && entity.bound != null
      && (!bindings.length || bindings.some((binding) => binding.entity === index))).flatMap((entity) => {
      const args = parsedRead(getRotaTool(carrier.tool), { [carrier.param]: carrier.type === 'person' ? Number(entity.bound) : entity.bound,
        ...(carrier.textFields.length ? { textFields: carrier.textFields } : {}) });
      return args ? [{ name: carrier.tool, args }] : [];
    });
  }));
  const fieldReads = [...new Set(request.fields.filter((field) => field.tool !== tool.name).map((field) => field.tool))].flatMap((name) => {
    const fields = request.fields.filter((field) => field.tool === name);
    const metrics = [...new Set(fields.map((field) => field.metric))];
    const bindings = request.bindings.filter((binding) => metrics.includes(binding.metric));
    const subjects = !conjunctiveEntities(request) && bindings.length ? new Set(bindings.map((binding) => binding.entity)) : null;
    const indexes = bound.flatMap((_entity, index) => !subjects || subjects.has(index) ? [index] : []);
    const entities = indexes.map((index) => request.entities[index]);
    const property = fields.every((field) => isProperty(name, field.path));
    const variant = { ...request, operation: 'value', rank: null, metrics, fields, filters: property ? {} : request.filters,
      entities, bindings: bindings.map((binding) => ({ ...binding, entity: indexes.indexOf(binding.entity) })), population: { tool: name } };
    return derivedReads(variant, indexes.map((index) => bound[index]), { today, attempted });
  });
  const populationNeeded = request.metrics.some((metric) => carriesMetric(tool.name, metric)
    && (!request.fields.some((field) => field.metric === metric) || request.fields.some((field) => field.metric === metric && field.tool === tool.name)));
  return fresh([...(populationNeeded && reads.length === candidates.length ? reads : []), ...ownReads, ...fieldReads]);
}

/**
 * İlk, türetilen ve takip okumaları aynı türlü yükümlülüklere bağlıdır: istekte yeri olmayan
 * çağrı `null`dır. Yürütülecek biçim döner; sayfa boyu tek yönlüdür, daha küçük sayfa korunur,
 * büyüğü sunucunun türettiği sayfaya indirilir.
 */
export function requestBoundCall(request, name, args, { today, bound = request.entities.map((entity) => ({ ...entity, bound: entity.id })), reads = null } = {}) {
  if (!request?.population) return null;
  const required = reads || derivedReads(request, bound, { today });
  const identity = (tool, values) => {
    const { limit: _limit, cursor: _cursor, ...population } = values;
    return readKey(tool, { ...population, limit: 1 }, today);
  };
  const pageSize = (values) => effectivePageSize(getRotaTool(name)?.parameters?.properties?.limit, values);
  for (const call of required) {
    if (call.name !== name) continue;
    let expected = call.args;
    if (!expected) { try { expected = JSON.parse(call.arguments); } catch { continue; } }
    if ((args.cursor || null) !== (expected.cursor || null) || identity(name, args) !== identity(name, expected)) continue;
    return pageSize(args) > pageSize(expected) ? { ...args, limit: pageSize(expected) } : args;
  }
  return null;
}
