import { AI_PROFILES } from './aiModelRegistry.js';
import {
  applyRerankScores,
  createSemanticIndex,
  normalizeSemanticQuery,
  rankSemanticIndex,
  SEMANTIC_LIMITS,
  semanticFingerprint
} from './semanticContract.js';

/**
 * Rota AI anlamsal değerlendirme sözleşmesi.
 *
 * Sentetik Türkçe kıyas kümesinin doğrulanması, sıralama ve karar ölçüleri ile
 * model sınırını çağıran sınırlı değerlendirme koşucusu. Ölçüler kesin kayan
 * nokta değerlerine değil sıralama ilişkilerine dayanır. Başarısız, geçersiz ya
 * da süresi dolan model çağrısı ölçüden ÇIKARILMAZ; ıska sayılır. Üretim kodu
 * kıyas kümesini okumaz. Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md
 */

export const SEMANTIC_BENCHMARK_FORMAT = 'mergen-rota-semantic-benchmark';
export const SEMANTIC_RUN_FORMAT = 'mergen-rota-semantic-run';

export const SEMANTIC_EXPECTATIONS = Object.freeze({ ANSWER: 'answer', CLARIFY: 'clarify', ABSTAIN: 'abstain' });
export const SEMANTIC_OUTCOMES = Object.freeze({ OK: 'ok', INVALID: 'invalid', TIMEOUT: 'timeout', FAILED: 'failed' });

export const SEMANTIC_BENCHMARK_LIMITS = Object.freeze({ maxCases: 150, maxGroups: 4, maxGroupSize: 4, maxAvoid: 6, maxTags: 6 });

export const SEMANTIC_EVALUATION_DEFAULTS = Object.freeze({ limit: 10, cutoffs: Object.freeze([1, 3, 5]), ndcgCutoff: 5 });

const { ANSWER, CLARIFY, ABSTAIN } = SEMANTIC_EXPECTATIONS;
const { OK, INVALID, TIMEOUT, FAILED } = SEMANTIC_OUTCOMES;
const EXPECTATIONS = Object.values(SEMANTIC_EXPECTATIONS);
const CASE_FIELDS = new Set(['id', 'text', 'expect', 'needs', 'avoid', 'tags']);
const CASE_ID = /^[a-z][a-z0-9-]{2,47}$/;
const TAG = /^[a-z][a-z0-9-]{1,31}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ISSUES = 25;
const MAX_CALL_TIMEOUT_MS = 600000;
const BENCHMARKS = new WeakSet();

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

function validateCase(entry, path, context) {
  const { add, ids, texts, items, tags } = context;
  if (!isRecord(entry)) {
    add(`${path}:shape`);
    return null;
  }
  if (Object.keys(entry).some((field) => !CASE_FIELDS.has(field))) add(`${path}:unknown-field`);
  if (typeof entry.id !== 'string' || !CASE_ID.test(entry.id)) add(`${path}.id:invalid`);
  else if (ids.has(entry.id)) add(`${path}.id:duplicate`);
  ids.add(entry.id);
  // Metin kanonik biçimde saklanır: normalleştirme kıyas kümesini sessizce değiştirmez.
  const query = normalizeSemanticQuery(entry.text);
  if (!query.ok || query.value !== entry.text) add(`${path}.text:not-normalized`);
  else if (texts.has(entry.text)) add(`${path}.text:duplicate`);
  texts.add(entry.text);
  if (!EXPECTATIONS.includes(entry.expect)) add(`${path}.expect:unknown`);
  const needs = entry.needs ?? [];
  const avoid = entry.avoid ?? [];
  const caseTags = entry.tags ?? [];
  const seen = new Set();
  if (!Array.isArray(needs) || needs.length > SEMANTIC_BENCHMARK_LIMITS.maxGroups) add(`${path}.needs:shape`);
  else {
    needs.forEach((group, g) => {
      if (!Array.isArray(group) || group.length === 0 || group.length > SEMANTIC_BENCHMARK_LIMITS.maxGroupSize) {
        add(`${path}.needs[${g}]:shape`);
        return;
      }
      group.forEach((item, i) => {
        if (!items.has(item)) add(`${path}.needs[${g}][${i}]:unknown-item`);
        else if (seen.has(item)) add(`${path}.needs[${g}][${i}]:duplicate`);
        seen.add(item);
      });
    });
    const groups = needs.length;
    if (entry.expect === ANSWER && groups < 1) add(`${path}.needs:count`);
    if (entry.expect === CLARIFY && groups < 2) add(`${path}.needs:count`);
    if (entry.expect === ABSTAIN && groups > 0) add(`${path}.needs:count`);
  }
  if (!Array.isArray(avoid) || avoid.length > SEMANTIC_BENCHMARK_LIMITS.maxAvoid) add(`${path}.avoid:shape`);
  else {
    if (avoid.length && entry.expect === ABSTAIN) add(`${path}.avoid:count`);
    avoid.forEach((item, i) => {
      if (!items.has(item) || seen.has(item) || avoid.indexOf(item) !== i) add(`${path}.avoid[${i}]:invalid`);
    });
  }
  if (!Array.isArray(caseTags) || caseTags.length === 0 || caseTags.length > SEMANTIC_BENCHMARK_LIMITS.maxTags) add(`${path}.tags:shape`);
  else caseTags.forEach((tag, i) => {
    if (!tags.has(tag) || caseTags.indexOf(tag) !== i) add(`${path}.tags[${i}]:invalid`);
  });
  if (!Array.isArray(needs) || !Array.isArray(avoid) || !Array.isArray(caseTags)) return null;
  return Object.freeze({
    id: entry.id,
    text: entry.text,
    expect: entry.expect,
    needs: Object.freeze(needs.map((group) => Object.freeze([...group]))),
    avoid: Object.freeze([...avoid]),
    tags: Object.freeze([...caseTags])
  });
}

/**
 * Kıyas kümesini doğrular. Altın etiketler kataloğun gerçek öğelerine bağlıdır;
 * küme ve etiket sözlüğü kapalıdır, metinler kanonik ve tekildir.
 */
export function validateSemanticBenchmark(document, catalogue) {
  if (!Array.isArray(catalogue?.items) || typeof catalogue.fingerprint !== 'string') throw new TypeError('SEMANTIC_CATALOGUE_REQUIRED');
  if (!isRecord(document)) return { ok: false, issues: ['$:shape'] };
  const issues = [];
  const add = (issue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  if (document.format !== SEMANTIC_BENCHMARK_FORMAT) add('format:unknown');
  if (document.version !== 1) add('version:unsupported');
  if (document.language !== 'tr') add('language:unsupported');
  const declared = isRecord(document.tags) ? Object.keys(document.tags) : [];
  if (!declared.length || declared.some((tag) => !TAG.test(tag) || typeof document.tags[tag] !== 'string' || !document.tags[tag].trim())) {
    add('tags:invalid');
  }
  const cases = Array.isArray(document.cases) ? document.cases : [];
  if (cases.length === 0 || cases.length > SEMANTIC_BENCHMARK_LIMITS.maxCases) add('cases:count');
  const items = new Set(catalogue.items.map((item) => item.id));
  const context = { add, ids: new Set(), texts: new Set(), items, tags: new Set(declared) };
  const validated = cases.slice(0, SEMANTIC_BENCHMARK_LIMITS.maxCases)
    .map((entry, position) => validateCase(entry, `cases[${position}]`, context));
  if (issues.length) return { ok: false, issues };
  const benchmark = Object.freeze({
    fingerprint: semanticFingerprint([SEMANTIC_BENCHMARK_FORMAT, 1, document.language,
      validated.map(({ id, text, expect, needs, avoid, tags }) => [id, text, expect, needs, avoid, tags])]),
    catalogue: catalogue.fingerprint,
    items: Object.freeze([...items]),
    language: document.language,
    tags: Object.freeze([...declared]),
    cases: Object.freeze(validated)
  });
  BENCHMARKS.add(benchmark);
  return { ok: true, benchmark };
}

function requireBenchmark(benchmark) {
  if (!BENCHMARKS.has(benchmark)) throw new TypeError('SEMANTIC_BENCHMARK_REQUIRED');
}

/* ── Model sınırı çağrısı ───────────────────────────────── */

// Hata nesnesi de güvenilmezdir: kod bir kez okunur, yalnızca güvenli biçimdeyse kaydedilir.
function failureCode(error) {
  try {
    const code = error?.code;
    return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'MODEL_CALL_FAILED';
  } catch {
    return 'MODEL_CALL_FAILED';
  }
}

/**
 * Tek model çağrısı: çağrı başına süre sınırı ve koşunun iptali birlikte
 * izlenir. Sinyale uymayan bir model işlevi de koşuyu askıda bırakamaz. Hata
 * iletisi taşınmaz; yalnızca güvenli bir kod kaydedilir.
 */
async function callModel(invoke, { signal, callTimeoutMs, now }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forward, { once: true });
  // Model işlevi `AbortSignal.timeout()` ile aynı nedeni görür; ayrım nesne kimliğiyle yapılır.
  const timedOut = new DOMException('Model call timed out', 'TimeoutError');
  const timer = callTimeoutMs == null ? null : setTimeout(() => controller.abort(timedOut), callTimeoutMs);
  const started = now();
  try {
    const value = await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      Promise.resolve().then(() => invoke(controller.signal)).then(resolve, reject);
    });
    return { outcome: OK, value, latencyMs: now() - started };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const latencyMs = now() - started;
    if (controller.signal.reason === timedOut) return { outcome: TIMEOUT, latencyMs };
    return { outcome: FAILED, reason: failureCode(error), latencyMs };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

const callRecord = ({ outcome, reason, latencyMs }) => Object.freeze(reason ? { outcome, reason, latencyMs } : { outcome, latencyMs });

async function collectCase(testCase, { index, embedding, reranking, limit, documentOf, call }) {
  const query = normalizeSemanticQuery(testCase.text).value;
  const embedded = await call((signal) => embedding.embed([query], { purpose: 'query', signal }));
  const result = { case: testCase.id, embedding: callRecord(embedded), rerank: null, firstStage: null, reranked: null };
  if (embedded.outcome !== OK) return Object.freeze(result);
  const ranked = rankSemanticIndex(index, { space: embedding.space, embeddings: embedded.value, limit });
  if (!ranked.ok) return Object.freeze({ ...result, embedding: callRecord({ ...embedded, outcome: INVALID, reason: ranked.reason }) });
  result.firstStage = Object.freeze(ranked.candidates.map(({ id, similarity }) => Object.freeze({ id, similarity })));
  if (!reranking) return Object.freeze(result);
  const documents = ranked.candidates.map((candidate) => documentOf.get(candidate.id));
  const scored = await call((signal) => reranking.rerank(query, documents, { signal }));
  result.rerank = callRecord(scored);
  if (scored.outcome !== OK) return Object.freeze(result);
  const reranked = applyRerankScores(ranked.candidates, scored.value);
  if (!reranked.ok) return Object.freeze({ ...result, rerank: callRecord({ ...scored, outcome: INVALID, reason: reranked.reason }) });
  result.reranked = Object.freeze(reranked.candidates.map(({ id, relevance }) => Object.freeze({ id, relevance })));
  return Object.freeze(result);
}

/**
 * Kıyas kümesini model sınırından geçirir: katalog bir kez gömülür, her vaka
 * için sorgu gömülür, sıralanır ve (varsa) yeniden sıralanır. Model işlevleri
 * dışarıdan verilir — CI'da belirlenimci ikizler, nitelemede gerçek modeller.
 * Vakalar sırayla yürür; koşunun iptali hemen yayılır.
 *
 * embedding: { space, embed(texts, { purpose, signal }) → [{ index, vector }] }
 * reranking: { provenance, rerank(query, documents, { signal }) → [{ index, score }] } | null
 */
export async function collectSemanticRun({
  benchmark,
  catalogue,
  embedding,
  reranking = null,
  limit = SEMANTIC_EVALUATION_DEFAULTS.limit,
  callTimeoutMs = null,
  signal = null,
  now = () => performance.now()
}) {
  requireBenchmark(benchmark);
  if (benchmark.catalogue !== catalogue?.fingerprint) throw new TypeError('SEMANTIC_CATALOGUE_MISMATCH');
  if (typeof embedding?.embed !== 'function' || embedding.space?.profile !== AI_PROFILES.EMBEDDING) throw new TypeError('SEMANTIC_EMBEDDING_REQUIRED');
  if (reranking && (typeof reranking.rerank !== 'function' || reranking.provenance?.profile !== AI_PROFILES.RERANK)) {
    throw new TypeError('SEMANTIC_RERANKING_INVALID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) throw new RangeError('SEMANTIC_LIMIT');
  if (callTimeoutMs != null && (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > MAX_CALL_TIMEOUT_MS)) {
    throw new RangeError('SEMANTIC_CALL_TIMEOUT');
  }
  const call = (invoke) => callModel(invoke, { signal, callTimeoutMs, now });
  const documents = catalogue.items.map((item) => item.text);
  const built = await call((callSignal) => embedding.embed(documents, { purpose: 'document', signal: callSignal }));
  let index = null;
  let indexRecord = callRecord(built);
  if (built.outcome === OK) {
    const created = createSemanticIndex(catalogue, embedding.space, built.value);
    if (created.ok) {
      index = created.index;
      indexRecord = Object.freeze({ outcome: OK, latencyMs: built.latencyMs, identity: index.identity, dimensions: index.dimensions });
    } else {
      indexRecord = callRecord({ ...built, outcome: INVALID, reason: created.reason });
    }
  }
  const documentOf = new Map(catalogue.items.map((item) => [item.id, item.text]));
  const cases = [];
  for (const testCase of benchmark.cases) {
    cases.push(index
      ? await collectCase(testCase, { index, embedding, reranking, limit, documentOf, call })
      : Object.freeze({ case: testCase.id, embedding: Object.freeze({ outcome: FAILED, reason: 'INDEX_UNAVAILABLE' }), rerank: null, firstStage: null, reranked: null }));
  }
  const { profile, model, provider, preprocessing } = embedding.space;
  const reranker = reranking?.provenance;
  return Object.freeze({
    format: SEMANTIC_RUN_FORMAT,
    version: 1,
    benchmark: benchmark.fingerprint,
    catalogue: catalogue.fingerprint,
    embedding: Object.freeze({ profile, model, provider, preprocessing }),
    reranker: reranker ? Object.freeze({ profile: reranker.profile, model: reranker.model, provider: reranker.provider }) : null,
    limit,
    index: indexRecord,
    cases: Object.freeze(cases)
  });
}

/* ── Ölçüler ────────────────────────────────────────────── */

/**
 * Vaka ölçüleri. Her ihtiyaç grubu (birbirinin yerine geçebilen yetenekler) bir
 * kez sayılır: Recall@K kapsanan grup oranı, kapsama@K bütün grupların ilk K
 * içinde olması, NDCG@K grup başına tek kazanç, MRR ilk ilgili adayın sırası.
 */
function rankingMetrics(ids, testCase, cutoffs, ndcgCutoff) {
  const groupOf = new Map();
  testCase.needs.forEach((group, position) => group.forEach((id) => groupOf.set(id, position)));
  const firstRanks = new Map();
  ids.forEach((id, position) => {
    const group = groupOf.get(id);
    if (group !== undefined && !firstRanks.has(group)) firstRanks.set(group, position + 1);
  });
  const ranks = [...firstRanks.values()];
  const groups = testCase.needs.length;
  const best = ranks.length ? Math.min(...ranks) : Infinity;
  const covered = (k) => ranks.filter((rank) => rank <= k).length;
  let ideal = 0;
  for (let rank = 1; rank <= Math.min(groups, ndcgCutoff); rank += 1) ideal += 1 / Math.log2(rank + 1);
  const gain = ranks.filter((rank) => rank <= ndcgCutoff).reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const rankOf = (id) => {
    const at = ids.indexOf(id);
    return at < 0 ? Infinity : at + 1;
  };
  return {
    hitAt1: best === 1 ? 1 : 0,
    reciprocalRank: Number.isFinite(best) ? 1 / best : 0,
    recall: Object.fromEntries(cutoffs.map((k) => [k, covered(k) / groups])),
    coverage: Object.fromEntries(cutoffs.map((k) => [k, covered(k) === groups ? 1 : 0])),
    ndcg: gain / ideal,
    avoidHeld: testCase.avoid.filter((id) => best < rankOf(id)).length
  };
}

function aggregate(perCase, cutoffs) {
  const pairs = perCase.reduce((sum, { testCase }) => sum + testCase.avoid.length, 0);
  const held = perCase.reduce((sum, { metrics }) => sum + metrics.avoidHeld, 0);
  return {
    cases: perCase.length,
    hitAt1: mean(perCase.map(({ metrics }) => metrics.hitAt1)),
    mrr: mean(perCase.map(({ metrics }) => metrics.reciprocalRank)),
    recall: Object.fromEntries(cutoffs.map((k) => [k, mean(perCase.map(({ metrics }) => metrics.recall[k]))])),
    coverage: Object.fromEntries(cutoffs.map((k) => [k, mean(perCase.map(({ metrics }) => metrics.coverage[k]))])),
    ndcg: mean(perCase.map(({ metrics }) => metrics.ndcg)),
    avoid: { pairs, held, rate: pairs ? held / pairs : null }
  };
}

/** Kapsam içi (yanıt + açıklama) ve kapsam dışı vakaların en yüksek skorla ayrılabilirliği (AUROC, eşitlik ½). */
function separability(inScope, outOfScope) {
  if (!inScope.length || !outOfScope.length) return null;
  let wins = 0;
  for (const a of inScope) for (const b of outOfScope) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (inScope.length * outOfScope.length);
}

/** Gecikme özeti (ms): en yakın sıra yüzdeliği; sayı olmayan değerler yok sayılır. */
export function semanticLatencySummary(values) {
  const sorted = (Array.isArray(values) ? values : []).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function stageMetrics(rows, select, options) {
  const { cutoffs, ndcgCutoff } = options;
  const answers = [];
  const clarifyCoverage = [];
  const inScope = [];
  const outOfScope = [];
  const tagged = new Map();
  for (const { testCase, entry } of rows) {
    const { ids, top } = select(entry);
    // Skoru olmayan (başarısız) vaka ayrılabilirlikten düşmez; en kötü durum sayılır.
    if (testCase.expect === ABSTAIN) {
      outOfScope.push(top ?? Infinity);
      continue;
    }
    inScope.push(top ?? -Infinity);
    const metrics = rankingMetrics(ids, testCase, cutoffs, ndcgCutoff);
    if (testCase.expect === CLARIFY) {
      clarifyCoverage.push(metrics.coverage[cutoffs[cutoffs.length - 1]]);
      continue;
    }
    answers.push({ testCase, metrics, ids });
    for (const tag of testCase.tags) tagged.set(tag, [...(tagged.get(tag) || []), metrics]);
  }
  return {
    answer: aggregate(answers, cutoffs),
    clarifyCoverage: { cutoff: cutoffs[cutoffs.length - 1], cases: clarifyCoverage.length, rate: mean(clarifyCoverage) },
    abstainSeparability: separability(inScope, outOfScope),
    byTag: Object.fromEntries([...tagged].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, list]) => [tag, {
      cases: list.length,
      hitAt1: mean(list.map((metrics) => metrics.hitAt1)),
      mrr: mean(list.map((metrics) => metrics.reciprocalRank))
    }])),
    misses: answers.filter(({ metrics }) => metrics.hitAt1 === 0).map(({ testCase, ids }) => ({ case: testCase.id, top: ids.slice(0, 3) }))
  };
}

function outcomeCounts(records) {
  const counts = { [OK]: 0, [INVALID]: 0, [TIMEOUT]: 0, [FAILED]: 0 };
  for (const record of records) if (record && Object.hasOwn(counts, record.outcome)) counts[record.outcome] += 1;
  return counts;
}

/**
 * Koşunun ölçü özeti. Yanıt vakaları sıralama kalitesini, açıklama vakaları
 * makul yorumların sınırlı aday kümesinde bulunmasını, kapsam dışı vakalar
 * skorla ayrılabilirliği ölçer. Yeniden sıralama başarısızsa üretimdeki gibi ilk
 * aşamanın sırası geçerlidir; kaydı olmayan ya da başarısız vaka ıska sayılır.
 */
export function summarizeSemanticRun(run, benchmark, { cutoffs = SEMANTIC_EVALUATION_DEFAULTS.cutoffs, ndcgCutoff = SEMANTIC_EVALUATION_DEFAULTS.ndcgCutoff } = {}) {
  requireBenchmark(benchmark);
  if (run?.format !== SEMANTIC_RUN_FORMAT || run.benchmark !== benchmark.fingerprint || run.catalogue !== benchmark.catalogue) {
    throw new Error('SEMANTIC_RUN_STALE');
  }
  if (!Array.isArray(cutoffs) || !cutoffs.length || cutoffs.some((k, i) => !Number.isSafeInteger(k) || k < 1 || (i && k <= cutoffs[i - 1]))
    || !Number.isSafeInteger(ndcgCutoff) || ndcgCutoff < 1) {
    throw new RangeError('SEMANTIC_CUTOFFS');
  }
  const options = { cutoffs, ndcgCutoff };
  const byCase = new Map((Array.isArray(run.cases) ? run.cases : []).map((entry) => [entry?.case, entry]));
  const rows = benchmark.cases.map((testCase) => ({ testCase, entry: byCase.get(testCase.id) || null }));
  const firstIds = (entry) => (entry?.firstStage || []).map((candidate) => candidate.id);
  const embeddingStage = stageMetrics(rows, (entry) => ({
    ids: firstIds(entry), top: entry?.firstStage?.[0]?.similarity ?? null
  }), options);
  const reranked = Boolean(run.reranker);
  const rerankStage = reranked ? stageMetrics(rows, (entry) => ({
    ids: entry?.reranked ? entry.reranked.map((candidate) => candidate.id) : firstIds(entry),
    top: entry?.reranked?.[0]?.relevance ?? null
  }), options) : null;
  const difference = (after, before) => (after == null || before == null ? null : after - before);
  const delta = (key) => difference(rerankStage.answer[key], embeddingStage.answer[key]);
  return {
    benchmark: benchmark.fingerprint,
    cases: {
      total: benchmark.cases.length,
      answer: rows.filter(({ testCase }) => testCase.expect === ANSWER).length,
      clarify: rows.filter(({ testCase }) => testCase.expect === CLARIFY).length,
      abstain: rows.filter(({ testCase }) => testCase.expect === ABSTAIN).length,
      missing: rows.filter(({ entry }) => !entry).length
    },
    outcomes: {
      index: run.index?.outcome ?? null,
      embedding: outcomeCounts(rows.map(({ entry }) => entry?.embedding)),
      rerank: reranked ? outcomeCounts(rows.map(({ entry }) => entry?.rerank)) : null
    },
    stages: { embedding: embeddingStage, reranked: rerankStage },
    uplift: rerankStage
      ? { hitAt1: delta('hitAt1'), mrr: delta('mrr'), ndcg: delta('ndcg'), recall: Object.fromEntries(cutoffs.map((k) => [k, difference(rerankStage.answer.recall[k], embeddingStage.answer.recall[k])])) }
      : null,
    latency: {
      index: run.index?.latencyMs ?? null,
      embedding: semanticLatencySummary(rows.map(({ entry }) => entry?.embedding?.latencyMs)),
      rerank: reranked ? semanticLatencySummary(rows.map(({ entry }) => entry?.rerank?.latencyMs)) : null
    }
  };
}

/* ── Planlayıcı kararları ───────────────────────────────── */

/**
 * Planlayıcı kararlarının ölçüsü: `[{ case, decision: answer|clarify|abstain, tools: [] }]`.
 * Açıklama doğruluğu `recall.clarify`, desteklenmeyen istekte çekimserlik
 * `recall.abstain` değeridir. Eksik, yinelenen ya da geçersiz karar hata sayılır.
 */
export function evaluateSemanticDecisions(benchmark, decisions) {
  requireBenchmark(benchmark);
  const known = new Set(benchmark.cases.map((testCase) => testCase.id));
  const items = new Set(benchmark.items);
  const seen = new Map();
  let invalid = 0;
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const id = decision?.case;
    const valid = isRecord(decision) && known.has(id) && EXPECTATIONS.includes(decision.decision)
      && Array.isArray(decision.tools) && decision.tools.length <= SEMANTIC_LIMITS.maxCandidates
      && decision.tools.every((tool, i) => items.has(tool) && decision.tools.indexOf(tool) === i);
    if (!valid || seen.has(id)) {
      invalid += 1;
      if (known.has(id)) seen.set(id, null);
      continue;
    }
    seen.set(id, decision);
  }
  const confusion = Object.fromEntries(EXPECTATIONS.map((kind) => [kind, { [ANSWER]: 0, [CLARIFY]: 0, [ABSTAIN]: 0, none: 0 }]));
  let covered = 0;
  let avoidViolations = 0;
  for (const testCase of benchmark.cases) {
    const decision = seen.get(testCase.id) || null;
    confusion[testCase.expect][decision ? decision.decision : 'none'] += 1;
    if (!decision) continue;
    if (decision.tools.some((tool) => testCase.avoid.includes(tool))) avoidViolations += 1;
    if (testCase.expect === ANSWER && decision.decision === ANSWER
      && testCase.needs.every((group) => group.some((tool) => decision.tools.includes(tool)))) covered += 1;
  }
  const totals = Object.fromEntries(EXPECTATIONS.map((kind) => [kind, benchmark.cases.filter((testCase) => testCase.expect === kind).length]));
  const correct = EXPECTATIONS.reduce((sum, kind) => sum + confusion[kind][kind], 0);
  return {
    cases: benchmark.cases.length,
    missing: benchmark.cases.filter((testCase) => !seen.has(testCase.id)).length,
    invalid,
    accuracy: correct / benchmark.cases.length,
    recall: Object.fromEntries(EXPECTATIONS.map((kind) => [kind, totals[kind] ? confusion[kind][kind] / totals[kind] : null])),
    confusion,
    toolCoverage: totals[ANSWER] ? covered / totals[ANSWER] : null,
    avoidViolations
  };
}
