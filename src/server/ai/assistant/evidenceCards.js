import 'server-only';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import {
  EVIDENCE_CARD_LIMITS,
  EVIDENCE_CARD_VERSION,
  hasBindingMarks,
  normalizeEvidenceCards,
  resolveBindingAnchors
} from '../../../domain/ai/evidenceCards.js';
import { strongTexts } from '../../../features/ai/assistant/evidenceCardAnchors.js';

/**
 * Bilgin etkileşimli kanıt kartlarının (ICE) sunucu tarafı.
 *
 * 1. `settleEvidenceBindings`: düzen yolunun işaretli metnindeki konum işaretlerini söker ve bağları kalın düğüm
 *    sırasına çevirir. Bundan sonraki her adım (notlar, kapsam açıklaması, uzunluk sınırı, kalıcılık, teslim) işaretsiz
 *    metinle çalışır.
 * 2. `buildEvidenceCards`: son yetki yeniden doğrulamasından ve son metin kurulduktan sonra, yalnızca yanıtta atfedilen
 *    kanıtların yüklerinden dar bir izdüşümle kart tanımlayıcısını kurar.
 *
 * Kart isteğe bağlı bir zenginleştirmedir: herhangi bir tutarsızlık kartı düşürür, yanıtı asla değiştirmez. Kart içeriği
 * günlüğe, telemetriye, kalıcı kayda ya da model bağlamına yazılmaz.
 */

const STATUSES = new Set(['todo', 'in_progress', 'done']);
const ASSIGNMENTS = new Set(['visible', 'unresolved', 'unassigned', 'undisclosed']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;
const collator = new Intl.Collator('tr-TR', { sensitivity: 'base' });

/** Görünen metin: denetim ve yön karakterleri boşluğa çevrilir, boşluk sadeleşir, sınırda kısaltılır. */
function cleanText(value, max = EVIDENCE_CARD_LIMITS.maxTextChars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const validDay = (value) => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/**
 * Düzen metnindeki işaretleri söker; bağlar `evidenceBindings` alanında taşınır. İşaret yoksa değer olduğu gibi döner.
 * İşaret varsa ama bağlar doğrulanamıyorsa metin yine işaretsizdir; yalnızca bağ taşınmaz.
 */
export function settleEvidenceBindings(value, bindings) {
  if (!value || typeof value.normalized !== 'string' || !hasBindingMarks(value.normalized)) return value;
  const resolved = resolveBindingAnchors(value.normalized, strongTexts);
  const known = Array.isArray(bindings) ? bindings : [];
  const anchors = resolved.anchors.filter((anchor) => known[anchor.key - 1]);
  const { evidenceBindings: _previous, ...rest } = value;
  return { ...rest, normalized: resolved.text,
    ...(anchors.length ? { evidenceBindings: Object.freeze({ text: resolved.text, bindings: known, anchors: Object.freeze(anchors) }) } : {}) };
}

/** Görev satırının kart izdüşümü; biçimi beklenmeyen satır `null` (kart düşer). */
function projectTask(row, directory) {
  if (!row || typeof row !== 'object' || typeof row.taskId !== 'string') return null;
  const id = canonicalActualId(row.taskId);
  const title = cleanText(row.title);
  if (!id || !title || !STATUSES.has(row.status)) return null;
  const overdue = row.overdue === true && row.status !== 'done';
  const people = Array.isArray(row.assignees) ? row.assignees : [];
  // Sonuç boyutu nedeniyle kısaltılan sorumlu dizisi aynı sıradaki önektir.
  const unresolved = new Set(directory?.unresolved);
  const visible = [];
  let hidden = 0;
  let unresolvedCount = directory?.unresolved.length ?? 0;
  people.forEach((person, index) => {
    if (!person || typeof person !== 'object') return;
    if (person.identityHidden === true) hidden += 1;
    else if (!directory && row.assignment === 'unresolved') unresolvedCount += 1;
    else if (!unresolved.has(index)) {
      const name = cleanText(person.name);
      if (name) visible.push({ name, key: Number.isSafeInteger(person.sicil) ? `s:${person.sicil}` : `n:${name}` });
    }
  });
  const maxNames = EVIDENCE_CARD_LIMITS.maxAssigneesPerItem;
  const availableNames = Math.min(maxNames, visible.length);
  const assignment = ASSIGNMENTS.has(row.assignment) ? row.assignment : visible.length ? 'visible' : 'undisclosed';
  const totalVisible = Math.max(visible.length, directory?.visibleCount ?? 0);
  // Görev olgusu ile sorumlu okuması arasında atama durumu değiştiyse çelişkili satır kapalı reddedilir.
  if (assignment === 'unassigned' && (people.length > 0 || totalVisible > 0 || unresolvedCount > 0 || hidden > 0)) return null;
  if (assignment === 'visible' && totalVisible === 0) return null;
  if (assignment === 'unresolved' && (totalVisible > 0 || unresolvedCount === 0)) return null;
  if (assignment === 'undisclosed' && (totalVisible > 0 || unresolvedCount > 0)) return null;
  const progress = Number.isSafeInteger(row.progressPercent) && row.progressPercent >= 0 && row.progressPercent <= 100 ? row.progressPercent : null;
  return {
    item: {
      id,
      title,
      project: cleanText(row.project?.name ?? null),
      status: row.status,
      overdue,
      overdueDays: overdue && Number.isSafeInteger(row.overdueDays) && row.overdueDays >= 0 && row.overdueDays <= EVIDENCE_CARD_LIMITS.maxCount ? row.overdueDays : null,
      due: validDay(row.targetFinish) ? row.targetFinish : null,
      finished: row.status === 'done' && validDay(row.actualFinish) ? row.actualFinish : null,
      progress,
      assignees: visible.slice(0, availableNames).map((person) => person.name),
      ...(totalVisible > availableNames ? { assigneesClipped: true } : {}),
      ...(unresolvedCount ? { unresolvedAssignees: unresolvedCount } : {}),
      hiddenAssignees: hidden,
      assignment
    },
    // Farklı sorumluların ayrılması yalnızca sunucuda (Sicil ile); tarayıcıya yalnızca ad ve görev sayısı gider.
    people: visible
  };
}

/** Kartın farklı sorumluları: görev sayısına, sonra ada göre; aynı kişi bir kez. */
function distinctPeople(projected) {
  const byKey = new Map();
  for (const { people } of projected) {
    for (const person of new Map(people.map((entry) => [entry.key, entry])).values()) {
      const current = byKey.get(person.key);
      if (current) current.tasks += 1;
      else byKey.set(person.key, { name: person.name, tasks: 1 });
    }
  }
  const limit = EVIDENCE_CARD_LIMITS.maxPeoplePerCard;
  const people = [...byKey.values()].sort((left, right) => right.tasks - left.tasks || collator.compare(left.name, right.name)).slice(0, limit);
  return { people, ...(byKey.size > limit ? { peopleClipped: true } : {}) };
}

function taskTone(item) {
  return item.status === 'done' ? 'done' : item.overdue ? 'overdue' : item.status === 'in_progress' ? 'progress' : 'neutral';
}

/**
 * Bağın kartı; kanıtla tutarsız bağ `null`. Görev koleksiyonu kartının nüfusu aynı kanıtın görev arama satırlarıdır:
 * sayı kanıtın kesin toplamına eşit olmalı ya da kanıt tam ve satır sayısı sayıya eşit olmalıdır; satır sayısı sayıyı
 * aşamaz. Satırlar sayıdan azsa kart kısmi önizlemedir (tarayıcı bunu açıkça yazar).
 */
function cardFor(bind, entry, summary) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== 'object' || entry.tool !== 'rota_task_search' || payload.tool !== 'rota_task_search') return null;
  const rows = payload.data?.tasks;
  if (!Array.isArray(rows) || !rows.length || typeof summary?.generatedAt !== 'string') return null;
  const base = { generatedAt: summary.generatedAt, scopePartial: summary.partial === true };
  if (bind.type === 'tasks') {
    const { count } = bind;
    if (!Number.isSafeInteger(count) || count < 1 || rows.length > count) return null;
    const exact = Number.isSafeInteger(payload.totalCount) && payload.totalCount === count;
    if (!exact && !(payload.complete === true && payload.truncated !== true && rows.length === count)) return null;
    const projected = rows.slice(0, EVIDENCE_CARD_LIMITS.maxItemsPerCard).map((row) => projectTask(row, entry.cardAssignments?.get(row?.taskId)));
    if (projected.some((row) => !row)) return null;
    const items = projected.map((row) => row.item);
    if (new Set(items.map((item) => item.id)).size !== items.length) return null;
    const title = cleanText(bind.title) || 'Görevler';
    return { ...base, kind: 'tasks', title, tone: bind.tone || 'neutral', total: count, items, ...distinctPeople(projected),
      unassigned: items.filter((item) => item.assignment === 'unassigned').length, undisclosed: items.filter((item) => item.assignment === 'undisclosed').length };
  }
  if (bind.type === 'task') {
    const taskId = canonicalActualId(bind.taskId);
    const matches = taskId ? rows.filter((row) => canonicalActualId(row?.taskId) === taskId) : [];
    if (matches.length !== 1) return null;
    const projected = projectTask(matches[0], entry.cardAssignments?.get(taskId));
    if (!projected) return null;
    return { ...base, kind: 'task', title: projected.item.title, tone: taskTone(projected.item), total: 1, items: [projected.item], ...distinctPeople([projected]),
      unassigned: projected.item.assignment === 'unassigned' ? 1 : 0, undisclosed: projected.item.assignment === 'undisclosed' ? 1 : 0 };
  }
  return null;
}

const bindKey = (bind) => (bind.type === 'tasks' ? `tasks:${bind.evidenceId}:${bind.count}` : `task:${bind.evidenceId}:${canonicalActualId(bind.taskId)}`);

/**
 * Kart tanımlayıcısı. `finalText` teslim edilen (kalıcılaştırılan) metindir; işaretsiz düzen metni onun başı olmalıdır
 * (sonraki adımlar yalnızca sona ekler). Her bağ son metnin çözümünde yeniden doğrulanır.
 * @returns {{ descriptor: object, evidenceIds: string[] } | null}
 */
export function buildEvidenceCards({ evidenceBindings, finalText, entries = [], summaries = [], citedIds = [] }) {
  if (!evidenceBindings || typeof finalText !== 'string' || !finalText.startsWith(evidenceBindings.text.trimEnd())) return null;
  const finalStrong = strongTexts(finalText);
  const cited = new Set(citedIds);
  const entryById = new Map(entries.filter((entry) => cited.has(entry.id)).map((entry) => [entry.id, entry]));
  const summaryById = new Map(summaries.filter((summary) => cited.has(summary?.id)).map((summary) => [summary.id, summary]));
  const cards = [];
  const cardIds = new Map();
  const cardEvidence = new Map();
  const anchors = [];
  let totalItems = 0;
  for (const anchor of evidenceBindings.anchors) {
    if (anchors.length >= EVIDENCE_CARD_LIMITS.maxAnchors) break;
    const bind = evidenceBindings.bindings[anchor.key - 1];
    if (!bind || finalStrong[anchor.strong] !== anchor.text || !entryById.has(bind.evidenceId)) continue;
    const key = bindKey(bind);
    let id = cardIds.get(key);
    if (!id) {
      if (cards.length >= EVIDENCE_CARD_LIMITS.maxCards) continue;
      const card = cardFor(bind, entryById.get(bind.evidenceId), summaryById.get(bind.evidenceId));
      if (!card || totalItems + card.items.length > EVIDENCE_CARD_LIMITS.maxTotalItems) continue;
      id = `c${cards.length + 1}`;
      cards.push({ id, ...card });
      cardIds.set(key, id);
      cardEvidence.set(id, bind.evidenceId);
      totalItems += card.items.length;
    }
    anchors.push({ strong: anchor.strong, text: anchor.text, card: id });
  }
  if (!anchors.length) return null;
  // Boyut bütçesi: sondaki kartlar (ve bağları) düşer; yanıt metni değişmez.
  let descriptor = { v: EVIDENCE_CARD_VERSION, cards, anchors };
  while (descriptor.cards.length && JSON.stringify(descriptor).length > EVIDENCE_CARD_LIMITS.maxPayloadChars) {
    const dropped = descriptor.cards.at(-1).id;
    descriptor = { ...descriptor, cards: descriptor.cards.slice(0, -1), anchors: descriptor.anchors.filter((anchor) => anchor.card !== dropped) };
  }
  // Sunucu da tarayıcının katı doğrulamasından geçmeyen tanımlayıcıyı göndermez.
  const normalized = descriptor.cards.length ? normalizeEvidenceCards(descriptor) : null;
  if (!normalized) return null;
  // Kanıt bağımlılıkları yalnızca bütçe kırpmasından sonra kalan kartlardan türetilir.
  const evidenceIds = [...new Set(normalized.cards.map((card) => cardEvidence.get(card.id)).filter(Boolean))];
  return { descriptor: normalized, evidenceIds };
}
