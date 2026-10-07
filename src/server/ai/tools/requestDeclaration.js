import 'server-only';
import { claimableContract, METRICS, metricEntry, metricPaths, rowCollections } from '../../../domain/ai/claimableEvidence.js';
import { concreteCollections, provesEmptyCollection, rankableMeasure, rankedRowIndexes, REQUEST_ENTITY_TYPES, REQUEST_LIMITS, REQUEST_OPERATIONS } from '../../../domain/ai/requestContract.js';
import { createEvidenceFacts, fieldPatternCovers } from '../../../domain/ai/evidenceFacts.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { parseSicil } from '../../identity/sicil.js';
import { addDays, normalizeTaskFilters } from './rota/taskFacts.js';
import { parseToolArguments } from './toolArguments.js';
import { invalidArguments } from './toolErrors.js';
import { getRotaTool, toolCatalogForModel } from './toolRegistry.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { containmentText, populationArguments } from './toolScope.js';

/**
 * Veri okunmadan bildirilen türlü isteğin SUNUCU tarafı: şema, güven
 * denetimi, varlık bağlama ve kanıtın nüfus koşulları.
 *
 * Şemanın süzgeç değerleri araçların kendi şemalarından alınır; istek araçla
 * aynı sözlüğü konuşur. Sunucu kullanıcı cümlesini yorumlamaz: yalnızca
 * bildirilen yapının geçerliliğini, arama metninin kullanıcının iletisinden
 * geldiğini ve kimliğin kullanıcıdan ya da sunucu seçiminden geldiğini denetler.
 */

const ID_PATTERN = '^(?:[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}|[1-9][0-9]{0,9})$';
const POPULATIONS = Object.freeze({ project: 'projects', task: 'tasks', person: 'people', wbs: 'wbs', baseline: 'baselines' });
const PERIODS = Object.freeze(['today', 'yesterday', 'last_7_days']);

let schema = null;

export function requestSchema() {
  if (schema) return schema;
  const task = getRotaTool('rota_task_search').parameters.properties;
  const statuses = [...getRotaTool('rota_schedule_requests').parameters.properties.status.enum,
    ...getRotaTool('rota_assignment_requests').parameters.properties.status.enum];
  const metric = { type: 'string', enum: Object.keys(METRICS) };
  schema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'metrics'],
    properties: {
      operation: { type: 'string', enum: [...REQUEST_OPERATIONS] },
      metrics: { type: 'array', minItems: 1, maxItems: REQUEST_LIMITS.maxMetrics, uniqueItems: true, items: metric },
      layout: { type: 'string', enum: ['auto', 'list', 'table'] },
      reasoning: { type: 'string', enum: ['deterministic', 'synthesis'] },
      population: {
        type: 'object', additionalProperties: false, required: ['tool'],
        properties: {
          tool: { type: 'string', enum: toolCatalogForModel().map((tool) => tool.name) },
          collection: { type: 'string', maxLength: 80 },
          groupBy: getRotaTool('rota_task_analytics').parameters.properties.groupBy,
          depth: { type: 'integer', minimum: 1, maximum: 4 },
          textFields: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ['description', 'requesterMessage', 'decisionMessage', 'changes'] } },
          sort: { type: 'string', enum: [...new Set(toolCatalogForModel().flatMap((tool) => tool.parameters.properties.sort?.enum || []))] }
        }
      },
      fields: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['metric', 'tool', 'path'],
        properties: { metric, tool: { type: 'string', enum: toolCatalogForModel().map((tool) => tool.name) }, path: { type: 'string', maxLength: 120 } } } },
      bindings: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['metric', 'entity'],
        properties: { metric, entity: { type: 'integer', minimum: 0, maximum: REQUEST_LIMITS.maxEntities - 1 } } } },
      rank: {
        type: 'object', additionalProperties: false, required: ['metric', 'order'],
        properties: { metric, order: { type: 'string', enum: ['desc', 'asc'] }, limit: { type: 'integer', minimum: 1, maximum: REQUEST_LIMITS.maxRankLimit } }
      },
      entities: {
        type: 'array', maxItems: REQUEST_LIMITS.maxEntities,
        items: {
          type: 'object', additionalProperties: false, required: ['type'],
          properties: {
            type: { type: 'string', enum: [...REQUEST_ENTITY_TYPES] },
            id: { type: 'string', maxLength: 36, pattern: ID_PATTERN },
            text: { type: 'string', minLength: 2, maxLength: 120 }
          }
        }
      },
      filters: {
        type: 'object', additionalProperties: false,
        properties: {
          status: task.status, priority: task.priority, deadline: task.deadline, dateField: task.dateField,
          dateFrom: task.dateFrom, dateTo: task.dateTo, period: { type: 'string', enum: [...PERIODS] },
          assignee: { type: 'string', enum: ['me', 'unassigned'] }, createdByMe: task.createdByMe, milestone: task.milestone, text: task.text,
          tab: { type: 'string', enum: ['pending', 'sent', 'history'] }, workflowStatus: { type: 'string', enum: [...new Set(statuses)] },
          source: { type: 'string', enum: ['corporate', 'manual'] }, includeEmpty: { type: 'boolean' },
          activityScope: { type: 'string', enum: ['mine', 'team'] }, activityKind: getRotaTool('rota_activity_search').parameters.properties.kind
        }
      }
    }
  });
  return schema;
}

function periodWindow(period, today) {
  if (period === 'yesterday') return { dateFrom: addDays(today, -1), dateTo: addDays(today, -1) };
  if (period === 'last_7_days') return { dateFrom: addDays(today, -6), dateTo: today };
  return period === 'today' ? { dateFrom: today, dateTo: today } : {};
}

/**
 * Bildirimi doğrular; geçerli değilse ayrıntılı `INVALID_ARGUMENTS`.
 * Arama metni kullanıcının iletisinden, kimlik kullanıcının yazdığı ya da
 * sunucunun bağladığı seçimden gelmelidir.
 */
export function parseRequestDeclaration(raw, { textTrusted, identityTrusted, today }) {
  if (raw == null) throw invalidArguments(['$.request:required']);
  const value = parseToolArguments(requestSchema(), JSON.stringify(raw));
  const problems = [];
  if (value.population) {
    const tool = getRotaTool(value.population.tool);
    if (value.population.collection && !rowCollections(tool.name).includes(value.population.collection)) problems.push('$.population.collection:unknown');
    if (value.population.sort && !tool.parameters.properties.sort?.enum?.includes(value.population.sort)) problems.push('$.population.sort:unsupported');
    if (value.operation !== 'value' && !value.population.collection) problems.push('$.population.collection:required');
    if (value.population.groupBy && tool.name !== 'rota_task_analytics') problems.push('$.population.groupBy:unsupported');
    if (value.population.depth && tool.name !== 'rota_wbs_inspect') problems.push('$.population.depth:unsupported');
  }
  for (const field of value.fields || []) if (!value.metrics.includes(field.metric) || !metricPaths(field.tool, field.metric).includes(field.path)) problems.push('$.fields:unknown');
  for (const binding of value.bindings || []) if (!value.metrics.includes(binding.metric) || !value.entities?.[binding.entity]) problems.push('$.bindings:unknown');
  if ((value.operation === 'rank') !== Boolean(value.rank)) problems.push('$.rank:operation');
  if (value.rank && !value.metrics.includes(value.rank.metric)) problems.push('$.rank.metric:undeclared');
  if (value.rank && !rankableMeasure(METRICS[value.rank.metric])) problems.push('$.rank.metric:unordered');
  const entities = (value.entities || []).map((entity, index) => {
    const path = `$.entities[${index}]`;
    if ((entity.id == null) === (entity.text == null)) {
      problems.push(`${path}:idOrText`);
      return null;
    }
    if (entity.text != null) {
      if (!textTrusted(entity.text)) problems.push(`${path}.text:untrusted`);
      return Object.freeze({ type: entity.type, id: null, text: containmentText(entity.text) });
    }
    const id = entity.type === 'person' ? parseSicil(entity.id) : canonicalActualId(entity.id);
    if (id == null || !identityTrusted(POPULATIONS[entity.type], String(id))) problems.push(`${path}.id:untrusted`);
    return Object.freeze({ type: entity.type, id: id == null ? null : String(id), text: null });
  });
  const filters = { ...(value.filters || {}) };
  if (filters.text != null && !textTrusted(filters.text)) problems.push('$.filters.text:untrusted');
  if (filters.period && (filters.dateFrom || filters.dateTo)) problems.push('$.filters.period:conflict');
  try {
    normalizeTaskFilters({ ...filters, ...periodWindow(filters.period, today) });
  } catch (error) {
    problems.push(...(error.details || ['$.filters:invalid']).map((detail) => detail.replace(/^\$\./, '$.filters.')));
  }
  if (problems.length) throw invalidArguments(problems);
  return Object.freeze({ operation: value.operation, metrics: Object.freeze([...value.metrics]), rank: value.rank ? Object.freeze({ ...value.rank }) : null,
    entities: Object.freeze(entities), filters: Object.freeze(filters), layout: value.layout || 'auto', reasoning: value.reasoning || 'deterministic',
    population: value.population ? Object.freeze({ ...value.population }) : null, fields: Object.freeze(value.fields || []), bindings: Object.freeze(value.bindings || []) });
}

/** Bildirim ve ilk araç planı tek yerel çağrının bağımsız değişkenleridir. */
export function typedPlanningTool(catalog) {
  return { name: 'rota_plan', description: 'Veri okumadan türlü Rota isteğini ve ilk salt okunur araç planını bildir. Asistan metni gerekmez.',
    parameters: { type: 'object', additionalProperties: false, required: ['intent', 'language', 'calls'], properties: {
      intent: { type: 'string', enum: ['rota', 'general'] }, language: { type: 'string', enum: ['tr', 'en'] },
      request: { ...requestSchema(), required: [...requestSchema().required, 'population', 'layout'] },
      calls: { type: 'array', maxItems: TOOL_LIMITS.maxCallsPerRound, items: { oneOf: catalog.map((tool) => ({
        type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
          name: { type: 'string', enum: [tool.name], description: tool.description }, arguments: tool.parameters
        }
      })) } }
    } } };
}

export function unpackTypedPlan(result, catalog) {
  if (result.toolCalls.length !== 1 || result.toolCalls[0].oversize) throw invalidArguments(['$.plan:single']);
  const call = result.toolCalls[0];
  if (Buffer.byteLength(call.arguments || '', 'utf8') > TOOL_LIMITS.maxArgumentBytes) throw invalidArguments(['$.plan:tooLarge']);
  let plan;
  try { plan = JSON.parse(call.arguments); } catch { throw invalidArguments(['$.plan:json']); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some((key) => !['intent', 'language', 'request', 'calls'].includes(key))
    || !['rota', 'general'].includes(plan.intent) || !['tr', 'en'].includes(plan.language) || !Array.isArray(plan.calls)
    || plan.calls.length > TOOL_LIMITS.maxCallsPerRound) throw invalidArguments(['$.plan:shape']);
  if (plan.intent === 'rota' && (!plan.request?.population || !plan.request?.layout || !plan.calls.length)) throw invalidArguments(['$.request:planRequired']);
  if (plan.intent === 'general' && (plan.calls.length || plan.request)) throw invalidArguments(['$.plan:general']);
  const toolCalls = plan.calls.map((item, index) => {
    const tool = catalog.find((tool) => tool.name === item?.name);
    if (!tool || Object.keys(item).some((key) => !['name', 'arguments'].includes(key)) || !item.arguments || typeof item.arguments !== 'object'
      || Array.isArray(item.arguments)) throw invalidArguments(['$.calls:shape']);
    const args = parseToolArguments(tool.parameters, JSON.stringify(item.arguments));
    return { id: `${call.id}_${index}`, name: item.name, arguments: JSON.stringify(args) };
  });
  return { ...result, text: JSON.stringify({ kind: 'route', intent: plan.intent, language: plan.language, ...(plan.request ? { request: plan.request } : {}) }), toolCalls };
}

/** Modele verilen kapalı ölçü sözlüğü: kimlikler öneklerine göre gruplanır. */
export function metricVocabulary() {
  const groups = new Map();
  for (const metric of Object.keys(METRICS)) {
    const [head, ...rest] = metric.split('.');
    groups.set(head, [...(groups.get(head) || []), rest.join('.')]);
  }
  return [...groups].map(([head, names]) => `${head}.{${names.join(',')}}`).join(' ');
}

/** Bildirilen dönem, hareket ve takvim takiplerinin güvenilir penceresidir. */
export function requestWindow(request) {
  const { period, dateFrom, dateTo } = request?.filters || {};
  if (period) return { period };
  return dateFrom ? { dateFrom, ...(dateTo ? { dateTo } : {}) } : null;
}

/** Sistem özetine yalnızca türlü değerler girer; serbest metin taşınmaz. */
export function requestSummary(request) {
  const filters = Object.fromEntries(Object.entries(request.filters).filter(([key]) => key !== 'text'));
  return JSON.stringify({ operation: request.operation, metrics: request.metrics, ...(request.rank ? { rank: request.rank } : {}),
    ...(request.population ? { population: request.population } : {}),
    ...(request.layout !== 'auto' ? { layout: request.layout } : {}),
    ...(request.reasoning !== 'deterministic' ? { reasoning: request.reasoning } : {}),
    ...(request.fields.length ? { fields: request.fields } : {}),
    ...(request.bindings.length ? { bindings: request.bindings } : {}),
    ...(request.entities.length ? { entities: request.entities.map(({ type, id }) => (id ? { type, id } : { type })) } : {}),
    ...(Object.keys(filters).length ? { filters } : {}) });
}

/* ── Varlık bağlama ───────────────────────────────────────── */

function resolvedId(type, tool, args, payload, text) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  if (type === 'wbs') {
    // Kesilmiş düğüm listesindeki tek eşleşme bütün ağaçta tek olduğunu kanıtlamaz.
    if (tool !== 'rota_wbs_inspect' || payload.complete !== true || payload.truncated === true) return null;
    const nodes = (data.nodes || []).filter((node) => [node.name, node.code].some((label) => containmentText(label) === text));
    return nodes.length === 1 ? nodes[0].wbsId : null;
  }
  if (type === 'baseline') {
    if (tool !== 'rota_baseline_compare' || data.availableBaselinesTruncated === true) return null;
    const baselines = (data.availableBaselines || []).filter((baseline) => containmentText(baseline.name) === text);
    return baselines.length === 1 ? baselines[0].baselineId : null;
  }
  if (containmentText(args?.text || '') !== text) return null;
  if (type === 'project' && tool === 'rota_project_search' && data.resolution === 'unique') return data.resolvedProject?.projectId || null;
  if (type === 'person' && tool === 'rota_person_search' && data.resolution === 'unique') return data.resolvedPerson?.sicil == null ? null : String(data.resolvedPerson.sicil);
  if (type === 'task' && tool === 'rota_task_search' && data.titleResolution === 'unique') return data.resolvedTask?.taskId || null;
  return null;
}

/**
 * Adla bildirilen varlık yalnızca bu turdaki tek kesin sunucu çözümüne ya da
 * önceki açıklamada sunucunun bağladığı seçime bağlanır; aksi hâlde `null`.
 */
export function bindRequestEntities(request, entries, selection = null) {
  const selected = selection?.projectId ? ['project', selection.projectId] : selection?.taskId ? ['task', selection.taskId]
    : selection?.personSicil != null ? ['person', String(selection.personSicil)] : null;
  return request.entities.map((entity) => {
    if (entity.id) return { ...entity, bound: entity.id };
    const found = new Set(entries.map(({ tool, args, payload }) => resolvedId(entity.type, tool, args, payload, entity.text)).filter(Boolean));
    if (found.size === 1) return { ...entity, bound: [...found][0] };
    const sameType = request.entities.filter((item) => item.type === entity.type && item.text);
    return { ...entity, bound: !found.size && selected?.[0] === entity.type && sameType.length === 1 ? selected[1] : null };
  });
}

/* ── Kanıtın nüfus koşulları ──────────────────────────────── */

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
const TASK_SORT_RANKS = Object.freeze({
  overdue_days_desc: ['task.overdueDays', 'desc'], target_finish_asc: ['task.targetFinish', 'asc'], target_finish_desc: ['task.targetFinish', 'desc'],
  planned_start_asc: ['task.plannedStart', 'asc'], updated_desc: ['task.updatedAt', 'desc']
});
const PORTFOLIO_SORT_RANKS = Object.freeze({ overdue_desc: ['tasks.overdue', 'desc'], open_desc: ['tasks.open', 'desc'], due_soon_desc: ['tasks.dueNext7Days', 'desc'] });

const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && !(Array.isArray(item) && !item.length)));
const sorted = (values) => (values?.length ? [...values].sort() : null);

/**
 * Aracın bağımsız değişken adlarıyla değerlerden kanonik nüfus koşulları.
 * Arama metni her zaman nüfus koşuludur; ad çözümü için yapılan aramanın
 * satırı, değer isteğinde adlandırılan varlık olarak doğrulanır.
 */
function canonicalFacets(family, values, today) {
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
function declaredValues(family, filters) {
  if (family === 'workflow') return { tab: filters.tab, status: filters.workflowStatus, dateFrom: filters.dateFrom, dateTo: filters.dateTo, period: filters.period, text: filters.text };
  if (family === 'activity') return { dateFrom: filters.dateFrom, dateTo: filters.dateTo, period: filters.period, scope: filters.activityScope, kind: filters.activityKind };
  return filters;
}

function selectorsOf(args) {
  return [
    ...(args.projectId ? [{ type: 'project', id: args.projectId }] : []),
    ...(args.taskId ? [{ type: 'task', id: args.taskId }] : []),
    ...(args.personSicil != null ? [{ type: 'person', id: String(args.personSicil) }] : []),
    ...(args.wbsId ? [{ type: 'wbs', id: args.wbsId }] : []),
    ...(args.baselineId ? [{ type: 'baseline', id: args.baselineId }] : [])
  ];
}

function sortedBy(tool, args) {
  const pair = tool === 'rota_task_search' ? TASK_SORT_RANKS[args.sort || (args.deadline === 'overdue' ? 'overdue_days_desc' : 'target_finish_asc')]
    : tool === 'rota_portfolio_summary' ? PORTFOLIO_SORT_RANKS[args.sort || 'overdue_desc']
      : tool === 'rota_workload_summary' ? ['tasks.open', 'desc']
        : tool === 'rota_baseline_compare' ? ['task.varianceDays', 'desc']
          : tool === 'rota_dependency_inspect' ? ['dependencies.relationCount', 'desc'] : null;
  return pair ? { metric: pair[0], order: pair[1] } : null;
}

/**
 * Doğrulayıcının kanıt dizini: kanıtın yürütülen nüfusu, istenen koşulların o
 * araçtaki karşılığı, aracın ifade edemediği koşullar ve varlık seçicileri.
 */
export function requestEvidence(request, entries, today) {
  const active = Object.entries(request.filters).filter(([, value]) => value != null).map(([key]) => key);
  const index = new Map();
  for (const [ordinal, { id, tool, args = {}, payload }] of entries.entries()) {
    const family = FAMILIES[tool] || null;
    const keys = family ? FAMILY_KEYS[family] : [];
    index.set(id, {
      tool,
      ordinal,
      snapshotDimensions: compact({ groupBy: args.groupBy, depth: args.depth, textFields: args.textFields ? [...args.textFields].sort() : null }),
      facts: payload?.data ? createEvidenceFacts(payload, { prefix: payload.factScope || id }) : [],
      envelope: payload,
      facets: canonicalFacets(family, args, today),
      declared: canonicalFacets(family, declaredValues(family, request.filters), today),
      unsupported: active.filter((key) => !keys.includes(key)),
      selectors: selectorsOf(args),
      sortedBy: sortedBy(tool, args),
      firstPage: !args.cursor,
      populationMatch: !request.population || request.population.tool === tool,
      collection: request.population?.tool === tool ? request.population.collection || null : null,
      dimensionsMatch: request.population?.tool !== tool ||
        ((!request.population.groupBy || request.population.groupBy === args.groupBy) && (!request.population.depth || request.population.depth === (args.depth || 2))
        && (!request.population.textFields || JSON.stringify([...request.population.textFields].sort()) === JSON.stringify([...(args.textFields || [])].sort()))),
      sortMatch: !request.population?.sort || request.population.tool !== tool || request.population.sort === (args.sort ||
        (tool === 'rota_task_search' ? args.deadline === 'overdue' ? 'overdue_days_desc' : 'target_finish_asc' : tool === 'rota_portfolio_summary' ? 'overdue_desc' : null))
    });
  }
  return index;
}

/** Düzeltme yönergesi: bildirilen her ölçüyü bu turun kanıtlarında taşıyan yollar. */
export function requestRepairHint(request, entries) {
  const lines = [];
  for (const metric of request.metrics) {
    const paths = entries.flatMap(({ id, tool }) => metricPaths(tool, metric).map((path) => `${id}:${path}`));
    lines.push(`${metric} → ${paths.length ? paths.slice(0, 4).join(', ') : 'bu turun kanıtlarında yok'}`);
  }
  return lines.slice(0, REQUEST_LIMITS.maxMetrics).join('\n');
}

/* ── İstekten türetilen olgu seçimi ───────────────────────── */

const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const canonicalField = (field) => field.split('.').map((part) => /^\d+$/.test(part) ? '*' : part).join('.');
const factPool = (entry) => createEvidenceFacts(entry.payload, { prefix: entry.payload.factScope || entry.id });
const declaredFields = (request, tool, metric) => (request.fields || []).filter((field) => field.tool === tool && field.metric === metric).map((field) => field.path);
const ROW_TOTALS = Object.freeze({
  rota_task_search: { tasks: 'tasks.total' }, rota_project_search: { matches: 'projects.total' }, rota_person_search: { people: 'people.total' },
  rota_portfolio_summary: { projects: 'projects.total' }, rota_wbs_inspect: { nodes: 'wbs.nodes' },
  rota_task_analytics: { groups: 'tasks.groupCount' }, rota_workload_summary: { people: 'people.total' },
  rota_baseline_compare: { mostSlipped: 'baseline.compared' }, rota_activity_search: { items: 'activity.events' },
  rota_schedule_requests: { items: 'requests.total' }, rota_assignment_requests: { items: 'requests.total' },
  rota_calendar_inspect: { holidays: 'calendar.holidays' }, rota_outlook_status: { items: 'subscriptions.active' }
});

/** Muhakeme başlamadan önce bildirilen ölçülerin kanıtı bulunmalıdır. */
export function requestEvidenceReady(request, entries, today) {
  const evidence = [...requestEvidence(request, entries, today).values()];
  return request.metrics.every((metric) => evidence.some((entry) => (entry.populationMatch !== false || declaredFields(request, entry.tool, metric).length > 0) && entry.dimensionsMatch !== false
    && entry.facts.some((fact) => fact.semantic?.metric === metric && (!(request.fields || []).some((field) => field.metric === metric)
      || declaredFields(request, entry.tool, metric).some((path) => fieldPatternCovers(path, fact.field))))));
}

function metricCarriers(request, entry, metric, { collection = null, bound = [] } = {}) {
  const declared = declaredFields(request, entry.tool, metric);
  if (request.fields.some((field) => field.metric === metric) && !declared.length) return [];
  const registry = metricPaths(entry.tool, metric);
  const paths = declared.length ? declared : registry;
  const pool = factPool(entry).filter((fact) => fact.semantic?.metric === metric && scalar(fact.value));
  const filled = paths.filter((path) => pool.some((fact) => fieldPatternCovers(path, fact.field)));
  if (!declared.length && registry.length > 1) return null;
  return filled.flatMap((path) => {
    if (collection) return path.startsWith(`data.${collection}.*.`) ? [path] : [];
    const rows = rowCollections(entry.tool).filter((row) => path.startsWith(`data.${row}.*.`));
    if (!rows.length) return [path];
    const matches = pool.filter((fact) => fieldPatternCovers(path, fact.field));
    if (!matches.every((fact) => fact.semantic?.property)) return [];
    return matches.filter((fact) => bound.some((entity) => {
      const type = fact.semantic.metric.split('.')[0];
      const field = { project: 'projectId', task: 'taskId', person: 'sicil', wbs: 'wbsId', baseline: 'baselineId' }[type];
      const parts = fact.field.split('.');
      const index = parts.findIndex((part) => /^\d+$/.test(part));
      const row = parts.slice(1, index + 1).reduce((value, key) => value?.[key], entry.payload.data);
      return entity.type === type && String(row?.[field]).toLowerCase() === String(entity.bound).toLowerCase();
    })).map((fact) => fact.field);
  });
}

function eligiblePopulation(request, entry) {
  if (entry.payload.complete !== true || entry.payload.truncated === true || entry.args?.cursor) return false;
  if (entry.tool === 'rota_task_analytics' && entry.args?.groupBy && request.population?.groupBy !== entry.args.groupBy) return false;
  if (entry.tool === 'rota_wbs_inspect' && request.operation !== 'value' && !request.population?.depth) return false;
  if (['rota_schedule_requests', 'rota_assignment_requests'].includes(entry.tool) && request.filters.text && !request.population?.textFields) return false;
  return true;
}

function rowSelection(request, entry, canonical, bound, entries) {
  const concrete = concreteCollections(entry.payload, canonical);
  if (!concrete.length) return provesEmptyCollection({ tool: entry.tool, envelope: entry.payload, firstPage: !entry.args?.cursor }, canonical) ? [`${entry.id}:complete`] : null;
  const prefix = `data.${canonical}.*.`;
  const declared = (request.fields || []).filter((field) => field.tool === entry.tool);
  const fields = [];
  const facts = [];
  for (const metric of request.metrics) {
    const paths = metricPaths(entry.tool, metric);
    const rowPaths = paths.filter((path) => path.startsWith(prefix));
    const scalarPaths = paths.filter((path) => !path.startsWith(prefix));
    const selected = declared.filter((field) => field.metric === metric).map((field) => field.path);
    if (rowPaths.length && (!selected.length && (rowPaths.length > 1 || scalarPaths.some((path) => factPool(entry).some((fact) => fieldPatternCovers(path, fact.field)))))) return null;
    if (rowPaths.length) fields.push(...(selected.length ? selected.filter((path) => path.startsWith(prefix)) : rowPaths));
    if (!rowPaths.length || selected.some((path) => !path.startsWith(prefix))) {
      const sources = entries.flatMap((source) => {
        const carriers = metricCarriers(request, source, metric, { bound });
        const own = carriers?.every((path) => metricEntry(source.tool, path.startsWith('data.') ? canonicalField(path).slice(5) : path)?.property);
        const explicit = declaredFields(request, source.tool, metric).length > 0;
        if (source.id !== entry.id && (!bound.length || (!own && !explicit))) return [];
        return carriers?.length ? [{ source, carriers }] : [];
      });
      if (sources.length !== 1) return null;
      // Satır sayımı yalnızca aynı koleksiyonun toplamıyla birleşir.
      const [{ source, carriers }] = sources;
      const own = carriers.every((path) => metricEntry(source.tool, path.startsWith('data.') ? canonicalField(path).slice(5) : path)?.property);
      if (!own && (source.id !== entry.id || ROW_TOTALS[entry.tool]?.[canonical] !== metric)) return null;
      facts.push(...carriers.map((path) => `${source.id}:${path}`));
    }
  }
  if (!fields.length) return null;
  if (concrete.every(({ rows }) => rows.length === 0)) {
    if (!provesEmptyCollection({ tool: entry.tool, envelope: entry.payload, firstPage: !entry.args?.cursor }, canonical)) return null;
    return facts.length ? facts : [`${entry.id}:complete`];
  }
  for (const item of concrete) {
    let indexes = request.operation === 'rank' ? rankedRowIndexes(request, entry.tool, entry.payload, canonical, item.collection.slice(5)) : item.rows.map((_, index) => index);
    if (!indexes?.length) return null;
    if (indexes.length === item.rows.length) indexes = ['*'];
    const naming = claimableContract(entry.tool).paths.find((path) => path.startsWith(`${canonical}.*.`)
      && !path.slice(canonical.length + 3).includes('.') && metricEntry(entry.tool, path)?.context);
    const relatives = [...new Set([naming ? `data.${naming}` : null, ...fields].filter(Boolean).map((path) => path.slice(prefix.length)))];
    for (const index of indexes) for (const rel of relatives) facts.push(`${entry.id}:${item.collection}.${index}.${rel}`);
  }
  return facts;
}

/** Tek anlamlı, tam ve çakışmayan kanıt; belirsizlikte seçimi model yapar. */
export function requestSelections(request, entries, selection = null) {
  if (request.reasoning === 'synthesis' || !request.population) return [];
  const usable = entries.filter((entry) => entry.payload?.ok === true && entry.payload.data && eligiblePopulation(request, entry));
  const bound = bindRequestEntities(request, entries, selection);
  if (bound.some((entity) => !entity.bound)) return [];
  if (bound.length > 1 && request.metrics.length > 1 && !request.bindings?.length) return [];
  const candidates = [];
  if (request.operation === 'value') {
    const composite = [];
    for (const metric of request.metrics) {
      const sources = usable.flatMap((entry) => {
        if (request.population && request.population.tool !== entry.tool && !declaredFields(request, entry.tool, metric).length
          && !metricPaths(entry.tool, metric).every((path) => metricEntry(entry.tool, path.startsWith('data.') ? path.slice(5) : path)?.property)) return [];
        if (!request.population && !metricPaths(entry.tool, metric).every((path) => {
          const key = path.startsWith('data.') ? path.slice(5) : path;
          return metricEntry(entry.tool, key)?.property && bound.length;
        })) return [];
        const carriers = metricCarriers(request, entry, metric, { bound });
        return carriers?.length ? [{ entry, carriers }] : [];
      });
      if (!sources.length) return [];
      if (sources.length > 1) {
        if (bound.length < 2) return [];
        const keys = sources.map(({ entry }) => JSON.stringify(selectorsOf(entry.args || {})));
        if (new Set(keys).size !== sources.length || keys.some((key) => key === '[]')) return [];
      }
      composite.push(...sources.flatMap(({ entry, carriers }) => carriers.map((path) => `${entry.id}:${path}`)));
    }
    candidates.push(composite);
  } else {
    if (!request.population?.collection) return [];
    for (const entry of usable) {
      if (entry.tool !== request.population.tool) continue;
      if (entry.tool === 'rota_task_analytics' && request.population.collection === 'groups' && !request.population.groupBy) continue;
      if (entry.tool === 'rota_wbs_inspect' && !request.population.depth) continue;
      if (getRotaTool(entry.tool).parameters.properties.sort && !request.population.sort && request.operation === 'list') continue;
      const facts = rowSelection(request, entry, request.population.collection, bound, usable);
      if (facts?.length) candidates.push(facts);
    }
  }
  return [...new Set(candidates.map((facts) => JSON.stringify({ kind: 'rota', facts: [...new Set(facts)], layout: request.layout || 'auto' })))];
}
