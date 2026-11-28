#!/usr/bin/env node
/**
 * Bilgin Aşama 4I-C — yönetici raporu doğrulama ve yerel onarım önizlemesi (geliştirici aracı).
 *
 * Dondurulmuş 48 senaryoluk kıyas paketleri ve kaydedilmiş yazar koşusu taslakları üzerinde:
 *   1. Belirlenimci nesnel olgu doğrulamasını (`verifyReportObjectiveFacts`) çalıştırır.
 *   2. Temsili vakalar (S04, S25, S40, S46, R8) üzerinde kontrollü sentetik denetçi/onarım
 *      yanıtlarıyla önce-sonra yerel onarım ve çağrı bütçesi özetini gösterir.
 *
 * Bu betik canlı model çağrısı yapmaz ve kurumsal nitelendirme kanıtı üretmez; yalnızca
 * belirlenimci doğrulama kapsamı ile yerel onarım boru hattının çevrimdışı tanılanması içindir.
 *
 * Kullanım:
 *   node scripts/yonetici-dogrulama-onizleme.mjs [--girdi kosu.jsonl] [--senaryolar S04,S25] [--ornekler] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from '../test/helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadReportStyle, loadWriterPackageSet } = await import('../test/helpers/executiveReportWriterBenchmark.mjs');
const { buildReportSectionPlan } = await import('../src/domain/ai/report/reportSectionPlan.js');
const { verifyReportObjectiveFacts } = await import('../src/domain/ai/report/reportClaims.js');
const { computeReviewTargetHash } = await import('../src/domain/ai/report/reportReview.js');
const { verifyAndRepairExecutiveReport } = await import('../src/server/ai/report/reportRepair.js');

const DEFAULT_ARCHIVE = path.join(ROOT, 'docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/kosu-kaydi.jsonl');

function parseArgs(argv) {
  const opts = { girdi: DEFAULT_ARCHIVE, senaryolar: null, ornekler: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ornekler') { opts.ornekler = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--girdi' && argv[i + 1]) { opts.girdi = path.resolve(argv[i + 1]); i += 1; continue; }
    if (arg === '--senaryolar' && argv[i + 1]) {
      opts.senaryolar = new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    process.stderr.write('Kullanım: node scripts/yonetici-dogrulama-onizleme.mjs [--girdi kosu.jsonl] [--senaryolar S04,S25] [--ornekler] [--json]\n');
    process.exit(2);
  }
  return opts;
}

function buildControlledCleanReview(messages, findings = []) {
  const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  return JSON.stringify({
    sozlesme: '4i-denetim-1',
    rapor_ozeti_sha256: payload.rapor_ozeti_sha256,
    kapsam: payload.hedefler.map((h) => ({ bolum: h.bolum, paragraf: h.paragraf })),
    degerlendirmeler: [],
    bulgular: findings
  });
}

async function runBeforeAfterExamples(packageById, style) {
  const examples = [];

  // 1. S25 — Tarihsel kronoloji tersinmesinin yalnızca ilgili paragrafta onarımı
  {
    const entry = packageById.get('S25');
    const intactP1 = 'Veri Akışı Ekibi, 2–8 Kasım 2026 haftasında Ufuk projesinde rapora açık iki görevi tamamladı; bu kapsam kısmi görünürlük altındadır.';
    const faultyP2 = '6 Kasım 2026 tarihli yük testi ortamı hazırlığının ardından 4 Kasım 2026 tarihinde veri akışı ölçüm sonuçları tamamlandı.';
    const draft = {
      sozlesme: '4i-yazim-1',
      baslik: 'Veri Akışı Ekibi Haftalık Raporu',
      bolumler: [{
        kimlik: 'faaliyetler',
        baslik: 'Faaliyetler',
        paragraflar: [
          { metin: intactP1, kanitlar: ['E1', 'E2'] },
          { metin: faultyP2, kanitlar: ['E3', 'E4'] }
        ]
      }],
      iddialar: []
    };
    const repairedP2 = '4 Kasım 2026 tarihinde tamamlanan veri akışı ölçüm sonuçlarının ardından 6 Kasım 2026 tarihinde yük testi ortamı hazırlığı sonuçlandırıldı.';
    const res = await verifyAndRepairExecutiveReport({
      draft,
      evidencePackage: entry.paket,
      style,
      gateway: {
        completeChat: async (opts) => {
          if (opts.profile === 'report.review') {
            return { text: buildControlledCleanReview(opts.messages), finishReason: 'stop', model: 'sentetik-denetci', configuredModel: 'sentetik-denetci' };
          }
          return {
            text: JSON.stringify({
              sozlesme: '4i-onarim-1',
              bolum: 'faaliyetler',
              paragraf: 2,
              metin: repairedP2,
              kanitlar: ['E3', 'E4'],
              iddialar: [{ alinti: repairedP2, sinif: 'nesnel_olgu', kanitlar: ['E3', 'E4'] }],
              uygulanan_islem: 'duzeltildi'
            }),
            finishReason: 'stop',
            model: 'sentetik-yazar',
            configuredModel: 'sentetik-yazar'
          };
        }
      },
      revalidate: async () => true,
      writerMeta: { yapilandirilanModel: 'sentetik-yazar', bildirilenModel: 'sentetik-yazar' },
      mandatoryFacts: entry.zorunlu_olgular
    });
    examples.push({
      vaka: 'S25 (kronoloji tersinmesi — yerel onarım)',
      once: faultyP2,
      sonra: res.taslak.bolumler[0].paragraflar[1].metin,
      etkilenmeyen_paragraf_korundu: res.taslak.bolumler[0].paragraflar[0].metin === intactP1,
      yayimlanabilir: res.yayimlanabilir,
      butce: res.butce
    });
  }

  // 2. S04 — Sayısal/yüzde hatasının (6/%200 → 7/%250) yerel onarımı
  {
    const entry = packageById.get('S04');
    const faultyP1 = "Ekim 2026'da altı görev tamamlandı; Eylül'de tamamlanan 2 göreve kıyasla bu yüzde 200 artış anlamına geliyor.";
    const intactP2 = '9 Kasım 2026 itibarıyla dokuz açık görevin biri gecikmiş durumda.';
    const draft = {
      sozlesme: '4i-yazim-1',
      baslik: 'Ekim 2026 Özet Raporu',
      bolumler: [{
        kimlik: 'yonetici_degerlendirmesi',
        baslik: 'Yönetici Değerlendirmesi',
        paragraflar: [
          { metin: faultyP1, kanitlar: ['E1', 'E7', 'F1'] },
          { metin: intactP2, kanitlar: ['E3', 'E4'] }
        ]
      }],
      iddialar: []
    };
    const repairedP1 = "Ekim 2026'da yedi görev tamamlandı; Eylül'de tamamlanan 2 göreve kıyasla bu yüzde 250 artış anlamına geliyor.";
    const res = await verifyAndRepairExecutiveReport({
      draft,
      evidencePackage: entry.paket,
      style,
      gateway: {
        completeChat: async (opts) => {
          if (opts.profile === 'report.review') {
            return { text: buildControlledCleanReview(opts.messages), finishReason: 'stop', model: 'sentetik-denetci', configuredModel: 'sentetik-denetci' };
          }
          return {
            text: JSON.stringify({
              sozlesme: '4i-onarim-1',
              bolum: 'yonetici_degerlendirmesi',
              paragraf: 1,
              metin: repairedP1,
              kanitlar: ['E1', 'E7', 'F1'],
              iddialar: [{ alinti: 'yüzde 250 artış', sinif: 'nesnel_olgu', kanitlar: ['F1'] }],
              uygulanan_islem: 'duzeltildi'
            }),
            finishReason: 'stop',
            model: 'sentetik-yazar',
            configuredModel: 'sentetik-yazar'
          };
        }
      },
      revalidate: async () => true,
      writerMeta: { yapilandirilanModel: 'sentetik-yazar', bildirilenModel: 'sentetik-yazar' }
    });
    examples.push({
      vaka: 'S04 (aritmetik ve yüzde sapması — yerel onarım)',
      once: faultyP1,
      sonra: res.taslak.bolumler[0].paragraflar[0].metin,
      etkilenmeyen_paragraf_korundu: res.taslak.bolumler[0].paragraflar[1].metin === intactP2,
      yayimlanabilir: res.yayimlanabilir,
      butce: res.butce
    });
  }

  // 3. R8 — Anlamsal desteksiz nedensellik bulgusunun toplu son denetimle onarımı
  {
    const entry = packageById.get('S15');
    const faultyP1 = 'Veri anı itibarıyla gecikmiş bir görev bulunmaktadır. Bu gecikme ekip içi iletişim eksikliğinden kaynaklanmıştır.';
    const repairedP1 = 'Veri anı itibarıyla gecikmiş bir görev bulunmaktadır. Ekip notlarına göre bu gecikme tedarik kaynaklı olarak kaydedilmiştir.';
    const draft = {
      sozlesme: '4i-yazim-1',
      baslik: 'Risk Değerlendirmesi',
      bolumler: [{
        kimlik: 'riskler',
        baslik: 'Riskler',
        paragraflar: [{ metin: faultyP1, kanitlar: ['E4'] }]
      }],
      iddialar: []
    };
    let reviewCall = 0;
    const res = await verifyAndRepairExecutiveReport({
      draft,
      evidencePackage: entry.paket,
      style,
      gateway: {
        completeChat: async (opts) => {
          if (opts.profile === 'report.review') {
            reviewCall += 1;
            const findings = reviewCall === 1
              ? [{
                  id: 'D1',
                  bolum: 'riskler',
                  paragraf: 1,
                  cumle: 2,
                  alinti: 'Bu gecikme ekip içi iletişim eksikliğinden kaynaklanmıştır.',
                  sinif: 'desteksiz_maddi_iddia',
                  sorun_turu: 'desteksiz_nedensellik',
                  siddet: 'kritik',
                  neden: 'Kayıtlarda iletişim eksikliği bulunmuyor; notlarda tedarik kaynaklı gecikme geçiyor.',
                  kanitlar: ['E4'],
                  onerilen_islem: 'yerel_onarim'
                }]
              : [];
            return { text: buildControlledCleanReview(opts.messages, findings), finishReason: 'stop', model: 'sentetik-denetci', configuredModel: 'sentetik-denetci' };
          }
          return {
            text: JSON.stringify({
              sozlesme: '4i-onarim-1',
              bolum: 'riskler',
              paragraf: 1,
              metin: repairedP1,
              kanitlar: ['E4'],
              iddialar: [],
              uygulanan_islem: 'duzeltildi'
            }),
            finishReason: 'stop',
            model: 'sentetik-yazar',
            configuredModel: 'sentetik-yazar'
          };
        }
      },
      revalidate: async () => true,
      writerMeta: { yapilandirilanModel: 'sentetik-yazar', bildirilenModel: 'sentetik-yazar' }
    });
    examples.push({
      vaka: 'R8 (desteksiz nedensellik — bağımsız denetim + yerel onarım + toplu son denetim)',
      once: faultyP1,
      sonra: res.taslak.bolumler[0].paragraflar[0].metin,
      etkilenmeyen_paragraf_korundu: true,
      yayimlanabilir: res.yayimlanabilir,
      butce: res.butce
    });
  }

  return examples;
}

const opts = parseArgs(process.argv.slice(2));
const style = loadReportStyle();
const packageSet = loadWriterPackageSet();
const packageById = new Map(packageSet.paketler.map((item) => [item.senaryo, item]));

const archiveSummary = {
  kaynak: path.relative(ROOT, opts.girdi),
  taranan_taslak: 0,
  belirlenimci_temiz: 0,
  belirlenimci_kritik_bulgulu: 0,
  kesin_kapi_ihlali_sayisi: 0,
  kod_dagilimi: {},
  vaka_ozetleri: []
};

if (existsSync(opts.girdi)) {
  const rows = readFileSync(opts.girdi, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  for (const row of rows) {
    const id = row.senaryo;
    if (opts.senaryolar && !opts.senaryolar.has(id)) continue;
    const pkgEntry = packageById.get(id);
    if (!pkgEntry || !row.taslak) continue;
    const plan = buildReportSectionPlan(pkgEntry.paket, style);
    const res = verifyReportObjectiveFacts({
      draft: row.taslak,
      evidencePackage: pkgEntry.paket,
      plan,
      mandatoryFacts: pkgEntry.zorunlu_olgular ?? [],
      unauthorizedEntities: pkgEntry.yetkisiz_varliklar ?? []
    });
    const crits = res.bulgular.filter((b) => b.siddet === 'kritik');
    archiveSummary.taranan_taslak += 1;
    if (crits.length === 0) archiveSummary.belirlenimci_temiz += 1;
    else archiveSummary.belirlenimci_kritik_bulgulu += 1;
    archiveSummary.kesin_kapi_ihlali_sayisi += res.kesin_kapilar.length;
    for (const f of crits) {
      archiveSummary.kod_dagilimi[f.kod] = (archiveSummary.kod_dagilimi[f.kod] || 0) + 1;
    }
    if (crits.length > 0) {
      archiveSummary.vaka_ozetleri.push({
        senaryo: id,
        kritik_sayisi: crits.length,
        kodlar: [...new Set(crits.map((c) => c.kod))],
        ozet_sha256: computeReviewTargetHash({ draft: row.taslak, targets: [{ bolum: row.taslak.bolumler[0].kimlik, paragraf: 1 }] }).slice(0, 12)
      });
    }
  }
}

const examples = opts.ornekler ? await runBeforeAfterExamples(packageById, style) : [];

if (opts.json) {
  process.stdout.write(`${JSON.stringify({ belirlenimci_tarama: archiveSummary, yerel_onarim_ornekleri: examples }, null, 2)}\n`);
} else {
  process.stdout.write(`# Bilgin 4I-C Belirlenimci Doğrulama Önizlemesi\n`);
  process.stdout.write(`- Kaynak: ${archiveSummary.kaynak}\n`);
  process.stdout.write(`- Taranan arşiv taslağı: ${archiveSummary.taranan_taslak} (temiz: ${archiveSummary.belirlenimci_temiz}, kritik bulgulu: ${archiveSummary.belirlenimci_kritik_bulgulu}, kesin kapı: ${archiveSummary.kesin_kapi_ihlali_sayisi})\n`);
  process.stdout.write(`- Bulgu kod dağılımı: ${JSON.stringify(archiveSummary.kod_dagilimi)}\n`);
  process.stdout.write(`- Not: Bu önizleme yalnızca belirlenimci nesnel doğrulama ve sentetik onarım örneklerini çalıştırır; canlı anlamsal denetçi modeli çağırmaz.\n`);
  if (examples.length > 0) {
    process.stdout.write(`\n## Kontrollü Önce-Sonra Yerel Onarım Örnekleri\n`);
    for (const ex of examples) {
      process.stdout.write(`\n### ${ex.vaka}\n`);
      process.stdout.write(`- Önce : ${ex.once}\n`);
      process.stdout.write(`- Sonra: ${ex.sonra}\n`);
      process.stdout.write(`- Etkilenmeyen paragraf korundu: ${ex.etkilenmeyen_paragraf_korundu} | Yayımlanabilir: ${ex.yayimlanabilir} | Bütçe: ${JSON.stringify(ex.butce)}\n`);
    }
  }
}
