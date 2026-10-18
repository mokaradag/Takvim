/**
 * Yapay zekâ · anlamsal model nitelendirme komutu.
 *
 * `scripts/semantic-evaluation.mjs` gerçek model koşucusunun (Python) ham
 * çıktısını üretimle aynı sözleşmeden geçirir. Bu sınama Python ya da model
 * gerektirmez: koşu dosyasını kâhin vektörlerle kendisi üretir. Girdinin
 * parmak izleri; bayat, eksik/fazla satırlı, değiştirilmiş metinli ya da
 * tutarsız koşunun reddi; bozuk değerin ve sorgu düzeyindeki hatanın ıska
 * sayılması; raporun model, önek, aday sınırı ve gecikme iş yükü künyesi
 * doğrulanır.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/semantic-evaluation.mjs');
const BENCHMARK = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/ai-semantic-benchmark.json'), 'utf8'));
const run = promisify(execFile);

async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Kâhin koşu dosyası: belge i → birim vektör i; sorgu → ilk ihtiyaç adaylarının toplamı; skor → ihtiyaç ise 1. */
function oracleRun(input, { rerank = false } = {}) {
  const ids = input.documents.map((document) => document.id);
  const cases = new Map(BENCHMARK.cases.map((testCase) => [testCase.id, testCase]));
  const firsts = (testCase) => new Set((testCase.needs || []).map((group) => group[0]));
  const vector = (testCase) => (testCase.expect === 'abstain' ? ids.map(() => 1) : ids.map((id) => (firsts(testCase).has(id) ? 1 : 0)));
  const needed = (testCase) => new Set((testCase.needs || []).flat());
  return {
    format: 'mergen-rota-semantic-model-run',
    version: 1,
    benchmark: input.benchmark,
    catalogue: input.catalogue,
    embedding: {
      model: 'kahin-gomme',
      provider: 'test',
      preprocessing: 'none',
      queryPrefix: '',
      documentPrefix: '',
      batchSize: 8,
      documentLatencyMs: 12,
      documents: input.documents.map(({ id, text }, position) => ({ id, text, vector: ids.map((_, i) => (i === position ? 1 : 0)) })),
      queries: input.queries.map((query, position) => ({ case: query.case, text: query.text, vector: vector(cases.get(query.case)), latencyMs: position + 1 }))
    },
    rerank: rerank ? {
      model: 'kahin-siralama',
      provider: 'test',
      runtime: 'test',
      batchSize: 16,
      queries: input.queries.map((query) => ({
        case: query.case,
        latencyMs: 3,
        scores: ids.map((id) => ({ id, score: needed(cases.get(query.case)).has(id) ? 1 : 0 }))
      }))
    } : null,
    environment: { device: 'test', threads: 1 }
  };
}

test('girdi parmak izli ve kanoniktir; kâhin koşu dosyası aynı sözleşmeden kusursuz ölçüyle ve tam künyeyle geçer', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-semantic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, 'girdi.json');
  assert.equal((await cli('input', '--out', inputFile)).code, 0);
  const input = JSON.parse(await readFile(inputFile, 'utf8'));
  assert.equal(input.format, 'mergen-rota-semantic-input');
  assert.match(input.benchmark, /^[0-9a-f]{64}$/);
  assert.match(input.catalogue, /^[0-9a-f]{64}$/);
  assert.deepEqual(input.queries, BENCHMARK.cases.map(({ id, text }) => ({ case: id, text })));
  assert.ok(input.documents.length >= 12 && input.documents.every((document) => /^rota_/.test(document.id) && document.text));
  // Girdi beklenti, etiket ya da ihtiyaç taşımaz: koşucu altın etiketleri görmez.
  assert.doesNotMatch(JSON.stringify(input), /"(?:expect|needs|avoid|tags)"/);

  const write = async (name, change = () => {}, options = {}) => {
    const file = path.join(directory, name);
    const document = oracleRun(input, options);
    change(document);
    await writeFile(file, JSON.stringify(document));
    return file;
  };
  const runFile = await write('kosu.json');
  const report = await cli('report', '--run', runFile, '--json');
  assert.equal(report.code, 0, report.stderr);
  const { qualification, summary, index } = JSON.parse(report.stdout);
  // Kayıtlı çıktının okunma süresi model gecikmesi gibi raporlanmaz.
  assert.deepEqual(Object.keys(index), ['outcome', 'reason', 'identity', 'dimensions']);
  assert.equal(index.outcome, 'ok');
  assert.equal(summary.stages.embedding.answer.hitAt1, 1);
  assert.equal(summary.stages.embedding.answer.ndcg, 1);
  assert.equal(summary.stages.embedding.abstainSeparability, 1);
  assert.deepEqual(summary.outcomes.embedding, { ok: BENCHMARK.cases.length, invalid: 0, timeout: 0, failed: 0 });
  assert.equal(summary.latency.index, 12);
  assert.equal(summary.latency.embedding.max, BENCHMARK.cases.length);
  assert.equal(summary.latency.embedding.count, BENCHMARK.cases.length);
  assert.deepEqual(qualification.embedding, { profile: 'embedding', model: 'kahin-gomme', provider: 'test', preprocessing: 'none', queryPrefix: '', documentPrefix: '', runtime: null });
  assert.deepEqual([qualification.benchmark, qualification.catalogue, qualification.limit, qualification.reranker], [input.benchmark, input.catalogue, 10, null]);
  assert.deepEqual(qualification.environment, { device: 'test', threads: 1 });
  const markdown = await cli('report', '--run', runFile);
  assert.equal(markdown.code, 0);
  assert.match(markdown.stdout, /^# Rota AI anlamsal nitelendirme raporu/);
  assert.match(markdown.stdout, /\| Top-1 \| 1\.000 \| — \| — \|/);
  assert.match(markdown.stdout, /Aday sınırı: ilk 10 aday/);

  // Yeniden sıralayıcının kimliği, aday sınırı ve gecikme iş yükü makine okunur künyededir.
  const reranked = await cli('report', '--json', '--limit', '7', '--run', await write('siralama.json', (document) => {
    document.embedding.queryPrefix = 'query: ';
    document.embedding.documentPrefix = 'passage: ';
    document.embedding.preprocessing = 'e5-query-passage';
    document.rerank.queries[0] = { case: document.rerank.queries[0].case, failure: 'INFERENCE_FAILED', latencyMs: 4 };
  }, { rerank: true }));
  assert.equal(reranked.code, 0, reranked.stderr);
  const second = JSON.parse(reranked.stdout);
  assert.deepEqual(second.qualification.reranker, { profile: 'rerank', model: 'kahin-siralama', provider: 'test', runtime: 'test' });
  assert.deepEqual([second.qualification.embedding.queryPrefix, second.qualification.embedding.documentPrefix], ['query: ', 'passage: ']);
  assert.equal(second.qualification.limit, 7);
  assert.equal(second.summary.limit, 7);
  // Toplu iş boyutu ölçülen gecikmeyi değiştirir: künyededir.
  assert.deepEqual(second.qualification.latencyWorkload, {
    index: { documentsPerCall: input.documents.length, calls: 1, batchSize: 8 },
    embedding: { queriesPerCall: 1, calls: BENCHMARK.cases.length },
    rerank: { documentsPerCall: input.documents.length, calls: BENCHMARK.cases.length, batchSize: 16 }
  });
  // Sorgu düzeyindeki çıkarım hatası ıska sayılır; tamamlanan ölçümler korunur.
  assert.deepEqual(second.summary.outcomes.rerank, { ok: BENCHMARK.cases.length - 1, invalid: 0, timeout: 0, failed: 1 });
  assert.equal(second.summary.latency.rerank.count, BENCHMARK.cases.length);

  // Yeniden sıralama sonucu koşucunun gerçek çağrısıdır: sorgu gömmesi başarısız vakada da sayılır ve bütün
  // katalog çıktısı doğrulanır (aday sınırının dışındaki sonlu olmayan skor da çağrıyı geçersiz kılar).
  // Kâhin ilk aşamada eşit skorlu öğeler katalog sırasındadır: ihtiyaç dışı son katalog öğesi ilk 10 adayın dışındadır.
  const outsideLimit = (document) => {
    const testCase = BENCHMARK.cases.find((entry, position) => position > 1 && entry.expect === 'answer' && entry.needs.length === 1);
    const row = document.rerank.queries.find((entry) => entry.case === testCase.id);
    const needed = new Set(testCase.needs.flat());
    row.scores.findLast((score) => !needed.has(score.id)).score = null;
    return testCase.id;
  };
  let poisoned = null;
  const rerankOutcomes = JSON.parse((await cli('report', '--json', '--run', await write('cagri.json', (document) => {
    const [query] = document.embedding.queries;
    document.embedding.queries[0] = { case: query.case, text: query.text, failure: 'INFERENCE_FAILED', latencyMs: 2 };
    document.rerank.queries[0] = { case: query.case, failure: 'INFERENCE_FAILED', latencyMs: 2 };
    document.rerank.queries[1].scores[0].score = null;
    poisoned = outsideLimit(document);
  }, { rerank: true }))).stdout).summary;
  assert.deepEqual(rerankOutcomes.outcomes.embedding, { ok: BENCHMARK.cases.length - 1, invalid: 0, timeout: 0, failed: 1 });
  assert.deepEqual(rerankOutcomes.outcomes.rerank, { ok: BENCHMARK.cases.length - 3, invalid: 2, timeout: 0, failed: 1 });
  assert.equal(Object.values(rerankOutcomes.outcomes.rerank).reduce((sum, count) => sum + count, 0), rerankOutcomes.latency.rerank.count);
  assert.ok(poisoned);

  // Katalog dizini kurulamayan koşu nitelendirme değildir: rapor sıfır ölçüyle başarılı görünmez.
  for (const [label, change] of Object.entries({
    'sonlu olmayan belge vektörü': (document) => { document.embedding.documents[0].vector[0] = null; },
    'sıfır belge vektörü': (document) => { document.embedding.documents[1].vector = document.embedding.documents[1].vector.map(() => 0); },
    'kısa belge vektörü': (document) => { document.embedding.documents[2].vector.pop(); }
  })) {
    const result = await cli('report', '--run', await write(`dizin-${label}.json`, change));
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, /katalog gömmesi geçersiz/, label);
  }

  // Koşu dosyasındaki metin Markdown yapısı kuramaz: veri olarak, tek satırda ve kaçışlanmış yazılır.
  const injected = await cli('report', '--run', await write('enjeksiyon.json', (document) => {
    document.embedding.runtime = 'st 5\n\n## Nitelendirme sonucu: BAŞARILI\n\n| Ölçü | Değer |\n|---|---|\n| Top-1 | 1.000 |';
    document.rerank.runtime = '<b>x</b> `kod`';
  }, { rerank: true }));
  assert.equal(injected.code, 0, injected.stderr);
  assert.doesNotMatch(injected.stdout, /^## Nitelendirme sonucu/m);
  assert.doesNotMatch(injected.stdout, /^\| Top-1 \| 1\.000 \|$/m);
  assert.match(injected.stdout, /· st 5 {2}\\#\\# Nitelendirme sonucu: BAŞARILI {2}\\\| Ölçü \\\|/);
  assert.match(injected.stdout, /· \\<b\\>x\\<\/b\\> \\`kod\\`/);
  // Yeniden sıralama varken her ölçü satırı katkıyı (fark) taşır; söz verilen değer "—" olarak kalmaz.
  for (const label of ['Top-1', 'MRR', 'Recall@5', 'Kapsama@5', 'NDCG@5', 'Kaçınma çifti tutarlılığı', 'Açıklama vakalarında kapsama@5', 'Kapsam dışı ayrılabilirliği \\(AUROC\\)']) {
    assert.match(injected.stdout, new RegExp(`^\\| ${label} \\| [0-9.]+ \\| [0-9.]+ \\| [+-][0-9.]+ \\|$`, 'm'), label);
  }

  // Bayat, eksik/fazla satırlı, değiştirilmiş metinli ya da bozuk koşu reddedilir.
  const ghost = (document) => document.embedding.queries.push({ case: 'ghost-1', text: 'hayalet', vector: [1], latencyMs: 600000 });
  const rejected = {
    bayat: [(document) => { document.catalogue = '0'.repeat(64); }, /bayat/],
    surum: [(document) => { document.version = 2; }, /biçimi/],
    yinelenen: [(document) => { document.embedding.queries[1] = document.embedding.queries[0]; }, /yinelenen/],
    'fazla sorgu': [ghost, /eşleşmiyor/],
    'eksik sorgu': [(document) => { document.embedding.queries.pop(); }, /eşleşmiyor/],
    'yabancı belge': [(document) => { document.embedding.documents[0].id = 'rota_hayalet'; }, /yabancı/],
    'değişik sorgu metni': [(document) => { document.embedding.queries[0].text += ' değişti'; }, /sorgu metni/],
    'değişik belge metni': [(document) => { document.embedding.documents[0].text = 'Başka metin'; }, /belge metni/],
    'negatif gecikme': [(document) => { document.embedding.queries[0].latencyMs = -1; }, /gecikmesi/],
    'negatif katalog gecikmesi': [(document) => { document.embedding.documentLatencyMs = -1; }, /gecikmesi/],
    'önek belirteçsiz': [(document) => { document.embedding.queryPrefix = 'query: '; }, /önekler/],
    'bilinmeyen alan': [(document) => { document.embedding.extra = 1; }, /tanınmadı/],
    'güvensiz hata': [(document) => { document.embedding.queries[0] = { case: document.embedding.queries[0].case, text: document.embedding.queries[0].text, failure: 'Traceback sk-gizli', latencyMs: 1 }; }, /tutarsız/],
    'hata ve vektör': [(document) => { document.embedding.queries[0].failure = 'INFERENCE_FAILED'; }, /tutarsız/],
    'fazla skor': [(document) => { document.rerank.queries[0].scores.push({ id: 'rota_hayalet', score: 1 }); }, /eşleşmiyor/],
    'yabancı skor': [(document) => { document.rerank.queries[0].scores[0].id = 'rota_hayalet'; }, /yabancı/],
    'yerel köken': [(document) => { document.embedding.model = '/yerel/model'; }, /kökeni/],
    'toplu iş boyutu yok': [(document) => { delete document.embedding.batchSize; }, /toplu iş/],
    'sıfır toplu iş boyutu': [(document) => { document.rerank.batchSize = 0; }, /toplu iş/],
    ortam: [(document) => { document.environment = { trace: 'x'.repeat(500) }; }, /ortam/]
  };
  for (const [label, [change, message]] of Object.entries(rejected)) {
    const result = await cli('report', '--run', await write(`${label}.json`, change, { rerank: true }));
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, message, label);
  }
  const broken = await cli('report', '--json', '--run', await write('bozuk.json', (document) => {
    document.embedding.queries[0].vector[0] = null;
    document.embedding.queries[1].vector = document.embedding.queries[1].vector.slice(0, 3);
    document.embedding.queries[2] = { case: document.embedding.queries[2].case, text: document.embedding.queries[2].text, failure: 'INFERENCE_FAILED', latencyMs: 5 };
  }));
  assert.equal(broken.code, 0, broken.stderr);
  assert.deepEqual(JSON.parse(broken.stdout).summary.outcomes.embedding, { ok: BENCHMARK.cases.length - 3, invalid: 2, timeout: 0, failed: 1 });
  // Sınır en derin ölçü kesiminden sığ olamaz: toplanmamış derinlik ölçülmez.
  for (const limit of ['0', '4', '21', '1.5']) {
    const result = await cli('report', '--run', runFile, '--limit', limit);
    assert.equal(result.code, 1, limit);
    assert.match(result.stderr, /--limit/, limit);
  }
  assert.equal((await cli('report')).code, 1);
  assert.equal((await cli('bilinmeyen')).code, 1);
  // Bağlantılı yoldan çağrılan komut da çalışır; sessizce başarılı çıkmaz.
  const linked = path.join(directory, 'depo');
  await symlink(ROOT, linked, 'junction');
  const viaLink = await run(process.execPath, [path.join(linked, 'scripts/semantic-evaluation.mjs'), 'input'], { cwd: ROOT, maxBuffer: 1 << 24 });
  assert.equal(JSON.parse(viaLink.stdout).catalogue, input.catalogue);
  const unknown = await run(process.execPath, [path.join(linked, 'scripts/semantic-evaluation.mjs'), 'bilinmeyen']).catch((error) => error);
  assert.equal(unknown.code, 1);
});

test('katalog yalnızca tekil kimlik ister: aynı açıklamalı iki öğe yeniden oynatımda kendi kimliğinin çıktısını alır', async () => {
  const { readModelRun, recordedModels } = await import('../scripts/semantic-evaluation.mjs');
  const { createSemanticCatalogue } = await import('../src/domain/ai/semanticContract.js');
  const { collectSemanticRun, summarizeSemanticRun, validateSemanticBenchmark } = await import('../src/domain/ai/semanticEvaluation.js');
  const built = createSemanticCatalogue([
    { id: 'rota_a', kind: 'tool', version: 1, text: 'Görevleri listeler' },
    { id: 'rota_b', kind: 'tool', version: 1, text: 'Görevleri listeler' },
    { id: 'rota_c', kind: 'tool', version: 1, text: 'Projeleri özetler' }
  ]);
  assert.equal(built.ok, true);
  const { catalogue } = built;
  const validated = validateSemanticBenchmark({
    format: 'mergen-rota-semantic-benchmark', version: 1, language: 'tr', tags: { ornek: 'Örnek' },
    cases: [
      { id: 'toy-001', text: 'Birinci soru', expect: 'answer', needs: [['rota_b']], tags: ['ornek'] },
      { id: 'toy-002', text: 'İkinci soru', expect: 'answer', needs: [['rota_a']], tags: ['ornek'] }
    ]
  }, catalogue);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  const { benchmark } = validated;
  const ids = catalogue.items.map((item) => item.id);
  const oneHot = (id) => ids.map((other) => (other === id ? 1 : 0));
  // Aynı metinli öğelerin vektörleri ve skorları farklıdır: metinle eşleme yanlış öğeye düşerdi.
  const target = { 'toy-001': 'rota_b', 'toy-002': 'rota_a' };
  const raw = {
    format: 'mergen-rota-semantic-model-run', version: 1, benchmark: benchmark.fingerprint, catalogue: catalogue.fingerprint,
    embedding: {
      model: 'kahin-gomme', provider: 'test', preprocessing: 'none', queryPrefix: '', documentPrefix: '', batchSize: 8, documentLatencyMs: 1,
      documents: catalogue.items.map(({ id, text }) => ({ id, text, vector: oneHot(id) })),
      queries: benchmark.cases.map(({ id, text }) => ({ case: id, text, vector: oneHot(target[id]), latencyMs: 1 }))
    },
    rerank: {
      model: 'kahin-siralama', provider: 'test', batchSize: 8,
      queries: benchmark.cases.map(({ id }) => ({ case: id, latencyMs: 1, scores: ids.map((item) => ({ id: item, score: item === target[id] ? 0.9 : item === 'rota_c' ? 0.5 : 0.1 })) }))
    },
    environment: null
  };
  const context = { catalogue, benchmark };
  const run = await collectSemanticRun({ ...context, ...recordedModels(readModelRun(raw, context), context), limit: 3 });
  assert.equal(run.index.outcome, 'ok');
  for (const entry of run.cases) {
    assert.equal(entry.firstStage[0].id, target[entry.case], entry.case);
    assert.deepEqual(entry.reranked.map(({ id, relevance }) => [id, relevance]), [[target[entry.case], 0.9], ['rota_c', 0.5], [target[entry.case] === 'rota_a' ? 'rota_b' : 'rota_a', 0.1]], entry.case);
  }
  const summary = summarizeSemanticRun(run, benchmark, { cutoffs: [1, 3], ndcgCutoff: 3 });
  assert.deepEqual([summary.stages.embedding.answer.hitAt1, summary.stages.reranked.answer.hitAt1], [1, 1]);
});

/* ── Üretim yolundan nitelendirme: ağ geçidi + bağdaştırıcı + yerel HTTP ikizi ── */

const { registerServerOnlyShim } = await import('./helpers/serverOnlyShim.mjs');
registerServerOnlyShim();
const { startFakeOpenAiCompatibleServer } = await import('./helpers/fakeOpenAiCompatibleServer.mjs');
const { createSemanticCatalogue: liveCatalogue, semanticToolDefinitions } = await import('../src/domain/ai/semanticContract.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { AI_PROFILES, resolveModelProfile, validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');

const LIVE_KEY = 'rota-canli-nitelendirme-anahtari';
const ITEMS = liveCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name)))).catalogue.items;
const ROUTES = (() => {
  const registry = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry;
  return { embedding: resolveModelProfile(registry, AI_PROFILES.EMBEDDING).route, rerank: resolveModelProfile(registry, AI_PROFILES.RERANK).route };
})();
const PARAPHRASE = (text) => `${text} — başka sözle`;

/**
 * Kâhin uç: belge → konumunun birim vektörü (yalnızca `passage: ` önekiyle
 * tanınır), sorgu → ihtiyaç gruplarının ilk adayları (yalnızca `query: `
 * önekiyle tanınır), skor → ihtiyaç ise 1. Önek eksikse ya da yeniden
 * sıralamaya önekli metin giderse ölçü kusursuz olamaz.
 */
function oracleEndpoint() {
  const position = new Map(ITEMS.map((item, index) => [`passage: ${item.text}`, index]));
  const byText = new Map(BENCHMARK.cases.flatMap((testCase) => [[testCase.text, testCase], [PARAPHRASE(testCase.text), testCase]]));
  const firsts = (testCase) => new Set((testCase.needs || []).map((group) => group[0]));
  return {
    embed(text) {
      if (position.has(text)) return ITEMS.map((_, index) => (index === position.get(text) ? 1 : 0));
      const testCase = text.startsWith('query: ') ? byText.get(text.slice(7)) : null;
      return ITEMS.map((item) => (!testCase || testCase.expect === 'abstain' || firsts(testCase).has(item.id) ? 1 : 0));
    },
    rerank(query, document) {
      const testCase = byText.get(query);
      const item = ITEMS.find((entry) => entry.text === document);
      return testCase && item && (testCase.needs || []).flat().includes(item.id) ? 1 : 0;
    }
  };
}

const FETCH_FAULT = path.join(ROOT, 'test/helpers/fetchFaultPreload.mjs');

/**
 * Komut alt süreçte, boş bir çalışma dizininde koşar: geliştiricinin `.env.local`
 * dosyası sınamaya karışmaz. `envFile` verilirse o dizine `.env.local` yazılır;
 * `shell: false` yapay zekâ değişkenlerini kabuktan vermez. `fault` alt sürece
 * tek bir `fetch` arızası yükler (bkz. helpers/fetchFaultPreload.mjs).
 */
async function live(t, { env = {}, args = [], semantic = oracleEndpoint(), envFile = null, shell = true, fault = null } = {}) {
  const server = await startFakeOpenAiCompatibleServer({ semantic });
  t.after(() => server.close());
  const cwd = await mkdtemp(path.join(tmpdir(), 'rota-semantic-cwd-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (envFile) await writeFile(path.join(cwd, '.env.local'), envFile(server), 'utf8');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MERGEN_ROTA_') && key !== 'NODE_OPTIONS'));
  const environment = {
    ...inherited,
    ...(shell ? { MERGEN_ROTA_AI_ENABLED: 'true', MERGEN_ROTA_AI_BASE_URL: server.baseUrl, MERGEN_ROTA_AI_DEFAULT_API_KEY: LIVE_KEY } : {}),
    ...(fault ? { ROTA_TEST_FETCH_FAULT: fault } : {}),
    ...env
  };
  for (const [key, value] of Object.entries(environment)) if (value == null) delete environment[key];
  const node = fault ? ['--import', pathToFileURL(FETCH_FAULT).href] : [];
  try {
    const { stdout, stderr } = await run(process.execPath, [...node, SCRIPT, 'live', ...args], { cwd, env: environment });
    return { code: 0, stdout, stderr, server };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, server };
  }
}

test('canlı nitelendirme kıyas kümesini üretim yolundan geçirir: profil ve önekler kayıttan, katalog bir kez, yeniden sıralama ilk aşama adaylarına', { timeout: 120000 }, async (t) => {
  const result = await live(t, { args: ['--json'] });
  assert.equal(result.code, 0, result.stderr);
  const { qualification, summary, index } = JSON.parse(result.stdout);
  assert.deepEqual(qualification.run, { format: 'mergen-rota-semantic-run', version: 1, path: 'gateway' });
  assert.deepEqual(qualification.embedding, {
    profile: AI_PROFILES.EMBEDDING, model: ROUTES.embedding.model, provider: ROUTES.embedding.provider,
    preprocessing: ROUTES.embedding.preprocessing.id, queryPrefix: 'query: ', documentPrefix: 'passage: ', truncateTokens: 512, runtime: 'gateway'
  });
  assert.deepEqual(qualification.reranker, { profile: AI_PROFILES.RERANK, model: ROUTES.rerank.model, provider: ROUTES.rerank.provider, runtime: 'gateway' });
  assert.deepEqual(qualification.latencyWorkload.rerank, { documentsPerCall: 10, calls: BENCHMARK.cases.length, batchSize: 10 });
  assert.deepEqual({ outcome: index.outcome, dimensions: index.dimensions }, { outcome: 'ok', dimensions: ITEMS.length });
  assert.match(index.identity, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.outcomes.embedding, { ok: BENCHMARK.cases.length, invalid: 0, timeout: 0, failed: 0 });
  assert.deepEqual(summary.outcomes.rerank, { ok: BENCHMARK.cases.length, invalid: 0, timeout: 0, failed: 0 });
  assert.equal(summary.stages.embedding.answer.hitAt1, 1);
  assert.equal(summary.stages.reranked.answer.hitAt1, 1);
  assert.equal(summary.latency.embedding.count, BENCHMARK.cases.length);
  // Uca giden: tek katalog gömmesi (önekli), vaka başına tek önekli sorgu, ilk aşamanın 10 adayının öneksiz yeniden sıralaması.
  const { requests } = result.server.state;
  const embeddings = requests.filter((request) => request.path === '/v1/embeddings');
  assert.equal(embeddings.length, 1 + BENCHMARK.cases.length);
  assert.deepEqual(embeddings[0].body.input, ITEMS.map((item) => `passage: ${item.text}`));
  // Belirteç penceresi kuralı üretimle aynıdır: önek dâhil ilk 512 belirteç, sağdan kesme.
  assert.ok(embeddings.every((request) => request.body.truncate_prompt_tokens === 512 && !Object.hasOwn(request.body, 'truncation_side')));
  assert.ok(embeddings.slice(1).every((request) => request.body.input.length === 1 && request.body.input[0].startsWith('query: ')));
  const reranks = requests.filter((request) => request.path === '/v1/rerank');
  assert.equal(reranks.length, BENCHMARK.cases.length);
  assert.ok(reranks.every((request) => request.body.documents.length === 10 && request.body.top_n === 10 && !request.body.query.startsWith('query: ')));
  assert.ok(requests.every((request) => request.bearer === LIVE_KEY));

  const markdown = await live(t);
  assert.equal(markdown.code, 0, markdown.stderr);
  assert.match(markdown.stdout, /çağrı başına ilk aşamanın 10 adayı, üretimdeki gibi/);
  assert.match(markdown.stdout, /\| Top-1 \| 1\.000 \| 1\.000 \| \+0\.000 \|/);
});

test('canlı nitelendirme başka ifadeleri aynı altın etiketlerle ölçer; bozuk soru dosyası ve kullanılamayan yapılandırma reddedilir', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-semantic-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (name, rows) => {
    const file = path.join(directory, name);
    await writeFile(file, JSON.stringify(rows), 'utf8');
    return file;
  };
  const rows = BENCHMARK.cases.map((testCase) => ({ case: testCase.id, text: `  ${PARAPHRASE(testCase.text)} ` }));
  const official = JSON.parse((await live(t, { args: ['--json'] })).stdout).summary.benchmark;
  const paraphrased = await live(t, { args: ['--json', '--queries', await write('sorular.json', rows)] });
  assert.equal(paraphrased.code, 0, paraphrased.stderr);
  const summary = JSON.parse(paraphrased.stdout).summary;
  assert.notEqual(summary.benchmark, official, 'türetilen kümenin parmak izi farklıdır');
  assert.equal(summary.stages.reranked.answer.hitAt1, 1);
  const queries = paraphrased.server.state.requests.filter((request) => request.path === '/v1/embeddings').slice(1);
  assert.equal(queries[0].body.input[0], `query: ${PARAPHRASE(BENCHMARK.cases[0].text)}`, 'metin normalleşir');
  const rowError = /Soru dosyasında yabancı, yinelenen ya da geçersiz satır var/;
  for (const [label, broken, message] of [
    ['eksik', rows.slice(1), /her kıyas vakası için tam bir satır/],
    ['yinelenen', [...rows.slice(1), rows[1]], rowError],
    ['yabancı', [...rows.slice(1), { case: 'tr-999', text: 'Yeni' }], rowError],
    ['fazla alan', [{ ...rows[0], expect: 'abstain' }, ...rows.slice(1)], rowError],
    ['boş metin', [{ ...rows[0], text: ' ' }, ...rows.slice(1)], rowError],
    ['aynı metin', [{ ...rows[0], text: rows[1].text }, ...rows.slice(1)], /Kıyas kümesi geçersiz: cases\[\d+\]\.text:duplicate/]
  ]) {
    const result = await live(t, { args: ['--queries', await write(`${label}.json`, broken)] });
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, message, label);
    assert.equal(result.server.state.requests.length, 0, `${label}: model çağrılmadı`);
  }
  // Yalnızca kişisel anahtarlar yapılandırılmışsa (geçerli ana anahtar) operatör komutunun kullanacağı anahtar yoktur.
  const masterKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
  const keyless = await live(t, { env: { MERGEN_ROTA_AI_DEFAULT_API_KEY: null, MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: masterKey } });
  assert.equal(keyless.code, 1);
  assert.match(keyless.stderr, /MERGEN_ROTA_AI_DEFAULT_API_KEY gerekli/);
  assert.equal(keyless.server.state.requests.length, 0);
  const disabled = await live(t, { env: { MERGEN_ROTA_AI_ENABLED: 'false' } });
  assert.equal(disabled.code, 1);
  assert.match(disabled.stderr, /MERGEN_ROTA_AI_ENABLED/);
  const zero = await live(t, { semantic: { embed: () => ITEMS.map(() => 0), rerank: () => 0 } });
  assert.equal(zero.code, 1);
  assert.match(zero.stderr, /Katalog gömmesi başarısız \(ZERO_VECTOR\)/);
});

test('canlı nitelendirmede yeniden sıralama profili kapalıysa yalnızca ilk aşama ölçülür', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-semantic-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'kayit.json');
  const document = JSON.parse(JSON.stringify(DEFAULT_AI_MODEL_REGISTRY));
  document.profiles.rerank = { ...document.profiles.rerank, enabled: false };
  await writeFile(file, JSON.stringify(document), 'utf8');
  const result = await live(t, { args: ['--json'], env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  assert.equal(result.code, 0, result.stderr);
  const { qualification, summary } = JSON.parse(result.stdout);
  assert.equal(qualification.reranker, null);
  assert.equal(summary.stages.reranked, null);
  assert.equal(result.server.state.requests.filter((request) => request.path === '/v1/rerank').length, 0);
});

/* ── Nitelendirmenin üretim yoluyla aynılığı ── */

test('canlı nitelendirme üretimin aday derinliğiyle ölçer; başka derinlik reddedilir ve model çağrılmaz', { timeout: 120000 }, async (t) => {
  for (const limit of ['5', '20']) {
    const result = await live(t, { args: ['--json', '--limit', limit] });
    assert.equal(result.code, 1, limit);
    assert.match(result.stderr, /aday derinliği üretimdeki 10 değeridir/, limit);
    assert.equal(result.server.state.requests.length, 0, limit);
  }
});

test('bozuk yeniden sıralama eşlemesi ilk aşama nitelendirmesine dönüşmez: kayıt reddedilir ve model çağrılmaz', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-semantic-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'kayit.json');
  const document = JSON.parse(JSON.stringify(DEFAULT_AI_MODEL_REGISTRY));
  // Yeniden sıralama profili yeteneği olmayan bir modele bağlanmış: bilinçli kapatma değil, yapılandırma hatasıdır.
  document.profiles.rerank = { ...document.profiles.rerank, model: 'Qwen3-Embedding-8B' };
  await writeFile(file, JSON.stringify(document), 'utf8');
  const result = await live(t, { args: ['--json'], env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Model kaydı yüklenemedi/);
  assert.equal(result.stdout, '');
  assert.equal(result.server.state.requests.length, 0);
});

test('yinelenen ama başarılı canlı koşuda stdout yalnızca ayrıştırılabilir JSON\'dur; işletim günlüğü stderr\'e gider', { timeout: 120000 }, async (t) => {
  const result = await live(t, { args: ['--json'], fault: 'refuse-first' });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.index.outcome, 'ok');
  assert.deepEqual(report.summary.outcomes.embedding, { ok: BENCHMARK.cases.length, invalid: 0, timeout: 0, failed: 0 });
  assert.match(result.stderr, /AI_PROVIDER_RETRY/);
  assert.doesNotMatch(result.stdout, /\[mergen-rota\]/);
});

test('canlı nitelendirme uygulamanın ortam kaynağını (`.env.local`) okur; kabuktaki değer önceliklidir ve anahtar yazılmaz', { timeout: 120000 }, async (t) => {
  const envFile = (server) => [
    'MERGEN_ROTA_AI_ENABLED=true',
    `MERGEN_ROTA_AI_BASE_URL=${server.baseUrl}`,
    `MERGEN_ROTA_AI_DEFAULT_API_KEY=${LIVE_KEY}`,
    ''
  ].join('\n');
  const loaded = await live(t, { args: ['--json'], envFile, shell: false });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).index.outcome, 'ok');
  assert.match(loaded.stderr, /\.env\.local/);
  assert.ok(loaded.server.state.requests.length > 0 && loaded.server.state.requests.every((request) => request.bearer === LIVE_KEY));
  assert.equal(`${loaded.stdout}${loaded.stderr}`.includes(LIVE_KEY), false);
  const overridden = await live(t, { args: ['--json'], envFile, shell: false, env: { MERGEN_ROTA_AI_ENABLED: 'false' } });
  assert.equal(overridden.code, 1);
  assert.match(overridden.stderr, /MERGEN_ROTA_AI_ENABLED/);
  assert.equal(overridden.server.state.requests.length, 0);
});

test('ağ geçidinin süre aşımı nitelendirmede süre aşımı olarak sayılır; koşu sürer', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-semantic-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'kayit.json');
  const document = JSON.parse(JSON.stringify(DEFAULT_AI_MODEL_REGISTRY));
  document.profiles.rerank = { ...document.profiles.rerank, timeoutMs: 1000 };
  await writeFile(file, JSON.stringify(document), 'utf8');
  const result = await live(t, { args: ['--json'], env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file }, fault: 'delay-first-rerank:2500' });
  assert.equal(result.code, 0, result.stderr);
  const { summary, qualification } = JSON.parse(result.stdout);
  assert.deepEqual(summary.outcomes.rerank, { ok: BENCHMARK.cases.length - 1, invalid: 0, timeout: 1, failed: 0 });
  assert.equal(qualification.latencyWorkload.rerank.calls, BENCHMARK.cases.length);
});

test('nitelendirme iş yükü yalnızca gerçekten yapılan çağrıları sayar; dış süre sınırı ağ geçidinin en uzun yaşam döngüsünü kapsar', { timeout: 30000 }, async () => {
  const { liveCallTimeoutMs, liveWorkload } = await import('../scripts/semantic-evaluation.mjs');
  const { collectSemanticRun, summarizeSemanticRun, validateSemanticBenchmark, SEMANTIC_MAX_CALL_TIMEOUT_MS } = await import('../src/domain/ai/semanticEvaluation.js');
  const { createEmbeddingSpace, createSemanticCatalogue, semanticModelProvenance } = await import('../src/domain/ai/semanticContract.js');
  const catalogue = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name)))).catalogue;
  const benchmark = validateSemanticBenchmark(BENCHMARK, catalogue).benchmark;
  const space = createEmbeddingSpace(semanticModelProvenance(ROUTES.embedding, AI_PROFILES.EMBEDDING), 'e5-query-passage');
  let queries = 0;
  // İkinci sorgu iptale uymaz ve hiç sonuçlanmaz: koşu durur, kalan vakalar çağrılmaz.
  const embed = (texts, { purpose }) => {
    if (purpose === 'document') return Promise.resolve(texts.map((_, index) => ({ index, vector: ITEMS.map((__, j) => (j === index ? 1 : 0)) })));
    queries += 1;
    return queries === 2 ? new Promise(() => {}) : Promise.resolve([{ index: 0, vector: ITEMS.map(() => 1) }]);
  };
  const run = await collectSemanticRun({ benchmark, catalogue, embedding: { space, embed }, callTimeoutMs: 20 });
  const summary = summarizeSemanticRun(run, benchmark);
  const workload = liveWorkload(summary, { documents: ITEMS.length, rerankDepth: null });
  assert.equal(queries, 2);
  assert.deepEqual(workload.embedding, { queriesPerCall: 1, calls: 2 });
  assert.equal(workload.rerank, null);
  // En uzun meşru ağ geçidi çağrısı: rehber 5 s + sıra (en çok 120 s) + rota (en çok 600 s).
  const longest = liveCallTimeoutMs({ queueTimeoutMs: 120000 }, [600000, 1000]);
  assert.ok(longest > 5000 + 120000 + 600000 && longest <= SEMANTIC_MAX_CALL_TIMEOUT_MS);
  assert.equal(liveCallTimeoutMs({ queueTimeoutMs: 20000 }, [90000]), 5000 + 20000 + 90000 + 5000);
});
