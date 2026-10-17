/**
 * Yapay zekâ · anlamsal değerlendirme.
 *
 * Sentetik Türkçe kıyas kümesinin yapısı ve sızıntısızlığı, üretim kodunun
 * kıyas kümesinden bağımsızlığı, elle hesaplanan senaryoyla ölçülerin
 * doğruluğu, tam küme üzerinde kâhin ikizle uçtan uca koşu, model hatalarının
 * ıska sayılması, süre aşımı ve iptal, planlayıcı karar ölçüleri. Gerçek model
 * yoktur; bütün sınamalar çevrimdışı ve belirlenimcidir. Kâhin ikiz altın
 * etiketleri yalnızca değerlendiricinin kendisini sınamak için okur.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEmbeddingDouble, createRerankDouble, oneHot } from './helpers/semanticModelDoubles.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const {
  createEmbeddingSpace,
  createSemanticCatalogue,
  semanticModelProvenance,
  semanticToolDefinitions
} = await import('../src/domain/ai/semanticContract.js');
const {
  SEMANTIC_BENCHMARK_FORMAT,
  SEMANTIC_BENCHMARK_LIMITS,
  SEMANTIC_EVALUATION_DEFAULTS,
  SEMANTIC_EXPECTATIONS,
  collectSemanticRun,
  evaluateSemanticDecisions,
  summarizeSemanticRun,
  validateSemanticBenchmark
} = await import('../src/domain/ai/semanticEvaluation.js');
const { AI_PROFILES } = await import('../src/domain/ai/aiModelRegistry.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_FILE = 'test/fixtures/ai-semantic-benchmark.json';
const officialDocument = JSON.parse(fs.readFileSync(path.join(ROOT, BENCHMARK_FILE), 'utf8'));

const route = (profile, capability) => ({ profile, model: `ikiz-${profile}`, provider: 'test', capabilities: [capability] });
const space = createEmbeddingSpace(semanticModelProvenance(route(AI_PROFILES.EMBEDDING, 'embedding'), AI_PROFILES.EMBEDDING), 'none');
const rerankProvenance = semanticModelProvenance(route(AI_PROFILES.RERANK, 'rerank'), AI_PROFILES.RERANK);

function toolCatalogue() {
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  assert.equal(built.ok, true);
  return built.catalogue;
}

function official() {
  const catalogue = toolCatalogue();
  const validated = validateSemanticBenchmark(officialDocument, catalogue);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  return { catalogue, benchmark: validated.benchmark };
}

/* ── Elle hesaplanan küçük senaryo ───────────────────────── */

const TOY = ['a', 'b', 'c', 'd'];
const toyCatalogue = createSemanticCatalogue(TOY.map((id) => ({ id, kind: 'tool', version: 1, text: `Belge ${id}` }))).catalogue;
const TOY_CASES = [
  { id: 'toy-001', text: 'Birinci soru', expect: 'answer', needs: [['b']], avoid: ['d'], tags: ['ornek'] },
  { id: 'toy-002', text: 'İkinci soru', expect: 'answer', needs: [['c'], ['d']], tags: ['ornek', 'diger'] },
  { id: 'toy-003', text: 'Üçüncü soru', expect: 'clarify', needs: [['a'], ['b']], tags: ['diger'] },
  { id: 'toy-004', text: 'Dördüncü soru', expect: 'abstain', tags: ['diger'] }
];
const toyDocument = (cases = TOY_CASES, overrides = {}) => ({
  format: SEMANTIC_BENCHMARK_FORMAT, version: 1, language: 'tr', tags: { ornek: 'Örnek', diger: 'Diğer' }, cases, ...overrides
});
const toyBenchmark = validateSemanticBenchmark(toyDocument(), toyCatalogue).benchmark;
// Sorgu vektörleri sıralamayı belirler: [a,b,c,d], [c,d,b,a], [d,a,b,c] (b/c eşit) ve tekdüze.
const TOY_QUERIES = new Map([
  ['Birinci soru', [0.9, 0.5, 0.1, 0]],
  ['İkinci soru', [0, 0.1, 0.9, 0.5]],
  ['Üçüncü soru', [0.6, 0, 0, 0.8]],
  ['Dördüncü soru', [0.25, 0.25, 0.25, 0.25]]
]);
const toyVector = (text, purpose) => (purpose === 'document' ? oneHot(4, TOY.indexOf(text.slice(-1))) : TOY_QUERIES.get(text));
const TOY_RERANK = new Map([
  ['Birinci soru', { a: 0.2, b: 0.9, c: 0.1, d: 0 }],
  ['İkinci soru', { a: 0, b: 0, c: 0.1, d: 0.8 }],
  ['Üçüncü soru', { a: 0.5, b: 0.4, c: 0, d: 0.1 }],
  ['Dördüncü soru', { a: 0.05, b: 0.05, c: 0.05, d: 0.05 }]
]);
const toyScore = (query, document) => TOY_RERANK.get(query)[document.slice(-1)];

const toyRun = (options = {}) => collectSemanticRun({ benchmark: toyBenchmark, catalogue: toyCatalogue, ...options });
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} ≠ ${expected}`);

/* ── Kıyas kümesi ───────────────────────────────────────── */

test('kıyas kümesi sentetik, kompakt ve gerçek araç kataloğuna bağlıdır', () => {
  const { catalogue, benchmark } = official();
  assert.ok(benchmark.cases.length >= 80 && benchmark.cases.length <= SEMANTIC_BENCHMARK_LIMITS.maxCases, `${benchmark.cases.length} vaka`);
  for (const kind of Object.values(SEMANTIC_EXPECTATIONS)) {
    assert.ok(benchmark.cases.filter((testCase) => testCase.expect === kind).length >= 5, kind);
  }
  // Her araç en az üç tek ihtiyaçlı yanıt vakasının birincil adayıdır.
  for (const { id } of catalogue.items) {
    const primary = benchmark.cases.filter((testCase) => testCase.expect === 'answer' && testCase.needs.length === 1 && testCase.needs[0][0] === id);
    assert.ok(primary.length >= 3, `${id}: ${primary.length}`);
  }
  assert.ok(benchmark.cases.some((testCase) => testCase.expect === 'answer' && testCase.needs.length > 1), 'birden çok yetenekli vaka');
  // Etiket sözlüğü dolgu içermez: her etiket en az bir vakada kullanılır.
  const used = new Set(benchmark.cases.flatMap((testCase) => testCase.tags));
  assert.deepEqual(benchmark.tags.filter((tag) => !used.has(tag)), []);
  // Sentetik veri: e-posta, adres, uzun numara ya da IBAN yoktur.
  for (const testCase of benchmark.cases) {
    assert.doesNotMatch(testCase.text, /@|https?:|www\.|\d{7,}|\bTR\d{2}/i, testCase.id);
  }
});

test('kıyas kümesi araç açıklamalarını kopyalamaz: vaka metni katalogda, katalogdaki örnek ifade vakada geçmez', () => {
  const { catalogue, benchmark } = official();
  const fold = (text) => text.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const documents = catalogue.items.map((item) => fold(item.text));
  const phrases = catalogue.items.flatMap((item) => [...item.text.matchAll(/"([^"]{6,})"/g)].map((match) => fold(match[1])));
  assert.ok(phrases.length > 0);
  for (const testCase of benchmark.cases) {
    const text = fold(testCase.text);
    assert.equal(documents.some((document) => document.includes(text)), false, testCase.id);
    assert.equal(phrases.some((phrase) => text.includes(phrase)), false, testCase.id);
  }
});

test('üretim kodu kıyas kümesini okumaz: dosya adı, vaka kimliği ya da vaka metni kaynakta geçmez', () => {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  const sources = walk(path.join(ROOT, 'src')).filter((file) => /\.(?:js|jsx|mjs|json|css)$/.test(file));
  assert.ok(sources.length > 100);
  const ids = new RegExp(`\\b(?:${officialDocument.cases.map((testCase) => testCase.id).join('|')})\\b`);
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.relative(ROOT, file);
    assert.equal(source.includes('ai-semantic-benchmark'), false, name);
    assert.doesNotMatch(source, ids, name);
    for (const testCase of officialDocument.cases) assert.equal(source.includes(testCase.text), false, `${name} → ${testCase.id}`);
  }
});

test('kıyas kümesi doğrulaması bozuk, çelişkili ya da kanonik olmayan altın etiketi reddeder', () => {
  const issues = (document) => validateSemanticBenchmark(document, toyCatalogue).issues;
  const withCase = (position, change) => toyDocument(TOY_CASES.map((testCase, i) => (i === position ? { ...testCase, ...change } : testCase)));
  assert.deepEqual(issues(withCase(0, { needs: [['zzz']] })), ['cases[0].needs[0][0]:unknown-item']);
  assert.deepEqual(issues(withCase(0, { needs: [['a', 'b', 'c', 'd', 'a']] })), ['cases[0].needs[0]:shape']);
  assert.deepEqual(issues(withCase(0, { needs: [] })), ['cases[0].needs:count']);
  assert.deepEqual(issues(withCase(0, { avoid: ['b'] })), ['cases[0].avoid[0]:invalid']);
  assert.deepEqual(issues(withCase(0, { avoid: ['d', 'd'] })), ['cases[0].avoid[1]:invalid']);
  assert.deepEqual(issues(withCase(1, { needs: [['c'], ['c']] })), ['cases[1].needs[1][0]:duplicate']);
  assert.deepEqual(issues(withCase(2, { needs: [['a']] })), ['cases[2].needs:count']);
  assert.deepEqual(issues(withCase(3, { needs: [['a']] })), ['cases[3].needs:count']);
  assert.deepEqual(issues(withCase(3, { avoid: ['a'] })), ['cases[3].avoid:count']);
  assert.deepEqual(issues(withCase(1, { id: 'toy-001' })), ['cases[1].id:duplicate']);
  assert.deepEqual(issues(withCase(1, { id: 'TOY 2' })), ['cases[1].id:invalid']);
  assert.deepEqual(issues(withCase(1, { text: 'Birinci soru' })), ['cases[1].text:duplicate']);
  assert.deepEqual(issues(withCase(0, { text: 'Birinci  soru' })), ['cases[0].text:not-normalized']);
  assert.deepEqual(issues(withCase(1, { text: 'İkinci soru'.normalize('NFD') })), ['cases[1].text:not-normalized']);
  assert.deepEqual(issues(withCase(0, { text: '' })), ['cases[0].text:not-normalized']);
  assert.deepEqual(issues(withCase(0, { expect: 'maybe' })), ['cases[0].expect:unknown']);
  assert.deepEqual(issues(withCase(0, { tags: ['bilinmeyen'] })), ['cases[0].tags[0]:invalid']);
  assert.deepEqual(issues(withCase(0, { tags: [] })), ['cases[0].tags:shape']);
  assert.deepEqual(issues(withCase(0, { gold: 'b' })), ['cases[0]:unknown-field']);
  assert.deepEqual(issues(toyDocument(TOY_CASES, { format: 'baska' })), ['format:unknown']);
  assert.deepEqual(issues(toyDocument(TOY_CASES, { version: 2 })), ['version:unsupported']);
  assert.deepEqual(issues(toyDocument(TOY_CASES, { language: 'en' })), ['language:unsupported']);
  assert.deepEqual(issues(toyDocument(TOY_CASES, { tags: { ornek: '' } })), ['tags:invalid', 'cases[1].tags[1]:invalid', 'cases[2].tags[0]:invalid', 'cases[3].tags[0]:invalid']);
  assert.deepEqual(issues(toyDocument([])), ['cases:count']);
  assert.deepEqual(issues(toyDocument(Array.from({ length: SEMANTIC_BENCHMARK_LIMITS.maxCases + 1 }, (_, i) => ({ ...TOY_CASES[3], id: `toy-${i + 100}`, text: `Soru ${i}` })))), ['cases:count']);
  assert.deepEqual(validateSemanticBenchmark(null, toyCatalogue), { ok: false, issues: ['$:shape'] });
  assert.throws(() => validateSemanticBenchmark(toyDocument(), null), TypeError);
});

test('kıyas kümesi yapısı kapalıdır: seyrek dizi, açık null ve bozuk grup yokluk sayılmaz, doğrulayıcı fırlamaz', () => {
  const issues = (document) => validateSemanticBenchmark(document, toyCatalogue).issues;
  const withCase = (position, change) => toyDocument(TOY_CASES.map((testCase, i) => (i === position ? { ...testCase, ...change } : testCase)));
  const hole = (size) => new Array(size);
  const table = [
    [toyDocument([TOY_CASES[0], , TOY_CASES[2], TOY_CASES[3]]), ['cases[1]:shape']], // eslint-disable-line no-sparse-arrays
    [withCase(0, { needs: hole(1) }), ['cases[0].needs:shape']],
    [withCase(0, { needs: [null] }), ['cases[0].needs[0]:shape']],
    [withCase(0, { needs: [42] }), ['cases[0].needs[0]:shape']],
    [withCase(0, { needs: [['b', , 'c']] }), ['cases[0].needs[0]:shape']], // eslint-disable-line no-sparse-arrays
    [withCase(0, { needs: null }), ['cases[0].needs:shape']],
    [withCase(3, { needs: null }), ['cases[3].needs:shape']],
    [withCase(0, { avoid: hole(1) }), ['cases[0].avoid:shape']],
    [withCase(0, { avoid: null }), ['cases[0].avoid:shape']],
    [withCase(0, { tags: hole(1) }), ['cases[0].tags:shape']],
    [withCase(0, { tags: null }), ['cases[0].tags:shape']],
    [toyDocument(TOY_CASES, { yorum: 'ek ayar' }), ['$:unknown-field']],
    [toyDocument(TOY_CASES.map((testCase, i) => (i === 0 ? { ...testCase, get text() { throw new Error('okunamaz'); } } : testCase))), ['$:unreadable']]
  ];
  for (const [document, expected] of table) assert.deepEqual(issues(document), expected, JSON.stringify(expected));
  // Taklit katalog altın etiketleri gerçek katalog gibi damgalayamaz; koşucu da taklidi reddeder.
  const ghost = { fingerprint: toyCatalogue.fingerprint, items: [...toyCatalogue.items, { id: 'ghost' }] };
  assert.throws(() => validateSemanticBenchmark(toyDocument(), ghost), /SEMANTIC_CATALOGUE_REQUIRED/);
  assert.throws(() => validateSemanticBenchmark(toyDocument(), { ...toyCatalogue }), /SEMANTIC_CATALOGUE_REQUIRED/);
  const embed = createEmbeddingDouble({ vectorFor: toyVector }).embed;
  return assert.rejects(collectSemanticRun({ benchmark: toyBenchmark, catalogue: { ...toyCatalogue }, embedding: { space, embed } }), /SEMANTIC_CATALOGUE_MISMATCH/);
});

test('koşu kaydı güvenilmezdir: sonuç ile yük çelişen, yabancı ya da yinelenen satırlı, uydurma yeniden sıralamalı koşu reddedilir', async () => {
  const run = await toyRun({
    embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed },
    reranking: { provenance: rerankProvenance, rerank: createRerankDouble({ scoreFor: toyScore }).rerank }
  });
  // JSON'dan gelen düz kopya, koşucunun dondurulmuş kaydıyla aynı özeti verir.
  assert.deepEqual(summarizeSemanticRun(JSON.parse(JSON.stringify(run)), toyBenchmark), summarizeSemanticRun(run, toyBenchmark));
  const variant = (change) => {
    const copy = structuredClone(run);
    change(copy, copy.cases[0]);
    return copy;
  };
  const failed = { outcome: 'failed', reason: 'MODEL_CALL_FAILED', latencyMs: 1 };
  const stale = [
    (copy) => { copy.version = 2; },
    (copy) => { copy.format = 'baska'; },
    (copy) => { copy.catalogue = '0'.repeat(64); }
  ];
  for (const change of stale) assert.throws(() => summarizeSemanticRun(variant(change), toyBenchmark), /SEMANTIC_RUN_STALE/);
  const invalid = {
    'fazla vaka satırı': (copy) => { copy.cases.push(structuredClone(copy.cases[0])); },
    'yinelenen vaka': (copy) => { copy.cases[1] = structuredClone(copy.cases[0]); },
    'yabancı vaka': (copy, first) => { first.case = 'toy-999'; },
    'seyrek vaka listesi': (copy) => { delete copy.cases[1]; },
    'başarısız gömmede aday': (copy, first) => { first.embedding = failed; },
    'başarısız gömmede yeniden sıralama': (copy, first) => { first.embedding = failed; first.firstStage = null; },
    'başarısız yeniden sıralamada sonuç': (copy, first) => { first.rerank = failed; },
    'eksik yeniden sıralama kaydı': (copy, first) => { first.rerank = null; first.reranked = null; },
    'yeniden sıralama aday düşürür': (copy, first) => { first.reranked = first.reranked.slice(1); },
    'yeniden sıralama aday ekler': (copy, first) => { first.reranked[3] = { id: 'zzz', relevance: -1 }; },
    'yeniden sıralama aday yineler': (copy, first) => { first.reranked[1] = { ...first.reranked[0] }; },
    'sırasız ilk aşama': (copy, first) => { first.firstStage.reverse(); },
    'kısa ilk aşama': (copy, first) => { first.firstStage.pop(); },
    'aralık dışı benzerlik': (copy, first) => { first.firstStage[0].similarity = 2; },
    'negatif gecikme': (copy, first) => { first.embedding.latencyMs = -5; },
    'negatif dizin gecikmesi': (copy) => { copy.index.latencyMs = -1; },
    'gerekçesiz başarısızlık': (copy, first) => { first.embedding = { outcome: 'failed', latencyMs: 1 }; first.firstStage = null; first.rerank = null; first.reranked = null; },
    'gerekçeli başarı': (copy, first) => { first.embedding.reason = 'X'; },
    'güvensiz gerekçe': (copy, first) => { first.embedding = { ...failed, reason: 'sk-gizli ileti' }; first.firstStage = null; first.rerank = null; first.reranked = null; },
    'bilinmeyen sonuç': (copy, first) => { first.embedding.outcome = 'belki'; },
    'geçersiz sınır': (copy) => { copy.limit = 0; },
    'okunamayan satır': (copy) => { Object.defineProperty(copy.cases, 2, { get() { throw new Error('okunamaz'); } }); }
  };
  for (const [label, change] of Object.entries(invalid)) {
    assert.throws(() => summarizeSemanticRun(variant(change), toyBenchmark), /SEMANTIC_RUN_INVALID/, label);
  }
  // Sınırlı aday kümesinde yeniden sıralama, ilk aşamanın görmediği katalog öğesini ekleyemez.
  const narrow = await toyRun({
    embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed },
    reranking: { provenance: rerankProvenance, rerank: createRerankDouble({ scoreFor: toyScore }).rerank },
    limit: 3
  });
  const outsider = structuredClone(narrow);
  const first = outsider.cases[0];
  const unseen = TOY.find((id) => !first.firstStage.some((candidate) => candidate.id === id));
  first.reranked[first.reranked.length - 1] = { id: unseen, relevance: -10 };
  assert.throws(() => summarizeSemanticRun(outsider, toyBenchmark, { cutoffs: [1, 3], ndcgCutoff: 3 }), /SEMANTIC_RUN_INVALID/);
  assert.equal(summarizeSemanticRun(narrow, toyBenchmark, { cutoffs: [1, 3], ndcgCutoff: 3 }).limit, 3);
  // Kaydı olmayan vaka reddedilmez; ıska sayılır.
  const partial = summarizeSemanticRun(variant((copy) => { copy.cases.pop(); }), toyBenchmark);
  assert.equal(partial.cases.missing, 1);
  // Kesimler koşunun toplandığı derinliği aşamaz; seyrek kesim dizisi reddedilir.
  const shallow = await toyRun({ embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed }, limit: 1 });
  assert.throws(() => summarizeSemanticRun(shallow, toyBenchmark), /SEMANTIC_CUTOFFS/);
  assert.throws(() => summarizeSemanticRun(shallow, toyBenchmark, { cutoffs: [1], ndcgCutoff: 2 }), /SEMANTIC_CUTOFFS/);
  assert.equal(summarizeSemanticRun(shallow, toyBenchmark, { cutoffs: [1], ndcgCutoff: 1 }).limit, 1);
  assert.throws(() => summarizeSemanticRun(run, toyBenchmark, { cutoffs: [1, , 5] }), /SEMANTIC_CUTOFFS/); // eslint-disable-line no-sparse-arrays
  // Özet kendi yapılandırmasını taşır.
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.deepEqual([summary.catalogue, summary.limit, summary.cutoffs, summary.ndcgCutoff], [toyCatalogue.fingerprint, 10, [1, 3, 5], 5]);
});

/* ── Ölçüler ────────────────────────────────────────────── */

test('ölçüler elle hesaplanan senaryoyla birebir uyuşur; yeniden sıralamanın katkısı ayrıca ölçülür', async () => {
  const embedding = createEmbeddingDouble({ vectorFor: toyVector });
  const reranker = createRerankDouble({ scoreFor: toyScore });
  const run = await toyRun({ embedding: { space, embed: embedding.embed }, reranking: { provenance: rerankProvenance, rerank: reranker.rerank } });
  assert.deepEqual(run.cases.map((entry) => entry.firstStage.map((candidate) => candidate.id)), [['a', 'b', 'c', 'd'], ['c', 'd', 'b', 'a'], ['d', 'a', 'b', 'c'], ['a', 'b', 'c', 'd']]);
  assert.deepEqual(run.cases.map((entry) => entry.reranked.map((candidate) => candidate.id)), [['b', 'a', 'c', 'd'], ['d', 'c', 'b', 'a'], ['a', 'b', 'd', 'c'], ['a', 'b', 'c', 'd']]);
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.deepEqual(summary.cases, { total: 4, answer: 2, clarify: 1, abstain: 1, missing: 0 });
  const first = summary.stages.embedding;
  // Vaka 1: ilgili aday 2. sırada (RR 1/2, NDCG 1/log2(3)); vaka 2: iki grup 1. ve 2. sırada.
  assert.equal(first.answer.cases, 2);
  assert.equal(first.answer.hitAt1, 0.5);
  assert.equal(first.answer.mrr, 0.75);
  assert.deepEqual(first.answer.recall, { 1: 0.25, 3: 1, 5: 1 });
  assert.deepEqual(first.answer.coverage, { 1: 0, 3: 1, 5: 1 });
  near(first.answer.ndcg, (1 / Math.log2(3) + 1) / 2, 'ndcg');
  assert.deepEqual(first.answer.avoid, { pairs: 1, held: 1, rate: 1 });
  assert.deepEqual(first.clarifyCoverage, { cutoff: 5, cases: 1, rate: 1 });
  assert.equal(first.abstainSeparability, 1);
  assert.deepEqual(first.byTag, { diger: { cases: 1, hitAt1: 1, mrr: 1 }, ornek: { cases: 2, hitAt1: 0.5, mrr: 0.75 } });
  assert.deepEqual(first.misses, [{ case: 'toy-001', top: ['a', 'b', 'c'] }]);
  const second = summary.stages.reranked;
  assert.equal(second.answer.hitAt1, 1);
  assert.equal(second.answer.mrr, 1);
  assert.deepEqual(second.answer.recall, { 1: 0.75, 3: 1, 5: 1 });
  assert.equal(second.answer.ndcg, 1);
  assert.equal(second.abstainSeparability, 1);
  assert.deepEqual(second.misses, []);
  assert.equal(summary.uplift.hitAt1, 0.5);
  assert.equal(summary.uplift.mrr, 0.25);
  near(summary.uplift.ndcg, 1 - (1 / Math.log2(3) + 1) / 2, 'uplift');
  assert.deepEqual(summary.uplift.recall, { 1: 0.5, 3: 0, 5: 0 });
  assert.deepEqual(summary.outcomes, { index: 'ok', embedding: { ok: 4, invalid: 0, timeout: 0, failed: 0 }, rerank: { ok: 4, invalid: 0, timeout: 0, failed: 0 } });
  // Model sınırına yalnızca metinler gider; yeniden sıralayıcı yalnızca ilk aşamanın adaylarını görür.
  assert.deepEqual(embedding.calls.map((call) => call.purpose), ['document', 'query', 'query', 'query', 'query']);
  assert.deepEqual(reranker.calls[0], { query: 'Birinci soru', documents: ['Belge a', 'Belge b', 'Belge c', 'Belge d'] });
  assert.equal(run.reranker.profile, AI_PROFILES.RERANK);
  assert.deepEqual(run.embedding, { profile: 'embedding', model: space.model, provider: space.provider, preprocessing: 'none' });
  assert.match(run.index.identity, /^[0-9a-f]{64}$/);
  // Daha dar sınır ve kesimlerle aynı koşu yeniden özetlenebilir.
  const narrow = summarizeSemanticRun(run, toyBenchmark, { cutoffs: [1, 2], ndcgCutoff: 1 });
  assert.deepEqual(narrow.stages.embedding.answer.recall, { 1: 0.25, 2: 1 });
  assert.deepEqual(narrow.stages.embedding.clarifyCoverage, { cutoff: 2, cases: 1, rate: 0 });
  assert.equal(narrow.stages.embedding.answer.ndcg, 0.5);
});

test('tam kıyas kümesi kâhin ikiziyle uçtan uca koşar: kusursuz sıralama kusursuz, ters sıralama zayıf ölçü verir', async () => {
  const { catalogue, benchmark } = official();
  const ids = catalogue.items.map((item) => item.id);
  const byText = new Map(benchmark.cases.map((testCase) => [testCase.text, testCase]));
  const documentAt = new Map(catalogue.items.map((item, position) => [item.text, position]));
  const golden = (testCase) => new Set(testCase.needs.map((group) => group[0]));
  const vectorFor = (text, purpose) => {
    if (purpose === 'document') return oneHot(ids.length, documentAt.get(text));
    const testCase = byText.get(text);
    return testCase.expect === 'abstain' ? ids.map(() => 1) : ids.map((id) => (golden(testCase).has(id) ? 1 : 0));
  };
  const textToId = new Map(catalogue.items.map((item) => [item.text, item.id]));
  const needed = (testCase) => new Set(testCase.needs.flat());
  const scoreFor = (query, document) => (needed(byText.get(query)).has(textToId.get(document)) ? -1 : 1);
  const embedding = createEmbeddingDouble({ vectorFor });
  const run = await collectSemanticRun({
    benchmark, catalogue, embedding: { space, embed: embedding.embed },
    reranking: { provenance: rerankProvenance, rerank: createRerankDouble({ scoreFor }).rerank }
  });
  const summary = summarizeSemanticRun(run, benchmark);
  const answers = benchmark.cases.filter((testCase) => testCase.expect === 'answer');
  const first = summary.stages.embedding;
  assert.equal(first.answer.cases, answers.length);
  assert.equal(first.answer.hitAt1, 1);
  assert.equal(first.answer.mrr, 1);
  assert.equal(first.answer.ndcg, 1);
  assert.equal(first.answer.coverage[5], 1);
  near(first.answer.recall[1], answers.reduce((sum, testCase) => sum + 1 / testCase.needs.length, 0) / answers.length, 'recall@1');
  assert.equal(first.answer.avoid.rate, 1);
  assert.equal(first.clarifyCoverage.rate, 1);
  assert.equal(first.abstainSeparability, 1);
  assert.deepEqual(first.misses, []);
  // Altın adayı sona iten yeniden sıralayıcı negatif katkı olarak görünür; ayrılabilirlik eşitliğe iner.
  assert.equal(summary.stages.reranked.answer.hitAt1, 0);
  assert.equal(summary.uplift.hitAt1, -1);
  assert.equal(summary.stages.reranked.abstainSeparability, 0.5);
  assert.deepEqual(summary.outcomes.embedding, { ok: benchmark.cases.length, invalid: 0, timeout: 0, failed: 0 });
  // Model sınırına yalnızca kanonik vaka metni gider: kimlik, etiket ya da beklenti gitmez.
  assert.deepEqual(embedding.calls[0].texts, catalogue.items.map((item) => item.text));
  for (const call of embedding.calls.slice(1)) assert.ok(call.texts.length === 1 && byText.has(call.texts[0]));
  assert.doesNotMatch(JSON.stringify(embedding.calls), /tr-\d{3}|"(?:answer|clarify|abstain)"|varlik-adi/);
});

test('model hatası, geçersiz çıktı ve süre aşımı ölçüden çıkarılmaz; ıska sayılır ve ileti taşınmaz', { timeout: 5000 }, async () => {
  const secret = Object.assign(new Error('sk-gizli-anahtar sağlayıcı yanıtında'), { code: 'AI_PROVIDER_UNAVAILABLE' });
  const embedding = createEmbeddingDouble({
    vectorFor: toyVector,
    behaviors: [{ type: 'vectors' }, { type: 'throw', error: secret }, { type: 'raw', value: [{ index: 0, vector: [NaN, 0, 0, 0] }] }, { type: 'hang' }]
  });
  let abortReason = null;
  const embed = (texts, options) => {
    options.signal.addEventListener('abort', () => { abortReason = options.signal.reason; }, { once: true });
    return embedding.embed(texts, options);
  };
  const run = await toyRun({ embedding: { space, embed }, callTimeoutMs: 25 });
  assert.deepEqual(run.cases.map((entry) => [entry.embedding.outcome, entry.embedding.reason ?? null]),
    [['failed', 'AI_PROVIDER_UNAVAILABLE'], ['invalid', 'VALUE_NOT_FINITE'], ['timeout', null], ['ok', null]]);
  // Süresi dolan çağrının sinyali `AbortSignal.timeout()` ile aynı türde nedenle iptal edilir.
  assert.equal(abortReason instanceof DOMException && abortReason.name, 'TimeoutError');
  assert.doesNotMatch(JSON.stringify(run), /sk-gizli|sağlayıcı yanıtında/);
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.deepEqual(summary.outcomes.embedding, { ok: 1, invalid: 1, timeout: 1, failed: 1 });
  // Başarısız yanıt vakaları paydada kalır: ölçü düşer, vaka sayısı düşmez.
  assert.equal(summary.stages.embedding.answer.cases, 2);
  assert.equal(summary.stages.embedding.answer.hitAt1, 0);
  assert.equal(summary.stages.embedding.answer.mrr, 0);
  assert.equal(summary.stages.embedding.clarifyCoverage.rate, 0);
  // Skoru olmayan vaka ayrılabilirlikten düşmez: başarısız kapsam içi vaka en kötü durum sayılır.
  assert.equal(summary.stages.embedding.abstainSeparability, 0);
  // Güvenli olmayan, okunamayan ya da metin olmayan hata kodu genel koda iner; kod bir kez okunur.
  let codeReads = 0;
  const shifting = { get code() { codeReads += 1; return codeReads === 1 ? 'AI_PROVIDER_UNAVAILABLE' : 'sk-gizli'; } };
  const unreadable = { get code() { throw new Error('sk-gizli'); } };
  const boxed = { code: { toString: () => 'AI_PROVIDER_UNAVAILABLE' } };
  const unsafe = createEmbeddingDouble({
    vectorFor: toyVector,
    behaviors: [{ type: 'vectors' }, ...[Object.assign(new Error('x'), { code: 'econnreset' }), shifting, unreadable, boxed].map((error) => ({ type: 'throw', error }))]
  });
  const second = await toyRun({ embedding: { space, embed: unsafe.embed } });
  assert.deepEqual(second.cases.map((entry) => entry.embedding.reason), ['MODEL_CALL_FAILED', 'AI_PROVIDER_UNAVAILABLE', 'MODEL_CALL_FAILED', 'MODEL_CALL_FAILED']);
  assert.equal(codeReads, 1);
});

test('yeniden sıralama başarısızsa üretimdeki gibi ilk aşama sırası geçerli kalır ve başarısızlık sayılır', { timeout: 5000 }, async () => {
  const reranker = createRerankDouble({
    scoreFor: toyScore,
    behaviors: [
      { type: 'raw', value: [{ index: 0, score: 1 }, { index: 0, score: 2 }, { index: 1, score: 0 }, { index: 2, score: 0 }] },
      { type: 'throw', error: new Error('kesildi') },
      { type: 'scores' },
      { type: 'hang' }
    ]
  });
  const run = await toyRun({
    embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed },
    reranking: { provenance: rerankProvenance, rerank: reranker.rerank },
    callTimeoutMs: 25
  });
  assert.deepEqual(run.cases.map((entry) => [entry.rerank.outcome, entry.rerank.reason ?? null, entry.reranked === null]),
    [['invalid', 'INDEX_DUPLICATE', true], ['failed', 'MODEL_CALL_FAILED', true], ['ok', null, false], ['timeout', null, true]]);
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.deepEqual(summary.outcomes.rerank, { ok: 1, invalid: 1, timeout: 1, failed: 1 });
  assert.deepEqual(summary.stages.reranked.answer, summary.stages.embedding.answer);
  assert.equal(summary.uplift.hitAt1, 0);
  // Başarısız yeniden sıralama ayrılabilirliği yükseltemez: skoru olmayan vaka en kötü durum sayılır.
  assert.equal(summary.stages.reranked.abstainSeparability, 0);
});

test('katalog gömülemezse dizin kurulmaz, model çağrılmaz ve bütün vakalar ıska sayılır', async () => {
  const embedding = createEmbeddingDouble({ vectorFor: toyVector, behaviors: [{ type: 'raw', value: [] }] });
  const run = await toyRun({ embedding: { space, embed: embedding.embed } });
  assert.deepEqual({ ...run.index, latencyMs: typeof run.index.latencyMs }, { outcome: 'invalid', reason: 'COUNT_MISMATCH', latencyMs: 'number' });
  assert.equal(embedding.calls.length, 1);
  assert.ok(run.cases.every((entry) => entry.embedding.outcome === 'failed' && entry.embedding.reason === 'INDEX_UNAVAILABLE'));
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.equal(summary.outcomes.index, 'invalid');
  assert.equal(summary.stages.embedding.answer.hitAt1, 0);
  assert.equal(summary.stages.embedding.abstainSeparability, 0);
  assert.deepEqual(summary.outcomes.embedding, { ok: 0, invalid: 0, timeout: 0, failed: 4 });
});

test('süresi dolup iptali doğrulanamayan çağrıdan sonra model çağrılmaz; kalan vakalar ıska sayılır ve örtüşme olmaz', { timeout: 5000 }, async () => {
  // Sinyale uymayan model: hiç sonuçlanmaz ya da geç sonuçlanıp paylaşılan durumu değiştirir.
  for (const late of [false, true]) {
    const embedding = createEmbeddingDouble({ vectorFor: toyVector });
    let queries = 0;
    const embed = (texts, options) => {
      if (options.purpose === 'document') return embedding.embed(texts, options);
      queries += 1;
      if (queries > 1) return embedding.embed(texts, options);
      return new Promise((resolve) => {
        if (late) setTimeout(() => resolve([]), 200);
      });
    };
    const run = await toyRun({ embedding: { space, embed }, callTimeoutMs: 25 });
    assert.deepEqual(run.cases.map((entry) => [entry.embedding.outcome, entry.embedding.reason ?? null]),
      [['timeout', null], ['failed', 'RUN_HALTED'], ['failed', 'RUN_HALTED'], ['failed', 'RUN_HALTED']], `late=${late}`);
    assert.equal(queries, 1, 'süresi dolan çağrıdan sonra yeni model çağrısı başlamaz');
    const summary = summarizeSemanticRun(run, toyBenchmark);
    assert.deepEqual(summary.outcomes.embedding, { ok: 0, invalid: 0, timeout: 1, failed: 3 });
    assert.equal(summary.stages.embedding.answer.cases, 2);
    // Gecikme nüfusu yalnızca yapılan çağrılardır: hiç çağrılmayan vaka gecikmeye girmez.
    assert.equal(summary.latency.embedding.count, 1);
  }
  // Varsayılan süre sınırı sonludur; sınırsız çağrı seçeneği yoktur.
  assert.ok(Number.isSafeInteger(SEMANTIC_EVALUATION_DEFAULTS.callTimeoutMs) && SEMANTIC_EVALUATION_DEFAULTS.callTimeoutMs > 0);
  await assert.rejects(toyRun({ embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed }, callTimeoutMs: null }), RangeError);
});

test('iptal yarışları: çağrıdan önce gelen iptal modeli çağırmaz, sonuçla iptal arasında iptal kazanır', { timeout: 5000 }, async () => {
  // Koşu başlatılır başlatılmaz iptal: kuyruktaki çağrı modele ulaşmaz.
  const early = new AbortController();
  const embedding = createEmbeddingDouble({ vectorFor: toyVector });
  const pending = toyRun({ embedding: { space, embed: embedding.embed }, signal: early.signal });
  early.abort(new Error('hemen'));
  await assert.rejects(pending, /hemen/);
  assert.equal(embedding.calls.length, 0);
  // Son model çağrısının sonucu kesinleştikten SONRA ama koşucu onu kaydetmeden ÖNCE gelen iptal:
  // başarı kaydedilmez, koşu iptal nedeniyle reddedilir.
  const racing = new AbortController();
  const reason = new Error('yarış');
  const normal = createEmbeddingDouble({ vectorFor: toyVector });
  let calls = 0;
  const embed = (texts, options) => {
    calls += 1;
    if (calls < 1 + TOY_CASES.length) return normal.embed(texts, options);
    const value = texts.map((text, index) => ({ index, vector: toyVector(text, options.purpose) }));
    return { then(resolve) { resolve(value); queueMicrotask(() => racing.abort(reason)); } };
  };
  await assert.rejects(toyRun({ embedding: { space, embed }, signal: racing.signal }), (error) => error === reason);
  assert.equal(calls, 1 + TOY_CASES.length);
});

test('koşunun iptali hemen yayılır; sinyale uymayan model de koşuyu askıda bırakamaz', { timeout: 5000 }, async () => {
  for (const type of ['hang', 'stall']) {
    const controller = new AbortController();
    const embedding = createEmbeddingDouble({ vectorFor: toyVector, behaviors: [{ type: 'vectors' }, { type }] });
    const pending = toyRun({ embedding: { space, embed: embedding.embed }, signal: controller.signal });
    while (embedding.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const reason = new Error(`iptal ${type}`);
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(embedding.calls.length, 2, `${type}: iptalden sonra model çağrılmaz`);
  }
  const aborted = new AbortController();
  aborted.abort(new Error('önceden'));
  const embedding = createEmbeddingDouble({ vectorFor: toyVector });
  await assert.rejects(toyRun({ embedding: { space, embed: embedding.embed }, signal: aborted.signal }), /önceden/);
  assert.equal(embedding.calls.length, 0);
});

test('gecikme özeti en yakın sıra yüzdeliğidir ve enjekte edilen saatle belirlenimcidir', async () => {
  const ticks = [0, 7, 100, 110, 200, 220, 300, 330, 400, 440];
  const run = await toyRun({ embedding: { space, embed: createEmbeddingDouble({ vectorFor: toyVector }).embed }, now: () => ticks.shift() });
  const summary = summarizeSemanticRun(run, toyBenchmark);
  assert.deepEqual(summary.latency, { index: 7, embedding: { count: 4, p50: 20, p95: 40, max: 40 }, rerank: null });
  assert.equal(summary.stages.reranked, null);
  assert.equal(summary.uplift, null);
});

test('bayat koşu, uyumsuz katalog ve geçersiz parametreler reddedilir', async () => {
  const embed = createEmbeddingDouble({ vectorFor: toyVector }).embed;
  const run = await toyRun({ embedding: { space, embed } });
  const changed = validateSemanticBenchmark(toyDocument(TOY_CASES.map((testCase, i) => (i === 0 ? { ...testCase, needs: [['a']] } : testCase))), toyCatalogue).benchmark;
  assert.throws(() => summarizeSemanticRun(run, changed), /SEMANTIC_RUN_STALE/);
  assert.throws(() => summarizeSemanticRun({ ...run, format: 'baska' }, toyBenchmark), /SEMANTIC_RUN_STALE/);
  assert.throws(() => summarizeSemanticRun(run, { ...toyBenchmark }), TypeError);
  for (const options of [{ cutoffs: [] }, { cutoffs: [0] }, { cutoffs: [3, 1] }, { cutoffs: [1, '3'] }, { ndcgCutoff: 0 }]) {
    assert.throws(() => summarizeSemanticRun(run, toyBenchmark, options), RangeError, JSON.stringify(options));
  }
  const otherCatalogue = createSemanticCatalogue(TOY.map((id) => ({ id, kind: 'tool', version: 2, text: `Belge ${id}` }))).catalogue;
  await assert.rejects(collectSemanticRun({ benchmark: toyBenchmark, catalogue: otherCatalogue, embedding: { space, embed } }), /SEMANTIC_CATALOGUE_MISMATCH/);
  await assert.rejects(toyRun({ embedding: { space: null, embed } }), TypeError);
  await assert.rejects(toyRun({ embedding: { space, embed: null } }), TypeError);
  await assert.rejects(toyRun({ embedding: { space, embed }, reranking: { provenance: null, rerank: () => [] } }), TypeError);
  await assert.rejects(toyRun({ embedding: { space, embed }, reranking: { provenance: space, rerank: () => [] } }), TypeError);
  await assert.rejects(collectSemanticRun({ benchmark: { ...toyBenchmark }, catalogue: toyCatalogue, embedding: { space, embed } }), TypeError);
  for (const limit of [0, 21, 1.5]) await assert.rejects(toyRun({ embedding: { space, embed }, limit }), RangeError);
  for (const callTimeoutMs of [0, 1.5, 600001]) await assert.rejects(toyRun({ embedding: { space, embed }, callTimeoutMs }), RangeError);
});

/* ── Planlayıcı kararları ───────────────────────────────── */

test('planlayıcı kararları: açıklama doğruluğu, çekimserlik, araç kapsaması ve yasak araç ihlali ölçülür', () => {
  const clean = evaluateSemanticDecisions(toyBenchmark, [
    { case: 'toy-001', decision: 'answer', tools: ['b', 'd'] },
    { case: 'toy-002', decision: 'answer', tools: ['c'] },
    { case: 'toy-003', decision: 'answer', tools: ['a'] },
    { case: 'toy-004', decision: 'abstain', tools: [] }
  ]);
  assert.deepEqual(clean, {
    cases: 4,
    missing: 0,
    invalid: 0,
    accuracy: 0.75,
    recall: { answer: 1, clarify: 0, abstain: 1 },
    confusion: {
      answer: { answer: 2, clarify: 0, abstain: 0, none: 0 },
      clarify: { answer: 1, clarify: 0, abstain: 0, none: 0 },
      abstain: { answer: 0, clarify: 0, abstain: 1, none: 0 }
    },
    toolCoverage: 0.5,
    avoidViolations: 1
  });
  // Eksik, yinelenen, bilinmeyen ya da bozuk karar hata sayılır; hiçbir vaka paydadan düşmez.
  const dirty = evaluateSemanticDecisions(toyBenchmark, [
    { case: 'toy-001', decision: 'answer', tools: ['b'] },
    { case: 'toy-001', decision: 'answer', tools: ['b'] },
    { case: 'toy-999', decision: 'answer', tools: [] },
    { case: 'toy-003', decision: 'belki', tools: [] },
    { case: 'toy-004', decision: 'abstain', tools: ['zzz'] },
    'karar',
    null
  ]);
  assert.equal(dirty.accuracy, 0);
  assert.equal(dirty.invalid, 6);
  assert.equal(dirty.missing, 1);
  assert.deepEqual(Object.values(dirty.confusion).map((row) => row.none), [2, 1, 1]);
  assert.throws(() => evaluateSemanticDecisions({ cases: [] }, []), TypeError);
  // Karar da güvenilmez model çıktısıdır: seyrek araç listesi, araç adlandıran çekimserlik,
  // okunamayan karar ve karar listesindeki boşluk geçersiz sayılır; değerlendirme fırlamaz.
  const hostile = evaluateSemanticDecisions(toyBenchmark, [
    { case: 'toy-001', decision: 'answer', tools: new Array(1) },
    { case: 'toy-002', decision: 'answer', tools: ['c', , 'd'] }, // eslint-disable-line no-sparse-arrays
    { case: 'toy-004', decision: 'abstain', tools: ['a'] },
    { case: 'toy-003', get decision() { throw new Error('okunamaz'); }, tools: [] },
    , // eslint-disable-line no-sparse-arrays
    { case: 'toy-003', decision: 'clarify', tools: ['a', 'b'] }
  ]);
  assert.equal(hostile.invalid, 5);
  assert.equal(hostile.toolCoverage, 0);
  assert.deepEqual(hostile.recall, { answer: 0, clarify: 1, abstain: 0 });
});
