import 'server-only';
import { METRICS, metricPaths } from '../../../domain/ai/claimableEvidence.js';
import { rankableMeasure, REQUEST_ENTITY_TYPES, REQUEST_LIMITS, REQUEST_OPERATIONS } from '../../../domain/ai/requestContract.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { parseSicil } from '../../identity/sicil.js';
import { addDays, normalizeTaskFilters } from './rota/taskFacts.js';
import { parseToolArguments } from './toolArguments.js';
import { invalidArguments } from './toolErrors.js';
import { getRotaTool } from './toolRegistry.js';
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
    entities: Object.freeze(entities), filters: Object.freeze(filters) });
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
  for (const { id, tool, args = {}, payload } of entries) {
    const family = FAMILIES[tool] || null;
    const keys = family ? FAMILY_KEYS[family] : [];
    index.set(id, {
      tool,
      envelope: payload,
      facets: canonicalFacets(family, args, today),
      declared: canonicalFacets(family, declaredValues(family, request.filters), today),
      unsupported: active.filter((key) => !keys.includes(key)),
      selectors: selectorsOf(args),
      sortedBy: sortedBy(tool, args),
      firstPage: !args.cursor
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
