import { claimableContract, metricEntry, rowCollections } from './claimableEvidence.js';

/**
 * Rota AI istek sözleşmesi — modelin veri okumadan bildirdiği türlü istek ile
 * seçtiği olguların BELİRLENİMCİ uyumu.
 *
 * Sunucu Türkçe ya da İngilizce cümleyi yorumlamaz: sorunun anlamı modelin
 * yapılandırılmış bildirimidir (`operation`, `metrics`, `entities`, `filters`,
 * `rank`). Burada yalnızca nesnel değişmezler denetlenir: istenen her ölçü
 * temsil edilir; istenmeyen ölçü yanıt olamaz; olgunun nüfusu bildirilen
 * koşullarla ve sunucunun bağladığı varlıklarla birebir aynıdır; liste TAM bir
 * sonucun bütün satırlarını, sıralama sıralamanın başını kapsar ve istenen ölçü
 * listelenen satırların kendisinde bulunur. Doğal dil anlamının daha iyi
 * çıkarımı Aşama 4'ün işidir.
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
const ENTITY_ID_FIELDS = Object.freeze({ project: 'projectId', task: 'taskId', person: 'sicil', wbs: 'wbsId', baseline: 'baselineId' });

const sortedJson = (value) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));

/**
 * Olgunun kayıt satırı: kayıt defterindeki satır koleksiyonunun ilk düzeyi.
 * Kaydın çok değerli alanı satır değildir; `list` döner.
 */
export function factRow(tool, field) {
  const parts = String(field).split('.');
  if (parts[0] !== 'data') return null;
  const index = parts.findIndex((part, position) => position > 1 && /^\d+$/.test(part));
  if (index < 0 || index === parts.length - 1) return null;
  const canonical = parts.slice(1, index).join('.');
  return {
    kind: rowCollections(tool).includes(canonical) ? 'row' : 'list',
    canonical,
    collection: parts.slice(0, index).join('.'),
    index: Number(parts[index]),
    path: parts.slice(0, index + 1).join('.')
  };
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

/** Koleksiyonun satırlarında bir ölçüyü taşıyan kanonik alanlar. */
function rowMetricFields(tool, collection, metric) {
  const prefix = `${collection}.*.`;
  return claimableContract(tool).paths
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('*') && metricEntry(tool, path)?.metric === metric)
    .map((path) => path.slice(prefix.length));
}

/** Satır sıralamasının ölçü alanı: koleksiyonda o ölçüyü taşıyan ve satırlarda bulunan tek kanonik yol. */
function rankField(tool, collection, metric, rows) {
  const fields = rowMetricFields(tool, collection, metric).filter((field) => rows.some((row) => fieldValue(row, field) !== undefined));
  return fields.length === 1 ? fields[0] : null;
}

/**
 * Sıralama yanıtı: seçilen satırlar, koleksiyonun ölçüye göre başındaki
 * `limit` satır ve onlarla eşit değerdeki satırlardır. Sunucu sıralamayı
 * kanıttaki değerlerden kendisi kurar; kesilmiş koleksiyonda yalnızca aynı
 * ölçüyle sunucuda sıralanmış ilk sayfa kabul edilir.
 */
function rankMatches(request, source, collection, selected) {
  const rows = valueAt(source.envelope, collection.collection);
  const field = Array.isArray(rows) ? rankField(source.tool, collection.canonical, request.rank.metric, rows) : null;
  if (!field) return false;
  const direction = request.rank.order === 'asc' ? 1 : -1;
  const value = (row) => fieldValue(row, field);
  const ranked = rows.map((row, index) => ({ index, value: value(row) }))
    .filter((item) => item.value != null)
    .sort((left, right) => {
      return (left.value < right.value ? -1 : left.value > right.value ? 1 : 0) * direction || left.index - right.index;
    });
  const limit = Math.min(request.rank.limit || 1, ranked.length);
  if (!limit) return false;
  const boundary = ranked[limit - 1].value;
  const order = ranked.filter((item, position) => position < limit || item.value === boundary).map((item) => item.index);
  const expected = new Set(order);
  if (expected.size !== selected.size || [...expected].some((index) => !selected.has(index))) return false;
  if ([...selected].some((index, position) => index !== order[position])) return false;
  if (source.envelope.complete === true && source.envelope.truncated !== true && source.firstPage === true) return true;
  // Kesilmiş koleksiyon: sunucu aynı ölçüyle sıralamışsa ilk sayfa bütün nüfusun başıdır.
  const sorted = source.sortedBy?.metric === request.rank.metric && source.sortedBy?.order === request.rank.order && source.firstPage === true;
  if (!sorted) return false;
  const beyond = ranked[expected.size];
  if (beyond) return true;
  const proof = source.envelope.rankingBoundary;
  return proof?.collection === collection.canonical && proof.metric === request.rank.metric
    && proof.order === request.rank.order && proof.returnedCount === rows.length
    && (proof.nextValue === null || (ranked.length >= (request.rank.limit || 1) && typeof proof.nextValue === typeof boundary
      && (proof.nextValue < boundary ? -1 : proof.nextValue > boundary ? 1 : 0) * direction > 0));
}

/**
 * Atfedilen her kanıt TAM ve satırsız mı? Yalnızca böyle bir kanıt boş nüfusu
 * kanıtlar; kısaltılmış ya da sayfalanmış boş sonuç nüfusun boş olduğunu göstermez.
 */
function emptyRowEvidence(request, facts, evidence) {
  const ids = [...new Set(facts.map(({ evidenceId }) => evidenceId))];
  return ids.length > 0 && ids.every((evidenceId) => {
    const source = evidence.get(evidenceId);
    const compatible = rowCollections(source.tool).filter((collection) =>
      request.metrics.every((metric) => rowMetricFields(source.tool, collection, metric).length > 0));
    return source.envelope?.complete === true && source.envelope?.truncated !== true
      && source.firstPage === true
      && source.envelope.totalCount === 0
      && compatible.length > 0 && compatible.every((collection) => {
        const rows = valueAt(source.envelope, `data.${collection}`);
        return Array.isArray(rows) && rows.length === 0;
      });
  });
}

/**
 * Seçilen satırların her biri, taşıyabildiği istenen ölçünün olgusunu da taşıyor mu?
 * Kanıtta o ölçünün değeri bulunmayan satır ölçüyü taşımaz.
 */
function rowMetricComplete(entry, metric) {
  const fields = rowMetricFields(entry.source.tool, entry.row.canonical, metric);
  const rows = valueAt(entry.source.envelope, entry.row.collection) || [];
  return [...entry.indexes].every((index) => {
    const row = rows[index];
    return row && fields.some((field) => fieldValue(row, field) !== undefined)
      && entry.metrics.get(index)?.has(metric) === true;
  });
}

function entityKey(type, id) {
  return `${type}:${String(id).toLowerCase()}`;
}

/**
 * Seçilen olguların bildirilen isteğe uyumu: `{ ok, issues }`.
 *
 * `evidence`: kanıt kimliği → `{ tool, envelope, facets, declared, unsupported,
 * selectors, sortedBy, firstPage }`. `facets` kanıtın yürütülen nüfus
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
  const represented = new Set();
  const referenced = new Set();
  const collections = new Map();
  for (const { evidenceId, fact } of facts) {
    const source = evidence.get(evidenceId);
    if (!source) return fail('UNKNOWN_FACT_REFERENCE');
    const semantic = fact.semantic || {};
    const substantive = metrics.has(semantic.metric);
    if (!substantive && !semantic.context) return fail('UNDECLARED_METRIC');
    const row = factRow(source.tool, fact.field);
    const rowObject = row ? valueAt(source.envelope, row.path) : null;
    const rowEntities = rowObject && typeof rowObject === 'object'
      ? Object.entries(ENTITY_ID_FIELDS).filter(([, field]) => rowObject[field] != null).map(([type, field]) => entityKey(type, rowObject[field])) : [];
    const named = row?.kind === 'row' && rowEntities.some((entity) => boundKeys.has(entity));
    // Değer isteğinde bağlı varlığın kendi özelliği (adlandırılan satır ya da
    // seçicinin kaydı) nüfus koşulundan bağımsızdır; toplamlar ve sayımlar değildir.
    const ownProperty = request.operation === 'value' && semantic.property === true && (named || (!row && source.selectors.length > 0));
    const group = request.operation === 'value' && row?.kind === 'row' && !named ? groupScope(fact) : null;
    const selectors = [...source.selectors, ...(group?.selectors || [])];
    if (selectors.some(({ type, id }) => !boundKeys.has(entityKey(type, id)))) return fail('ENTITY_MISMATCH');
    if (substantive) {
      if (!ownProperty) {
        if (group && group.facets === null) return fail('POPULATION_MISMATCH');
        const effective = { ...source.facets, ...(group?.facets || {}) };
        if (source.unsupported.some((key) => !Object.hasOwn(group?.facets || {}, key))) return fail('POPULATION_MISMATCH');
        if (sortedJson(effective) !== sortedJson(source.declared)) return fail('POPULATION_MISMATCH');
      }
      represented.add(semantic.metric);
      // Varlık yalnızca ölçü taşıyan olguyla karşılanır; ad ya da etiket bağlamı yetmez.
      for (const { type, id } of selectors) referenced.add(entityKey(type, id));
      if (source.envelope?.entity?.id && REQUEST_ENTITY_TYPES.includes(source.envelope.entity.type)) {
        referenced.add(entityKey(source.envelope.entity.type, source.envelope.entity.id));
      }
      rowEntities.forEach((key) => referenced.add(key));
    }
    if (row) {
      const key = `${evidenceId}|${row.collection}`;
      if (!collections.has(key)) collections.set(key, { source, row, indexes: new Set(), metrics: new Map(), bound: true });
      const entry = collections.get(key);
      entry.indexes.add(row.index);
      if (substantive) entry.metrics.set(row.index, (entry.metrics.get(row.index) || new Set()).add(semantic.metric));
      if (row.kind === 'row' && request.operation === 'value') {
        const grouped = group && group.facets !== null && (Object.keys(group.facets).length > 0 || group.selectors.length > 0);
        if (!named && !grouped) entry.bound = false;
      }
    }
  }
  if ([...metrics].some((metric) => !represented.has(metric))) return fail('METRIC_MISSING');
  if ([...boundKeys].some((key) => !referenced.has(key))) return fail('ENTITY_MISSING');
  const rowGroups = [...collections.values()].filter((entry) => entry.row.kind === 'row');
  for (const entry of collections.values()) {
    const rows = valueAt(entry.source.envelope, entry.row.collection);
    const size = Array.isArray(rows) ? rows.length : 0;
    const complete = entry.indexes.size === size;
    // Çok değerli alan her istekte bütündür; satırların tamlığı istek türüne bağlıdır.
    if (entry.row.kind === 'list' && !complete) return fail('PARTIAL_VALUE_LIST');
    if (entry.row.kind !== 'row') continue;
    // Bütün satırların istendiği liste yalnızca TAM bir sonuçtan kurulur: boyut
    // sınırında kısaltılan zarf, elinde kalan satırların tamamı seçilse de bütün değildir.
    if (request.operation === 'list'
      && (!complete || entry.source.envelope?.complete !== true || entry.source.envelope?.truncated === true || entry.source.firstPage !== true)) return fail('LIST_INCOMPLETE');
    if (request.operation === 'value' && !entry.bound && size !== 1) return fail('ROW_SELECTION_UNBOUND');
  }
  // Liste ve sıralama satırların yanıtıdır: satırların taşıyabildiği istenen ölçü
  // her satırda bulunmalıdır; genel bir toplam satırların değerinin yerine geçmez.
  if (['list', 'rank'].includes(request.operation)) {
    const rowMetrics = [...metrics].filter((metric) => rowGroups.some((entry) =>
      rowMetricFields(entry.source.tool, entry.row.canonical, metric).length > 0));
    if (rowGroups.length && !rowMetrics.length) return fail('METRIC_MISSING');
    for (const metric of rowMetrics) {
      if (rowGroups.some((entry) => !rowMetricComplete(entry, metric))) return fail('METRIC_MISSING');
    }
  }
  if (request.operation === 'list' && !rowGroups.length && !emptyRowEvidence(request, facts, evidence)) return fail('LIST_ROWS_REQUIRED');
  if (request.operation === 'rank') {
    // Satırsız kanıt yalnızca nüfus boşken sıralamanın yanıtıdır.
    if (!rowGroups.length) return emptyRowEvidence(request, facts, evidence) ? { ok: true, issues: [] } : fail('RANK_MISMATCH');
    if (rowGroups.length !== 1) return fail('RANK_MISMATCH');
    const [entry] = rowGroups;
    if (!rankMatches(request, entry.source, entry.row, entry.indexes)) return fail('RANK_MISMATCH');
  }
  return { ok: true, issues: [] };
}
