import { validateEvidencePackageContract } from './reportRequest.js';

/**
 * Bilgin Aşama 4I-A — Geliştirici ve sınama amaçlı yönetici kanıt paketi tanı önizlemesi (saf).
 *
 * Üretim arayüzü veya HTTP ucu değildir. Varsayılan olarak ham not metinlerini genel tanı
 * özetinden dışlar; sentetik veya yerel geliştirici bağlamında açıkça istendiğinde not metnini
 * kaynak ve kayıt zamanı bağlamıyla birlikte gösterir.
 */

function sanitizePackageForPreview(pkg, { includeRawText = false } = {}) {
  if (includeRawText) return pkg;
  return {
    ...pkg,
    kanitlar: (pkg.kanitlar || []).map((entry) => {
      if (entry?.tur !== 'not') return entry;
      const { metin, ...rest } = entry;
      return {
        ...rest,
        metin_gizlendi: true,
        metin_karakter_sayisi: typeof metin === 'string' ? Array.from(metin).length : 0
      };
    })
  };
}

/**
 * Kanonik `4i-kanit-1` paketi için okunur Türkçe tanı özeti ve güvenli JSON çıktısı üretir.
 *
 * @param {object} evidencePackage - Kurulmuş `4i-kanit-1` kanıt paketi.
 * @param {{ includeRawText?: boolean, syntheticContext?: boolean }} [options] - Önizleme seçenekleri.
 * @returns {{ gecerli: boolean, sorunlar: string[], ozet: string, paketJson: string, secimTanisi: object }} Tanı önizlemesi.
 */
export function buildExecutiveEvidencePreview(evidencePackage, { includeRawText = false, syntheticContext = false } = {}) {
  // Ham not metni yalnızca açıkça sentetik/yerel geliştirici bağlamı bildirildiğinde gösterilir.
  const allowRawText = includeRawText === true && syntheticContext === true;
  const validation = validateEvidencePackageContract(evidencePackage);
  const safePackage = sanitizePackageForPreview(evidencePackage, { includeRawText: allowRawText });

  const lines = [];
  const req = evidencePackage?.istek || {};
  lines.push(`=== Bilgin Yönetici Kanıt Paketi Önizlemesi (${evidencePackage?.sema || 'bilinmiyor'}) ===`);
  lines.push(`Doğrulama: ${validation.ok ? 'GEÇERLİ' : `SORUNLU (${validation.problems.join(', ')})`}`);
  lines.push(`Rapor Türü: ${req.rapor_turu || '-'} | Ayrıntı: ${req.ayrinti || '-'} | Odak: ${req.odak || '-'}`);
  lines.push(`Dönem: ${req.donem?.baslangic || '-'} .. ${req.donem?.bitis || '-'} (${req.donem?.ad || '-'})`);
  if (req.karsilastirma && req.karsilastirma !== 'yok') {
    const comp = req.karsilastirma_donemi;
    lines.push(`Karşılaştırma (${req.karsilastirma}): ${comp?.baslangic || '-'} .. ${comp?.bitis || '-'} (${comp?.ad || '-'})`);
  }
  lines.push(`Kapsam: ${req.kapsam?.tur || '-'} → [${(req.kapsam?.kimlikler || []).join(', ')}]`);
  lines.push(`Not Rızası: ${req.notlar || 'haric'} | Veri Anı: ${evidencePackage?.veri_ani || '-'}`);
  lines.push(`Boyut: ${(evidencePackage?.kanitlar || []).length}/${evidencePackage?.sinirlar?.kanit_sayisi_en_fazla ?? '-'} kanıt | ${validation.serializedChars}/${evidencePackage?.sinirlar?.karakter_en_fazla ?? '-'} karakter`);

  const tamlik = evidencePackage?.tamlik || {};
  lines.push(`Tamlık: kapsam=${tamlik.kapsam_gorunurlugu || '-'}, hareket=${tamlik.hareket || '-'}, tarihsiz_tamamlanan=${tamlik.tarihsiz_tamamlanan === null ? 'bilinmiyor' : (tamlik.tarihsiz_tamamlanan ?? '-')}, kesildi=${Boolean(tamlik.paket_kesildi)}, dışarıda_kalan=${tamlik.disarida_kalan_kanit ?? 0}`);
  if (tamlik.notlar) lines.push(`Not Tamlığı: ${tamlik.notlar}`);

  lines.push('');
  lines.push(`--- Kanıtlar (${(safePackage.kanitlar || []).length}) ---`);
  for (const entry of safePackage.kanitlar || []) {
    const timeTag = entry.donem
      ? `dönem=${entry.donem.baslangic}..${entry.donem.bitis}`
      : entry.veri_ani
        ? `veri_ani=${entry.veri_ani}`
        : entry.kayit_zamani
          ? `kayit_zamani=${entry.kayit_zamani}`
          : entry.kayit_zamani_durumu === 'bilinmiyor'
            ? 'kayit_zamani=bilinmiyor'
            : 'zaman=-';

    if (entry.tur === 'olcu') {
      lines.push(`[${entry.id}] OLCU | kaynak=${entry.kaynak} | ${entry.olcu}=${entry.deger === null ? 'null' : entry.deger} | ${timeTag}${entry.tamlik ? ` | tamlik=${entry.tamlik}` : ''}${entry.kayit_kapsami ? ` | kayit_kapsami=${entry.kayit_kapsami}` : ''}`);
    } else if (entry.tur === 'gorev') {
      lines.push(`[${entry.id}] GOREV | kaynak=${entry.kaynak} | ${entry.gorev} (${entry.proje || '-'}) | durum=${entry.durum} | oncelik=${entry.oncelik || '-'}${entry.kilometre_tasi ? ' | KT' : ''} | ${entry.baslik || ''}`);
    } else if (entry.tur === 'not') {
      const flags = [
        entry.surum_tipi ? `surum=${entry.surum_tipi}` : null,
        entry.kirpildi ? 'kirpildi' : null,
        entry.guvenilmez_yonerge_iceriyor ? 'GUVENILMEZ_YONERGE' : null
      ].filter(Boolean).join(', ');
      const previewText = allowRawText
        ? ` | metin="${entry.metin}"`
        : ` | metin=<gizlendi:${entry.metin_karakter_sayisi} krk>`;
      lines.push(`[${entry.id}] NOT | kaynak=${entry.kaynak} | gorev=${entry.gorev} | ${timeTag}${flags ? ` | [${flags}]` : ''}${previewText}`);
    } else if (entry.tur === 'hareket') {
      lines.push(`[${entry.id}] HAREKET | kaynak=${entry.kaynak} | ${timeTag} | kayit_kapsami=${entry.kayit_kapsami || '-'} | ozet=${JSON.stringify(entry.donem_ozeti || {})}`);
    } else {
      lines.push(`[${entry.id}] ${String(entry.tur || 'DIGER').toUpperCase()} | kaynak=${entry.kaynak} | ${timeTag}`);
    }
  }

  if ((safePackage.turetilmis || []).length > 0) {
    lines.push('');
    lines.push(`--- Sunucu Türetimleri (${safePackage.turetilmis.length}) ---`);
    for (const finding of safePackage.turetilmis) {
      lines.push(`[${finding.id}] ${finding.tur} | girdiler=[${(finding.girdiler || []).join(', ')}] | deger=${JSON.stringify(finding.deger)}${finding.kosul ? ` | kosul=${finding.kosul}` : ''}`);
    }
  }

  if ((safePackage.celiskiler || []).length > 0) {
    lines.push('');
    lines.push(`--- Çelişkiler (${safePackage.celiskiler.length}) ---`);
    for (const conflict of safePackage.celiskiler) {
      lines.push(`! ${conflict.tur} | kanitlar=[${(conflict.kanitlar || []).join(', ')}] | ${conflict.aciklama || ''}`);
    }
  }

  const byType = {};
  for (const entry of safePackage.kanitlar || []) {
    byType[entry.tur] = (byType[entry.tur] || 0) + 1;
  }

  return {
    gecerli: validation.ok,
    sorunlar: validation.problems,
    ozet: lines.join('\n'),
    paketJson: JSON.stringify(safePackage, null, 2),
    secimTanisi: {
      kanitSayilari: byType,
      turetimSayisi: (safePackage.turetilmis || []).length,
      celiskiSayisi: (safePackage.celiskiler || []).length,
      paketKesildi: Boolean(tamlik.paket_kesildi),
      disaridaKalanKanit: tamlik.disarida_kalan_kanit ?? 0,
      karakterSayisi: validation.serializedChars,
      hamMetinDahil: allowRawText
    }
  };
}
