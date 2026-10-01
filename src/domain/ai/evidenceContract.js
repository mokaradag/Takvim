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

const ROTA_DATA_PATTERNS = [
  /(?:^|[^\p{L}])görev\p{L}*(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])proje\p{L}*(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])portföy(?:üm|ümüz|ü|de|den)?(?=$|[^\p{L}])/iu,
  /\bwbs\b/iu, /(?:^|[^\p{L}])[İi]ş dağılım/u, /(?:^|[^\p{L}])sorumlu(?:lar|su|ları)?(?=$|[^\p{L}])/iu,
  /\batama\b/u, /\bbildirim(?:ler)?\b/u, /\bbaz plan\b/u, /\bbağımlılık(?:lar)?\b/u,
  /\btekrar(?: serisi)?\b/u, /\btakvim\b/u, /\boutlook\b/u, /\btermin\b/u,
  /\bgerçekleşen\b/u, /(?:^|[^\p{L}])planlanan bitiş(?=$|[^\p{L}])/iu, /(?:^|[^\p{L}])[İi]lerleme(?=$|[^\p{L}])/u,
  /\btasks?\b/i, /\bprojects?\b/i, /\bportfolio\b/i, /\bassignee(?:s)?\b/i,
  /\bassignments?\b/i, /\bnotifications?\b/i, /\bbaseline\b/i, /\bdependencies\b/i,
  /\brecurrence\b/i, /\bcalendar\b/i, /\bdeadline\b/i, /\bprogress\b/i
];

const ROTA_FACT_PATTERNS = [
  /(?:^|[^\p{L}])(?:kaç|ne zaman|var mı|yok mu|durum(?:u|ları)?|gecik\p{L}*|tamamlan\p{L}*|bitti|bitmiş|sorumlu(?:su|ları)?|atan\p{L}*|bekleyen|onay|benim|bizim|ekibim|bugün|yarın|bu hafta)(?=$|[^\p{L}])/iu,
  /\bhow many\b/i, /\bwhen\b/i, /\bstatus\b/i, /\boverdue\b/i, /\bdue\b/i,
  /\bcompleted?\b/i, /\bassigned?\b/i, /\bpending\b/i, /\bmy\b/i, /\bour\b/i,
  /\btoday\b/i, /\btomorrow\b/i, /\bthis week\b/i
];

const ROTA_EXPLICIT_QUERY_PATTERNS = [
  /(?:^|[^\p{L}])(?:[İi]ş\s+yük\p{L}*|(?:tarih\s+değişikliğ\p{L}*|atama)\s+talep\p{L}*|(?:plan\s+)?veri\s+kalite\p{L}*|(?:dün|bugün)\s+kim\s+ne\s+yaptı)(?=$|[^\p{L}])/iu,
  /\b(?:workload|data quality|schedule requests?|assignment requests?)\b/i,
  /\bwho\s+did\s+what\s+(?:today|yesterday)\b/i,
  /(?:^|[^\p{L}])(?:görevleri|görevlerim|görevlerimi|görevlerimiz|görevlerimizi|projeleri|projelerim|projelerimi|projelerimiz|projelerimizi|bildirimleri|bildirimlerim|bildirimlerimi|bildirimlerimiz|bildirimlerimizi|atamaları|atamalarım|atamalarımı|atamalarımız|atamalarımızı)\s+(?:listele|göster|bul)(?=$|[^\p{L}])/iu,
  /\b(?:list|show|find)\s+(?:my\s+|our\s+|the\s+)?(?:tasks?|projects?|assignments?|notifications?)\b/i,
  /(?:^|[^\p{L}])hangi\s+(?:görev|proje|atama|bildirim)\p{L}*(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])kim\s+sorumlu(?=$|[^\p{L}])/iu,
  /\bwho\s+(?:owns|is\s+(?:the\s+)?(?:owner|assignee|responsible))\b/i,
  /\bwhat(?:'s| is)\s+(?:the\s+)?(?:status|deadline|due date)\b/i
];

const CONTEXT_FOLLOW_UP = /(?:^|[^\p{L}])(?:peki|bunu|şunu|aynı|tekrar|ya|kim|hangisi|ne zaman|what about|and what|who|when|which|again|same)(?=$|[^\p{L}])/iu;
const GENERAL_ADVICE_PATTERNS = [
  /(?:^|[^\p{L}])(?:yöntem\p{L}*|metot\p{L}*|açıkla\p{L}*|anlat\p{L}*|öner\p{L}*|\p{L}+(?:meli|malı|meliyim|malıyım|meliyiz|malıyız))(?=$|[^\p{L}])/iu,
  /\b(?:should|how\s+(?:do|can|should)|explain|methods?|best\s+practices?)\b/i
];
const ROTA_OPEN_FACT_PATTERNS = [
  /(?:^|[^\p{L}])(?:ne|nedir|hangi|kim)(?=$|[^\p{L}])/iu,
  /\b(?:what|which|who)\b/i,
  /(?:^|[^\p{L}])(?:öncelik|lider|sahip)\p{L}*(?=$|[^\p{L}])/iu,
  /\b(?:priority|leader|owner)\b/i
];

function directlyRequiresRotaEvidence(text) {
  const source = String(text ?? '');
  if (ROTA_EXPLICIT_QUERY_PATTERNS.some((pattern) => pattern.test(source))) return true;
  if (!ROTA_DATA_PATTERNS.some((pattern) => pattern.test(source))) return false;
  if (ROTA_FACT_PATTERNS.some((pattern) => pattern.test(source))) return true;
  if (GENERAL_ADVICE_PATTERNS.some((pattern) => pattern.test(source))) return false;
  return ROTA_OPEN_FACT_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Kullanıcının iletisi güncel Rota olgusu gerektiriyor mu?
 * Genel planlama soruları yalnızca proje/görev sözcüğü geçtiği için araçlara
 * zorlanmaz; kısa bağlamsal takipler ise önceki Rota veri sorusunun kapsamını
 * devralır.
 */
export function requiresRotaEvidence(text, { priorUserMessages = [] } = {}) {
  if (directlyRequiresRotaEvidence(text)) return true;
  const source = String(text ?? '').trim();
  const words = source.split(/\s+/u).filter(Boolean).length;
  if (
    words > 5
    || /(?:^|[^\p{L}])ya da(?=$|[^\p{L}])/iu.test(source)
    || GENERAL_ADVICE_PATTERNS.some((pattern) => pattern.test(source))
    || !CONTEXT_FOLLOW_UP.test(source)
  ) return false;
  return [...priorUserMessages].reverse().some((message) => directlyRequiresRotaEvidence(message));
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
  const normalized = /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

const STATUS_CLAIMS = [
  { pattern: /(?:tamamlandı|\bcompleted?\b|\bdone\b)/u, values: ['done', 'completed', 'complete'] },
  { pattern: /(?:devam ediyor|\bin progress\b)/u, values: ['in_progress', 'in-progress', 'inprogress'] },
  { pattern: /(?:yapılacak|\btodo\b|\bis planned\b|\bstatus(?: is|:)\s*planned\b)/u, values: ['todo', 'planned'] }
];

const FIELD_HINTS = Object.freeze([
  { kind: 'number', pattern: /(?:gecikmiş(?:\s+görev(?:\s+say(?:ı|ısı))?)?|overdue(?:\s+(?:task\s+count|tasks?))?)/iu, fields: ['overdue', 'overduecount', 'subtreeoverdue'] },
  { kind: 'number', pattern: /(?:açık\s+görev(?:\s+say(?:ı|ısı))?|open\s+(?:task\s+count|tasks?))/iu, fields: ['open', 'opentasks', 'opentaskcount'] },
  { kind: 'number', pattern: /(?:tamamlanmış\s+görev(?:\s+say(?:ı|ısı))?|completed\s+(?:task\s+count|tasks?)|done\s+tasks?)/iu, fields: ['done', 'completed', 'closed', 'completedtasks'] },
  { kind: 'number', pattern: /(?:bu\s+hafta\s+termini|7\s+gün(?:\s+içinde)?\s+termin|due\s+soon|next\s+7\s+days?)/iu, fields: ['duenext7days', 'duesoon', 'duesooncount'] },
  { kind: 'number', pattern: /(?:sorumlusuz(?:\s+görev)?|unassigned(?:\s+tasks?)?)/iu, fields: ['unassigned', 'unassignedcount', 'unassignedopentasks'] },
  { kind: 'number', pattern: /(?:proje\s+say(?:ı|ısı)|project\s+count|toplam\s+proje)/iu, fields: ['projects', 'projectcount', 'totalprojects'] },
  { kind: 'number', pattern: /(?:(?:wbs|iş\s+dağılım)\s+(?:düğüm\s+)?say(?:ı|ısı)|wbs\s+node\s+count)/iu, fields: ['wbsnodecount', 'nodecount', 'totalnodes', 'nodes'] },
  { kind: 'number', pattern: /(?:talep\s+say(?:ı|ısı)|request\s+count|toplam\s+talep)/iu, fields: ['requests', 'requestcount'] },
  { kind: 'number', pattern: /(?:toplam\s+görev|total\s+tasks?|tasks?\s+total)/iu, fields: ['total', 'tasks', 'taskcount'] },
  { kind: 'number', pattern: /(?:tamamlanma\s+oran|completion\s+rate)/iu, fields: ['completionratepercent'] },
  { kind: 'number', pattern: /(?:%|ilerleme|progress)/iu, fields: ['progress', 'progresspercent'] },
  { kind: 'number', pattern: /(?:planlanan\s+saat|planned\s+hours?)/iu, fields: ['plannedhours', 'planned', 'plannedhoursonassignedtasks'] },
  { kind: 'number', pattern: /(?:gerçekleşen\s+saat|actual\s+hours?)/iu, fields: ['actualhours', 'actual'] },
  { kind: 'number', pattern: /(?:süre|duration)/iu, fields: ['planneddurationdays', 'remainingdurationdays', 'durationdays'] },
  { kind: 'number', pattern: /(?:bütçe|budget)/iu, fields: ['budget'] },
  { kind: 'number', pattern: /(?:harcanan|spent)/iu, fields: ['spent'] },
  { kind: 'date', pattern: /(?:planlanan\s+bitiş|planned\s+finish)/iu, fields: ['plannedfinish'] },
  { kind: 'date', pattern: /(?:gerçekleşen\s+bitiş|actual\s+finish)/iu, fields: ['actualfinish'] },
  { kind: 'date', pattern: /(?:gerçekleşen\s+başlangıç|actual\s+start)/iu, fields: ['actualstart'] },
  { kind: 'date', pattern: /(?:planlanan\s+başlangıç|planned\s+start)/iu, fields: ['plannedstart'] },
  { kind: 'date', pattern: /(?:termin|deadline|target\s+finish|due\s+date)/iu, fields: ['targetfinish', 'calendardate'] }
]);

function hintedFields(source, start, end, kind = 'number') {
  if (kind === 'number') {
    const before = source.slice(Math.max(0, start - 48), start);
    const after = source.slice(end, Math.min(source.length, end + 32));
    if (/(?:tamamlanma\s+oran[ıi]?|completion\s+rate)\s*[:=]?\s*%?\s*$/iu.test(before)) {
      return ['completionratepercent'];
    }
    if (/^\s*(?:gün|days?)\s+(?:gecikmiş|overdue)(?=$|[^\p{L}])/iu.test(after)) {
      return ['overduedays'];
    }
  }
  const from = Math.max(0, start - 36);
  const around = source.slice(from, Math.min(source.length, end + 36));
  const claimCenter = ((start + end) / 2) - from;
  let best = null;
  for (const item of FIELD_HINTS) {
    if (item.kind !== kind) continue;
    const flags = item.pattern.flags.includes('g') ? item.pattern.flags : item.pattern.flags + 'g';
    const pattern = new RegExp(item.pattern.source, flags);
    for (const match of around.matchAll(pattern)) {
      const center = match.index + (match[0].length / 2);
      const distance = Math.abs(center - claimCenter);
      if (!best || distance < best.distance) best = { distance, fields: item.fields };
    }
  }
  return best?.fields || null;
}

const TURKISH_MONTHS = Object.freeze({
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12'
});

function claimsIn(text) {
  let source = claimText(text);
  const qualifiedClockTimes = new Set(
    [...source.matchAll(/\b\d{4}-\d{2}-\d{2}T((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?)(?:Z|[+\-]\d{2}:\d{2})\b/gi)]
      .map((match) => match[1])
  );
  const dates = [];
  source = source
    .replace(/\b(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})\b/giu, (token, day, monthName, year, offset) => {
      const month = TURKISH_MONTHS[monthName.toLocaleLowerCase('tr-TR')];
      dates.push({
        value: year + '-' + month + '-' + String(day).padStart(2, '0'),
        fields: hintedFields(source, offset, offset + token.length, 'date')
      });
      return ' '.repeat(token.length);
    })
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (token, _year, _month, _day, offset) => {
      dates.push({ value: token, fields: hintedFields(source, offset, offset + token.length, 'date') });
      return ' '.repeat(token.length);
    })
    .replace(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g, (token, day, month, year, offset) => {
      dates.push({
        value: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
        fields: hintedFields(source, offset, offset + token.length, 'date')
      });
      return ' '.repeat(token.length);
    });
  const clockTimes = [...qualifiedClockTimes].map((value) => ({ value, qualified: true }));
  source = source
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?\b/g, (token) => {
      clockTimes.push({ value: token, qualified: qualifiedClockTimes.has(token) });
      return ' '.repeat(token.length);
    });
  const numbers = [...source.matchAll(/(^|[^\p{L}\d])([+\-−]?(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?))(?=$|[^\p{L}\d])/gu)]
    .map((match) => {
      const start = match.index + match[1].length;
      const end = match.index + match[0].length;
      const before = source.slice(Math.max(0, start - 16), start);
      const after = source.slice(end, Math.min(source.length, end + 32));
      const windowLiteral = match[2] === '7' && (
        /^\s+gün(?:\s+içinde)?\s+termin/iu.test(after)
        || (/next\s+$/i.test(before) && /^\s+days?\b/i.test(after))
      );
      if (windowLiteral) return null;
      return { value: canonicalNumber(match[2]), fields: hintedFields(source, start, end) };
    })
    .filter((claim) => claim?.value);
  const lower = source.toLocaleLowerCase('tr-TR');
  const statuses = STATUS_CLAIMS.filter((item) => item.pattern.test(lower)).map((item) => item.values);
  return { dates, numbers, statuses, clockTimes };
}

function emptyEvidenceValues() {
  return { numbers: new Set(), dates: new Set(), strings: new Set(), fields: new Map() };
}

function cloneEvidenceValues(source) {
  const copy = emptyEvidenceValues();
  for (const value of source.numbers) copy.numbers.add(value);
  for (const value of source.dates) copy.dates.add(value);
  for (const value of source.strings) copy.strings.add(value);
  for (const [field, values] of source.fields) {
    copy.fields.set(field, {
      numbers: new Set(values.numbers),
      dates: new Set(values.dates),
      strings: new Set(values.strings)
    });
  }
  return copy;
}

function fieldBucket(result, key) {
  const normalized = String(key || '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
  if (!normalized) return null;
  if (!result.fields.has(normalized)) result.fields.set(normalized, { numbers: new Set(), dates: new Set(), strings: new Set() });
  return result.fields.get(normalized);
}

function addPrimitive(value, keys, result) {
  const buckets = [...new Set((Array.isArray(keys) ? keys : [keys]).map((key) => fieldBucket(result, key)).filter(Boolean))];
  if (typeof value === 'number' && Number.isFinite(value)) {
    const number = String(value);
    result.numbers.add(number);
    for (const bucket of buckets) bucket.numbers.add(number);
    return;
  }
  if (typeof value !== 'string') return;
  const lower = value.toLocaleLowerCase('tr-TR');
  result.strings.add(lower);
  for (const bucket of buckets) bucket.strings.add(lower);
  for (const match of value.matchAll(/(^|[^\p{L}\d])([+\-−]?(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?))(?=$|[^\p{L}\d])/gu)) {
    const number = canonicalNumber(match[2]);
    if (number) {
      result.numbers.add(number);
      for (const bucket of buckets) bucket.numbers.add(number);
    }
  }
  for (const date of value.matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=[^\d]|$)/g)) {
    result.dates.add(date[1]);
    for (const bucket of buckets) bucket.dates.add(date[1]);
  }
}

function collectLocalValues(value, result, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item == null || typeof item !== 'object') addPrimitive(item, keys, result);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value)) {
      const childKeys = [...keys, childKey];
      if (Array.isArray(item) && item.some((entry) => entry && typeof entry === 'object')) {
        collectLocalValues(item.filter((entry) => entry == null || typeof entry !== 'object'), result, childKeys);
      } else {
        collectLocalValues(item, result, childKeys);
      }
    }
    return;
  }
  addPrimitive(value, keys, result);
}

function collectEvidenceScopes(value, inherited = emptyEvidenceValues(), scopes = []) {
  const local = cloneEvidenceValues(inherited);
  collectLocalValues(value, local);
  if (local.numbers.size || local.dates.size || local.strings.size) scopes.push(local);
  const visitArrays = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child && typeof child === 'object') collectEvidenceScopes(child, local, scopes);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const child of Object.values(node)) visitArrays(child);
  };
  visitArrays(value);
  return scopes;
}

const ENVELOPE_TOTAL_FIELDS = Object.freeze({
  rota_task_search: 'taskcount',
  rota_project_search: 'projectcount',
  rota_schedule_requests: 'requestcount',
  rota_assignment_requests: 'requestcount'
});

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
    const scopes = collectEvidenceScopes(payload);
    const totalField = ENVELOPE_TOTAL_FIELDS[payload?.tool];
    const totalValue = canonicalNumber(payload?.totalCount);
    if (totalField && totalValue != null) {
      for (const scope of scopes) fieldBucket(scope, totalField)?.numbers.add(totalValue);
    }
    byId.set(item.id, scopes);
  }
  return byId;
}

function fieldSupports(scope, fields, kind, value) {
  if (!fields?.length) return scope[kind].has(value);
  return fields.some((field) => scope.fields.get(field)?.[kind]?.has(value));
}

function meaningfulEvidenceString(value) {
  const text = String(value || '').trim();
  if (text.length < 3 || text.length > 160) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text) || /^\d{4}-\d{2}-\d{2}/.test(text)) return false;
  return !/^(?:true|false|null|done|todo|planned|in_progress|in-progress|full|partial|read)$/i.test(text);
}

function entityClaimsIn(text) {
  const source = claimText(text);
  const claims = [];
  const patterns = [
    { kind: 'person', pattern: /(?:sorumlu(?:su|ları)?|oluşturan|proje lideri|lideri)\s*(?:[:=–—-]\s*|\s+)([\p{L}][\p{L}\p{M}'’ -]{1,80})/giu },
    { kind: 'person', pattern: /(?:assignee|owner|responsible person|created by|project lead)\s*(?:is\s+|[:=–—-]\s*)?([\p{L}][\p{L}\p{M}'’ -]{1,80})/giu },
    { kind: 'subject', pattern: /([\p{L}\d][\p{L}\p{M}\d'’()/_ -]{2,80}?)\s+projesi(?:nde|nin)?\b/giu },
    { kind: 'subject', pattern: /([\p{L}\d][\p{L}\p{M}\d'’()/_ -]{2,80}?)\s+görevi(?:nde|nin)?\b/giu },
    { kind: 'subject', pattern: /([\p{L}\d][\p{L}\p{M}\d'’()/_ -]{2,80}?)\s+project\b/giu },
    { kind: 'subject', pattern: /([\p{L}\d][\p{L}\p{M}\d'’()/_ -]{2,80}?)\s+task\b/giu },
    { kind: 'exact', pattern: /(?:görev|task)\s*[“"'‘’]([^”"'‘’]{2,120})[”"'‘’]/giu }
  ];
  for (const { kind, pattern } of patterns) {
    for (const match of source.matchAll(pattern)) {
      let value = match[1].trim().replace(/\s+/g, ' ');
      if (kind === 'person') value = value.replace(/\s+(?:olan|olarak)\b.*$/iu, '').trim();
      if (kind === 'subject') value = value.replace(/^(?:şu\s+anda|şimdi|halen|currently|now)\s+/iu, '').trim();
      const normalized = normalizedText(value);
      if (/^(?:oldugunuz|oldugun|oldugu|olan|olarak)$/u.test(normalized)) continue;
      if (!/^(?:bu|bir|ilgili|proje|görev|kişi|bilinmiyor|yok|the|this|a)$/iu.test(value) && value.length >= 2) claims.push(value);
    }
  }
  return [...new Set(claims)];
}

function normalizedText(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function scopeContainsText(scope, value) {
  const needle = normalizedText(value);
  return [...scope.strings].some((candidate) => normalizedText(candidate) === needle);
}

function scopeContainsQualifiedClock(scope, value) {
  const needle = String(value || '').toLocaleLowerCase('en-US');
  return [...scope.strings].some((candidate) => {
    const text = String(candidate || '').toLocaleLowerCase('en-US');
    return text.includes(`t${needle}`) && /(?:z|[+\-]\d{2}:\d{2})$/.test(text);
  });
}

function claimUnits(text) {
  return claimText(text).split(/\n|;|,(?!\d)|(?<=[.!?])\s+/u).map((item) => item.trim()).filter(Boolean);
}

function unsupportedEvidenceClaims(text, citationIds, byId) {
  const scopes = citationIds.flatMap((id) => byId.get(id) || []);
  const unsupported = [];
  if (!scopes.length) {
    const claims = claimsIn(text);
    return claims.numbers.length || claims.dates.length || claims.statuses.length || claims.clockTimes.length || entityClaimsIn(text).length ? ['kanıt yükü'] : [];
  }

  for (const entity of entityClaimsIn(text)) {
    if (!scopes.some((scope) => scopeContainsText(scope, entity))) unsupported.push('metin ' + excerpt(entity));
  }

  for (const unit of claimUnits(text)) {
    const claims = claimsIn(unit);
    if (!claims.numbers.length && !claims.dates.length && !claims.statuses.length && !claims.clockTimes.length) continue;
    const lowerUnit = normalizedText(unit);
    const anchors = [...new Set(scopes.flatMap((scope) => [...scope.strings])
      .filter(meaningfulEvidenceString)
      .filter((value) => lowerUnit.includes(normalizedText(value))))];
    const candidates = anchors.length
      ? scopes.filter((scope) => anchors.some((anchor) => scope.strings.has(anchor)))
      : scopes;
    const supported = candidates.some((scope) => (
      claims.numbers.every((claim) => fieldSupports(scope, claim.fields, 'numbers', claim.value))
      && claims.dates.every((claim) => fieldSupports(scope, claim.fields, 'dates', claim.value))
      && claims.statuses.every((aliases) => aliases.some((alias) => scope.strings.has(alias)))
      && claims.clockTimes.every((claim) => claim.qualified && scopeContainsQualifiedClock(scope, claim.value))
    ));
    if (!supported) {
      for (const claim of claims.numbers) unsupported.push('sayı ' + claim.value);
      for (const claim of claims.dates) unsupported.push('tarih ' + claim.value);
      for (const aliases of claims.statuses) unsupported.push('durum ' + aliases[0]);
      for (const claim of claims.clockTimes) unsupported.push('saat ' + claim.value);
    }
  }
  return [...new Set(unsupported)];
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
const SAFE_UNGROUNDED_FAILURE = /^(?:bu soruyu(?: şu anda)?(?: Rota verisiyle)? yanıtlayamıyorum|bu görevi bulamadım ya da görüntüleme yetkiniz yok|kayıt bulunamadı(?: ya da bu kaydı görüntüleme yetkiniz yok)?|(?:Rota )?veri(?:si|sine|ye|lerine)?(?: şu anda| süre sınırında)? (?:alınamadı|ulaşılamıyor|erişemiyorum|yoğun)|(?:bu |ilgili )?veri (?:bulunamadı|bulamadım)|(?:bu |ilgili )?veriye erişemiyorum|görüntüleme yetkiniz yok)$/iu;
const SAFE_UNGROUNDED_REMEDIATION = /^(?:(?:lütfen )?(?:(?:biraz|daha|kısa bir süre) sonra )?(?:yeniden|tekrar) deneyin|(?:soruyu|daha dar bir sorguyla) .*?(?:yeniden|tekrar) deneyin|daha dar bir sorguyla (?:yeniden|tekrar) deneyin|(?:lütfen )?görüntüleme yetkinizi .*?kontrol edin)$/iu;

function isSafeUngroundedAnswer(value) {
  const clauses = stripCitations(String(value ?? ''))
    .trim()
    .split(/\s*;\s*|(?<=[.!?])\s+/u)
    .map((clause) => clause.trim().replace(/[.!?]+$/u, ''))
    .filter(Boolean);
  if (!clauses.length || !SAFE_UNGROUNDED_FAILURE.test(clauses[0])) return false;
  return clauses.slice(1).every((clause) => SAFE_UNGROUNDED_REMEDIATION.test(clause));
}

export function analyzeUngroundedAnswer(text, { evidenceRequired = false } = {}) {
  const value = String(text ?? '');
  const direct = analyzeDirectAnswer(value);
  const issues = [...direct.issues];
  if (evidenceRequired && !isSafeUngroundedAnswer(value)) {
    issues.push({ code: 'ROTA_EVIDENCE_REQUIRED', detail: excerpt(value) });
  }
  for (const segment of answerSegments(value)) {
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
  UNKNOWN_CITATION: 'Bu turda üretilmemiş kanıt kimliği kullandın. Yalnızca araç sonuçlarındaki evidenceId değerlerini kullan.',
  MALFORMED_CITATION: 'Atıf biçimi hatalı. Atıfları yalnızca 【R1】 biçiminde yaz.',
  MISSING_CITATION: 'Rota verisine dayanan her ifadeye ilgili kanıtın atfını 【R1】 biçiminde ekle.',
  UNCITED_NUMERIC_BLOCK: 'Bir bölüm sayı ya da tarih içeriyor ama kanıt atfı taşımıyor. Değeri destekleyen kanıtın atfını aynı paragrafa ekle; kanıtla desteklenemiyorsa değeri yazma.',
  UNCITED_GROUNDED_BLOCK: 'Bir bölüm Rota yanıtında kanıt atfı taşımıyor. Rota verisine dayanmıyorsa bölümü çıkar; dayanıyorsa ilgili kanıtın atfını ekle.',
  UNSUPPORTED_EVIDENCE_VALUE: 'Taslakta atıf yapılan araç sonuçlarıyla desteklenmeyen değerler var. Yalnızca ilgili kanıt yükünde gerçekten bulunan sayı, tarih ve durum değerlerini kullan.',
  ROTA_EVIDENCE_REQUIRED: 'Kullanıcı güncel Rota verisi soruyor. Yanıt vermeden önce ilgili Rota aracını çağır ve sonucu kanıt olarak kullan.',
  CITATION_WITHOUT_EVIDENCE: 'Bu yanıtta hiçbir Rota kanıtı yok ama kanıt işareti kullandın. Rota verisi gerekiyorsa önce ilgili aracı çağır; gerekmiyorsa kanıt işareti kullanmadan yanıtla.',
  UNGROUNDED_NUMERIC_BLOCK: 'Rota verisi alınamadığı hâlde taslak sayı ya da tarih içeriyor. Veriyi tahminle doldurma; verinin neden alınamadığını açıkla ya da ilgili aracı yeniden çağır.'
});

/** Tek düzeltme turunda modele verilen, sunucuya ait yönerge. */
export function groundingRepairInstruction(issues = []) {
  const lines = [...new Set(issues.map((issue) => issue?.code).filter(Boolean))]
    .slice(0, 6)
    .map((code) => `- ${ISSUE_GUIDANCE[code] || 'Yanıtı kanıt sözleşmesine uygun yeniden yaz.'}`);
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
