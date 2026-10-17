/**
 * Rota AI anlamsal değerlendirme komutu — geliştirme aracı; uygulama, CI ve
 * Rota sunucusu bu dosyayı çalıştırmaz.
 *
 *   node scripts/semantic-evaluation.mjs input [--out girdi.json]
 *     Kıyas kümesinin sorgularını ve Aşama 3 araç kataloğunun belgelerini,
 *     parmak izleriyle birlikte model koşucusunun girdisi olarak yazar.
 *
 *   node scripts/semantic-evaluation.mjs report --run kosu.json [--limit 10] [--json]
 *     Model koşucusunun ham çıktısını (vektörler, skorlar) üretimle AYNI
 *     sözleşmeden ve değerlendirme koşucusundan geçirir. Başka bir kıyas kümesi
 *     ya da katalogla üretilmiş (bayat) koşuyu reddeder.
 *
 * Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_FILE = path.join(ROOT, 'test/fixtures/ai-semantic-benchmark.json');
const INPUT_FORMAT = 'mergen-rota-semantic-input';
const MODEL_RUN_FORMAT = 'mergen-rota-semantic-model-run';

const {
  SEMANTIC_LIMITS, createEmbeddingSpace, createSemanticCatalogue, semanticModelProvenance, semanticToolDefinitions
} = await import('../src/domain/ai/semanticContract.js');
const {
  SEMANTIC_EVALUATION_DEFAULTS, collectSemanticRun, semanticLatencySummary, summarizeSemanticRun, validateSemanticBenchmark
} = await import('../src/domain/ai/semanticEvaluation.js');
const { AI_PROFILES } = await import('../src/domain/ai/aiModelRegistry.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments([command, ...rest]) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json') flags.json = true;
    else if (['--out', '--run', '--limit'].includes(rest[i]) && rest[i + 1]) flags[rest[i].slice(2)] = rest[++i];
    else fail(`Tanınmayan bağımsız değişken: ${rest[i]}`);
  }
  return { command, flags };
}

function load() {
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  if (!built.ok) fail(`Araç kataloğu geçersiz: ${built.issues.join(', ')}`);
  const validated = validateSemanticBenchmark(JSON.parse(readFileSync(BENCHMARK_FILE, 'utf8')), built.catalogue);
  if (!validated.ok) fail(`Kıyas kümesi geçersiz: ${validated.issues.join(', ')}`);
  return { catalogue: built.catalogue, benchmark: validated.benchmark };
}

function writeInput({ catalogue, benchmark }, out) {
  const json = `${JSON.stringify({
    format: INPUT_FORMAT,
    version: 1,
    benchmark: benchmark.fingerprint,
    catalogue: catalogue.fingerprint,
    documents: catalogue.items.map(({ id, text }) => ({ id, text })),
    queries: benchmark.cases.map(({ id, text }) => ({ case: id, text }))
  }, null, 2)}\n`;
  if (out) writeFileSync(out, json, 'utf8');
  else process.stdout.write(json);
}

/** Koşu dosyasındaki girişler anahtarına göre tekil olmalıdır; yinelenen giriş sessizce ezilmez. */
function keyed(entries, key, value, label) {
  const list = Array.isArray(entries) ? entries : [];
  const map = new Map(list.map((entry) => [entry?.[key], value(entry)]));
  if (map.size !== list.length) fail(`Koşu dosyasında yinelenen ${label} girişi var.`);
  return map;
}

function provenanceOf(section, profile, capability) {
  return semanticModelProvenance({ profile, model: section?.model, provider: section?.provider, capabilities: [capability] }, profile);
}

/** Koşucunun önceden hesapladığı çıktıları model sınırı işlevlerine çevirir; eksik değer sözleşmede reddedilir. */
function recordedModels(run, { catalogue, benchmark }) {
  const caseOf = new Map(benchmark.cases.map((testCase) => [testCase.text, testCase.id]));
  const itemOf = new Map(catalogue.items.map((item) => [item.text, item.id]));
  if (itemOf.size !== catalogue.items.length) fail('Katalog belge metinleri tekil değil; kayıtlı çıktılar belgelere eşlenemez.');
  const documents = keyed(run.embedding?.documents, 'id', (entry) => entry?.vector, 'belge');
  const queries = keyed(run.embedding?.queries, 'case', (entry) => entry?.vector, 'sorgu');
  const space = createEmbeddingSpace(provenanceOf(run.embedding, AI_PROFILES.EMBEDDING, 'embedding'), run.embedding?.preprocessing);
  if (!space) fail('Koşu dosyasındaki gömme modeli kökeni ya da ön işleme belirteci geçersiz.');
  const embed = async (texts, { purpose }) => texts.map((text, index) => ({
    index, vector: purpose === 'document' ? documents.get(itemOf.get(text)) : queries.get(caseOf.get(text))
  }));
  if (!run.rerank) return { embedding: { space, embed }, reranking: null };
  const provenance = provenanceOf(run.rerank, AI_PROFILES.RERANK, 'rerank');
  if (!provenance) fail('Koşu dosyasındaki yeniden sıralama modeli kökeni geçersiz.');
  const scores = keyed(run.rerank.queries, 'case', (entry) => keyed(entry?.scores, 'id', (score) => score?.score, 'skor'), 'yeniden sıralama');
  const rerank = async (query, texts) => texts.map((text, index) => ({ index, score: scores.get(caseOf.get(query))?.get(itemOf.get(text)) }));
  return { embedding: { space, embed }, reranking: { provenance, rerank } };
}

const percent = (value) => (value == null ? '—' : value.toFixed(3));
const signed = (value) => (value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`);

function markdown(summary, run, benchmark) {
  const { embedding, reranked } = summary.stages;
  const final = reranked || embedding;
  const textOf = new Map(benchmark.cases.map((testCase) => [testCase.id, testCase]));
  const [k1, , kMax] = SEMANTIC_EVALUATION_DEFAULTS.cutoffs;
  const row = (label, pick, delta = null) => `| ${label} | ${percent(pick(embedding))} | ${reranked ? percent(pick(reranked)) : '—'} | ${reranked ? signed(delta) : '—'} |`;
  const latency = (value) => (value ? `p50 ${Math.round(value.p50)} ms · p95 ${Math.round(value.p95)} ms · en çok ${Math.round(value.max)} ms (${value.count})` : '—');
  return [
    '# Rota AI anlamsal nitelendirme raporu',
    '',
    `- Kıyas kümesi: \`${summary.benchmark.slice(0, 16)}\` · ${summary.cases.total} vaka (${summary.cases.answer} yanıt, ${summary.cases.clarify} açıklama, ${summary.cases.abstain} kapsam dışı)`,
    `- Gömme: ${run.embedding.model} (${run.embedding.provider}, ön işleme \`${run.embedding.preprocessing}\`)${run.embedding.runtime ? ` · ${run.embedding.runtime}` : ''}`,
    `- Yeniden sıralama: ${run.rerank ? `${run.rerank.model} (${run.rerank.provider})` : 'yok'}`,
    `- Ortam: ${run.environment ? JSON.stringify(run.environment) : '—'}`,
    `- Model çıktısı: gömme ${JSON.stringify(summary.outcomes.embedding)}${summary.outcomes.rerank ? ` · yeniden sıralama ${JSON.stringify(summary.outcomes.rerank)}` : ''}`,
    '',
    '| Ölçü (yanıt vakaları) | Gömme | Yeniden sıralama | Fark |',
    '| --- | ---: | ---: | ---: |',
    row('Top-1', (stage) => stage.answer.hitAt1, summary.uplift?.hitAt1),
    row('MRR', (stage) => stage.answer.mrr, summary.uplift?.mrr),
    ...SEMANTIC_EVALUATION_DEFAULTS.cutoffs.map((k) => row(`Recall@${k}`, (stage) => stage.answer.recall[k], summary.uplift?.recall[k])),
    row(`Kapsama@${kMax}`, (stage) => stage.answer.coverage[kMax]),
    row(`NDCG@${SEMANTIC_EVALUATION_DEFAULTS.ndcgCutoff}`, (stage) => stage.answer.ndcg, summary.uplift?.ndcg),
    row('Kaçınma çifti tutarlılığı', (stage) => stage.answer.avoid.rate),
    row(`Açıklama vakalarında kapsama@${kMax}`, (stage) => stage.clarifyCoverage.rate),
    row('Kapsam dışı ayrılabilirliği (AUROC)', (stage) => stage.abstainSeparability),
    '',
    `Gecikme (koşucunun ölçtüğü): katalog ${summary.latency.index == null ? '—' : `${Math.round(summary.latency.index)} ms`} · sorgu gömme ${latency(summary.latency.embedding)} · yeniden sıralama ${latency(summary.latency.rerank)}`,
    '',
    `## Etikete göre Top-1 (${reranked ? 'yeniden sıralama' : 'gömme'})`,
    '',
    '| Etiket | Vaka | Top-1 | MRR |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(final.byTag).map(([tag, value]) => `| ${tag} | ${value.cases} | ${percent(value.hitAt1)} | ${percent(value.mrr)} |`),
    '',
    `## Top-${k1} ıskaları (${reranked ? 'yeniden sıralama' : 'gömme'})`,
    '',
    ...final.misses.map(({ case: id, top }) => `- \`${id}\` “${textOf.get(id).text}” → beklenen ${JSON.stringify(textOf.get(id).needs)}, ilk üç ${JSON.stringify(top)}`),
    ''
  ].join('\n');
}

async function report(context, flags) {
  if (!flags.run) fail('--run koşu dosyası gerekli.');
  const run = JSON.parse(readFileSync(flags.run, 'utf8'));
  if (run?.format !== MODEL_RUN_FORMAT || run.version !== 1) fail('Koşu dosyasının biçimi tanınmadı.');
  if (run.benchmark !== context.benchmark.fingerprint || run.catalogue !== context.catalogue.fingerprint) {
    fail('Koşu dosyası bayat: başka bir kıyas kümesi ya da araç kataloğuyla üretilmiş. Girdiyi yeniden üretip modelleri yeniden koşun.');
  }
  const models = recordedModels(run, context);
  const limit = flags.limit == null ? SEMANTIC_EVALUATION_DEFAULTS.limit : Number(flags.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) {
    fail(`--limit 1 ile ${SEMANTIC_LIMITS.maxCandidates} arasında bir tam sayı olmalıdır.`);
  }
  const collected = await collectSemanticRun({ ...context, ...models, limit });
  const summary = summarizeSemanticRun(collected, context.benchmark);
  // Kayıtlı çıktı anında okunur; gecikme koşucunun gerçek model ölçümüdür.
  summary.latency = {
    index: Number.isFinite(run.embedding?.documentLatencyMs) ? run.embedding.documentLatencyMs : null,
    embedding: semanticLatencySummary((run.embedding?.queries || []).map((entry) => entry?.latencyMs)),
    rerank: run.rerank ? semanticLatencySummary((run.rerank.queries || []).map((entry) => entry?.latencyMs)) : null
  };
  if (flags.json) {
    // Dizin kaydının süresi kayıtlı çıktının okunma süresidir; gerçek gecikme `summary.latency` içindedir.
    const { outcome, reason = null, identity = null, dimensions = null } = collected.index;
    process.stdout.write(`${JSON.stringify({ summary, index: { outcome, reason, identity, dimensions }, environment: run.environment ?? null }, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(summary, run, context.benchmark));
  }
}

const { command, flags } = parseArguments(process.argv.slice(2));
if (command === 'input') writeInput(load(), flags.out);
else if (command === 'report') await report(load(), flags);
else fail('Kullanım: node scripts/semantic-evaluation.mjs input [--out dosya] | report --run dosya [--limit 10] [--json]');
