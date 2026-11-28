/**
 * Bilgin etkileşimli kanıt kartları (ICE) — sunucu ile tarayıcının ORTAK, saf sözleşmesi.
 *
 * Kart, doğrulanmış bir yanıttaki belirli bir olgunun (ör. "**10** gecikmiş göreviniz var" cümlesindeki 10)
 * arkasındaki yetkili kayıtları gösterir. Kart içeriğini ve bağını YALNIZCA sunucu üretir; model kart seçmez,
 * üretmez ya da görmez. Tanımlayıcı geçicidir: kalıcı kayda, kanıt JSON'una, tarayıcı deposuna ya da model
 * bağlamına girmez (bkz. docs/BILGIN-ETKILESIMLI-KANIT-MIMARISI.md).
 *
 * Bağın konumu, sunucunun yalnızca kendi düzen çiziminde eklediği denetim karakteri işaretleriyle
 * (`U+001E <anahtar> U+001F`) bulunur. Veri metni (`escapedFactText`) bu aralığı boşluğa çevirdiği ve kalıcı ileti
 * normalleştirmesi bu karakterleri sildiği için işaret veriden taklit edilemez ve kalıcı metne sızamaz.
 */
import { canonicalActualId } from '../identity/actualId.js';

export const EVIDENCE_CARD_VERSION = 2;

/**
 * ICE-2 sınırları. Karmaşık analitik yanıt (ör. dört bölümlü yönetim özeti) gözlenen kıyas kümesinde 60'ı aşan kanıtlanabilir
 * sayı, ad ve oran taşır; bu yüzden bağ ve kart sınırları yükseltildi (bağ anahtarı biçimi en çok 99'a izin verir). En kötü
 * durum: tanımlayıcının JSON uzunluğu 200.000 UTF-16 kod birimini aşamaz. En çok 6 canlı yanıt tutulur.
 * Satır bütçesi görev ve varlık koleksiyonlarına birlikte uygulanır.
 */
export const EVIDENCE_CARD_LIMITS = Object.freeze({
  /** Yanıt başına en fazla kart. */
  maxCards: 64,
  /** Yanıt başına en fazla bağ (işaretli olgu). */
  maxAnchors: 96,
  /** Kart başına en fazla görev satırı. */
  maxItemsPerCard: 30,
  /** Yanıt başına toplam görev ve varlık koleksiyonu satırı. */
  maxTotalItems: 360,
  /** Varlık koleksiyonu kartının en fazla satırı (kişi/proje/birim). */
  maxEntityRows: 30,
  /** Varlık koleksiyonu kartının en fazla ölçü sütunu. */
  maxEntityColumns: 4,
  /** Tekil varlık, hesap ve karşılaştırma kartının en fazla ölçü satırı. */
  maxMetrics: 6,
  /** Ölçü değeri metninin üst sınırı. */
  maxValueChars: 40,
  /** Kart başına en fazla farklı sorumlu. */
  maxPeoplePerCard: 30,
  /** Satır başına gösterilen sorumlu adı. */
  maxAssigneesPerItem: 4,
  /** Metin alanlarının üst sınırı. */
  maxTextChars: 160,
  /** Bağlı kalın metnin üst sınırı. */
  maxAnchorTextChars: 160,
  /** Tanımlayıcının JSON uzunluğu. */
  maxPayloadChars: 200000,
  /** Tarayıcıda kartın yaşam süresi (alındığı andan). */
  ttlMs: 15 * 60 * 1000,
  /** Kart taşıyabilen en yeni canlı yanıt sayısı. */
  maxLiveAnswers: 6,
  /** Görev sayısı ve gün değerlerinin üst sınırı. */
  maxCount: 1000000
});

/**
 * Kart türleri: görev koleksiyonu ve tekil görev (ICE-1); tekil kişi/proje/örgüt birimi, onların koleksiyonları, doğrulanmış
 * hesap (yüzde, oran) ve karşılaştırma (ICE-2).
 */
export const EVIDENCE_CARD_KINDS = Object.freeze(['tasks', 'task', 'person', 'project', 'unit', 'people', 'projects', 'units', 'calc', 'compare']);
const TASK_KINDS = new Set(['tasks', 'task']);
const ENTITY_KINDS = new Set(['person', 'project', 'unit']);
const COLLECTION_KINDS = new Set(['people', 'projects', 'units']);
const FACT_KINDS = new Set(['calc', 'compare']);
export const EVIDENCE_CARD_TONES = Object.freeze(['overdue', 'done', 'progress', 'due', 'unassigned', 'neutral']);
const STATUSES = new Set(['todo', 'in_progress', 'done']);
const ASSIGNMENTS = new Set(['visible', 'unresolved', 'unassigned', 'undisclosed']);

/* ── Bağ işaretleri (yalnızca sunucu iç yolu) ───────────────── */

export const BINDING_MARK_OPEN = '\u001e';
export const BINDING_MARK_CLOSE = '\u001f';
const MARK = /\u001e([1-9]\d?)\u001f/g;
const MARK_PREFIX = /^\u001e([1-9]\d?)\u001f/;
const STRAY = /[\u001e\u001f]/g;

/** Bağ anahtarının işareti; anahtar 1..maxAnchors dışındaysa işaret üretilmez. */
export function bindingMark(key) {
  return Number.isSafeInteger(key) && key >= 1 && key <= EVIDENCE_CARD_LIMITS.maxAnchors ? `${BINDING_MARK_OPEN}${key}${BINDING_MARK_CLOSE}` : '';
}

/** Metin işaret ya da artık işaret karakteri taşıyor mu? */
export function hasBindingMarks(text) {
  return typeof text === 'string' && (text.includes(BINDING_MARK_OPEN) || text.includes(BINDING_MARK_CLOSE));
}

/** Bütün işaretleri ve artık işaret karakterlerini söker (metnin görünen içeriği değişmez). */
export function stripBindingMarks(text) {
  return String(text ?? '').replace(MARK, '').replace(STRAY, '');
}

/** Kalın düğüm metninin başındaki işaret: `{ key, text }` ya da `null`. */
export function leadingBindingMark(text) {
  const match = MARK_PREFIX.exec(String(text ?? ''));
  return match ? { key: Number(match[1]), text: String(text).slice(match[0].length) } : null;
}

/**
 * İşaretli düzen metninden kalın düğüm bağlarını çıkarır. `strongTexts(metin)` saf Markdown çözücüsüyle kalın
 * düğümlerin görünen metinlerini ÇİZİM SIRASIYLA döndürür (sunucu ve tarayıcı aynı gezintiyi kullanır).
 *
 * Kurallar (kapalı ret): her anahtar tam bir kez ve yalnızca kalın düğümün başında bulunmalı; işaretsiz metnin
 * kalın düğüm sayısı ve ilgili sıradaki metin aynı olmalı; artık işaret karakteri ya da kalın dışı işaret bütün
 * bağları düşürür. Dönen metin her durumda işaretsizdir.
 * @returns {{ text: string, anchors: { key: number, strong: number, text: string }[], rejected: string|null }}
 */
export function resolveBindingAnchors(text, strongTexts) {
  const source = String(text ?? '');
  if (!hasBindingMarks(source)) return { text: source, anchors: [], rejected: null };
  const stripped = stripBindingMarks(source);
  const reject = (reason) => ({ text: stripped, anchors: [], rejected: reason });
  const marks = [...source.matchAll(MARK)];
  if (source.replace(MARK, '').match(STRAY)) return reject('STRAY_MARK');
  const keys = marks.map((match) => Number(match[1]));
  if (new Set(keys).size !== keys.length) return reject('DUPLICATE_MARK');
  let marked;
  let plain;
  try {
    marked = strongTexts(source);
    plain = strongTexts(stripped);
  } catch {
    return reject('PARSE');
  }
  if (!Array.isArray(marked) || !Array.isArray(plain) || marked.length !== plain.length) return reject('STRONG_COUNT');
  const anchors = [];
  let anchoredMarks = 0;
  marked.forEach((value, strong) => {
    const lead = leadingBindingMark(value);
    if (!lead || hasBindingMarks(lead.text) || plain[strong] !== lead.text) return;
    anchoredMarks += 1;
    if (strong <= 4000 && textLabelAllowed(lead.text)) anchors.push({ key: lead.key, strong, text: lead.text });
  });
  // Kalın düğümün dışına taşan işaret yapısal hatadır. Geçerli konumdaki uzun etiket yalnızca kendi bağını düşürür.
  if (anchoredMarks !== keys.length) return reject('UNANCHORED_MARK');
  return { text: stripped, anchors, rejected: null };
}

/* ── Tanımlayıcı doğrulaması (tarayıcı ve sınamalar) ────────── */

const isPlain = (value) => value != null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CARD_ID = /^c[1-9]\d?$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Bidi_Control}\p{Surrogate}]/gu;
const HAS_UNSAFE_TEXT = new RegExp(UNSAFE_TEXT.source, 'u');

/** Kart metninde denetim ve yön karakterlerini, bozuk Unicode'u ve gereksiz boşlukları temizler. */
export function cleanEvidenceCardText(value, max = EVIDENCE_CARD_LIMITS.maxTextChars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}

function text(value, { optional = false, max = EVIDENCE_CARD_LIMITS.maxTextChars } = {}) {
  if (value == null && optional) return { ok: true, value: null };
  if (typeof value !== 'string' || !value.trim() || value.length > max || HAS_UNSAFE_TEXT.test(value)) return { ok: false };
  return { ok: true, value };
}

const textLabelAllowed = (value) => text(value, { max: EVIDENCE_CARD_LIMITS.maxAnchorTextChars }).ok;

function count(value, { optional = false } = {}) {
  if (value == null && optional) return { ok: true, value: null };
  return Number.isSafeInteger(value) && value >= 0 && value <= EVIDENCE_CARD_LIMITS.maxCount ? { ok: true, value } : { ok: false };
}

function day(value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string' || !DAY.test(value)) return { ok: false };
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? { ok: true, value } : { ok: false };
}

function normalizeItem(item) {
  if (!isPlain(item) || typeof item.id !== 'string') return null;
  const id = canonicalActualId(item.id);
  const title = text(item.title);
  const project = text(item.project, { optional: true });
  const overdueDays = count(item.overdueDays, { optional: true });
  const progress = count(item.progress, { optional: true });
  const hidden = count(item.hiddenAssignees);
  const unresolved = count(item.unresolvedAssignees === undefined ? 0 : item.unresolvedAssignees);
  const clipped = item.assigneesClipped === undefined ? false : item.assigneesClipped;
  const due = day(item.due);
  const finished = day(item.finished);
  if (!id || id !== item.id || !title.ok || !project.ok || !overdueDays.ok || !progress.ok || (progress.value != null && progress.value > 100) || !hidden.ok
    || !unresolved.ok || typeof clipped !== 'boolean' || !due.ok || !finished.ok || !STATUSES.has(item.status) || typeof item.overdue !== 'boolean' || !ASSIGNMENTS.has(item.assignment)
    || !Array.isArray(item.assignees) || item.assignees.length > EVIDENCE_CARD_LIMITS.maxAssigneesPerItem) return null;
  const assignees = item.assignees.map((name) => text(name));
  if (assignees.some((name) => !name.ok)) return null;
  // Gecikme günü yalnızca gecikmiş açık görevde, tamamlanma günü yalnızca tamamlanmış görevde anlamlıdır.
  if ((overdueDays.value != null && !item.overdue) || (item.overdue && item.status === 'done') || (finished.value != null && item.status !== 'done')) return null;
  // Sorumlusuz satırda sorumlu kaydı, gizli ya da çözülemeyen durumda görünür ad taşınmaz.
  if (item.assignment === 'unassigned' && (assignees.length > 0 || hidden.value > 0 || unresolved.value > 0 || clipped)) return null;
  if ((item.assignment === 'undisclosed' || item.assignment === 'unresolved') && (assignees.length > 0 || clipped)) return null;
  return Object.freeze({ id, title: title.value, project: project.value, status: item.status, overdue: item.overdue, overdueDays: overdueDays.value,
    due: due.value, finished: finished.value, progress: progress.value, assignees: Object.freeze(assignees.map((name) => name.value)),
    hiddenAssignees: hidden.value, ...(unresolved.value ? { unresolvedAssignees: unresolved.value } : {}),
    ...(clipped ? { assigneesClipped: true } : {}), assignment: item.assignment });
}

function normalizePerson(person) {
  if (!isPlain(person)) return null;
  const name = text(person.name);
  const tasks = count(person.tasks);
  return name.ok && tasks.ok && tasks.value >= 1 ? Object.freeze({ name: name.value, tasks: tasks.value }) : null;
}

/** Ölçü satırı: sunucunun etiketi ve biçimlenmiş değeri (ör. `{ label: 'Gecikmiş', value: '5' }`). */
function normalizeMetric(metric) {
  if (!isPlain(metric)) return null;
  const label = text(metric.label);
  const value = text(metric.value, { max: EVIDENCE_CARD_LIMITS.maxValueChars });
  return label.ok && value.ok ? Object.freeze({ label: label.value, value: value.value }) : null;
}

function normalizeMetrics(list, { min = 1 } = {}) {
  if (!Array.isArray(list) || list.length < min || list.length > EVIDENCE_CARD_LIMITS.maxMetrics) return null;
  const metrics = list.map(normalizeMetric);
  return metrics.some((metric) => !metric) ? null : Object.freeze(metrics);
}

/** Ortak kart künyesi; bozuksa `null`. */
function cardHead(card) {
  const title = text(card.title);
  if (!title.ok || typeof card.generatedAt !== 'string' || !INSTANT.test(card.generatedAt) || Number.isNaN(Date.parse(card.generatedAt)) || typeof card.scopePartial !== 'boolean') return null;
  return { id: card.id, kind: card.kind, title: title.value, tone: card.tone, generatedAt: card.generatedAt, scopePartial: card.scopePartial };
}

/** Tekil kişi/proje/birim: doğrulanmış ölçüler ve (varsa) aynı varlığın görev önizlemesi. */
function normalizeEntityCard(card) {
  const head = cardHead(card);
  const metrics = normalizeMetrics(card.metrics);
  const total = count(card.total);
  const listLabel = text(card.listLabel, { optional: true });
  if (!head || !metrics || !total.ok || !listLabel.ok || !Array.isArray(card.items) || card.items.length > EVIDENCE_CARD_LIMITS.maxItemsPerCard) return null;
  const items = card.items.map(normalizeItem);
  if (items.some((item) => !item) || new Set(items.map((item) => item.id)).size !== items.length || items.length > total.value || (items.length > 0 && !listLabel.value)) return null;
  return Object.freeze({ ...head, metrics, total: total.value, items: Object.freeze(items), ...(listLabel.value ? { listLabel: listLabel.value } : {}) });
}

/** Varlık koleksiyonu: adlar ve sütun başına doğrulanmış sayı (bilinmeyen değer `null`). */
function normalizeCollectionCard(card) {
  const head = cardHead(card);
  const total = count(card.total);
  if (!head || !total.ok || total.value < 1 || !Array.isArray(card.columns) || card.columns.length > EVIDENCE_CARD_LIMITS.maxEntityColumns
    || !Array.isArray(card.rows) || !card.rows.length || card.rows.length > EVIDENCE_CARD_LIMITS.maxEntityRows || card.rows.length > total.value) return null;
  const columns = card.columns.map((label) => text(label));
  if (columns.some((label) => !label.ok)) return null;
  const rows = [];
  for (const row of card.rows) {
    const name = isPlain(row) ? text(row.name) : { ok: false };
    if (!name.ok || !Array.isArray(row.values) || row.values.length !== columns.length) return null;
    const values = row.values.map((value) => count(value, { optional: true }));
    if (values.some((value) => !value.ok)) return null;
    rows.push(Object.freeze({ name: name.value, values: Object.freeze(values.map((value) => value.value)) }));
  }
  return Object.freeze({ ...head, total: total.value, columns: Object.freeze(columns.map((label) => label.value)), rows: Object.freeze(rows) });
}

/** Hesap ve karşılaştırma: işlenenler, sonuç ve (hesapta) işlem metni. */
function normalizeFactCard(card) {
  const head = cardHead(card);
  const metrics = normalizeMetrics(card.metrics, { min: 2 });
  const result = text(card.result, { max: EVIDENCE_CARD_LIMITS.maxValueChars * 2 });
  const formula = text(card.formula, { optional: true });
  const note = text(card.note, { optional: true });
  if (!head || !metrics || !result.ok || !formula.ok || !note.ok) return null;
  return Object.freeze({ ...head, metrics, result: result.value, ...(formula.value ? { formula: formula.value } : {}), ...(note.value ? { note: note.value } : {}) });
}

function normalizeCard(card) {
  if (!isPlain(card) || typeof card.id !== 'string' || !CARD_ID.test(card.id) || !EVIDENCE_CARD_KINDS.includes(card.kind) || !EVIDENCE_CARD_TONES.includes(card.tone)) return null;
  if (ENTITY_KINDS.has(card.kind)) return normalizeEntityCard(card);
  if (COLLECTION_KINDS.has(card.kind)) return normalizeCollectionCard(card);
  if (FACT_KINDS.has(card.kind)) return normalizeFactCard(card);
  if (!TASK_KINDS.has(card.kind)) return null;
  const title = text(card.title);
  const total = count(card.total);
  const unassigned = count(card.unassigned);
  const undisclosed = count(card.undisclosed);
  const clipped = card.peopleClipped === undefined ? false : card.peopleClipped;
  if (!title.ok || !total.ok || !unassigned.ok || !undisclosed.ok || typeof card.generatedAt !== 'string' || !INSTANT.test(card.generatedAt)
    || Number.isNaN(Date.parse(card.generatedAt)) || typeof card.scopePartial !== 'boolean'
    || !Array.isArray(card.items) || !card.items.length || card.items.length > EVIDENCE_CARD_LIMITS.maxItemsPerCard
    || typeof clipped !== 'boolean' || !Array.isArray(card.people) || card.people.length > EVIDENCE_CARD_LIMITS.maxPeoplePerCard) return null;
  const items = card.items.map(normalizeItem);
  const people = card.people.map(normalizePerson);
  if (items.some((item) => !item) || people.some((person) => !person)) return null;
  // Satırlar ve kişiler tekil; gösterilen satır sayısı toplamı aşamaz; tekil görev kartı tek satırdır.
  if (new Set(items.map((item) => item.id)).size !== items.length || items.length > total.value
    || (card.kind === 'task' && (items.length !== 1 || total.value !== 1))
    || unassigned.value + undisclosed.value > items.length
    || (clipped && people.length < EVIDENCE_CARD_LIMITS.maxPeoplePerCard && !items.some((item) => item.assigneesClipped))) return null;
  return Object.freeze({ id: card.id, kind: card.kind, title: title.value, tone: card.tone, generatedAt: card.generatedAt, total: total.value,
    scopePartial: card.scopePartial, items: Object.freeze(items), people: Object.freeze(people), ...(clipped ? { peopleClipped: true } : {}), unassigned: unassigned.value, undisclosed: undisclosed.value });
}

/**
 * Tarayıcıya gelen tanımlayıcıyı katı biçimde doğrular. Herhangi bir alan bozuksa, sınır aşılıyorsa ya da bağ
 * bilinmeyen karta işaret ediyorsa `null` döner (yanıt kartsız gösterilir; kısmi güven yoktur).
 */
export function normalizeEvidenceCards(value) {
  if (!isPlain(value) || value.v !== EVIDENCE_CARD_VERSION || !Array.isArray(value.cards) || !Array.isArray(value.anchors)) return null;
  if (!value.cards.length || value.cards.length > EVIDENCE_CARD_LIMITS.maxCards || !value.anchors.length || value.anchors.length > EVIDENCE_CARD_LIMITS.maxAnchors) return null;
  let size;
  try { size = JSON.stringify(value).length; } catch { return null; }
  if (size > EVIDENCE_CARD_LIMITS.maxPayloadChars) return null;
  const cards = value.cards.map(normalizeCard);
  if (cards.some((card) => !card) || new Set(cards.map((card) => card.id)).size !== cards.length
    || cards.reduce((sum, card) => sum + (card.items?.length ?? card.rows?.length ?? 0), 0) > EVIDENCE_CARD_LIMITS.maxTotalItems) return null;
  const known = new Set(cards.map((card) => card.id));
  const anchors = [];
  for (const anchor of value.anchors) {
    if (!isPlain(anchor) || !Number.isSafeInteger(anchor.strong) || anchor.strong < 0 || anchor.strong > 4000 || !known.has(anchor.card)) return null;
    const label = text(anchor.text, { max: EVIDENCE_CARD_LIMITS.maxAnchorTextChars });
    if (!label.ok) return null;
    anchors.push(Object.freeze({ strong: anchor.strong, text: label.value, card: anchor.card }));
  }
  if (new Set(anchors.map((anchor) => anchor.strong)).size !== anchors.length) return null;
  // Her kart en az bir bağla kullanılır: bağsız kart taşınmaz.
  if (cards.some((card) => !anchors.some((anchor) => anchor.card === card.id))) return null;
  return Object.freeze({ v: EVIDENCE_CARD_VERSION, cards: Object.freeze(cards), anchors: Object.freeze(anchors) });
}

/** Kartın süresi doldu mu? (`receivedAt` tarayıcının alma anıdır.) */
export function evidenceCardsExpired(receivedAt, now = Date.now(), expiresAt = Infinity, elapsed = globalThis.performance.now()) {
  return !Number.isFinite(receivedAt) || now - receivedAt >= EVIDENCE_CARD_LIMITS.ttlMs
    || now < receivedAt - 60000 || elapsed >= expiresAt;
}
