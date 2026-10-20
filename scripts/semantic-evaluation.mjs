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
 *   node scripts/semantic-evaluation.mjs live [--json]
 *     Kıyas kümesini ÜRETİMDEKİ yoldan geçirir: model kaydının `embedding` ve
 *     `rerank` profilleri → ağ geçidi (kapasite, süre sınırı, yineleme) →
 *     OpenAI uyumlu bağdaştırıcı → `MERGEN_ROTA_AI_BASE_URL` ucu, kurumsal
 *     anahtarla. Aday derinliği üretimdekidir (10); `--limit` yalnızca bu
 *     değerle verilebilir. Ortam uygulamayla aynı kaynaktan okunur (çalışma
 *     dizinindeki `.env.local`, `.env`; kabuktaki değer önceliklidir). Rota
 *     verisi okunmaz; uca yalnızca sentetik sorular ve sunucuya ait araç
 *     açıklamaları gider. İşletim günlüğü stderr'e yazılır, stdout yalnızca
 *     rapordur (`--json` ile ayrıştırılabilir JSON).
 *
 *   --queries sorular.json  (üç komutta da)
 *     Kıyas vakalarının metnini `[{ case, text }]` ile değiştirir (ör. aynı
 *     anlamlı başka ifadeler); altın etiketler aynı kalır, parmak izi değişir.
 *
 * Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md
 */
import { Console } from 'node:console';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_FILE = path.join(ROOT, 'test/fixtures/ai-semantic-benchmark.json');
const INPUT_FORMAT = 'mergen-rota-semantic-input';
const MODEL_RUN_FORMAT = 'mergen-rota-semantic-model-run';

const {
  SEMANTIC_LIMITS, createEmbeddingSpace, createSemanticCatalogue, createSemanticIndex, normalizeSemanticQuery, rankSemanticIndex,
  semanticModelProvenance, semanticToolDefinitions
} = await import('../src/domain/ai/semanticContract.js');
const {
  SEMANTIC_EVALUATION_DEFAULTS, collectSemanticRun, semanticLatencySummary, summarizeSemanticRun, validateSemanticBenchmark
} = await import('../src/domain/ai/semanticEvaluation.js');
const { AI_NO_PREPROCESSING, AI_PROFILE_RESOLUTION_FAILURES, AI_PROFILES, resolveModelProfile } = await import('../src/domain/ai/aiModelRegistry.js');
const { getRotaTool, rotaToolNames } = await import('../src/server/ai/tools/toolRegistry.js');
const { aiCallBudgetMs } = await import('../src/server/ai/aiDeadline.js');

function fail(message) {
  throw new Error(message);
}

function parseArguments([command, ...rest]) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json') flags.json = true;
    else if (['--out', '--run', '--limit', '--queries'].includes(rest[i]) && rest[i + 1]) flags[rest[i].slice(2)] = rest[++i];
    else fail(`Tanınmayan bağımsız değişken: ${rest[i]}`);
  }
  return { command, flags };
}

/**
 * Vaka metinlerinin yerine konan ifadeler: her kıyas vakası tam bir kez, metin
 * kanonik biçime normalleşir; altın etiketler değişmez. Türetilen küme aynı
 * kıyas doğrulamasından geçer (tekil metin dâhil) ve kendi parmak izini taşır.
 */
function withQueries(document, file) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('Soru dosyası okunamadı ya da JSON değil.');
  }
  const known = new Set(document.cases.map((testCase) => testCase.id));
  const textOf = new Map();
  if (!Array.isArray(rows) || rows.length !== known.size) fail('Soru dosyası her kıyas vakası için tam bir satır taşımalıdır.');
  for (const row of rows) {
    const query = normalizeSemanticQuery(row?.text);
    if (!isRecord(row) || Object.keys(row).some((key) => key !== 'case' && key !== 'text') || !known.has(row.case) || textOf.has(row.case) || !query.ok) {
      fail('Soru dosyasında yabancı, yinelenen ya da geçersiz satır var ({ case, text }).');
    }
    textOf.set(row.case, query.value);
  }
  return { ...document, cases: document.cases.map((testCase) => ({ ...testCase, text: textOf.get(testCase.id) })) };
}

function load(flags = {}) {
  const built = createSemanticCatalogue(semanticToolDefinitions(rotaToolNames().map((name) => getRotaTool(name))));
  if (!built.ok) fail(`Araç kataloğu geçersiz: ${built.issues.join(', ')}`);
  const official = JSON.parse(readFileSync(BENCHMARK_FILE, 'utf8'));
  const validated = validateSemanticBenchmark(flags.queries ? withQueries(official, flags.queries) : official, built.catalogue);
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
export function readModelRun(raw, { catalogue, benchmark }) {
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
      for (const score of byItem.values()) {
        closed(score, ['id', 'score'], 'skor');
        // JSON'daki null sonlu olmayan model skorudur; eksik/metin alan bozuk artifakttır.
        if (!Object.hasOwn(score, 'score') || score.score !== null && typeof score.score !== 'number') fail('Koşu dosyasındaki skor biçimi geçersiz.');
      }
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

/**
 * Doğrulanmış kayıtlı çıktıları model sınırı işlevlerine çevirir; değerler yine sözleşmede doğrulanır.
 * Katalog metinleri tekil olmak zorunda değildir: belge çıktısı katalog sırasıyla (konum → kimlik),
 * yeniden sıralama skoru adayın kimliğiyle eşlenir. Vaka metinleri kıyas sözleşmesince tekildir.
 */
export function recordedModels(trusted, { catalogue, benchmark }) {
  const caseOf = new Map(benchmark.cases.map((testCase) => [testCase.text, testCase.id]));
  const documents = catalogue.items.map((item, index) => ({ index, vector: trusted.documents.get(item.id).vector }));
  const embed = async (texts, { purpose }) => {
    if (purpose === 'document') return documents;
    const row = trusted.queries.get(caseOf.get(texts[0]));
    if (row.failure) throw inferenceFailure();
    return [{ index: 0, vector: row.vector }];
  };
  const embedding = { space: trusted.space, embed };
  if (!trusted.rerank) return { embedding, reranking: null };
  const { provenance, scores } = trusted.rerank;
  // Yeniden sıralayıcıya yalnızca metin gider; aynı metinli adaylar ancak kimlikle ayrılır. Adayların kimliği
  // koşucunun ilk aşamasıyla aynı belirlenimci sıralamadan (aynı dizin, aynı sorgu vektörü) yeniden kurulur.
  const built = createSemanticIndex(catalogue, trusted.space, documents);
  const rerank = async (query, texts) => {
    const id = caseOf.get(query);
    const byItem = scores.get(id);
    if (!byItem || !built.ok) throw inferenceFailure();
    const ranked = rankSemanticIndex(built.index, { space: trusted.space, embeddings: [{ index: 0, vector: trusted.queries.get(id).vector }], limit: texts.length });
    if (!ranked.ok) throw inferenceFailure();
    return ranked.candidates.map((candidate, index) => ({ index, score: byItem.get(candidate.id).score }));
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
    row(`Kapsama@${kMax}`, (stage) => stage.answer.coverage[kMax], summary.uplift?.coverage[kMax]),
    row(`NDCG@${summary.ndcgCutoff}`, (stage) => stage.answer.ndcg, summary.uplift?.ndcg),
    row('Kaçınma çifti tutarlılığı', (stage) => stage.answer.avoid.rate, summary.uplift?.avoid),
    row(`Açıklama vakalarında kapsama@${kMax}`, (stage) => stage.clarifyCoverage.rate, summary.uplift?.clarifyCoverage),
    row('Kapsam dışı ayrılabilirliği (AUROC)', (stage) => stage.abstainSeparability, summary.uplift?.abstainSeparability),
    '',
    `Gecikme (koşucunun ölçtüğü): katalog ${summary.latency.index == null ? '—' : `${Math.round(summary.latency.index)} ms`} (${workload.index.documentsPerCall} belge, tek çağrı) · sorgu gömme ${latency(summary.latency.embedding)} (çağrı başına 1 sorgu) · yeniden sıralama ${latency(summary.latency.rerank)}${!workload.rerank ? ''
      : workload.rerank.documentsPerCall === workload.index.documentsPerCall
        ? ` (çağrı başına bütün katalog: ${workload.rerank.documentsPerCall} belge; kalite ölçüleri ilk ${summary.limit} aday üzerindedir)`
        : ` (çağrı başına ilk aşamanın ${workload.rerank.documentsPerCall} adayı, üretimdeki gibi)`}`,
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

// Kesimler toplanan aday derinliğini aşamaz: sınır en derin kesimden küçük olamaz.
function limitOf(flags) {
  const { cutoffs, ndcgCutoff } = SEMANTIC_EVALUATION_DEFAULTS;
  const minimum = Math.max(...cutoffs, ndcgCutoff);
  const limit = flags.limit == null ? SEMANTIC_EVALUATION_DEFAULTS.limit : Number(flags.limit);
  if (!Number.isSafeInteger(limit) || limit < minimum || limit > SEMANTIC_LIMITS.maxCandidates) {
    fail(`--limit ${minimum} ile ${SEMANTIC_LIMITS.maxCandidates} arasında bir tam sayı olmalıdır.`);
  }
  return limit;
}

function printSummary({ qualification, summary, index }, flags, benchmark) {
  if (flags.json) {
    const { outcome, reason = null, identity = null, dimensions = null } = index;
    process.stdout.write(`${JSON.stringify({ qualification, summary, index: { outcome, reason, identity, dimensions } }, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(summary, qualification, benchmark));
  }
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
  const limit = limitOf(flags);
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
  // Dizin kaydının süresi kayıtlı çıktının okunma süresidir; gerçek gecikme `summary.latency` içindedir.
  printSummary({ qualification: qualificationOf(trusted, summary, context), summary, index: collected.index }, flags, context.benchmark);
}

// Bilinçli olarak kapatılmış ya da hiç tanımlanmamış yeniden sıralama profili yalnızca ilk aşama ölçümüne izin verir.
const RERANK_OFF = new Set([AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED, AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED]);
// Süre sınırına ulaşan ağ geçidi çağrısının sonuçlanması için pay.
const LIVE_SETTLE_MARGIN_MS = 5000;

/**
 * Canlı çağrının dış süre sınırı: ağ geçidinin en uzun meşru yaşam döngüsü
 * (rehber denetimi + sıra + rotanın süre sınırı) ve sonuçlanma payı. Daha kısa
 * bir sınır geçerli bir çağrıyı ağ geçidinden önce keserdi.
 */
export function liveCallTimeoutMs(config, routeTimeoutsMs) {
  return aiCallBudgetMs(config, Math.max(...routeTimeoutsMs)) + LIVE_SETTLE_MARGIN_MS;
}

/**
 * Gecikmenin ölçüldüğü iş yükü: yalnızca GERÇEKTEN yapılan çağrılar. Koşu
 * durduğunda (sonuçlanmayan çağrı) ya da dizin kurulamadığında çağrılmayan
 * vakalar sayılmaz; özetin gecikme nüfusu da aynı çağrılardır.
 */
export function liveWorkload(summary, { documents, rerankDepth }) {
  return {
    index: { documentsPerCall: documents, calls: 1, batchSize: documents },
    embedding: { queriesPerCall: 1, calls: summary.latency.embedding?.count ?? 0 },
    rerank: rerankDepth == null ? null : { documentsPerCall: rerankDepth, calls: summary.latency.rerank?.count ?? 0, batchSize: rerankDepth }
  };
}

// Ağ geçidinin süre aşımı değerlendirme sözleşmesinde süre aşımıdır (genel model hatası değil).
function reportingTimeouts(call) {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (error?.code === 'AI_TIMEOUT') throw new DOMException('Ağ geçidi süre sınırı doldu.', 'TimeoutError');
      throw error;
    }
  };
}

/**
 * Komutun stdout'u yalnızca rapordur: işletim günlüğü (ör. ağ geçidinin
 * yineleme kaydı, ortam dosyası bildirimi) stderr'e gider. Yalnızca bu komut
 * sürecinde geçerlidir; uygulamanın telemetrisi değişmez.
 */
export function routeDiagnosticsToStderr() {
  const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
  for (const method of ['log', 'info', 'debug']) console[method] = diagnostics[method].bind(diagnostics);
}

/**
 * Uygulamanın (Next.js) ortam kaynağı: çalışma dizinindeki `.env.production.local`,
 * `.env.local`, `.env.production`, `.env` — `next start` ile aynı kural ve aynı
 * araç (@next/env). Kabukta tanımlı değer dosyadakinden önceliklidir.
 */
export function loadDeploymentEnvironment() {
  const { loadEnvConfig } = createRequire(import.meta.url)('@next/env');
  const { loadedEnvFiles } = loadEnvConfig(process.cwd(), false, { info: (...args) => console.error(...args), error: (...args) => console.error(...args) });
  // Yalnızca dosya adı yazılır; değerler yazılmaz.
  for (const file of loadedEnvFiles) process.stderr.write(`Ortam dosyası okundu: ${path.basename(file.path)}\n`);
}

/**
 * Üretim yolundan nitelendirme. Ağ geçidi süreçteki gibi kurulur (kapasite,
 * süre sınırı, dar yineleme, model eşleşmesi, ön işleme önekleri ve belirteç
 * penceresi); bu bir operatör komutudur: kullanıcı oturumu yoktur, kurumsal
 * anahtar kullanılır ve Rota verisi okunmaz. Profiller kayıttan bir kez
 * çözülür. Aday derinliği üretimin derinliğidir. Yeniden sıralama profili
 * bilinçli olarak kapatılmış ya da tanımlanmamışsa yalnızca ilk aşama ölçülür;
 * bozuk profil ölçüm yerine hatadır.
 */
async function live(context, flags) {
  routeDiagnosticsToStderr();
  loadDeploymentEnvironment();
  const { SEMANTIC_RETRIEVAL_DEPTH } = await import('../src/server/ai/semanticRetrieval.js');
  if (flags.limit != null && Number(flags.limit) !== SEMANTIC_RETRIEVAL_DEPTH) {
    fail(`live üretim yolunu ölçer: aday derinliği üretimdeki ${SEMANTIC_RETRIEVAL_DEPTH} değeridir (--limit yalnızca report içindir).`);
  }
  const limit = SEMANTIC_RETRIEVAL_DEPTH;
  const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
  const { createAiAdmissionController } = await import('../src/server/ai/admissionController.js');
  const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
  const { loadAiModelRegistry } = await import('../src/server/ai/modelRegistryLoader.js');
  const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
  const config = parseAiConfig(process.env);
  if (!config.available) fail(`Yapay zekâ yapılandırması kullanılamıyor (${config.enabled ? config.issues.join(', ') : 'MERGEN_ROTA_AI_ENABLED'}).`);
  if (!config.defaultApiKey) fail('Canlı nitelendirme kurumsal anahtarla çalışır: MERGEN_ROTA_AI_DEFAULT_API_KEY gerekli.');
  let registry;
  try {
    registry = await loadAiModelRegistry({ path: config.registryPath });
  } catch {
    fail('Model kaydı yüklenemedi.');
  }
  const embeddingRoute = resolveModelProfile(registry, AI_PROFILES.EMBEDDING);
  if (!embeddingRoute.ok) fail(`embedding profili kullanılamıyor (${embeddingRoute.reason}).`);
  const preprocessing = embeddingRoute.route.preprocessing ?? AI_NO_PREPROCESSING;
  const space = createEmbeddingSpace(semanticModelProvenance(embeddingRoute.route, AI_PROFILES.EMBEDDING), preprocessing.id);
  if (!space) fail('embedding profilinin rotası bir gömme uzayı kurmuyor.');
  const rerankRoute = resolveModelProfile(registry, AI_PROFILES.RERANK);
  if (!rerankRoute.ok && !RERANK_OFF.has(rerankRoute.reason)) {
    fail(`rerank profili kullanılamıyor (${rerankRoute.reason}); yalnızca kapatılmış ya da tanımlanmamış profil ilk aşama ölçümüne izin verir.`);
  }
  const provenance = rerankRoute.ok ? semanticModelProvenance(rerankRoute.route, AI_PROFILES.RERANK) : null;
  if (rerankRoute.ok && !provenance) fail('rerank profilinin rotası bir yeniden sıralama kökeni kurmuyor.');
  const admission = createAiAdmissionController({ limits: config.limits });
  const provider = createOpenAiCompatibleProvider();
  const gateway = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admission,
    loadConfig: () => config,
    loadRegistry: async () => registry,
    currentSicil: async () => 'semantic-qualification',
    verifySicil: async () => {},
    resolveCredential: async () => ({ source: 'default', apiKey: config.defaultApiKey })
  });
  // Ağ geçidi rotayı her çağrıda aynı (yüklenmiş) kayıttan çözer: uzay ve köken koşu boyunca sabittir.
  const embedding = {
    space,
    embed: reportingTimeouts(async (texts, { purpose, signal }) => (await gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts, purpose, signal })).embeddings)
  };
  const reranking = provenance ? {
    provenance,
    rerank: reportingTimeouts(async (query, documents, { signal }) => (await gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query, documents, signal })).scores)
  } : null;
  const routeTimeoutMs = (route) => route.timeoutMs ?? config.requestTimeoutMs;
  const callTimeoutMs = liveCallTimeoutMs(config, [routeTimeoutMs(embeddingRoute.route), ...(provenance ? [routeTimeoutMs(rerankRoute.route)] : [])]);
  const collected = await collectSemanticRun({ ...context, embedding, reranking, limit, callTimeoutMs });
  if (collected.index.outcome !== 'ok') fail(`Katalog gömmesi başarısız (${collected.index.reason ?? collected.index.outcome}); dizin kurulamadı, nitelendirme yapılamaz.`);
  const summary = summarizeSemanticRun(collected, context.benchmark);
  const documents = context.catalogue.items.length;
  const qualification = {
    run: { format: collected.format, version: collected.version, path: 'gateway' },
    benchmark: summary.benchmark,
    catalogue: summary.catalogue,
    embedding: {
      ...summary.provenance.embedding,
      queryPrefix: preprocessing.queryPrefix,
      documentPrefix: preprocessing.documentPrefix,
      truncateTokens: preprocessing.truncateTokens ?? null,
      runtime: 'gateway'
    },
    reranker: provenance ? { ...provenance, runtime: 'gateway' } : null,
    limit: summary.limit,
    cutoffs: summary.cutoffs,
    ndcgCutoff: summary.ndcgCutoff,
    latencyWorkload: liveWorkload(summary, { documents, rerankDepth: provenance ? Math.min(limit, documents) : null }),
    environment: { node: process.version, platform: process.platform, maxActive: config.limits.maxActive, callTimeoutMs }
  };
  printSummary({ qualification, summary, index: collected.index }, flags, context.benchmark);
}

// Komut yalnızca doğrudan çalıştırıldığında yürür; sınama yeniden oynatımı içe aktararak kendi kataloğuyla sınar.
// Yollar gerçek yola çevrilerek karşılaştırılır: sembolik bağ, Windows bağlantı noktası ya da subst sürücüsü komutu susturamaz.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
  const { command, flags } = parseArguments(process.argv.slice(2));
  if (command === 'input') writeInput(load(flags), flags.out);
  else if (command === 'report') await report(load(flags), flags);
  else if (command === 'live') await live(load(flags), flags);
  else fail('Kullanım: node scripts/semantic-evaluation.mjs input [--out dosya] | report --run dosya [--limit 10] [--json] | live [--json]; üçünde de [--queries sorular.json]');
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 400)}\n`);
    process.exitCode = 1;
  }
}
