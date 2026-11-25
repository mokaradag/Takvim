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
import { readFileSync, writeFileSync } from 'node:fs';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const { renderReportDraftText } = await import('../src/domain/ai/report/reportDraft.js');
const { loadBenchmarkFixture } = await import('../test/helpers/executiveReportWriterBenchmark.mjs');

const ALLOWED = new Set(['--girdi', '--senaryolar', '--cikti']);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!ALLOWED.has(args[i]) || args[i + 1] === undefined) {
    process.stderr.write('Kullanım: node scripts/yonetici-anlati-onizleme.mjs --girdi kosu.jsonl [--senaryolar S01,S12] [--cikti onizleme.md]\n');
    process.exit(2);
  }
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.girdi) {
  process.stderr.write('--girdi gerekli.\n');
  process.exit(2);
}

const fixture = loadBenchmarkFixture();
const scenarios = new Map(fixture.senaryolar.map((item) => [item.id, item]));
const records = new Map();
for (const line of readFileSync(options.girdi, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  records.set(record.senaryo, record);
}
const wanted = options.senaryolar ? options.senaryolar.split(',').map((id) => id.trim()) : [...records.keys()].sort();

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
  if (!record || !scenario) continue;
  const model = Array.isArray(record.model?.bildirilen) ? record.model.bildirilen.join(', ') : record.model?.bildirilen ?? '-';
  out.push(`## ${id} — ${scenario.durum}`, '');
  out.push(`- Sınanan: ${scenario.sinanan}`);
  out.push(`- İstek: ${scenario.donem} · ${scenario.kapsam} · ayrıntı ${scenario.ayrinti} · odak ${scenario.odak} · notlar ${scenario.notlar} · karşılaştırma ${scenario.karsilastirma}`);
  out.push(`- Taşıyıcı ${record.tasiyici} · model ${model} · istem ${record.istem_surumu} · durum ${record.durum} · süre ${Math.round((record.sure_ms || 0) / 1000)} sn${record.sozcuk ? ` · ${record.sozcuk} sözcük` : ''}`, '');
  if (record.durum === 'gecerli') out.push(renderReportDraftText(record.taslak), '');
  else out.push(`_Taslak üretilemedi: ${record.hata_kodu || record.durum}._`, '');
}
const text = `${out.join('\n')}\n`;
if (options.cikti) writeFileSync(options.cikti, text, 'utf8');
else process.stdout.write(text);
