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
export const PLANNER_RUN_VERSION = 2;
export const WEAK_PLANNER_MODEL = 'claude-haiku-4-5-20251001';

const { createSemanticCatalogue, semanticFingerprint, semanticToolDefinitions, normalizeSemanticQuery } = await import('../src/domain/ai/semanticContract.js');
const { validateSemanticBenchmark } = await import('../src/domain/ai/semanticEvaluation.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { canonicalDimensions, declaredFacets, readKey, requestBoundCall, requestDimensions, requestTextFields, toolFamily } = await import('../src/server/ai/tools/requestPopulation.js');
const { searchText } = await import('../src/server/ai/tools/rota/taskFacts.js');
const { containmentText } = await import('../src/server/ai/tools/toolScope.js');
const { EVIDENCE_TEXT_FIELDS, METRICS } = await import('../src/domain/ai/claimableEvidence.js');
const { REQUEST_ENTITY_TYPES, REQUEST_OPERATIONS } = await import('../src/domain/ai/requestContract.js');

/** Adla bildirilen varlık türünün sunucu tarafı çözüm aracı (planlayıcı önkoşulu; ihtiyaç değildir). */
const RESOLVERS = Object.freeze({ project: 'rota_project_search', person: 'rota_person_search', task: 'rota_task_search', wbs: 'rota_wbs_inspect', baseline: 'rota_baseline_compare' });
const CANONICAL_IDS = Object.freeze(Array.from({ length: 117 }, (_, index) => `tr-${String(index + 1).padStart(3, '0')}`));
const SUPPLEMENTARY_IDS = Object.freeze(Array.from({ length: 19 }, (_, index) => `pl-${String(index + 1).padStart(3, '0')}`));
const EXPECTATIONS = Object.freeze(['answer', 'clarify', 'abstain', 'general']);
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
export function validCalendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateRange(value, at, add) {
  const pair = (range) => Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger) && range[0] <= range[1] && Math.abs(range[0]) <= 400 && Math.abs(range[1]) <= 400;
  if (Array.isArray(value)) { if (!pair(value)) add(`${at}:invalid`); return; }
  if (!isRecord(value) || Object.keys(value).some((key) => !['anchor', 'date', 'range'].includes(key)) || !pair(value.range ?? [0, 0])
    || (value.anchor === undefined) === (value.date === undefined) || (value.anchor !== undefined && !ANCHORS.includes(value.anchor))
    || (value.date !== undefined && !validCalendarDate(`2000-${value.date}`))) add(`${at}:invalid`);
}

function validateAlternative(alt, at, add, { tools, groups, group }) {
  if (!closed(alt, ['tools', 'operation', 'entities', 'metrics', 'filters', 'window', 'rank', 'groupBy', 'dependent', 'collections', 'reasoning', 'textFields', 'depth', 'sort', 'fields'], at, add)) return;
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
  if (alt.operation === undefined) add(`${at}.operation:required`);
  if (alt.metrics === undefined) add(`${at}.metrics:required`);
  if (alt.collections === undefined) add(`${at}.collections:required`);
  if (alt.operation !== undefined) stringList(alt.operation, `${at}.operation`, add, { allowed: [...REQUEST_OPERATIONS] });
  if (alt.metrics !== undefined && closed(alt.metrics, ['any', 'all', 'allowed'], `${at}.metrics`, add)) {
    stringList(alt.metrics.allowed, `${at}.metrics.allowed`, add, { allowed: Object.keys(METRICS), max: 24 });
    if (alt.metrics.any !== undefined) stringList(alt.metrics.any, `${at}.metrics.any`, add, { allowed: Object.keys(METRICS), max: 16 });
    if (alt.metrics.all !== undefined) stringList(alt.metrics.all, `${at}.metrics.all`, add, { allowed: Object.keys(METRICS), max: 8 });
  }
  if (alt.collections !== undefined && closed(alt.collections, alt.tools || [], `${at}.collections`, add)) {
    for (const tool of alt.tools || []) {
      const values = alt.collections[tool];
      if (!Array.isArray(values) || !values.length || values.some((value) => value !== null && typeof value !== 'string') || new Set(values).size !== values.length) add(`${at}.collections.${tool}:invalid`);
    }
  }
  if (alt.fields !== undefined) {
    if (!Array.isArray(alt.fields) || !alt.fields.length) add(`${at}.fields:invalid`);
    else for (const field of alt.fields) {
      if (!closed(field, ['metric', 'tool', 'path'], `${at}.fields`, add)) continue;
      if (!Object.hasOwn(METRICS, field.metric) || !tools.includes(field.tool) || typeof field.path !== 'string') add(`${at}.fields:invalid`);
    }
  }
  if (alt.reasoning !== undefined) stringList(alt.reasoning, `${at}.reasoning`, add, { allowed: ['deterministic', 'synthesis'] });
  if (alt.textFields !== undefined) stringList(alt.textFields, `${at}.textFields`, add, { allowed: [...EVIDENCE_TEXT_FIELDS], min: 0 });
  if (alt.depth !== undefined && (!Number.isSafeInteger(alt.depth) || alt.depth < 1 || alt.depth > 4)) add(`${at}.depth:invalid`);
  if (alt.sort !== undefined) stringList(alt.sort, `${at}.sort`, add);
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

/** Sonlandırıcı kararın nedeni ve konuları da kapalı altın sözleşmenin parçasıdır. */
function validateDecisionGold(entry, expect, at, add) {
  if (!['tr', 'en'].includes(entry.language)) add(`${at}.language:required`);
  if (!['clarify', 'abstain'].includes(expect)) {
    if (entry.choice !== undefined) add(`${at}.choice:forbidden`);
    return;
  }
  if (!closed(entry.choice, ['reason', 'topics'], `${at}.choice`, add)) return;
  const reasons = expect === 'clarify' ? ['missing_referent', 'ambiguous'] : ['write', 'calculation', 'outside_data', 'security', 'general'];
  if (!reasons.includes(entry.choice.reason)) add(`${at}.choice.reason:invalid`);
  if (entry.choice.reason === 'ambiguous') {
    if (!Array.isArray(entry.choice.topics) || entry.choice.topics.length < 2) add(`${at}.choice.topics:required`);
    else entry.choice.topics.forEach((group) => stringList(group, `${at}.choice.topics`, add, { allowed: rotaToolNames() }));
  } else if (entry.choice.topics !== undefined) add(`${at}.choice.topics:forbidden`);
}

/** İzinler yalnızca açık vaka girdisidir; puanlama etiketinden türetilmez. */
function validateInput(input, at, add) {
  if (input === undefined) return;
  if (closed(input, ['allowedTextFields'], `${at}.input`, add)) stringList(input.allowedTextFields, `${at}.input.allowedTextFields`, add, { allowed: [...EVIDENCE_TEXT_FIELDS], min: 0 });
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
  if (semantic.cases.length !== CANONICAL_IDS.length || semantic.cases.some((item, index) => item.id !== CANONICAL_IDS[index])) add('cases:mandatory-ids');
  const tools = rotaToolNames();
  const byId = new Map(semantic.cases.map((testCase) => [testCase.id, testCase]));
  const seen = new Set();
  const cases = [];
  if (!Array.isArray(document.cases) || document.cases.length !== semantic.cases.length) add('cases:count');
  for (const [position, entry] of (Array.isArray(document.cases) ? document.cases : []).entries()) {
    const at = `cases[${position}]`;
    if (!closed(entry, ['case', 'plan', 'example', 'language', 'choice', 'input'], at, add)) continue;
    const testCase = byId.get(entry.case);
    if (!testCase) { add(`${at}.case:unknown`); continue; }
    if (seen.has(entry.case)) add(`${at}.case:duplicate`);
    if (semantic.cases[position]?.id !== entry.case) add(`${at}.case:order`);
    seen.add(entry.case);
    if (testCase.expect === 'answer') {
      if (entry.plan === undefined || entry.example === undefined) add(`${at}:answer-gold-required`);
      else { validatePlan(entry.plan, `${at}.plan`, add, { tools, needs: testCase.needs }); validateExample(entry.example, `${at}.example`, add); }
    } else if (entry.plan !== undefined || entry.example !== undefined) add(`${at}:gold-forbidden`);
    validateDecisionGold(entry, testCase.expect, at, add);
    validateInput(entry.input, at, add);
    cases.push({ input: entry.input, language: entry.language, choice: entry.choice, id: testCase.id, text: testCase.text, history: [], expect: testCase.expect, needs: testCase.needs, avoid: testCase.avoid, tags: testCase.tags,
      gold: entry.plan ?? null, example: entry.example ?? null, canonical: true });
  }
  const supplementary = Array.isArray(document.supplementary) ? document.supplementary : null;
  if (!supplementary || supplementary.length !== SUPPLEMENTARY_IDS.length || supplementary.some((entry, index) => entry?.id !== SUPPLEMENTARY_IDS[index])) add('supplementary:mandatory-ids');
  const texts = new Set(semantic.cases.map((testCase) => testCase.text));
  for (const [position, entry] of (supplementary || []).entries()) {
    const at = `supplementary[${position}]`;
    if (!closed(entry, ['id', 'text', 'history', 'expect', 'needs', 'avoid', 'tags', 'plan', 'example', 'language', 'choice', 'input'], at, add)) continue;
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
    validateDecisionGold(entry, entry.expect, at, add);
    validateInput(entry.input, at, add);
    cases.push({ input: entry.input, language: entry.language, choice: entry.choice, id: entry.id, text: entry.text, history, expect: entry.expect, needs, avoid, tags: entry.tags, gold: entry.plan ?? null, example: entry.example ?? null, canonical: false });
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
  if (!validCalendarDate(referenceDate)) throw new Error('PLANNER_REFERENCE_DATE_INVALID');
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  const semantic = validateSemanticBenchmark(JSON.parse(readFileSync(SEMANTIC_BENCHMARK_FILE, 'utf8')), built.catalogue);
  if (!semantic.ok) throw new Error(`Kıyas kümesi geçersiz: ${semantic.issues.join(', ')}`);
  const document = plannerDocument ?? JSON.parse(readFileSync(PLANNER_BENCHMARK_FILE, 'utf8'));
  if (!goldRequired) {
    // Tanı girdisi aynı soru, geçmiş ve açık izin yapılandırmasını kullanır; altın etiketleri taşımaz.
    const cases = [...semantic.benchmark.cases.map((testCase) => ({ ...testCase, input: document.cases.find((entry) => entry.case === testCase.id)?.input, history: [], canonical: true })),
      ...document.supplementary.map(({ id, text, history = [], input }) => ({ id, text, history, input, canonical: false }))];
    return { fingerprint: null, semanticFingerprint: semantic.benchmark.fingerprint, referenceDate, cases, now: new Date(`${referenceDate}T06:00:00Z`) };
  }
  const validated = validatePlannerBenchmark(document, semantic.benchmark);
  if (!validated.ok) throw new Error(`Planlayıcı altın etiketleri geçersiz: ${validated.issues.join(', ')}`);
  return { ...validated.benchmark, fingerprint: semanticFingerprint([validated.benchmark.fingerprint, referenceDate]), referenceDate, now: new Date(`${referenceDate}T06:00:00Z`) };
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
  if (bound.date) {
    if (!validCalendarDate(`${year}-${bound.date}`)) throw new Error('PLANNER_GOLD_DATE_INVALID');
    return dayNumber(`${year}-${bound.date}`);
  }
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
  if (!validCalendarDate(day)) return false;
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
  if (!alt.operation.includes(part.operation)) return `operation:${part.operation}`;
  if (alt.metrics?.all && alt.metrics.all.some((metric) => !part.metrics.includes(metric))) return 'metrics:all';
  if (alt.metrics?.any && !alt.metrics.any.some((metric) => part.metrics.includes(metric))) return 'metrics:any';
  if (alt.fields && (alt.fields.some((gold) => !(part.fields || []).some((field) => field.metric === gold.metric && field.tool === gold.tool && field.path === gold.path))
    || (part.fields || []).some((field) => !alt.fields.some((gold) => field.metric === gold.metric && field.tool === gold.tool && field.path === gold.path)))) return 'fields';
  if (!alt.fields && (part.fields || []).length) return 'fields:unexpected';
  if ((part.bindings || []).length && (part.entities || []).length > 1) return 'bindings:unexpected';
  if (part.metrics.some((metric) => !alt.metrics.allowed.includes(metric))) return 'metrics:extra';
  if (!(alt.collections[tool] || []).includes(part.population?.collection ?? null)) return 'collection';
  if (!(alt.reasoning || ['deterministic']).includes(part.reasoning || 'deterministic')) return 'reasoning';
  if (!sameValue(requestTextFields(part), alt.textFields || [])) return 'textFields';
  if (!alt.rank && part.rank) return 'rank:unexpected';
  if (!alt.groupBy && part.population?.groupBy) return 'groupBy:unexpected';
  const dimensions = requestDimensions(part, tool);
  const defaults = canonicalDimensions(tool, part.filters || {});
  if ((dimensions.depth ?? null) !== (alt.depth ?? defaults.depth ?? null)) return 'depth';
  if (alt.sort ? !alt.sort.includes(dimensions.sort) : !alt.rank && dimensions.sort !== defaults.sort) return 'sort';
  const facets = toolFamily(tool) ? declaredFacets(tool, part.filters || {}, referenceDate) : {};
  for (const [key, expected] of Object.entries(alt.filters || {})) {
    const actual = key === 'dateField' ? facets.dateField : facets[key];
    if (!filterMatches(key, actual, expected)) return `filter:${key}`;
  }
  const expectedFilters = Object.fromEntries(Object.entries(alt.filters || {}).map(([key, value]) => [key, isRecord(value)
    ? value.any.find((option) => filterMatches(key, facets[key], option)) ?? value.any[0] : value]));
  if (!Object.hasOwn(expectedFilters, 'text') && ['rota_project_search', 'rota_person_search'].includes(tool)) {
    const type = tool === 'rota_project_search' ? 'project' : 'person';
    const entity = (alt.entities || []).find((item) => item.type === type);
    if (entity?.texts?.some((text) => searchText(text) === facets.text)) expectedFilters.text = facets.text;
  }
  const expectedFacets = declaredFacets(tool, expectedFilters, referenceDate);
  for (const key of new Set([...Object.keys(facets), ...Object.keys(expectedFacets)])) {
    if (Object.hasOwn(alt.filters || {}, key) || alt.window && ['dateFrom', 'dateTo', 'dateField'].includes(key)) continue;
    if (!sameValue(facets[key], expectedFacets[key] ?? null)) return `filter:unexpected-${key}`;
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
  if (record.language !== testCase.language) return { correct: false, reasons: ['language'] };
  if (testCase.expect === 'general') {
    return record.outcome === 'general_redirect' && record.general && !record.plan && !record.choice
      ? { correct: true, reasons } : { correct: false, reasons: [`decision:${record.outcome}`] };
  }
  if (['clarify', 'abstain'].includes(testCase.expect)) {
    const expected = testCase.expect === 'clarify' ? 'clarification' : 'abstained';
    if (record.outcome !== expected || record.choice?.intent !== testCase.expect || record.plan) return { correct: false, reasons: [`decision:${record.outcome}`] };
    if (record.choice.reason !== testCase.choice.reason) reasons.push('choice:reason');
    const topics = record.choice.topics || [];
    const groups = testCase.choice.topics || [];
    if (groups.length) {
      const matched = groups.filter((group) => group.some((tool) => topics.includes(tool)));
      if (topics.length < 2 || new Set(topics).size !== topics.length || matched.length !== groups.length || topics.some((topic) => !groups.flat().includes(topic))) reasons.push('choice:topics');
    } else if (topics.length) reasons.push('choice:topics');
    return { correct: !reasons.length, reasons };
  }
  if (record.outcome !== 'planned' || !record.plan) return { correct: false, reasons: [`decision:${record.outcome}`] };
  const parts = record.plan.requests;
  const needs = new Set(testCase.needs.flat());
  const entityTypes = new Set(parts.flatMap((part) => (part.entities || []).filter((entity) => entity.from == null).map((entity) => entity.type)));
  const resolvers = new Set([...entityTypes].map((type) => RESOLVERS[type]));
  const partTools = parts.flatMap((part) => [part.population?.tool, ...(part.fields || []).map((field) => field.tool)]).filter(Boolean);
  const callTools = record.plan.calls.map((call) => call.name);
  const reads = record.plan.calls.map((call) => readKey(call.name, { ...call.args, limit: 1 }, referenceDate));
  if (new Set(reads).size !== reads.length) reasons.push('calls:duplicate');
  for (const call of record.plan.calls) {
    if (!requestBoundCall(parts[0], call.name, call.args, { today: referenceDate })) reasons.push('calls:unrelated');
  }
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
    const options = [...(testCase.gold.extras || [])];
    parts.forEach((part, index) => {
      if (used.has(index)) return;
      const extra = options.findIndex((alt) => !alternativeIssue(part, alt, { referenceDate, matchedParts: matched.matched }));
      if (extra < 0) reasons.push('parts:extra');
      else options.splice(extra, 1);
    });
  }
  return { correct: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Puanlamadan önce bütünlük; bozuk koşu bir model puanı değildir. */
export function validatePlannerRun(run, loaded) {
  const invalid = () => { throw new Error('PLANNER_RUN_INVALID'); };
  if (!isRecord(run) || run.format !== PLANNER_RUN_FORMAT || run.version !== PLANNER_RUN_VERSION) invalid();
  if (run.benchmark !== loaded.fingerprint || run.semanticBenchmark !== loaded.semanticFingerprint) throw new Error('PLANNER_RUN_STALE');
  if (!validCalendarDate(run.referenceDate) || run.referenceDate !== loaded.referenceDate) invalid();
  const known = new Set(loaded.cases.map((testCase) => testCase.id));
  if (!Array.isArray(run.cases) || !run.cases.length || run.cases.some((id) => !known.has(id)) || new Set(run.cases).size !== run.cases.length) invalid();
  if (!Number.isSafeInteger(run.passes) || run.passes < 1 || run.passes > 10 || !Array.isArray(run.records) || run.records.length !== run.cases.length * run.passes) invalid();
  if (!isRecord(run.qualification) || typeof run.qualification.expectedModel !== 'string' || !run.qualification.expectedModel || run.qualification.thinking !== 'off') invalid();
  if (!isRecord(run.model) || Object.keys(run.model).some((key) => !['live', 'commandHash'].includes(key)) || Boolean(run.model.live) === Boolean(run.model.commandHash)) invalid();
  if (run.model.commandHash && !/^[a-f0-9]{64}$/.test(run.model.commandHash)) invalid();
  if (run.model.live && (run.model.live.thinking !== 'off' || run.model.live.model !== run.qualification.expectedModel || !run.model.live.provider || run.model.live.profile !== 'chat.tools')) invalid();
  if (!isRecord(run.semantic) || !['none', 'run', 'live'].includes(run.semantic.mode)) invalid();
  if (run.semantic.mode === 'run' && (!run.semantic.provenance?.model || !run.semantic.provenance?.provider || !run.semantic.provenance?.preprocessing)) invalid();
  if (run.semantic.mode === 'live' && run.semantic.provenance?.path !== 'gateway') invalid();
  const seen = new Set();
  for (const record of run.records) {
    if (!isRecord(record)) invalid();
    const key = `${record.pass}:${record.case}`;
    if (!run.cases.includes(record.case) || !Number.isSafeInteger(record.pass) || record.pass < 1 || record.pass > run.passes || seen.has(key)) invalid();
    seen.add(key);
    if (!Array.isArray(record.rounds) || !record.rounds.length || record.rounds.some((round) => !isRecord(round) || round.error)) invalid();
    if (record.outcome === 'planned' && (!isRecord(record.plan) || !Array.isArray(record.plan.requests) || !record.plan.requests.length
      || record.plan.requests.length > 3 || !Array.isArray(record.plan.calls) || record.plan.calls.some((call) => !isRecord(call) || !rotaToolNames().includes(call.name) || !isRecord(call.args))
      || record.plan.requests.some((part) => !isRecord(part) || !['value', 'list', 'rank'].includes(part.operation)
        || !Array.isArray(part.metrics) || !part.metrics.length || part.metrics.some((metric) => !Object.hasOwn(METRICS, metric))
        || !isRecord(part.population) || !rotaToolNames().includes(part.population.tool)
        || !Array.isArray(part.entities) || part.entities.some((entity) => !isRecord(entity))
        || !isRecord(part.filters) || !Array.isArray(part.fields) || part.fields.some((field) => !isRecord(field))
        || !Array.isArray(part.bindings) || part.bindings.some((binding) => !isRecord(binding))))) invalid();
    if (record.choice != null && (!isRecord(record.choice) || !['clarify', 'abstain'].includes(record.choice.intent) || typeof record.choice.reason !== 'string'
      || record.choice.topics != null && (!Array.isArray(record.choice.topics) || record.choice.topics.some((topic) => typeof topic !== 'string')))) invalid();
    const missed = ['failed', 'unavailable', 'not_found'].includes(record.outcome);
    if (typeof record.general !== 'boolean' || !(['tr', 'en'].includes(record.language) || missed && record.language === null)) invalid();
    if (missed && (record.plan != null || record.choice != null || record.general)) invalid();
    if (!['planned', 'clarification', 'abstained', 'general_redirect'].includes(record.outcome) && !missed || record.error) invalid();
    if (!['reranked', 'first_stage', 'unavailable'].includes(record.semantic?.state) || !Array.isArray(record.semantic?.candidates)
      || new Set(record.semantic.candidates).size !== record.semantic.candidates.length || record.semantic.candidates.length > 10
      || record.semantic.candidates.some((id) => !rotaToolNames().includes(id))) invalid();
    if ((run.semantic.mode === 'none' || record.semantic.state === 'unavailable') && record.semantic.candidates.length
      || record.semantic.state !== 'unavailable' && !record.semantic.candidates.length) invalid();
    for (const round of record.rounds) {
      if (!['stop', 'end_turn', 'eos', 'stop_sequence', 'tool_calls', 'length', 'content_filter'].includes(round.finishReason)) throw new Error('PLANNER_COMPLETION_UNVERIFIED');
      if (!Array.isArray(round.models) || !round.models.length || round.models.some((model) => model !== run.qualification.expectedModel)) throw new Error('PLANNER_MODEL_MISMATCH');
      if (round.thinkingMode !== 'off' || round.thinking !== 0 || round.thinkingBlocks != null && round.thinkingBlocks !== 0) throw new Error('PLANNER_THINKING_UNVERIFIED');
    }
  }
}

/** Koşu kaydı güncel kıyas ve altın etiketlere ait olmalıdır; geçiş başına özet ve vaka kimliğiyle ıskalar. */
export function scorePlannerRun(run, loaded) {
  validatePlannerRun(run, loaded);
  const byId = new Map(loaded.cases.map((testCase) => [testCase.id, testCase]));
  const selected = run.cases;
  const byPass = [];
  for (let pass = 1; pass <= run.passes; pass += 1) {
    const records = new Map(run.records.filter((record) => record.pass === pass).map((record) => [record.case, record]));
    const rows = selected.map((id) => {
      const testCase = byId.get(id);
      const record = records.get(id);
      let scored;
      try { scored = record ? scoreDecision(testCase, record, { referenceDate: loaded.referenceDate }) : { correct: false, reasons: ['missing'] }; }
      catch { throw new Error('PLANNER_RUN_INVALID'); }
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
    byPass,
    gatePassed: ['run', 'live'].includes(run.semantic.mode) && run.records.every((record) => record.semantic.state !== 'unavailable') && byPass.every((pass) => pass.correct === pass.total && pass.canonical.total === CANONICAL_IDS.length
      && pass.supplementary.total === SUPPLEMENTARY_IDS.length)
  };
}

