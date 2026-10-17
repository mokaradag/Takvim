import { AI_PROFILES } from './aiModelRegistry.js';
import {
  applyRerankScores,
  createSemanticIndex,
  isSemanticCatalogue,
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
 *
 * Güven sınırı: kıyas belgesi, koşu kaydı ve planlayıcı kararları güvenilmez
 * girdidir; her biri burada BİR KEZ doğrulanıp güvenilir iç biçime çevrilir.
 * Ölçüler yalnızca bu iç biçim üzerinde hesaplanır.
 */

export const SEMANTIC_BENCHMARK_FORMAT = 'mergen-rota-semantic-benchmark';
export const SEMANTIC_RUN_FORMAT = 'mergen-rota-semantic-run';
export const SEMANTIC_RUN_VERSION = 1;

export const SEMANTIC_EXPECTATIONS = Object.freeze({ ANSWER: 'answer', CLARIFY: 'clarify', ABSTAIN: 'abstain' });
export const SEMANTIC_OUTCOMES = Object.freeze({ OK: 'ok', INVALID: 'invalid', TIMEOUT: 'timeout', FAILED: 'failed' });

export const SEMANTIC_BENCHMARK_LIMITS = Object.freeze({ maxCases: 150, maxGroups: 4, maxGroupSize: 4, maxAvoid: 6, maxTags: 6 });

export const SEMANTIC_EVALUATION_DEFAULTS = Object.freeze({ limit: 10, cutoffs: Object.freeze([1, 3, 5]), ndcgCutoff: 5, callTimeoutMs: 60000 });

const { ANSWER, CLARIFY, ABSTAIN } = SEMANTIC_EXPECTATIONS;
const { OK, INVALID, TIMEOUT, FAILED } = SEMANTIC_OUTCOMES;
const EXPECTATIONS = Object.values(SEMANTIC_EXPECTATIONS);
const OUTCOMES = Object.values(SEMANTIC_OUTCOMES);
const BENCHMARK_FIELDS = new Set(['format', 'version', 'language', 'tags', 'cases']);
const CASE_FIELDS = new Set(['id', 'text', 'expect', 'needs', 'avoid', 'tags']);
const CASE_ID = /^[a-z][a-z0-9-]{2,47}$/;
const TAG = /^[a-z][a-z0-9-]{1,31}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ISSUES = 25;
const MAX_CALL_TIMEOUT_MS = 600000;
const MAX_TAGS_DECLARED = 64;
const RUN_HALTED = 'RUN_HALTED';
const INDEX_UNAVAILABLE = 'INDEX_UNAVAILABLE';
// Model hiç çağrılmadan kaydedilen ıskalar: gecikme taşımazlar.
const UNCALLED = new Set([INDEX_UNAVAILABLE, RUN_HALTED]);
const BENCHMARKS = new WeakSet();

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * Dış dizinin yoğun, sınırlı kopyası; dizi değilse, sınırı aşıyorsa ya da
 * boşluk (forEach/map/every'nin atladığı yuva) içeriyorsa null. Her konum bir
 * kez okunur; doğrulama kopya üzerinde yapılır.
 */
function denseCopy(value, max) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > max) return null;
  const copy = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i)) return null;
    copy.push(value[i]);
  }
  return copy;
}

// Alan yoksa boş dizidir; açıkça yazılmış null ya da başka değer yokluk sayılmaz.
const optionalList = (entry, field, max) => (Object.hasOwn(entry, field) ? denseCopy(entry[field], max) : []);

function validateCase(entry, path, context) {
  const { add, ids, texts, items, tags } = context;
  if (!isRecord(entry)) {
    add(`${path}:shape`);
    return null;
  }
  const issuesBefore = context.count();
  if (Object.keys(entry).some((field) => !CASE_FIELDS.has(field))) add(`${path}:unknown-field`);
  const { id, text, expect } = entry;
  if (typeof id !== 'string' || !CASE_ID.test(id)) add(`${path}.id:invalid`);
  else if (ids.has(id)) add(`${path}.id:duplicate`);
  ids.add(id);
  // Metin kanonik biçimde saklanır: normalleştirme kıyas kümesini sessizce değiştirmez.
  const query = normalizeSemanticQuery(text);
  if (!query.ok || query.value !== text) add(`${path}.text:not-normalized`);
  else if (texts.has(text)) add(`${path}.text:duplicate`);
  texts.add(text);
  if (!EXPECTATIONS.includes(expect)) add(`${path}.expect:unknown`);
  const needs = optionalList(entry, 'needs', SEMANTIC_BENCHMARK_LIMITS.maxGroups);
  const avoid = optionalList(entry, 'avoid', SEMANTIC_BENCHMARK_LIMITS.maxAvoid);
  const caseTags = Object.hasOwn(entry, 'tags') ? denseCopy(entry.tags, SEMANTIC_BENCHMARK_LIMITS.maxTags) : null;
  const seen = new Set();
  const groups = [];
  if (!needs) add(`${path}.needs:shape`);
  else {
    needs.forEach((raw, g) => {
      const group = denseCopy(raw, SEMANTIC_BENCHMARK_LIMITS.maxGroupSize);
      if (!group || group.length === 0) {
        add(`${path}.needs[${g}]:shape`);
        return;
      }
      group.forEach((item, i) => {
        if (!items.has(item)) add(`${path}.needs[${g}][${i}]:unknown-item`);
        else if (seen.has(item)) add(`${path}.needs[${g}][${i}]:duplicate`);
        seen.add(item);
      });
      groups.push(Object.freeze(group));
    });
    if (expect === ANSWER && needs.length < 1) add(`${path}.needs:count`);
    if (expect === CLARIFY && needs.length < 2) add(`${path}.needs:count`);
    if (expect === ABSTAIN && needs.length > 0) add(`${path}.needs:count`);
  }
  if (!avoid) add(`${path}.avoid:shape`);
  else {
    if (avoid.length && expect === ABSTAIN) add(`${path}.avoid:count`);
    avoid.forEach((item, i) => {
      if (!items.has(item) || seen.has(item) || avoid.indexOf(item) !== i) add(`${path}.avoid[${i}]:invalid`);
    });
  }
  if (!caseTags || caseTags.length === 0) add(`${path}.tags:shape`);
  else caseTags.forEach((tag, i) => {
    if (!tags.has(tag) || caseTags.indexOf(tag) !== i) add(`${path}.tags[${i}]:invalid`);
  });
  // Bozuk vaka kurulmaz: doğrulanmayan değer kopyalanmaz, dondurulmaz.
  if (context.count() !== issuesBefore) return null;
  return Object.freeze({ id, text, expect, needs: Object.freeze(groups), avoid: Object.freeze(avoid), tags: Object.freeze(caseTags) });
}

function readBenchmark(document, catalogue) {
  if (!isRecord(document)) return { ok: false, issues: ['$:shape'] };
  const issues = [];
  let total = 0;
  const add = (issue) => {
    total += 1;
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  if (Object.keys(document).some((field) => !BENCHMARK_FIELDS.has(field))) add('$:unknown-field');
  const { format, version, language, tags: declaredTags, cases: rawCases } = document;
  if (format !== SEMANTIC_BENCHMARK_FORMAT) add('format:unknown');
  if (version !== 1) add('version:unsupported');
  if (language !== 'tr') add('language:unsupported');
  const declared = isRecord(declaredTags) ? Object.entries(declaredTags) : [];
  if (!declared.length || declared.length > MAX_TAGS_DECLARED
    || declared.some(([tag, label]) => !TAG.test(tag) || typeof label !== 'string' || !label.trim())) {
    add('tags:invalid');
  }
  const cases = Array.isArray(rawCases) && Number.isSafeInteger(rawCases.length) && rawCases.length > 0
    && rawCases.length <= SEMANTIC_BENCHMARK_LIMITS.maxCases ? rawCases : null;
  if (!cases) add('cases:count');
  const items = new Set(catalogue.items.map((item) => item.id));
  const context = { add, count: () => total, ids: new Set(), texts: new Set(), items, tags: new Set(declared.map(([tag]) => tag)) };
  // Seyrek dizinin boşluğu da vaka olarak denetlenir: her konum tam bir kez okunur.
  const validated = Array.from({ length: cases ? cases.length : 0 }, (_, position) => (
    validateCase(Object.hasOwn(cases, position) ? cases[position] : undefined, `cases[${position}]`, context)));
  if (issues.length) return { ok: false, issues };
  const benchmark = Object.freeze({
    fingerprint: semanticFingerprint([SEMANTIC_BENCHMARK_FORMAT, 1, language,
      validated.map(({ id, text, expect, needs, avoid, tags }) => [id, text, expect, needs, avoid, tags])]),
    catalogue: catalogue.fingerprint,
    items: Object.freeze([...items]),
    language,
    tags: Object.freeze(declared.map(([tag]) => tag)),
    cases: Object.freeze(validated)
  });
  BENCHMARKS.add(benchmark);
  return { ok: true, benchmark };
}

/**
 * Kıyas kümesini doğrular. Altın etiketler YALNIZCA `createSemanticCatalogue`
 * ile kurulmuş gerçek kataloğun öğelerine bağlıdır (taklit katalog reddedilir);
 * belge, vaka ve etiket sözlüğü kapalıdır, diziler yoğun ve sınırlıdır, metinler
 * kanonik ve tekildir. Okunamayan belge de doğrulama sonucu olarak reddedilir.
 */
export function validateSemanticBenchmark(document, catalogue) {
  if (!isSemanticCatalogue(catalogue)) throw new TypeError('SEMANTIC_CATALOGUE_REQUIRED');
  try {
    return readBenchmark(document, catalogue);
  } catch {
    return { ok: false, issues: ['$:unreadable'] };
  }
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

// Süresi dolan çağrı iptali kabul edip sonuçlanmalıdır; ek süre içinde sonuçlanmazsa arka planda sürüyor sayılır.
function settlesWithin(running, ms, signal) {
  return new Promise((resolve) => {
    const done = (settled) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(settled);
    };
    const stop = () => done(false);
    const timer = setTimeout(stop, ms);
    signal?.addEventListener('abort', stop, { once: true });
    running.then(() => done(true), () => done(true));
  });
}

/**
 * Tek model çağrısı: çağrı başına süre sınırı ve koşunun iptali birlikte
 * izlenir. İptal çağrıdan önce geldiyse model hiç çağrılmaz; sonuç ile iptal
 * yarışında iptal kazanır. Süresi dolan çağrı bir süre sınırı daha içinde
 * sonuçlanmazsa (sinyale uymayan model) `halted` döner: koşucu artık model
 * çağırmaz, terk edilen çağrı sonraki vakaları kirletemez. Hata iletisi
 * taşınmaz; yalnızca güvenli bir kod kaydedilir.
 */
async function callModel(invoke, { signal, callTimeoutMs, now }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forward, { once: true });
  // Model işlevi `AbortSignal.timeout()` ile aynı nedeni görür; ayrım nesne kimliğiyle yapılır.
  const timedOut = new DOMException('Model call timed out', 'TimeoutError');
  const timer = setTimeout(() => controller.abort(timedOut), callTimeoutMs);
  const started = now();
  let running = null;
  try {
    const value = await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      running = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return invoke(controller.signal);
      });
      running.then(resolve, reject);
    });
    signal?.throwIfAborted();
    return { outcome: OK, value, latencyMs: now() - started };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const latencyMs = now() - started;
    if (controller.signal.reason === timedOut) {
      const settled = await settlesWithin(running, callTimeoutMs, signal);
      signal?.throwIfAborted();
      return { outcome: TIMEOUT, latencyMs, halted: !settled };
    }
    return { outcome: FAILED, reason: failureCode(error), latencyMs };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

const callRecord = ({ outcome, reason, latencyMs }) => Object.freeze(reason ? { outcome, reason, latencyMs } : { outcome, latencyMs });
const missedCase = (id, reason) => Object.freeze({ case: id, embedding: Object.freeze({ outcome: FAILED, reason }), rerank: null, firstStage: null, reranked: null });

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
 * Vakalar sırayla yürür; iki model çağrısı hiçbir zaman örtüşmez. Koşunun
 * iptali hemen yayılır. Süresi dolup iptali doğrulanamayan çağrıdan sonra
 * model bir daha çağrılmaz; kalan vakalar `RUN_HALTED` ile ıska sayılır.
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
  callTimeoutMs = SEMANTIC_EVALUATION_DEFAULTS.callTimeoutMs,
  signal = null,
  now = () => performance.now()
}) {
  requireBenchmark(benchmark);
  if (!isSemanticCatalogue(catalogue) || benchmark.catalogue !== catalogue.fingerprint) throw new TypeError('SEMANTIC_CATALOGUE_MISMATCH');
  if (typeof embedding?.embed !== 'function' || embedding.space?.profile !== AI_PROFILES.EMBEDDING) throw new TypeError('SEMANTIC_EMBEDDING_REQUIRED');
  if (reranking && (typeof reranking.rerank !== 'function' || reranking.provenance?.profile !== AI_PROFILES.RERANK)) {
    throw new TypeError('SEMANTIC_RERANKING_INVALID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) throw new RangeError('SEMANTIC_LIMIT');
  if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > MAX_CALL_TIMEOUT_MS) {
    throw new RangeError('SEMANTIC_CALL_TIMEOUT');
  }
  let halted = false;
  const call = async (invoke) => {
    const result = await callModel(invoke, { signal, callTimeoutMs, now });
    if (result.halted) halted = true;
    return result;
  };
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
    if (!index) cases.push(missedCase(testCase.id, INDEX_UNAVAILABLE));
    else if (halted) cases.push(missedCase(testCase.id, RUN_HALTED));
    else cases.push(await collectCase(testCase, { index, embedding, reranking, limit, documentOf, call }));
  }
  const { profile, model, provider, preprocessing } = embedding.space;
  const reranker = reranking?.provenance;
  return Object.freeze({
    format: SEMANTIC_RUN_FORMAT,
    version: SEMANTIC_RUN_VERSION,
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

/**
 * Gecikme özeti (ms): en yakın sıra yüzdeliği. Ölçülmemiş çağrı (`null`/yok)
 * nüfusa girmez; negatif ya da sonlu olmayan ölçüm bozuk veridir ve reddedilir.
 */
export function semanticLatencySummary(values) {
  const measured = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError('SEMANTIC_LATENCY');
    measured.push(value);
  }
  const sorted = measured.sort((a, b) => a - b);
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
  for (const record of records) if (record) counts[record.outcome] += 1;
  return counts;
}

/* ── Koşu kaydının güven sınırı ─────────────────────────── */

const RUN_ERRORS = new Set(['SEMANTIC_RUN_STALE', 'SEMANTIC_RUN_INVALID']);
const runInvalid = () => new TypeError('SEMANTIC_RUN_INVALID');
const isLatency = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Sonuç türü ile gerekçe tutarlıdır: başarılı ve süresi dolan çağrı gerekçe
 * taşımaz, diğerleri güvenli kod taşır. Yapılan her çağrı ölçülmüş gecikme
 * taşır; yalnızca hiç çağrılmayan vaka ıskası (`uncalled` izinliyse) taşımaz.
 */
function readCallRecord(record, { uncalled = false } = {}) {
  if (!isRecord(record)) throw runInvalid();
  const { outcome, reason, latencyMs } = record;
  if (!OUTCOMES.includes(outcome)) throw runInvalid();
  const reasonless = outcome === OK || outcome === TIMEOUT;
  if (reasonless ? reason !== undefined : !(typeof reason === 'string' && SAFE_CODE.test(reason))) throw runInvalid();
  const called = !(uncalled && outcome === FAILED && UNCALLED.has(reason));
  if (called ? !isLatency(latencyMs) : latencyMs !== undefined) throw runInvalid();
  return Object.freeze({ outcome, reason, latencyMs });
}

// Aday listesi yoğun, tam `depth` uzunlukta, kimlikleri izinli ve tekil; skorlar sonlu ve artmayan sıradadır.
function readRanked(raw, key, depth, allowed) {
  const list = denseCopy(raw, SEMANTIC_LIMITS.maxCandidates);
  if (!list || list.length !== depth) throw runInvalid();
  const seen = new Set();
  let previous = Infinity;
  return Object.freeze(list.map((candidate) => {
    if (!isRecord(candidate)) throw runInvalid();
    const { id, [key]: score } = candidate;
    if (!allowed.has(id) || seen.has(id) || typeof score !== 'number' || !Number.isFinite(score) || score > previous
      || (key === 'similarity' && Math.abs(score) > 1)) {
      throw runInvalid();
    }
    seen.add(id);
    previous = score;
    return Object.freeze({ id, [key]: score });
  }));
}

/**
 * Vaka kaydı ile yükü tutarlı olmalıdır: başarısız gömme aday taşımaz;
 * yeniden sıralama yalnızca başarılı ilk aşamadan sonra vardır ve ilk aşamanın
 * aday kümesinin bir permütasyonudur (aday eklemez, çıkarmaz).
 */
function readEntry(raw, { depth, items, reranking }) {
  if (!isRecord(raw)) throw runInvalid();
  const { case: id, embedding, rerank, firstStage, reranked } = raw;
  const entry = { case: id, embedding: readCallRecord(embedding, { uncalled: true }), rerank: null, firstStage: null, reranked: null };
  if (entry.embedding.outcome !== OK) {
    if (firstStage != null || rerank != null || reranked != null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.firstStage = readRanked(firstStage, 'similarity', depth, items);
  if (!reranking) {
    if (rerank != null || reranked != null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.rerank = readCallRecord(rerank);
  if (entry.rerank.outcome !== OK) {
    if (reranked != null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.reranked = readRanked(reranked, 'relevance', depth, new Set(entry.firstStage.map((candidate) => candidate.id)));
  return Object.freeze(entry);
}

function readRun(run, benchmark) {
  if (!isRecord(run)) throw runInvalid();
  const { format, version, benchmark: fingerprint, catalogue, limit, reranker, index, cases } = run;
  if (format !== SEMANTIC_RUN_FORMAT || version !== SEMANTIC_RUN_VERSION || fingerprint !== benchmark.fingerprint || catalogue !== benchmark.catalogue) {
    throw new Error('SEMANTIC_RUN_STALE');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) throw runInvalid();
  if (reranker != null && !(isRecord(reranker) && reranker.profile === AI_PROFILES.RERANK)) throw runInvalid();
  const indexRecord = readCallRecord(index);
  const list = denseCopy(cases, benchmark.cases.length);
  if (!list) throw runInvalid();
  const known = new Set(benchmark.cases.map((testCase) => testCase.id));
  const context = { depth: Math.min(limit, benchmark.items.length), items: new Set(benchmark.items), reranking: reranker != null };
  const byCase = new Map();
  for (const raw of list) {
    const entry = readEntry(raw, context);
    // Kıyas kümesinde olmayan ya da yinelenen vaka satırı sessizce yok sayılmaz ya da ezilmez.
    if (!known.has(entry.case) || byCase.has(entry.case)) throw runInvalid();
    // Dizin yoksa her vaka `INDEX_UNAVAILABLE` ıskasıdır; dizin varken bu kod kullanılamaz.
    if ((indexRecord.outcome === OK) === (entry.embedding.reason === INDEX_UNAVAILABLE)) throw runInvalid();
    byCase.set(entry.case, entry);
  }
  checkHaltOrder(benchmark, byCase);
  return { limit, reranking: context.reranking, index: indexRecord, byCase };
}

const isHalted = (entry) => entry?.embedding.reason === RUN_HALTED;

/**
 * Koşucu durduktan sonra model çağırmaz: `RUN_HALTED` ıskaları kıyas sırasında
 * kesintisiz bir son dilimdir ve hemen önceki vakanın son çağrısı süresi dolan
 * çağrıdır. Duruştan sonra puanlanan vaka, sırasız ya da gerekçesiz duruş reddedilir.
 */
function checkHaltOrder(benchmark, byCase) {
  const entries = benchmark.cases.map((testCase) => byCase.get(testCase.id));
  const first = entries.findIndex(isHalted);
  if (first < 0) return;
  if (entries.slice(first).some((entry) => !isHalted(entry))) throw runInvalid();
  const previous = entries[first - 1];
  const last = previous?.rerank ?? previous?.embedding;
  if (last?.outcome !== TIMEOUT) throw runInvalid();
}

/**
 * Koşu kaydı güvenilmez girdidir: biçim, sürüm ve parmak izleri uyuşmazsa
 * `SEMANTIC_RUN_STALE`; yapı ya da sonuç–yük tutarlılığı bozuksa (okunamayan
 * değer dâhil) `SEMANTIC_RUN_INVALID`. Ölçüler yalnızca dönen iç biçimi kullanır.
 */
function trustedRun(run, benchmark) {
  try {
    return readRun(run, benchmark);
  } catch (error) {
    if (error instanceof Error && RUN_ERRORS.has(error.message)) throw error;
    throw runInvalid();
  }
}

/**
 * Koşunun ölçü özeti. Yanıt vakaları sıralama kalitesini, açıklama vakaları
 * makul yorumların sınırlı aday kümesinde bulunmasını, kapsam dışı vakalar
 * skorla ayrılabilirliği ölçer. Yeniden sıralama başarısızsa üretimdeki gibi ilk
 * aşamanın sırası geçerlidir; ayrılabilirlik ise yalnızca yeniden sıralama
 * skorunu kullanır (ölçekler karıştırılmaz), skoru olmayan vaka en kötü durumdur.
 * Kaydı olmayan ya da başarısız vaka ıska sayılır. Kesimler koşunun toplandığı
 * `limit` derinliğini aşamaz.
 */
export function summarizeSemanticRun(run, benchmark, { cutoffs: requested = SEMANTIC_EVALUATION_DEFAULTS.cutoffs, ndcgCutoff = SEMANTIC_EVALUATION_DEFAULTS.ndcgCutoff } = {}) {
  requireBenchmark(benchmark);
  const trusted = trustedRun(run, benchmark);
  const cutoffs = denseCopy(requested, SEMANTIC_LIMITS.maxCandidates);
  if (!cutoffs || !cutoffs.length || cutoffs.some((k, i) => !Number.isSafeInteger(k) || k < 1 || (i && k <= cutoffs[i - 1]))
    || !Number.isSafeInteger(ndcgCutoff) || ndcgCutoff < 1
    || cutoffs[cutoffs.length - 1] > trusted.limit || ndcgCutoff > trusted.limit) {
    throw new RangeError('SEMANTIC_CUTOFFS');
  }
  const options = { cutoffs, ndcgCutoff };
  const rows = benchmark.cases.map((testCase) => ({ testCase, entry: trusted.byCase.get(testCase.id) || null }));
  const firstIds = (entry) => (entry?.firstStage || []).map((candidate) => candidate.id);
  const embeddingStage = stageMetrics(rows, (entry) => ({
    ids: firstIds(entry), top: entry?.firstStage?.[0]?.similarity ?? null
  }), options);
  const { reranking } = trusted;
  const rerankStage = reranking ? stageMetrics(rows, (entry) => ({
    ids: entry?.reranked ? entry.reranked.map((candidate) => candidate.id) : firstIds(entry),
    top: entry?.reranked?.[0]?.relevance ?? null
  }), options) : null;
  const difference = (after, before) => (after == null || before == null ? null : after - before);
  const delta = (key) => difference(rerankStage.answer[key], embeddingStage.answer[key]);
  return {
    benchmark: benchmark.fingerprint,
    catalogue: benchmark.catalogue,
    limit: trusted.limit,
    cutoffs,
    ndcgCutoff,
    cases: {
      total: benchmark.cases.length,
      answer: rows.filter(({ testCase }) => testCase.expect === ANSWER).length,
      clarify: rows.filter(({ testCase }) => testCase.expect === CLARIFY).length,
      abstain: rows.filter(({ testCase }) => testCase.expect === ABSTAIN).length,
      missing: rows.filter(({ entry }) => !entry).length
    },
    outcomes: {
      index: trusted.index.outcome,
      embedding: outcomeCounts(rows.map(({ entry }) => entry?.embedding)),
      rerank: reranking ? outcomeCounts(rows.map(({ entry }) => entry?.rerank)) : null
    },
    stages: { embedding: embeddingStage, reranked: rerankStage },
    uplift: rerankStage
      ? { hitAt1: delta('hitAt1'), mrr: delta('mrr'), ndcg: delta('ndcg'), recall: Object.fromEntries(cutoffs.map((k) => [k, difference(rerankStage.answer.recall[k], embeddingStage.answer.recall[k])])) }
      : null,
    // Gecikme nüfusu: gerçekten yapılan çağrılar (başarısızlar dâhil); hiç çağrılmayan vaka girmez.
    latency: {
      index: trusted.index.latencyMs ?? null,
      embedding: semanticLatencySummary(rows.map(({ entry }) => entry?.embedding.latencyMs)),
      rerank: reranking ? semanticLatencySummary(rows.map(({ entry }) => entry?.rerank?.latencyMs)) : null
    }
  };
}

/* ── Planlayıcı kararları ───────────────────────────────── */

const MAX_DECISIONS = SEMANTIC_BENCHMARK_LIMITS.maxCases * 4;

/**
 * Planlayıcı kararı da güvenilmez model çıktısıdır: alanlar bir kez okunur,
 * araç listesi yoğun, sınırlı ve tekildir; çekimser karar araç adlandıramaz.
 * Okunamayan karar geçersizdir.
 */
function readDecision(decisions, position, items) {
  try {
    const raw = Object.hasOwn(decisions, position) ? decisions[position] : undefined;
    if (!isRecord(raw)) return { id: undefined, decision: null };
    const { case: id, decision, tools: rawTools } = raw;
    const tools = denseCopy(rawTools, SEMANTIC_LIMITS.maxCandidates);
    const valid = EXPECTATIONS.includes(decision) && tools !== null
      && tools.every((tool, i) => items.has(tool) && tools.indexOf(tool) === i)
      && (decision !== ABSTAIN || tools.length === 0);
    return { id, decision: valid ? Object.freeze({ decision, tools: Object.freeze(tools) }) : null };
  } catch {
    return { id: undefined, decision: null };
  }
}

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
  const count = Array.isArray(decisions) && Number.isSafeInteger(decisions.length) ? decisions.length : 0;
  // Sınırı aşan karar listesi okunmaz: her karar geçersiz, her vaka kararsız sayılır.
  let invalid = count > MAX_DECISIONS ? count : 0;
  for (let position = 0; position < count && count <= MAX_DECISIONS; position += 1) {
    const { id, decision } = readDecision(decisions, position, items);
    if (!decision || !known.has(id) || seen.has(id)) {
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
