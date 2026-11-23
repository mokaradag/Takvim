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

const args = process.argv.slice(2);
const showJson = args.includes('--json');
const includeRawText = args.includes('--ham-not');
const requested = args.find((arg) => !arg.startsWith('--')) || 'tumu';
const targetKeys = requested === 'tumu' ? Object.keys(CASES) : [requested.toUpperCase()];

const stack = await createActualStack(executiveReportBenchmarkSeed(), { sicil: REPORT_BENCH_USERS.YONETICI });
try {
  for (const key of targetKeys) {
    if (!Object.hasOwn(CASES, key)) {
      process.stderr.write(`Bilinmeyen sentetik kıyas vakası: ${key}\n`);
      process.exitCode = 1;
      break;
    }
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
  }
} finally {
  await stack.dispose();
}
