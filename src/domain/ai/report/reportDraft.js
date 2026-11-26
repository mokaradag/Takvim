import { MAX_PARAGRAPHS_PER_SECTION, REPORT_WRITING_CONTRACT } from './reportSectionPlan.js';

/**
 * Bilgin Aşama 4I-B — yazar çıktısının yapısal ve göndergesel doğrulaması (`4i-yazim-1`, saf).
 *
 * Model yanıtı güvenilmez girdidir. Ayrıştırıcı:
 *   - yalnızca tek JSON nesnesini (en çok bir kod çiti sarmalıyla) kabul eder; metinden JSON "kazımaz";
 *   - ham JSON metninde yinelenen nesne anahtarlarını reddeder;
 *   - kapalı şema uygular (bilinmeyen alan, prototip anahtarı, yinelenen ya da plan dışı bölüm reddedilir);
 *   - bütün kanıt göndergelerini pakette gerçekten bulunan E#/F# kimliklerine bağlar;
 *   - boyut ve sayı sınırları uygular;
 *   - model düzyazısını AYNEN korur: paragraf metni sunucuca yeniden kurulmaz, kısaltılmaz ya da düzeltilmez.
 *
 * İddia eki yazarın BEYANIDIR; olgusal doğruluğun ya da tamlığın kanıtı değildir. Beyan edilmemiş nesnel
 * ifadeler de değerlendirmede (4I-B kıyası, 4I-C doğrulaması) düzyazının kendisinden denetlenir.
 */

export const REPORT_DRAFT_LIMITS = Object.freeze({
  maxRawChars: 200000,
  maxSections: 6,
  maxParagraphsPerSection: MAX_PARAGRAPHS_PER_SECTION,
  maxParagraphChars: 4000,
  maxHighlightChars: 600,
  maxRefsPerParagraph: 60,
  maxClaims: 400,
  maxQuoteChars: 400
});

export const REPORT_DRAFT_ERROR_CODES = Object.freeze({
  EMPTY: 'REPORT_DRAFT_EMPTY',
  TOO_LARGE: 'REPORT_DRAFT_TOO_LARGE',
  NOT_JSON: 'REPORT_DRAFT_NOT_JSON',
  SCHEMA: 'REPORT_DRAFT_SCHEMA_INVALID',
  CONTRACT: 'REPORT_DRAFT_CONTRACT_UNSUPPORTED',
  SECTION: 'REPORT_DRAFT_SECTION_INVALID',
  REFERENCE: 'REPORT_DRAFT_REFERENCE_INVALID',
  CLAIM: 'REPORT_DRAFT_CLAIM_INVALID',
  TEXT: 'REPORT_DRAFT_TEXT_INVALID'
});

const CLAIM_CLASSES = new Set(['nesnel_olgu', 'desteklenen_yorum', 'editoryal_dil', 'desteksiz_maddi_iddia']);
const ROOT_KEYS = new Set(['sozlesme', 'bolumler', 'iddialar']);
const SECTION_KEYS = new Set(['kimlik', 'paragraflar', 'one_cikan_tespit']);
const PARAGRAPH_KEYS = new Set(['metin', 'kanitlar']);
const CLAIM_KEYS = new Set(['bolum', 'paragraf', 'alinti', 'sinif', 'kanitlar']);
const KNOWN_SCHEMA_KEYS = new Set([...ROOT_KEYS, ...SECTION_KEYS, ...PARAGRAPH_KEYS, ...CLAIM_KEYS]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Paket sözleşmesi (`reportRequest.js`) ile aynı kanıt kimliği dilbilgisi; üyelik denetimi `known.has(ref)` ile kapalıdır.
const REF_PATTERN = /^[EF][1-9]\d{0,14}$/u;
// Paragraf içinde yalnızca yazdırılabilir metin; satır sonu dışındaki C0/C1 denetim karakterleri (U+0085 dâhil),
// Unicode çift yönlü metin denetimleri (`Bidi_Control`, U+200F dâhil), görünmez biçim karakterleri ve etiket bloğu reddedilir.
// eslint-disable-next-line no-control-regex -- güvenilmez model metnindeki denetim karakterleri bilinçli olarak eşleştirilir
const FORBIDDEN_TEXT_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF\u{E0000}-\u{E007F}\p{Bidi_Control}]/u;
// Görünür/çizilebilir en az bir temel karakter gerektirir (boşluk, sıfır genişlikli, birleşen işaret ve boş Braille U+2800 kabul edilmez).
const RENDERABLE_CHAR = /[^\s\p{C}\p{M}\u2800]/u;
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu;
const HIGHLIGHT_CLAIM_LOCATION = 'one_cikan_tespit';

/** Taslak doğrulama hatası: kararlı kod, yol ve sabit neden taşır; model metnini ya da anahtar adını yansıtmaz. */
export class ReportDraftError extends Error {
  constructor(code, path = null, reason = null) {
    super('Yazar çıktısı yönetici raporu taslak sözleşmesine uymuyor.');
    this.name = 'ReportDraftError';
    this.code = code;
    this.path = path;
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function closedObject(value, allowed, path) {
  if (!isPlainObject(value)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, path);
  for (const key of Object.keys(value)) {
    // Modelin ürettiği beklenmeyen alan adı hata yoluna kopyalanmaz; yalnızca kapsayan yol ve sabit neden döndürülür.
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, path, 'unexpected_field');
    }
  }
}

/**
 * Geçerli RFC 8259 JSON metninde herhangi bir nesne düzeyinde yinelenen üye adını (kaçışlı yazımlar dâhil)
 * kapalı şema denetiminden önce reddeder.
 */
function assertNoDuplicateJsonKeys(source) {
  let pos = 0;
  const len = source.length;
  const skipWs = () => {
    while (pos < len && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n' || source[pos] === '\r')) pos += 1;
  };
  const readString = () => {
    const start = pos;
    pos += 1; // açılış tırnağı
    while (pos < len) {
      const ch = source[pos];
      if (ch === '\\') {
        pos += 2;
      } else if (ch === '"') {
        pos += 1;
        return JSON.parse(source.slice(start, pos));
      } else {
        pos += 1;
      }
    }
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.NOT_JSON);
  };
  const MAX_JSON_DEPTH = 64;
  const scanValue = (path, depth = 0) => {
    if (depth > MAX_JSON_DEPTH) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, path, 'max_depth');
    }
    skipWs();
    if (pos >= len) return;
    const ch = source[pos];
    if (ch === '{') {
      pos += 1;
      skipWs();
      const seenKeys = new Set();
      if (source[pos] === '}') {
        pos += 1;
        return;
      }
      while (pos < len) {
        skipWs();
        const key = readString();
        if (seenKeys.has(key)) {
          throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, path, 'duplicate_field');
        }
        seenKeys.add(key);
        skipWs();
        if (source[pos] === ':') pos += 1;
        // Hata yoluna yalnızca şemada bilinen alan adları eklenir; modelin ürettiği yabancı anahtar adı sızmaz.
        const childPath = KNOWN_SCHEMA_KEYS.has(key) ? `${path}.${key}` : path;
        scanValue(childPath, depth + 1);
        skipWs();
        if (source[pos] === ',') {
          pos += 1;
          continue;
        }
        if (source[pos] === '}') {
          pos += 1;
          return;
        }
        return;
      }
      return;
    }
    if (ch === '[') {
      pos += 1;
      skipWs();
      if (source[pos] === ']') {
        pos += 1;
        return;
      }
      let index = 0;
      while (pos < len) {
        scanValue(`${path}[${index}]`, depth + 1);
        index += 1;
        skipWs();
        if (source[pos] === ',') {
          pos += 1;
          continue;
        }
        if (source[pos] === ']') {
          pos += 1;
          return;
        }
        return;
      }
      return;
    }
    if (ch === '"') {
      readString();
      return;
    }
    // Sayı, mantıksal değer ya da null belirteci.
    while (pos < len && !' \t\n\r,}]'.includes(source[pos])) pos += 1;
  };
  scanValue('$', 0);
}

function requireText(value, maxChars, path) {
  if (typeof value !== 'string') throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
  if (!value.isWellFormed()) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
  if (!value.trim() || !RENDERABLE_CHAR.test(value)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
  if (Array.from(value).length > maxChars) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TOO_LARGE, path);
  if (FORBIDDEN_TEXT_CHARS.test(value)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
  return value;
}

function requireRefs(value, known, path, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > REPORT_DRAFT_LIMITS.maxRefsPerParagraph) {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.REFERENCE, path);
  }
  if (!allowEmpty && value.length === 0) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.REFERENCE, path);
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.REFERENCE, path);
    const ref = value[index];
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || !known.has(ref)) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.REFERENCE, `${path}[${index}]`);
    }
    // Yinelenen gönderge anlamı değiştirmez; yalnızca tekilleştirilir (düzyazı değişmez).
    if (!out.includes(ref)) out.push(ref);
  }
  return Object.freeze(out);
}

/** Model yanıtından JSON gövdesini çıkarır: düz JSON ya da tek bir kod çiti sarmalı; başka metin kabul edilmez. */
function jsonBody(raw) {
  const trimmed = raw.replace(/^\uFEFF/u, '').trim();
  const fenced = FENCE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeForQuote(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('tr-TR');
}

/** Düzyazıdaki dikkat gerektiren biçim kusurları; yapısal hata değildir, editoryal değerlendirmeye uyarı olarak gider. */
function styleWarnings(text, path) {
  const warnings = [];
  if (/(^|\r\n|\r|\n)\s*(?:[-*•]|\d+[.)])\s+/u.test(text)) warnings.push({ kod: 'madde_isareti', yol: path });
  if (/(^|\r\n|\r|\n)\s*#{1,6}\s/u.test(text) || /\*\*[^*]+\*\*/u.test(text)) warnings.push({ kod: 'markdown', yol: path });
  if (/\b[EF][1-9]\d*\b/u.test(text)) warnings.push({ kod: 'duzyazida_kanit_kimligi', yol: path });
  if (/\b\d{4}-\d{2}-\d{2}\b/u.test(text)) warnings.push({ kod: 'iso_tarih', yol: path });
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(text)) warnings.push({ kod: 'ic_tanimlayici', yol: path });
  if (/[\r\n\u2028\u2029]/u.test(text)) warnings.push({ kod: 'paragraf_ici_satir_sonu', yol: path });
  return warnings;
}

/**
 * Yazar yanıtını doğrular ve dondurulmuş taslağa çevirir.
 *
 * @param {string} rawText - Modelin değiştirilmemiş yanıt metni.
 * @param {{ plan: object, evidencePackage: object }} context - Bölüm planı ve aynı kanıt paketi.
 * @returns {{ sozlesme: string, bolumler: object[], iddialar: object[], uyarilar: object[] }} Doğrulanmış taslak.
 */
export function parseReportDraft(rawText, { plan, evidencePackage }) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.EMPTY);
  if (rawText.length > REPORT_DRAFT_LIMITS.maxRawChars) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TOO_LARGE);
  if (plan?.sozlesme !== REPORT_WRITING_CONTRACT || !Array.isArray(plan.bolumler)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, 'plan');
  const body = jsonBody(rawText);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.NOT_JSON);
  }
  assertNoDuplicateJsonKeys(body);
  closedObject(parsed, ROOT_KEYS, '$');
  if (parsed.sozlesme !== REPORT_WRITING_CONTRACT) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CONTRACT, '$.sozlesme');

  const known = new Set([
    ...(Array.isArray(evidencePackage?.kanitlar) ? evidencePackage.kanitlar : []).map((item) => item?.id),
    ...(Array.isArray(evidencePackage?.turetilmis) ? evidencePackage.turetilmis : []).map((item) => item?.id)
  ].filter((id) => typeof id === 'string'));
  if (!known.size) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, 'kanit_paketi');

  const planned = new Map(plan.bolumler.map((section, index) => [section.kimlik, { section, index }]));
  if (!Array.isArray(parsed.bolumler) || parsed.bolumler.length === 0 || parsed.bolumler.length > REPORT_DRAFT_LIMITS.maxSections) {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, '$.bolumler');
  }
  const warnings = [];
  const seen = new Set();
  const sections = [];
  parsed.bolumler.forEach((section, sectionIndex) => {
    const path = `$.bolumler[${sectionIndex}]`;
    closedObject(section, SECTION_KEYS, path);
    if (typeof section.kimlik !== 'string' || !planned.has(section.kimlik)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `${path}.kimlik`);
    if (seen.has(section.kimlik)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `${path}.kimlik`);
    seen.add(section.kimlik);
    const { section: planSection, index: planIndex } = planned.get(section.kimlik);
    if (!Array.isArray(section.paragraflar) || section.paragraflar.length === 0
      || section.paragraflar.length > REPORT_DRAFT_LIMITS.maxParagraphsPerSection) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `${path}.paragraflar`);
    }
    if (Array.isArray(planSection.paragraf_araligi) && planSection.paragraf_araligi.length === 2
      && (section.paragraflar.length < planSection.paragraf_araligi[0] || section.paragraflar.length > planSection.paragraf_araligi[1])) {
      warnings.push({ kod: 'paragraf_sayisi_plan_disi', yol: section.kimlik });
    }
    const paragraphs = section.paragraflar.map((paragraph, paragraphIndex) => {
      const ppath = `${path}.paragraflar[${paragraphIndex}]`;
      closedObject(paragraph, PARAGRAPH_KEYS, ppath);
      const metin = requireText(paragraph.metin, REPORT_DRAFT_LIMITS.maxParagraphChars, `${ppath}.metin`);
      warnings.push(...styleWarnings(metin, `${section.kimlik}#${paragraphIndex + 1}`));
      return Object.freeze({ metin, kanitlar: requireRefs(paragraph.kanitlar, known, `${ppath}.kanitlar`) });
    });
    let highlight = null;
    if (Object.hasOwn(section, 'one_cikan_tespit') && section.one_cikan_tespit !== undefined) {
      if (!planSection.one_cikan_tespit) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `${path}.one_cikan_tespit`);
      if (section.one_cikan_tespit === null) {
        // JSON isteğe bağlı yokluğu sıkça `null` olarak ifade eder; izinli bölümde yok sayılır ve uyarı kaydedilir.
        warnings.push({ kod: 'one_cikan_tespit_bos', yol: section.kimlik });
      } else {
        closedObject(section.one_cikan_tespit, PARAGRAPH_KEYS, `${path}.one_cikan_tespit`);
        const highlightText = requireText(section.one_cikan_tespit.metin, REPORT_DRAFT_LIMITS.maxHighlightChars, `${path}.one_cikan_tespit.metin`);
        warnings.push(...styleWarnings(highlightText, `${section.kimlik}#${HIGHLIGHT_CLAIM_LOCATION}`));
        highlight = Object.freeze({
          metin: highlightText,
          kanitlar: requireRefs(section.one_cikan_tespit.kanitlar, known, `${path}.one_cikan_tespit.kanitlar`, { allowEmpty: false })
        });
      }
    }
    sections.push({ planIndex, value: Object.freeze({ kimlik: section.kimlik, baslik: planSection.baslik, paragraflar: Object.freeze(paragraphs), one_cikan_tespit: highlight }) });
  });
  for (const section of plan.bolumler) {
    if (section.zorunlu && !seen.has(section.kimlik)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `eksik:${section.kimlik}`);
    if (!section.zorunlu && !seen.has(section.kimlik)) warnings.push({ kod: 'istege_bagli_bolum_yazilmadi', yol: section.kimlik });
  }
  if (sections.some((entry, index) => index > 0 && entry.planIndex < sections[index - 1].planIndex)) {
    warnings.push({ kod: 'bolum_sirasi_duzeltildi', yol: '$.bolumler' });
  }
  // Bölümler kanonik plan sırasına dizilir; düzyazı değişmez.
  const ordered = sections.sort((a, b) => a.planIndex - b.planIndex).map((entry) => entry.value);

  // Kapanış istemiyle uyumlu olarak iddia eki zorunludur ve boş bırakılamaz.
  if (!Array.isArray(parsed.iddialar) || parsed.iddialar.length === 0 || parsed.iddialar.length > REPORT_DRAFT_LIMITS.maxClaims) {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, '$.iddialar');
  }
  const bySection = new Map(ordered.map((section) => [section.kimlik, section]));
  const claims = parsed.iddialar.map((claim, claimIndex) => {
    const path = `$.iddialar[${claimIndex}]`;
    closedObject(claim, CLAIM_KEYS, path);
    const section = typeof claim.bolum === 'string' ? bySection.get(claim.bolum) : null;
    if (!section) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.bolum`);
    const isHighlightClaim = claim.paragraf === HIGHLIGHT_CLAIM_LOCATION;
    if (isHighlightClaim) {
      if (!section.one_cikan_tespit) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.paragraf`);
    } else if (!Number.isSafeInteger(claim.paragraf) || claim.paragraf < 1 || claim.paragraf > section.paragraflar.length) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.paragraf`);
    }
    if (typeof claim.sinif !== 'string' || !CLAIM_CLASSES.has(claim.sinif)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.sinif`);
    const alinti = requireText(claim.alinti, REPORT_DRAFT_LIMITS.maxQuoteChars, `${path}.alinti`);
    const kanitlar = requireRefs(claim.kanitlar, known, `${path}.kanitlar`);
    const targetBlock = isHighlightClaim ? section.one_cikan_tespit : section.paragraflar[claim.paragraf - 1];
    const targetRefs = new Set(targetBlock.kanitlar);
    // İddianın dayandığı her kanıt göndergesi, ait olduğu paragrafın veya öne çıkan tespitin `kanitlar` listesinde de bulunmalıdır.
    if (kanitlar.some((ref) => !targetRefs.has(ref))) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.kanitlar`, 'claim_ref_not_in_paragraph');
    }
    const targetText = targetBlock.metin;
    const warningPath = `${claim.bolum}#${claim.paragraf}`;
    const verbatimFound = targetText.includes(alinti);
    const normalizedFound = !verbatimFound && normalizeForQuote(targetText).includes(normalizeForQuote(alinti));
    if (!verbatimFound) {
      warnings.push({ kod: normalizedFound ? 'iddia_alintisi_birebir_degil' : 'iddia_alintisi_paragrafta_yok', yol: warningPath });
    }
    if (claim.sinif === 'desteksiz_maddi_iddia') warnings.push({ kod: 'yazar_desteksiz_iddia_beyan_etti', yol: warningPath });
    if (claim.sinif === 'nesnel_olgu' && kanitlar.length === 0) warnings.push({ kod: 'nesnel_iddia_kanitsiz', yol: warningPath });
    return Object.freeze({
      bolum: claim.bolum,
      paragraf: claim.paragraf,
      alinti,
      sinif: claim.sinif,
      kanitlar,
      alinti_bulundu: verbatimFound,
      alinti_normal_eslesti: normalizedFound
    });
  });

  return Object.freeze({
    sozlesme: REPORT_WRITING_CONTRACT,
    bolumler: Object.freeze(ordered),
    // Yazar beyanı: doğrulanmış olgu listesi değildir.
    iddialar: Object.freeze(claims),
    uyarilar: Object.freeze(warnings.map((entry) => Object.freeze(entry)))
  });
}

/** Taslağı okunur düz metne çevirir (geliştirici önizlemesi); model paragraflarının sonundaki boşluklar dâhil metin aynen korunur. */
export function renderReportDraftText(draft) {
  const lines = [];
  for (const section of draft?.bolumler || []) {
    lines.push(section.baslik, '');
    if (section.one_cikan_tespit) lines.push(`Öne Çıkan Tespit: ${section.one_cikan_tespit.metin}`, '');
    for (const paragraph of section.paragraflar) lines.push(paragraph.metin, '');
  }
  if (lines.length && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}
