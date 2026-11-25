import { REPORT_WRITING_CONTRACT } from './reportSectionPlan.js';

/**
 * Bilgin Aşama 4I-B — yazar çıktısının yapısal ve göndergesel doğrulaması (`4i-yazim-1`, saf).
 *
 * Model yanıtı güvenilmez girdidir. Ayrıştırıcı:
 *   - yalnızca tek JSON nesnesini (en çok bir kod çiti sarmalıyla) kabul eder; metinden JSON "kazımaz";
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
  maxParagraphsPerSection: 14,
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
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REF_PATTERN = /^[EF][1-9]\d{0,4}$/u;
// Paragraf içinde yalnızca yazdırılabilir metin; satır sonu dışındaki denetim karakterleri ve çift yönlü metin
// denetimleri (görünmez yeniden sıralama) reddedilir.
// eslint-disable-next-line no-control-regex -- güvenilmez model metnindeki denetim karakterleri bilinçli olarak eşleştirilir
const FORBIDDEN_TEXT_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u;
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/u;

/** Taslak doğrulama hatası: kararlı kod ve yol taşır, model metnini yansıtmaz. */
export class ReportDraftError extends Error {
  constructor(code, path = null) {
    super('Yazar çıktısı yönetici raporu taslak sözleşmesine uymuyor.');
    this.name = 'ReportDraftError';
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function closedObject(value, allowed, path) {
  if (!isPlainObject(value)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, path);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SCHEMA, `${path}.${key}`);
  }
}

function requireText(value, maxChars, path) {
  if (typeof value !== 'string') throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
  if (!value.trim()) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.TEXT, path);
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
  const trimmed = raw.trim();
  const fenced = FENCE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeForQuote(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('tr-TR');
}

/** Düzyazıdaki dikkat gerektiren biçim kusurları; yapısal hata değildir, editoryal değerlendirmeye uyarı olarak gider. */
function styleWarnings(text, path) {
  const warnings = [];
  if (/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/u.test(text)) warnings.push({ kod: 'madde_isareti', yol: path });
  if (/(^|\n)\s*#{1,6}\s/u.test(text) || /\*\*[^*]+\*\*/u.test(text)) warnings.push({ kod: 'markdown', yol: path });
  if (/\b[EF][1-9]\d*\b/u.test(text)) warnings.push({ kod: 'duzyazida_kanit_kimligi', yol: path });
  if (/\b\d{4}-\d{2}-\d{2}\b/u.test(text)) warnings.push({ kod: 'iso_tarih', yol: path });
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(text)) warnings.push({ kod: 'ic_tanimlayici', yol: path });
  if (/\n/u.test(text)) warnings.push({ kod: 'paragraf_ici_satir_sonu', yol: path });
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
  let parsed;
  try {
    parsed = JSON.parse(jsonBody(rawText));
  } catch {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.NOT_JSON);
  }
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
    const paragraphs = section.paragraflar.map((paragraph, paragraphIndex) => {
      const ppath = `${path}.paragraflar[${paragraphIndex}]`;
      closedObject(paragraph, PARAGRAPH_KEYS, ppath);
      const metin = requireText(paragraph.metin, REPORT_DRAFT_LIMITS.maxParagraphChars, `${ppath}.metin`);
      warnings.push(...styleWarnings(metin, `${section.kimlik}#${paragraphIndex + 1}`));
      return Object.freeze({ metin, kanitlar: requireRefs(paragraph.kanitlar, known, `${ppath}.kanitlar`) });
    });
    let highlight = null;
    if (section.one_cikan_tespit !== undefined && section.one_cikan_tespit !== null) {
      if (!planSection.one_cikan_tespit) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.SECTION, `${path}.one_cikan_tespit`);
      closedObject(section.one_cikan_tespit, PARAGRAPH_KEYS, `${path}.one_cikan_tespit`);
      highlight = Object.freeze({
        metin: requireText(section.one_cikan_tespit.metin, REPORT_DRAFT_LIMITS.maxHighlightChars, `${path}.one_cikan_tespit.metin`),
        kanitlar: requireRefs(section.one_cikan_tespit.kanitlar, known, `${path}.one_cikan_tespit.kanitlar`)
      });
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

  if (!Array.isArray(parsed.iddialar) || parsed.iddialar.length > REPORT_DRAFT_LIMITS.maxClaims) {
    throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, '$.iddialar');
  }
  const bySection = new Map(ordered.map((section) => [section.kimlik, section]));
  const claims = parsed.iddialar.map((claim, claimIndex) => {
    const path = `$.iddialar[${claimIndex}]`;
    closedObject(claim, CLAIM_KEYS, path);
    const section = typeof claim.bolum === 'string' ? bySection.get(claim.bolum) : null;
    if (!section) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.bolum`);
    if (!Number.isSafeInteger(claim.paragraf) || claim.paragraf < 1 || claim.paragraf > section.paragraflar.length) {
      throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.paragraf`);
    }
    if (typeof claim.sinif !== 'string' || !CLAIM_CLASSES.has(claim.sinif)) throw new ReportDraftError(REPORT_DRAFT_ERROR_CODES.CLAIM, `${path}.sinif`);
    const alinti = requireText(claim.alinti, REPORT_DRAFT_LIMITS.maxQuoteChars, `${path}.alinti`);
    const kanitlar = requireRefs(claim.kanitlar, known, `${path}.kanitlar`);
    const paragraphText = section.paragraflar[claim.paragraf - 1].metin;
    const quoteFound = normalizeForQuote(paragraphText).includes(normalizeForQuote(alinti));
    if (!quoteFound) warnings.push({ kod: 'iddia_alintisi_paragrafta_yok', yol: `${claim.bolum}#${claim.paragraf}` });
    if (claim.sinif === 'desteksiz_maddi_iddia') warnings.push({ kod: 'yazar_desteksiz_iddia_beyan_etti', yol: `${claim.bolum}#${claim.paragraf}` });
    if (claim.sinif === 'nesnel_olgu' && kanitlar.length === 0) warnings.push({ kod: 'nesnel_iddia_kanitsiz', yol: `${claim.bolum}#${claim.paragraf}` });
    return Object.freeze({ bolum: claim.bolum, paragraf: claim.paragraf, alinti, sinif: claim.sinif, kanitlar, alinti_bulundu: quoteFound });
  });

  return Object.freeze({
    sozlesme: REPORT_WRITING_CONTRACT,
    bolumler: Object.freeze(ordered),
    // Yazar beyanı: doğrulanmış olgu listesi değildir.
    iddialar: Object.freeze(claims),
    uyarilar: Object.freeze(warnings.map((entry) => Object.freeze(entry)))
  });
}

/** Taslağı okunur düz metne çevirir (geliştirici önizlemesi); model paragrafları aynen yazılır. */
export function renderReportDraftText(draft) {
  const lines = [];
  for (const section of draft?.bolumler || []) {
    lines.push(section.baslik, '');
    if (section.one_cikan_tespit) lines.push(`Öne Çıkan Tespit: ${section.one_cikan_tespit.metin}`, '');
    for (const paragraph of section.paragraflar) lines.push(paragraph.metin, '');
  }
  return lines.join('\n').trimEnd();
}
