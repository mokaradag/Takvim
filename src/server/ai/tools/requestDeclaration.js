import 'server-only';
import { claimableContract, equivalentCarriers, METRICS, metricEntityType, metricEntry, metricPaths, rowCollections, SAME_VALUE_PATHS } from '../../../domain/ai/claimableEvidence.js';
import {
  canonicalField,
  carrierAvailable,
  collectionComplete,
  collectionTotalPaths,
  concreteCollections,
  insideRowCollection,
  provesEmptyCollection,
  readLater,
  rowKey,
  scalarKey,
  metricDimensionsMatch
} from '../../../domain/ai/evidencePopulation.js';
import {
  ENTITY_ID_FIELDS,
  entityKey,
  factRow,
  factSuperseded,
  listCollections,
  parentProperty,
  presentCollection,
  rankableMeasure,
  rankDomain,
  REQUEST_ENTITY_TYPES,
  REQUEST_LIMITS,
  REQUEST_OPERATIONS,
  rowMetricFields,
  sourceCollections
} from '../../../domain/ai/requestContract.js';
import { analyzeGroundedAnswer } from '../../../domain/ai/evidenceVerification.js';
import { createEvidenceFacts, fieldPatternCovers } from '../../../domain/ai/evidenceFacts.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { parseSicil } from '../../identity/sicil.js';
import { normalizeTaskFilters } from './rota/taskFacts.js';
import { parseToolArguments } from './toolArguments.js';
import { invalidArguments } from './toolErrors.js';
import { getRotaTool, toolCatalogForModel } from './toolRegistry.js';
import { containmentText } from './toolScope.js';
import {
  declaredFacets,
  familyKeys,
  periodWindow,
  populationAgreement,
  REQUEST_PERIODS,
  selectorsOf,
  sortedBy
} from './requestPopulation.js';

/**
 * Veri okunmadan bildirilen türlü isteğin SUNUCU tarafı: şema, güven
 * denetimi, varlık bağlama, kanıtın nüfus dizini ve isteğin belirlediği
 * olguların belirlenimci seçimi.
 *
 * Şemanın süzgeç değerleri araçların kendi şemalarından alınır; istek araçla
 * aynı sözlüğü konuşur. Sunucu kullanıcı cümlesini yorumlamaz: yalnızca
 * bildirilen yapının geçerliliğini, arama metninin kullanıcının iletisinden
 * geldiğini ve kimliğin kullanıcıdan ya da sunucu seçiminden geldiğini denetler.
 * Nüfus kimliği ve aracın yetenekleri requestPopulation.js'dedir.
 */

const ID_PATTERN = '^(?:[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}|[1-9][0-9]{0,9})$';
const POPULATIONS = Object.freeze({ project: 'projects', task: 'tasks', person: 'people', wbs: 'wbs', baseline: 'baselines' });

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
          collection: { type: 'string', maxLength: 80, description: `Yalnızca list/rank: aracın satır koleksiyonu (${toolCatalogForModel()
            .filter((tool) => rowCollections(tool.name).length).map((tool) => `${tool.name}=${rowCollections(tool.name).join('|')}`).join(', ')}). value isteğinde verilmez; kardeş koleksiyonlar (öncüller ve ardıllar, bildirim akışları) birlikte isteniyorsa list isteğinde verilmez.` },
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
          dateFrom: task.dateFrom, dateTo: task.dateTo, period: { type: 'string', enum: [...REQUEST_PERIODS] },
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

/**
 * Bildirimi doğrular; geçerli değilse ayrıntılı `INVALID_ARGUMENTS`. Arama
 * metni kullanıcının iletisinden, kimlik kullanıcının yazdığı ya da sunucunun
 * bağladığı seçimden gelmelidir. Nüfusun planla tamamlanması ve aracın
 * yetenek denetimi `completeRequest` ile, araç planıyla birlikte yapılır.
 */
/** Nüfusun boyutları: istek düzeyinde yazılmışlarsa (nüfusta yoksa) nüfusa aittir; biçim kayması anlamı değiştirmez. */
const POPULATION_KEYS = Object.freeze(['collection', 'sort', 'groupBy', 'depth', 'textFields']);

function populationShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.population || typeof raw.population !== 'object') return raw;
  const misplaced = POPULATION_KEYS.filter((key) => Object.hasOwn(raw, key) && !Object.hasOwn(raw.population, key));
  if (!misplaced.length) return raw;
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !misplaced.includes(key)));
  return { ...rest, population: { ...raw.population, ...Object.fromEntries(misplaced.map((key) => [key, raw[key]])) } };
}

export function parseRequestDeclaration(raw, { textTrusted, identityTrusted, today }) {
  if (raw == null) throw invalidArguments(['$.request:required']);
  const value = parseToolArguments(requestSchema(), JSON.stringify(populationShape(raw)));
  const problems = [];
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
      // Karşılaştırma katlanmış metinle yapılır; sunucunun ad araması kullanıcının yazdığı biçimi kullanır.
      return Object.freeze({ type: entity.type, id: null, text: containmentText(entity.text), query: String(entity.text).trim() });
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

/** Bildirim sorunlarının beklenen biçimi; yalnızca şemadan türetilir, modelin değeri yansıtılmaz. */
export function declarationHints(problems) {
  const hints = [];
  for (const problem of problems) {
    const path = String(problem).split(':')[0];
    const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
    const tool = /^calls\[\d+\]$/.test(parts[0] || '') ? getRotaTool(parts[1]) : null;
    let node = tool ? tool.parameters : requestSchema();
    for (const part of parts.slice(tool ? 2 : parts[0] === 'request' ? 1 : 0)) {
      node = node?.properties?.[part.replace(/\[\d+\]$/, '')];
      if (/\[\d+\]$/.test(part)) node = node?.items;
    }
    const leaf = node?.type === 'array' ? node.items : node;
    if (!node?.type || node.type === 'object' || (node.type === 'string' && !node.enum)) continue;
    const values = !leaf?.enum ? '' : leaf.enum.length <= 12 ? ` ${leaf.enum.join('|')}` : ' (izinli değerlerden biri)';
    hints.push(`${path.slice(2)}: ${node.type === 'array' ? `${leaf?.type} dizisi` : node.type}${values}`);
  }
  return [...new Set(hints)].slice(0, 6);
}

/**
 * Kayıtlı olmayan ölçü kimliğinin düzeltme ipucu: aynı önekli kayıtlı ölçüler (yalnızca kayıt
 * defterinden; modelin yazdığı metin yansıtılmaz).
 */
export function metricIdHints(problems, raw) {
  return problems.flatMap((problem) => {
    const index = /^\$\.metrics\[(\d+)\]:enum$/.exec(String(problem))?.[1];
    const value = index == null ? null : raw?.metrics?.[Number(index)];
    const head = typeof value === 'string' ? value.split('.')[0] : null;
    const family = head ? Object.keys(METRICS).filter((metric) => metric.startsWith(`${head}.`)) : [];
    return family.length ? [`metrics[${index}] kayıtlı değil; kayıtlı ${head}.* ölçüleri: ${family.slice(0, 16).join('|')}`] : [];
  });
}

/**
 * Bildirimin kullanıcının adlandırdığı kayıtları: metni kullanıcının iletisinde geçen
 * varlık adları ve görev başlığı metni. Bir tur boyunca birikir (reddedilen bildirimler dâhil).
 */
export function namedScope(scope, raw, textTrusted) {
  const texts = [...(Array.isArray(raw?.entities) ? raw.entities.map((entity) => entity?.text) : []), raw?.filters?.text];
  const next = new Map((scope || []).map((item) => [item.key, item]));
  for (const text of texts) {
    if (typeof text !== 'string' || !textTrusted(text)) continue;
    const key = containmentText(text);
    if (key && !next.has(key)) next.set(key, { key, text: text.trim() });
  }
  return [...next.values()];
}

/**
 * Düzeltme biçimi onarır, sorunun kapsamını daraltamaz: önceki bildirimde kullanıcının
 * adlandırdığı kayıtlardan yeni bildirimin varlıklarında (ya da başlık metninde) karşılığı
 * olmayanlar. Ad kısaltılmış ya da sözcüklerle uzatılmış olabilir.
 */
export function droppedNames(scope, raw) {
  const texts = [...(Array.isArray(raw?.entities) ? raw.entities.map((entity) => entity?.text) : []), raw?.filters?.text]
    .filter((text) => typeof text === 'string').map(containmentText).filter(Boolean);
  return (scope || []).filter((item) => !texts.some((text) => prefixRelated(item.key, text))).map((item) => item.text);
}

/** Düşürülen adların düzeltme ipucu. */
export function droppedNameHint(names) {
  return `entities: önceki kapsamdan ${names.length} varlık alanı düşürüldü (ENTITY_SCOPE_DROPPED); kullanıcının adlandırdığı bütün kayıtları koru. Birden çok varlıkta ölçüleri bindings ile kendi varlık sırasına bağla.`;
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
    // Kesilmiş ya da derinlikle sınırlı düğüm listesindeki tek eşleşme bütün ağaçta tek olduğunu kanıtlamaz.
    if (tool !== 'rota_wbs_inspect' || payload.complete !== true || payload.truncated === true || data.deeperNodes === true) return null;
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
  const bound = request.entities.map((entity) => {
    if (entity.id) return { ...entity, bound: entity.id };
    const found = new Set(entries.map(({ tool, args, payload }) => resolvedId(entity.type, tool, args, payload, entity.text)).filter(Boolean));
    // Kapsamın bağladığı ad: tam adı kullanıcının iletisinde geçen tek kısmi aday ya da (seri incelemesinde) tek serinin kayıtları.
    for (const item of selection?.named || []) {
      if (item.type !== entity.type || (item.tool && item.tool !== request.population?.tool)) continue;
      const uniqueScope = request.entities.filter((other) => other.type === entity.type && prefixRelated(item.text, other.text)).length === 1;
      if (item.text === entity.text || (uniqueScope && prefixRelated(item.text, entity.text) && prefixRelated(item.title, entity.text))) found.add(item.id);
    }
    if (found.size === 1) return { ...entity, bound: [...found][0] };
    const sameType = request.entities.filter((item) => item.type === entity.type && item.text);
    return { ...entity, bound: !found.size && selected?.[0] === entity.type && sameType.length === 1 ? selected[1] : null };
  });
  return bound.map((entity, index) => bound.some((other, position) => position !== index && entity.bound && other.type === entity.type
    && other.bound === entity.bound && other.text !== entity.text) ? { ...entity, bound: null } : entity);
}

/** Kullanıcının adlandırdığı adayın adı ile bildirilen ad aynı adın kısaltılmışı ya da sözcüklerle uzatılmışı mı? */
const prefixRelated = (title, text) => Boolean(title && text) && (title === text || text.startsWith(`${title} `) || title.startsWith(`${text} `));

/** Ad aramasının çözüm alanı: aracın yalnızca metinle (koşulsuz) yapılan araması adın görünür kayıtlarını tam sayar. */
const NAME_SEARCHES = Object.freeze({ project: ['rota_project_search', 'resolution'], person: ['rota_person_search', 'resolution'], task: ['rota_task_search', 'titleResolution'] });

/** Kullanıcının yazdığı adın ilk sözcüğü: tam ad hiçbir kayda uymazsa yoklama araması bununla yapılır. */
const probeText = (entity) => String(entity.query || entity.text || '').trim().split(/\s+/)[0] || '';

/** Bu metinle koşulsuz tam ad araması yapıldı ve hiçbir görünür kayda uymadı mı? */
function searchedNone(entries, type, text) {
  const [search, field] = NAME_SEARCHES[type] || [];
  return entries.some(({ tool, args = {}, payload }) => tool === search && payload?.data && payload.complete !== false
    && containmentText(args.text || '') === text && Object.keys(args).every((key) => ['text', 'limit'].includes(key)) && payload.data[field] === 'none');
}

/**
 * Tam adı hiçbir görünür kayda uymayan bağlanmamış varlığın yoklama araması (adın ilk sözcüğü):
 * model adı uzatmış olabilir (ör. "… _alt görev"); yoklamanın adaylarından tam adı kullanıcının
 * iletisinde geçen tek aday bildirilen varlıktır.
 */
export function nameProbes(request, entries, selection = null) {
  return bindRequestEntities(request, entries, selection).flatMap((entity) => {
    const probe = probeText(entity);
    if (entity.bound || !entity.text || !searchedNone(entries, entity.type, entity.text) || containmentText(probe) === entity.text) return [];
    return [{ name: NAME_SEARCHES[entity.type][0], args: { text: probe } }];
  });
}

/**
 * Adla bildirilen ve ne tam adı ne de adın ilk sözcüğü hiçbir görünür kayda uymayan varlıklar (ör.
 * görme yetkisi olmayan proje). Bu varlığın verisi bu turda okunamaz; yanıt kaydın bulunamadığıdır.
 */
export function unmatchedEntities(request, entries, selection = null) {
  return bindRequestEntities(request, entries, selection).filter((entity) => !entity.bound && entity.text && searchedNone(entries, entity.type, entity.text)
    && searchedNone(entries, entity.type, containmentText(probeText(entity))));
}

/* ── Kanıtın nüfus dizini ─────────────────────────────────── */

/**
 * Doğrulayıcının, sunucu seçiminin ve devir kararının ORTAK kanıt dizini:
 * kanıtın kanonik nüfusu (koşullar, seçiciler, varsayılanları uygulanmış
 * boyutlar), istenen koşulların o araçtaki karşılığı ve aracın ifade edemediği
 * koşullar. Yürütülen bağımsız değişkenler kayıtta kalır.
 */
export function requestEvidence(request, entries, today) {
  const active = Object.entries(request.filters).filter(([, value]) => value != null).map(([key]) => key);
  const index = new Map();
  for (const [ordinal, { id, tool, args = {}, payload, round = null }] of entries.entries()) {
    const agreement = populationAgreement(request, tool, args, today);
    index.set(id, {
      id,
      tool,
      ordinal,
      round: round ?? ordinal,
      args,
      snapshotDimensions: agreement.dimensions,
      facts: payload?.data ? createEvidenceFacts(payload, { prefix: payload.factScope || id }) : [],
      envelope: payload,
      facets: agreement.facets,
      declared: declaredFacets(tool, request.filters, today),
      unsupported: active.filter((key) => !familyKeys(tool).includes(key)),
      selectors: selectorsOf(args),
      sortedBy: sortedBy(tool, agreement.dimensions),
      firstPage: !args.cursor,
      populationMatch: agreement.populationMatch,
      collection: request.population?.tool === tool ? declaredCollections(request) : null,
      dimensionsMatch: agreement.dimensionsMatch,
      rowDimensionsMatch: agreement.rowDimensionsMatch,
      sortMatch: agreement.sortMatch
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

/* ── Uygun taşıyıcılar (sunucu seçimi ve devir kararı) ────── */

const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const sortedJson = (value) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
const declaredPaths = (request, tool, metric) => request.fields.filter((field) => field.tool === tool && field.metric === metric).map((field) => field.path);
const isProperty = (tool, path) => metricEntry(tool, path.startsWith('data.') ? path.slice(5) : path)?.property === true;
/**
 * Değer isteğinde ölçünün olası taşıyıcı yolları: satır dışı yollar ve varlığın kendi
 * özelliği olan satır alanları. Grup ya da proje satırındaki kırılım değer isteğinde
 * uygun değildir (doğrulayıcı da reddeder); toplamın anlamını belirsizleştirmez.
 */
const valueCarrierPaths = (tool, metric) => metricPaths(tool, metric).filter((path) => !insideRowCollection(tool, path) || isProperty(tool, path));
/**
 * Aynı kanıtta yapı gereği AYNI değeri taşıyan yollar (tek anlam): sunucu ilkini seçer.
 * Eşitlik bir özellik sınamasıyla korunur (analiz: toplam = saat kapsamının görev sayısı = totalCount).
 */
export { SAME_VALUE_PATHS } from '../../../domain/ai/claimableEvidence.js';

/** Gerçek eşdeğerlik anlatım, seçim ve tazelikte aynı sözlükten gelir. */
const representations = (tool, paths) => equivalentCarriers(tool, paths);

/** Değer isteğinde ölçünün tek anlamlı taşıyıcı yolları: tek yol ya da aynı değerli yolların ilki; yoksa null. */
function valueCarrier(tool, metric, source) {
  const carriers = valueCarrierPaths(tool, metric);
  const same = SAME_VALUE_PATHS[tool]?.[metric];
  if (same && carriers.every((path) => same.includes(path))) return [same[0]];
  if (equivalentCarriers(tool, carriers)) return [carriers.find((path) => source.facts.some((fact) => canonicalField(fact.field) === path)) || carriers[0]];
  return carriers.length === 1 ? carriers : null;
}

/** Olgunun satırının ya da seçicisinin adlandırdığı bağlı varlık (varlığın kendi özelliği). */
function ownedBy(source, fact, bound) {
  const type = metricEntityType(fact.semantic?.metric);
  const idField = ENTITY_ID_FIELDS[type];
  if (!fact.semantic?.property || !idField) return null;
  const row = factRow(source.tool, fact.field);
  const object = row?.kind === 'row' ? row.path.split('.').slice(1).reduce((value, key) => value?.[key], source.envelope.data) : null;
  const id = object ? object[idField] ?? object[type]?.[idField] : (source.selectors.find((item) => item.type === type)?.id ?? null);
  if (id == null) return null;
  return bound.find((entity) => entity.type === type && entityKey(type, entity.bound) === entityKey(type, id)) || null;
}

/**
 * Bir ölçünün bu kanıttaki uygun taşıyıcı olguları: doğrulayıcının olgu başına
 * denetimlerinin aynısı (nüfus aracı ya da açık alan bağı, koşullar, boyutlar,
 * sıra, koleksiyon, tazelik). Bağlı varlığın kendi özelliği nüfustan bağımsızdır.
 */
function eligibleFacts(request, source, metric, evidence, bound) {
  const declared = declaredPaths(request, source.tool, metric);
  if (request.fields.some((field) => field.metric === metric) && !declared.length) return [];
  return source.facts.filter((fact) => {
    if (!carrierAvailable(source, fact.field)) return false;
    if (fact.semantic?.metric !== metric || !scalar(fact.value)) return false;
    if (declared.length && !declared.some((path) => fieldPatternCovers(path, fact.field))) return false;
    const row = factRow(source.tool, fact.field);
    const owner = request.operation === 'value' || row?.kind !== 'row' ? ownedBy(source, fact, bound) : null;
    if (!owner) {
      const dimensionsMatch = metricDimensionsMatch(source, request, metric, row?.kind === 'row');
      if ((source.populationMatch === false && !declared.length) || dimensionsMatch === false || source.sortMatch === false) return false;
      if (source.unsupported.length || sortedJson(source.facets) !== sortedJson(source.declared)) return false;
      if (request.operation === 'value' && row?.kind === 'row') return false;
    }
    if (sourceCollections(source) && row?.kind === 'row' && !sourceCollections(source).includes(row.canonical)) return false;
    return !factSuperseded(evidence, source, fact, { property: owner ? [owner.type, entityKey(owner.type, owner.bound)] : null });
  });
}

const usableEntries = (entries) => entries.filter((entry) => entry.payload?.ok === true && entry.payload.data);

/**
 * Muhakeme başlamadan önce kanıt isteği karşılayabilir mi? Her ölçünün uygun
 * bir taşıyıcısı, liste/sıralamada nüfusun tam (ya da sıralı ilk sayfa ya da
 * boş) koleksiyonu bulunmalıdır. Doğrulayıcının reddedeceği kanıt Derin
 * düşünme turunu harcamaz.
 */
export function requestEvidenceReady(request, entries, today, selection = null) {
  return Boolean(request?.population && requestSelections(request, entries, selection, today, null, true).length);
}

/** Liste ya da sıralamanın bildirilen satır koleksiyonları; bildirilmemişse bildirilen satır ölçülerini taşıyan kardeş koleksiyonlar. */
function declaredCollections(request) {
  if (request.operation === 'value' || !request.population) return null;
  if (request.population.collection) return [request.population.collection];
  const lists = request.operation === 'list' ? listCollections(request.population.tool, request.metrics) : [];
  return lists.length ? lists : null;
}

/** Kanıttaki her bildirilen koleksiyon tam mı (en az biri bulunmalı)? Tek koleksiyonda koleksiyonun tamlığıdır. */
function listedCompletely(source, lists) {
  if (lists.length === 1) return collectionComplete(source, lists[0]);
  const present = lists.filter((canonical) => presentCollection(source.envelope, canonical));
  return present.length > 0 && present.every((canonical) => collectionComplete(source, canonical));
}

/** Kanıt bildirilen koleksiyonların hepsinin boş olduğunu kanıtlıyor mu? */
function listProvenEmpty(source, lists) {
  if (lists.length === 1) return provesEmptyCollection(source, lists[0]);
  const present = lists.filter((canonical) => presentCollection(source.envelope, canonical));
  return present.length > 0 && present.every((canonical) => provesEmptyCollection(source, canonical));
}

/* ── İstekten türetilen olgu seçimi ───────────────────────── */

/** Değer isteği: her ölçünün (ve bağlı varlığının) tek anlamlı kanıtı. */
function valueSelection(request, sources, evidence, bound, readiness = false) {
  const references = [];
  for (const metric of request.metrics) {
    const declared = request.fields.some((field) => field.metric === metric);
    const allowed = request.bindings.filter((binding) => binding.metric === metric).map((binding) => bound[binding.entity]);
    const groups = sources.flatMap((source) => {
      const carrier = declared ? null : valueCarrier(source.tool, metric, source);
      if (!readiness && !declared && !carrier && valueCarrierPaths(source.tool, metric).length > 1) return [];
      let facts = eligibleFacts(request, source, metric, evidence, bound);
      if (carrier && valueCarrierPaths(source.tool, metric).length > 1) facts = facts.filter((fact) => carrier.includes(canonicalField(fact.field)));
      // Sayfalı satır koleksiyonunun satır dışı kesin toplamı geçerlidir; satırları yalnızca tam koleksiyondan okunur.
      facts = facts.filter((fact) => {
        const row = factRow(source.tool, fact.field);
        return row?.kind !== 'row' || collectionComplete(source, row.canonical);
      });
      if (allowed.length) {
        facts = facts.filter((fact) => {
          const owner = ownedBy(source, fact, bound);
          const keys = owner ? [entityKey(owner.type, owner.bound)] : source.selectors.map(({ type, id }) => entityKey(type, id));
          return keys.some((key) => allowed.some((entity) => entityKey(entity.type, entity.bound) === key));
        });
      }
      return facts.length ? [{ source, facts }] : [];
    // Eşdeğer okumalardan (aynı araç ve nüfus) yalnızca sonuncusu önerilir: aynı plandaki yinelenen çağrı seçimi belirsizleştirmez.
    }).filter((group, index, all) => !all.some((other, position) => position > index && other.source.tool === group.source.tool
      && scalarKey(other.source, metric) === scalarKey(group.source, metric)));
    if (!groups.length) return null;
    if (groups.length > 1) {
      if (bound.length < 2) return null;
      const keys = groups.map(({ source }) => JSON.stringify(source.selectors));
      if (new Set(keys).size !== groups.length || keys.some((key) => key === '[]')) return null;
    }
    references.push(...groups.flatMap(({ source, facts }) => facts.map((fact) => `${source.id}:${fact.field}`)));
  }
  return references;
}

/** Liste ya da sıralama: nüfus aracının tam koleksiyonunun bütün satırları ya da sıralamanın başı. */
function rowSelection(request, source, evidence, bound, sources, readiness = false) {
  if (source.tool !== request.population.tool || !source.populationMatch || !source.rowDimensionsMatch || !source.sortMatch
    || source.unsupported.length || sortedJson(source.facets) !== sortedJson(source.declared)) return null;
  if (request.population.collection) return collectionSelection(request, source, evidence, bound, sources, request.population.collection, [], readiness);
  // Birden çok koleksiyonlu liste: kanıttaki her bildirilen koleksiyon ayrı ayrı (boşsa boş olarak) seçilir.
  const lists = (declaredCollections(request) || []).filter((canonical) => presentCollection(source.envelope, canonical));
  if (request.operation !== 'list' || !lists.length) return null;
  const parts = lists.map((canonical) => collectionSelection(request, source, evidence, bound, sources, canonical, lists, readiness));
  if (parts.some((facts) => !facts)) return null;
  const facts = parts.flat().filter((fact) => fact !== `${source.id}:complete`);
  return facts.length ? facts : [`${source.id}:complete`];
}

/** Tek satır koleksiyonunun seçimi; `siblings` aynı listedeki diğer koleksiyonlardır (birlikte listede tek koleksiyonun toplamı seçilmez). */
function collectionSelection(request, source, evidence, bound, sources, canonical, siblings, readiness = false) {
  const total = siblings.length ? null : collectionTotalPaths(source.tool, canonical).find((path) => (path === 'totalCount' ? source.envelope.totalCount != null
    : path.split('.').slice(1).reduce((value, key) => value?.[key], source.envelope.data) != null));
  const prefix = `data.${canonical}.*.`;
  const fields = [];
  const scalars = [];
  for (const metric of request.metrics) {
    const declared = declaredPaths(request, source.tool, metric);
    const registered = rowMetricFields(source.tool, canonical, metric).map((field) => `${prefix}${field}`);
    // Kanıtta bulunmayan kayıtlı alan (ör. grup satırında yalnızca count yazılır) belirsizlik değildir.
    const written = registered.filter((path) => source.facts.some((fact) => fieldPatternCovers(path, fact.field)));
    const rowPaths = written.length ? written : registered;
    if (rowPaths.length) {
      const selected = declared.length ? declared.filter((path) => path.startsWith(prefix)) : rowPaths;
      // Bildirilen koleksiyonun satır alanı listenin yanıtıdır; aynı ölçünün satır dışı toplamı isteğe bağlı bağlamdır, belirsizlik değil.
      if (!readiness && !declared.length && rowPaths.length > 1 && !representations(source.tool, rowPaths)) return null;
      if (!selected.length) return null;
      fields.push(...selected);
      continue;
    }
    if (total && metricPaths(source.tool, metric).includes(total) && collectionTotalPaths(source.tool, canonical).includes(total)) {
      const counter = sources.flatMap((other) => other.tool === source.tool && scalarKey(other, metric) === scalarKey(source, metric)
        ? eligibleFacts(request, other, metric, evidence, bound).filter((fact) => collectionTotalPaths(other.tool, canonical).includes(fact.field))
          .map((fact) => `${other.id}:${fact.field}`) : []).at(-1);
      if (!counter) return null;
      scalars.push(counter);
      continue;
    }
    // Tek kaydın iç koleksiyonunda üst kaydın kendi özelliği (ör. serinin kuralı) tek anlamlıysa seçilir.
    const parentPaths = metricPaths(source.tool, metric).filter((path) => parentProperty(source.tool, canonical, path)
      && source.facts.some((fact) => fact.field === path));
    const selectedParents = declared.length ? parentPaths.filter((path) => declared.includes(path)) : parentPaths;
    if (selectedParents.length === 1 || representations(source.tool, selectedParents) || ((readiness || declared.length) && selectedParents.length)) {
      scalars.push(...selectedParents.map((path) => `${source.id}:${path}`));
      continue;
    }
    // Bağlı varlığın kendi özelliği başka bir kanıttan gelebilir; tek anlamlı olmalıdır.
    const owners = sources.flatMap((other) => eligibleFacts(request, other, metric, evidence, bound)
      .filter((fact) => ownedBy(other, fact, bound) && isProperty(other.tool, canonicalField(fact.field)))
      .map((fact) => `${other.id}:${fact.field}`));
    if (owners.length !== 1) return null;
    scalars.push(owners[0]);
  }
  // Boş koleksiyonun yanıtı ya koleksiyonun sayısıdır ya da tamlık olgusudur (üst kaydın özelliği boşluğu söylemez).
  if (provesEmptyCollection(source, canonical)) {
    const counted = scalars.some((fact) => collectionTotalPaths(source.tool, canonical).includes(fact.slice(fact.indexOf(':') + 1)));
    return counted ? scalars : [...scalars, `${source.id}:complete`];
  }
  if (!fields.length) return null;
  const rank = request.operation === 'rank';
  if (!rank && !collectionComplete(source, canonical)) return null;
  // Aynı nüfusun daha yeni tam okuması bu satırların yerine geçer.
  if ([...evidence.values()].some((newer) => readLater(newer, source) && newer.tool === source.tool
    && rowKey(newer, canonical) === rowKey(source, canonical) && collectionComplete(newer, canonical))) return null;
  const naming = claimableContract(source.tool).paths.find((path) => path.startsWith(`${canonical}.*.`)
    && !path.slice(canonical.length + 3).includes('.') && metricEntry(source.tool, path)?.context);
  const relatives = [...new Set([naming ? `data.${naming}` : null, ...fields].filter(Boolean).map((path) => path.slice(prefix.length)))];
  const facts = [...scalars];
  if (rank) {
    const domain = rankDomain(request, [source, ...sources], canonical);
    if (!domain?.verified) return null;
    if (domain.empty) return [...facts, `${source.id}:complete`];
    const groups = new Map();
    for (const item of domain.order) {
      const key = `${item.source.id}|${item.collection}`;
      if (!groups.has(key)) groups.set(key, { ...item, indexes: [] });
      groups.get(key).indexes.push(item.index);
    }
    for (const item of groups.values()) {
      const rows = concreteCollections(item.source.envelope, canonical).find((collection) => collection.collection === item.collection)?.rows || [];
      const indexes = item.indexes.length === rows.length ? ['*'] : item.indexes;
      for (const relative of relatives) {
        for (const index of indexes) {
          const path = `${item.collection}.${index}.${relative}`;
          if (item.source.facts.some((fact) => fieldPatternCovers(path, fact.field))) facts.push(`${item.source.id}:${path}`);
        }
      }
    }
    return facts.length ? facts : null;
  }
  for (const item of concreteCollections(source.envelope, canonical)) {
    if (!item.rows.length) continue;
    let indexes = item.rows.map((_, index) => index);
    if (!indexes?.length) return null;
    if (indexes.length === item.rows.length) indexes = ['*'];
    for (const relative of relatives) {
      // Bütün satırlarda boş olan çok değerli alanın deseni olgu seçmez; satırlar alanı boş değeriyle taşır.
      const references = indexes.map((index) => `${item.collection}.${index}.${relative}`)
        .filter((pattern) => source.facts.some((fact) => fieldPatternCovers(pattern, fact.field)));
      facts.push(...references.map((pattern) => `${source.id}:${pattern}`));
    }
  }
  return facts.length ? facts : null;
}

/**
 * Bildirilen istekten sunucunun önerdiği olgu seçimleri. Öneri doğrulayıcının
 * kendisinden geçer (`accept`); tek doğrulanan aday kalırsa model seçim turu
 * gerekmez. Eşdeğer okumalar (aynı araç, nüfus, sıra ve boyutlar) tek adaydır:
 * en yeniden başlayarak doğrulanan ilk okuma önerilir. Belirsizlikte (birden çok
 * taşıyıcı ya da nüfus, bağlanmamış boyut ya da varlık) seçimi model yapar.
 */
export function requestSelections(request, entries, selection = null, today = null, accept = null, readiness = false) {
  if ((!readiness && request.reasoning === 'synthesis') || !request.population) return [];
  const bound = bindRequestEntities(request, entries, selection);
  if (bound.some((entity) => !entity.bound)) return [];
  const evidence = requestEvidence(request, usableEntries(entries), today ?? businessDate(new Date()));
  const sources = [...evidence.values()];
  const json = (facts) => JSON.stringify({ kind: 'rota', facts: [...new Set(facts)], layout: request.layout || 'auto' });
  const validate = accept || ((text) => analyzeGroundedAnswer(text, {
    request: { ...request, entities: bound }, evidence,
    evidenceIds: sources.map((source) => source.id), evidencePayloads: sources.map((source) => ({ id: source.id, payload: JSON.stringify(source.envelope) }))
  }).ok);
  const usable = (facts) => facts?.length && validate(json(facts));
  if (request.operation === 'value') {
    const facts = valueSelection(request, sources, evidence, bound, readiness);
    return usable(facts) ? [json(facts)] : [];
  }
  const classes = new Map();
  for (const source of [...sources].sort((left, right) => right.ordinal - left.ordinal)) {
    const key = `${source.tool}|${rowKey(source, request.population.collection)}`;
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push(source);
  }
  const candidates = [];
  for (const members of classes.values()) {
    for (const source of members) {
      const facts = rowSelection(request, source, evidence, bound, sources, readiness);
      if (usable(facts)) {
        candidates.push(json(facts));
        break;
      }
    }
  }
  return [...new Set(candidates)];
}
