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

function safeText(value, fallback = '-') {
  if (typeof value === 'string') return value || fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function safeJson(value, fallback = '{}') {
  try {
    const out = JSON.stringify(value);
    return typeof out === 'string' ? out : fallback;
  } catch {
    return fallback;
  }
}

function redactProtectedKeysDeep(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (visited.has(value)) return null;
  visited.add(value);
  if (Array.isArray(value)) return value.map((item) => redactProtectedKeysDeep(item, visited));
  const cleaned = {};
  let redactedAny = false;
  for (const [key, val] of Object.entries(value)) {
    if (PROTECTED_TEXT_KEY_SET.has(key)) {
      redactedAny = true;
      continue;
    }
    cleaned[key] = redactProtectedKeysDeep(val, visited);
  }
  if (redactedAny) {
    cleaned.korunan_metin_gizlendi = true;
  }
  return cleaned;
}

function sanitizePackageForPreview(pkg, { includeRawText = false } = {}) {
  if (includeRawText) return pkg;
  if (!isPlainObject(pkg)) return redactProtectedKeysDeep(pkg);
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
  const unserializable = validation.problems.includes('paket:serilestirilemiyor');
  const safePackage = unserializable
    ? null
    : sanitizePackageForPreview(evidencePackage, { includeRawText: allowRawText });

  const pkgObj = isPlainObject(evidencePackage) ? evidencePackage : {};
  const safeObj = isPlainObject(safePackage) ? safePackage : {};
  const req = isPlainObject(pkgObj.istek) ? pkgObj.istek : {};
  const reqDonem = isPlainObject(req.donem) ? req.donem : {};
  const reqKapsam = isPlainObject(req.kapsam) ? req.kapsam : {};
  const scopeIds = Array.isArray(reqKapsam.kimlikler) ? reqKapsam.kimlikler.map((id) => safeText(id, '?')) : [];
  const rawKanitlar = Array.isArray(pkgObj.kanitlar) ? pkgObj.kanitlar : [];
  const safeKanitlar = Array.isArray(safeObj.kanitlar) ? safeObj.kanitlar : [];
  const safeTuretilmis = Array.isArray(safeObj.turetilmis) ? safeObj.turetilmis : [];
  const safeCeliskiler = Array.isArray(safeObj.celiskiler) ? safeObj.celiskiler : [];
  const sinirlar = isPlainObject(pkgObj.sinirlar) ? pkgObj.sinirlar : {};

  const lines = [];
  lines.push(`=== Bilgin Yönetici Kanıt Paketi Önizlemesi (${safeText(pkgObj.sema, 'bilinmiyor')}) ===`);
  lines.push(`Doğrulama: ${validation.ok ? 'GEÇERLİ' : `SORUNLU (${validation.problems.join(', ')})`}`);
  lines.push(`Rapor Türü: ${safeText(req.rapor_turu)} | Ayrıntı: ${safeText(req.ayrinti)} | Odak: ${safeText(req.odak)}`);
  lines.push(`Dönem: ${safeText(reqDonem.baslangic)} .. ${safeText(reqDonem.bitis)} (${safeText(reqDonem.ad)})`);
  if (req.karsilastirma && req.karsilastirma !== 'yok') {
    const comp = isPlainObject(req.karsilastirma_donemi) ? req.karsilastirma_donemi : {};
    lines.push(`Karşılaştırma (${safeText(req.karsilastirma)}): ${safeText(comp.baslangic)} .. ${safeText(comp.bitis)} (${safeText(comp.ad)})`);
  }
  lines.push(`Kapsam: ${safeText(reqKapsam.tur)} → [${scopeIds.join(', ')}]`);
  lines.push(`Not Rızası: ${safeText(req.notlar, 'haric')} | Veri Anı: ${safeText(pkgObj.veri_ani)}`);
  lines.push(`Boyut: ${rawKanitlar.length}/${safeText(sinirlar.kanit_sayisi_en_fazla)} kanıt | ${validation.serializedChars}/${safeText(sinirlar.karakter_en_fazla)} karakter`);

  const tamlik = isPlainObject(pkgObj.tamlik) ? pkgObj.tamlik : {};
  const tarihsizText = tamlik.tarihsiz_tamamlanan === null ? 'bilinmiyor' : safeText(tamlik.tarihsiz_tamamlanan);
  lines.push(`Tamlık: kapsam=${safeText(tamlik.kapsam_gorunurlugu)}, hareket=${safeText(tamlik.hareket)}, tarihsiz_tamamlanan=${tarihsizText}, kesildi=${Boolean(tamlik.paket_kesildi)}, dışarıda_kalan=${safeText(tamlik.disarida_kalan_kanit, '0')}`);
  if (tamlik.notlar) lines.push(`Not Tamlığı: ${safeText(tamlik.notlar)}`);

  lines.push('');
  lines.push(`--- Kanıtlar (${safeKanitlar.length}) ---`);
  const byType = {};
  for (const entry of safeKanitlar) {
    // Bozuk veya boş kanıt girdileri önizlemeyi düşürmez; doğrulama sorunları korunur.
    if (!isPlainObject(entry)) continue;
    const turKey = safeText(entry.tur, 'diger');
    byType[turKey] = (byType[turKey] || 0) + 1;
    const entryDonem = isPlainObject(entry.donem) ? entry.donem : null;
    const timeTag = entryDonem
      ? `dönem=${safeText(entryDonem.baslangic)}..${safeText(entryDonem.bitis)}`
      : entry.veri_ani
        ? `veri_ani=${safeText(entry.veri_ani)}`
        : entry.kayit_zamani
          ? `kayit_zamani=${safeText(entry.kayit_zamani)}`
          : entry.kayit_zamani_durumu === 'bilinmiyor'
            ? 'kayit_zamani=bilinmiyor'
            : 'zaman=-';

    if (entry.tur === 'olcu') {
      lines.push(`[${safeText(entry.id)}] OLCU | kaynak=${safeText(entry.kaynak)} | ${safeText(entry.olcu)}=${entry.deger === null ? 'null' : safeText(entry.deger)} | ${timeTag}${entry.tamlik ? ` | tamlik=${safeText(entry.tamlik)}` : ''}${entry.kayit_kapsami ? ` | kayit_kapsami=${safeText(entry.kayit_kapsami)}` : ''}`);
    } else if (entry.tur === 'gorev') {
      lines.push(`[${safeText(entry.id)}] GOREV | kaynak=${safeText(entry.kaynak)} | ${safeText(entry.gorev)} (${safeText(entry.proje)}) | durum=${safeText(entry.durum)} | oncelik=${safeText(entry.oncelik)}${entry.kilometre_tasi ? ' | KT' : ''} | ${safeText(entry.baslik, '')}`);
    } else if (entry.tur === 'not') {
      const flags = [
        entry.surum_tipi ? `surum=${safeText(entry.surum_tipi)}` : null,
        entry.kirpildi ? 'kirpildi' : null,
        entry.guvenilmez_yonerge_iceriyor ? 'GUVENILMEZ_YONERGE' : null
      ].filter(Boolean).join(', ');
      const previewText = allowRawText
        ? ` | metin="${safeText(entry.metin, '')}"`
        : ` | metin=<gizlendi:${safeText(entry.metin_karakter_sayisi, '0')} krk>`;
      lines.push(`[${safeText(entry.id)}] NOT | kaynak=${safeText(entry.kaynak)} | gorev=${safeText(entry.gorev)} | ${timeTag}${flags ? ` | [${flags}]` : ''}${previewText}`);
    } else if (entry.tur === 'hareket') {
      lines.push(`[${safeText(entry.id)}] HAREKET | kaynak=${safeText(entry.kaynak)} | ${timeTag} | kayit_kapsami=${safeText(entry.kayit_kapsami)} | ozet=${safeJson(entry.donem_ozeti || {})}`);
    } else {
      lines.push(`[${safeText(entry.id)}] ${safeText(entry.tur, 'DIGER').toUpperCase()} | kaynak=${safeText(entry.kaynak)} | ${timeTag}`);
    }
  }

  if (safeTuretilmis.length > 0) {
    lines.push('');
    lines.push(`--- Sunucu Türetimleri (${safeTuretilmis.length}) ---`);
    for (const finding of safeTuretilmis) {
      if (!isPlainObject(finding)) continue;
      const refs = Array.isArray(finding.girdiler) ? finding.girdiler.map((ref) => safeText(ref, '?')) : [];
      lines.push(`[${safeText(finding.id)}] ${safeText(finding.tur)} | girdiler=[${refs.join(', ')}] | deger=${safeJson(finding.deger, 'null')}${finding.kosul ? ` | kosul=${safeText(finding.kosul)}` : ''}`);
    }
  }

  if (safeCeliskiler.length > 0) {
    lines.push('');
    lines.push(`--- Çelişkiler (${safeCeliskiler.length}) ---`);
    for (const conflict of safeCeliskiler) {
      if (!isPlainObject(conflict)) continue;
      const refs = Array.isArray(conflict.kanitlar) ? conflict.kanitlar.map((ref) => safeText(ref, '?')) : [];
      lines.push(`! ${safeText(conflict.tur)} | kanitlar=[${refs.join(', ')}] | ${safeText(conflict.aciklama, '')}`);
    }
  }

  let paketJson;
  if (unserializable) {
    paketJson = JSON.stringify({ hata: 'paket:serilestirilemiyor' }, null, 2);
  } else {
    try {
      paketJson = JSON.stringify(safePackage, null, 2) ?? 'null';
    } catch {
      paketJson = JSON.stringify({ hata: 'paket:serilestirilemiyor' }, null, 2);
    }
  }

  return {
    gecerli: validation.ok,
    sorunlar: validation.problems,
    ozet: lines.join('\n'),
    paketJson,
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
