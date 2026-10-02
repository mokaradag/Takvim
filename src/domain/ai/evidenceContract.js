/**
 * Rota AI kanıt sözleşmesi — sunucu ile tarayıcının ORTAK, saf kuralları.
 *
 * Rota verisine dayanan her yanıt, aynı turda yetkili alan araçlarının ürettiği
 * kanıtlara (`R1`, `R2` …) atıf yapar. Atıf biçimi `【R1】`dir: Markdown
 * bağlantı sözdizimiyle (`[…](…)`) çakışmaz ve tarayıcıdaki çözücü onu küçük bir
 * kaynak işaretine çevirir.
 *
 * Doğrulama BELİRLENİMCİDİR; ikinci bir dil modeline sorulmaz:
 *  - her atıf bu turda üretilmiş bir kanıta işaret etmelidir;
 *  - olgular kayıt ve alan kimliğine bağlı yapılandırılmış iddialarla doğrulanır;
 *  - olgu metnini sunucu üretir; serbest model metni kanıt sayılmaz;
 *  - araç kullanılmadan üretilen (genel) yanıt hiçbir kanıt işareti taşıyamaz.
 */

export const EVIDENCE_LIMITS = Object.freeze({
  /** Bir yanıtın dayanabileceği en fazla kanıt (turdaki en fazla araç çağrısı). */
  maxEvidencePerAnswer: 12,
  /** Kalıcı kayıttaki en büyük kanıt sıra numarası (veritabanı kısıtıyla aynı). */
  maxEvidenceOrdinal: 16,
  maxLabelChars: 120,
  maxEntityNameChars: 160,
  maxHighlights: 6,
  maxHighlightChars: 80
});

export const EVIDENCE_KINDS = Object.freeze({
  'task-list': 'Görev listesi',
  'task-detail': 'Görev ayrıntısı',
  'task-analytics': 'Görev özeti',
  'project-list': 'Proje araması',
  'project-detail': 'Proje bilgisi',
  portfolio: 'Portföy özeti',
  wbs: 'İş dağılım yapısı',
  workload: 'İş yükü dağılımı',
  people: 'Personel araması',
  activity: 'Hareket geçmişi',
  'schedule-requests': 'Tarih değişikliği talepleri',
  'assignment-requests': 'Atama koordinasyonu',
  notifications: 'Bildirimler',
  baseline: 'Baz plan karşılaştırması',
  dependencies: 'Bağımlılık ilişkileri',
  recurrence: 'Tekrar serisi',
  calendar: 'Çalışma takvimi',
  outlook: 'Outlook teslim durumu',
  'data-quality': 'Plan veri kalitesi'
});

const ENTITY_TYPES = new Set(['task', 'project', 'person', 'portfolio', 'user']);

/** Kanıta dayanan yanıt doğrulanamadığında gösterilen ve kaydedilen SABİT metin. */
export const GROUNDING_FAILURE_TEXT = 'Rota verilerine ilişkin yanıt doğrulanamadı. Soruyu daha dar kapsamda yeniden deneyin.';

/** Kısmi kapsamlı kanıta dayanan her yanıta sunucunun eklediği not. */
export const SCOPE_DISCLOSURE_TEXT = '_Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._';

/** Yanıtın doğrulanamadığını söyleyen bitiş nedeni (kalıcı iletide saklanır). */
export function replyLocale(text) {
  const source = String(text || '');
  if (/(?:in English|İngilizce|English please)/iu.test(source)) return 'en';
  if (/(?:in Turkish|Türkçe)/iu.test(source)) return 'tr';
  if (/(?:^|[^\p{L}])(?:görev|kaç|termin|sorumlu|toplam|saat|bugün|yarın|gecikmiş|bunu|peki)\p{L}*/iu.test(source)) return 'tr';
  if (/\b(?:the|what|how|show|find|list|task|project|today|tomorrow|hours|total|status|please|English)\b/i.test(source)) return 'en';
  return 'tr';
}

export function groundingFailureText(locale = 'tr') {
  return locale === 'en' ? 'The answer about Rota data could not be verified. Please try a narrower question.' : GROUNDING_FAILURE_TEXT;
}

export const GROUNDING_FAILED_FINISH_REASON = 'grounding_failed';

const CITATION = /【R([1-9]\d?)】/g;
const EVIDENCE_BRACKETED = /【\s*R[1-9]\d?(?:\s*[,;]\s*R[1-9]\d?)*\s*】/g;
const EVIDENCE_ID = /^R([1-9]\d?)$/;

export function evidenceIdFor(ordinal) {
  return `R${ordinal}`;
}

export function evidenceOrdinal(id) {
  const match = EVIDENCE_ID.exec(String(id ?? ''));
  const ordinal = match ? Number(match[1]) : NaN;
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= EVIDENCE_LIMITS.maxEvidenceOrdinal ? ordinal : null;
}

export function isEvidenceId(value) {
  return evidenceOrdinal(value) != null;
}

export function citationToken(id) {
  return `【${id}】`;
}

/**
 * Modelin atıf yazımındaki küçük farkları kanonik biçime getirir: `[R1]`,
 * `【 R1 】`, `【R1, R2】`. Bu, sözdizimi düzeltmesidir; hiçbir atıf
 * uydurulmaz ya da silinmez. Markdown bağlantısı (`[R1](…)`) dokunulmadan kalır.
 */
export function normalizeCitations(text) {
  return String(text ?? '')
    .replace(/\[\s*R([1-9]\d?)\s*\](?=\s*\[\s*R[1-9]\d?\s*\])/g, '【R$1】')
    .replace(/(^|[^!\\[])\[\s*R([1-9]\d?)\s*\](?![([])/g, '$1【R$2】')
    .replace(/【\s*(R[1-9]\d?(?:\s*[,;]\s*R[1-9]\d?)+)\s*】/g, (_, list) => list.split(/\s*[,;]\s*/).map((id) => citationToken(id)).join(''))
    .replace(/【\s*R([1-9]\d?)\s*】/g, '【R$1】');
}

/** Metindeki atıflar, ilk geçiş sırasıyla ve tekil. */
export function extractCitationIds(text) {
  const ids = [];
  for (const match of String(text ?? '').matchAll(CITATION)) {
    const id = `R${match[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Atıf işaretlerini kaldırır (ör. geçmiş yanıt modele bağlam olarak verilirken). */
export function stripCitations(text) {
  return String(text ?? '').replace(EVIDENCE_BRACKETED, '').replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]+$/gm, '');
}

/* ── Blok çözümleme ─────────────────────────────────────────── */

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s/;
const TABLE_ROW = /^\s{0,3}\|/;

function segmentKind(lines) {
  const first = lines[0];
  if (FENCE.test(first)) return 'code';
  if (HEADING.test(first)) return 'heading';
  if (lines.every((line) => TABLE_ROW.test(line))) return 'table';
  if (LIST_ITEM.test(first)) return 'list';
  return 'paragraph';
}

/**
 * Yanıtı görsel bloklara ayırır: boş satırlar blok sınırıdır, başlık satırı her
 * zaman kendi bloğudur, çitli kod bloğu bütün olarak tek bloktur.
 */
export function answerSegments(text) {
  const segments = [];
  let current = [];
  let fenced = false;
  const flush = () => {
    if (current.length) segments.push({ kind: segmentKind(current), text: current.join('\n') });
    current = [];
  };
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) {
      if (!fenced) flush();
      current.push(line);
      fenced = !fenced;
      if (!fenced) flush();
      continue;
    }
    if (fenced) {
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      current.push(line);
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return segments;
}

export { requiresRotaEvidence } from './evidenceIntent.js';
export { analyzeGroundedAnswer } from './evidenceVerification.js';

export function analyzeDirectAnswer(text, { evidenceRequired = false } = {}) {
  const answer = String(text ?? '');
  const issues = [];
  if (!answer.trim()) issues.push({ code: 'EMPTY_ANSWER' });
  if (evidenceRequired) issues.push({ code: 'ROTA_EVIDENCE_REQUIRED' });
  if (containsCitationMarker(answer)) issues.push({ code: 'CITATION_WITHOUT_EVIDENCE' });
  return { ok: issues.length === 0, citedIds: [], issues };
}

export const NON_ENUMERATING_FAILURE_TEXT = 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.';

export function analyzeUngroundedAnswer(text, { allowNotFound = true } = {}) {
  const value = String(text ?? '').trim();
  const unavailable = [GROUNDING_FAILURE_TEXT, groundingFailureText('en')];
  const notFound = [NON_ENUMERATING_FAILURE_TEXT, 'The record was not found or you are not authorized to view it.'];
  const safe = allowNotFound ? [...notFound, ...unavailable] : unavailable;
  const issues = safe.includes(value) ? [] : [{ code: 'ROTA_EVIDENCE_REQUIRED' }];
  return { ok: issues.length === 0, citedIds: [], issues };
}

export function containsCitationMarker(text) {
  return /【|\[\s*R\d+/i.test(String(text ?? ''));
}

export function withScopeDisclosure(text, citedEvidence = [], locale = replyLocale(text)) {
  const notes = [];
  if (citedEvidence.some((item) => item?.partial === true)) notes.push(locale === 'en'
    ? '_Note: This answer covers only records you are authorized to view and may not reflect the entire projects._'
    : SCOPE_DISCLOSURE_TEXT);
  if (citedEvidence.some((item) => item?.complete === false || item?.truncated === true)) notes.push(locale === 'en'
    ? '_Note: Some records or details were omitted; this evidence is incomplete._'
    : '_Not: Bazı kayıtlar veya ayrıntılar sonuçta yer almıyor; bu kanıt eksiktir._');
  return { text: notes.length ? `${String(text).trimEnd()}\n\n${notes.join('\n\n')}` : text, disclosed: notes.length > 0 };
}

export function groundingRepairInstruction(issues = []) {
  const codes = [...new Set(issues.map((issue) => issue?.code).filter(Boolean))].slice(0, 6);
  return [
    'SUNUCU DOĞRULAMASI: Önceki taslak kullanıcıya gösterilmedi.',
    `Sözleşme hataları: ${codes.join(', ')}`,
    'Güncel Rota verisi gerekiyorsa uygun aracı çağır. Kanıt varsa yalnızca yapılandırılmış yanıt üret:',
    '{"kind":"rota","claims":[{"evidenceId":"R1","factId":"araçtaki kimlik","subjectId":"araçtaki kimlik","field":"araçtaki alan","operator":"eq","value":"araçtaki türü korunmuş değer"}]}',
    'Genel niyet önerisi {"kind":"general","text":"yanıt"} olabilir; veri kipinde sunucu yalnızca Genel sohbet seçimi açıklamasını gösterir. Serbest olgu metni, başlık veya ek alan yazma. Kanıt alınamadıysa {"kind":"unavailable"} yaz.'
  ].join('\n');
}

/* ── Kanıt özeti (tarayıcıya giden ve kalıcı künye) ─────────── */

function clipText(value, max) {
  // Yalnızca metin (ve sonlu sayı) kabul edilir; nesne "[object Object]" olarak görünmez.
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Kanıt özetini doğrular ve güvenli biçime indirir; biçim uymuyorsa `null`.
 * Özet araç adı, SQL, yetki ayrıntısı ya da kayıt içeriği taşımaz: yalnızca
 * türü, etiketi, veri zamanını, kapsam/kısaltma bayraklarını, sayıları ve en
 * fazla altı kısa öne çıkan değeri.
 */
export function normalizeEvidenceSummary(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isEvidenceId(value.id) || !Object.hasOwn(EVIDENCE_KINDS, String(value.kind ?? ''))) return null;
  if (!isTimestamp(value.generatedAt)) return null;
  const entity = value.entity && typeof value.entity === 'object' && ENTITY_TYPES.has(value.entity.type)
    ? {
      type: value.entity.type,
      id: typeof value.entity.id === 'string' && value.entity.id.length <= 64 ? value.entity.id : null,
      name: clipText(value.entity.name, EVIDENCE_LIMITS.maxEntityNameChars)
    }
    : null;
  const counts = value.counts && typeof value.counts === 'object'
    ? { returned: nonNegativeInteger(value.counts.returned), total: nonNegativeInteger(value.counts.total) }
    : { returned: null, total: null };
  const highlights = Array.isArray(value.highlights)
    ? value.highlights
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ label: clipText(item.label, EVIDENCE_LIMITS.maxHighlightChars), value: clipText(item.value, EVIDENCE_LIMITS.maxHighlightChars) }))
      .filter((item) => item.label && item.value)
      .slice(0, EVIDENCE_LIMITS.maxHighlights)
    : [];
  return {
    id: value.id,
    kind: value.kind,
    label: clipText(value.label, EVIDENCE_LIMITS.maxLabelChars) || EVIDENCE_KINDS[value.kind],
    entity,
    generatedAt: value.generatedAt,
    complete: value.complete === true,
    truncated: value.truncated === true,
    partial: value.partial === true,
    counts,
    highlights
  };
}

/** Kanıt listesi: yalnızca geçerli özetler, kimliğe göre tekil ve sıra numarasına göre dizili. */
export function normalizeEvidenceList(values) {
  if (!Array.isArray(values)) return [];
  const byId = new Map();
  for (const value of values.slice(0, EVIDENCE_LIMITS.maxEvidenceOrdinal)) {
    const summary = normalizeEvidenceSummary(value);
    if (summary && !byId.has(summary.id)) byId.set(summary.id, summary);
  }
  return [...byId.values()].sort((left, right) => evidenceOrdinal(left.id) - evidenceOrdinal(right.id));
}
