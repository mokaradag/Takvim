/**
 * Yapay zekâ · anlamsal model nitelendirme komutu.
 *
 * `scripts/semantic-evaluation.mjs` gerçek model koşucusunun (Python) ham
 * çıktısını üretimle aynı sözleşmeden geçirir. Bu sınama Python ya da model
 * gerektirmez: koşu dosyasını kâhin vektörlerle kendisi üretir. Girdinin
 * parmak izleri, bayat ya da yinelenen koşunun reddi ve bozuk değerin ıska
 * sayılması doğrulanır.
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

/** Kâhin koşu dosyası: belge i → birim vektör i; sorgu → ilk ihtiyaç adaylarının toplamı. */
function oracleRun(input) {
  const ids = input.documents.map((document) => document.id);
  const cases = new Map(BENCHMARK.cases.map((testCase) => [testCase.id, testCase]));
  const firsts = (testCase) => new Set((testCase.needs || []).map((group) => group[0]));
  const vector = (testCase) => (testCase.expect === 'abstain' ? ids.map(() => 1) : ids.map((id) => (firsts(testCase).has(id) ? 1 : 0)));
  return {
    format: 'mergen-rota-semantic-model-run',
    version: 1,
    benchmark: input.benchmark,
    catalogue: input.catalogue,
    embedding: {
      model: 'kahin-gomme',
      provider: 'test',
      preprocessing: 'none',
      documentLatencyMs: 12,
      documents: ids.map((id, position) => ({ id, vector: ids.map((_, i) => (i === position ? 1 : 0)) })),
      queries: input.queries.map((query, position) => ({ case: query.case, vector: vector(cases.get(query.case)), latencyMs: position + 1 }))
    },
    rerank: null,
    environment: { device: 'test' }
  };
}

test('girdi parmak izli ve kanoniktir; kâhin koşu dosyası aynı sözleşmeden kusursuz ölçüyle geçer', { timeout: 60000 }, async (t) => {
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

  const runFile = path.join(directory, 'kosu.json');
  await writeFile(runFile, JSON.stringify(oracleRun(input)));
  const report = await cli('report', '--run', runFile, '--json');
  assert.equal(report.code, 0, report.stderr);
  const { summary, index } = JSON.parse(report.stdout);
  // Kayıtlı çıktının okunma süresi model gecikmesi gibi raporlanmaz.
  assert.deepEqual(Object.keys(index), ['outcome', 'reason', 'identity', 'dimensions']);
  assert.equal(index.outcome, 'ok');
  assert.equal(summary.stages.embedding.answer.hitAt1, 1);
  assert.equal(summary.stages.embedding.answer.ndcg, 1);
  assert.equal(summary.stages.embedding.abstainSeparability, 1);
  assert.deepEqual(summary.outcomes.embedding, { ok: BENCHMARK.cases.length, invalid: 0, timeout: 0, failed: 0 });
  assert.equal(summary.latency.index, 12);
  assert.equal(summary.latency.embedding.max, BENCHMARK.cases.length);
  const markdown = await cli('report', '--run', runFile);
  assert.equal(markdown.code, 0);
  assert.match(markdown.stdout, /^# Rota AI anlamsal nitelendirme raporu/);
  assert.match(markdown.stdout, /\| Top-1 \| 1\.000 \| — \| — \|/);

  // Bayat, yinelenen ya da bozuk kökenli koşu reddedilir; bozuk değer ıska sayılır.
  const write = async (name, change) => {
    const file = path.join(directory, name);
    const document = oracleRun(input);
    change(document);
    await writeFile(file, JSON.stringify(document));
    return file;
  };
  const stale = await cli('report', '--run', await write('bayat.json', (document) => { document.catalogue = '0'.repeat(64); }));
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /bayat/);
  const duplicate = await cli('report', '--run', await write('yinelenen.json', (document) => { document.embedding.queries.push(document.embedding.queries[0]); }));
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /yinelenen/);
  const origin = await cli('report', '--run', await write('koken.json', (document) => { document.embedding.model = '/yerel/model'; }));
  assert.equal(origin.code, 1);
  const broken = await cli('report', '--json', '--run', await write('bozuk.json', (document) => {
    document.embedding.queries[0].vector[0] = null;
    document.embedding.queries[1].vector = document.embedding.queries[1].vector.slice(0, 3);
  }));
  assert.equal(broken.code, 0, broken.stderr);
  assert.deepEqual(JSON.parse(broken.stdout).summary.outcomes.embedding, { ok: BENCHMARK.cases.length - 2, invalid: 2, timeout: 0, failed: 0 });
  for (const limit of ['0', '21', '1.5']) {
    const rejected = await cli('report', '--run', runFile, '--limit', limit);
    assert.equal(rejected.code, 1, limit);
    assert.match(rejected.stderr, /--limit/, limit);
  }
  assert.equal((await cli('report')).code, 1);
  assert.equal((await cli('bilinmeyen')).code, 1);
});
