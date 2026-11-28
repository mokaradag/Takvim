import 'server-only';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import {
  EVIDENCE_CARD_LIMITS,
  EVIDENCE_CARD_VERSION,
  cleanEvidenceCardText as cleanText,
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
const collator = new Intl.Collator('tr-TR', { sensitivity: 'base' });

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
  let assignment = ASSIGNMENTS.has(row.assignment) ? row.assignment : visible.length ? 'visible' : 'undisclosed';
  const totalVisible = Math.max(visible.length, directory?.visibleCount ?? 0);
  hidden = Math.max(hidden, directory?.hiddenCount ?? 0);
  // Dizin adı temizlenince boşsa görevde açıklanabilir atama vardır, fakat kişi adı çözülemez.
  if (assignment === 'visible' && totalVisible === 0 && directory?.hasUnusableName && unresolvedCount > 0) assignment = 'unresolved';
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
    people: visible,
    peopleIncomplete: totalVisible > visible.length
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
  return { people, ...(byKey.size > limit || projected.some((row) => row.peopleIncomplete) ? { peopleClipped: true } : {}) };
}

function taskTone(item) {
  return item.status === 'done' ? 'done' : item.overdue ? 'overdue' : item.status === 'in_progress' ? 'progress' : 'neutral';
}

/* ── ICE-2: canlı nüfus kaydı, yük değerleri ve varlık satırları ───────────── */

const ROW_PATH = /^data\.(groups|people|projects)\.(\d+)$/;
const FIELD_PATH = /^(?:totalCount|data(?:\.[A-Za-z][A-Za-z0-9]*|\.\d+){1,4})$/;
const SAFE_KEY = (key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';

/** Yükteki alanın değeri (yalnızca kendi alanları; prototip zinciri okunmaz). */
function valueAt(payload, field) {
  if (typeof field !== 'string' || !FIELD_PATH.test(field)) return undefined;
  return field.split('.').reduce((value, key) => (value != null && typeof value === 'object' && SAFE_KEY(key) && Object.hasOwn(value, key) ? value[key] : undefined), payload);
}

/** Satır yolunun (ör. `data.groups.2.open`) satırı ve kimliği; satır yolu yoksa `null`. */
function rowOf(payload, field) {
  const match = /^(data\.(?:groups|people|projects)\.\d+)(?:\.|$)/.exec(String(field));
  if (!match) return null;
  const row = valueAt(payload, match[1]);
  if (!row || typeof row !== 'object') return null;
  const key = row.projectId ?? row.sicil ?? row.key ?? null;
  return { path: match[1], row, key: key == null ? null : String(key) };
}

/**
 * Kayıtlı nüfus kümesinin kart satırları. Kapalı ret: yükteki sayı, bağın sayısı ve kaydın kesin büyüklüğü birbirine eşit
 * olmalı; satır yolundaki satırın kimliği kayıttakiyle aynı olmalı; önizleme satırları kayıtta bulunmalıdır.
 */
function registeredSet(entry, field, count) {
  const population = entry?.cardPopulation;
  const set = population?.sets?.get?.(field);
  if (!set || !Number.isSafeInteger(count) || count < 1 || set.size !== count || valueAt(entry.payload, field) !== count) return null;
  if (set.rowKey != null && rowOf(entry.payload, field)?.key !== String(set.rowKey)) return null;
  const rows = set.ids.map((id) => population.rows.get(id));
  if (!rows.length || rows.some((row) => !row) || rows.length > count) return null;
  return { rows, assignments: population.assignments };
}

/** Birbirini dışlayan gruplamalar: bir görev tek gruptadır (birleşimin büyüklüğü grup sayılarının toplamıdır). */
const EXCLUSIVE_GROUP_BY = new Set(['status', 'priority', 'project', 'deadline', 'target_month', 'date_week', 'date_month', 'due_horizon']);

/**
 * Ayrık grupların birleşimi (ör. birikimli teslim ufku): gruplama birbirini dışlamalı, her grup kayıtlı olmalı ve grup
 * büyüklüklerinin toplamı bağın sayısına eşit olmalıdır. Önizleme grupların sırasıyla birleştirilir; yinelenen satır kapalı ret.
 */
function unionSet(entry, fields, count) {
  if (entry?.tool !== 'rota_task_analytics' || !EXCLUSIVE_GROUP_BY.has(entry.payload?.data?.groupBy) || !Array.isArray(fields) || fields.length < 2
    || new Set(fields).size !== fields.length || !fields.every((field) => /^data\.groups\.\d+\.(?:count|open|overdue|done)$/.test(field))) return null;
  const parts = fields.map((field) => ({ field, value: valueAt(entry.payload, field) }));
  if (parts.some((part) => !Number.isSafeInteger(part.value) || part.value < 0) || parts.reduce((sum, part) => sum + part.value, 0) !== count || count < 1) return null;
  const rows = [];
  for (const part of parts) {
    if (part.value === 0) continue;
    const set = registeredSet(entry, part.field, part.value);
    if (!set) return null;
    rows.push(...set.rows);
  }
  const ids = rows.map((row) => row?.taskId);
  if (new Set(ids).size !== ids.length) return null;
  return { rows: rows.slice(0, EVIDENCE_CARD_LIMITS.maxItemsPerCard), assignments: entry.cardPopulation.assignments };
}

/** Tam görev listesinde koşula uyan satırlar (yalnızca sunucunun kapalı koşul kümesi). */
const ROW_PREDICATES = Object.freeze({
  overdue: (row) => row?.overdue === true && row.status !== 'done',
  withoutTargetFinish: (row) => row != null && !row.targetFinish
});

/**
 * Görev aramasının BÜTÜN nüfusu yükteyse (tam, kesilmemiş, satır sayısı = kesin toplam) koşula uyan satırlar. Koşula uyan
 * satır sayısı bağın sayısına eşit değilse kart yoktur: iddia yükün kendisiyle bağımsız olarak doğrulanır.
 */
function predicateRows(entry, predicate, count) {
  const payload = entry?.payload;
  const rows = payload?.data?.tasks;
  const test = ROW_PREDICATES[predicate];
  if (entry?.tool !== 'rota_task_search' || !test || !Array.isArray(rows) || payload.complete !== true || payload.truncated === true
    || !Number.isSafeInteger(payload.totalCount) || rows.length !== payload.totalCount) return null;
  const matched = rows.filter(test);
  return matched.length === count && count > 0 ? { rows: matched, assignments: entry.cardAssignments } : null;
}

/** Görev arama satırlarının açıkça adlandırılmış alt kümesi (ör. gecikmiş kilometre taşları); her kimlik satırlarda tek olmalı. */
function explicitRows(entry, taskIds, count) {
  const rows = entry?.payload?.data?.tasks;
  if (entry?.tool !== 'rota_task_search' || !Array.isArray(rows) || !Array.isArray(taskIds) || taskIds.length !== count || count < 1) return null;
  const wanted = taskIds.map((id) => canonicalActualId(id));
  if (wanted.some((id) => !id) || new Set(wanted).size !== wanted.length) return null;
  const picked = wanted.map((id) => rows.filter((row) => canonicalActualId(row?.taskId) === id));
  return picked.every((list) => list.length === 1) ? { rows: picked.map(([row]) => row), assignments: entry.cardAssignments } : null;
}

/** Görev satırlarından görev koleksiyonu kartı (ortak izdüşüm). */
function taskCollection(base, { rows, assignments }, count, bind, budget = EVIDENCE_CARD_LIMITS.maxItemsPerCard) {
  const projected = rows.slice(0, Math.min(budget, EVIDENCE_CARD_LIMITS.maxItemsPerCard)).map((row) => projectTask(row, assignments?.get?.(row?.taskId)));
  if (!projected.length || projected.some((row) => !row)) return null;
  const items = projected.map((row) => row.item);
  if (new Set(items.map((item) => item.id)).size !== items.length) return null;
  return { ...base, kind: 'tasks', title: cleanText(bind.title) || 'Görevler', tone: bind.tone || 'neutral', total: count, items, ...distinctPeople(projected),
    unassigned: items.filter((item) => item.assignment === 'unassigned').length, undisclosed: items.filter((item) => item.assignment === 'undisclosed').length };
}

const ENTITY_TOOLS = Object.freeze({
  rota_workload_summary: { collection: 'people', name: (row) => row.name,
    metrics: [['openTasks', 'Açık görev', 'Açık'], ['inProgress', 'Devam eden', 'Devam'], ['overdue', 'Gecikmiş', 'Gecikmiş'], ['dueNext7Days', '7 gün içinde terminli', '7 gün']], preview: ['overdue', 'openTasks'] },
  rota_task_analytics: { collection: 'groups', name: (row) => row.label,
    metrics: [['count', 'Görev', 'Görev'], ['open', 'Açık', 'Açık'], ['overdue', 'Gecikmiş', 'Gecikmiş'], ['done', 'Tamamlanan', 'Tamam.']], preview: ['overdue', 'open', 'count'] },
  rota_portfolio_summary: { collection: 'projects', name: (row) => (row.code ? `${row.code} · ${row.name}` : row.name),
    metrics: [['tasks.open', 'Açık görev', 'Açık'], ['tasks.overdue', 'Gecikmiş', 'Gecikmiş'], ['tasks.dueNext7Days', '7 gün içinde terminli', '7 gün'], ['tasks.done', 'Tamamlanan', 'Tamam.']], preview: ['tasks.overdue', 'tasks.open'] }
});
const ENTITY_LIST_LABELS = Object.freeze({ overdue: 'Gecikmiş görevler', openTasks: 'Açık görevler', open: 'Açık görevler', count: 'Görevler',
  'tasks.overdue': 'Gecikmiş görevler', 'tasks.open': 'Açık görevler' });
const ENTITY_KIND = Object.freeze({ person: 'person', project: 'project', department: 'unit', unit: 'unit' });
const COLLECTION_KIND = Object.freeze({ person: 'people', project: 'projects', department: 'units', unit: 'units' });
const ENTITY_TONE = Object.freeze({ person: 'neutral', project: 'neutral', department: 'neutral', unit: 'neutral' });

/** Varlık satırı (kişi, proje grubu, portföy projesi, örgüt birimi) ve ölçüleri; biçimi beklenmeyen satır `null`. */
function entityRow(entry, path) {
  const spec = ENTITY_TOOLS[entry?.tool];
  const match = ROW_PATH.exec(String(path));
  if (!spec || !match || match[1] !== spec.collection) return null;
  const row = valueAt(entry.payload, path);
  if (!row || typeof row !== 'object') return null;
  const name = cleanText(spec.name(row));
  const key = row.projectId ?? row.sicil ?? row.key ?? null;
  // Atamasız, açıklanamayan ya da kesik listenin "diğer" satırı bir varlık değildir.
  if (!name || key == null || ['other', 'unassigned', 'unresolved', 'undisclosed', 'none', 'no_unit'].includes(String(key))) return null;
  const metrics = spec.metrics.map(([field, label]) => ({ field, label, value: valueAt(entry.payload, `${path}.${field}`) }))
    .filter((metric) => Number.isSafeInteger(metric.value) && metric.value >= 0);
  return metrics.length ? { spec, row, name, metrics } : null;
}

const formatInt = (value) => new Intl.NumberFormat('tr-TR').format(value);

function entityCard(base, bind, entry, budget) {
  const found = entityRow(entry, bind.row);
  const kind = ENTITY_KIND[bind.entity];
  if (!found || !kind) return null;
  // Önizleme: gecikmiş işi varsa gecikmiş görevler, yoksa açık görevler (aynı satırın kayıtlı nüfusu).
  let items = [];
  let total = 0;
  let listLabel = null;
  for (const field of found.spec.preview) {
    const value = valueAt(entry.payload, `${bind.row}.${field}`);
    if (!Number.isSafeInteger(value) || value < 1) continue;
    const set = registeredSet(entry, `${bind.row}.${field}`, value);
    const card = set && budget > 0 ? taskCollection(base, set, value, { title: found.name }, budget) : null;
    if (card) { items = card.items; total = value; listLabel = ENTITY_LIST_LABELS[field]; }
    break;
  }
  return { ...base, kind, title: found.name, tone: ENTITY_TONE[bind.entity] || 'neutral',
    metrics: found.metrics.slice(0, EVIDENCE_CARD_LIMITS.maxMetrics).map((metric) => ({ label: metric.label, value: formatInt(metric.value) })),
    total, items, ...(listLabel ? { listLabel } : {}) };
}

function collectionCard(base, bind, entry) {
  const kind = COLLECTION_KIND[bind.entity];
  if (!kind || !Array.isArray(bind.rows) || bind.rows.length !== bind.count || bind.count < 1 || new Set(bind.rows).size !== bind.rows.length) return null;
  const found = bind.rows.map((path) => entityRow(entry, path));
  if (found.some((row) => !row)) return null;
  const columns = found[0].spec.metrics.slice(0, EVIDENCE_CARD_LIMITS.maxEntityColumns);
  // Koleksiyon tablosu dar kartta okunur kalsın diye kısa sütun adları (tekil kartın ölçü adları uzundur).
  return { ...base, kind, title: cleanText(bind.title) || 'Kayıtlar', tone: bind.tone || 'neutral', total: bind.count, columns: columns.map(([, label, short]) => short || label),
    rows: found.slice(0, EVIDENCE_CARD_LIMITS.maxEntityRows).map((row, index) => ({ name: row.name,
      values: columns.map(([field]) => { const value = valueAt(entry.payload, `${bind.rows[index]}.${field}`); return Number.isSafeInteger(value) && value >= 0 ? value : null; }) })) };
}

/**
 * Hesap ve karşılaştırma işleneni: kanıt yükündeki sayı (alan yolu) ya da görev aramasının adlandırılmış alt kümesinin büyüklüğü.
 * Bağın taşıdığı değer yükten yeniden okunan değerle aynı değilse işlenen geçersizdir.
 */
function operandValue(operand, entries) {
  const entry = entries.get(operand?.evidenceId);
  if (!entry) return null;
  if (operand.field && operand.value === null) {
    // Yanıtın yazmadığı işlenen (ör. oranın paydası): yalnızca yükteki doğrulanmış sayı kullanılır.
    const value = valueAt(entry.payload, operand.field);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (!Number.isSafeInteger(operand.value) || operand.value < 0) return null;
  if (operand.field) return valueAt(entry.payload, operand.field) === operand.value ? operand.value : null;
  if (Array.isArray(operand.taskIds)) return operand.value === 0 ? null : explicitRows(entry, operand.taskIds, operand.value) ? operand.value : null;
  return null;
}

/** Sunucunun yüzde kuralları: pay (küçük pay kesirli, uçlar 0/100 değil) ve tamamlanma (tam sayıya yuvarlama). */
export function evidencePercent(numerator, denominator, rule) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0 || numerator < 0 || numerator > denominator) return null;
  if (rule === 'round') {
    // Tamamlanma oranı (taskCompletionRate): tam sayıya yuvarlanır; %100 ve %0 yalnızca uçlarda.
    const rate = Math.round((numerator / denominator) * 100);
    return numerator < denominator && rate >= 100 ? 99 : numerator > 0 && rate <= 0 ? 1 : rate;
  }
  const raw = (numerator / denominator) * 100;
  const share = numerator > 0 && numerator < denominator ? (raw < 1 ? raw : Math.min(99, Math.round(raw))) : Math.round(raw);
  if (rule !== 'majority') return share;
  // Çoğunluk: tam sayı %50 gösterecekse en az ondalıkla aşağı kesilir (groundedPropositions.majorityPercent ile aynı kural).
  if (numerator * 2 <= denominator) return null;
  if (share > 50) return share;
  for (let digits = 1; digits <= 6; digits += 1) {
    const scale = 10 ** digits;
    const shown = Math.floor((numerator * 100 * scale) / denominator) / scale;
    if (shown > 50) return shown;
  }
  return null;
}

/** Yanıttaki yüzde biçimi: küçük kesir üç anlamlı basamak, çoğunluk ondalığı olduğu gibi, diğerleri tam sayı. */
const percentText = (value) => `%${new Intl.NumberFormat('tr-TR', value > 0 && value < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 6 }).format(value)}`;

function calcCard(base, bind, entries) {
  const numerator = operandValue(bind.numerator, entries);
  const denominator = operandValue(bind.denominator, entries);
  const shown = evidencePercent(numerator, denominator, bind.rule);
  // Yanıtta gösterilen yüzde sunucunun yeniden hesabıyla birebir aynı değilse kart yoktur.
  if (shown == null || shown !== bind.shown) return null;
  const exact = (numerator * 100) % denominator === 0;
  return { ...base, kind: 'calc', title: cleanText(bind.title) || 'Hesaplama', tone: bind.tone || 'neutral',
    metrics: [{ label: cleanText(bind.numerator.label) || 'Pay', value: formatInt(numerator) }, { label: cleanText(bind.denominator.label) || 'Payda', value: formatInt(denominator) }],
    result: percentText(shown), formula: `${formatInt(numerator)} / ${formatInt(denominator)} × 100 ${exact ? '=' : '≈'} ${percentText(shown)}`,
    ...(!exact ? { note: bind.rule === 'round' ? 'Sonuç tam sayıya yuvarlanmıştır.' : 'Sonuç yuvarlanmıştır; sıfır ya da tamamı olmayan pay %0 veya %100 gösterilmez.' } : {}) };
}

function compareCard(base, bind, entries) {
  if (!Array.isArray(bind.items) || bind.items.length !== 2) return null;
  const values = bind.items.map((item) => operandValue(item, entries));
  if (values.some((value) => value == null)) return null;
  const gap = values[1] - values[0];
  // Değişim oranı yalnızca yanıt yazdıysa ve sunucunun kuralıyla (|fark| / önceki × 100, yuvarlanmış) birebir aynıysa gösterilir.
  if (bind.rate != null && (values[0] <= 0 || Math.round((Math.abs(gap) / values[0]) * 100) !== bind.rate)) return null;
  const change = bind.rate != null ? `${gap > 0 ? 'artış' : 'azalış'} %${formatInt(bind.rate)}` : null;
  return { ...base, kind: 'compare', title: cleanText(bind.title) || 'Karşılaştırma', tone: bind.tone || 'neutral',
    metrics: bind.items.map((item, index) => ({ label: cleanText(item.label) || `Değer ${index + 1}`, value: formatInt(values[index]) })),
    result: gap === 0 ? 'Fark yok' : `Fark: ${gap > 0 ? '+' : '−'}${formatInt(Math.abs(gap))}${change ? ` (${change})` : ''}`,
    ...(change ? { formula: `|${formatInt(values[1])} − ${formatInt(values[0])}| / ${formatInt(values[0])} × 100 ≈ %${formatInt(bind.rate)}` } : {}) };
}

/** Bağın dayandığı kanıt kimlikleri (hesap ve karşılaştırma birden çok kanıta dayanabilir). */
function bindEvidence(bind) {
  if (bind.type === 'calc') return [bind.numerator?.evidenceId, bind.denominator?.evidenceId];
  if (bind.type === 'compare') return (bind.items || []).map((item) => item?.evidenceId);
  return [bind.evidenceId];
}

/**
 * Bağın kartı; kanıtla tutarsız bağ `null`. Görev koleksiyonu kartının nüfusu aynı kanıtın görev arama satırlarıdır:
 * sayı kanıtın kesin toplamına eşit olmalı ya da kanıt tam ve satır sayısı sayıya eşit olmalıdır; satır sayısı sayıyı
 * aşamaz. Satırlar sayıdan azsa kart kısmi önizlemedir (tarayıcı bunu açıkça yazar). ICE-2 bağları (alan yolu, açık alt küme,
 * varlık, hesap, karşılaştırma) aynı kapalı ret kuralıyla yükten ve canlı nüfus kaydından doğrulanır.
 */
function cardFor(bind, entries, summaries, budget = EVIDENCE_CARD_LIMITS.maxItemsPerCard) {
  const evidenceIds = bindEvidence(bind);
  if (!evidenceIds.length || evidenceIds.some((id) => !entries.has(id) || typeof summaries.get(id)?.generatedAt !== 'string')) return null;
  const summary = summaries.get(evidenceIds[0]);
  const base = { generatedAt: summary.generatedAt, scopePartial: evidenceIds.some((id) => summaries.get(id).partial === true) };
  if (bind.type === 'calc') return calcCard(base, bind, entries);
  if (bind.type === 'compare') return compareCard(base, bind, entries);
  const entry = entries.get(bind.evidenceId);
  if (!entry?.payload || typeof entry.payload !== 'object' || entry.payload.tool !== entry.tool) return null;
  if (bind.type === 'entity') return entityCard(base, bind, entry, budget);
  if (budget < 1 && bind.type !== 'entities') return null;
  if (bind.type === 'entities') return collectionCard(base, bind, entry);
  if (bind.type === 'tasks' && bind.field) {
    const set = registeredSet(entry, bind.field, bind.count);
    return set ? taskCollection(base, set, bind.count, bind, budget) : null;
  }
  if (bind.type === 'tasks' && Array.isArray(bind.fields)) {
    const set = unionSet(entry, bind.fields, bind.count);
    return set ? taskCollection(base, set, bind.count, bind, budget) : null;
  }
  if (bind.type === 'tasks' && bind.predicate) {
    const rows = predicateRows(entry, bind.predicate, bind.count);
    return rows ? taskCollection(base, rows, bind.count, bind, budget) : null;
  }
  if (bind.type === 'tasks' && bind.taskIds) {
    const rows = explicitRows(entry, bind.taskIds, bind.count);
    return rows ? taskCollection(base, rows, bind.count, bind, budget) : null;
  }
  return searchCard(bind, entry, base, budget);
}

function searchCard(bind, entry, base, budget = EVIDENCE_CARD_LIMITS.maxItemsPerCard) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== 'object' || entry.tool !== 'rota_task_search' || payload.tool !== 'rota_task_search') return null;
  const rows = payload.data?.tasks;
  if (!Array.isArray(rows) || !rows.length) return null;
  if (bind.type === 'tasks') {
    const { count } = bind;
    if (!Number.isSafeInteger(count) || count < 1 || rows.length > count) return null;
    const exact = Number.isSafeInteger(payload.totalCount) && payload.totalCount === count;
    if (!exact && !(payload.complete === true && payload.truncated !== true && rows.length === count)) return null;
    const projected = rows.slice(0, Math.min(budget, EVIDENCE_CARD_LIMITS.maxItemsPerCard)).map((row) => projectTask(row, entry.cardAssignments?.get(row?.taskId)));
    if (!projected.length || projected.some((row) => !row)) return null;
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

/** Kartın kimliği bağın anlamıdır (tür + kanıt + nüfus): aynı nüfusu söyleyen iki ifade aynı kartı paylaşır. */
function bindKey(bind) {
  if (bind.type === 'task') return `task:${bind.evidenceId}:${canonicalActualId(bind.taskId)}`;
  if (bind.type === 'tasks') return `tasks:${bind.evidenceId}:${bind.field || (bind.fields || []).join('+')}:${bind.taskIds ? bind.taskIds.join(',') : ''}:${bind.predicate || ''}:${bind.count}`;
  if (bind.type === 'entity') return `entity:${bind.evidenceId}:${bind.row}`;
  if (bind.type === 'entities') return `entities:${bind.evidenceId}:${(bind.rows || []).join(',')}`;
  const operand = (item) => `${item?.evidenceId}:${item?.field || (item?.taskIds || []).join(',')}:${item?.value}`;
  if (bind.type === 'calc') return `calc:${operand(bind.numerator)}/${operand(bind.denominator)}:${bind.shown}:${bind.rule}`;
  if (bind.type === 'compare') return `compare:${(bind.items || []).map(operand).join('|')}:${bind.rate ?? ''}`;
  return null;
}

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
  const rejected = new Set();
  // Satır bütçesi kartlara adil bölünür: çok kartlı yanıtta her görev kartı daha kısa (ama en az 5 satırlık) önizleme taşır; ilk
  // kartlar bütçeyi tüketip sonrakileri düşürmez. Kısmi önizleme kartta açıkça yazılır.
  const rowBearing = new Set(evidenceBindings.anchors.map((anchor) => evidenceBindings.bindings[anchor.key - 1])
    .filter((bind) => bind && ['tasks', 'task', 'entity'].includes(bind.type)).map(bindKey).filter(Boolean)).size;
  const share = Math.max(5, Math.min(EVIDENCE_CARD_LIMITS.maxItemsPerCard, Math.floor(EVIDENCE_CARD_LIMITS.maxTotalItems / Math.max(1, rowBearing))));
  for (const anchor of evidenceBindings.anchors) {
    if (anchors.length >= EVIDENCE_CARD_LIMITS.maxAnchors) break;
    const bind = evidenceBindings.bindings[anchor.key - 1];
    if (!bind || typeof bind !== 'object' || finalStrong[anchor.strong] !== anchor.text) continue;
    const key = bindKey(bind);
    if (!key || rejected.has(key)) continue;
    let id = cardIds.get(key);
    if (!id) {
      if (cards.length >= EVIDENCE_CARD_LIMITS.maxCards) continue;
      const card = cardFor(bind, entryById, summaryById, Math.min(share, EVIDENCE_CARD_LIMITS.maxTotalItems - totalItems));
      const size = card?.items?.length || 0;
      if (!card || totalItems + size > EVIDENCE_CARD_LIMITS.maxTotalItems) { rejected.add(key); continue; }
      id = `c${cards.length + 1}`;
      cards.push({ id, ...card });
      cardIds.set(key, id);
      cardEvidence.set(id, bindEvidence(bind));
      totalItems += size;
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
  const evidenceIds = [...new Set(normalized.cards.flatMap((card) => cardEvidence.get(card.id) || []).filter(Boolean))];
  return { descriptor: normalized, evidenceIds };
}
