#!/usr/bin/env node
/**
 * Bilgin Aşama 4I-B — yönetici raporu yazar kıyasının dondurulmuş sentetik kanıt paketi kümesini üretir ya da denetler.
 *
 * Geliştirme aracıdır; uygulama ve CI bu betiği çalıştırmaz (CI'daki sınama aynı üretimi süreç içinde yapar). Canlı
 * veritabanına bağlanmaz: 4I-A kanıt kurucusu yalnızca sentetik bellek içi SQL ikizi üzerinde çalışır.
 *
 *   node scripts/yonetici-raporu-kiyas-paketleri.mjs            # dosyayı yeniden üretir
 *   node scripts/yonetici-raporu-kiyas-paketleri.mjs --denetle  # dosya üretimle aynı değilse çıkış kodu 1
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildWriterPackageSet } = await import('../test/helpers/executiveReportWriterScenarios.mjs');
const { WRITER_PACKAGES_PATH, verifyWriterPackageSet, loadBenchmarkFixture } = await import('../test/helpers/executiveReportWriterBenchmark.mjs');

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--denetle')) {
  process.stderr.write('Kullanım: node scripts/yonetici-raporu-kiyas-paketleri.mjs [--denetle]\n');
  process.exit(2);
}
const set = await buildWriterPackageSet();
const problems = verifyWriterPackageSet(set, loadBenchmarkFixture());
if (problems.length) {
  process.stderr.write(`Üretilen küme doğrulanamadı: ${problems.join(', ')}\n`);
  process.exit(1);
}
const target = path.join(ROOT, WRITER_PACKAGES_PATH);
const text = `${JSON.stringify(set, null, 1)}\n`;
if (args.includes('--denetle')) {
  const current = readFileSync(target, 'utf8');
  const same = current.replace(/\r\n/gu, '\n') === text;
  process.stdout.write(same ? `Dondurulmuş küme güncel (${set.paketler.length} paket, özet ${set.ozet_sha256.slice(0, 16)}).\n` : 'Dondurulmuş küme üretimle aynı değil.\n');
  process.exit(same ? 0 : 1);
}
// Mevcut dondurulmuş fikstürü kesmeden önce aynı dizinde geçici dosyaya yazıp atomik olarak değiştir.
const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
let createdTmp = false;
try {
  writeFileSync(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
  createdTmp = true;
  renameSync(tmpPath, target);
} catch (error) {
  if (createdTmp) {
    try {
      rmSync(tmpPath, { force: true });
    } catch { /* geçici dosya temizlenemedi */ }
  }
  throw error;
}
process.stdout.write(`${set.paketler.length} paket yazıldı (özet ${set.ozet_sha256.slice(0, 16)}).\n`);
