/**
 * Bilgin Aşama 4I-B — yazar kıyası için sentetik kanıt paketi kümesi ve belirlenimci nesnel değerlendirme.
 *
 * Yalnızca geliştirme ve sınama altyapısıdır; uygulama çalışma zamanı bu dosyayı yüklemez.
 *
 *   - Temsili vakalar (R1–R8) fikstürdeki dondurulmuş kanıtlardan `4i-kanit-1` zarfına AYNEN sarılır: olgu
 *     değeri, metin, kimlik ya da tarih değiştirilmez; yalnızca 4I-A kurucusunun aynı durum için ürettiği
 *     zarf alanları (rıza ve güvenilmez veri işaretleri, tamlık, çelişki işareti) eklenir.
 *   - Diğer senaryolar 4I-A kurucusunun sentetik SQL ikiziyle ürettiği ve sürümlü dosyada dondurulmuş
 *     paketlerdir (`test/fixtures/bilgin-executive-report-writer-packages.json`).
 *   - Nesnel değerlendirme düzyazının kendisinden yapılır; yazarın iddia eki kapsamı daraltmaz.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCHMARK_FIXTURE_PATH = 'test/fixtures/bilgin-executive-report-benchmark.json';
export const WRITER_PACKAGES_PATH = 'test/fixtures/bilgin-executive-report-writer-packages.json';
export const REPORT_STYLE_PATH = 'config/ai/bilgin_rapor_stili.yaml';

export function readRepoFile(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

export function loadBenchmarkFixture() {
  return JSON.parse(readRepoFile(BENCHMARK_FIXTURE_PATH));
}

export function loadReportStyle() {
  return yaml.load(readRepoFile(REPORT_STYLE_PATH), { schema: yaml.CORE_SCHEMA });
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Kanonik JSON (anahtarlar sıralı): paket özeti alan sırasından bağımsızdır. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const PERIOD_TYPE_BY_SCENARIO = Object.freeze({ haftalik: 'haftalik', aylik: 'aylik', ozel: 'ozel' });

/**
 * 4I-A kurucusunun aynı durumlar için ürettiği zarf işaretleri. Değerler kurucunun tanı önizlemesiyle
 * karşılaştırılmıştır (R4: ardışık not sürümü çelişkisi; R5: tarihsiz tamamlanan; R8: kısmi görünürlük).
 * Olgu eklemez; yalnızca sunucunun bu durumlarda zaten yazdığı tamlık/çelişki bilgisini zarfa taşır.
 */
const REPRESENTATIVE_ENVELOPE = Object.freeze({
  R4: { celiskiler: [{ tur: 'not_surum_celiskisi', kanitlar: ['E1', 'E2'], kronoloji: ['2026-11-03T09:15:00+03:00', '2026-11-07T15:30:00+03:00'],
    aciklama: 'Aynı görevin ardışık not sürümleri arasında zaman sırasıyla değişen çelişkili bildirimler bulundu.' }] },
  R8: { tamlik: { kapsam_gorunurlugu: 'partial', projeler: { tam: 0, okuma: 0, kismi: 1 } } }
});

/**
 * Fikstürün 4I-0'da yazılan üç vakası (R3, R5, R7) veri anını dönemin son günü `23:59:59.999999999` olarak verir.
 * 4I-A sözleşmesi (`validateEvidencePackageContract`) ise yalnızca kapanmış dönemi kabul eder ve İstanbul iş günü
 * hâlâ dönem içindeyse paketi açık dönem sayar. Fikstür ve 4I-A sözleşmesi değiştirilmez: bu gün sonu işareti,
 * 1 ns sonraki eşdeğer kapanış anına (ertesi gün 00:00:00) eşlenir. Başka hiçbir değer değişmez.
 */
function closedPeriodInstant(value, periodEnd) {
  const sentinel = `${periodEnd}T23:59:59.999999999+03:00`;
  if (value !== sentinel) return value;
  const next = new Date(`${periodEnd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00:00+03:00`;
}

function noteEnvelope(item) {
  if (item.tur !== 'not') return item;
  const known = typeof item.kayit_zamani === 'string';
  return {
    ...item,
    kayit_zamani: known ? item.kayit_zamani : null,
    kayit_zamani_durumu: known ? 'biliniyor' : 'bilinmiyor',
    guvenilmez_veri: true,
    metin_turu: 'kayitli_kullanici_metni',
    olay_tarihi_ayri: true
  };
}

/**
 * Temsili vakayı (R1–R8) `4i-kanit-1` paketine sarar.
 *
 * @param {object} fixture - Kıyas fikstürü.
 * @param {string} caseId - R1…R8.
 * @returns {object} Kanıt paketi.
 */
export function representativeCasePackage(fixture, caseId) {
  const entry = fixture.temsili_vakalar.find((item) => item.id === caseId);
  if (!entry) throw new Error(`Bilinmeyen temsili vaka: ${caseId}`);
  const scenario = fixture.senaryolar.find((item) => item.id === entry.senaryo);
  const periodEnd = entry.istek.donem.bitis;
  const kanitlar = entry.kanitlar.map(noteEnvelope).map((item) => (
    typeof item.veri_ani === 'string' ? { ...item, veri_ani: closedPeriodInstant(item.veri_ani, periodEnd) } : item
  ));
  const undated = kanitlar.find((item) => item.tur === 'olcu' && item.olcu === 'history.undatedDone');
  const envelope = REPRESENTATIVE_ENVELOPE[caseId] || {};
  const notes = kanitlar.filter((item) => item.tur === 'not').length;
  const consent = entry.istek.notlar === 'dahil';
  return {
    sema: '4i-kanit-1',
    istek: {
      rapor_turu: PERIOD_TYPE_BY_SCENARIO[scenario.donem],
      donem: { baslangic: entry.istek.donem.baslangic, bitis: entry.istek.donem.bitis },
      kapsam: structuredClone(entry.istek.kapsam),
      ayrinti: entry.istek.ayrinti ?? scenario.ayrinti,
      odak: entry.istek.odak ?? scenario.odak,
      notlar: entry.istek.notlar,
      karsilastirma: 'yok'
    },
    veri_ani: closedPeriodInstant(entry.veri_ani, periodEnd),
    kanitlar,
    turetilmis: [],
    tamlik: {
      kapsam_gorunurlugu: 'complete',
      gorevler: { dahil: kanitlar.filter((item) => item.tur === 'gorev').length, kesildi: false },
      notlar: consent ? `${notes} not` : 'hariç (rıza yok)',
      not_ozeti: { riza: consent, dahil: consent ? notes : 0 },
      hareket: 'complete',
      tarihsiz_tamamlanan: undated ? undated.deger : 0,
      paket_kesildi: false,
      ...(envelope.tamlik || {})
    },
    celiskiler: structuredClone(envelope.celiskiler || []),
    sinirlar: { kanit_sayisi_en_fazla: 120, karakter_en_fazla: 120000, not_karakter_en_fazla: 1600 }
  };
}

// ---------------------------------------------------------------- dondurulmuş paket kümesi

/**
 * Dondurulmuş paket kümesini okur ve bütünlüğünü doğrular: sürüm, özet, senaryo eşlemesi ve sentetik köken.
 * Özet ya da kökeni doğrulanamayan küme kullanılmaz (vekil model koşusu buna dayanır).
 */
export function loadWriterPackageSet() {
  const raw = readRepoFile(WRITER_PACKAGES_PATH);
  const set = JSON.parse(raw);
  const fixture = loadBenchmarkFixture();
  const problems = verifyWriterPackageSet(set, fixture);
  if (problems.length) throw new Error(`Dondurulmuş paket kümesi doğrulanamadı: ${problems.slice(0, 5).join('; ')}`);
  return set;
}

/** Paket kümesindeki her özel adın sentetik kadrodan olduğunu ve özetin tuttuğunu doğrular. */
export function verifyWriterPackageSet(set, fixture) {
  const problems = [];
  if (set?.sema !== 'bilgin-yonetici-raporu-yazar-paketleri' || set?.veri_niteligi !== 'sentetik') problems.push('sema_ya_da_veri_niteligi');
  if (fixture?.veri_niteligi !== 'sentetik') problems.push('fikstur_sentetik_degil');
  const scenarios = new Map((fixture?.senaryolar || []).map((item) => [item.id, item]));
  const packages = Array.isArray(set?.paketler) ? set.paketler : [];
  const ids = packages.map((item) => item.senaryo);
  if (ids.length !== scenarios.size || new Set(ids).size !== ids.length || ids.some((id) => !scenarios.has(id))) problems.push('senaryo_kumesi_eksik');
  const expectedHash = sha256(canonicalJson(packages));
  if (set?.ozet_sha256 !== expectedHash) problems.push('ozet_uyusmuyor');
  const roster = syntheticRoster(fixture);
  for (const entry of packages) {
    for (const name of properNamesIn(entry.paket)) {
      if (!roster.has(name)) problems.push(`sentetik_olmayan_ad:${entry.senaryo}`);
    }
  }
  return [...new Set(problems)];
}

/** Sentetik kadrodaki bütün özel adlar (kişi, proje kodu ve adı, birim, ekip, kapalı varlık). */
export function syntheticRoster(fixture) {
  const k = fixture.sentetik_kadro;
  return new Set([
    ...k.kisiler, ...k.birimler, ...k.ekipler,
    ...Object.keys(k.projeler), ...Object.values(k.projeler),
    ...Object.keys(k.kapali_varliklar), ...Object.values(k.kapali_varliklar),
    'Mühendislik Direktörlüğü'
  ]);
}

const NAME_FIELDS = new Set(['proje', 'proje_adi', 'sorumlu', 'ekip']);

/** Paketin yapılandırılmış ad alanlarındaki özel adlar (metin alanları hariç; onlar kullanıcı verisidir). */
export function properNamesIn(pkg) {
  const names = new Set();
  for (const id of pkg?.istek?.kapsam?.kimlikler || []) names.add(id);
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (NAME_FIELDS.has(key) && typeof inner === 'string') names.add(inner);
        else if (key === 'kapsam' && Array.isArray(inner)) inner.forEach((id) => typeof id === 'string' && names.add(id));
        else if (typeof inner === 'object') visit(inner);
      }
    }
  };
  visit(pkg?.kanitlar);
  return names;
}

// ---------------------------------------------------------------- nesnel değerlendirme

const NUMBER_WORDS = Object.freeze({
  sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10,
  'on bir': 11, 'on iki': 12, 'on üç': 13, 'on dört': 14, 'on beş': 15, 'on altı': 16, 'on yedi': 17, 'on sekiz': 18, 'on dokuz': 19,
  yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90, yüz: 100
});
const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayis', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasim', 'aralik'];

/** Değerlendirme kopyası: Türkçe küçük harf, boşluk sadeleştirme, sayı sözcükleri rakama. */
export function normalizeProse(text) {
  // Türkçe küçük harfe çevirme kısaltmalardaki I'yı ı yapar ("SPI" → "spı"); eşleştirmede ı ve i katlanır.
  let out = ` ${String(text).normalize('NFC').toLocaleLowerCase('tr-TR').replace(/ı/gu, 'i').replace(/[’']/gu, "'").replace(/\s+/gu, ' ')} `;
  const words = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length);
  for (const word of words) {
    // "bir" belirsiz tanımlıktır ("bir görev"); yalnızca açık sayı bağlamında dönüştürülmez, olduğu gibi kalır.
    if (word === 'bir') continue;
    out = out.replace(new RegExp(`(?<=[\\s(])${word.replace(/ı/gu, 'i')}(?=[\\s.,;:)'])`, 'gu'), String(NUMBER_WORDS[word]));
  }
  return out;
}

/** Düzyazıdaki tarihleri ISO güne çevirir ("5 Kasım 2026", "5 Kasım", "2–8 Kasım 2026" aralığının iki ucu). */
export function extractDates(text, defaultYear) {
  const norm = normalizeProse(text);
  const days = new Set();
  const monthAlt = MONTHS.join('|');
  const range = new RegExp(`(\\d{1,2})\\s*[–-]\\s*(\\d{1,2})\\s+(${monthAlt})(?:\\s+(\\d{4}))?`, 'gu');
  for (const m of norm.matchAll(range)) {
    const year = m[4] ? Number(m[4]) : defaultYear;
    const month = MONTHS.indexOf(m[3]) + 1;
    days.add(iso(year, month, Number(m[1])));
    days.add(iso(year, month, Number(m[2])));
  }
  const single = new RegExp(`(\\d{1,2})\\s+(${monthAlt})(?:'?[a-zçğıöşü]*)?(?:\\s+(\\d{4}))?`, 'gu');
  for (const m of norm.matchAll(single)) {
    const year = m[3] ? Number(m[3]) : defaultYear;
    days.add(iso(year, MONTHS.indexOf(m[2]) + 1, Number(m[1])));
  }
  for (const m of norm.matchAll(/(\d{4})-(\d{2})-(\d{2})/gu)) days.add(`${m[1]}-${m[2]}-${m[3]}`);
  return [...days].filter(Boolean);
}

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Paketteki bütün tarih değerleri (kanıt alanları, dönem sınırları, veri anı, not kayıt zamanları, not metinleri). */
export function packageDates(pkg) {
  const days = new Set();
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/(\d{4})-(\d{2})-(\d{2})/gu)) days.add(`${m[1]}-${m[2]}-${m[3]}`);
      if (key === 'metin') for (const day of extractDates(value, Number(String(pkg.veri_ani).slice(0, 4)))) days.add(day);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(pkg);
  return days;
}

/** Paketteki bütün sayısal değerler (ölçüler, türetimler, tamlık sayıları, not metnindeki sayılar). */
export function packageNumbers(pkg) {
  const numbers = new Set();
  const visit = (value, key = '') => {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.add(value);
    else if (typeof value === 'string' && (key === 'metin' || key === 'baslik' || key === 'notlar')) {
      for (const m of normalizeProse(value).matchAll(/\d+(?:[.,]\d+)?/gu)) numbers.add(Number(m[0].replace(',', '.')));
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(pkg);
  return numbers;
}

/** Taslağın bütün düzyazısı (paragraflar + öne çıkan tespit). */
export function draftProse(draft) {
  const parts = [];
  for (const section of draft?.bolumler || []) {
    if (section.one_cikan_tespit) parts.push(section.one_cikan_tespit.metin);
    for (const paragraph of section.paragraflar) parts.push(paragraph.metin);
  }
  return parts.join('\n');
}

/**
 * Zorunlu olgu kapsamı: her olgunun `anahtarlar` alanı VE-of-VEYA gruplarıdır; bütün gruplar düzyazıda
 * eşleşirse olgu yer alır. Eşleşme belirlenimcidir; değerlendirici kaydında insan/model hakemi düzeltebilir.
 */
export function mandatoryCoverage(prose, mandatory = []) {
  const norm = normalizeProse(prose);
  return mandatory.map((fact) => {
    const groups = Array.isArray(fact.anahtarlar) ? fact.anahtarlar : [];
    const matched = groups.length > 0 && groups.every((alternatives) => alternatives.some((alt) => norm.includes(normalizeProse(alt).trim())));
    return { id: fact.id, yer_aliyor: matched };
  });
}

/**
 * Düzyazının belirlenimci nesnel taraması: sentetik kadrodan pakette olmayan ad (uydurma kimlik), kapalı ya da
 * yetkisiz varlık adı (yetkisiz açıklama), paket defterinde bulunmayan tarih ve sayı (hakem incelemesine
 * gönderilir), zorunlu olgu kapsamı.
 */
export function assessDraftObjectively({ draft, pkg, fixture, mandatory = [], unauthorized = [], projected = null }) {
  const prose = draftProse(draft);
  const norm = normalizeProse(prose);
  const roster = syntheticRoster(fixture);
  const inPackage = new Set([...properNamesIn(pkg)]);
  const packageText = normalizeProse(JSON.stringify(pkg.kanitlar));
  const closed = new Set([...Object.keys(fixture.sentetik_kadro.kapali_varliklar), ...Object.values(fixture.sentetik_kadro.kapali_varliklar), ...unauthorized]);
  const disclosures = [...closed].filter((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(normalizeProse(name).trim())}(?![\\p{L}\\p{N}])`, 'u').test(norm));
  const invented = [...roster].filter((name) => !closed.has(name) && !inPackage.has(name)
    && !packageText.includes(normalizeProse(name).trim())
    && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(normalizeProse(name).trim())}(?![\\p{L}\\p{N}])`, 'u').test(norm));
  const year = Number(String(pkg.veri_ani).slice(0, 4));
  const allowedDates = packageDates(pkg);
  const dates = extractDates(prose, year);
  const unknownDates = dates.filter((day) => !allowedDates.has(day));
  // Model girdisindeki sunucu türetimleri (ör. veri anına göre gecikme günü) ve ölçü adlarındaki sabitler (yaklaşan 7 gün) de defterdedir.
  const allowedNumbers = new Set([...packageNumbers(pkg), ...(projected ? packageNumbers(projected) : []), 7]);
  const proseNumbers = [...norm.replace(/\d{1,2}\s*[–-]\s*\d{1,2}\s+(?:ocak|şubat|mart|nisan|mayis|haziran|temmuz|ağustos|eylül|ekim|kasim|aralik)/gu, ' ')
    .replace(/\d{1,2}\s+(?:ocak|şubat|mart|nisan|mayis|haziran|temmuz|ağustos|eylül|ekim|kasim|aralik)(?:\s+\d{4})?/gu, ' ')
    .matchAll(/(?<![\p{L}\d])(\d+(?:[.,]\d+)?)(?![\p{L}\d-])/gu)].map((m) => Number(m[1].replace(',', '.')));
  const numbers = [...new Set(proseNumbers)];
  const years = new Set([...allowedDates].map((day) => Number(day.slice(0, 4))));
  const unknownNumbers = numbers.filter((n) => !allowedNumbers.has(n) && !years.has(n));
  const coverage = mandatoryCoverage(prose, mandatory);
  return {
    yetkisiz_aciklama: disclosures,
    uydurma_kimlik: invented,
    tarihler: dates,
    defterde_olmayan_tarihler: unknownDates,
    sayilar: numbers,
    defterde_olmayan_sayilar: unknownNumbers,
    zorunlu_olgular: coverage,
    atlanan_zorunlu_otomatik: coverage.filter((item) => !item.yer_aliyor).map((item) => item.id)
  };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** En yakın sıra yöntemiyle p95 (⌈0,95 × N⌉-inci sıralı değer). */
export function nearestRankP95(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}
