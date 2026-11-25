#!/usr/bin/env node
/**
 * Bilgin Aşama 4I-B — yönetici raporu yazarı nitelendirme ve vekil model koşusu.
 *
 * Geliştirme aracıdır; uygulama başlangıcı, `npm test` ve CI bu betiği çalıştırmaz. Bütün adaylar AYNI dondurulmuş
 * sentetik kanıt paketlerini, aynı bölüm planını, aynı yazar istemini (`prepareReportWriterRequest`) ve aynı taslak
 * ayrıştırıcısını (`finalizeReportWriterResponse`) kullanır; yalnızca taşıyıcı değişir. Ayrıştırıcıya modelin
 * DEĞİŞTİRİLMEMİŞ yanıtı verilir; yanıt düzeltilmez, kırpılmaz, JSON kazınmaz.
 *
 * Kullanım:
 *   node scripts/report-writer-qualification.mjs kosu --tasiyici vekil --senaryolar S12,S46 --cikti /gecici/kosu.jsonl
 *   node scripts/report-writer-qualification.mjs kosu --tasiyici kurum-ici --model <katalog kimliği> --cikti ...
 *   node scripts/report-writer-qualification.mjs katalog
 *   node scripts/report-writer-qualification.mjs ozet --girdi kosu.jsonl [--hakem hakem.json] [--editoryal puan.json]
 *        [--json ozet.json] [--markdown ozet.md] [--ornekler S01,S12]
 *   node scripts/report-writer-qualification.mjs insan-paketi --girdi kosu.jsonl --dizin <çıktı dizini>
 *        Kör insan puanlaması için paket: rastgele kodlu ve rastgele sıralı taslaklar (senaryo ve model kimliği yok),
 *        E1–E9 + mekanik döküm puan çizelgesi (CSV) ve koordinatörde kalan kod anahtarı.
 *
 * Taşıyıcılar:
 *   vekil     Yalıtılmış komut satırı model köprüsü (`scripts/planner-model-adapter.mjs`): yalıtılmış ev klasörü, araçsız,
 *             tek tur, oturum kalıcılığı yok, her çağrıda model kimliği ve tek API çağrısı denetlenir. Model ve efor sabittir
 *             (VEKIL_MODEL, düşük efor); bu koşular yalnızca mimariye güven sağlar, kurum içi nitelendirme sayılmaz.
 *             Bilinen sapma: köprü rol ayrımlı kullanıcı iletilerini etiketli tek kullanıcı iletisine düzleştirir ve CLI
 *             kendi ortam notlarını ekler; sistem yönergesi ise bayt bayt aynen verilir.
 *   kurum-ici Üretimdeki OpenAI uyumlu sağlayıcı modülüyle (`createOpenAiCompatibleProvider`) MERGEN_ROTA_AI_BASE_URL
 *             ucuna doğrudan çağrı; anahtar `--anahtar-ortami` ile adı verilen ortam değişkeninden okunur (varsayılan
 *             MERGEN_ROTA_AI_QUALIFICATION_KEY). Model kimliği önce `GET /models` ile doğrulanır; doğrulanamazsa koşu başlamaz.
 *
 * Gizlilik: Yalnızca dondurulmuş SENTETİK paket kümesi kullanılır; küme özeti ve her özel adın sentetik kadrodan olduğu
 * koşudan önce doğrulanır (dışarıdan paket yolu kabul edilmez). Ham yanıtlar yalnızca `--cikti` dosyasına yazılır.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'scripts', 'planner-model-adapter.mjs');
const VEKIL_MODEL = 'claude-haiku-5-5';
const VEKIL_EFFORT = 'low';
const CALL_TIMEOUT_MS = 600000;

const bench = await import('../test/helpers/executiveReportWriterBenchmark.mjs');
const writer = await import('../src/server/ai/report/reportWriter.js');
const { renderReportDraftText } = await import('../src/domain/ai/report/reportDraft.js');
const { projectEvidencePackageForWriter } = await import('../src/domain/ai/report/reportWriterPrompt.js');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`Beklenmeyen bağımsız değişken: ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Değer eksik: ${key}`);
    options[key.slice(2)] = value;
    i += 1;
  }
  return { command, options };
}

/** Vekil köprüsüne bir yazar isteği gönderir; kabuk kullanılmaz, girdi stdin ile verilir. */
function callSurrogate(request, ledger) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADAPTER], {
      cwd: ROOT,
      env: {
        ...process.env,
        PLANNER_CLAUDE_MODEL: VEKIL_MODEL,
        PLANNER_CLAUDE_EFFORT: VEKIL_EFFORT,
        PLANNER_CLAUDE_LOG: ledger,
        PLANNER_CLAUDE_OUTPUT_CAP: '64000',
        PLANNER_CLAUDE_ALLOW_THINKING: '1',
        PLANNER_MODEL_TIMEOUT_MS: String(CALL_TIMEOUT_MS)
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* köprü çıktısı yok */ }
      resolve({ code, parsed });
    });
    child.stdin.end(JSON.stringify({ messages: request.messages, tools: [], toolChoice: 'none', maxOutputTokens: request.maxOutputTokens }));
  });
}

function onPremConfig(options) {
  const baseUrl = process.env.MERGEN_ROTA_AI_BASE_URL;
  const keyEnv = options['anahtar-ortami'] || 'MERGEN_ROTA_AI_QUALIFICATION_KEY';
  const apiKey = process.env[keyEnv];
  if (!baseUrl || !apiKey) throw new Error(`Kurum içi uç yapılandırılmamış (MERGEN_ROTA_AI_BASE_URL ve ${keyEnv} gerekli). Nitelendirme: BEKLIYOR.`);
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), apiKey };
}

async function listOnPremModels(config) {
  const response = await fetch(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GET /models yanıtı ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data.map((item) => String(item?.id ?? '')).filter(Boolean) : [];
}

async function callOnPrem(request, config, model) {
  const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
  const provider = createOpenAiCompatibleProvider({});
  const completion = await provider.chatCompletion({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model, messages: request.messages,
    maxOutputTokens: request.maxOutputTokens, signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  return completion;
}

function selectEntries(set, list) {
  if (!list || list === 'tumu') return set.paketler;
  const wanted = list.split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !set.paketler.some((entry) => entry.senaryo === id));
  if (unknown.length) throw new Error(`Bilinmeyen senaryo: ${unknown.join(', ')}`);
  return set.paketler.filter((entry) => wanted.includes(entry.senaryo));
}

async function runScenario(entry, context) {
  const { transport, style, fixture, runId, ledgerFor, worker, onPrem, model, quality } = context;
  const base = {
    kosu: runId, senaryo: entry.senaryo, kaynak: entry.kaynak, paket_ozeti: entry.paket_ozeti_sha256,
    paket_kumesi_ozeti: context.setHash, tasiyici: transport, kalite: quality, ayrinti: entry.paket.istek.ayrinti ?? 'standart'
  };
  const request = writer.prepareReportWriterRequest({ evidencePackage: entry.paket, style, quality });
  Object.assign(base, { istem_surumu: request.promptVersion, sozlesme: request.plan.sozlesme, profil: request.profile, cikti_siniri: request.maxOutputTokens });
  const startedAt = Date.now();
  let text = '';
  let finishReason = null;
  let identity = null;
  let usage = null;
  let extra = {};
  if (transport === 'vekil') {
    const { parsed } = await callSurrogate(request, ledgerFor(worker));
    const sureMs = Date.now() - startedAt;
    if (!parsed || typeof parsed.text !== 'string' || parsed.error) {
      return { ...base, durum: 'altyapi_hatasi', hata_kodu: parsed?.error || 'KOPRU_CIKTISI_YOK', sure_ms: sureMs, model_beklenen: VEKIL_MODEL };
    }
    text = parsed.text;
    finishReason = parsed.finishReason === 'length' ? 'length' : parsed.finishReason;
    usage = parsed.usage;
    identity = { beklenen: VEKIL_MODEL, bildirilen: parsed.models, dogrulandi: Array.isArray(parsed.models) && parsed.models.length === 1 && parsed.models[0] === VEKIL_MODEL };
    extra = { efor: VEKIL_EFFORT, dusunme: parsed.thinking, sure_ms: sureMs };
  } else {
    try {
      const completion = await callOnPrem(request, onPrem, model);
      text = completion.text;
      finishReason = completion.finishReason;
      usage = completion.usage;
      identity = { beklenen: model, bildirilen: completion.model, dogrulandi: completion.model === model };
      extra = { sure_ms: Date.now() - startedAt, ornekleme: 'saglayici_varsayilani' };
    } catch (error) {
      return { ...base, durum: 'altyapi_hatasi', hata_kodu: error?.code || 'KURUM_ICI_CAGRI_HATASI', sure_ms: Date.now() - startedAt, model_beklenen: model };
    }
  }
  const record = { ...base, ...extra, model: identity, kullanim: usage, bitis_nedeni: finishReason ?? null, ham_yanit: text };
  if (!identity.dogrulandi) return { ...record, durum: 'gecersiz_kimlik' };
  try {
    const draft = writer.finalizeReportWriterResponse({ text, finishReason, plan: request.plan, evidencePackage: entry.paket });
    const nesnel = bench.assessDraftObjectively({ draft, pkg: entry.paket, fixture, mandatory: entry.zorunlu_olgular, unauthorized: entry.yetkisiz_varliklar,
      projected: projectEvidencePackageForWriter(entry.paket) });
    const words = bench.draftProse(draft).split(/\s+/u).filter(Boolean).length;
    return { ...record, durum: 'gecerli', taslak: draft, sozcuk: words, nesnel };
  } catch (error) {
    return { ...record, durum: 'ayristirma_hatasi', hata_kodu: error?.details?.draftCode || error?.details?.reason || error?.code || 'BILINMEYEN', hata_yolu: error?.details?.path ?? null };
  }
}

async function commandRun(options) {
  const transport = options.tasiyici;
  if (!['vekil', 'kurum-ici'].includes(transport)) throw new Error('--tasiyici vekil | kurum-ici');
  const quality = options.kalite || 'otomatik';
  const out = options.cikti || path.join(tmpdir(), `rapor-yazari-kosu-${Date.now()}.jsonl`);
  // Sentetik köken olumlu doğrulanır: özet ve kadro denetimi geçmeyen küme kullanılamaz.
  const set = bench.loadWriterPackageSet();
  const fixture = bench.loadBenchmarkFixture();
  const style = bench.loadReportStyle();
  const entries = selectEntries(set, options.senaryolar);
  let onPrem = null;
  let model = null;
  if (transport === 'kurum-ici') {
    model = options.model;
    if (!model) throw new Error('--model gerekli (kurum içi katalog kimliği).');
    onPrem = onPremConfig(options);
    const catalogue = await listOnPremModels(onPrem);
    if (!catalogue.includes(model)) throw new Error(`Model kurum içi katalogda doğrulanamadı: koşu başlamaz (BEKLIYOR).`);
  }
  const concurrency = Math.max(1, Math.min(4, Number.parseInt(options.eszamanlilik || '1', 10) || 1));
  const runId = randomUUID();
  const ledgerBase = options.defter || path.join(tmpdir(), `rapor-yazari-defter-${runId}`);
  const context = { transport, style, fixture, runId, ledgerFor: (worker) => `${ledgerBase}-${worker}.jsonl`, onPrem, model, quality, setHash: set.ozet_sha256 };
  process.stdout.write(`Koşu ${runId}: ${entries.length} senaryo, taşıyıcı ${transport}, eşzamanlılık ${concurrency} → ${out}\n`);
  const queue = [...entries];
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (queue.length) {
      const entry = queue.shift();
      const record = await runScenario(entry, { ...context, worker });
      appendFileSync(out, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      const n = record.nesnel;
      process.stdout.write(`${record.senaryo} ${record.durum}${record.hata_kodu ? ` ${record.hata_kodu}` : ''} ${Math.round((record.sure_ms || 0) / 1000)} sn`
        + (n ? ` · sözcük ${record.sozcuk} · yetkisiz ${n.yetkisiz_aciklama.length} · uydurma ad ${n.uydurma_kimlik.length} · defter dışı tarih ${n.defterde_olmayan_tarihler.length} · atlanan zorunlu ${n.atlanan_zorunlu_otomatik.length}` : '') + '\n');
    }
  }));
}

async function commandCatalogue(options) {
  const config = onPremConfig(options);
  const catalogue = await listOnPremModels(config);
  const policy = bench.loadReportStyle().model_politikasi.roller.rapor_yazari_otomatik.adaylar;
  for (const candidate of policy) process.stdout.write(`${candidate}: ${catalogue.includes(candidate) ? 'katalogda DOĞRULANDI' : 'katalogda YOK (BEKLIYOR)'}\n`);
}

function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Koşu kaydından A/B/D özetini hesaplar; hakem ve editoryal dosyaları verilmişse onları birleştirir. */
export function summarizeRun(records, { adjudication = {}, editorial = null } = {}) {
  const latest = new Map();
  // Nesnel tarama belirlenimcidir: kayıttaki taslaklar güncel değerlendirme koduyla ve dondurulmuş kümeyle yeniden
  // taranır (model yeniden çağrılmaz). Kayıt anındaki tarama ham kayıtta olduğu gibi kalır.
  const set = bench.loadWriterPackageSet();
  const fixture = bench.loadBenchmarkFixture();
  for (const record of records) {
    const entry = set.paketler.find((item) => item.senaryo === record.senaryo);
    if (record.durum === 'gecerli' && record.taslak && entry) {
      latest.set(record.senaryo, { ...record, nesnel: bench.assessDraftObjectively({ draft: record.taslak, pkg: entry.paket, fixture,
        mandatory: entry.zorunlu_olgular, unauthorized: entry.yetkisiz_varliklar, projected: projectEvidencePackageForWriter(entry.paket) }) });
    } else {
      latest.set(record.senaryo, record);
    }
  }
  const rows = [...latest.values()].sort((a, b) => a.senaryo.localeCompare(b.senaryo));
  const valid = rows.filter((row) => row.durum === 'gecerli');
  const perReport = valid.map((row) => {
    const judge = adjudication[row.senaryo] || null;
    const omitted = judge?.atlanan_zorunlu ?? row.nesnel.atlanan_zorunlu_otomatik;
    const correct = judge?.dogru ?? null;
    const wrong = judge?.yanlis ?? null;
    const denominator = correct == null ? null : correct + wrong + omitted.length;
    return {
      senaryo: row.senaryo,
      yetkisiz_aciklama: row.nesnel.yetkisiz_aciklama.length,
      // Sentetik proje adları sıradan Türkçe sözcüklerdir ("denge", "ışık"); tarama aday işaretler, hakem yanlış pozitifi ayırır.
      uydurma_kimlik: row.nesnel.uydurma_kimlik.filter((name) => !(judge?.uydurma_kimlik_yanlis_pozitif || []).includes(name)).length + (judge?.uydurma_tarih ?? 0),
      atlanan_zorunlu: omitted.length,
      nesnel_dogruluk: denominator ? correct / denominator : null,
      celiski_islendi: judge?.celiski_islendi ?? null,
      sure_sn: Math.round((row.sure_ms || 0) / 100) / 10,
      ayrinti: row.ayrinti
    };
  });
  const standard = valid.filter((row) => row.ayrinti === 'standart').map((row) => row.sure_ms / 1000);
  const summary = {
    denenen: rows.length,
    gecerli: valid.length,
    ayristirma_hatasi: rows.filter((row) => row.durum === 'ayristirma_hatasi').map((row) => `${row.senaryo}:${row.hata_kodu}`),
    altyapi_hatasi: rows.filter((row) => row.durum === 'altyapi_hatasi' || row.durum === 'gecersiz_kimlik').map((row) => `${row.senaryo}:${row.hata_kodu || row.durum}`),
    yetkisiz_aciklama_toplam: perReport.reduce((sum, row) => sum + row.yetkisiz_aciklama, 0),
    uydurma_kimlik_tarih_toplam: perReport.reduce((sum, row) => sum + row.uydurma_kimlik, 0),
    zorunlu_tamlik_tam_rapor: perReport.filter((row) => row.atlanan_zorunlu === 0).length,
    dogruluk_95_alti: perReport.filter((row) => row.nesnel_dogruluk != null && row.nesnel_dogruluk < 0.95).map((row) => row.senaryo),
    yazar_sure_p95_standart_sn: bench.nearestRankP95(standard),
    rapor: perReport
  };
  if (editorial) {
    const scored = Object.entries(editorial.puanlar || {});
    const criteria = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'];
    const averages = Object.fromEntries(criteria.map((c) => {
      const values = scored.map(([, s]) => s[c]).filter((v) => Number.isFinite(v));
      return [c, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null];
    }));
    const overall = scored.map(([, s]) => {
      const values = criteria.map((c) => s[c]).filter((v) => Number.isFinite(v));
      return values.reduce((a, b) => a + b, 0) / values.length;
    });
    const mechanical = scored.filter(([, s]) => s.mekanik === true).map(([id]) => id);
    summary.editoryal = {
      degerlendirici: editorial.degerlendirici,
      rapor_sayisi: scored.length,
      genel_ortalama: overall.length ? overall.reduce((a, b) => a + b, 0) / overall.length : null,
      olcut_ortalamalari: averages,
      mekanik: mechanical,
      mekanik_orani: scored.length ? mechanical.length / scored.length : null
    };
  }
  return summary;
}

function markdownSummary(summary, rows, samples) {
  const lines = ['# Yönetici raporu yazarı koşu özeti (sentetik)', '', `Denenen ${summary.denenen} · geçerli ${summary.gecerli} · ayrıştırma hatası ${summary.ayristirma_hatasi.length} · altyapı/kimlik hatası ${summary.altyapi_hatasi.length}`, ''];
  lines.push(`Yetkisiz açıklama toplamı: ${summary.yetkisiz_aciklama_toplam} · uydurma kimlik/tarih: ${summary.uydurma_kimlik_tarih_toplam} · zorunlu olgusu tam rapor: ${summary.zorunlu_tamlik_tam_rapor}/${summary.gecerli} · standart ayrıntıda yazar p95: ${summary.yazar_sure_p95_standart_sn ?? '-'} sn`, '');
  for (const id of samples) {
    const row = rows.find((item) => item.senaryo === id && item.durum === 'gecerli');
    if (!row) continue;
    lines.push(`## ${id} — gerçek yazar çıktısı (sentetik veri)`, '', renderReportDraftText(row.taslak), '');
  }
  return lines.join('\n');
}

async function commandSummary(options) {
  if (!options.girdi || !existsSync(options.girdi)) throw new Error('--girdi koşu dosyası gerekli');
  const records = readJsonl(options.girdi);
  const adjudication = options.hakem ? JSON.parse(readFileSync(options.hakem, 'utf8')) : {};
  const editorial = options.editoryal ? JSON.parse(readFileSync(options.editoryal, 'utf8')) : null;
  const summary = summarizeRun(records, { adjudication, editorial });
  if (options.json) writeFileSync(options.json, `${JSON.stringify(summary, null, 1)}\n`);
  const samples = (options.ornekler || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (options.markdown) writeFileSync(options.markdown, `${markdownSummary(summary, records, samples)}\n`);
  const { rapor, ...head } = summary;
  process.stdout.write(`${JSON.stringify(head, null, 1)}\n`);
}

/** Kör puanlama paketi: kodlar gizli tuzla HMAC'tir; anahtar dosyası puanlayıcıya verilmez. */
async function commandHumanPackage(options) {
  if (!options.girdi || !options.dizin) throw new Error('--girdi ve --dizin gerekli');
  const latest = new Map();
  for (const record of readJsonl(options.girdi)) latest.set(record.senaryo, record);
  const valid = [...latest.values()].filter((record) => record.durum === 'gecerli');
  const salt = randomBytes(16).toString('hex');
  const coded = valid.map((record) => ({ record, kod: `K-${createHmac('sha256', salt).update(record.senaryo).digest('hex').slice(0, 6).toUpperCase()}` }))
    .sort((a, b) => a.kod.localeCompare(b.kod));
  const scenarios = new Map(bench.loadBenchmarkFixture().senaryolar.map((item) => [item.id, item]));
  const doc = ['# Bilgin 4I-B kör editoryal puanlama paketi (sentetik)', '',
    'Her taslağı kıyas çerçevesinin §4 ölçütüyle (E1–E9, 1–5) puanlayın ve mekanik döküm bayrağını verin. Taslaklar kurgusal kanıttan',
    'üretilmiştir; model kimliği ve senaryo kodu gizlidir. E8 (not dönüşümü) yalnızca "notlar: dahil" ve paketinde not bulunan taslaklarda uygulanır.', ''];
  for (const { record, kod } of coded) {
    const scenario = scenarios.get(record.senaryo);
    const hasNotes = scenario.notlar === 'dahil';
    doc.push(`## ${kod}`, '', `İstek: ${scenario.donem} · ${scenario.kapsam} · ayrıntı ${scenario.ayrinti} · odak ${scenario.odak} · notlar ${scenario.notlar}`, '',
      renderReportDraftText(record.taslak), '', `E8 uygulanabilirliği: ${hasNotes ? 'pakete göre koordinatör belirler' : 'Uygulanmaz (notlar hariç)'}`, '');
  }
  const csv = ['kod,E1,E2,E3,E4,E5,E6,E7,E8,E9,mekanik,not', ...coded.map(({ kod }) => `${kod},,,,,,,,,,,`)].join('\n');
  const key = { kosu: valid[0]?.kosu ?? null, uretim: new Date().toISOString(), uyari: 'PUANLAYICIYA VERİLMEZ', eslesme: Object.fromEntries(coded.map(({ record, kod }) => [kod, record.senaryo])) };
  writeFileSync(path.join(options.dizin, 'kor-puanlama-paketi.md'), `${doc.join('\n')}\n`);
  writeFileSync(path.join(options.dizin, 'kor-puanlama-cizelgesi.csv'), `${csv}\n`);
  writeFileSync(path.join(options.dizin, 'kor-puanlama-anahtari-PUANLAYICIYA-VERILMEZ.json'), `${JSON.stringify(key, null, 1)}\n`);
  process.stdout.write(`${coded.length} taslak kör pakete yazıldı.\n`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'kosu') await commandRun(options);
    else if (command === 'katalog') await commandCatalogue(options);
    else if (command === 'ozet') await commandSummary(options);
    else if (command === 'insan-paketi') await commandHumanPackage(options);
    else throw new Error('Komut: kosu | katalog | ozet | insan-paketi');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
