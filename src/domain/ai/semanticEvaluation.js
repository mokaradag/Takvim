import { AI_CAPABILITIES, AI_PROFILES } from './aiModelRegistry.js';
import {
  applyRerankScores,
  createEmbeddingSpace,
  createSemanticIndex,
  isSemanticCatalogue,
  normalizeSemanticQuery,
  rankSemanticIndex,
  SEMANTIC_LIMITS,
  semanticFingerprint,
  semanticIndexIdentity,
  semanticModelProvenance
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
/**
 * Çağrı başına süre sınırının üst değeri: üretim ağ geçidinden geçen bir
 * çağrının en uzun meşru yaşam döngüsünü (rehber denetimi 5 s + sıra ≤ 120 s +
 * rota süre sınırı ≤ 600 s) ve sonuçlanma payını kapsar.
 */
export const SEMANTIC_MAX_CALL_TIMEOUT_MS = 900000;
const MAX_CALL_TIMEOUT_MS = SEMANTIC_MAX_CALL_TIMEOUT_MS;
const MAX_TAGS_DECLARED = 64;
const RUN_HALTED = 'RUN_HALTED';
const INDEX_UNAVAILABLE = 'INDEX_UNAVAILABLE';
// Model hiç çağrılmadan kaydedilen ıskalar: gecikme taşımazlar.
const UNCALLED = new Set([INDEX_UNAVAILABLE, RUN_HALTED]);
const BENCHMARKS = new WeakSet();

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * Güvenilmez dizinin uzunluğu: tam bir kez okunur ve yakalanan değer negatif
 * olmayan, sınırlı güvenli tam sayı olmalıdır; değilse null. Kopyalama bu
 * değerle yapılır, uzunluk bir daha okunmaz.
 */
function snapshotLength(value, max) {
  if (!Array.isArray(value)) return null;
  const { length } = value;
  return Number.isSafeInteger(length) && length >= 0 && length <= max ? length : null;
}

/**
 * Dış dizinin yoğun, sınırlı kopyası; dizi değilse, sınırı aşıyorsa ya da
 * boşluk (forEach/map/every'nin atladığı yuva) içeriyorsa null. Her konum bir
 * kez okunur; doğrulama kopya üzerinde yapılır.
 */
function denseCopy(value, max) {
  const length = snapshotLength(value, max);
  if (length === null) return null;
  const copy = [];
  for (let i = 0; i < length; i += 1) {
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
  const count = snapshotLength(rawCases, SEMANTIC_BENCHMARK_LIMITS.maxCases);
  if (!count) add('cases:count');
  const items = new Set(catalogue.items.map((item) => item.id));
  const context = { add, count: () => total, ids: new Set(), texts: new Set(), items, tags: new Set(declared.map(([tag]) => tag)) };
  // Seyrek dizinin boşluğu da vaka olarak denetlenir: her konum tam bir kez okunur.
  const validated = Array.from({ length: count || 0 }, (_, position) => (
    validateCase(Object.hasOwn(rawCases, position) ? rawCases[position] : undefined, `cases[${position}]`, context)));
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

// Hata nesnesi de güvenilmezdir: kod bir kez okunur, yalnızca güvenli biçimdeyse kaydedilir; ayrılmış (çağrılmadı) kodlar kullanılamaz.
function failureCode(error) {
  try {
    const code = error?.code;
    return typeof code === 'string' && SAFE_CODE.test(code) && !UNCALLED.has(code) ? code : 'MODEL_CALL_FAILED';
  } catch {
    return 'MODEL_CALL_FAILED';
  }
}

/**
 * Model işlevi kendi süre sınırının dolduğunu standart `TimeoutError` adıyla
 * bildirebilir (ör. ağ geçidinin `AI_TIMEOUT` sonucu): çağrı sonuçlanmıştır ve
 * süre aşımıdır, genel hata değildir. Ad bir kez okunur; okunamazsa hata sayılır.
 */
function reportsTimeout(error) {
  try {
    return error?.name === 'TimeoutError';
  } catch {
    return false;
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
 *
 * Model sınırı eşzamansızdır: süre sınırı ve iptal Promise döndüren çağrıyı
 * sınırlar. Olay döngüsünü bloke eden eşzamanlı iş zamanlayıcıyla kesilemez;
 * bunu süreç yalıtımı çözer ve Aşama 4A'nın kapsamında değildir.
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
    if (reportsTimeout(error)) return { outcome: TIMEOUT, latencyMs, halted: false };
    return { outcome: FAILED, reason: failureCode(error), latencyMs };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

// Süresi dolan çağrının kaydı koşucunun duruş kararını da taşır: koşu kaydı duruşu bu alanla doğrular.
function callRecord({ outcome, reason, latencyMs, halted }) {
  if (outcome === TIMEOUT) return Object.freeze({ outcome, latencyMs, halted });
  return Object.freeze(reason ? { outcome, reason, latencyMs } : { outcome, latencyMs });
}
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
  // Kayda yazılan yeniden sıralama kökeni, koşu kaydını okuyanın kabul ettiği köken biçimindedir.
  const reranker = reranking ? rerankerProvenance(reranking.provenance) : null;
  if (reranking && (typeof reranking.rerank !== 'function' || !reranker)) throw new TypeError('SEMANTIC_RERANKING_INVALID');
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
  return Object.freeze({
    format: SEMANTIC_RUN_FORMAT,
    version: SEMANTIC_RUN_VERSION,
    benchmark: benchmark.fingerprint,
    catalogue: catalogue.fingerprint,
    embedding: Object.freeze({ profile, model, provider, preprocessing }),
    reranker,
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

// Bayat koşu iç işaretle ayrılır: güvenilmez erişimcinin fırlattığı aynı iletili hata bayat sayılmaz.
const STALE_RUN = Symbol('SEMANTIC_RUN_STALE');
const runInvalid = () => new TypeError('SEMANTIC_RUN_INVALID');
const isLatency = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hasExactFields = (record, fields) => {
  const keys = Object.keys(record);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
};

// Koşucunun yazdığı biçimler kapalıdır: her kaydın alan kümesi durumuna göre tektir.
const RUN_FIELDS = ['format', 'version', 'benchmark', 'catalogue', 'embedding', 'reranker', 'limit', 'index', 'cases'];
const ENTRY_FIELDS = ['case', 'embedding', 'rerank', 'firstStage', 'reranked'];
const CALL_FIELDS = Object.freeze({
  [OK]: ['outcome', 'latencyMs'],
  [INVALID]: ['outcome', 'reason', 'latencyMs'],
  [FAILED]: ['outcome', 'reason', 'latencyMs'],
  [TIMEOUT]: ['outcome', 'latencyMs', 'halted']
});
const INDEX_FIELDS = ['outcome', 'latencyMs', 'identity', 'dimensions'];
const UNCALLED_FIELDS = ['outcome', 'reason'];

function rerankerProvenance(value) {
  if (!isRecord(value)) return null;
  const { profile, model, provider } = value;
  return semanticModelProvenance({ profile, model, provider, capabilities: [AI_CAPABILITIES.RERANK] }, AI_PROFILES.RERANK);
}

/**
 * Yapılan çağrının kaydı. Alan kümesi sonuç türüne göre kapalıdır: başarılı ve
 * süresi dolan çağrı gerekçe taşımaz, diğerleri güvenli kod taşır ve ayrılmış
 * (çağrılmadı) kodları kullanamaz. Her çağrı ölçülmüş gecikme, süresi dolan
 * çağrı koşucunun duruş kararını (`halted`) taşır. Başarılı dizin kaydının
 * kimliği kayıttaki gömme uzayına ve boyuta bağlıdır.
 */
function readCall(record, index = null) {
  if (!isRecord(record)) throw runInvalid();
  const { outcome, reason, latencyMs, halted, identity, dimensions } = record;
  if (!OUTCOMES.includes(outcome) || !hasExactFields(record, index && outcome === OK ? INDEX_FIELDS : CALL_FIELDS[outcome])
    || !isLatency(latencyMs)) {
    throw runInvalid();
  }
  if (outcome === INVALID || outcome === FAILED) {
    if (typeof reason !== 'string' || !SAFE_CODE.test(reason) || UNCALLED.has(reason)) throw runInvalid();
    return Object.freeze({ outcome, reason, latencyMs });
  }
  if (outcome === TIMEOUT) {
    if (typeof halted !== 'boolean') throw runInvalid();
    return Object.freeze({ outcome, latencyMs, halted });
  }
  if (!index) return Object.freeze({ outcome, latencyMs });
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > SEMANTIC_LIMITS.maxDimensions
    || identity !== semanticIndexIdentity(index.catalogue, index.space.key, dimensions)) {
    throw runInvalid();
  }
  return Object.freeze({ outcome, latencyMs, identity, dimensions });
}

// Hiç çağrılmayan vaka yalnızca koşucunun ürettiği biçimdedir: `failed`, ayrılmış kod; gecikme ve yük yok.
const isUncalled = (record, reason) => isRecord(record) && hasExactFields(record, UNCALLED_FIELDS)
  && record.outcome === FAILED && record.reason === reason;

/**
 * Aday listesi yoğun, tam `depth` uzunlukta, kimlikleri izinli ve tekil;
 * skorlar sonlu ve artmayan sıradadır. Eşit skorda koşucunun belirlenimci
 * sırası korunur (`order`: ilk aşamada katalog, yeniden sıralamada ilk aşama
 * sırası); eşitleri yer değiştirerek ölçüyü değiştiren kayıt reddedilir.
 */
function readRanked(raw, key, depth, order) {
  const list = denseCopy(raw, SEMANTIC_LIMITS.maxCandidates);
  if (!list || list.length !== depth) throw runInvalid();
  const seen = new Set();
  let previous = null;
  return Object.freeze(list.map((candidate) => {
    if (!isRecord(candidate) || !hasExactFields(candidate, ['id', key])) throw runInvalid();
    const { id, [key]: score } = candidate;
    if (!order.has(id) || seen.has(id) || typeof score !== 'number' || !Number.isFinite(score)
      || (key === 'similarity' && Math.abs(score) > 1)) {
      throw runInvalid();
    }
    if (previous && (score > previous.score || (score === previous.score && order.get(id) < order.get(previous.id)))) throw runInvalid();
    seen.add(id);
    previous = { id, score };
    return Object.freeze({ id, [key]: score });
  }));
}

/**
 * Vaka kaydı koşucunun üretebileceği bir durumdur. Dizin yoksa vaka yalnızca
 * `INDEX_UNAVAILABLE` ıskasıdır; dizin varken çağrılmayan vaka yalnızca
 * `RUN_HALTED` ıskasıdır. Başarısız gömme aday taşımaz; yeniden sıralama
 * yalnızca başarılı ilk aşamadan sonra vardır ve ilk aşamanın aday kümesinin
 * bir permütasyonudur (aday eklemez, çıkarmaz).
 */
function readEntry(raw, { depth, catalogueOrder, reranking, indexed }) {
  if (!isRecord(raw) || !hasExactFields(raw, ENTRY_FIELDS)) throw runInvalid();
  const { case: id, embedding, rerank, firstStage, reranked } = raw;
  const entry = { case: id, embedding: null, rerank: null, firstStage: null, reranked: null };
  const uncalled = indexed ? RUN_HALTED : INDEX_UNAVAILABLE;
  if (isUncalled(embedding, uncalled)) {
    if (rerank !== null || firstStage !== null || reranked !== null) throw runInvalid();
    entry.embedding = Object.freeze({ outcome: FAILED, reason: uncalled });
    return Object.freeze(entry);
  }
  if (!indexed) throw runInvalid();
  entry.embedding = readCall(embedding);
  if (entry.embedding.outcome !== OK) {
    if (firstStage !== null || rerank !== null || reranked !== null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.firstStage = readRanked(firstStage, 'similarity', depth, catalogueOrder);
  if (!reranking) {
    if (rerank !== null || reranked !== null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.rerank = readCall(rerank);
  if (entry.rerank.outcome !== OK) {
    if (reranked !== null) throw runInvalid();
    return Object.freeze(entry);
  }
  entry.reranked = readRanked(reranked, 'relevance', depth, new Map(entry.firstStage.map((candidate, position) => [candidate.id, position])));
  return Object.freeze(entry);
}

// Kayıttaki gömme kökeni koşucunun yazdığı kapalı künyedir; dizin kimliği bu uzaya bağlanır.
function readSpace(embedding) {
  if (!isRecord(embedding) || !hasExactFields(embedding, ['profile', 'model', 'provider', 'preprocessing'])) throw runInvalid();
  const { profile, model, provider, preprocessing } = embedding;
  const space = profile === AI_PROFILES.EMBEDDING ? createEmbeddingSpace({ profile, model, provider }, preprocessing) : null;
  if (!space) throw runInvalid();
  return space;
}

function readRun(run, benchmark) {
  if (!isRecord(run)) throw runInvalid();
  const { format, version, benchmark: fingerprint, catalogue, embedding, limit, reranker: rawReranker, index, cases } = run;
  if (format !== SEMANTIC_RUN_FORMAT || version !== SEMANTIC_RUN_VERSION || fingerprint !== benchmark.fingerprint || catalogue !== benchmark.catalogue) {
    throw STALE_RUN;
  }
  if (!hasExactFields(run, RUN_FIELDS)) throw runInvalid();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) throw runInvalid();
  const space = readSpace(embedding);
  const reranker = rawReranker === null ? null : rerankerProvenance(rawReranker);
  if (rawReranker !== null && (!reranker || !hasExactFields(rawReranker, ['profile', 'model', 'provider']))) throw runInvalid();
  const indexRecord = readCall(index, { catalogue: benchmark.catalogue, space });
  const list = denseCopy(cases, benchmark.cases.length);
  if (!list) throw runInvalid();
  const positionOf = new Map(benchmark.cases.map((testCase, position) => [testCase.id, position]));
  const context = {
    depth: Math.min(limit, benchmark.items.length),
    catalogueOrder: new Map(benchmark.items.map((id, position) => [id, position])),
    reranking: reranker !== null,
    indexed: indexRecord.outcome === OK
  };
  const byCase = new Map();
  let previous = -1;
  for (const raw of list) {
    const entry = readEntry(raw, context);
    // Satırlar koşucunun yazdığı kıyas kümesi sırasındadır: yabancı, yinelenen ya da geri giden vaka reddedilir; atlanan vaka kısmi koşunun ıskasıdır.
    const position = positionOf.get(entry.case);
    if (!(position > previous)) throw runInvalid();
    previous = position;
    byCase.set(entry.case, entry);
  }
  checkHalt(benchmark, byCase);
  return { limit, space, reranker, reranking: context.reranking, index: indexRecord, byCase };
}

/**
 * Duruş durum makinesi: koşucu yalnızca süresi dolup ek sürede de
 * sonuçlanmayan çağrıdan (`halted: true`) sonra durur. Böyle çağrı en çok bir
 * kez vardır; ondan önceki kayıtlı vakalar `RUN_HALTED` taşıyamaz, sonraki
 * kayıtlı vakaların hepsi `RUN_HALTED` ıskasıdır. Kaydı olmayan vaka her
 * konumda ıskadır (kısmi koşu); kaydı olan vaka duruşla çelişemez.
 */
function checkHalt(benchmark, byCase) {
  let halted = false;
  for (const testCase of benchmark.cases) {
    const entry = byCase.get(testCase.id);
    if (!entry) continue;
    const marker = entry.embedding.reason === RUN_HALTED;
    if (marker !== halted) throw runInvalid();
    if (!marker && (entry.rerank ?? entry.embedding).halted === true) halted = true;
  }
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
    if (error === STALE_RUN) throw new Error('SEMANTIC_RUN_STALE');
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
  const delta = (pick) => difference(pick(rerankStage), pick(embeddingStage));
  const byCutoff = (pick) => Object.fromEntries(cutoffs.map((k) => [k, delta((stage) => pick(stage)[k])]));
  const { profile, model, provider, preprocessing } = trusted.space;
  return {
    benchmark: benchmark.fingerprint,
    catalogue: benchmark.catalogue,
    // Doğrulanmış köken: sıralamaları üreten gömme uzayı, dizin kimliği ve yeniden sıralayıcı.
    provenance: {
      embedding: { profile, model, provider, preprocessing },
      index: trusted.index.outcome === OK ? { identity: trusted.index.identity, dimensions: trusted.index.dimensions } : null,
      reranker: trusted.reranker
    },
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
    // Yeniden sıralama katkısı her aşama ölçüsü için aynı tanımdır: yeniden sıralama sonrası − ilk aşama.
    uplift: rerankStage ? {
      hitAt1: delta((stage) => stage.answer.hitAt1),
      mrr: delta((stage) => stage.answer.mrr),
      ndcg: delta((stage) => stage.answer.ndcg),
      recall: byCutoff((stage) => stage.answer.recall),
      coverage: byCutoff((stage) => stage.answer.coverage),
      avoid: delta((stage) => stage.answer.avoid.rate),
      clarifyCoverage: delta((stage) => stage.clarifyCoverage.rate),
      abstainSeparability: delta((stage) => stage.abstainSeparability)
    } : null,
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
 * Okunamayan karar geçersizdir; okunabilen vaka kimliği korunur, böylece
 * aynı vakanın sonraki kararı da yinelenen sayılır.
 */
function readDecision(decisions, position, items) {
  let id;
  try {
    const raw = Object.hasOwn(decisions, position) ? decisions[position] : undefined;
    if (!isRecord(raw)) return { id, decision: null };
    id = raw.case;
    const decision = raw.decision;
    const tools = denseCopy(raw.tools, SEMANTIC_LIMITS.maxCandidates);
    const valid = EXPECTATIONS.includes(decision) && tools !== null
      && tools.every((tool, i) => items.has(tool) && tools.indexOf(tool) === i)
      && (decision !== ABSTAIN || tools.length === 0);
    return { id, decision: valid ? Object.freeze({ decision, tools: Object.freeze(tools) }) : null };
  } catch {
    return { id, decision: null };
  }
}

// Karar listesinin uzunluğu bir kez okunur; dizi olmayan ya da okunamayan liste null'dır.
function decisionCount(decisions) {
  try {
    const length = Array.isArray(decisions) ? decisions.length : null;
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
  } catch {
    return null;
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
  const count = decisionCount(decisions);
  // Okunamayan liste tek geçersiz çıktıdır; sınırı aşan liste okunmaz, her kararı geçersizdir. İki durumda da her vaka kararsızdır.
  let invalid = count === null ? 1 : count > MAX_DECISIONS ? count : 0;
  for (let position = 0; count !== null && count <= MAX_DECISIONS && position < count; position += 1) {
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
