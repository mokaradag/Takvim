#!/usr/bin/env node
/**
 * Bilgin Aşama 4I-A — Geliştirici ve sınama amaçlı sentetik yönetici kanıt paketi tanı önizleme betiği.
 *
 * Yalnızca sentetik bellek içi SQL ikiziyle çalışır; canlı veritabanına bağlanmaz,
 * kalıcı tanı dosyası yazmaz ve gerçek çalışan notlarına erişmez.
 *
 * Kullanım:
 *   node scripts/yonetici-kanit-onizleme.mjs [R1|R4|R5|R6|R7|R8|S09|tumu] [--json] [--ham-not]
 */
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { createActualStack } = await import('../test/helpers/actualStack.mjs');
const {
  executiveReportBenchmarkSeed,
  REPORT_BENCH_NOW,
  REPORT_BENCH_TODAY,
  REPORT_BENCH_USERS
} = await import('../test/helpers/executiveReportBenchmarkSeed.mjs');
const { buildExecutiveReportEvidence } = await import('../src/server/ai/report/reportEvidence.js');
const { buildExecutiveEvidencePreview } = await import('../src/domain/ai/report/reportPreview.js');

const CASES = Object.freeze({
  R1: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'proje', kimlikler: ['PRJ-KUZEY'] },
      ayrinti: 'standart',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'yok'
    }
  },
  R4: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'proje', kimlikler: ['PRJ-MELTEM'] },
      ayrinti: 'standart',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'yok'
    }
  },
  R5: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'proje', kimlikler: ['PRJ-UFUK'] },
      ayrinti: 'standart',
      odak: 'riskler',
      notlar: 'haric',
      karsilastirma: 'yok'
    }
  },
  R6: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'proje', kimlikler: ['PRJ-PUSULA'] },
      ayrinti: 'standart',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'yok'
    }
  },
  R7: {
    sicil: REPORT_BENCH_USERS.ECE,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'kisi', kimlikler: ['Ece Tunalı'] },
      ayrinti: 'kisa',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'yok'
    }
  },
  R8: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'haftalik',
      donem: { baslangic: '2026-11-02', bitis: '2026-11-08' },
      kapsam: { tur: 'ekip', kimlikler: ['Veri Akışı Ekibi'] },
      ayrinti: 'standart',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'yok'
    }
  },
  S09: {
    sicil: REPORT_BENCH_USERS.YONETICI,
    request: {
      rapor_turu: 'ozel',
      donem: { baslangic: '2026-10-30', bitis: '2026-11-08' },
      kapsam: { tur: 'projeler', kimlikler: ['PRJ-KUZEY', 'PRJ-MELTEM'] },
      ayrinti: 'standart',
      odak: 'dengeli',
      notlar: 'dahil',
      karsilastirma: 'ozel_donem',
      karsilastirma_donemi: { baslangic: '2026-10-10', bitis: '2026-10-19' }
    }
  }
});

const ALLOWED_FLAGS = new Set(['--json', '--ham-not']);
const args = process.argv.slice(2);
const unknownFlags = args.filter((arg) => arg.startsWith('-') && !ALLOWED_FLAGS.has(arg));
const positional = args.filter((arg) => !arg.startsWith('-'));

if (unknownFlags.length > 0) {
  process.stderr.write(`Desteklenmeyen seçenek: ${unknownFlags.join(', ')}\n`);
  process.exitCode = 1;
} else if (positional.length > 1) {
  process.stderr.write(`Birden fazla kıyas vakası verilemez: ${positional.join(', ')}\n`);
  process.exitCode = 1;
} else {
  const showJson = args.includes('--json');
  const includeRawText = args.includes('--ham-not');
  const requested = positional[0] || 'tumu';
  const targetKeys = requested.toLowerCase() === 'tumu' ? Object.keys(CASES) : [requested.toUpperCase()];
  const invalidKeys = targetKeys.filter((key) => !Object.hasOwn(CASES, key));

  if (invalidKeys.length > 0) {
    process.stderr.write(`Bilinmeyen sentetik kıyas vakası: ${invalidKeys.join(', ')}\n`);
    process.exitCode = 1;
  } else {
    const previousDevSicil = process.env.MERGEN_ROTA_DEV_SICIL;
    const stack = await createActualStack(executiveReportBenchmarkSeed(), { sicil: REPORT_BENCH_USERS.YONETICI });
    try {
      for (const key of targetKeys) {
        const spec = CASES[key];
        process.env.MERGEN_ROTA_DEV_SICIL = String(spec.sicil);
        const { evidencePackage } = await buildExecutiveReportEvidence({
          request: spec.request,
          now: REPORT_BENCH_NOW,
          today: REPORT_BENCH_TODAY
        });
        const preview = buildExecutiveEvidencePreview(evidencePackage, {
          includeRawText,
          syntheticContext: true
        });
        process.stdout.write(`\n[${key}] ${preview.ozet}\n`);
        if (showJson) process.stdout.write(`${preview.paketJson}\n`);
        if (!preview.gecerli) {
          process.exitCode = 1;
        }
      }
    } finally {
      await stack.dispose();
      if (previousDevSicil === undefined) delete process.env.MERGEN_ROTA_DEV_SICIL;
      else process.env.MERGEN_ROTA_DEV_SICIL = previousDevSicil;
    }
  }
}
