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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
      documentLatencyMs: 12,
      documents: input.documents.map(({ id, text }, position) => ({ id, text, vector: ids.map((_, i) => (i === position ? 1 : 0)) })),
      queries: input.queries.map((query, position) => ({ case: query.case, text: query.text, vector: vector(cases.get(query.case)), latencyMs: position + 1 }))
    },
    rerank: rerank ? {
      model: 'kahin-siralama',
      provider: 'test',
      runtime: 'test',
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
  assert.deepEqual(second.qualification.latencyWorkload.rerank, { documentsPerCall: input.documents.length, calls: BENCHMARK.cases.length });
  // Sorgu düzeyindeki çıkarım hatası ıska sayılır; tamamlanan ölçümler korunur.
  assert.deepEqual(second.summary.outcomes.rerank, { ok: BENCHMARK.cases.length - 1, invalid: 0, timeout: 0, failed: 1 });
  assert.equal(second.summary.latency.rerank.count, BENCHMARK.cases.length);

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
});
