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
 *  - kanıt varken yanıt en az bir geçerli atıf taşımalıdır;
 *  - kanıta dayanan her paragraf kendi içinde geçerli bir atıf taşımalıdır;
 *    liste/tablo/başlık/kod gibi yapısal bloklarda hemen komşu atıf da geçerlidir;
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

/** Kısmi kapsamlı kanıta dayanıp kapsamı belirtmeyen yanıta sunucunun eklediği not. */
export const SCOPE_DISCLOSURE_TEXT = '_Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._';

/** Yanıtın doğrulanamadığını söyleyen bitiş nedeni (kalıcı iletide saklanır). */
export const GROUNDING_FAILED_FINISH_REASON = 'grounding_failed';

const CITATION = /【R([1-9]\d?)】/g;
const EVIDENCE_BRACKETED = /【\s*R[1-9]\d?(?:\s*[,;]\s*R[1-9]\d?)*\s*】/g;
const ANY_BRACKETED = /【[^】\n]{0,24}】/g;
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

/** Blokta atfı gerektiren bir sayı var mı? Liste/başlık numarası ve atıfın kendisi sayılmaz. */
export function segmentHasNumericClaim(segment) {
  const text = segment.text
    .replace(ANY_BRACKETED, ' ')
    .split('\n')
    .map((line) => line
      .replace(/^\s{0,3}\d{1,3}[.)]\s/, '')
      .replace(/^\s{0,3}#{1,6}\s+\d{1,3}(?:\.\d{1,3})*[.)]?\s/, '')
      .replace(/^\s{0,3}\|?[\s:|-]*-[\s:|-]*$/, ''))
    .join('\n');
  return /\d/.test(text);
}

function validCitationsIn(text, evidenceIds) {
  return extractCitationIds(text).filter((id) => evidenceIds.has(id));
}

const ROTA_DATA_TERMS = [
  'görev', 'proje', 'portföy', 'wbs', 'iş dağılım', 'sorumlu', 'atama', 'bildirim',
  'baz plan', 'bağımlılık', 'tekrar', 'takvim', 'outlook', 'termin', 'gerçekleşen',
  'planlanan bitiş', 'ilerleme'
];
const ROTA_FACT_HINTS = [
  'kaç', 'hangi', 'kim', 'ne zaman', 'var mı', 'yok mu', 'listele', 'göster', 'bul',
  'ara', 'durum', 'gecik', 'tamamlan', 'başla', 'bitti', 'bitmiş', 'sorumlu', 'atan',
  'bekleyen', 'onay', 'benim', 'bana', 'bizim', 'ekibim', 'bugün', 'yarın', 'bu hafta'
];

/** Kullanıcının iletisi güncel Rota olgusu gerektiriyor mu? Saf ve muhafazakâr kapı. */
export function requiresRotaEvidence(text) {
  const lower = String(text ?? '').toLocaleLowerCase('tr-TR');
  return ROTA_DATA_TERMS.some((term) => lower.includes(term))
    && ROTA_FACT_HINTS.some((hint) => lower.includes(hint));
}

function excerpt(text) {
  const plain = String(text).replace(/\s+/g, ' ').trim();
  return plain.length > 80 ? `${plain.slice(0, 77)}…` : plain;
}

function claimText(text) {
  return String(text ?? '')
    .replace(ANY_BRACKETED, ' ')
    .split('\n')
    .map((line) => line
      .replace(/^\s{0,3}\d{1,3}[.)]\s/, '')
      .replace(/^\s{0,3}#{1,6}\s+\d{1,3}(?:\.\d{1,3})*[.)]?\s/, ''))
    .join('\n');
}

function canonicalNumber(value) {
  const raw = String(value).trim().replace(/−/g, '-');
  const normalized = /^[+-]?\d{1,3}(?:\.\d{3})+$/.test(raw)
    ? raw.replace(/\./g, '')
    : raw.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

const STATUS_CLAIMS = [
  { pattern: /tamamlandı/u, values: ['done', 'completed', 'complete'] },
  { pattern: /devam ediyor/u, values: ['in_progress', 'in-progress', 'inprogress'] },
  { pattern: /yapılacak/u, values: ['todo', 'planned'] }
];

function claimsIn(text) {
  let source = claimText(text);
  const dates = [];
  source = source
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (token) => {
      dates.push(token);
      return ' ';
    })
    .replace(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g, (_, day, month, year) => {
      dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      return ' ';
    });
  source = source
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, ' ');
  const numbers = [...source.matchAll(/(^|[^\p{L}\d])([+\-−]?\d+(?:[.,]\d+)?)(?=$|[^\p{L}\d])/gu)]
    .map((match) => canonicalNumber(match[2]))
    .filter(Boolean);
  const lower = source.toLocaleLowerCase('tr-TR');
  const statuses = STATUS_CLAIMS.filter((item) => item.pattern.test(lower)).map((item) => item.values);
  return { dates: [...new Set(dates)], numbers: [...new Set(numbers)], statuses };
}

function collectEvidenceValues(value, result) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    result.numbers.add(String(value));
    return;
  }
  if (typeof value === 'string') {
    result.strings.add(value.toLocaleLowerCase('tr-TR'));
    for (const match of value.matchAll(/(^|[^\p{L}\d])([+\-−]?\d+(?:[.,]\d+)?)(?=$|[^\p{L}\d])/gu)) {
      const number = canonicalNumber(match[2]);
      if (number) result.numbers.add(number);
    }
    for (const date of value.matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=[^\d]|$)/g)) result.dates.add(date[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidenceValues(item, result));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      result.strings.add(key.toLocaleLowerCase('tr-TR'));
      collectEvidenceValues(item, result);
    }
  }
}

function evidenceValueIndex(payloads) {
  const byId = new Map();
  for (const item of Array.isArray(payloads) ? payloads : []) {
    if (!item || !isEvidenceId(item.id)) continue;
    let payload = item.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    const values = { numbers: new Set(), dates: new Set(), strings: new Set() };
    collectEvidenceValues(payload, values);
    byId.set(item.id, values);
  }
  return byId;
}

function unsupportedEvidenceClaims(text, citationIds, byId) {
  const indexes = citationIds.map((id) => byId.get(id)).filter(Boolean);
  const claims = claimsIn(text);
  const unsupported = [];
  if (!indexes.length && (claims.numbers.length || claims.dates.length || claims.statuses.length)) return ['kanıt yükü'];
  for (const value of claims.numbers) {
    if (!indexes.some((index) => index.numbers.has(value))) unsupported.push(`sayı ${value}`);
  }
  for (const value of claims.dates) {
    if (!indexes.some((index) => index.dates.has(value))) unsupported.push(`tarih ${value}`);
  }
  for (const aliases of claims.statuses) {
    if (!indexes.some((index) => aliases.some((alias) => index.strings.has(alias)))) unsupported.push(`durum ${aliases[0]}`);
  }
  return unsupported;
}

/**
 * Kanıta dayanan (araç kullanılmış) yanıtın doğrulanması.
 *
 * @param {string} text  kanonikleştirilmiş yanıt
 * @param {{ evidenceIds: Iterable<string>, evidencePayloads?: Array<{id: string, payload: string}> }} context tur kanıtları
 * @returns {{ ok: boolean, citedIds: string[], issues: Array<{code: string, detail?: string}> }}
 */
export function analyzeGroundedAnswer(text, { evidenceIds = [], evidencePayloads } = {}) {
  const available = new Set(evidenceIds);
  const answer = String(text ?? '');
  const issues = [];
  if (!answer.trim()) {
    return { ok: false, citedIds: [], issues: [{ code: 'EMPTY_ANSWER' }] };
  }
  const cited = extractCitationIds(answer);
  const unknown = cited.filter((id) => !available.has(id));
  if (unknown.length) issues.push({ code: 'UNKNOWN_CITATION', detail: unknown.join(', ') });
  const malformed = (answer.match(ANY_BRACKETED) || []).filter((token) => !/^【R[1-9]\d?】$/.test(token));
  if (malformed.length) issues.push({ code: 'MALFORMED_CITATION', detail: malformed.slice(0, 3).join(' ') });
  const valid = cited.filter((id) => available.has(id));
  if (available.size > 0 && valid.length === 0) issues.push({ code: 'MISSING_CITATION' });

  const segments = answerSegments(answer);
  const directCitations = segments.map((segment) => validCitationsIn(segment.text, available));
  const valuesByEvidence = evidenceValueIndex(evidencePayloads);
  const validatePayloadValues = Array.isArray(evidencePayloads);
  segments.forEach((segment, index) => {
    let citationIds = directCitations[index];
    if (!citationIds.length && segment.kind !== 'paragraph') {
      citationIds = [...new Set([...(directCitations[index - 1] || []), ...(directCitations[index + 1] || [])])];
    }
    if (citationIds.length) {
      if (validatePayloadValues) {
        const unsupported = unsupportedEvidenceClaims(segment.text, citationIds, valuesByEvidence);
        if (unsupported.length) issues.push({ code: 'UNSUPPORTED_EVIDENCE_VALUE', detail: unsupported.slice(0, 4).join(', ') });
      }
      return;
    }
    const code = segmentHasNumericClaim(segment) ? 'UNCITED_NUMERIC_BLOCK' : 'UNCITED_GROUNDED_BLOCK';
    issues.push({ code, detail: excerpt(segment.text) });
  });
  return { ok: issues.length === 0, citedIds: valid, issues };
}

/**
 * Araç kullanılmadan üretilen genel yanıt. Kanıt olmadığı için hiçbir kanıt
 * işareti taşıyamaz; taşıyorsa model kanıt uydurmuştur.
 */
export function analyzeDirectAnswer(text, { evidenceRequired = false } = {}) {
  const answer = String(text ?? '');
  const issues = [];
  if (!answer.trim()) issues.push({ code: 'EMPTY_ANSWER' });
  if (evidenceRequired) issues.push({ code: 'ROTA_EVIDENCE_REQUIRED' });
  const tokens = answer.match(ANY_BRACKETED) || [];
  if (tokens.length) issues.push({ code: 'CITATION_WITHOUT_EVIDENCE', detail: tokens.slice(0, 3).join(' ') });
  return { ok: issues.length === 0, citedIds: [], issues };
}

/**
 * Araç denendi ama hiçbir kanıt üretilemedi (bulunamadı, süre aşımı, yoğunluk…).
 * Yanıt kanıt işareti taşıyamaz ve Rota verisi olarak okunabilecek sayı ya da
 * tarih içeremez: araç hatası, veriyi tahminle doldurma izni değildir.
 */
export function analyzeUngroundedAnswer(text) {
  const direct = analyzeDirectAnswer(text);
  const issues = [...direct.issues];
  for (const segment of answerSegments(String(text ?? ''))) {
    if (segment.kind !== 'code' && segmentHasNumericClaim(segment)) {
      issues.push({ code: 'UNGROUNDED_NUMERIC_BLOCK', detail: excerpt(segment.text) });
    }
  }
  return { ok: issues.length === 0, citedIds: [], issues };
}

/** Satır, kanıt işaretine benzeyen bir parça taşıyor mu? (akış kapısı için) */
export function containsCitationMarker(text) {
  return /【/.test(String(text ?? '')) || /\[\s*R[1-9]\d?\s*\]/.test(String(text ?? ''));
}

const SCOPE_PHRASES = [
  'görebildiğiniz', 'görüntüleyebildiğiniz', 'erişebildiğiniz', 'erişiminiz', 'erişim yetkiniz',
  'yetkili olduğunuz', 'yetkinizdeki', 'yetkiniz bulunan', 'yetkinizin', 'size görünen', 'görünür kapsam',
  'görünen kapsam', 'kısmi kapsam', 'görünürlüğünüz', 'görünürlük kapsamınız', 'yetki kapsamınız'
];

/** Yanıt, kapsamın yetkiyle sınırlı olduğunu söylüyor mu? */
export function mentionsAuthorizedScope(text) {
  const lower = String(text ?? '').toLocaleLowerCase('tr-TR');
  return SCOPE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Kısmi kapsamlı kanıta atıf yapan ama kapsamı belirtmeyen yanıta sunucunun
 * belirlenimci notunu ekler. Not modelden gelmez; yanıt metnine eklenir ve
 * yanıtla birlikte kaydedilir.
 */
export function withScopeDisclosure(text, citedEvidence = []) {
  const partial = citedEvidence.some((item) => item?.partial === true);
  if (!partial) return { text, disclosed: false };
  return { text: `${String(text).trimEnd()}\n\n${SCOPE_DISCLOSURE_TEXT}`, disclosed: true };
}

const ISSUE_GUIDANCE = Object.freeze({
  EMPTY_ANSWER: 'Yanıt boş kaldı; kanıtlara dayanan kısa bir yanıt yaz.',
  UNKNOWN_CITATION: 'Bu turda üretilmemiş kanıt kimliklerine atıf yaptın: {detail}. Yalnızca araç sonuçlarındaki evidenceId değerlerini kullan.',
  MALFORMED_CITATION: 'Atıf biçimi hatalı: {detail}. Atıfları yalnızca 【R1】 biçiminde yaz.',
  MISSING_CITATION: 'Rota verisine dayanan her ifadeye ilgili kanıtın atfını 【R1】 biçiminde ekle.',
  UNCITED_NUMERIC_BLOCK: 'Şu bölüm sayı ya da tarih içeriyor ama kanıt atfı taşımıyor: "{detail}". Bu değeri destekleyen kanıtın atfını aynı paragrafa ekle; kanıtla desteklenemiyorsa değeri yazma.',
  UNCITED_GROUNDED_BLOCK: 'Şu bölüm Rota yanıtında kanıt atfı taşımıyor: "{detail}". Rota verisine dayanmıyorsa bölümü çıkar; dayanıyorsa ilgili kanıtın atfını ekle.',
  UNSUPPORTED_EVIDENCE_VALUE: 'Şu değerler atıf yapılan araç sonuçlarında bulunmuyor: {detail}. Yalnızca ilgili kanıt yükünde gerçekten bulunan sayı, tarih ve durum değerlerini kullan.',
  ROTA_EVIDENCE_REQUIRED: 'Kullanıcı güncel Rota verisi soruyor. Yanıt vermeden önce ilgili Rota aracını çağır ve sonucu kanıt olarak kullan.',
  CITATION_WITHOUT_EVIDENCE: 'Bu yanıtta hiçbir Rota kanıtı yok ama kanıt işareti kullandın. Rota verisi gerekiyorsa önce ilgili aracı çağır; gerekmiyorsa kanıt işareti kullanmadan yanıtla.',
  UNGROUNDED_NUMERIC_BLOCK: 'Rota verisi alınamadığı hâlde şu bölüm sayı ya da tarih içeriyor: "{detail}". Veriyi tahminle doldurma; verinin neden alınamadığını açıkla ya da ilgili aracı yeniden çağır.'
});

/** Tek düzeltme turunda modele verilen, sunucuya ait yönerge. */
export function groundingRepairInstruction(issues = []) {
  const lines = [...new Map(issues.map((issue) => [`${issue.code}:${issue.detail || ''}`, issue])).values()]
    .slice(0, 6)
    .map((issue) => `- ${(ISSUE_GUIDANCE[issue.code] || 'Yanıtı kanıt sözleşmesine uygun yeniden yaz.').replace('{detail}', issue.detail || '')}`);
  return [
    'SUNUCU DOĞRULAMASI: Önceki taslak kanıt sözleşmesini karşılamadı ve kullanıcıya gösterilmedi.',
    ...lines,
    'Rota verisi gerekiyorsa önce uygun aracı çağır. Kanıt varsa yalnızca o kanıtlarla yanıtı baştan yaz; yeni sayı, tarih ya da durum uydurma.'
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
