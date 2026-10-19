/**
 * Rota AI planlayıcı değerlendirmesinin altın etiketleri ve puanlaması (Aşama 4C) — yalnızca değerlendirme
 * aracı ve sınamalar kullanır; üretim kodu bu dosyayı ve altın etiketleri içe aktarmaz (sınamayla korunur).
 *
 * Altın etiketler `test/fixtures/ai-planner-benchmark.json` içindedir ve Aşama 4A kıyas kümesinin (117 vaka)
 * parmak izine bağlıdır: kıyas kümesi değişirse etiketler bayat sayılır. Belge kapalı şemadır. Her `answer`
 * vakası türlü plan kısıtları (`plan.groups`: planın gerekli bölümleri; her grup bir ihtiyaç grubunu karşılar,
 * aynı ihtiyaç iki ayrı okuma isteyebilir) ve bunları karşılayan bir örnek plan (`example`, rota_plan
 * çağrısının `request`/`additionalRequests` alanları) taşır. `extras`, gerekli bölümlere ek olarak kabul edilen
 * bölümlerdir (ör. aynı sorunun toplamını ayrıca okuyan bölüm). Örnek planın üretim doğrulayıcılarından
 * geçtiği ve kendi etiketini karşıladığı sınamayla gösterilir (etiketin karşılanabilir olduğunun kanıtı).
 *
 * Puanlama planın anlamına bakar, JSON eşitliğine değil: koşullar üretimin kanonik nüfus kimliğiyle
 * (`declaredFacets`), metinler aramanın kanonik biçimiyle (`searchText`/`containmentText`) karşılaştırılır.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEMANTIC_BENCHMARK_FILE = path.join(ROOT, 'test/fixtures/ai-semantic-benchmark.json');
export const PLANNER_BENCHMARK_FILE = path.join(ROOT, 'test/fixtures/ai-planner-benchmark.json');
export const PLANNER_BENCHMARK_FORMAT = 'mergen-rota-planner-benchmark';
export const PLANNER_BENCHMARK_VERSION = 1;
export const PLANNER_RUN_FORMAT = 'mergen-rota-planner-run';

const { createSemanticCatalogue, semanticFingerprint, semanticToolDefinitions, normalizeSemanticQuery } = await import('../src/domain/ai/semanticContract.js');
const { validateSemanticBenchmark } = await import('../src/domain/ai/semanticEvaluation.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { declaredFacets, toolFamily } = await import('../src/server/ai/tools/requestPopulation.js');
const { searchText } = await import('../src/server/ai/tools/rota/taskFacts.js');
const { containmentText } = await import('../src/server/ai/tools/toolScope.js');
const { METRICS } = await import('../src/domain/ai/claimableEvidence.js');
const { REQUEST_ENTITY_TYPES, REQUEST_OPERATIONS } = await import('../src/domain/ai/requestContract.js');

/** Adla bildirilen varlık türünün sunucu tarafı çözüm aracı (planlayıcı önkoşulu; ihtiyaç değildir). */
const RESOLVERS = Object.freeze({ project: 'rota_project_search', person: 'rota_person_search', task: 'rota_task_search', wbs: 'rota_wbs_inspect', baseline: 'rota_baseline_compare' });
const EXPECTATIONS = Object.freeze(['answer', 'clarify', 'abstain']);
const FILTER_KEYS = Object.freeze(['status', 'priority', 'deadline', 'dateField', 'assignee', 'createdByMe', 'milestone', 'text', 'tab', 'workflowStatus',
  'source', 'includeEmpty', 'activityScope', 'activityKind']);
const DATE_FIELDS = Object.freeze(['targetFinish', 'calendarDate', 'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish']);
const MAX_ISSUES = 25;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fold = (value) => containmentText(String(value ?? ''));

/* ── Altın etiket şeması (kapalı) ───────────────────────────────────── */

function closed(value, fields, at, add) {
  if (!isRecord(value)) { add(`${at}:shape`); return false; }
  for (const key of Object.keys(value)) if (!fields.includes(key)) add(`${at}.${key}:unknown`);
  return true;
}

function stringList(value, at, add, { allowed = null, min = 1, max = 12 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => typeof item !== 'string' || !item)
    || new Set(value).size !== value.length || (allowed && value.some((item) => !allowed.includes(item)))) add(`${at}:invalid`);
}

function validateFilterValue(key, value, at, add) {
  const single = (item) => item === null || typeof item === 'boolean' || typeof item === 'string'
    || (Array.isArray(item) && item.length > 0 && item.every((part) => typeof part === 'string'));
  if (isRecord(value)) {
    if (Object.keys(value).some((field) => field !== 'any') || !Array.isArray(value.any) || !value.any.length || !value.any.every(single)) add(`${at}.${key}:invalid`);
  } else if (!single(value)) add(`${at}.${key}:invalid`);
}

const ANCHORS = Object.freeze(['today', 'weekStart', 'weekEnd', 'monthStart', 'monthEnd', 'nextMonthStart', 'nextMonthEnd', 'previousWeekStart', 'previousWeekEnd', 'yearEnd', 'nextYearStart']);

/** Göreli pencere sınırı: `[alt, üst]` gün farkı bugüne göre ya da `{ anchor | date: 'AA-GG', range }` takvim çapasına göre. */
function validateRange(value, at, add) {
  const pair = (range) => Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger) && range[0] <= range[1] && Math.abs(range[0]) <= 400 && Math.abs(range[1]) <= 400;
  if (Array.isArray(value)) { if (!pair(value)) add(`${at}:invalid`); return; }
  if (!isRecord(value) || Object.keys(value).some((key) => !['anchor', 'date', 'range'].includes(key)) || !pair(value.range ?? [0, 0])
    || (value.anchor === undefined) === (value.date === undefined) || (value.anchor !== undefined && !ANCHORS.includes(value.anchor))
    || (value.date !== undefined && !/^\d{2}-\d{2}$/.test(value.date))) add(`${at}:invalid`);
}

function validateAlternative(alt, at, add, { tools, groups, group }) {
  if (!closed(alt, ['tools', 'operation', 'entities', 'metrics', 'filters', 'window', 'rank', 'groupBy', 'dependent'], at, add)) return;
  if (alt.entities !== undefined) {
    if (!Array.isArray(alt.entities) || alt.entities.length > 4) add(`${at}.entities:invalid`);
    else alt.entities.forEach((entity, index) => {
      const where = `${at}.entities[${index}]`;
      if (!closed(entity, ['type', 'texts', 'ids'], where, add)) return;
      if (!REQUEST_ENTITY_TYPES.includes(entity.type)) add(`${where}.type:invalid`);
      if (entity.texts === undefined && entity.ids === undefined) add(`${where}:empty`);
      if (entity.texts !== undefined) stringList(entity.texts, `${where}.texts`, add);
      if (entity.ids !== undefined) stringList(entity.ids, `${where}.ids`, add);
    });
  }
  stringList(alt.tools, `${at}.tools`, add, { allowed: tools });
  if (alt.operation !== undefined) stringList(alt.operation, `${at}.operation`, add, { allowed: [...REQUEST_OPERATIONS] });
  if (alt.metrics !== undefined && closed(alt.metrics, ['any', 'all'], `${at}.metrics`, add)) {
    if (alt.metrics.any !== undefined) stringList(alt.metrics.any, `${at}.metrics.any`, add, { allowed: Object.keys(METRICS), max: 16 });
    if (alt.metrics.all !== undefined) stringList(alt.metrics.all, `${at}.metrics.all`, add, { allowed: Object.keys(METRICS), max: 8 });
  }
  if (alt.filters !== undefined && closed(alt.filters, FILTER_KEYS, `${at}.filters`, add)) {
    for (const [key, value] of Object.entries(alt.filters)) validateFilterValue(key, value, `${at}.filters`, add);
  }
  if (alt.window !== undefined && closed(alt.window, ['field', 'from', 'to'], `${at}.window`, add)) {
    if (alt.window.field !== undefined) stringList(alt.window.field, `${at}.window.field`, add, { allowed: [...DATE_FIELDS] });
    if (alt.window.from !== undefined) validateRange(alt.window.from, `${at}.window.from`, add);
    if (alt.window.to !== undefined) validateRange(alt.window.to, `${at}.window.to`, add);
  }
  if (alt.rank !== undefined && closed(alt.rank, ['order', 'metrics', 'limit'], `${at}.rank`, add)) {
    if (!['asc', 'desc'].includes(alt.rank.order)) add(`${at}.rank.order:invalid`);
    if (alt.rank.metrics !== undefined) stringList(alt.rank.metrics, `${at}.rank.metrics`, add, { allowed: Object.keys(METRICS) });
    if (alt.rank.limit !== undefined && (!Number.isSafeInteger(alt.rank.limit) || alt.rank.limit < 1 || alt.rank.limit > 10)) add(`${at}.rank.limit:invalid`);
  }
  if (alt.groupBy !== undefined) stringList(alt.groupBy, `${at}.groupBy`, add, { allowed: getRotaTool('rota_task_analytics').parameters.properties.groupBy.enum });
  if (alt.dependent !== undefined && closed(alt.dependent, ['type', 'group'], `${at}.dependent`, add)) {
    if (!['task', 'project'].includes(alt.dependent.type) || !Number.isSafeInteger(alt.dependent.group) || alt.dependent.group < 0
      || alt.dependent.group >= group || alt.dependent.group >= groups) add(`${at}.dependent:invalid`);
  }
}

/** Grubun karşıladığı ihtiyaç grubu (verilmezse grubun sırası). */
const groupNeed = (group, g) => group?.need ?? g;

function validatePlan(plan, at, add, { tools, needs }) {
  if (!closed(plan, ['groups', 'extras'], at, add)) return;
  if (!Array.isArray(plan.groups) || plan.groups.length < needs.length || plan.groups.length > 3) { add(`${at}.groups:count`); return; }
  plan.groups.forEach((group, g) => {
    const where = `${at}.groups[${g}]`;
    if (!closed(group, ['need', 'any'], where, add)) return;
    const need = groupNeed(group, g);
    if (!Number.isSafeInteger(need) || need < 0 || need >= needs.length) { add(`${where}.need:invalid`); return; }
    if (!Array.isArray(group.any) || !group.any.length || group.any.length > 8) { add(`${where}.any:invalid`); return; }
    group.any.forEach((alt, index) => {
      validateAlternative(alt, `${where}.any[${index}]`, add, { tools, groups: plan.groups.length, group: g });
      // Seçeneğin nüfus aracı o ihtiyaç grubunun aracıdır: etiket grubun anlamını genişletemez.
      if (Array.isArray(alt?.tools) && alt.tools.some((tool) => !needs[need].includes(tool))) add(`${where}.any[${index}].tools:outside-group`);
    });
  });
  needs.forEach((_, need) => { if (!plan.groups.some((group, g) => groupNeed(group, g) === need)) add(`${at}.groups:need-${need}-uncovered`); });
  if (plan.extras !== undefined) {
    if (!Array.isArray(plan.extras) || !plan.extras.length || plan.extras.length > 4) add(`${at}.extras:invalid`);
    else plan.extras.forEach((alt, index) => {
      validateAlternative(alt, `${at}.extras[${index}]`, add, { tools, groups: plan.groups.length, group: 0 });
      if (Array.isArray(alt?.tools) && alt.tools.some((tool) => !needs.flat().includes(tool))) add(`${at}.extras[${index}].tools:outside-needs`);
    });
  }
}

function validateExample(example, at, add) {
  // Örnek, rota_plan çağrısının istek alanlarıdır: { request, additionalRequests? }.
  if (!closed(example, ['request', 'additionalRequests'], at, add)) return;
  if (!isRecord(example.request)) add(`${at}.request:shape`);
  if (example.additionalRequests !== undefined && (!Array.isArray(example.additionalRequests) || example.additionalRequests.length < 1
    || example.additionalRequests.length > 2 || !example.additionalRequests.every(isRecord))) add(`${at}.additionalRequests:invalid`);
}

const EXAMPLE_DATE = /^\{\{(?:(today|weekStart|weekEnd|monthStart|monthEnd|nextMonthStart|nextMonthEnd|previousWeekStart|previousWeekEnd|yearEnd|nextYearStart)([+-]\d{1,3})?|date:(\d{2}-\d{2}))\}\}$/;

/** Örnek plandaki göreli tarih belirteçleri (`{{today+13}}`, `{{monthEnd}}`, `{{date:10-29}}`) referans güne çözülür. */
export function resolveExample(example, referenceDate) {
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    const token = typeof value === 'string' ? EXAMPLE_DATE.exec(value) : null;
    if (!token) return value;
    const day = token[3] ? anchorDay(referenceDate, { date: token[3] }) : anchorDay(referenceDate, { anchor: token[1] }) + Number(token[2] || 0);
    return new Date(day * 86400000).toISOString().slice(0, 10);
  };
  return resolve(example);
}

/**
 * Altın etiket belgesini doğrular ve Aşama 4A kıyas kümesine bağlar. Sonuç: vaka metni, beklentisi,
 * ihtiyaçları, kaçınmaları ve (yanıt vakasında) türlü plan kısıtları.
 */
export function validatePlannerBenchmark(document, semantic) {
  const issues = [];
  const add = (issue) => { if (issues.length < MAX_ISSUES) issues.push(issue); };
  if (!closed(document, ['format', 'version', 'semanticBenchmark', 'cases', 'supplementary'], '$', add)) return { ok: false, issues };
  if (document.format !== PLANNER_BENCHMARK_FORMAT) add('format:unknown');
  if (document.version !== PLANNER_BENCHMARK_VERSION) add('version:unsupported');
  if (document.semanticBenchmark !== semantic.fingerprint) add('semanticBenchmark:stale');
  const tools = rotaToolNames();
  const byId = new Map(semantic.cases.map((testCase) => [testCase.id, testCase]));
  const seen = new Set();
  const cases = [];
  if (!Array.isArray(document.cases) || document.cases.length !== semantic.cases.length) add('cases:count');
  for (const [position, entry] of (Array.isArray(document.cases) ? document.cases : []).entries()) {
    const at = `cases[${position}]`;
    if (!closed(entry, ['case', 'plan', 'example'], at, add)) continue;
    const testCase = byId.get(entry.case);
    if (!testCase) { add(`${at}.case:unknown`); continue; }
    if (seen.has(entry.case)) add(`${at}.case:duplicate`);
    if (semantic.cases[position]?.id !== entry.case) add(`${at}.case:order`);
    seen.add(entry.case);
    if (testCase.expect === 'answer') {
      if (entry.plan === undefined || entry.example === undefined) add(`${at}:answer-gold-required`);
      else { validatePlan(entry.plan, `${at}.plan`, add, { tools, needs: testCase.needs }); validateExample(entry.example, `${at}.example`, add); }
    } else if (entry.plan !== undefined || entry.example !== undefined) add(`${at}:gold-forbidden`);
    cases.push({ id: testCase.id, text: testCase.text, history: [], expect: testCase.expect, needs: testCase.needs, avoid: testCase.avoid, tags: testCase.tags,
      gold: entry.plan ?? null, example: entry.example ?? null, canonical: true });
  }
  const supplementary = Array.isArray(document.supplementary) ? document.supplementary : null;
  if (!supplementary || supplementary.length > 60) add('supplementary:invalid');
  const texts = new Set(semantic.cases.map((testCase) => testCase.text));
  for (const [position, entry] of (supplementary || []).entries()) {
    const at = `supplementary[${position}]`;
    if (!closed(entry, ['id', 'text', 'history', 'expect', 'needs', 'avoid', 'tags', 'plan', 'example'], at, add)) continue;
    if (typeof entry.id !== 'string' || !/^pl-\d{3}$/.test(entry.id) || seen.has(entry.id)) add(`${at}.id:invalid`);
    seen.add(entry.id);
    const query = normalizeSemanticQuery(entry.text);
    if (!query.ok || query.value !== entry.text || texts.has(entry.text)) add(`${at}.text:invalid`);
    texts.add(entry.text);
    if (!EXPECTATIONS.includes(entry.expect)) add(`${at}.expect:invalid`);
    const history = entry.history ?? [];
    if (!Array.isArray(history) || history.length > 4 || history.some((message, index) => !closed(message, ['role', 'content'], `${at}.history[${index}]`, add)
      || message.role !== (index % 2 ? 'assistant' : 'user') || typeof message.content !== 'string' || !message.content)) add(`${at}.history:invalid`);
    const needs = entry.needs ?? [];
    if (!Array.isArray(needs) || needs.some((group) => !Array.isArray(group) || !group.length || group.some((tool) => !tools.includes(tool)))
      || (entry.expect === 'answer') !== (needs.length > 0)) add(`${at}.needs:invalid`);
    const avoid = entry.avoid ?? [];
    if (!Array.isArray(avoid) || avoid.some((tool) => !tools.includes(tool) || needs.flat().includes(tool))) add(`${at}.avoid:invalid`);
    stringList(entry.tags, `${at}.tags`, add, { max: 6 });
    if (entry.expect === 'answer') {
      if (entry.plan === undefined || entry.example === undefined) add(`${at}:answer-gold-required`);
      else if (Array.isArray(needs)) { validatePlan(entry.plan, `${at}.plan`, add, { tools, needs }); validateExample(entry.example, `${at}.example`, add); }
    } else if (entry.plan !== undefined || entry.example !== undefined) add(`${at}:gold-forbidden`);
    cases.push({ id: entry.id, text: entry.text, history, expect: entry.expect, needs, avoid, tags: entry.tags, gold: entry.plan ?? null, example: entry.example ?? null, canonical: false });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, benchmark: {
    fingerprint: semanticFingerprint([PLANNER_BENCHMARK_FORMAT, PLANNER_BENCHMARK_VERSION, semantic.fingerprint,
      JSON.stringify(document.cases), JSON.stringify(document.supplementary)]),
    semanticFingerprint: semantic.fingerprint, cases
  } };
}

/** Kıyas kümesi ve altın etiketler; referans gün Türkiye saatiyle sabittir (göreli tarihler buna göre puanlanır). */
export function loadPlannerBenchmark({ plannerDocument = null, goldRequired = true, referenceDate = '2026-10-14' } = {}) {
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  const semantic = validateSemanticBenchmark(JSON.parse(readFileSync(SEMANTIC_BENCHMARK_FILE, 'utf8')), built.catalogue);
  if (!semantic.ok) throw new Error(`Kıyas kümesi geçersiz: ${semantic.issues.join(', ')}`);
  // Altın etiketsiz deneme (puanlanmaz): yalnızca kıyas kümesinin soruları.
  if (!goldRequired) {
    const cases = semantic.benchmark.cases.map((testCase) => ({ id: testCase.id, text: testCase.text, history: [], expect: testCase.expect,
      needs: testCase.needs, avoid: testCase.avoid, tags: testCase.tags, gold: null, example: null, canonical: true }));
    return { fingerprint: null, semanticFingerprint: semantic.benchmark.fingerprint, referenceDate, cases, now: new Date(`${referenceDate}T06:00:00Z`) };
  }
  const document = plannerDocument ?? JSON.parse(readFileSync(PLANNER_BENCHMARK_FILE, 'utf8'));
  const validated = validatePlannerBenchmark(document, semantic.benchmark);
  if (!validated.ok) throw new Error(`Planlayıcı altın etiketleri geçersiz: ${validated.issues.join(', ')}`);
  return { ...validated.benchmark, referenceDate, now: new Date(`${referenceDate}T06:00:00Z`) };
}

/* ── Puanlama ───────────────────────────────────────────────────────── */

const sameValue = (actual, expected) => {
  if (expected === null) return actual === undefined || actual === null;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && [...expected].sort().every((item, index) => [...actual].sort()[index] === item);
  return actual === expected;
};

/** Kısıttaki metin süzgeci aramanın kanonik biçimiyle karşılaştırılır. */
function filterMatches(key, actual, expected) {
  const options = isRecord(expected) ? expected.any : [expected];
  return options.some((option) => (key === 'text' && typeof option === 'string' ? actual === searchText(option) : sameValue(actual, option)));
}

const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000);

/** Takvim çapasının günü (referans güne göre; hafta pazartesi başlar). */
function anchorDay(referenceDate, bound) {
  const today = dayNumber(referenceDate);
  const [year, month] = referenceDate.split('-').map(Number);
  if (bound.date) return dayNumber(`${year}-${bound.date}`);
  const weekday = (new Date(`${referenceDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monthStart = dayNumber(`${referenceDate.slice(0, 7)}-01`);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const afterNext = month >= 11 ? `${year + 1}-${String(month - 10).padStart(2, '0')}-01` : `${year}-${String(month + 2).padStart(2, '0')}-01`;
  return {
    today, weekStart: today - weekday, weekEnd: today - weekday + 6, previousWeekStart: today - weekday - 7, previousWeekEnd: today - weekday - 1,
    monthStart, monthEnd: dayNumber(nextMonth) - 1, nextMonthStart: dayNumber(nextMonth), nextMonthEnd: dayNumber(afterNext) - 1,
    yearEnd: dayNumber(`${year}-12-31`), nextYearStart: dayNumber(`${year + 1}-01-01`)
  }[bound.anchor];
}

/** Penceredeki tarih sınırın kabul aralığında mı? */
function withinBound(referenceDate, day, bound) {
  if (typeof day !== 'string') return false;
  const base = Array.isArray(bound) ? dayNumber(referenceDate) : anchorDay(referenceDate, bound);
  const [lo, hi] = Array.isArray(bound) ? bound : (bound.range ?? [0, 0]);
  const value = dayNumber(day);
  return value >= base + lo && value <= base + hi;
}

/** Kanonik koşullar aracın varsayılan penceresini yazmaz (hareketlerde bugün, takvimde bugünden 30 gün): puanlama onu geri koyar. */
function effectiveWindow(tool, facets, referenceDate) {
  const family = toolFamily(tool);
  if (family === 'activity') return { dateFrom: facets.dateFrom ?? referenceDate, dateTo: facets.dateTo ?? referenceDate };
  if (family === 'calendar' && !facets.dateFrom && !facets.dateTo) return { dateFrom: referenceDate, dateTo: new Date((dayNumber(referenceDate) + 29) * 86400000).toISOString().slice(0, 10) };
  return facets;
}

/** Tek bölümün tek seçeneği karşılayıp karşılamadığı; karşılamıyorsa ilk nedeni döner. */
function alternativeIssue(part, alt, { referenceDate, matchedParts }) {
  const tool = part.population?.tool;
  if (!alt.tools.includes(tool)) return `tool:${tool}`;
  if (alt.operation && !alt.operation.includes(part.operation)) return `operation:${part.operation}`;
  if (alt.metrics?.all && alt.metrics.all.some((metric) => !part.metrics.includes(metric))) return 'metrics:all';
  if (alt.metrics?.any && !alt.metrics.any.some((metric) => part.metrics.includes(metric))) return 'metrics:any';
  const facets = toolFamily(tool) ? declaredFacets(tool, part.filters || {}, referenceDate) : {};
  for (const [key, expected] of Object.entries(alt.filters || {})) {
    const actual = key === 'dateField' ? facets.dateField : facets[key];
    if (!filterMatches(key, actual, expected)) return `filter:${key}`;
  }
  if (alt.window) {
    const window = alt.window;
    const span = effectiveWindow(tool, facets, referenceDate);
    if (window.field && !window.field.includes(facets.dateField ?? 'targetFinish')) return 'window:field';
    if (window.from && !withinBound(referenceDate, span.dateFrom, window.from)) return 'window:from';
    if (window.to && !withinBound(referenceDate, span.dateTo, window.to)) return 'window:to';
  }
  if (alt.rank) {
    if (!part.rank || part.rank.order !== alt.rank.order) return 'rank:order';
    if (alt.rank.metrics && !alt.rank.metrics.includes(part.rank.metric)) return 'rank:metric';
    if (alt.rank.limit && (part.rank.limit ?? 1) !== alt.rank.limit) return 'rank:limit';
  }
  if (alt.groupBy && !alt.groupBy.includes(part.population?.groupBy)) return 'groupBy';
  const entityIssue = entitiesIssue(part, alt.entities || []);
  if (entityIssue) return entityIssue;
  const dependent = (part.entities || []).find((entity) => entity.from != null);
  if (alt.dependent) {
    if (!dependent || dependent.type !== alt.dependent.type) return 'dependent:missing';
    if (matchedParts[alt.dependent.group] !== dependent.from) return 'dependent:source';
  } else if (dependent) return 'dependent:unexpected';
  return null;
}

/** Grupları ayrı bölümlerle eşler (küçük arama uzayı: en çok üç bölüm ve üç grup); eşleşmeyi döner. */
function matchGroups(parts, groups, context) {
  const issues = [];
  const assign = (g, used, matched) => {
    if (g === groups.length) return matched;
    for (let index = 0; index < parts.length; index += 1) {
      if (used.has(index)) continue;
      const next = { ...matched, [g]: index };
      const fits = groups[g].any.some((alt) => !alternativeIssue(parts[index], alt, { ...context, matchedParts: next }));
      if (!fits) continue;
      const result = assign(g + 1, new Set([...used, index]), next);
      if (result) return result;
    }
    return null;
  };
  const result = assign(0, new Set(), {});
  if (result) return { ok: true, issues, matched: result };
  // Nedeni raporlamak için her grubun en yakın seçeneği.
  groups.forEach((group, g) => {
    const reasons = parts.flatMap((part) => group.any.map((alt) => alternativeIssue(part, alt, { ...context, matchedParts: {} })));
    if (!reasons.includes(null)) issues.push(`group${g}:${reasons.find((reason) => !reason.startsWith('tool:')) || reasons[0] || 'missing'}`);
  });
  return { ok: false, issues: issues.length ? issues : ['groups:unmatched'] };
}

/**
 * Bölümün adla ya da kimlikle bildirilen varlıkları seçeneğin varlıklarıyla birebir eşleşmelidir: eksik varlık
 * soruyu genişletir, sorulmayan varlık nüfusu daraltır. Ad aramanın kanonik biçimiyle karşılaştırılır.
 */
function entitiesIssue(part, expected) {
  const declared = (part.entities || []).filter((entity) => entity.from == null);
  const matches = (entity, gold) => entity.type === gold.type && ((entity.text && (gold.texts || []).some((text) => fold(text) === fold(entity.query ?? entity.text)))
    || (entity.id && (gold.ids || []).includes(String(entity.id))));
  const used = new Set();
  for (const gold of expected) {
    const index = declared.findIndex((entity, position) => !used.has(position) && matches(entity, gold));
    if (index < 0) return `entity:${gold.type}`;
    used.add(index);
  }
  return declared.length > used.size ? `entity:extra-${declared.find((_, position) => !used.has(position)).type}` : null;
}

/**
 * Tek kararın puanı: `{ correct, reasons }`. Yanıt vakası planın üretim doğrulayıcılarından geçmiş olmasını
 * (kayıtta yalnızca doğrulanmış plan bulunur), her ihtiyaç grubunun bir bölümle anlamca karşılanmasını,
 * kaçınılacak ya da ilgisiz araç olmamasını ve varlıkların doğru olmasını ister.
 */
export function scoreDecision(testCase, record, { referenceDate }) {
  const reasons = [];
  if (testCase.expect === 'clarify') {
    if (record.outcome === 'clarification' && record.choice?.intent === 'clarify' && !record.plan) return { correct: true, reasons };
    return { correct: false, reasons: [`decision:${record.outcome}`] };
  }
  if (testCase.expect === 'abstain') {
    const nonExecution = !record.plan && (record.outcome === 'abstained' || (record.outcome === 'general_redirect' && record.general));
    return nonExecution ? { correct: true, reasons } : { correct: false, reasons: [`decision:${record.outcome}`] };
  }
  if (record.outcome !== 'planned' || !record.plan) return { correct: false, reasons: [`decision:${record.outcome}`] };
  const parts = record.plan.requests;
  const needs = new Set(testCase.needs.flat());
  const entityTypes = new Set(parts.flatMap((part) => (part.entities || []).filter((entity) => entity.from == null).map((entity) => entity.type)));
  const resolvers = new Set([...entityTypes].map((type) => RESOLVERS[type]));
  const partTools = parts.flatMap((part) => [part.population?.tool, ...(part.fields || []).map((field) => field.tool)]).filter(Boolean);
  const callTools = record.plan.calls.map((call) => call.name);
  for (const tool of new Set([...partTools, ...callTools])) {
    if (testCase.avoid.includes(tool)) reasons.push(`avoid:${tool}`);
  }
  for (const tool of new Set(partTools)) if (!needs.has(tool)) reasons.push(`unrelated:${tool}`);
  for (const tool of new Set(callTools)) if (!needs.has(tool) && !resolvers.has(tool)) reasons.push(`unrelated-call:${tool}`);
  const matched = matchGroups(parts, testCase.gold.groups, { referenceDate });
  if (!matched.ok) reasons.push(...matched.issues);
  else {
    // Gerekli bölümlere eşlenmeyen her bölüm de sorunun bir okuması olmalıdır (bir grubun ya da ek bölümlerin seçeneği).
    const used = new Set(Object.values(matched.matched));
    const options = [...testCase.gold.groups.flatMap((group) => group.any), ...(testCase.gold.extras || [])];
    parts.forEach((part, index) => {
      if (!used.has(index) && !options.some((alt) => !alternativeIssue(part, alt, { referenceDate, matchedParts: matched.matched }))) reasons.push('parts:extra');
    });
  }
  return { correct: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Koşu kaydı güncel kıyas ve altın etiketlere ait olmalıdır; geçiş başına özet ve vaka kimliğiyle ıskalar. */
export function scorePlannerRun(run, loaded) {
  if (!isRecord(run) || run.format !== PLANNER_RUN_FORMAT || run.version !== 1) throw new Error('PLANNER_RUN_INVALID');
  if (run.benchmark !== loaded.fingerprint) throw new Error('PLANNER_RUN_STALE');
  const byId = new Map(loaded.cases.map((testCase) => [testCase.id, testCase]));
  const selected = (Array.isArray(run.cases) ? run.cases : []).filter((id) => byId.has(id));
  const byPass = [];
  for (let pass = 1; pass <= run.passes; pass += 1) {
    const records = new Map(run.records.filter((record) => record.pass === pass).map((record) => [record.case, record]));
    const rows = selected.map((id) => {
      const testCase = byId.get(id);
      const record = records.get(id);
      const scored = record ? scoreDecision(testCase, record, { referenceDate: loaded.referenceDate }) : { correct: false, reasons: ['missing'] };
      return { case: id, canonical: testCase.canonical, expect: testCase.expect, ...scored };
    });
    const tally = (filter) => ({ total: rows.filter(filter).length, correct: rows.filter((row) => filter(row) && row.correct).length });
    byPass.push({
      pass,
      total: rows.length,
      correct: rows.filter((row) => row.correct).length,
      canonical: tally((row) => row.canonical),
      supplementary: tally((row) => !row.canonical),
      byExpect: Object.fromEntries(EXPECTATIONS.map((expect) => [expect, tally((row) => row.expect === expect)])),
      failures: rows.filter((row) => !row.correct).map((row) => ({ case: row.case, reasons: row.reasons }))
    });
  }
  const thinking = run.records.flatMap((record) => record.rounds.map((round) => round.thinking)).filter((value) => value != null);
  const models = [...new Set(run.records.flatMap((record) => record.rounds.flatMap((round) => round.models || [])))];
  const declarations = run.records.map((record) => record.declarations ?? 0);
  return {
    benchmark: loaded.fingerprint, semanticBenchmark: loaded.semanticFingerprint, referenceDate: loaded.referenceDate, passes: run.passes,
    semantic: run.semantic, models, thinkingTokens: { calls: thinking.length, max: thinking.length ? Math.max(...thinking) : null },
    modelCalls: run.records.reduce((sum, record) => sum + record.rounds.length, 0),
    repairs: { plansWithRepair: run.records.filter((record) => (record.declarations ?? 0) > 1).length, maxDeclarations: declarations.length ? Math.max(...declarations) : 0 },
    byPass
  };
}

