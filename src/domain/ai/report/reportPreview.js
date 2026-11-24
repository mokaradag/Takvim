import { PROTECTED_TEXT_KEYS, validateEvidencePackageContract } from './reportRequest.js';

/**
 * Bilgin Aşama 4I-A — Geliştirici ve sınama amaçlı yönetici kanıt paketi tanı önizlemesi (saf).
 *
 * Üretim arayüzü veya HTTP ucu değildir. Varsayılan olarak ham not metinlerini genel tanı
 * özetinden dışlar; sentetik veya yerel geliştirici bağlamında açıkça istendiğinde not metnini
 * kaynak ve kayıt zamanı bağlamıyla birlikte gösterir.
 */

const PROTECTED_TEXT_KEY_SET = new Set(PROTECTED_TEXT_KEYS);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function redactProtectedKeysDeep(value) {
  if (Array.isArray(value)) return value.map(redactProtectedKeysDeep);
  if (!isPlainObject(value)) return value;
  const cleaned = {};
  let redactedAny = false;
  for (const [key, val] of Object.entries(value)) {
    if (PROTECTED_TEXT_KEY_SET.has(key)) {
      redactedAny = true;
      continue;
    }
    cleaned[key] = redactProtectedKeysDeep(val);
  }
  if (redactedAny) {
    cleaned.korunan_metin_gizlendi = true;
  }
  return cleaned;
}

function sanitizePackageForPreview(pkg, { includeRawText = false } = {}) {
  if (!isPlainObject(pkg)) return pkg;
  if (includeRawText) return pkg;
  const rawEntries = Array.isArray(pkg.kanitlar) ? pkg.kanitlar : [];
  const sanitizedTop = {};
  for (const [key, val] of Object.entries(pkg)) {
    if (key === 'kanitlar') continue;
    if (PROTECTED_TEXT_KEY_SET.has(key)) continue;
    sanitizedTop[key] = redactProtectedKeysDeep(val);
  }
  return {
    ...sanitizedTop,
    kanitlar: rawEntries.map((entry) => {
      if (!isPlainObject(entry)) return redactProtectedKeysDeep(entry);
      if (entry.tur === 'not') {
        const cleaned = redactProtectedKeysDeep(entry);
        delete cleaned.korunan_metin_gizlendi;
        return {
          ...cleaned,
          metin_gizlendi: true,
          metin_karakter_sayisi: typeof entry.metin === 'string' ? Array.from(entry.metin).length : 0
        };
      }
      return redactProtectedKeysDeep(entry);
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

  const pkgObj = isPlainObject(evidencePackage) ? evidencePackage : {};
  const safeObj = isPlainObject(safePackage) ? safePackage : {};
  const req = isPlainObject(pkgObj.istek) ? pkgObj.istek : {};
  const reqDonem = isPlainObject(req.donem) ? req.donem : {};
  const reqKapsam = isPlainObject(req.kapsam) ? req.kapsam : {};
  const scopeIds = Array.isArray(reqKapsam.kimlikler) ? reqKapsam.kimlikler : [];
  const rawKanitlar = Array.isArray(pkgObj.kanitlar) ? pkgObj.kanitlar : [];
  const safeKanitlar = Array.isArray(safeObj.kanitlar) ? safeObj.kanitlar : [];
  const safeTuretilmis = Array.isArray(safeObj.turetilmis) ? safeObj.turetilmis : [];
  const safeCeliskiler = Array.isArray(safeObj.celiskiler) ? safeObj.celiskiler : [];
  const sinirlar = isPlainObject(pkgObj.sinirlar) ? pkgObj.sinirlar : {};

  const lines = [];
  lines.push(`=== Bilgin Yönetici Kanıt Paketi Önizlemesi (${pkgObj.sema || 'bilinmiyor'}) ===`);
  lines.push(`Doğrulama: ${validation.ok ? 'GEÇERLİ' : `SORUNLU (${validation.problems.join(', ')})`}`);
  lines.push(`Rapor Türü: ${req.rapor_turu || '-'} | Ayrıntı: ${req.ayrinti || '-'} | Odak: ${req.odak || '-'}`);
  lines.push(`Dönem: ${reqDonem.baslangic || '-'} .. ${reqDonem.bitis || '-'} (${reqDonem.ad || '-'})`);
  if (req.karsilastirma && req.karsilastirma !== 'yok') {
    const comp = isPlainObject(req.karsilastirma_donemi) ? req.karsilastirma_donemi : {};
    lines.push(`Karşılaştırma (${req.karsilastirma}): ${comp.baslangic || '-'} .. ${comp.bitis || '-'} (${comp.ad || '-'})`);
  }
  lines.push(`Kapsam: ${reqKapsam.tur || '-'} → [${scopeIds.join(', ')}]`);
  lines.push(`Not Rızası: ${req.notlar || 'haric'} | Veri Anı: ${pkgObj.veri_ani || '-'}`);
  lines.push(`Boyut: ${rawKanitlar.length}/${sinirlar.kanit_sayisi_en_fazla ?? '-'} kanıt | ${validation.serializedChars}/${sinirlar.karakter_en_fazla ?? '-'} karakter`);

  const tamlik = isPlainObject(pkgObj.tamlik) ? pkgObj.tamlik : {};
  lines.push(`Tamlık: kapsam=${tamlik.kapsam_gorunurlugu || '-'}, hareket=${tamlik.hareket || '-'}, tarihsiz_tamamlanan=${tamlik.tarihsiz_tamamlanan === null ? 'bilinmiyor' : (tamlik.tarihsiz_tamamlanan ?? '-')}, kesildi=${Boolean(tamlik.paket_kesildi)}, dışarıda_kalan=${tamlik.disarida_kalan_kanit ?? 0}`);
  if (tamlik.notlar) lines.push(`Not Tamlığı: ${tamlik.notlar}`);

  lines.push('');
  lines.push(`--- Kanıtlar (${safeKanitlar.length}) ---`);
  const byType = {};
  for (const entry of safeKanitlar) {
    // Bozuk veya boş kanıt girdileri önizlemeyi düşürmez; doğrulama sorunları korunur.
    if (!isPlainObject(entry)) continue;
    byType[entry.tur] = (byType[entry.tur] || 0) + 1;
    const entryDonem = isPlainObject(entry.donem) ? entry.donem : null;
    const timeTag = entryDonem
      ? `dönem=${entryDonem.baslangic || '-'}..${entryDonem.bitis || '-'}`
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
        ? ` | metin="${entry.metin ?? ''}"`
        : ` | metin=<gizlendi:${entry.metin_karakter_sayisi ?? 0} krk>`;
      lines.push(`[${entry.id}] NOT | kaynak=${entry.kaynak} | gorev=${entry.gorev} | ${timeTag}${flags ? ` | [${flags}]` : ''}${previewText}`);
    } else if (entry.tur === 'hareket') {
      lines.push(`[${entry.id}] HAREKET | kaynak=${entry.kaynak} | ${timeTag} | kayit_kapsami=${entry.kayit_kapsami || '-'} | ozet=${JSON.stringify(entry.donem_ozeti || {})}`);
    } else {
      lines.push(`[${entry.id}] ${String(entry.tur || 'DIGER').toUpperCase()} | kaynak=${entry.kaynak} | ${timeTag}`);
    }
  }

  if (safeTuretilmis.length > 0) {
    lines.push('');
    lines.push(`--- Sunucu Türetimleri (${safeTuretilmis.length}) ---`);
    for (const finding of safeTuretilmis) {
      if (!isPlainObject(finding)) continue;
      const refs = Array.isArray(finding.girdiler) ? finding.girdiler : [];
      lines.push(`[${finding.id}] ${finding.tur} | girdiler=[${refs.join(', ')}] | deger=${JSON.stringify(finding.deger)}${finding.kosul ? ` | kosul=${finding.kosul}` : ''}`);
    }
  }

  if (safeCeliskiler.length > 0) {
    lines.push('');
    lines.push(`--- Çelişkiler (${safeCeliskiler.length}) ---`);
    for (const conflict of safeCeliskiler) {
      if (!isPlainObject(conflict)) continue;
      const refs = Array.isArray(conflict.kanitlar) ? conflict.kanitlar : [];
      lines.push(`! ${conflict.tur} | kanitlar=[${refs.join(', ')}] | ${conflict.aciklama || ''}`);
    }
  }

  return {
    gecerli: validation.ok,
    sorunlar: validation.problems,
    ozet: lines.join('\n'),
    paketJson: JSON.stringify(safePackage, null, 2),
    secimTanisi: {
      kanitSayilari: byType,
      turetimSayisi: safeTuretilmis.filter(isPlainObject).length,
      celiskiSayisi: safeCeliskiler.filter(isPlainObject).length,
      paketKesildi: Boolean(tamlik.paket_kesildi),
      disaridaKalanKanit: tamlik.disarida_kalan_kanit ?? 0,
      karakterSayisi: validation.serializedChars,
      hamMetinDahil: allowRawText
    }
  };
}
