import { isIsoDay } from '../isoDay.js';
import { REPORT_EVIDENCE_SCHEMA, snapshotBusinessDay } from './reportRequest.js';
import { parseStrictEvidenceDay } from './reportSectionPlan.js';
import { projectEvidencePackageForWriter } from './reportWriterPrompt.js';

/**
 * Bilgin Aşama 4I-C — belirlenimci nesnel olgu doğrulaması, Türkçe dilbilimsel normalleştirme,
 * bağlamsal kanıt defteri eşlemesi ve yerel onarım için belirlenimci kanıt seçici (saf).
 *
 * Dil modeli nesnel olguların son otoritesi değildir: sayılar, yüzdeler, oranlar, tarihler,
 * görev durumları, kronoloji ilişkileri, zorunlu olgular, planlı görsel/tablo göndermeleri ve
 * yetkisiz/uydurma varlıklar sunucuya ait yetkili kanıt defterine karşı belirlenimci olarak
 * doğrulanır. Yazarın iddia eki (`iddialar`) doğrulamayı asla daraltmaz.
 */

export const REPORT_CLAIM_CLASSES = Object.freeze({
  OBJECTIVE_FACT: 'nesnel_olgu',
  SUPPORTED_INTERPRETATION: 'desteklenen_yorum',
  EDITORIAL_LANGUAGE: 'editoryal_dil',
  UNSUPPORTED_MATERIAL_CLAIM: 'desteksiz_maddi_iddia'
});

export const REPORT_FINDING_SEVERITIES = Object.freeze({
  CRITICAL: 'kritik',
  MEDIUM: 'orta',
  WARNING: 'uyari'
});

export const REPORT_OBJECTIVE_FINDING_CODES = Object.freeze({
  UNAUTHORIZED_DISCLOSURE: 'yetkisiz_aciklama',
  SECURITY_VIOLATION: 'guvenlik_ihlali',
  FABRICATED_IDENTITY: 'uydurma_kimlik',
  FABRICATED_DATE: 'uydurma_tarih',
  WRONG_OBJECTIVE_VALUE: 'yanlis_nesnel_deger',
  WRONG_ENTITY_ATTRIBUTION: 'yanlis_varlik_atfi',
  WRONG_PERIOD_ATTRIBUTION: 'yanlis_donem_atfi',
  UNSUPPORTED_DERIVATION: 'desteksiz_turetim',
  WRONG_TASK_STATUS: 'yanlis_gorev_durumu',
  CHRONOLOGY_INVERSION: 'kronoloji_tersinmesi',
  UNKNOWN_AS_ZERO: 'bilinmeyen_sifir_hatasi',
  CONTRADICTORY_CLAIM: 'celisen_iddia',
  INVALID_VISUAL_REFERENCE: 'gecersiz_gorsel_gondergesi',
  MISSING_MANDATORY_FACT: 'atlanan_zorunlu_olgu',
  APPENDIX_INCONSISTENCY: 'ek_tutarsizligi',
  INCOMPLETE_EVIDENCE_OVERSTATEMENT: 'eksik_kanit_asiri_kesinlik',
  AMBIGUOUS_OBJECTIVE_STATEMENT: 'belirsiz_nesnel_ifade'
});

export const HARD_GATE_FINDING_CODES = Object.freeze(new Set([
  REPORT_OBJECTIVE_FINDING_CODES.UNAUTHORIZED_DISCLOSURE,
  REPORT_OBJECTIVE_FINDING_CODES.SECURITY_VIOLATION,
  REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_IDENTITY,
  REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_DATE
]));

const TURKISH_UNITS = Object.freeze({
  sifir: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9
});
const TURKISH_TENS = Object.freeze({
  on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50, altmiş: 60, yetmiş: 70, seksen: 80, doksan: 90
});
const TURKISH_SCALES = Object.freeze({ yüz: 100, bin: 1000 });
// Türkçe sayı sözcüklerinin iyelik/hal çekimli son biçimleri ("altısı" → "alti", "beşi" → "beş",
// "on ikisi" → "on iki", "yirmi dördü" → "yirmi dört"); "altın", "bina", "birlik", "yüzde" gibi
// ilgisiz sözcüklerle yanlış eşleşmemesi için yalnızca kapalı çekim biçimleri kabul edilir.
const INFLECTED_NUMBER_STEMS = Object.freeze({
  biri: 'bir', birini: 'bir',
  ikisi: 'iki', ikisini: 'iki',
  üçü: 'üç', üçünü: 'üç',
  dördü: 'dört', dördünü: 'dört',
  beşi: 'beş', beşini: 'beş',
  altisi: 'alti', altisini: 'alti',
  yedisi: 'yedi', yedisini: 'yedi',
  sekizi: 'sekiz', sekizini: 'sekiz',
  dokuzu: 'dokuz', dokuzunu: 'dokuz',
  onu: 'on', onunu: 'on',
  yirmisi: 'yirmi', yirmisini: 'yirmi',
  otuzu: 'otuz',
  kirki: 'kirk',
  ellisi: 'elli',
  altmişi: 'altmiş',
  yetmişi: 'yetmiş',
  sekseni: 'seksen',
  doksani: 'doksan',
  yüzü: 'yüz',
  bini: 'bin'
});
const ALL_NUMBER_WORDS = new Set([
  ...Object.keys(TURKISH_UNITS),
  ...Object.keys(TURKISH_TENS),
  ...Object.keys(TURKISH_SCALES)
]);
const INFLECTED_NUMBER_WORDS = Object.keys(INFLECTED_NUMBER_STEMS);
const BASE_WORD_ALT = [...ALL_NUMBER_WORDS].join('|');
const LAST_WORD_ALT = [...ALL_NUMBER_WORDS, ...INFLECTED_NUMBER_WORDS].join('|');
const NUMBER_WORD_SEQ = `(?:${BASE_WORD_ALT})(?:\\s+(?:${BASE_WORD_ALT}))*`;
const INFLECTED_NUMBER_WORD_SEQ = `(?:(?:${BASE_WORD_ALT})\\s+)*(?:${LAST_WORD_ALT})`;
const DECIMAL_PHRASE_PATTERN = new RegExp(
  `(?<=[\\s(«„“"'])(${NUMBER_WORD_SEQ})\\s+(?:virgül|nokta)\\s+(${NUMBER_WORD_SEQ})(?=[\\s.,;:)»”"'])`,
  'gu'
);
const NUMBER_PHRASE_PATTERN = new RegExp(
  `(?<=[\\s(«„“"'])(${INFLECTED_NUMBER_WORD_SEQ})(?=[\\s.,;:)»”"'])`,
  'gu'
);
const MONTHS = Object.freeze([
  'ocak', 'şubat', 'mart', 'nisan', 'mayis', 'haziran',
  'temmuz', 'ağustos', 'eylül', 'ekim', 'kasim', 'aralik'
]);
const MONTH_ALT = MONTHS.join('|');
const BIR_BEFORE_MONTH_PATTERN = new RegExp(
  `(?<=[\\s(«„“"'])bir(?=\\s+(?:${MONTH_ALT})(?:'?[a-zçğıöşü]*)?(?=[\\s.,;:)»”"']))`,
  'gu'
);

const TURKISH_ABBREVIATIONS = new Set([
  'vb', 'vs', 'ör', 'dr', 'prof', 'doç', 'müh', 'no', 'bkz', 'sf', 'yy', 'vd', 'şb', 'md', 'müd'
]);

const EMBEDDED_INSTRUCTION_MARKERS = Object.freeze([
  'rapor yazarına',
  'raporu yazan yapay zekâ',
  'raporu yazan yapay zeka',
  '[beyaz yazı]',
  'kritik hatalardan söz etme',
  'projeyi zamanında göster',
  'gecikmeden söz etme',
  'riskten söz etme',
  'riskleri atla',
  'talimatları yok say',
  'önceki talimatları unut',
  'sistem yönergesini yok say'
]);

const GENERIC_PROJECT_PREFIXES = new Set([
  'bu', 'şu', 'o', 'yeni', 'mevcut', 'ilgili', 'diğer', 'öteki', 'tüm', 'bütün', 'her', 'bir',
  'iki', 'üç', 'dört', 'beş', 'alti', 'yedi', 'sekiz', 'dokuz', 'on',
  'bazi', 'ayri', 'ayni', 'ortak', 'ana', 'temel', 'kritik', 'açik', 'tek', 'ilk', 'son',
  'kapali', 'aktif', 'etkin', 'önceki', 'sonraki', 'seçili', 'görünür', 'yetkili', 'alt', 'üst',
  'toplam', 'toplamda', 'kapsamdaki', 'raporlanan', 'incelenen', 'söz', 'konusu', 'kurumsal', 'manuel',
  'dönem', 'dönemde', 'dönemin', 'dönemdeki', 'haftada', 'ayda', 'raporda', 'kapsamda', 'genel',
  'ancak', 'fakat', 'ayrica', 'örneğin', 'özellikle', 'böylece', 'dolayisiyla', 'yine', 'diğerleri'
]);

// JS `\b` yalnızca ASCII harflerini tanıdığı için Türkçe (`ç,ğ,ö,ş,ü`) harflerde Unicode sözcük sınırı kullanılır.
const trWord = (expr, flags = 'u') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${expr})(?![\\p{L}\\p{N}])`, flags);

// `normalizeTurkishText` tüm `ı` karakterlerini `i`ye katladığı için aşağıdaki desenler `i` kullanır.
const METRIC_CUE_PATTERNS = Object.freeze([
  { metric: 'tamamlanan', pattern: trWord('tamamlan\\p{L}*|kapan\\p{L}*|sonuçlandir\\p{L}*|bitiril\\p{L}*', 'gu') },
  { metric: 'geciken', pattern: trWord('gecik\\p{L}*|termini\\p{L}*\\s+aş\\p{L}*|hedef\\s+tarih\\p{L}*\\s+geç\\p{L}*', 'gu') },
  { metric: 'yaklasan_7_gun', pattern: trWord('yaklaşan|önümüzdeki\\s+7\\s+gün|izleyen\\s+7\\s+gün|termini\\s+yaklaş\\p{L}*', 'gu') },
  { metric: 'acik', pattern: trWord('açik(?:\\s+(?:kalan|olan|bulunan))?\\s+(?:görev\\p{L}*|iş\\p{L}*|kalem\\p{L}*|konu\\p{L}*|\\d)|açik\\s+kal\\p{L}*|devam\\s+eden\\s+(?:görev\\p{L}*|iş\\p{L}*|kalem\\p{L}*)|süren\\s+(?:görev\\p{L}*|iş\\p{L}*|kalem\\p{L}*)', 'gu') },
  { metric: 'hareket', pattern: trWord('hareket\\p{L}*|kayit\\s+hareket\\p{L}*', 'gu') },
  { metric: 'etkilenen', pattern: trWord('etkilen\\p{L}*|etkiledi\\p{L}*|güncelleme\\p{L}*', 'gu') },
  { metric: 'history.undatedDone', pattern: trWord('tarihsiz|bitiş\\s+tarihi\\s+kayitli\\s+olmayan|bitiş\\s+tarihi\\s+bulunmayan', 'gu') }
]);

const AGGREGATE_CUE_PATTERN = trWord('toplam|toplamda|genel\\s+toplam|tüm\\s+projeler|üç\\s+proje|iki\\s+proje|projelerde\\s+toplam|genelinde');
const COMPARISON_PERIOD_CUE_PATTERN = trWord('önceki\\s+dönem\\p{L}*|karşilaştirma\\s+dönem\\p{L}*|bir\\s+önceki\\s+(?:hafta|ay|dönem)\\p{L}*|geçen\\s+(?:hafta|ay)\\p{L}*\\s+kiyasla');
const REPORT_PERIOD_CUE_PATTERN = trWord('bu\\s+dönem\\p{L}*|rapor\\s+dönem\\p{L}*|raporlama\\s+dönem\\p{L}*|incelenen\\s+dönem\\p{L}*|dönem\\s+boyunca|hafta\\s+boyunca|ay\\s+boyunca');
const NEGATED_COMPLETION_PATTERN = trWord('tamamlanmad\\p{L}*|tamamlanmamiş\\p{L}*|kapanmad\\p{L}*|henüz\\s+(?:tamamlan|başlama|bitme|kapan)\\p{L}*|devam\\s+ediyor|devam\\s+etmekte|açik\\s+kal\\p{L}*|tek\\s+açik\\s+(?:iş|görev)|sürüyor|sürmekte|başlamadi|beklemede|engelli');
const POSITIVE_COMPLETION_PATTERN = trWord('tamamlandi|tamamlanmiştir|tamamlandiği|kapandi|kapanmiştir|sonuçlandirildi|sonuçlandirilmiştir|bitirildi');
const DELAY_CLAIM_PATTERN = trWord('gecikmeyle\\s+tamamlan\\p{L}*|gecikmeli\\s+tamamlan\\p{L}*|gecikme\\s+yaşiyor|gecikme\\s+yaşandi|gün\\s+gecik\\p{L}*');
const NEGATED_DELAY_PATTERN = trWord('gecikme\\s+(?:iddia\\s+edilemez|söylenemez|belirlenemez|hesaplanamaz|yorumlanamaz|kaniti\\s+yok|bulunmuyor|yok)|zamaninda\\s+tamamlanip\\s+tamamlanmadiği\\s+(?:söylenemez|bilinemez|belirlenemez)');
const ZERO_CLAIM_PATTERN = trWord('sifir|0\\s+(?:görev|iş|gecik|hareket)|hiç\\s+(?:gecik\\p{L}*|tamamlan\\p{L}*|açik|hareket)|(?:gecik\\p{L}*|açik|hareket)(?:\\s+(?:görev|iş|kalem|kayit)\\p{L}*)?\\s+(?:yoktur|yok|bulunmamaktadir|bulunmuyor)');
const UNKNOWN_EXPLICIT_PATTERN = trWord('bilinm\\p{L}*|belirleneme\\p{L}*|kayitli\\s+olmad\\p{L}*|kayitli\\s+değil|mevcut\\s+değil|söyleneme\\p{L}*|kismi');
const OVERSTATEMENT_COMPLETE_PATTERN = trWord('tüm\\s+kayitlar\\s+eksiksiz|eksiksiz\\s+kayit\\s+kapsami|hiçbir\\s+eksik\\s+bulunmamaktadir|tam\\s+görünürlükle\\s+tüm\\s+projeler|bütün\\s+hareketler\\s+eksiksiz');
const NEGATIVE_CHANGE_CUE_PATTERN = trWord('azaliş\\p{L}*|azalma\\p{L}*|düşüş\\p{L}*|düşme\\p{L}*|gerileme\\p{L}*|eksilme\\p{L}*|düştü|azaldi|geriledi');
const NON_TASK_NOUN_AFTER_QTY_PATTERN = /^\s*(?:proje\p{L}*|aşama\p{L}*|yön\p{L}*|kural\p{L}*|hata\p{L}*|kritik\s+hata\p{L}*|kilometre\s+taş\p{L}*|sürüm\p{L}*|bölüm\p{L}*|madde\p{L}*|konu\p{L}*|nokta\p{L}*|ekip\p{L}*|birim\p{L}*|kişi\p{L}*|eksen\p{L}*|başli\p{L}*|gelişme\p{L}*|araç\p{L}*|arac\p{L}*|farkli|ayri|tablo\p{L}*|şekil\p{L}*)(?![\p{L}\p{N}])/u;
const SUBSET_CONTEXT_PATTERN = trWord('bu\\s+toplamin|toplamin|bunlarin|bunlardan|bunun|içinde|kismi|tanesi|düşük\\s+öncelik\\p{L}*|yüksek\\s+öncelik\\p{L}*|orta\\s+öncelik\\p{L}*|kritik\\s+öncelik\\p{L}*|yarisi|diğer|üçüncüsü|ikisi|biri|dördü|beşi|altisi');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function maskRange(chars, start, end) {
  for (let i = Math.max(0, start); i < Math.min(chars.length, end); i += 1) {
    chars[i] = ' ';
  }
}

function isValidGregorianDate(y, m, d) {
  if (!Number.isSafeInteger(y) || !Number.isSafeInteger(m) || !Number.isSafeInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function formatDateToken(y, m, d, { includeInvalid = false } = {}) {
  const padded = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (isValidGregorianDate(y, m, d)) return padded;
  return includeInvalid ? `gecersiz:${padded}` : null;
}

/**
 * Birleşik Türkçe sayı öbeklerini ("yirmi dört" → 24, "yüz yirmi" → 120) tek sayı olarak çözer;
 * yaklaşık aralıkları ("bir iki", "iki üç") ve geçersiz basamak tekrarlarını reddeder.
 */
export function parseTurkishNumberPhrase(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  if (tokens.length === 1 && tokens[0] === 'sifir') return 0;
  let total = 0;
  let current = 0;
  let usedThousand = false;
  let hasHundred = false;
  let hasTen = false;
  let hasUnit = false;
  for (const token of tokens) {
    if (Object.hasOwn(TURKISH_UNITS, token)) {
      if (token === 'sifir' || hasUnit) return null;
      current += TURKISH_UNITS[token];
      hasUnit = true;
    } else if (Object.hasOwn(TURKISH_TENS, token)) {
      if (hasTen || hasUnit) return null;
      current += TURKISH_TENS[token];
      hasTen = true;
    } else if (token === 'yüz') {
      if (hasHundred || hasTen || (hasUnit && current === 1)) return null;
      current = (hasUnit ? current : 1) * 100;
      hasHundred = true;
      hasUnit = false;
    } else if (token === 'bin') {
      if (usedThousand || (!hasHundred && !hasTen && hasUnit && current === 1)) return null;
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      usedThousand = true;
      hasHundred = false;
      hasTen = false;
      hasUnit = false;
    } else {
      return null;
    }
  }
  return total + current;
}

function parseTurkishDecimalFraction(tokens) {
  if (tokens.length > 1 && tokens.every((t) => Object.hasOwn(TURKISH_UNITS, t))) {
    return tokens.map((t) => String(TURKISH_UNITS[t])).join('');
  }
  let leadingZeros = 0;
  while (leadingZeros < tokens.length && tokens[leadingZeros] === 'sifir') leadingZeros += 1;
  if (leadingZeros === tokens.length) return '0'.repeat(leadingZeros);
  const rest = parseTurkishNumberPhrase(tokens.slice(leadingZeros));
  if (rest === null) return null;
  return `${'0'.repeat(leadingZeros)}${rest}`;
}

/**
 * Türkçe düzyazıyı NFC normalleştirme, tr-TR küçük harf (ı→i katlama), kesme işareti birleştirme
 * ve Türkçe sayı sözcüklerini tek rakama çevirme ile belirlenimci karşılaştırma biçimine indirger.
 */
export function normalizeTurkishText(text) {
  let out = ` ${String(text ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/gu, 'i')
    .replace(/[’‘ʼ`']/gu, "'")
    .replace(/\s+/gu, ' ')} `;
  out = out.replace(DECIMAL_PHRASE_PATTERN, (match, intPart, fracPart) => {
    const intVal = parseTurkishNumberPhrase(intPart.split(/\s+/u));
    const fracStr = parseTurkishDecimalFraction(fracPart.split(/\s+/u));
    if (intVal === null || fracStr === null) return match;
    return `${intVal},${fracStr}`;
  });
  out = out.replace(NUMBER_PHRASE_PATTERN, (match, _group, offset, fullStr) => {
    const rawTokens = match.split(/\s+/u);
    // Tek başına "bir", "biri" ("biri diğerine...") zamir/belirsiz tanımlıktır; yalnızca bileşik sayı içinde ("on biri") sayıdır.
    if (rawTokens.length === 1 && (rawTokens[0] === 'bir' || rawTokens[0] === 'biri' || rawTokens[0] === 'birini')) return match;
    if (rawTokens.length === 1 && (rawTokens[0] === 'yüz' || rawTokens[0] === 'yüzü')) {
      const beforeSlice = fullStr.slice(Math.max(0, offset - 12), offset);
      const afterSlice = fullStr.slice(offset + match.length);
      if (/\bara\s+$/u.test(beforeSlice) || /^\s+yüze(?=[\s.,;:)'])/u.test(afterSlice)) {
        return match;
      }
    }
    const tokens = rawTokens.map((tok, idx) => (
      idx === rawTokens.length - 1 && Object.hasOwn(INFLECTED_NUMBER_STEMS, tok)
        ? INFLECTED_NUMBER_STEMS[tok]
        : tok
    ));
    const value = parseTurkishNumberPhrase(tokens);
    return value === null ? match : String(value);
  });
  out = out.replace(BIR_BEFORE_MONTH_PATTERN, '1');
  out = out.replace(/(?<=[\s(])yüzde\s+bir(?=[\s.,;:)'])/gu, 'yüzde 1');
  out = out.replace(/(?<=[\s(])eksi\s+bir(?=[\s.,;:)'])/gu, '-1');
  out = out.replace(/(?<=[\s(])eksi\s+(?=\d)/gu, '-');
  return out;
}

/** Türkçe sayı biçimlerini (`1.250`, `1.250,75`, `3,5`, `−12`) güvenli sayıya çevirir. */
export function parseTurkishNumber(raw) {
  const normalized = String(raw ?? '').trim().replace(/^−/u, '-');
  if (!normalized) return null;
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/u.test(normalized)) {
    return Number(normalized.replace(/\./gu, '').replace(',', '.'));
  }
  if (/^-?\d+,\d+$/u.test(normalized)) {
    return Number(normalized.replace(',', '.'));
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Türkçe paragrafı tarih (`04.11.2026`), binlik ayırıcı (`1.250`) ve kısaltmalara (`vb.`, `ör.`)
 * zarar vermeden cümlelere böler. Her cümle 1'den başlayan `index` ve kaynak konumu taşır.
 */
export function splitTurkishSentences(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  const sentences = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const prev = i > 0 ? source[i - 1] : '';
    const next = i + 1 < source.length ? source[i + 1] : '';
    // Sayı içi nokta (`04.11.2026`, `1.250`, `2.4`) cümle sonu değildir.
    if (ch === '.' && /\d/u.test(prev) && /\d/u.test(next)) continue;
    // Sıra sayısı veya madde (`4. madde`, `1. çeyrek`) sonraki küçük harfle devam ediyorsa bölünmez.
    if (ch === '.' && /\d/u.test(prev) && /\s/u.test(next)) {
      const rest = source.slice(i + 1).trimStart();
      if (/^\p{Ll}/u.test(rest)) continue;
    }
    // Kısaltmalar (`vb.`, `ör.`, `Dr.`) cümleyi bölmez.
    if (ch === '.') {
      const wordMatch = /(\p{L}+)$/u.exec(source.slice(start, i));
      if (wordMatch && TURKISH_ABBREVIATIONS.has(wordMatch[1].toLocaleLowerCase('tr-TR'))) continue;
    }
    // Cümle sonu kapanış tırnağı/parantezi varsa cümleye dahil edilir.
    let end = i + 1;
    while (end < source.length && /[»”"')]/u.test(source[end])) end += 1;
    if (end < source.length && !/[\s\r\n]/u.test(source[end])) continue;
    const chunk = source.slice(start, end).trim();
    if (chunk) {
      sentences.push({ index: sentences.length + 1, text: chunk, start, end });
    }
    start = end;
    while (start < source.length && /[\s\r\n]/u.test(source[start])) start += 1;
    i = Math.max(i, start - 1);
  }
  const tail = source.slice(start).trim();
  if (tail) {
    sentences.push({ index: sentences.length + 1, text: tail, start, end: source.length });
  }
  return sentences;
}

/**
 * Düzyazıdaki bütün tarih ifadelerini (ISO, GG.AA.YYYY, GG/AA/YYYY, ay adlı aralık, çoklu gün ve tekil
 * gün) ayrıştırır; tarihleri maskeler ve kronoloji denetimi için metin sırasındaki konumları döndürür.
 */
export function extractTurkishDates(text, defaultYear = 2026, { includeInvalid = true, maskLiterals = [] } = {}) {
  const norm = normalizeTurkishText(text);
  const working = norm.split('');
  // Kanıtta yer alan sayısal/tarih benzeri görev ve proje adları tarih sanılmaması için önce maskelenir.
  for (const literal of maskLiterals) {
    if (!literal || literal.length < 3) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(literal)}(?![\\p{L}\\p{N}])`, 'gu');
    const current = working.join('');
    for (const m of current.matchAll(re)) {
      maskRange(working, m.index, m.index + m[0].length);
    }
  }
  const validDays = new Set();
  const invalidDays = new Set();
  const occurrences = [];
  const addDate = (y, m, d, pos, raw) => {
    const token = formatDateToken(y, m, d, { includeInvalid });
    if (!token) return;
    if (token.startsWith('gecersiz:')) {
      invalidDays.add(token);
      occurrences.push({ day: token, invalid: true, index: pos, raw });
    } else {
      validDays.add(token);
      occurrences.push({ day: token, invalid: false, index: pos, raw });
    }
  };
  const consume = (regex, handler) => {
    const current = working.join('');
    for (const m of current.matchAll(regex)) {
      handler(m);
      maskRange(working, m.index, m.index + m[0].length);
    }
  };
  // 1. ISO tarih (`2026-11-04`)
  consume(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu, (m) => {
    addDate(Number(m[1]), Number(m[2]), Number(m[3]), m.index, m[0]);
  });
  // 2. Sayısal Türkçe tarih (`04.11.2026`, `4/11/2026`)
  consume(/(?<!\d)(\d{1,2})([./])(\d{1,2})\2(\d{4})(?!\d)/gu, (m) => {
    addDate(Number(m[4]), Number(m[3]), Number(m[1]), m.index, m[0]);
  });
  // 3. Farklı aylı gün aralığı (`27 Ekim – 2 Kasım 2026`)
  consume(
    new RegExp(`(?<![\\d.,])(\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4})(?!\\d))?\\s*[–—−-]\\s*(\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4})(?!\\d)(?:'[a-zçğıöşü]+)?|(?:'?[a-zçğıöşü]+)?)(?![a-zçğıöşü])`, 'gu'),
    (m) => {
      const endYear = m[6] ? Number(m[6]) : defaultYear;
      const startYear = m[3] ? Number(m[3]) : endYear;
      addDate(startYear, MONTHS.indexOf(m[2]) + 1, Number(m[1]), m.index, m[0]);
      addDate(endYear, MONTHS.indexOf(m[5]) + 1, Number(m[4]), m.index + m[1].length + 2, m[0]);
    }
  );
  // 4. Aynı aylı gün aralığı (`4–6 Kasım 2026`, `4-6 Kasım`)
  consume(
    new RegExp(`(?<!\\d)(\\d{1,2})\\s*[–—−-]\\s*(\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4})(?!\\d)(?:'[a-zçğıöşü]+)?|(?:'?[a-zçğıöşü]+)?)(?![a-zçğıöşü])`, 'gu'),
    (m) => {
      const year = m[4] ? Number(m[4]) : defaultYear;
      const month = MONTHS.indexOf(m[3]) + 1;
      addDate(year, month, Number(m[1]), m.index, m[0]);
      addDate(year, month, Number(m[2]), m.index + m[1].length + 1, m[0]);
    }
  );
  // 5. Ortak aylı çoklu gün (`4 ve 6 Kasım 2026`, `10 ile 13 Kasım 2026`, `10, 12 ve 14 Kasım`)
  consume(
    new RegExp(`(?<![\\d.,%])(?<!%\\s|yüzde\\s)(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*\\s+(?:ve|ile)\\s+\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4})(?!\\d)(?:'[a-zçğıöşü]+)?|(?:'?[a-zçğıöşü]+)?)(?![a-zçğıöşü])`, 'gu'),
    (m) => {
      const year = m[3] ? Number(m[3]) : defaultYear;
      const month = MONTHS.indexOf(m[2]) + 1;
      for (const dayMatch of m[1].matchAll(/\d{1,2}/gu)) {
        addDate(year, month, Number(dayMatch[0]), m.index + dayMatch.index, m[0]);
      }
    }
  );
  // 6. Tekil ay adlı tarih (`4 Kasım 2026`, `4 Kasım'da`)
  consume(
    new RegExp(`(?<![\\d.,])(\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4})(?!\\d)(?:'[a-zçğıöşü]+)?|(?:'?[a-zçğıöşü]+)?)(?![a-zçğıöşü])`, 'gu'),
    (m) => {
      const year = m[3] ? Number(m[3]) : defaultYear;
      addDate(year, MONTHS.indexOf(m[2]) + 1, Number(m[1]), m.index, m[0]);
    }
  );
  occurrences.sort((a, b) => a.index - b.index);
  return {
    validDays: [...validDays],
    invalidDays: [...invalidDays],
    allDays: [...validDays, ...invalidDays],
    occurrences,
    maskedText: working.join('')
  };
}

/**
 * Düzyazıdan sayı, yüzde, oran ve süre niceliklerini türleriyle birlikte çıkarır.
 * Tarihler, izinli yıllar, planlı şekil/tablo numaraları ve sayısal ad taşıyan yetkili
 * görev/proje başlıkları yanlış pozitif üretmemek için maskelenir.
 */
export function extractTurkishQuantities(text, defaultYear = 2026, {
  allowedYears = null,
  maskHorizonSeven = false,
  maskLiterals = [],
  plannedFigures = [],
  plannedTables = []
} = {}) {
  const { maskedText } = extractTurkishDates(text, defaultYear, { includeInvalid: true, maskLiterals });
  const working = maskedText.split('');
  const quantities = [];
  const numToken = '(?:\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)';
  const trNumSuffix = "(?:'?(?:[aeiioöuü]|[dt][ae]n?|[ny][aeiiuü]|ünde|unda|inda|inde|ini|unu|ünü|ten|tan))?";

  // Planlı Şekil / Tablo göndermelerinin numaraları serbest sayı sayımından maskelenir.
  const plannedFigureSet = new Set(plannedFigures);
  const plannedTableSet = new Set(plannedTables);
  for (const m of working.join('').matchAll(/(?<![\p{L}\d])(şekil|tablo)\s+(\d+)(?:'[a-zçğıöşü]+)?(?![\p{L}\d])/gu)) {
    const num = Number(m[2]);
    if ((m[1] === 'şekil' && plannedFigureSet.has(num)) || (m[1] === 'tablo' && plannedTableSet.has(num))) {
      maskRange(working, m.index, m.index + m[0].length);
    }
  }

  // Zaman bağlamındaki izinli yıllar maskelenir ("2026 yılında", "Kasım 2026", "2026'da").
  if (allowedYears && allowedYears.size > 0) {
    const maskYear = (regex, groupIndex) => {
      const current = working.join('');
      for (const m of current.matchAll(regex)) {
        if (allowedYears.has(Number(m[groupIndex]))) maskRange(working, m.index, m.index + m[0].length);
      }
    };
    maskYear(new RegExp(`(?<!\\d)((?:19|20)\\d{2})\\s+(?:${MONTH_ALT})(?:'?[a-zçğıöşü]*)?`, 'gu'), 1);
    maskYear(new RegExp(`(?<![\\p{L}])(?:${MONTH_ALT})\\s+((?:19|20)\\d{2})(?!\\d|\\s+(?:görev|iş|kayit|adet|belge|olay|kişi)(?![\\p{L}]))`, 'gu'), 1);
    maskYear(/(?<!\d)((?:19|20)\d{2})(?:\s+yil[a-zçğıöşü]*|'?(?:da|de|ta|te|nin|nun|nün|in|un|ün))(?![\p{L}\d])/gu, 1);
  }

  // 7 günlük raporlama ufku ifadesi (`önümüzdeki 7 gün`, `7 gün içinde`, `7 günlük`) yalnızca kanıtta 7 günlük ölçü varken maskelenir.
  if (maskHorizonSeven) {
    for (const m of working.join('').matchAll(/(?<![\p{L}\d])(?:(?:önümüzdeki|gelecek|sonraki|izleyen|yaklaşan|son|veri anindan itibaren)\s+7\s+(?:takvim\s+)?gün(?:lük|de|e|ü|ün)?|7\s+(?:takvim\s+)?gün\s+(?:içinde|içerisinde|sonra)|7\s+(?:takvim\s+)?günlük)(?![\p{L}\d])/gu)) {
      maskRange(working, m.index, m.index + m[0].length);
    }
  }

  // Saat ifadeleri (`saat 15.00'te`, `saat 09:30'da`) ondalık sayı sayımından maskelenir.
  for (const m of working.join('').matchAll(/(?<![\p{L}\d])saat\s+\d{1,2}[.:]\d{2}(?:'[a-zçğıöşü]+)?(?![\p{L}\d])/gu)) {
    maskRange(working, m.index, m.index + m[0].length);
  }

  // 1. Yüzdeler (`%75`, `% 75,5`, `%75'i`, `yüzde 75`, `yüzde -50`)
  const pctPatterns = [
    new RegExp(`%\\s*([-−]?${numToken})${trNumSuffix}(?![\\p{L}\\d])`, 'gu'),
    new RegExp(`(?<![\\p{L}\\d])yüzde\\s+([-−]?${numToken})${trNumSuffix}(?![\\p{L}\\d])`, 'gu')
  ];
  for (const pctRe of pctPatterns) {
    for (const m of working.join('').matchAll(pctRe)) {
      const value = parseTurkishNumber(m[1]);
      if (value !== null) {
        quantities.push({ kind: 'yuzde', value, raw: m[0].trim(), index: m.index });
        maskRange(working, m.index, m.index + m[0].length);
      }
    }
  }

  // 2. Oranlar (`12/20`, `20'de 12`, `4'te 3`)
  for (const m of working.join('').matchAll(/(?<![\p{L}\d])(\d+)\s*\/\s*(\d+)(?![\p{L}\d])/gu)) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      quantities.push({ kind: 'oran', value: num, denominator: den, ratio: num / den, raw: m[0].trim(), index: m.index });
      maskRange(working, m.index, m.index + m[0].length);
    }
  }
  for (const m of working.join('').matchAll(/(?<![\p{L}\d])(\d+)'?(?:de|da|te|ta)\s+(\d+)(?:'[a-zçğıöşü]+)?(?![\p{L}\d])/gu)) {
    const den = Number(m[1]);
    const num = Number(m[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      quantities.push({ kind: 'oran', value: num, denominator: den, ratio: num / den, raw: m[0].trim(), index: m.index });
      maskRange(working, m.index, m.index + m[0].length);
    }
  }

  // 3. Süreler (`5 gün`, `3 takvim günü`, `11 takvim günüyle`, `13 takvim gününe`, `2 hafta`)
  for (const m of working.join('').matchAll(new RegExp(`(?<![\\p{L}\\d])([-−]?${numToken})\\s+(?:takvim\\s+|iş\\s+)?(gün|hafta|ay)(?:lük|luk|lik|de|da|e|a|ü|u|i|ün|un|in|üne|una|ine|ünde|unda|inde|dür|dir|tur|tir|le|la|yle|yla|üyle|uyla|iyla|leri|lari)?(?![\\p{L}\\d])`, 'gu'))) {
    const value = parseTurkishNumber(m[1]);
    if (value !== null) {
      quantities.push({ kind: 'sure', unit: m[2], value, raw: m[0].trim(), index: m.index });
      maskRange(working, m.index, m.index + m[0].length);
    }
  }

  // 4. Sayı aralıkları (`3-4 görev`, `10–15`)
  const rangeRegex = new RegExp(`(?<![\\p{L}\\d])([-−]?${numToken})\\s*[–—−-]\\s*([-−]?${numToken})${trNumSuffix}(?![\\p{L}\\d])`, 'gu');
  for (const m of working.join('').matchAll(rangeRegex)) {
    const a = parseTurkishNumber(m[1]);
    const b = parseTurkishNumber(m[2]);
    if (a !== null) quantities.push({ kind: 'sayi', value: a, raw: m[1], index: m.index });
    if (b !== null) quantities.push({ kind: 'sayi', value: b, raw: m[2], index: m.index + m[1].length + 1 });
    maskRange(working, m.index, m.index + m[0].length);
  }

  // 5. Tekil sayılar (`24`, `1.250`, `1.250,75`, `24'ü`, `-5`)
  const singleRegex = new RegExp(`(?<![\\p{L}\\d])([-−]?${numToken})${trNumSuffix}(?![\\p{L}\\d])`, 'gu');
  for (const m of working.join('').matchAll(singleRegex)) {
    const value = parseTurkishNumber(m[1]);
    if (value !== null) {
      quantities.push({ kind: 'sayi', value, raw: m[0].trim(), index: m.index });
    }
  }

  quantities.sort((a, b) => a.index - b.index);
  return quantities;
}

function approxEqual(a, b, tolerance = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function samePeriod(a, b) {
  return Boolean(a && b && a.baslangic === b.baslangic && a.bitis === b.bitis);
}

/** Verilen proje/ekip/kişi adından kanonik eşleme anahtarı üretir. */
function canonicalEntityKey(raw) {
  return normalizeTurkishText(raw).trim();
}

/** Proje kodundan türetilebilecek kısa ad (ör. `PRJ-KUZEY` → `kuzey`, `PRJ-B` → `b`). */
function projectCodeShortName(code) {
  const m = /^PRJ-([A-ZÇĞİÖŞÜ0-9]+)$/iu.exec(String(code ?? '').trim());
  return m ? canonicalEntityKey(m[1]) : null;
}

/**
 * Yetkili `4i-kanit-1` kanıt paketinden belirlenimci olgu defteri kurar.
 * Kesit sonrası değişmiş görevlerin gizlenen alanları ve sunucu yürütme sınırları deftere alınmaz.
 *
 * @param {object} evidencePackage - Doğrulanmış `4i-kanit-1` kanıt paketi.
 * @param {{ documentPlan?: { sekiller?: number[], tablolar?: number[] }|null }} [options] - Belge görsel planı.
 * @returns {object} Dondurulmuş olgu defteri.
 */
export function buildEvidenceFactLedger(evidencePackage, { documentPlan = null } = {}) {
  if (!isPlainObject(evidencePackage) || evidencePackage.sema !== REPORT_EVIDENCE_SCHEMA || !Array.isArray(evidencePackage.kanitlar)) {
    throw new Error('Geçersiz kanıt paketi: olgu defteri kurulamadı.');
  }
  const projected = projectEvidencePackageForWriter(evidencePackage);
  const rootSnapshotDay = snapshotBusinessDay(evidencePackage.veri_ani) ?? parseStrictEvidenceDay(evidencePackage.veri_ani);
  const defaultYear = Number(String(rootSnapshotDay ?? '2026').slice(0, 4)) || 2026;
  const reportPeriod = isPlainObject(evidencePackage.istek?.donem) ? evidencePackage.istek.donem : null;
  const comparisonPeriod = isPlainObject(evidencePackage.istek?.karsilastirma_donemi) ? evidencePackage.istek.karsilastirma_donemi : null;

  const authorizedDates = new Set();
  const authorizedNumbers = new Set();
  const authorizedPercentages = new Set();
  const authorizedNegativePercentMagnitudes = new Set();
  const allowedYears = new Set([defaultYear]);
  const entityAliases = new Map(); // normalizedMention → Set<canonicalGroupKey>
  const authorizedEntityNames = new Set();
  const authorizedCodes = new Set();
  const literalNamesWithDigits = new Set();
  const metricBindings = [];
  const unknownMetrics = [];
  const tasks = [];
  const evidenceById = new Map();
  const distinctProjects = new Set();

  const inclusiveDaySpan = (startDay, endDay) => {
    if (!isIsoDay(startDay) || !isIsoDay(endDay)) return null;
    const s = Date.parse(`${startDay}T00:00:00Z`);
    const e = Date.parse(`${endDay}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
    return Math.round((e - s) / 86_400_000) + 1;
  };

  const registerEntity = (rawName, groupKey = null) => {
    if (typeof rawName !== 'string' || !rawName.trim()) return null;
    const trimmed = rawName.trim();
    const norm = canonicalEntityKey(trimmed);
    if (!norm) return null;
    const targetGroup = groupKey ?? norm;
    authorizedEntityNames.add(norm);
    if (!entityAliases.has(norm)) entityAliases.set(norm, new Set());
    entityAliases.get(norm).add(targetGroup);
    if (/^(?:PRJ|T)-[A-Z0-9_-]+$/iu.test(trimmed)) {
      authorizedCodes.add(norm);
      const shortName = projectCodeShortName(trimmed);
      if (shortName) {
        authorizedEntityNames.add(shortName);
        if (!entityAliases.has(shortName)) entityAliases.set(shortName, new Set());
        entityAliases.get(shortName).add(targetGroup);
      }
    }
    // "A Projesi" ↔ "a projesi" ve "a" (tek harf hariç anlamlı kök) bağlamları
    const projSuffix = /^(.+?)\s+projesi$/u.exec(norm);
    if (projSuffix && projSuffix[1].length >= 1) {
      if (!entityAliases.has(projSuffix[1])) entityAliases.set(projSuffix[1], new Set());
      entityAliases.get(projSuffix[1]).add(targetGroup);
    }
    if (/\d/u.test(trimmed)) {
      literalNamesWithDigits.add(norm);
    }
    return targetGroup;
  };

  const addDateDay = (day) => {
    if (typeof day === 'string' && isIsoDay(day)) {
      authorizedDates.add(day);
      allowedYears.add(Number(day.slice(0, 4)));
    }
  };

  const registerAuthorizedPercentage = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    authorizedPercentages.add(value);
    if (value < 0) authorizedNegativePercentMagnitudes.add(Math.abs(value));
  };

  const visitRawValues = (value, key = '') => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      authorizedNumbers.add(value);
      if (key === 'oran_yuzde' || key === 'fark_yuzde' || key === 'yuzde_degisim' || key === 'yuzde') {
        registerAuthorizedPercentage(value);
      }
      return;
    }
    if (typeof value === 'string') {
      if (key !== 'metin') {
        const istDay = snapshotBusinessDay(value);
        if (istDay) {
          addDateDay(istDay);
          return;
        }
      }
      for (const m of value.matchAll(/(\d{4})-(\d{2})-(\d{2})/gu)) {
        const day = formatDateToken(Number(m[1]), Number(m[2]), Number(m[3]), { includeInvalid: false });
        if (day) addDateDay(day);
      }
      if (key === 'metin' || key === 'baslik' || key === 'notlar') {
        const dateInfo = extractTurkishDates(value, defaultYear, { includeInvalid: false });
        for (const day of dateInfo.validDays) addDateDay(day);
        const qtyList = extractTurkishQuantities(value, defaultYear);
        for (const q of qtyList) {
          authorizedNumbers.add(q.value);
          if (q.kind === 'yuzde') registerAuthorizedPercentage(q.value);
          if (q.kind === 'oran') {
            authorizedNumbers.add(q.denominator);
            registerAuthorizedPercentage(Math.round((q.value / q.denominator) * 1000) / 10);
          }
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visitRawValues(item, key);
    } else if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) visitRawValues(v, k);
    }
  };

  visitRawValues(projected.header);
  visitRawValues(projected.celiskiler);
  visitRawValues(projected.turetilmis);
  visitRawValues(projected.kanitlar);

  // Kapsam kimliklerini kaydet
  const scopeIds = Array.isArray(evidencePackage.istek?.kapsam?.kimlikler)
    ? evidencePackage.istek.kapsam.kimlikler
    : [];
  for (const scopeId of scopeIds) {
    registerEntity(scopeId);
  }
  if (scopeIds.length >= 2) authorizedNumbers.add(scopeIds.length);
  if (reportPeriod) {
    addDateDay(reportPeriod.baslangic);
    addDateDay(reportPeriod.bitis);
    if (Number.isFinite(reportPeriod.gun_sayisi)) authorizedNumbers.add(reportPeriod.gun_sayisi);
    const span = inclusiveDaySpan(reportPeriod.baslangic, reportPeriod.bitis);
    if (span !== null) authorizedNumbers.add(span);
  }
  if (comparisonPeriod) {
    addDateDay(comparisonPeriod.baslangic);
    addDateDay(comparisonPeriod.bitis);
    if (Number.isFinite(comparisonPeriod.gun_sayisi)) authorizedNumbers.add(comparisonPeriod.gun_sayisi);
    const span = inclusiveDaySpan(comparisonPeriod.baslangic, comparisonPeriod.bitis);
    if (span !== null) authorizedNumbers.add(span);
  }
  if (rootSnapshotDay) addDateDay(rootSnapshotDay);

  // Kanıt kayıtlarını bağlamsal olarak indeksle
  let hasSevenDayHorizon = false;
  let hasInjectionNotes = false;
  for (const item of projected.kanitlar) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue;
    evidenceById.set(item.id, item);

    // Proje kodu + proje adı birlikteyse tek ortak varlık grubuna bağla (`PRJ-KUZEY` ↔ `Kuzey`)
    let projectGroup = null;
    if (typeof item.proje === 'string') projectGroup = registerEntity(item.proje);
    if (typeof item.proje_kodu === 'string') projectGroup = registerEntity(item.proje_kodu, projectGroup);
    if (typeof item.proje_adi === 'string') projectGroup = registerEntity(item.proje_adi, projectGroup);
    if (projectGroup) distinctProjects.add(projectGroup);
    if (typeof item.tamamlandigi_proje === 'string') registerEntity(item.tamamlandigi_proje);

    for (const field of ['sorumlu', 'ekip', 'birim', 'mudurluk', 'direktorluk', 'kaynak_belge']) {
      if (typeof item[field] === 'string') registerEntity(item[field]);
    }
    if (Array.isArray(item.kapsam)) {
      for (const k of item.kapsam) registerEntity(k);
    }

    if (item.tur === 'not' || item.tur === 'belge') {
      if (item.guvenilmez_yonerge_iceriyor === true) hasInjectionNotes = true;
      if (typeof item.metin === 'string') {
        const lowerNote = item.metin.toLocaleLowerCase('tr-TR');
        if (EMBEDDED_INSTRUCTION_MARKERS.some((marker) => lowerNote.includes(marker))) {
          hasInjectionNotes = true;
        }
      }
    }

    if (item.tur === 'gorev') {
      if (typeof item.baslik === 'string' && item.baslik.trim()) {
        const titleNorm = canonicalEntityKey(item.baslik);
        if (titleNorm) {
          authorizedEntityNames.add(titleNorm);
          if (/\d/u.test(item.baslik)) literalNamesWithDigits.add(titleNorm);
        }
      }
      const rawTask = evidencePackage.kanitlar.find((k) => k?.id === item.id);
      if (typeof rawTask?.gorev === 'string' && /^T-[A-Z0-9_-]+$/iu.test(rawTask.gorev)) {
        authorizedCodes.add(canonicalEntityKey(rawTask.gorev));
      }
      tasks.push(Object.freeze({
        id: item.id,
        baslik: typeof item.baslik === 'string' ? item.baslik : null,
        baslikNorm: typeof item.baslik === 'string' ? canonicalEntityKey(item.baslik) : null,
        projectGroup,
        proje: item.proje ?? null,
        proje_adi: item.proje_adi ?? null,
        durum: item.durum ?? null,
        donemde_tamamlandi: item.donemde_tamamlandi === true,
        hedef_bitis: parseStrictEvidenceDay(item.hedef_bitis),
        gerceklesen_bitis: parseStrictEvidenceDay(item.gerceklesen_bitis),
        kesit_sonrasi_degisti: item.kesit_sonrasi_degisti === true,
        gecikme_gunu: Number.isFinite(item.veri_anina_gore_gecikme_takvim_gunu) ? item.veri_anina_gore_gecikme_takvim_gunu : null,
        sorumlu: item.sorumlu ?? null
      }));
    }

    if (item.tur === 'olcu' && typeof item.olcu === 'string') {
      if (item.olcu === 'yaklasan_7_gun') hasSevenDayHorizon = true;
      const entities = new Set();
      const rawEntities = [];
      if (Array.isArray(item.kapsam)) {
        for (const k of item.kapsam) {
          const g = registerEntity(k);
          if (g) { entities.add(g); rawEntities.push(k); }
        }
      }
      for (const f of ['proje', 'proje_adi', 'sorumlu', 'ekip', 'birim', 'mudurluk', 'direktorluk']) {
        if (typeof item[f] === 'string') {
          const g = registerEntity(item[f], f === 'proje_adi' ? projectGroup : null);
          if (g) { entities.add(g); rawEntities.push(item[f]); }
        }
      }
      let periodKind = 'anlik';
      if (isPlainObject(item.donem)) {
        if (comparisonPeriod && samePeriod(item.donem, comparisonPeriod)) periodKind = 'karsilastirma';
        else periodKind = 'rapor';
      }
      const isAggregate = entities.size > 1 || entities.size === 0;
      if (item.deger === null || item.kayit_kapsami === 'unknown') {
        unknownMetrics.push(Object.freeze({
          evidenceId: item.id,
          metric: item.olcu,
          entities,
          periodKind
        }));
      } else if (typeof item.deger === 'number' && Number.isFinite(item.deger)) {
        metricBindings.push(Object.freeze({
          evidenceId: item.id,
          metric: item.olcu,
          value: item.deger,
          isPercentage: false,
          entities,
          rawEntities,
          isAggregate,
          periodKind,
          period: item.donem ?? null,
          coverage: item.tamlik ?? item.kayit_kapsami ?? 'complete'
        }));
      }
    }

    if (item.tur === 'hareket' && isPlainObject(item.donem_ozeti)) {
      let periodKind = 'rapor';
      if (isPlainObject(item.donem) && comparisonPeriod && samePeriod(item.donem, comparisonPeriod)) {
        periodKind = 'karsilastirma';
      }
      const entities = new Set();
      for (const f of ['proje', 'proje_adi', 'sorumlu', 'ekip', 'birim', 'mudurluk', 'direktorluk']) {
        if (typeof item[f] === 'string') {
          const g = registerEntity(item[f]);
          if (g) entities.add(g);
        }
      }
      if (Number.isFinite(item.donem_ozeti.toplam_hareket)) {
        metricBindings.push(Object.freeze({
          evidenceId: item.id,
          metric: 'hareket',
          value: item.donem_ozeti.toplam_hareket,
          isPercentage: false,
          entities,
          rawEntities: [],
          isAggregate: entities.size !== 1,
          periodKind,
          period: item.donem ?? null,
          coverage: item.kayit_kapsami ?? 'complete'
        }));
      }
      if (Number.isFinite(item.donem_ozeti.tamamlanan_gorev)) {
        metricBindings.push(Object.freeze({
          evidenceId: item.id,
          metric: 'tamamlanan',
          value: item.donem_ozeti.tamamlanan_gorev,
          isPercentage: false,
          entities,
          rawEntities: [],
          isAggregate: entities.size !== 1,
          periodKind,
          period: item.donem ?? null,
          coverage: item.kayit_kapsami ?? 'complete'
        }));
      }
    }
  }

  // Sunucu türetimlerini (`turetilmis`: F#) indeksle
  for (const derived of projected.turetilmis) {
    if (!isPlainObject(derived) || typeof derived.id !== 'string') continue;
    evidenceById.set(derived.id, derived);
    const val = derived.deger;
    if (isPlainObject(val)) {
      if (val.oran_yuzde === null || val.fark_yuzde === null || val.yuzde_degisim === null) {
        unknownMetrics.push(Object.freeze({
          evidenceId: derived.id,
          metric: derived.tur ?? 'turetilmis',
          entities: new Set(),
          periodKind: derived.tur === 'karsilastirma' ? 'karsilastirma' : 'anlik',
          isPercentage: true
        }));
      }
      if (Number.isFinite(val.oran_yuzde)) {
        registerAuthorizedPercentage(val.oran_yuzde);
        metricBindings.push(Object.freeze({
          evidenceId: derived.id,
          metric: derived.tur ?? 'oran_yuzde',
          value: val.oran_yuzde,
          isPercentage: true,
          entities: new Set(),
          rawEntities: [],
          isAggregate: true,
          periodKind: 'anlik',
          period: null,
          coverage: 'complete'
        }));
      }
      const changePct = Number.isFinite(val.fark_yuzde)
        ? val.fark_yuzde
        : (Number.isFinite(val.yuzde_degisim) ? val.yuzde_degisim : null);
      if (changePct !== null) {
        registerAuthorizedPercentage(changePct);
        metricBindings.push(Object.freeze({
          evidenceId: derived.id,
          metric: 'karsilastirma',
          value: changePct,
          isPercentage: true,
          entities: new Set(),
          rawEntities: [],
          isAggregate: true,
          periodKind: 'karsilastirma',
          period: null,
          coverage: 'complete'
        }));
      }
    } else if (typeof val === 'number' && Number.isFinite(val)) {
      if (derived.tur === 'gecikme_payi' || derived.tur === 'tamamlanma_orani') {
        registerAuthorizedPercentage(val);
      }
    }
  }

  // Yetkili kanıt paketindeki tekil proje, tüm görev ve dönem-etkin görev kalem sayıları yapısal sayı olarak deftere eklenir.
  if (distinctProjects.size >= 2) authorizedNumbers.add(distinctProjects.size);
  if (tasks.length >= 2) authorizedNumbers.add(tasks.length);
  const periodActiveTasks = tasks.filter((t) => t.donemde_tamamlandi || (t.durum && t.durum !== 'tamamlandi')).length;
  if (periodActiveTasks >= 2) authorizedNumbers.add(periodActiveTasks);
  const completedTasksInPackage = tasks.filter((t) => t.durum === 'tamamlandi').length;
  if (completedTasksInPackage >= 2) authorizedNumbers.add(completedTasksInPackage);

  // Aynı proje kodu için hem `proje` hem `proje_adi` başka kanıtlardan gelmişse eşanlamlı gruplarını birleştir.
  // (Örn: E2'de `proje: "PRJ-UFUK"`, E3'te `proje: "PRJ-UFUK", proje_adi: "Ufuk"`)
  const codeToGroup = new Map();
  for (const item of projected.kanitlar) {
    if (!isPlainObject(item)) continue;
    if (typeof item.proje === 'string' && typeof item.proje_adi === 'string') {
      const codeKey = canonicalEntityKey(item.proje);
      const nameKey = canonicalEntityKey(item.proje_adi);
      const groups = entityAliases.get(codeKey) ?? new Set([codeKey]);
      codeToGroup.set(codeKey, groups);
      if (!entityAliases.has(nameKey)) entityAliases.set(nameKey, new Set());
      for (const g of groups) entityAliases.get(nameKey).add(g);
    }
  }

  const tamlik = isPlainObject(evidencePackage.tamlik) ? evidencePackage.tamlik : {};
  const plannedFigures = Array.isArray(documentPlan?.sekiller) ? documentPlan.sekiller.filter(Number.isSafeInteger) : [];
  const plannedTables = Array.isArray(documentPlan?.tablolar) ? documentPlan.tablolar.filter(Number.isSafeInteger) : [];

  return Object.freeze({
    projected,
    snapshotDay: rootSnapshotDay,
    defaultYear,
    allowedYears,
    reportPeriod,
    comparisonPeriod,
    authorizedDates,
    authorizedNumbers,
    authorizedPercentages,
    authorizedNegativePercentMagnitudes,
    entityAliases,
    authorizedEntityNames,
    authorizedCodes,
    literalNamesWithDigits: [...literalNamesWithDigits].sort((a, b) => b.length - a.length),
    metricBindings,
    unknownMetrics,
    tasks,
    evidenceById,
    hasSevenDayHorizon,
    hasInjectionNotes,
    hasUndatedDone: (Number.isSafeInteger(tamlik.tarihsiz_tamamlanan) && tamlik.tarihsiz_tamamlanan > 0)
      || tasks.some((t) => t.durum === 'tamamlandi' && t.gerceklesen_bitis === null),
    hasPartialCoverage: tamlik.kapsam_gorunurlugu === 'partial'
      || tamlik.hareket === 'partial'
      || tamlik.bagimliliklar === 'partial'
      || tamlik.paket_kesildi === true,
    plannedFigures,
    plannedTables
  });
}

/** Verilen metinde geçen yetkili varlık gruplarını konumlarıyla bulur. */
function findMentionedEntityGroups(normClause, ledger) {
  const matched = new Map(); // groupKey → { alias, index }
  // Daha uzun eşanlamlılar önce eşleştirilir ("A Projesi" > "a")
  const aliases = [...ledger.entityAliases.keys()].sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    // Tek harfli yalın belirteçler ("a", "b") yalnızca açık "X projesi" bağlamında eşleştirilir;
    // aksi halde tek harfli ek/bağlaçlarla yanlış eşleşir.
    if (alias.length === 1) continue;
    const isCode = /^[a-z0-9]+-[a-z0-9-]+$/iu.test(alias);
    const re = isCode
      ? new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegex(alias)}(?![\\p{L}\\p{N}-])`, 'gu')
      : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(alias)}(?:'?[\\p{L}]{1,8})?(?![\\p{L}\\p{N}])`, 'gu');
    const m = re.exec(normClause);
    if (m) {
      for (const group of ledger.entityAliases.get(alias)) {
        if (!matched.has(group)) matched.set(group, { alias, index: m.index });
      }
    }
  }
  return matched;
}

/** Metindeki tüm ölçü ipuçlarını konumlarıyla birlikte (durumsuz) bulur. */
function findMetricCueMatches(normText) {
  const hits = [];
  for (const { metric, pattern } of METRIC_CUE_PATTERNS) {
    for (const m of normText.matchAll(pattern)) {
      hits.push({ metric, index: m.index, end: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** Metinde geçen ilk ölçü anlamını (tamamlanan, açık, geciken, yaklaşan, hareket vb.) saptar. */
function detectMetricCue(normText) {
  const hits = findMetricCueMatches(normText).filter((h) => h.metric !== 'etkilenen');
  return hits.length > 0 ? hits[0].metric : null;
}

/**
 * Bir tümce içindeki belirli bir sayısal niceliği yalnızca kendisine yerel ve anlamca bağlı ölçü
 * ipucuna eşler; proje/aşama/kural/sürüm/alt-küme sayılarını ilgisiz ölçülere bağlamaz.
 */
function detectLocalMetricCue(cNorm, qty, allQuantitiesInClause, segmentMetricFallback) {
  const qtyStart = qty.index;
  const qtyEnd = qty.index + qty.raw.length;
  const beforeText = cNorm.slice(Math.max(0, qtyStart - 28), qtyStart);
  const afterText = cNorm.slice(qtyEnd, qtyEnd + 44);

  // Proje, aşama, yön, kural, hata, kilometre taşı veya sürüm numarası sayıları görev durum ölçüsü değildir.
  if (NON_TASK_NOUN_AFTER_QTY_PATTERN.test(afterText) || /(?<![\p{L}\p{N}])sürüm\s+$/u.test(beforeText)) {
    return null;
  }
  // Bir toplamın alt kümesi ("dört işin üçü", "üç düşük öncelikli iş", "diğer ikisi", "bunların ikisi") ana ölçüyle çelişmez.
  if (
    /(?<![\p{L}\p{N}])(?:işin|görevin|hareketin|kalemin|bunlarin|bunlardan|toplamin|diğer)\s*$/u.test(beforeText)
    || /^\s*(?:tanesi|kismi|yarisi|düşük\s+öncelik\p{L}*|yüksek\s+öncelik\p{L}*|orta\s+öncelik\p{L}*|kritik\s+öncelik\p{L}*)(?![\p{L}\p{N}])/u.test(afterText)
  ) {
    return null;
  }

  const hits = findMetricCueMatches(cNorm);
  const localCandidates = [];
  for (const hit of hits) {
    const separatedByOtherQty = allQuantitiesInClause.some((other) => {
      if (other === qty) return false;
      const oMid = other.index + other.raw.length / 2;
      return (hit.index > qtyEnd && oMid > qtyEnd && oMid < hit.index)
        || (hit.index < qtyStart && oMid > hit.index && oMid < qtyStart);
    });
    if (separatedByOtherQty) continue;
    const dist = hit.index >= qtyEnd
      ? hit.index - qtyEnd
      : (qtyStart >= hit.index ? qtyStart - hit.index : 0);
    if (dist <= 40) {
      localCandidates.push({
        metric: hit.metric,
        dist,
        afterQty: hit.index >= qtyStart
      });
    }
  }

  if (localCandidates.length > 0) {
    localCandidates.sort((a, b) => (a.dist - b.dist) || (Number(b.afterQty) - Number(a.afterQty)));
    const winner = localCandidates[0].metric;
    if (winner === 'etkilenen') return null;
    if (winner === 'hareket' && /^\s*(?:görev\p{L}*|iş\p{L}*|kalem\p{L}*)(?![\p{L}\p{N}])/u.test(afterText)) {
      return null;
    }
    return winner;
  }

  if (allQuantitiesInClause.length === 1 && !SUBSET_CONTEXT_PATTERN.test(cNorm) && !/(?<![\p{L}\p{N}])bu\s+$/u.test(beforeText)) {
    return segmentMetricFallback;
  }
  return null;
}

/** Metinde geçen dönem bağlamını (`karsilastirma` | `rapor` | null) saptar. */
function detectPeriodCue(normText, datesInText, ledger) {
  const hasCompWords = COMPARISON_PERIOD_CUE_PATTERN.test(normText);
  const hasRepWords = REPORT_PERIOD_CUE_PATTERN.test(normText);
  if (hasCompWords && !hasRepWords) return 'karsilastirma';
  if (hasRepWords && !hasCompWords) return 'rapor';
  if (ledger.comparisonPeriod && datesInText.length > 0) {
    const inComp = datesInText.some((d) => d >= ledger.comparisonPeriod.baslangic && d <= ledger.comparisonPeriod.bitis);
    const inRep = ledger.reportPeriod
      ? datesInText.some((d) => d >= ledger.reportPeriod.baslangic && d <= ledger.reportPeriod.bitis)
      : false;
    if (inComp && !inRep) return 'karsilastirma';
    if (inRep && !inComp) return 'rapor';
  }
  return null;
}

/** Yetkisiz veya kadro dışı bir varlık adının düzyazıda geçip geçmediğini sınar. */
function matchesEntityName(rawProse, normText, rawName, { strictSingleWord = false } = {}) {
  const trimmed = String(rawName ?? '').trim();
  const needle = canonicalEntityKey(trimmed);
  if (!needle) return false;
  if (/^[a-z0-9]+-[a-z0-9-]+$/iu.test(needle)) {
    return new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegex(needle)}(?![\\p{L}\\p{N}-])`, 'u').test(normText);
  }
  if (needle.includes(' ') || trimmed.includes('_')) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?:'?[\\p{L}]{1,8})?(?![\\p{L}\\p{N}])`, 'u').test(normText);
  }
  const normalizedProse = String(rawProse).normalize('NFC').replace(/[’‘ʼ`']/gu, "'");
  const normalizedName = trimmed.normalize('NFC');
  const upperName = normalizedName.toLocaleUpperCase('tr-TR');
  const variants = upperName !== normalizedName
    ? `(?:${escapeRegex(normalizedName)}|${escapeRegex(upperName)})`
    : escapeRegex(normalizedName);
  if (new RegExp(`(?<![\\p{L}\\p{N}])${variants}(?:'[\\p{L}]{1,8})?(?![\\p{L}\\p{N}])`, 'u').test(normalizedProse)) {
    return true;
  }
  if (strictSingleWord) return false;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?:'[\\p{L}]{1,8})?\\s+(?:proje[\\p{L}]*|ekib[\\p{L}]*|ekip[\\p{L}]*|birim[\\p{L}]*|müdürlü[\\p{L}]*|kapsam[\\p{L}]*)(?![\\p{L}\\p{N}])`,
    'u'
  ).test(normText);
}

/**
 * Aynı cümledeki sıralı zaman bağlaçlarında (`ardından`, `sonrasında`, `peşinden`, `takiben` ve
 * `öncesinde`) tarih tersinmesini saptar.
 */
function detectSentenceChronologyInversions(sentenceText, defaultYear, maskLiterals) {
  const inversions = [];
  const lower = sentenceText.normalize('NFC').toLocaleLowerCase('tr-TR');
  const connectorRe = /\b(?:bunun\s+ardından|ardından|sonrasında|peşinden|takiben|öncesinde)\b/gu;
  const connectors = [...lower.matchAll(connectorRe)];
  if (!connectors.length) return inversions;
  const spans = [];
  let cursor = 0;
  for (const m of connectors) {
    spans.push(lower.slice(cursor, m.index));
    cursor = m.index + m[0].length;
  }
  spans.push(lower.slice(cursor));
  const spanDates = spans.map((s) => extractTurkishDates(s, defaultYear, { includeInvalid: false, maskLiterals }).occurrences);
  for (let i = 0; i < connectors.length; i += 1) {
    const before = spanDates[i];
    const after = spanDates[i + 1];
    if (!before.length || !after.length) continue;
    const conn = connectors[i][0];
    const first = before[before.length - 1].day;
    const second = after[0].day;
    if (conn === 'öncesinde') {
      // "X öncesinde Y": Y'nin tarihi X'ten sonra olamaz ("4 Kasım öncesinde 6 Kasım'da ...").
      if (second > first) {
        inversions.push({ onceki_tarih: first, sonraki_tarih: second, baglac: conn });
      }
    } else if (first > second) {
      // "X ardından/sonrasında Y": X'in tarihi Y'den sonra olamaz ("6 Kasım'ın ardından 4 Kasım'da ...").
      inversions.push({ onceki_tarih: first, sonraki_tarih: second, baglac: conn });
    }
  }
  return inversions;
}

/** Cümleyi virgül, noktalı virgül, iki nokta ve karşıtlık bağlaçlarından alt tümcelere böler. */
function splitClauses(sentenceText) {
  return String(sentenceText)
    .split(/(?:;|:\s+|,(?!\d)|\s+(?:ancak|fakat|oysa|buna\s+karşılık|öte\s+yandan)\s+)/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Zorunlu olguların (VE-of-VEYA anahtar grupları) düzyazıda karşılanıp karşılanmadığını denetler. */
function evaluateMandatoryFacts(draft, mandatoryFacts, defaultYear, maskLiterals) {
  if (!Array.isArray(mandatoryFacts) || !mandatoryFacts.length) return [];
  const analyze = (text) => ({
    norm: normalizeTurkishText(text),
    dates: new Set(extractTurkishDates(text, defaultYear, { includeInvalid: false, maskLiterals }).validDays),
    numbers: new Set(extractTurkishQuantities(text, defaultYear, { maskLiterals }).map((q) => q.value))
  });
  const allParts = [];
  const bySection = new Map();
  for (const section of draft?.bolumler || []) {
    const parts = [];
    if (section.one_cikan_tespit?.metin) parts.push(section.one_cikan_tespit.metin);
    for (const p of section.paragraflar || []) parts.push(p.metin);
    const joined = parts.join('\n');
    bySection.set(section.kimlik, joined);
    allParts.push(joined);
  }
  const full = analyze(allParts.join('\n'));
  const cache = new Map();
  const targetOf = (sectionId) => {
    if (!sectionId) return full;
    if (!cache.has(sectionId)) cache.set(sectionId, analyze(bySection.get(sectionId) ?? ''));
    return cache.get(sectionId);
  };

  return mandatoryFacts.map((fact) => {
    const target = targetOf(fact.bolum);
    const groups = Array.isArray(fact.anahtarlar) ? fact.anahtarlar : [];
    const matched = groups.length > 0 && groups.every((alternatives) => alternatives.some((alt) => {
      const altDates = extractTurkishDates(alt, defaultYear, { includeInvalid: false });
      if (altDates.validDays.length > 0 && !altDates.maskedText.trim()) {
        return altDates.validDays.every((day) => target.dates.has(day));
      }
      const needle = normalizeTurkishText(alt).trim();
      if (/^[-−]?\d+(?:[.,]\d+)*$/u.test(needle)) {
        const parsed = parseTurkishNumber(needle);
        return parsed !== null && [...target.numbers].some((n) => approxEqual(n, parsed));
      }
      if (!/\d/u.test(needle)) return needle.length > 0 && target.norm.includes(needle);
      const bounded = needle.split(/([-−]?\d+(?:[.,]\d+)*)/u).map((part, idx) => {
        const esc = escapeRegex(part);
        return idx % 2 === 0 ? esc : `(?<![\\d−-])(?<!\\d[.,])${esc}(?!\\d|[.,]\\d)`;
      }).join('');
      return new RegExp(bounded, 'u').test(target.norm);
    }));
    return Object.freeze({
      id: fact.id,
      bolum: fact.bolum ?? null,
      yer_aliyor: matched
    });
  });
}

/** Plandaki kaldırılamaz bütünlük açıklamalarının (`zorunlu_aciklamalar`) ilgili bölümde anıldığını denetler. */
const DISCLOSURE_PATTERNS = Object.freeze({
  kismi_gorunurluk: trWord('kismi|görünür\\s+görev|yetkili\\s+görünür|sinirli\\s+görünürlük|rapora\\s+açik'),
  kismi_hareket_kaydi: trWord('kismi|tüm\\s+etkinliği\\s+göstermez|eksik\\s+hareket|hareket\\s+kaydi\\p{L}*\\s+kismi'),
  kismi_bagimlilik_kapsami: trWord('bağimlilik\\p{L}*\\s+kismi|kismi\\s+bağimlilik|görünmeyen\\s+bağimlilik|bağimlilik\\p{L}*(?:\\s+\\p{L}+){0,3}\\s+kismi'),
  tarihsiz_tamamlanan: trWord('tarih\\p{L}*(?:\\s+\\p{L}+){0,3}\\s+(?:kayitli\\s+(?:olmad\\p{L}*|olmama\\p{L}*|değil)|bulunm\\p{L}*|olmayan|olmama\\p{L}*)|tarihsiz\\s+tamamlan\\p{L}*'),
  paket_kesildi: trWord('sinir\\p{L}*\\s+nedeniyle|seçilmiş\\s+kayit|tüm\\s+kayitlari\\s+içerme\\p{L}*|kismi\\s+kapsam|kesil\\p{L}*'),
  karsilastirma_kurulamadi: trWord('karşilaştirma\\s+(?:kurulamadi|yapilamadi|mümkün\\s+değil|sağlanamadi)|karşilaştirilabilir\\s+(?:veri|kayit)\\s+(?:yok|bulunmuyor)'),
  degisiklik_yok: trWord('(?:değişiklik|hareket\\p{L}*)\\s+(?:bulunmuyor|yok|kayda\\s+geçmedi|görünmüyor|gözlenmedi|tespit\\s+edilmedi)')
});

function evaluatePlanDisclosures(draft, plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.bolumler)) return [];
  const results = [];
  const sectionsById = new Map((draft?.bolumler || []).map((s) => [s.kimlik, s]));
  for (const planSection of plan.bolumler) {
    const disclosures = Array.isArray(planSection.zorunlu_aciklamalar) ? planSection.zorunlu_aciklamalar : [];
    const draftSection = sectionsById.get(planSection.kimlik);
    const text = draftSection
      ? [draftSection.one_cikan_tespit?.metin ?? '', ...(draftSection.paragraflar || []).map((p) => p.metin)].join('\n')
      : '';
    const norm = normalizeTurkishText(text);
    for (const disclosure of disclosures) {
      const pattern = DISCLOSURE_PATTERNS[disclosure.kimlik];
      if (!pattern) continue;
      results.push(Object.freeze({
        kimlik: disclosure.kimlik,
        bolum: planSection.kimlik,
        yer_aliyor: pattern.test(norm)
      }));
    }
  }
  return results;
}

/**
 * Bir yönetici raporu taslağındaki bütün nesnel olguları yetkili kanıt defterine karşı belirlenimci olarak doğrular.
 *
 * @param {object} input - Doğrulama girdileri.
 * @param {object} input.draft - Ayrıştırılmış `4i-yazim-1` taslağı.
 * @param {object} input.evidencePackage - Yetkili `4i-kanit-1` kanıt paketi.
 * @param {object|null} [input.plan] - Bölüm planı (zorunlu açıklamalar için).
 * @param {object[]} [input.mandatoryFacts] - Sürümlü zorunlu olgu listesi.
 * @param {string[]} [input.unauthorizedEntities] - Kapalı/yetkisiz varlık adları.
 * @param {string[]} [input.knownExternalEntities] - Paket dışı bilinen varlık adları (kadro vb.).
 * @param {{ sekiller?: number[], tablolar?: number[] }|null} [input.documentPlan] - Planlı şekil/tablo numaraları.
 * @param {object|null} [input.ledger] - Önceden kurulmuş olgu defteri.
 * @returns {object} Doğrulama sonucu ve konumlu bulgular.
 */
export function verifyReportObjectiveFacts({
  draft,
  evidencePackage,
  plan = null,
  mandatoryFacts = [],
  unauthorizedEntities = [],
  knownExternalEntities = [],
  documentPlan = null,
  ledger: prebuiltLedger = null
}) {
  const ledger = prebuiltLedger ?? buildEvidenceFactLedger(evidencePackage, { documentPlan });
  const findings = [];
  let seq = 0;
  const addFinding = ({
    kod,
    siddet = REPORT_FINDING_SEVERITIES.CRITICAL,
    bolum,
    paragraf = null,
    cumle = null,
    alinti = '',
    mesaj,
    kanitlar = [],
    onerilen_deger = null
  }) => {
    seq += 1;
    const redactedQuote = kod === REPORT_OBJECTIVE_FINDING_CODES.UNAUTHORIZED_DISCLOSURE
      ? ''
      : String(alinti ?? '').slice(0, 400);
    findings.push(Object.freeze({
      id: `N${seq}`,
      kod,
      siddet,
      kesin_kapi: HARD_GATE_FINDING_CODES.has(kod),
      kaynak: 'belirlenimci',
      bolum,
      paragraf,
      cumle,
      alinti: redactedQuote,
      mesaj,
      kanitlar: Object.freeze([...new Set(kanitlar.filter((id) => ledger.evidenceById.has(id)))]),
      ...(onerilen_deger !== null ? { onerilen_deger } : {})
    }));
  };

  // Rapor genelinde çelişkili iddiaları yakalamak için `(varlık|genel, ölçü, dönem) → ilk değer` tablosu.
  const observedAssertions = new Map();
  const observedTaskDates = new Map();

  // Yazar iddia ekini konuma göre grupla (yalnızca bütünlük çapraz denetimi için; kapsamı daraltmaz).
  const claimsByBlock = new Map();
  for (const claim of draft?.iddialar || []) {
    const key = `${claim.bolum}#${claim.paragraf}`;
    if (!claimsByBlock.has(key)) claimsByBlock.set(key, []);
    claimsByBlock.get(key).push(claim);
  }

  const unauthorizedList = [...new Set(unauthorizedEntities.filter((n) => typeof n === 'string' && n.trim()))];
  const externalList = [...new Set(knownExternalEntities.filter((n) => typeof n === 'string' && n.trim()))]
    .filter((name) => !ledger.authorizedEntityNames.has(canonicalEntityKey(name)));

  const blocks = [];
  for (const section of draft?.bolumler || []) {
    if (section.one_cikan_tespit?.metin) {
      blocks.push({ bolum: section.kimlik, paragraf: 'one_cikan_tespit', block: section.one_cikan_tespit });
    }
    (section.paragraflar || []).forEach((p, idx) => {
      blocks.push({ bolum: section.kimlik, paragraf: idx + 1, block: p });
    });
  }

  for (const { bolum, paragraf, block } of blocks) {
    const text = String(block.metin ?? '');
    const sentences = splitTurkishSentences(text);
    const blockClaims = claimsByBlock.get(`${bolum}#${paragraf}`) || [];

    // 1. Cümle bazlı nesnel denetimler
    for (const sentence of sentences) {
      const sRaw = sentence.text;
      const sNorm = normalizeTurkishText(sRaw);

      // 1a. Yetkisiz varlık açıklaması (kesin kapı)
      for (const unauth of unauthorizedList) {
        if (matchesEntityName(sRaw, sNorm, unauth)) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.UNAUTHORIZED_DISCLOSURE,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            // Hata mesajı yetkisiz varlık adını asla yankılamaz.
            mesaj: 'Bu cümlede yetkili kanıt paketinde bulunmayan kapalı veya yetkisiz bir varlığa atıf yapılıyor.'
          });
        }
      }

      // 1b. Gömülü yönerge (istem enjeksiyonu) yankısı (kesin kapı)
      const lowerRaw = sRaw.normalize('NFC').toLocaleLowerCase('tr-TR');
      if (EMBEDDED_INSTRUCTION_MARKERS.some((marker) => lowerRaw.includes(marker))) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.SECURITY_VIOLATION,
          siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sRaw,
          mesaj: 'Güvenilmez kayıt metnindeki gömülü yönerge veya istem enjeksiyonu ifadesi rapora taşınamaz.'
        });
      }

      // 1c. Uydurma kimlik: pakette olmayan kodlar (`PRJ-*`, `T-*`), kadro dışı bilinen varlıklar ve uydurma `<Ad> Projesi`
      for (const codeMatch of sRaw.matchAll(/\b((?:PRJ|T)-[A-Z0-9_-]{2,})\b/gu)) {
        const codeKey = canonicalEntityKey(codeMatch[1]);
        if (!ledger.authorizedCodes.has(codeKey) && !unauthorizedList.some((u) => canonicalEntityKey(u) === codeKey)) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_IDENTITY,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            mesaj: 'Cümlede yetkili kanıt paketinde yer almayan bir proje veya görev kodu geçiyor.'
          });
        }
      }
      for (const extName of externalList) {
        if (unauthorizedList.some((u) => canonicalEntityKey(u) === canonicalEntityKey(extName))) continue;
        if (matchesEntityName(sRaw, sNorm, extName, { strictSingleWord: true })) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_IDENTITY,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            mesaj: 'Cümlede yetkili kanıt paketinde bulunmayan bir proje, kişi veya birim adı geçiyor.'
          });
        }
      }
      // Açıkça "<ÖzelAd> Projesi/projesinde/projesinin" iyelik kalıbıyla anılan ve yetkili varlıklarda bulunmayan proje adları
      for (const projMatch of sRaw.matchAll(/(?<![\p{L}\d])([A-ZÇĞİÖŞÜ][\p{L}0-9-]{2,})\s+[Pp]roje(?:si|sinde|sine|sinin|sini|sinden)(?![\p{L}\d])/gu)) {
        const candidate = canonicalEntityKey(projMatch[1]);
        if (!candidate || /^\d+$/u.test(candidate) || GENERIC_PROJECT_PREFIXES.has(candidate)) continue;
        const alreadyKnown = ledger.authorizedEntityNames.has(candidate)
          || ledger.authorizedEntityNames.has(`${candidate} projesi`)
          || unauthorizedList.some((u) => canonicalEntityKey(u) === candidate)
          || externalList.some((e) => canonicalEntityKey(e) === candidate);
        if (!alreadyKnown) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_IDENTITY,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            mesaj: 'Cümlede yetkili kanıtta yer almayan bir proje adı geçiyor.'
          });
        }
      }

      // 1d. Planlı şekil ve tablo göndermeleri (`Şekil N`, `Tablo N`)
      for (const visMatch of sNorm.matchAll(/(?<![\p{L}\d])(şekil|tablo)\s+(\d+)(?:'[a-zçğıöşü]+)?(?![\p{L}\d])/gu)) {
        const kind = visMatch[1];
        const num = Number(visMatch[2]);
        const allowed = kind === 'şekil' ? ledger.plannedFigures : ledger.plannedTables;
        if (!allowed.includes(num)) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.INVALID_VISUAL_REFERENCE,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            mesaj: `Belge görsel planında bulunmayan ${kind === 'şekil' ? 'Şekil' : 'Tablo'} ${num} göndermesi yapılamaz.`
          });
        }
      }

      // 1e. Tarih denetimi (uydurma veya geçersiz takvim tarihi — kesin kapı)
      const dateAnalysis = extractTurkishDates(sRaw, ledger.defaultYear, {
        includeInvalid: true,
        maskLiterals: ledger.literalNamesWithDigits
      });
      for (const invalidDay of dateAnalysis.invalidDays) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_DATE,
          siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sRaw,
          mesaj: `Geçersiz takvim tarihi tespit edildi (${invalidDay.replace('gecersiz:', '')}).`
        });
      }
      for (const day of dateAnalysis.validDays) {
        if (!ledger.authorizedDates.has(day)) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.FABRICATED_DATE,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            mesaj: `Yetkili kanıt paketinde bulunmayan tarih (${day}) raporda yer alamaz.`
          });
        }
      }

      // 1f. Kronoloji tersinmesi denetimi
      const inversions = detectSentenceChronologyInversions(sRaw, ledger.defaultYear, ledger.literalNamesWithDigits);
      for (const inv of inversions) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.CHRONOLOGY_INVERSION,
          siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sRaw,
          mesaj: `Kronoloji tersinmesi: ${inv.onceki_tarih} ve ${inv.sonraki_tarih} tarihleri "${inv.baglac}" bağlacıyla ters sırayla anlatılmış.`
        });
      }

      // 1g. Görev durumu, kesit sonrası değişim ve tarihsiz tamamlanma gecikme denetimi (tümce düzeyinde)
      const matchingTasks = ledger.tasks.filter((t) => t.baslikNorm && t.baslikNorm.length >= 4 && sNorm.includes(t.baslikNorm));
      const sentenceHasDelayClaim = DELAY_CLAIM_PATTERN.test(sNorm) && !NEGATED_DELAY_PATTERN.test(sNorm);
      if (matchingTasks.length > 0) {
        const taskClauses = splitClauses(sRaw);
        const taskGroupByTitle = new Map();
        for (const t of matchingTasks) {
          if (!taskGroupByTitle.has(t.baslikNorm)) taskGroupByTitle.set(t.baslikNorm, []);
          taskGroupByTitle.get(t.baslikNorm).push(t);
        }
        for (const [titleNorm, sameTitleTasks] of taskGroupByTitle.entries()) {
          const relevantClauses = taskClauses.filter((cl) => normalizeTurkishText(cl).includes(titleNorm));
          const taskContextRaw = relevantClauses.length > 0 ? relevantClauses.join(' ') : sRaw;
          const taskContextNorm = normalizeTurkishText(taskContextRaw);
          const hasNegCompletion = NEGATED_COMPLETION_PATTERN.test(taskContextNorm)
            || trWord('(?:buna\\s+rağmen|ancak)\\s+(?:görev|iş)\\p{L}*\\s+(?:henüz\\s+|resmi\\s+olarak\\s+)?(?:tamamlanmad|kapanmad)\\p{L}*').test(sNorm)
            || trWord('ait\\s+notlar\\p{L}*').test(taskContextNorm);
          const hasPosCompletion = POSITIVE_COMPLETION_PATTERN.test(taskContextNorm) && !hasNegCompletion;
          const hasDelayClaim = DELAY_CLAIM_PATTERN.test(taskContextNorm) && !NEGATED_DELAY_PATTERN.test(taskContextNorm);
          const contextEntities = findMentionedEntityGroups(taskContextNorm, ledger);
          const sentenceEntities = contextEntities.size > 0 ? contextEntities : findMentionedEntityGroups(sNorm, ledger);
          const scopedTasks = sameTitleTasks.filter((t) => !t.projectGroup || sentenceEntities.size === 0 || sentenceEntities.has(t.projectGroup));
          const activeTasks = scopedTasks.length > 0 ? scopedTasks : sameTitleTasks;

          // Aynı görev adında farklı durumlar varsa belirsiz olarak işaretle; aksi hâlde kesin denetle.
          const statuses = new Set(activeTasks.map((t) => t.durum));
          if (hasPosCompletion) {
            const allOpen = activeTasks.every((t) => t.durum && t.durum !== 'tamamlandi' && !t.donemde_tamamlandi && !t.kesit_sonrasi_degisti);
            if (allOpen) {
              addFinding({
                kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_TASK_STATUS,
                siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                bolum,
                paragraf,
                cumle: sentence.index,
                alinti: sRaw,
                kanitlar: activeTasks.map((t) => t.id),
                mesaj: 'Kanıtta hâlen açık/devam ediyor görünen görev tamamlanmış gibi ifade edilmiş.'
              });
            } else if (statuses.size > 1 && activeTasks.length > 1) {
              addFinding({
                kod: REPORT_OBJECTIVE_FINDING_CODES.AMBIGUOUS_OBJECTIVE_STATEMENT,
                siddet: REPORT_FINDING_SEVERITIES.MEDIUM,
                bolum,
                paragraf,
                cumle: sentence.index,
                alinti: sRaw,
                kanitlar: activeTasks.map((t) => t.id),
                mesaj: 'Aynı adlı birden çok görev farklı durumlarda olduğundan ifade anlamsal inceleme gerektiriyor.'
              });
            }
          }
          // Kesit sonrası değişmiş görevde kesit anı durum/gecikme iddiası
          if (activeTasks.some((t) => t.kesit_sonrasi_degisti) && (hasPosCompletion || hasDelayClaim)) {
            addFinding({
              kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_TASK_STATUS,
              siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
              bolum,
              paragraf,
              cumle: sentence.index,
              alinti: sRaw,
              kanitlar: activeTasks.filter((t) => t.kesit_sonrasi_degisti).map((t) => t.id),
              mesaj: 'Veri kesiti sonrasında değişen görev için kesit anı durum veya gecikme iddiası kurulamaz.'
            });
          }
          // Tarihsiz tamamlanan görevde gecikme iddiası (R5/S21)
          if (hasDelayClaim && activeTasks.every((t) => t.durum === 'tamamlandi' && t.gerceklesen_bitis === null)) {
            addFinding({
              kod: REPORT_OBJECTIVE_FINDING_CODES.UNSUPPORTED_DERIVATION,
              siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
              bolum,
              paragraf,
              cumle: sentence.index,
              alinti: sRaw,
              kanitlar: activeTasks.map((t) => t.id),
              mesaj: 'Gerçekleşen bitiş tarihi kayıtlı olmayan tamamlanmış görev için gecikme iddiası kurulamaz.'
            });
          }
          // Aynı göreve rapor içinde çelişen gerçekleşen bitiş tarihi verilmesi
          const taskContextDates = extractTurkishDates(taskContextRaw, ledger.defaultYear, {
            includeInvalid: false,
            maskLiterals: ledger.literalNamesWithDigits
          }).validDays;
          if (hasPosCompletion && activeTasks.length === 1 && taskContextDates.length === 1) {
            const taskId = activeTasks[0].id;
            const assertedDay = taskContextDates[0];
            if (activeTasks[0].gerceklesen_bitis && activeTasks[0].gerceklesen_bitis !== assertedDay && ledger.authorizedDates.has(assertedDay)) {
              addFinding({
                kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_OBJECTIVE_VALUE,
                siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                bolum,
                paragraf,
                cumle: sentence.index,
                alinti: sRaw,
                kanitlar: [taskId],
                onerilen_deger: activeTasks[0].gerceklesen_bitis,
                mesaj: `Görevin gerçekleşen bitiş tarihi kanıtta ${activeTasks[0].gerceklesen_bitis} olarak kayıtlıdır.`
              });
            }
            const prevDate = observedTaskDates.get(taskId);
            if (prevDate && prevDate.day !== assertedDay) {
              addFinding({
                kod: REPORT_OBJECTIVE_FINDING_CODES.CONTRADICTORY_CLAIM,
                siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                bolum,
                paragraf,
                cumle: sentence.index,
                alinti: sRaw,
                kanitlar: [taskId],
                mesaj: `Aynı görev için daha önce ${prevDate.day}, burada ise ${assertedDay} tarihi verilmiş (çelişen iddia).`
              });
            } else {
              observedTaskDates.set(taskId, { day: assertedDay, bolum, paragraf });
            }
          }
        }
      } else if (sentenceHasDelayClaim && ledger.hasUndatedDone && !ledger.metricBindings.some((b) => b.metric === 'geciken' && b.value > 0) && !ledger.tasks.some((t) => t.gecikme_gunu > 0)) {
        // Görev adı anılmadan tarihsiz tamamlanan kapsamda genel gecikme iddiası (R5 yasak ifade 2)
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.UNSUPPORTED_DERIVATION,
          siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sRaw,
          mesaj: 'Kayıtlı gecikme kanıtı olmadan (tarihsiz tamamlanan görev üzerinden) gecikme iddiası kurulamaz.'
        });
      }

      // 1h. Bilinmeyen (null) ölçünün sıfır / "yok" olarak yazılması
      if (ledger.unknownMetrics.length > 0 && ZERO_CLAIM_PATTERN.test(sNorm) && !UNKNOWN_EXPLICIT_PATTERN.test(sNorm)) {
        const sentenceMetrics = new Set(findMetricCueMatches(sNorm).map((h) => h.metric));
        const matchedUnknown = ledger.unknownMetrics.find((u) => sentenceMetrics.has(u.metric));
        if (matchedUnknown) {
          addFinding({
            kod: REPORT_OBJECTIVE_FINDING_CODES.UNKNOWN_AS_ZERO,
            siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
            bolum,
            paragraf,
            cumle: sentence.index,
            alinti: sRaw,
            kanitlar: [matchedUnknown.evidenceId],
            mesaj: 'Kanıtta bilinmeyen (null) olarak kayıtlı ölçü sıfır veya "yok" şeklinde kesinleştirilemez.'
          });
        }
      }

      // 1i. Eksik/kısmi kanıtın tamlık abartması
      if (ledger.hasPartialCoverage && OVERSTATEMENT_COMPLETE_PATTERN.test(sNorm)) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.INCOMPLETE_EVIDENCE_OVERSTATEMENT,
          siddet: REPORT_FINDING_SEVERITIES.MEDIUM,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sRaw,
          mesaj: 'Kanıt paketi kısmi veya kesilmiş olmasına karşın tamlık abartılmış.'
        });
      }

      // 1j. Bağlamsal nicelik, yüzde, oran ve süre doğrulaması (noktalı virgül sınırı + yerel tümce)
      const sentencePeriodFallback = detectPeriodCue(sNorm, dateAnalysis.validDays, ledger);
      const semicolonSegments = String(sRaw).split(';').map((part) => part.trim()).filter(Boolean);

      for (const segment of semicolonSegments) {
        const segNorm = normalizeTurkishText(segment);
        const segDates = extractTurkishDates(segment, ledger.defaultYear, {
          includeInvalid: false,
          maskLiterals: ledger.literalNamesWithDigits
        }).validDays;
        const segmentMetricFallback = detectMetricCue(segNorm);
        const segmentPeriodFallback = detectPeriodCue(segNorm, segDates, ledger) ?? sentencePeriodFallback;
        const segmentIsAggregate = AGGREGATE_CUE_PATTERN.test(segNorm);
        const clauses = splitClauses(segment);

        for (const clause of clauses) {
          const cNorm = normalizeTurkishText(clause);
          const cDates = extractTurkishDates(clause, ledger.defaultYear, {
            includeInvalid: false,
            maskLiterals: ledger.literalNamesWithDigits
          }).validDays;
          const cQuantities = extractTurkishQuantities(clause, ledger.defaultYear, {
            allowedYears: ledger.allowedYears,
            maskHorizonSeven: ledger.hasSevenDayHorizon,
            maskLiterals: ledger.literalNamesWithDigits,
            plannedFigures: ledger.plannedFigures,
            plannedTables: ledger.plannedTables
          });
          if (!cQuantities.length) continue;

          const cEntities = findMentionedEntityGroups(cNorm, ledger);
          const cPeriod = detectPeriodCue(cNorm, cDates, ledger) ?? segmentPeriodFallback;
          const cAggregate = AGGREGATE_CUE_PATTERN.test(cNorm) || (cEntities.size > 1) || (cEntities.size === 0 && segmentIsAggregate);

          for (const qty of cQuantities) {
            // Yüzde denetimi: yüzde değeri sunucu türetiminde veya yetkili yüzde defterinde olmalıdır.
            if (qty.kind === 'yuzde') {
              const unknownPct = ledger.unknownMetrics.find((u) => u.isPercentage);
              const directMatch = [...ledger.authorizedPercentages].some((v) => approxEqual(v, qty.value, 0.05));
              const signedNegativeMatch = qty.value > 0
                && NEGATIVE_CHANGE_CUE_PATTERN.test(cNorm)
                && [...ledger.authorizedNegativePercentMagnitudes].some((v) => approxEqual(v, qty.value, 0.05));
              if (!directMatch && !signedNegativeMatch) {
                addFinding({
                  kod: unknownPct
                    ? REPORT_OBJECTIVE_FINDING_CODES.UNKNOWN_AS_ZERO
                    : REPORT_OBJECTIVE_FINDING_CODES.UNSUPPORTED_DERIVATION,
                  siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                  bolum,
                  paragraf,
                  cumle: sentence.index,
                  alinti: sRaw,
                  kanitlar: unknownPct ? [unknownPct.evidenceId] : [],
                  mesaj: `Yetkili kanıtta veya sunucu türetimlerinde desteklenmeyen yüzde değeri (${qty.raw}).`
                });
                continue;
              }
            }

            // Oran denetimi (`a/b`, `b'de a`): hem pay hem payda kanıtta desteklenmeli
            if (qty.kind === 'oran') {
              const numOk = [...ledger.authorizedNumbers].some((v) => approxEqual(v, qty.value));
              const denOk = [...ledger.authorizedNumbers].some((v) => approxEqual(v, qty.denominator));
              if (!numOk || !denOk) {
                addFinding({
                  kod: REPORT_OBJECTIVE_FINDING_CODES.UNSUPPORTED_DERIVATION,
                  siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                  bolum,
                  paragraf,
                  cumle: sentence.index,
                  alinti: sRaw,
                  mesaj: `Yetkili kanıtta desteklenmeyen oran ifadesi (${qty.raw}).`
                });
                continue;
              }
            }

            // Genel sayı/süre defter varlığı denetimi
            if (qty.kind === 'sayi' || qty.kind === 'sure') {
              const beforeQty = cNorm.slice(Math.max(0, qty.index - 16), qty.index);
              const afterQty = cNorm.slice(qty.index + qty.raw.length, qty.index + qty.raw.length + 36);
              const isEditorialDiscoursePhrase = qty.kind === 'sayi'
                && qty.value >= 2
                && qty.value <= 4
                && /(?<![\p{L}\p{N}])bu\s+$/u.test(beforeQty)
                && /^\s*(?:tablo\p{L}*|farkli|ayri|eksen\p{L}*|başli\p{L}*|konu\p{L}*|nokta\p{L}*|yön\p{L}*|aşama\p{L}*|gelişme\p{L}*)(?![\p{L}\p{N}])/u.test(afterQty);
              const inNumberLedger = isEditorialDiscoursePhrase
                || [...ledger.authorizedNumbers].some((v) => approxEqual(v, qty.value));
              if (!inNumberLedger) {
                addFinding({
                  kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_OBJECTIVE_VALUE,
                  siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                  bolum,
                  paragraf,
                  cumle: sentence.index,
                  alinti: sRaw,
                  mesaj: `Yetkili kanıt defterinde yer almayan nesnel sayısal değer (${qty.raw}).`
                });
                continue;
              }
            }

            // Bağlamsal eşleme (6.1): Değer pakette VAR, ama DOĞRU varlığa, DOĞRU döneme ve DOĞRU yerel ölçüye mi bağlı?
            const qMetric = qty.kind === 'sayi'
              ? detectLocalMetricCue(cNorm, qty, cQuantities, segmentMetricFallback)
              : null;

            if (qty.kind === 'sayi' && qMetric) {
              // 1. Tekil varlık → ölçü eşlemesi (ör. "B Projesi kapsamında 12 görev tamamlanmıştır" → A=12, B=8)
              if (cEntities.size === 1 && !cAggregate) {
                const [entityGroup] = [...cEntities.keys()];
                const matchingEntityBindings = ledger.metricBindings.filter(
                  (b) => b.metric === qMetric
                    && !b.isPercentage
                    && b.entities.size === 1
                    && b.entities.has(entityGroup)
                    && (!cPeriod || b.periodKind === cPeriod || b.periodKind === 'anlik')
                );
                if (matchingEntityBindings.length > 0) {
                  const valueMatchesEntity = matchingEntityBindings.some((b) => approxEqual(b.value, qty.value));
                  if (!valueMatchesEntity) {
                    addFinding({
                      kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_ENTITY_ATTRIBUTION,
                      siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                      bolum,
                      paragraf,
                      cumle: sentence.index,
                      alinti: sRaw,
                      kanitlar: matchingEntityBindings.map((b) => b.evidenceId),
                      onerilen_deger: matchingEntityBindings[0].value,
                      mesaj: `Değer (${qty.value}) kanıt paketinde geçse de bu varlığın "${qMetric}" ölçüsü için kayıtlı değer ${matchingEntityBindings[0].value}'dir.`
                    });
                    continue;
                  }
                }
              }

              // 2. Dönem bağlamı eşlemesi (rapor dönemi ↔ karşılaştırma dönemi)
              if (cPeriod && ledger.comparisonPeriod) {
                const periodBindings = ledger.metricBindings.filter(
                  (b) => b.metric === qMetric
                    && !b.isPercentage
                    && b.periodKind === cPeriod
                    && (cEntities.size !== 1 || cAggregate || (b.entities.size === 1 && b.entities.has([...cEntities.keys()][0])))
                );
                if (periodBindings.length > 0 && !periodBindings.some((b) => approxEqual(b.value, qty.value))) {
                  const otherPeriod = cPeriod === 'rapor' ? 'karsilastirma' : 'rapor';
                  const inOtherPeriod = ledger.metricBindings.some(
                    (b) => b.metric === qMetric && b.periodKind === otherPeriod && approxEqual(b.value, qty.value)
                  );
                  addFinding({
                    kod: inOtherPeriod
                      ? REPORT_OBJECTIVE_FINDING_CODES.WRONG_PERIOD_ATTRIBUTION
                      : REPORT_OBJECTIVE_FINDING_CODES.WRONG_OBJECTIVE_VALUE,
                    siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                    bolum,
                    paragraf,
                    cumle: sentence.index,
                    alinti: sRaw,
                    kanitlar: periodBindings.map((b) => b.evidenceId),
                    onerilen_deger: periodBindings[0].value,
                    mesaj: inOtherPeriod
                      ? `Değer (${qty.value}) diğer döneme aittir; bu dönemin "${qMetric}" ölçüsü ${periodBindings[0].value}'dir.`
                      : `Bu dönemin "${qMetric}" ölçüsü için kayıtlı değer ${periodBindings[0].value}'dir.`
                  });
                  continue;
                }
              }

              // 3. Toplam / genel kapsam ölçü uyuşmazlığı (ör. açık görev sayısı tamamlanan gibi yazılmış)
              if (cEntities.size === 0 || cAggregate) {
                const scopeBindings = ledger.metricBindings.filter(
                  (b) => b.metric === qMetric
                    && !b.isPercentage
                    && (cAggregate ? b.isAggregate : true)
                    && (!cPeriod || b.periodKind === cPeriod || b.periodKind === 'anlik')
                );
                if (scopeBindings.length > 0 && !scopeBindings.some((b) => approxEqual(b.value, qty.value))) {
                  // Değer aynı varlıkta başka bir alt küme ölçüsüne ait olabilir ("toplam 18'in 6'sı..." gibi);
                  // yalnızca alt küme/bölünme ifadesi yoksa reddet.
                  if (!SUBSET_CONTEXT_PATTERN.test(cNorm)) {
                    addFinding({
                      kod: REPORT_OBJECTIVE_FINDING_CODES.WRONG_OBJECTIVE_VALUE,
                      siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                      bolum,
                      paragraf,
                      cumle: sentence.index,
                      alinti: sRaw,
                      kanitlar: scopeBindings.map((b) => b.evidenceId),
                      onerilen_deger: scopeBindings[0].value,
                      mesaj: `"${qMetric}" ölçüsü için kanıttaki değer ${scopeBindings[0].value}'dir; ${qty.value} değeri bu ölçüyle uyuşmuyor.`
                    });
                    continue;
                  }
                }
              }

              // 4. Rapor genelinde çelişen aynı-varlık/aynı-ölçü iddiası takibi
              const entityScopeKey = cEntities.size === 1 && !cAggregate ? [...cEntities.keys()][0] : (cAggregate ? '__toplam__' : null);
              if (entityScopeKey && !SUBSET_CONTEXT_PATTERN.test(cNorm)) {
                const assertKey = `${entityScopeKey}|${qMetric}|${cPeriod ?? 'genel'}`;
                const prev = observedAssertions.get(assertKey);
                if (prev && !approxEqual(prev.value, qty.value)) {
                  addFinding({
                    kod: REPORT_OBJECTIVE_FINDING_CODES.CONTRADICTORY_CLAIM,
                    siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
                    bolum,
                    paragraf,
                    cumle: sentence.index,
                    alinti: sRaw,
                    mesaj: `Aynı varlık ve ölçü için raporda çelişen değerler yazılmış (${prev.value} ve ${qty.value}).`
                  });
                } else if (!prev) {
                  observedAssertions.set(assertKey, { value: qty.value, bolum, paragraf });
                }
              }
            }
          }
        }
      }
    }

    // 2. Yazarın iddia eki (`iddialar`) ile düzyazı bütünlüğü çapraz denetimi (6.3)
    const normalizedQuotes = blockClaims.map((c) => normalizeTurkishText(c.alinti).trim());
    for (const claim of blockClaims) {
      if (claim.sinif === REPORT_CLAIM_CLASSES.UNSUPPORTED_MATERIAL_CLAIM) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.APPENDIX_INCONSISTENCY,
          siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
          bolum,
          paragraf,
          cumle: null,
          alinti: claim.alinti,
          mesaj: 'Yazar iddia ekinde desteklenmeyen maddi iddia sınıfı beyan etmiş.'
        });
      }
      // Geçerli bir E# kimliğinin ilgisiz bir ifadeye bağlanması denetimi
      if (claim.sinif === REPORT_CLAIM_CLASSES.OBJECTIVE_FACT && Array.isArray(claim.kanitlar) && claim.kanitlar.length > 0) {
        const quoteQuantities = extractTurkishQuantities(claim.alinti, ledger.defaultYear, {
          allowedYears: ledger.allowedYears,
          maskHorizonSeven: ledger.hasSevenDayHorizon,
          maskLiterals: ledger.literalNamesWithDigits
        });
        const quoteDates = extractTurkishDates(claim.alinti, ledger.defaultYear, {
          includeInvalid: false,
          maskLiterals: ledger.literalNamesWithDigits
        }).validDays;
        if (quoteQuantities.length > 0 || quoteDates.length > 0) {
          const citedRecords = claim.kanitlar.map((id) => ledger.evidenceById.get(id)).filter(Boolean);
          const citedBlob = JSON.stringify(citedRecords);
          const citedDates = new Set(extractTurkishDates(citedBlob, ledger.defaultYear, { includeInvalid: false }).validDays);
          for (const rec of citedRecords) {
            for (const f of ['hedef_bitis', 'gerceklesen_bitis', 'kayit_zamani', 'veri_ani']) {
              const d = parseStrictEvidenceDay(rec[f]);
              if (d) citedDates.add(d);
            }
            if (isPlainObject(rec.donem)) {
              if (isIsoDay(rec.donem.baslangic)) citedDates.add(rec.donem.baslangic);
              if (isIsoDay(rec.donem.bitis)) citedDates.add(rec.donem.bitis);
            }
          }
          const citedNums = new Set();
          const collectCitedNums = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) citedNums.add(v);
            else if (typeof v === 'string') {
              for (const q of extractTurkishQuantities(v, ledger.defaultYear)) citedNums.add(q.value);
            } else if (Array.isArray(v)) v.forEach(collectCitedNums);
            else if (isPlainObject(v)) Object.values(v).forEach(collectCitedNums);
          };
          collectCitedNums(citedRecords);

          const anyDateMatch = quoteDates.some((d) => citedDates.has(d));
          const anyNumMatch = quoteQuantities.some((q) => [...citedNums].some((n) => approxEqual(n, q.value, 0.05)));
          if (!anyDateMatch && !anyNumMatch) {
            addFinding({
              kod: REPORT_OBJECTIVE_FINDING_CODES.APPENDIX_INCONSISTENCY,
              siddet: REPORT_FINDING_SEVERITIES.MEDIUM,
              bolum,
              paragraf,
              cumle: null,
              alinti: claim.alinti,
              kanitlar: claim.kanitlar,
              mesaj: 'İddia ekindeki alıntıda yer alan sayı veya tarihler, atfedilen kanıt kimliklerinde bulunmuyor (ilgisiz kanıt atfı).'
            });
          }
        }
      }
    }

    // Düzyazıda olup iddia ekinden tamamen atlanmış nesnel sayısal/tarihli cümleler (anlamsal inceleme uyarısı)
    for (const sentence of sentences) {
      const sDates = extractTurkishDates(sentence.text, ledger.defaultYear, {
        includeInvalid: false,
        maskLiterals: ledger.literalNamesWithDigits
      }).validDays;
      const sQtys = extractTurkishQuantities(sentence.text, ledger.defaultYear, {
        allowedYears: ledger.allowedYears,
        maskHorizonSeven: ledger.hasSevenDayHorizon,
        maskLiterals: ledger.literalNamesWithDigits,
        plannedFigures: ledger.plannedFigures,
        plannedTables: ledger.plannedTables
      });
      if (sDates.length === 0 && sQtys.length === 0) continue;
      const sNorm = normalizeTurkishText(sentence.text).trim();
      const coveredByAppendix = normalizedQuotes.some((q) => q && (sNorm.includes(q) || q.includes(sNorm)));
      if (!coveredByAppendix) {
        addFinding({
          kod: REPORT_OBJECTIVE_FINDING_CODES.APPENDIX_INCONSISTENCY,
          siddet: REPORT_FINDING_SEVERITIES.WARNING,
          bolum,
          paragraf,
          cumle: sentence.index,
          alinti: sentence.text,
          mesaj: 'Düzyazıdaki nesnel sayı/tarih içeren ifade yazarın iddia ekinde beyan edilmemiş.'
        });
      }
    }
  }

  // 3. Zorunlu olgular ve plan zorunlu açıklamaları tamlık denetimi
  const mandatoryCoverage = evaluateMandatoryFacts(draft, mandatoryFacts, ledger.defaultYear, ledger.literalNamesWithDigits);
  for (const item of mandatoryCoverage) {
    if (!item.yer_aliyor) {
      addFinding({
        kod: REPORT_OBJECTIVE_FINDING_CODES.MISSING_MANDATORY_FACT,
        siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
        bolum: item.bolum ?? draft?.bolumler?.[0]?.kimlik ?? 'yonetici_degerlendirmesi',
        paragraf: null,
        cumle: null,
        alinti: '',
        mesaj: `Zorunlu olgu (${item.id}) raporda yer almıyor.`
      });
    }
  }

  const disclosureCoverage = evaluatePlanDisclosures(draft, plan);
  for (const item of disclosureCoverage) {
    if (!item.yer_aliyor) {
      addFinding({
        kod: REPORT_OBJECTIVE_FINDING_CODES.MISSING_MANDATORY_FACT,
        siddet: REPORT_FINDING_SEVERITIES.CRITICAL,
        bolum: item.bolum,
        paragraf: null,
        cumle: null,
        alinti: '',
        mesaj: `Kaldırılamaz bütünlük açıklaması (${item.kimlik}) ilgili bölümde karşılanmamış.`
      });
    }
  }

  const hardGates = findings.filter((f) => f.kesin_kapi);
  const criticalCount = findings.filter((f) => f.siddet === REPORT_FINDING_SEVERITIES.CRITICAL).length;

  return Object.freeze({
    ok: criticalCount === 0,
    bulgular: Object.freeze(findings),
    kesin_kapilar: Object.freeze(hardGates),
    kritik_bulgu_sayisi: criticalCount,
    zorunlu_olgu_kapsami: Object.freeze(mandatoryCoverage),
    zorunlu_aciklama_kapsami: Object.freeze(disclosureCoverage),
    defter_ozeti: Object.freeze({
      kanit_sayisi: ledger.evidenceById.size,
      tarih_sayisi: ledger.authorizedDates.size,
      sayi_sayisi: ledger.authorizedNumbers.size,
      varlik_sayisi: ledger.authorizedEntityNames.size
    })
  });
}

/**
 * Yerel onarım veya hedefli denetim için yalnızca ilgili paragraf ve bulgularla ilişkili yetkili
 * kanıt alt kümesini belirlenimci olarak seçer. Tüm kanıt paketini her onarımda yeniden göndermez.
 *
 * @param {object} input - Seçim girdileri.
 * @param {{ metin: string, kanitlar?: string[] }} input.paragraph - Hedef paragraf.
 * @param {string} input.sectionId - Bölüm kimliği.
 * @param {object[]} [input.findings] - Paragrafın bulguları.
 * @param {object} input.evidencePackage - Yetkili `4i-kanit-1` kanıt paketi.
 * @param {object|null} [input.plan] - Bölüm planı.
 * @param {number} [input.maxItems] - Seçilecek en çok kanıt kaydı sayısı.
 * @returns {{ kanitlar: object[], turetilmis: object[], celiskiler: object[], kanit_kimlikleri: string[] }} Seçilen alt küme.
 */
export function selectRelevantEvidenceForParagraph({
  paragraph,
  sectionId,
  findings = [],
  evidencePackage,
  plan = null,
  maxItems = 18
}) {
  const projected = projectEvidencePackageForWriter(evidencePackage);
  const scoreById = new Map();
  const bump = (id, points) => {
    if (typeof id !== 'string') return;
    scoreById.set(id, (scoreById.get(id) ?? 0) + points);
  };

  for (const ref of paragraph?.kanitlar || []) bump(ref, 100);
  for (const finding of findings) {
    for (const ref of finding?.kanitlar || []) bump(ref, 120);
  }
  const planSection = (plan?.bolumler || []).find((s) => s.kimlik === sectionId);
  if (planSection) {
    for (const ref of planSection.odak_kanitlar || []) bump(ref, 25);
    for (const disc of planSection.zorunlu_aciklamalar || []) {
      for (const ref of disc.kanitlar || []) bump(ref, 40);
    }
  }

  // Paragrafta geçen sözcük/varlık/tarih örtüşmesine göre ek belirlenimci puanlama
  const pNorm = normalizeTurkishText(paragraph?.metin ?? '');
  const pTokens = new Set(pNorm.split(/[^a-zçğıöşü0-9-]+/u).filter((t) => t.length >= 3));
  for (const item of [...projected.kanitlar, ...projected.turetilmis]) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue;
    const itemText = normalizeTurkishText(JSON.stringify(item));
    let overlap = 0;
    for (const tok of pTokens) {
      if (itemText.includes(tok)) overlap += 1;
    }
    if (overlap > 0) bump(item.id, Math.min(60, overlap * 6));
  }

  // Sıralı ve kararlı seçim (en yüksek puanlı `maxItems` kayıt, ardından orijinal paket sırasına dizilir).
  const allOrderedIds = [
    ...projected.kanitlar.map((i) => i?.id),
    ...projected.turetilmis.map((i) => i?.id)
  ].filter((id) => typeof id === 'string');

  const ranked = [...allOrderedIds].sort((a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0));
  const selectedIds = new Set(ranked.slice(0, Math.max(1, maxItems)));

  const kanitlar = projected.kanitlar.filter((item) => selectedIds.has(item?.id));
  const turetilmis = projected.turetilmis.filter((item) => selectedIds.has(item?.id));
  const celiskiler = projected.celiskiler.filter(
    (c) => Array.isArray(c?.kanitlar) && c.kanitlar.some((id) => selectedIds.has(id))
  );

  return Object.freeze({
    kanitlar: Object.freeze(kanitlar),
    turetilmis: Object.freeze(turetilmis),
    celiskiler: Object.freeze(celiskiler),
    kanit_kimlikleri: Object.freeze([...selectedIds])
  });
}
