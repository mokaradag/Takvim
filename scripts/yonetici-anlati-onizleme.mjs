#!/usr/bin/env node
/**
 * Bilgin Aşama 4I-B — yönetici raporu anlatı önizlemesi (geliştirici aracı).
 *
 * Yazar koşusunun kayıt dosyasından (`report-writer-qualification.mjs kosu --cikti ...`) gerçek model düzyazısını okunur
 * Markdown'a çevirir. Paragraflar modelin yazdığı gibidir; bu betik metni düzeltmez, kısaltmaz ya da yeniden yazmaz.
 * Kayıtlar yalnızca SENTETİK kıyas verisinden üretilir; çıktı gerçek kurum raporu değildir.
 *
 *   node scripts/yonetici-anlati-onizleme.mjs --girdi kosu.jsonl [--senaryolar S01,S12] [--cikti onizleme.md]
 *
 * Yeni taslak üretmek için önce koşu yapılır (ör. `node scripts/report-writer-qualification.mjs kosu --tasiyici vekil
 * --senaryolar S12 --cikti kosu.jsonl`).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderReportDraftText } = await import('../src/domain/ai/report/reportDraft.js');
const { BENCHMARK_FIXTURE_PATH, REPORT_STYLE_PATH, WRITER_PACKAGES_PATH, loadBenchmarkFixture } = await import('../test/helpers/executiveReportWriterBenchmark.mjs');
const { draftDigest, hasVerifiedStoredModelIdentity, isValidStoredDraftShape, literalFence, selectHomogeneousRun } = await import('./report-writer-qualification.mjs');

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  if (existsSync(resolved)) {
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  const parent = path.dirname(resolved);
  try {
    return path.join(realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function sameFile(a, b) {
  if (canonicalPath(a) === canonicalPath(b)) return true;
  if (existsSync(a) && existsSync(b)) {
    try {
      const sa = statSync(a);
      const sb = statSync(b);
      if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
    } catch { /* dosya bilgisi okunamadı */ }
  }
  return false;
}

const ALLOWED = new Set(['--girdi', '--kosu', '--senaryolar', '--cikti']);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  // Tanınan bir başka seçenek değeri yerine geçemez; başında tire olan gerçek dosya adları korunur.
  if (!ALLOWED.has(flag) || value === undefined || ALLOWED.has(value)) {
    process.stderr.write('Kullanım: node scripts/yonetici-anlati-onizleme.mjs --girdi kosu.jsonl [--kosu <kimlik>] [--senaryolar S01,S12] [--cikti onizleme.md]\n');
    process.exit(2);
  }
  options[flag.slice(2)] = value;
}
if (!options.girdi) {
  process.stderr.write('--girdi gerekli.\n');
  process.exit(2);
}
const protectedInputs = [
  options.girdi,
  path.join(ROOT, BENCHMARK_FIXTURE_PATH),
  path.join(ROOT, WRITER_PACKAGES_PATH),
  path.join(ROOT, REPORT_STYLE_PATH)
];
if (options.cikti && protectedInputs.some((inputPath) => sameFile(inputPath, options.cikti))) {
  process.stderr.write('Çıktı yolu girdi koşu veya kıyas dosyalarından birinin kendisi olamaz.\n');
  process.exit(2);
}

const fixture = loadBenchmarkFixture();
const scenarios = new Map(fixture.senaryolar.map((item) => [item.id, item]));
const rawRecords = readFileSync(options.girdi, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
let selectedRows;
try {
  selectedRows = selectHomogeneousRun(rawRecords, { runId: options.kosu ?? null });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const records = new Map(selectedRows.map((record) => [record.senaryo, record]));

let wanted;
if (options.senaryolar !== undefined) {
  wanted = options.senaryolar.split(',').map((id) => id.trim()).filter(Boolean);
  if (!wanted.length) {
    process.stderr.write('--senaryolar boş olamaz.\n');
    process.exit(2);
  }
  const unknown = wanted.filter((id) => !scenarios.has(id));
  if (unknown.length) {
    process.stderr.write(`Bilinmeyen senaryo: ${unknown.join(', ')}\n`);
    process.exit(2);
  }
} else {
  wanted = [...records.keys()].sort();
  const unknownRecorded = wanted.filter((id) => !scenarios.has(id));
  if (unknownRecorded.length) {
    process.stderr.write(`Koşu kaydında bilinmeyen senaryo: ${unknownRecorded.join(', ')}\n`);
    process.exit(2);
  }
}

const out = [
  '# Yönetici raporu anlatı önizlemesi',
  '',
  '> **SENTETİK VERİ.** Aşağıdaki metinler Bilgin 4I-B yazar hattının kıyas kümesindeki kurgusal kanıt paketleri için ürettiği',
  '> değiştirilmemiş model düzyazısıdır. Gerçek kişi, proje ya da kurum raporu değildir; 4I-C doğrulaması uygulanmamış taslaklardır.',
  ''
];
for (const id of wanted) {
  const record = records.get(id);
  const scenario = scenarios.get(id);
  if (!scenario) continue;
  if (!record) {
    out.push(`## ${id} — ${scenario.durum}`, '', '_Bu senaryo koşu kaydında yer almıyor (koşulmadı)._', '');
    continue;
  }
  const model = Array.isArray(record.model?.bildirilen) ? record.model.bildirilen.join(', ') : record.model?.bildirilen ?? '-';
  const durationLabel = typeof record.sure_ms === 'number' && Number.isFinite(record.sure_ms)
    ? `${Math.round(record.sure_ms / 1000)} sn`
    : 'ölçülmedi';
  const modelVerified = record.durum === 'gecerli' ? hasVerifiedStoredModelIdentity(record) : true;
  const effectiveStatus = record.durum === 'gecerli' && !modelVerified ? 'gecersiz_kimlik' : record.durum;
  out.push(`## ${id} — ${scenario.durum}`, '');
  out.push(`- Sınanan: ${scenario.sinanan}`);
  out.push(`- İstek: ${scenario.donem} · ${scenario.kapsam} · ayrıntı ${scenario.ayrinti} · odak ${scenario.odak} · notlar ${scenario.notlar} · karşılaştırma ${scenario.karsilastirma}`);
  out.push(`- Taşıyıcı ${record.tasiyici} · model ${model} · istem ${record.istem_surumu} · durum ${effectiveStatus} · süre ${durationLabel}${record.sozcuk ? ` · ${record.sozcuk} sözcük` : ''}`, '');
  // Model düzyazısı HTML yorumu ya da Markdown sözdizimiyle gizlenmemesi için düz metin çitinde birebir sunulur;
  // model kimliği doğrulanmamış, taslak özeti bozuk ya da uyuşmayan satırlar reddedilir, diğer geçerli satırlar etkilenmez.
  if (record.durum === 'gecerli') {
    const hasOwnDigest = record.taslak_ozeti !== undefined && record.taslak_ozeti !== null;
    if (!isValidStoredDraftShape(record.taslak)) {
      out.push('_Kayıtlı taslak yapısı bozuk; önizleme oluşturulamadı._', '');
    } else if (!modelVerified) {
      out.push('_Kayıtlı model kimliği beklenen modelle doğrulanmadı; doğrulanmamış taslak önizlemede gösterilmedi._', '');
    } else if (hasOwnDigest) {
      if (typeof record.taslak_ozeti !== 'string' || !record.taslak_ozeti.trim()) {
        out.push('_Kayıtlı taslak özeti geçersiz biçimde; bozuk kayıt önizlemede gösterilmedi._', '');
      } else if (record.taslak_ozeti !== draftDigest(record)) {
        out.push('_Kayıtlı taslak özeti uyuşmuyor; değiştirilmiş taslak önizlemede gösterilmedi._', '');
      } else {
        out.push(literalFence(renderReportDraftText(record.taslak)), '');
      }
    } else {
      out.push('_Uyarı: kayıtlı taslak özeti yok (doğrulanmamış tarihsel taslak)._', '', literalFence(renderReportDraftText(record.taslak)), '');
    }
  } else {
    out.push(`_Taslak üretilemedi: ${record.hata_kodu || record.durum}._`, '');
  }
}
const text = `${out.join('\n')}\n`;
if (options.cikti) {
  mkdirSync(path.dirname(path.resolve(options.cikti)), { recursive: true });
  writeFileSync(options.cikti, text, 'utf8');
} else {
  process.stdout.write(text);
}
