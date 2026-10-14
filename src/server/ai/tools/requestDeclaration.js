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
  rowKey,
  scalarKey,
  metricDimensionsMatch
} from '../../../domain/ai/evidencePopulation.js';
import {
  emptyPropertyProofs,
  ENTITY_ID_FIELDS,
  entityKey,
  factRow,
  factSuperseded,
  listCollections,
  parentProperty,
  propertyOwner,
  rankableMeasure,
  rankedRowIndexes,
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
import { normalizeTaskFilters, searchText } from './rota/taskFacts.js';
import { parseToolArguments } from './toolArguments.js';
import { invalidArguments } from './toolErrors.js';
import { getRotaTool, toolCatalogForModel } from './toolRegistry.js';
import { containmentText } from './toolScope.js';
import { MIN_DIRECTORY_QUERY_LENGTH } from '../../directory/directorySearch.js';
import {
  declaredFacets,
  familyKeys,
  periodWindow,
  populationAgreement,
  REQUEST_PERIODS,
  resolutionProject,
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
 * Kabul edilen isteğin kapsam yükümlülükleri, TÜRÜYLE: kullanıcının adlandırdığı ya da kimliğini
 * yazdığı her kayıt (planla tamamlanan istekteki seçici kimlikleri dâhil) ve görev başlığı metni.
 * Yalnızca kabul edilen istekler birikir.
 */
export function namedScope(scope, request, textTrusted) {
  const next = new Map((scope || []).map((item) => [item.key, item]));
  const add = (item) => { if (!next.has(item.key)) next.set(item.key, item); };
  for (const entity of request?.entities || []) {
    const name = typeof entity.query === 'string' && textTrusted(entity.query)
      ? ['wbs', 'baseline'].includes(entity.type) ? entity.text : searchText(entity.query) : '';
    if (entity.id) add({ key: `${entity.type}#${entity.id}`, type: entity.type, id: entity.id });
    else if (name) add({ key: `${entity.type}:${name}`, type: entity.type, name });
  }
  const filter = request?.filters?.text;
  const name = typeof filter === 'string' && textTrusted(filter) ? searchText(filter) : '';
  if (name) add({ key: `filter:${name}`, type: 'filter', name });
  return [...next.values()];
}

/**
 * Düzeltme kabul edilen nüfusu genişletemez ya da varlığı değiştiremez.
 * Adın arama kimliği aynıdır; metin süzgeci aracın alt dizge yüklemiyle yalnızca daralabilir.
 */
export function droppedNames(scope, request) {
  const entities = request?.entities || [];
  const filter = searchText(request?.filters?.text);
  const kept = (item) => (item.id
    ? entities.some((entity) => entity.type === item.type && entity.id === item.id)
    : entities.some((entity) => (entity.type === item.type || (item.type === 'filter' && entity.type === 'task'))
      && typeof entity.query === 'string' && (item.type === 'filter'
        ? searchText(entity.query)?.includes(item.name)
        : item.name === (['wbs', 'baseline'].includes(entity.type) ? entity.text : searchText(entity.query))))
      || (item.type === 'filter' && Boolean(filter) && filter.includes(item.name)));
  return (scope || []).filter((item) => !kept(item)).map((item) => item.key);
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

/** İki okuma kapsamı aynı proje mi (ikisi de koşulsuz ya da aynı proje kimliği)? */
const sameScope = (projectId, scope) => (projectId == null ? null : canonicalActualId(projectId)) === (scope == null ? null : canonicalActualId(scope));

/** `scope`: varlığın adının çözüldüğü proje (resolutionProject) ya da koşulsuz çözüm için null. */
function resolvedId(type, tool, args, payload, entity, scope) {
  const data = payload?.data;
  const { text } = entity;
  if (!data || typeof data !== 'object') return null;
  // Çözüm yalnızca varlığın kendi kapsamındaki aramanın çözümüdür: projede tek olan ad başka projede ya da koşulsuz tek değildir.
  if (!sameScope(args?.projectId, scope)) return null;
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
  // Ad aramasının çözümü yalnızca AYNI aramanın (aracın yüklemiyle) çözümüdür.
  if (!sameSearch(args?.text, entity.query)) return null;
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
  const bindOne = (entity, scope) => {
    if (entity.id) return { ...entity, bound: entity.id };
    const found = new Set(entries.map(({ tool, args, payload }) => resolvedId(entity.type, tool, args, payload, entity, scope)).filter(Boolean));
    // Kapsamın bağladığı ad: tam adı kullanıcının iletisinde geçen tek kısmi aday ya da (seri incelemesinde) tek serinin kayıtları.
    for (const item of selection?.named || []) {
      if (item.type !== entity.type || (item.tool && item.tool !== request.population?.tool) || !sameScope(item.projectId, scope)) continue;
      if (sameSearch(item.query, entity.query) || sameSearch(item.title, entity.query)) found.add(item.id);
    }
    if (found.size === 1) return { ...entity, bound: [...found][0] };
    const sameType = request.entities.filter((item) => item.type === entity.type && item.text);
    return { ...entity, bound: !found.size && selected?.[0] === entity.type && sameType.length === 1 ? selected[1] : null };
  };
  // Projedeki kaydın adı yalnızca çözüldüğü projenin (resolutionProject) aramasıyla bağlanır; proje bağlanmadan bağlanmaz.
  const projects = request.entities.map((entity) => (entity.type === 'project' ? bindOne(entity, null) : { ...entity, bound: entity.id ?? null }));
  const bound = request.entities.map((entity, index) => {
    if (entity.type === 'project') return projects[index];
    const project = resolutionProject(request, projects, entity);
    return project && project.bound == null ? { ...entity, bound: entity.id ?? null } : bindOne(entity, project?.bound ?? null);
  });
  return bound.map((entity, index) => bound.some((other, position) => position !== index && entity.bound && other.type === entity.type
    && other.bound === entity.bound && entity.text && other.text && !sameSearch(other.query, entity.query)) ? { ...entity, bound: null } : entity);
}

/** İki metin aracın arama yükleminde aynı arama mı (requestPopulation.canonicalFacets ile aynı kimlik)? */
const sameSearch = (left, right) => searchText(left) != null && searchText(left) === searchText(right);

/** Ad aramasının çözüm alanı: aracın yalnızca metinle (koşulsuz) yapılan araması adın görünür kayıtlarını tam sayar. */
const NAME_SEARCHES = Object.freeze({ project: ['rota_project_search', 'resolution'], person: ['rota_person_search', 'resolution'], task: ['rota_task_search', 'titleResolution'] });

/** Kullanıcının yazdığı adın ilk sözcüğü: tam ad hiçbir kayda uymazsa yoklama araması bununla yapılır. */
const probeText = (entity) => String(entity.query || entity.text || '').trim().split(/\s+/)[0] || '';

/** Yoklama araması; projede çözülen ad yoklamada da aynı projeyle sınırlıdır (kapsam genişlemez). */
function probeCall(entity, projectId = null) {
  const search = NAME_SEARCHES[entity.type]?.[0];
  if (!search) return null;
  const text = probeText(entity);
  if (entity.type === 'person' && text.length < MIN_DIRECTORY_QUERY_LENGTH && parseSicil(text) == null) return null;
  try { return { name: search, args: parseToolArguments(getRotaTool(search).parameters, JSON.stringify({ text, ...(projectId ? { projectId } : {}) })) }; }
  catch { return null; }
}

/**
 * Bu adın AYNI araması (aracın yüklemiyle: `searchText`) yapıldı ve hiçbir görünür kayda uymadı mı?
 * Başka biçimde yazılmış (ör. "A B" / "A-B") aramanın boşluğu bu adın yokluğunu kanıtlamaz. Koşulsuz
 * arama her kapsamda, projede yapılan arama yalnızca adın aynı projedeki çözümü için "yok" kanıtıdır.
 */
function searchedNone(entries, type, query, projectId = null) {
  const [search, field] = NAME_SEARCHES[type] || [];
  return entries.some(({ tool, args = {}, payload }) => tool === search && payload?.data && payload.complete !== false
    && sameSearch(args.text, query) && Object.keys(args).every((key) => ['text', 'limit', 'projectId'].includes(key))
    && (args.projectId == null || (projectId != null && canonicalActualId(args.projectId) === canonicalActualId(projectId))) && payload.data[field] === 'none');
}

/** Varlığın adının çözüldüğü proje kimliği (requestPopulation.resolutionProject); yoksa null. */
const resolutionProjectId = (request, bound, entity) => resolutionProject(request, bound, entity)?.bound ?? null;

/**
 * Tam adı uymayan bağlanmamış varlığın ilk sözcük yoklaması; benzer kısa ad kimlik değildir.
 */
export function nameProbes(request, entries, selection = null) {
  const bound = bindRequestEntities(request, entries, selection);
  return bound.flatMap((entity) => {
    const probe = probeText(entity);
    const projectId = resolutionProjectId(request, bound, entity);
    if (entity.bound || !entity.text || !searchedNone(entries, entity.type, entity.query, projectId) || sameSearch(probe, entity.query)) return [];
    const call = probeCall(entity, projectId);
    return call ? [call] : [];
  });
}

/**
 * Adla bildirilen ve ne tam adı ne de adın ilk sözcüğü (adın çözüldüğü kapsamda) hiçbir görünür kayda
 * uymayan varlıklar (ör. görme yetkisi olmayan proje). Bu varlığın verisi bu turda okunamaz; yanıt kaydın
 * bulunamadığıdır ve başka bir kapsamda yeniden aranmaz.
 */
export function unmatchedEntities(request, entries, selection = null) {
  const bound = bindRequestEntities(request, entries, selection);
  return bound.filter((entity) => {
    if (entity.bound || !entity.text) return false;
    const projectId = resolutionProjectId(request, bound, entity);
    return searchedNone(entries, entity.type, entity.query, projectId)
      && (!probeCall(entity, projectId) || searchedNone(entries, entity.type, probeText(entity), projectId));
  });
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
    return !factSuperseded(evidence, source, fact, { rows: request.operation !== 'value' });
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

/* ── İstekten türetilen olgu seçimi ───────────────────────── */

/**
 * Bağlı varlığın açıkça boş çok değerli özelliği (doğrulayıcının aynı tanımı, emptyPropertyProofs):
 * kanıt, varlığı adlandıran olgusuyla atfedilir; varlık başına en yeni kanıt.
 */
function emptyPropertyCitations(request, sources, metric, evidence, bound) {
  const type = metricEntityType(metric);
  const named = new Map();
  for (const source of sources) {
    for (const { owner } of emptyPropertyProofs(request, bound, source, metric, evidence)) {
      const naming = source.facts.find((fact) => fact.semantic?.context && fact.semantic.property && !factRow(source.tool, fact.field)
        && metricEntityType(fact.semantic.metric) === type && propertyOwner(source, fact.field, type) === owner);
      if (naming) named.set(owner, `${source.id}:${naming.field}`);
    }
  }
  return [...named.values()];
}

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
    if (!groups.length) {
      const named = emptyPropertyCitations(request, sources, metric, evidence, bound);
      if (!named.length) return null;
      references.push(...named);
      continue;
    }
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
  const lists = declaredCollections(request) || [];
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
      scalars.push(`${source.id}:${total}`);
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
    const citations = owners.length ? owners : emptyPropertyCitations(request, sources, metric, evidence, bound);
    if (citations.length !== 1) return null;
    scalars.push(citations[0]);
  }
  // Boş koleksiyonun yanıtı ya koleksiyonun sayısıdır ya da tamlık olgusudur (üst kaydın özelliği boşluğu söylemez).
  if (provesEmptyCollection(source, canonical)) {
    const counted = scalars.some((fact) => collectionTotalPaths(source.tool, canonical).includes(fact.slice(fact.indexOf(':') + 1)));
    return counted ? scalars : [...scalars, `${source.id}:complete`];
  }
  if (!fields.length) return null;
  const rank = request.operation === 'rank';
  // Liste tek tam okumadır; tazelik ve sayfa kuralını seçimi doğrulayan aynı denetim uygular.
  if (!rank && !collectionComplete(source, canonical)) return null;
  const naming = claimableContract(source.tool).paths.find((path) => path.startsWith(`${canonical}.*.`)
    && !path.slice(canonical.length + 3).includes('.') && metricEntry(source.tool, path)?.context);
  const relatives = [...new Set([naming ? `data.${naming}` : null, ...fields].filter(Boolean).map((path) => path.slice(prefix.length)))];
  const facts = [...scalars];
  for (const item of concreteCollections(source.envelope, canonical)) {
    if (!item.rows.length) continue;
    let indexes = rank ? rankedRowIndexes(request, source.tool, source.envelope, canonical, item.collection.slice(5)) : item.rows.map((_, index) => index);
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
