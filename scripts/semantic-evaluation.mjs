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

// Koşu dosyası güvenilmez girdidir: her bölüm kapalı şemadır, kimlik ve vaka kümeleri girdiyle BİREBİR aynıdır.
const RUN_FIELDS = ['format', 'version', 'benchmark', 'catalogue', 'embedding', 'rerank', 'environment'];
const EMBEDDING_FIELDS = ['model', 'provider', 'preprocessing', 'queryPrefix', 'documentPrefix', 'runtime', 'batchSize', 'documentLatencyMs', 'documents', 'queries'];
const RERANK_FIELDS = ['model', 'provider', 'runtime', 'batchSize', 'queries'];
// Koşucunun sorgu düzeyindeki çıkarım hatası için tek güvenli kod; hata iletisi kaydedilmez.
const INFERENCE_FAILED = 'INFERENCE_FAILED';
const MAX_TEXT = 200;
const MAX_BATCH_SIZE = 4096;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLatency = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const boundedText = (value) => typeof value === 'string' && value.length <= MAX_TEXT;
// Toplu iş boyutu ölçülen gecikmeyi değiştirir; künyenin parçasıdır.
const isBatchSize = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_BATCH_SIZE;
const isScore = (value) => typeof value === 'number' && Number.isFinite(value);

function closed(record, fields, label) {
  if (!isRecord(record) || Object.keys(record).some((key) => !fields.includes(key))) fail(`Koşu dosyasında ${label} bölümü tanınmadı.`);
  return record;
}

/** Satırlar beklenen anahtar kümesinin her öğesini tam bir kez taşımalıdır; eksik, fazla ya da yinelenen satır reddedilir. */
function exactRows(rows, key, expected, label) {
  if (!Array.isArray(rows) || rows.length !== expected.length) fail(`Koşu dosyasında ${label} satırları girdiyle eşleşmiyor.`);
  const byKey = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isRecord(row) || !expected.includes(row[key]) || byKey.has(row[key])) fail(`Koşu dosyasında yinelenen, yabancı ya da bozuk ${label} satırı var.`);
    byKey.set(row[key], row);
  }
  return byKey;
}

// Sorgu satırı ya vektör ya da güvenli hata kodu taşır; gecikme ölçülmüş ve negatif olmayan bir süredir.
function readOutcomeRow(row, fields, payload, label) {
  closed(row, fields, label);
  if (!isLatency(row.latencyMs)) fail(`Koşu dosyasında ${label} gecikmesi geçersiz.`);
  if (Object.hasOwn(row, 'failure') ? row.failure !== INFERENCE_FAILED || Object.hasOwn(row, payload) : !Object.hasOwn(row, payload)) {
    fail(`Koşu dosyasında ${label} sonucu tutarsız.`);
  }
  return row;
}

function readEnvironment(environment) {
  if (environment == null) return null;
  const entries = isRecord(environment) ? Object.entries(environment) : null;
  if (!entries || entries.length > 16 || entries.some(([, value]) => !(value === null || boundedText(value) || Number.isFinite(value)))) {
    fail('Koşu dosyasındaki ortam künyesi geçersiz.');
  }
  return Object.fromEntries(entries);
}

/**
 * Ham koşu dosyasını bir kez doğrulayıp güvenilir biçime çevirir: biçim/sürüm,
 * parmak izleri, model kökeni, ön işleme ve önekler, belgeler ve sorgular
 * (kimlik kümesi ve koşucunun GERÇEKTEN değerlendirdiği metin girdiyle birebir),
 * yeniden sıralama satırları ve skor kimlikleri, gecikmeler ve ortam.
 */
function readModelRun(raw, { catalogue, benchmark }) {
  const run = closed(raw, RUN_FIELDS, 'üst düzey');
  if (run.format !== MODEL_RUN_FORMAT || run.version !== 1) fail('Koşu dosyasının biçimi tanınmadı.');
  if (run.benchmark !== benchmark.fingerprint || run.catalogue !== catalogue.fingerprint) {
    fail('Koşu dosyası bayat: başka bir kıyas kümesi ya da araç kataloğuyla üretilmiş. Girdiyi yeniden üretip modelleri yeniden koşun.');
  }
  const embedding = closed(run.embedding, EMBEDDING_FIELDS, 'gömme');
  const { queryPrefix, documentPrefix } = embedding;
  if (!boundedText(queryPrefix) || !boundedText(documentPrefix) || (embedding.runtime !== undefined && !boundedText(embedding.runtime))) {
    fail('Koşu dosyasındaki önek ya da çalışma ortamı künyesi geçersiz.');
  }
  // Önek varsa ön işleme belirteci onu adlandırır; önek yoksa belirteç "none" kalır.
  if (Boolean(queryPrefix || documentPrefix) === (embedding.preprocessing === 'none')) fail('Koşu dosyasındaki önekler ön işleme belirteciyle çelişiyor.');
  const space = createEmbeddingSpace(provenanceOf(embedding, AI_PROFILES.EMBEDDING, 'embedding'), embedding.preprocessing);
  if (!space) fail('Koşu dosyasındaki gömme modeli kökeni ya da ön işleme belirteci geçersiz.');
  if (!isLatency(embedding.documentLatencyMs)) fail('Koşu dosyasındaki katalog gömme gecikmesi geçersiz.');
  if (!isBatchSize(embedding.batchSize)) fail('Koşu dosyasındaki gömme toplu iş boyutu geçersiz.');
  const itemIds = catalogue.items.map((item) => item.id);
  const caseIds = benchmark.cases.map((testCase) => testCase.id);
  const textOfItem = new Map(catalogue.items.map((item) => [item.id, item.text]));
  const textOfCase = new Map(benchmark.cases.map((testCase) => [testCase.id, testCase.text]));
  const documents = exactRows(embedding.documents, 'id', itemIds, 'belge');
  for (const [id, row] of documents) {
    closed(row, ['id', 'text', 'vector'], 'belge');
    if (row.text !== textOfItem.get(id)) fail('Koşu dosyasındaki belge metni girdiyle aynı değil; değiştirilmiş metin puanlanmaz.');
  }
  const queries = exactRows(embedding.queries, 'case', caseIds, 'sorgu');
  for (const [id, row] of queries) {
    readOutcomeRow(row, ['case', 'text', 'vector', 'failure', 'latencyMs'], 'vector', 'sorgu');
    if (row.text !== textOfCase.get(id)) fail('Koşu dosyasındaki sorgu metni girdiyle aynı değil; değiştirilmiş metin puanlanmaz.');
  }
  let rerank = null;
  if (run.rerank != null) {
    const section = closed(run.rerank, RERANK_FIELDS, 'yeniden sıralama');
    const provenance = provenanceOf(section, AI_PROFILES.RERANK, 'rerank');
    if (!provenance || (section.runtime !== undefined && !boundedText(section.runtime))) fail('Koşu dosyasındaki yeniden sıralama modeli kökeni geçersiz.');
    if (!isBatchSize(section.batchSize)) fail('Koşu dosyasındaki yeniden sıralama toplu iş boyutu geçersiz.');
    const rows = exactRows(section.queries, 'case', caseIds, 'yeniden sıralama');
    const scores = new Map();
    const outcomes = new Map();
    for (const [id, row] of rows) {
      readOutcomeRow(row, ['case', 'scores', 'failure', 'latencyMs'], 'scores', 'yeniden sıralama');
      if (!Object.hasOwn(row, 'scores')) {
        outcomes.set(id, 'failed');
        continue;
      }
      const byItem = exactRows(row.scores, 'id', itemIds, 'skor');
      for (const score of byItem.values()) closed(score, ['id', 'score'], 'skor');
      // Koşucu her sorguda bütün kataloğu puanlar: çağrının geçerliliği raporun aday sınırına değil bütün çıktıya bağlıdır.
      const valid = [...byItem.values()].every((score) => isScore(score.score));
      outcomes.set(id, valid ? 'ok' : 'invalid');
      if (valid) scores.set(id, byItem);
    }
    rerank = { provenance, runtime: section.runtime ?? null, batchSize: section.batchSize, rows, scores, outcomes };
  }
  return { embedding, space, documents, queries, rerank, environment: readEnvironment(run.environment) };
}

function inferenceFailure() {
  return Object.assign(new Error(INFERENCE_FAILED), { code: INFERENCE_FAILED });
}

/** Doğrulanmış kayıtlı çıktıları model sınırı işlevlerine çevirir; değerler yine sözleşmede doğrulanır. */
function recordedModels(trusted, { catalogue, benchmark }) {
  const caseOf = new Map(benchmark.cases.map((testCase) => [testCase.text, testCase.id]));
  const itemOf = new Map(catalogue.items.map((item) => [item.text, item.id]));
  if (itemOf.size !== catalogue.items.length) fail('Katalog belge metinleri tekil değil; kayıtlı çıktılar belgelere eşlenemez.');
  const embed = async (texts, { purpose }) => texts.map((text, index) => {
    if (purpose === 'document') return { index, vector: trusted.documents.get(itemOf.get(text)).vector };
    const row = trusted.queries.get(caseOf.get(text));
    if (row.failure) throw inferenceFailure();
    return { index, vector: row.vector };
  });
  const embedding = { space: trusted.space, embed };
  if (!trusted.rerank) return { embedding, reranking: null };
  const { provenance, scores } = trusted.rerank;
  const rerank = async (query, texts) => {
    const byItem = scores.get(caseOf.get(query));
    if (!byItem) throw inferenceFailure();
    return texts.map((text, index) => ({ index, score: byItem.get(itemOf.get(text)).score }));
  };
  return { embedding, reranking: { provenance, rerank } };
}

function provenanceOf(section, profile, capability) {
  return semanticModelProvenance({ profile, model: section?.model, provider: section?.provider, capabilities: [capability] }, profile);
}

const percent = (value) => (value == null ? '—' : value.toFixed(3));
// Koşu dosyasından gelen metin Markdown'a veri olarak girer: satır sonu ve denetim karakteri boşluk olur, biçim işaretleri kaçışlanır.
const plain = (value) => String(value).replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/[\\`*_[\]<>|#]/g, '\\$&');
const signed = (value) => (value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`);

function markdown(summary, qualification, benchmark) {
  const { embedding, reranked } = summary.stages;
  const final = reranked || embedding;
  const textOf = new Map(benchmark.cases.map((testCase) => [testCase.id, testCase]));
  const [k1, , kMax] = summary.cutoffs;
  const { embedding: model, reranker, latencyWorkload: workload } = qualification;
  const row = (label, pick, delta = null) => `| ${label} | ${percent(pick(embedding))} | ${reranked ? percent(pick(reranked)) : '—'} | ${reranked ? signed(delta) : '—'} |`;
  const latency = (value) => (value ? `p50 ${Math.round(value.p50)} ms · p95 ${Math.round(value.p95)} ms · en çok ${Math.round(value.max)} ms (${value.count})` : '—');
  return [
    '# Rota AI anlamsal nitelendirme raporu',
    '',
    `- Kıyas kümesi: \`${summary.benchmark.slice(0, 16)}\` · katalog \`${summary.catalogue.slice(0, 16)}\` · ${summary.cases.total} vaka (${summary.cases.answer} yanıt, ${summary.cases.clarify} açıklama, ${summary.cases.abstain} kapsam dışı)`,
    `- Gömme: ${plain(model.model)} (${plain(model.provider)}, ön işleme ${plain(model.preprocessing)}, sorgu öneki ${plain(JSON.stringify(model.queryPrefix))}, belge öneki ${plain(JSON.stringify(model.documentPrefix))})${model.runtime ? ` · ${plain(model.runtime)}` : ''}`,
    `- Yeniden sıralama: ${reranker ? `${plain(reranker.model)} (${plain(reranker.provider)})${reranker.runtime ? ` · ${plain(reranker.runtime)}` : ''}` : 'yok'}`,
    `- Aday sınırı: ilk ${summary.limit} aday · kesimler ${summary.cutoffs.join(', ')} · NDCG@${summary.ndcgCutoff}`,
    `- Ortam: ${qualification.environment ? plain(JSON.stringify(qualification.environment)) : '—'} · toplu iş boyutu ${workload.index.batchSize}${workload.rerank ? ` / ${workload.rerank.batchSize}` : ''}`,
    `- Model çıktısı: gömme ${JSON.stringify(summary.outcomes.embedding)}${summary.outcomes.rerank ? ` · yeniden sıralama ${JSON.stringify(summary.outcomes.rerank)}` : ''}`,
    '',
    '| Ölçü (yanıt vakaları) | Gömme | Yeniden sıralama | Fark |',
    '| --- | ---: | ---: | ---: |',
    row('Top-1', (stage) => stage.answer.hitAt1, summary.uplift?.hitAt1),
    row('MRR', (stage) => stage.answer.mrr, summary.uplift?.mrr),
    ...summary.cutoffs.map((k) => row(`Recall@${k}`, (stage) => stage.answer.recall[k], summary.uplift?.recall[k])),
    row(`Kapsama@${kMax}`, (stage) => stage.answer.coverage[kMax]),
    row(`NDCG@${summary.ndcgCutoff}`, (stage) => stage.answer.ndcg, summary.uplift?.ndcg),
    row('Kaçınma çifti tutarlılığı', (stage) => stage.answer.avoid.rate),
    row(`Açıklama vakalarında kapsama@${kMax}`, (stage) => stage.clarifyCoverage.rate),
    row('Kapsam dışı ayrılabilirliği (AUROC)', (stage) => stage.abstainSeparability),
    '',
    `Gecikme (koşucunun ölçtüğü): katalog ${summary.latency.index == null ? '—' : `${Math.round(summary.latency.index)} ms`} (${workload.index.documentsPerCall} belge, tek çağrı) · sorgu gömme ${latency(summary.latency.embedding)} (çağrı başına 1 sorgu) · yeniden sıralama ${latency(summary.latency.rerank)}${workload.rerank ? ` (çağrı başına bütün katalog: ${workload.rerank.documentsPerCall} belge; kalite ölçüleri ilk ${summary.limit} aday üzerindedir)` : ''}`,
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

/**
 * Nitelendirme çıktısının künyesi: sonucu yeniden üretmek için gereken her şey
 * (koşu biçimi, parmak izleri, modeller, ön işleme ve gerçek önekler, aday
 * sınırı, kesimler, gecikmenin ölçüldüğü iş yükü ve ortam).
 */
function qualificationOf(trusted, summary, { catalogue, benchmark }) {
  const { embedding, space, rerank } = trusted;
  return {
    run: { format: MODEL_RUN_FORMAT, version: 1 },
    benchmark: summary.benchmark,
    catalogue: summary.catalogue,
    embedding: {
      profile: space.profile, model: space.model, provider: space.provider, preprocessing: space.preprocessing,
      queryPrefix: embedding.queryPrefix, documentPrefix: embedding.documentPrefix, runtime: embedding.runtime ?? null
    },
    reranker: rerank ? { ...rerank.provenance, runtime: rerank.runtime } : null,
    limit: summary.limit,
    cutoffs: summary.cutoffs,
    ndcgCutoff: summary.ndcgCutoff,
    // Koşucu yeniden sıralayıcıyla her sorguda bütün kataloğu puanlar; kalite ölçüleri ilk `limit` aday üzerindedir.
    latencyWorkload: {
      index: { documentsPerCall: catalogue.items.length, calls: 1, batchSize: embedding.batchSize },
      embedding: { queriesPerCall: 1, calls: benchmark.cases.length },
      rerank: rerank ? { documentsPerCall: catalogue.items.length, calls: benchmark.cases.length, batchSize: rerank.batchSize } : null
    },
    environment: trusted.environment
  };
}

async function report(context, flags) {
  if (!flags.run) fail('--run koşu dosyası gerekli.');
  let raw;
  try {
    raw = JSON.parse(readFileSync(flags.run, 'utf8'));
  } catch {
    fail('Koşu dosyası okunamadı ya da JSON değil.');
  }
  const trusted = readModelRun(raw, context);
  const { cutoffs, ndcgCutoff } = SEMANTIC_EVALUATION_DEFAULTS;
  // Kesimler toplanan aday derinliğini aşamaz: sınır en derin kesimden küçük olamaz.
  const minimum = Math.max(...cutoffs, ndcgCutoff);
  const limit = flags.limit == null ? SEMANTIC_EVALUATION_DEFAULTS.limit : Number(flags.limit);
  if (!Number.isSafeInteger(limit) || limit < minimum || limit > SEMANTIC_LIMITS.maxCandidates) {
    fail(`--limit ${minimum} ile ${SEMANTIC_LIMITS.maxCandidates} arasında bir tam sayı olmalıdır.`);
  }
  const collected = await collectSemanticRun({ ...context, ...recordedModels(trusted, context), limit });
  // Katalog dizini kurulamayan koşu nitelendirme değildir: sıfır ölçülü başarılı rapor üretilmez.
  if (collected.index.outcome !== 'ok') {
    fail(`Koşu dosyasındaki katalog gömmesi geçersiz (${collected.index.reason ?? collected.index.outcome}); dizin kurulamadı, nitelendirme yapılamaz.`);
  }
  const summary = summarizeSemanticRun(collected, context.benchmark);
  // Sonuç türü ve gecikme nüfusu koşucunun GERÇEKTEN yaptığı çağrılardır (her vaka için bir sorgu gömme ve bir
  // yeniden sıralama çağrısı); yeniden sıralama sonucu sorgu gömmesinin yeniden oynatımına bağlı değildir.
  if (trusted.rerank) {
    const counts = { ok: 0, invalid: 0, timeout: 0, failed: 0 };
    for (const outcome of trusted.rerank.outcomes.values()) counts[outcome] += 1;
    summary.outcomes.rerank = counts;
  }
  summary.latency = {
    index: trusted.embedding.documentLatencyMs,
    embedding: semanticLatencySummary([...trusted.queries.values()].map((row) => row.latencyMs)),
    rerank: trusted.rerank ? semanticLatencySummary([...trusted.rerank.rows.values()].map((row) => row.latencyMs)) : null
  };
  const qualification = qualificationOf(trusted, summary, context);
  if (flags.json) {
    // Dizin kaydının süresi kayıtlı çıktının okunma süresidir; gerçek gecikme `summary.latency` içindedir.
    const { outcome, reason = null, identity = null, dimensions = null } = collected.index;
    process.stdout.write(`${JSON.stringify({ qualification, summary, index: { outcome, reason, identity, dimensions } }, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(summary, qualification, context.benchmark));
  }
}

const { command, flags } = parseArguments(process.argv.slice(2));
if (command === 'input') writeInput(load(), flags.out);
else if (command === 'report') await report(load(), flags);
else fail('Kullanım: node scripts/semantic-evaluation.mjs input [--out dosya] | report --run dosya [--limit 10] [--json]');
