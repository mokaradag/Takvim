import 'server-only';
import { taskCompletionRate } from '../../../../scheduling/metrics/taskCompletionRate.js';
import { createHash } from 'node:crypto';
import { PRIORITIES, normalizePriorityId, normalizeTaskStatus } from '../../../../domain/constants/index.js';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { invalidArguments } from '../toolErrors.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { fixedDecimal, scaledDecimal, decimalFromScaled } from '../../../../domain/numbers/fixedDecimal.js';

/**
 * Görev olgularının BELİRLENİMCİ hesapları (SQL'siz, saf).
 *
 * Tanımlar ürünün kendi kurallarıdır ve tek yerde durur:
 *  - Durum: veritabanı `planned` → `todo` (Yapılacak), `in-progress` →
 *    `in_progress` (Devam ediyor), `done` → `done` (Tamamlandı).
 *  - Gecikme (getStatus / selectTaskStats ile aynı): tamamlanmamış VE termini
 *    (TargetFinish) bugünden önce. Planlanan bitiş gecikme ölçüsü DEĞİLDİR.
 *  - Takvim günü (Takvim ve Outlook ile aynı, taskCalendarDate): termin, yoksa
 *    planlanan bitiş.
 *  - Tamamlanma tarihi yalnızca gerçekleşen bitiştir (taskCompletionDate).
 *  - "Bugün" Türkiye iş günüdür (Europe/Istanbul); tur boyunca sabittir.
 *  - Saat ve bütçe alanlarında NULL "bilinmiyor"dur, sıfır değildir; toplamlar
 *    kapsama sayısıyla birlikte verilir. Para birimi Rota'da tutulmaz.
 */

export const TASK_STATUS_LABELS = Object.freeze({ todo: 'Yapılacak', in_progress: 'Devam ediyor', done: 'Tamamlandı' });
export const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'done']);
export const TASK_PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const DEADLINE_FILTERS = Object.freeze(['overdue', 'due_today', 'due_next_7_days', 'due_next_30_days', 'no_target_finish']);
export const DATE_FIELDS = Object.freeze(['targetFinish', 'calendarDate', 'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish']);
export const TASK_SORTS = Object.freeze([
  'target_finish_asc', 'target_finish_desc', 'overdue_days_desc', 'priority', 'planned_start_asc', 'updated_desc', 'title_asc'
]);
/** "Önümüzdeki 7/30 gün" bugün DAHİL 7/30 takvim günüdür. */
export const DUE_SOON_DAYS = 7;
export const DUE_MONTH_DAYS = 30;

const DAY_MS = 86400000;

export function taskStatus(value) {
  return normalizeTaskStatus(value);
}

/** Veritabanı durum değeri (kaba SQL süzgeci için). */
export function dbStatus(status) {
  return { todo: 'planned', in_progress: 'in-progress', done: 'done' }[status];
}

export function priorityLabel(priority) {
  return PRIORITIES[normalizePriorityId(priority)].label;
}

/** SQL `date` sütunu → `YYYY-MM-DD` (sürücü UTC gece yarısı `Date` döndürür). */
export function sqlDay(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function sqlInstant(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function addDays(day, count) {
  return sqlDay(new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS));
}

/** `to - from` takvim günü. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function factFromRow(row) {
  const targetFinish = sqlDay(row.TargetFinish);
  const plannedFinish = sqlDay(row.PlannedFinish);
  const assigneeCount = Math.max(0, Number(row.AssigneeCount) || 0);
  const resolvedAssigneeCount = row.ResolvedAssigneeCount == null
    ? assigneeCount
    : Math.max(0, Number(row.ResolvedAssigneeCount) || 0);
  return {
    id: canonicalActualId(row.TaskId),
    projectId: canonicalActualId(row.ProjectId),
    wbsId: row.WbsId ? canonicalActualId(row.WbsId) : null,
    title: String(row.Title ?? ''),
    keyword: row.Keyword ? String(row.Keyword) : '',
    status: taskStatus(row.Status),
    priority: normalizePriorityId(row.Priority),
    milestone: Boolean(row.IsMilestone),
    plannedStart: sqlDay(row.PlannedStart),
    plannedFinish,
    plannedDurationDays: numberOrNull(row.PlannedDurationDays),
    targetFinish,
    calendarDate: targetFinish || plannedFinish || null,
    actualStart: sqlDay(row.ActualStart),
    actualFinish: sqlDay(row.ActualFinish),
    progress: numberOrNull(row.Progress),
    plannedHours: numberOrNull(row.PlannedHours),
    actualHours: numberOrNull(row.ActualHours),
    budget: fixedDecimal(row.Budget, 4),
    spent: fixedDecimal(row.Spent, 4),
    recurrenceRule: row.RecurrenceRule ? String(row.RecurrenceRule) : null,
    recurrenceParentId: row.RecurrenceParentTaskId ? canonicalActualId(row.RecurrenceParentTaskId) : null,
    recurrenceOccurrenceDate: sqlDay(row.RecurrenceOccurrenceDate),
    createdAt: sqlInstant(row.CreatedAt),
    updatedAt: sqlInstant(row.UpdatedAt),
    accessLevel: row.AccessLevel === 'FULL' ? 'FULL' : 'PARTIAL',
    identityBase: Boolean(row.IdentityBase),
    isCreator: Boolean(row.IsCreator),
    isOwnAssignee: Boolean(row.IsOwnAssignee),
    hasAssignee: row.HasAssignee == null ? assigneeCount > 0 : Boolean(row.HasAssignee),
    assigneeCount,
    resolvedAssigneeCount
  };
}

/* ── Gecikme ve termin ─────────────────────────────────────── */

export function isOpen(fact) {
  return fact.status !== 'done';
}

export function isOverdue(fact, today) {
  return isOpen(fact) && Boolean(fact.targetFinish) && fact.targetFinish < today;
}

export function overdueDays(fact, today) {
  return isOverdue(fact, today) ? daysBetween(fact.targetFinish, today) : 0;
}

export function isDueWithin(fact, today, days) {
  return isOpen(fact) && Boolean(fact.targetFinish) && fact.targetFinish >= today && fact.targetFinish <= addDays(today, days - 1);
}

export function deadlineMatches(fact, deadline, today) {
  switch (deadline) {
    case 'overdue': return isOverdue(fact, today);
    case 'due_today': return isOpen(fact) && fact.targetFinish === today;
    case 'due_next_7_days': return isDueWithin(fact, today, DUE_SOON_DAYS);
    case 'due_next_30_days': return isDueWithin(fact, today, DUE_MONTH_DAYS);
    case 'no_target_finish': return isOpen(fact) && !fact.targetFinish;
    default: return true;
  }
}

/** Gecikme yaşlandırma kovaları (planHealth ile aynı sınırlar, gün dahil). */
export const OVERDUE_AGING = Object.freeze([
  Object.freeze({ id: '1-7', label: '1–7 gün', min: 1, max: 7 }),
  Object.freeze({ id: '8-30', label: '8–30 gün', min: 8, max: 30 }),
  Object.freeze({ id: '31-90', label: '31–90 gün', min: 31, max: 90 }),
  Object.freeze({ id: '91+', label: '91+ gün', min: 91, max: Number.POSITIVE_INFINITY })
]);

/* ── Metin eşleşmesi ───────────────────────────────────────── */

/** SQL Turkish_100_CI_AI ile aynı Türkçe I/İ gruplarını koruyan karşılaştırma anahtarı. */
export function foldText(value) {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function textMatches(fact, text) {
  if (!text) return true;
  return foldText(`${fact.title} ${fact.keyword}`).includes(foldText(text));
}

/* ── Süzgeçler ─────────────────────────────────────────────── */

/**
 * Modelin bağımsız değişkenlerinden görev süzgeci. Sorumlu kipleri birbirini
 * dışlar; ters tarih aralığı ve tarih alanı olmadan aralık reddedilir.
 */
export function normalizeTaskFilters(args = {}) {
  const filters = {
    text: args.text || '',
    projectId: args.projectId || null,
    wbsId: args.wbsId || null,
    statuses: args.status ? [...args.status] : [],
    priorities: args.priority ? [...args.priority] : [],
    deadline: args.deadline || null,
    dateField: args.dateField || null,
    dateFrom: args.dateFrom || null,
    dateTo: args.dateTo || null,
    assignee: args.assignee || 'any',
    personSicil: args.personSicil ?? null,
    createdByMe: args.createdByMe === true,
    milestone: typeof args.milestone === 'boolean' ? args.milestone : null
  };
  const problems = [];
  if (filters.personSicil != null && filters.assignee !== 'any') problems.push('$.personSicil:conflict');
  if ((filters.dateFrom || filters.dateTo) && !filters.dateField) filters.dateField = 'targetFinish';
  if (filters.dateField && !filters.dateFrom && !filters.dateTo) problems.push('$.dateField:range');
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) problems.push('$.dateFrom:reversed');
  if (problems.length) throw invalidArguments(problems);
  if (filters.personSicil != null) filters.assignee = 'person';
  return filters;
}

/** Ürün kuralları gereği yalnızca açık görevleri kapsayan süzgeç mi? (SQL'i daraltmak için) */
export function filtersOpenOnly(filters) {
  if (filters.statuses.length && !filters.statuses.includes('done')) return true;
  return Boolean(filters.deadline);
}

/**
 * SQL'e verilen kaba termin aralığı: yalnızca DARALTIR, sonuç aynı süzgeç
 * sunucu kodunda yeniden uygulanarak kesinleşir.
 */
export function coarseTargetRange(filters, today) {
  let from = null;
  let to = null;
  const narrow = (lower, upper) => {
    if (lower && (!from || lower > from)) from = lower;
    if (upper && (!to || upper < to)) to = upper;
  };
  if (filters.deadline === 'overdue') narrow(null, addDays(today, -1));
  if (filters.deadline === 'due_today') narrow(today, today);
  if (filters.deadline === 'due_next_7_days') narrow(today, addDays(today, DUE_SOON_DAYS - 1));
  if (filters.deadline === 'due_next_30_days') narrow(today, addDays(today, DUE_MONTH_DAYS - 1));
  if (filters.dateField === 'targetFinish') narrow(filters.dateFrom, filters.dateTo);
  return { from, to };
}

export function assigneeMatches(fact, filters, assignees, sicil) {
  switch (filters.assignee) {
    case 'me': return fact.isOwnAssignee;
    case 'unassigned': return assignmentState(fact) === 'unassigned';
    case 'person': return (assignees.get(fact.id) || []).some((person) => person.identityVisible && person.sicil === filters.personSicil)
      || (filters.personSicil === sicil && fact.isOwnAssignee);
    default: return true;
  }
}

export function assignmentState(fact) {
  if (fact.hasAssignee === false || (fact.hasAssignee == null && fact.assigneeCount === 0)) return 'unassigned';
  if (fact.resolvedAssigneeCount > 0) return 'visible';
  return fact.identityBase ? 'unresolved' : 'hidden';
}

export function matchesTaskFilters(fact, filters, { today, assignees = new Map(), sicil = null }) {
  if (filters.projectId && fact.projectId !== filters.projectId) return false;
  if (filters.wbsId && fact.wbsId !== filters.wbsId) return false;
  if (filters.statuses.length && !filters.statuses.includes(fact.status)) return false;
  if (filters.priorities.length && !filters.priorities.includes(fact.priority)) return false;
  if (filters.milestone != null && fact.milestone !== filters.milestone) return false;
  if (filters.createdByMe && !fact.isCreator) return false;
  if (filters.deadline && !deadlineMatches(fact, filters.deadline, today)) return false;
  if (filters.dateField) {
    const value = fact[filters.dateField];
    if (!value) return false;
    if (filters.dateFrom && value < filters.dateFrom) return false;
    if (filters.dateTo && value > filters.dateTo) return false;
  }
  if (!textMatches(fact, filters.text)) return false;
  return assigneeMatches(fact, filters, assignees, sicil);
}

/* ── Sıralama ──────────────────────────────────────────────── */

const PRIORITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const collator = new Intl.Collator('tr-TR', { sensitivity: 'base' });

function compareNullableDay(left, right, direction = 1) {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? -direction : direction;
}

function tieBreak(left, right) {
  return collator.compare(left.title, right.title) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function sortFacts(facts, sort, today) {
  const comparators = {
    target_finish_asc: (left, right) => compareNullableDay(left.targetFinish, right.targetFinish, 1),
    target_finish_desc: (left, right) => compareNullableDay(left.targetFinish, right.targetFinish, -1),
    overdue_days_desc: (left, right) => overdueDays(right, today) - overdueDays(left, today)
      || compareNullableDay(left.targetFinish, right.targetFinish, 1),
    priority: (left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      || compareNullableDay(left.targetFinish, right.targetFinish, 1),
    planned_start_asc: (left, right) => compareNullableDay(left.plannedStart, right.plannedStart, 1),
    updated_desc: (left, right) => compareNullableDay(left.updatedAt, right.updatedAt, -1),
    title_asc: () => 0
  };
  const compare = comparators[sort] || comparators.target_finish_asc;
  return [...facts].sort((left, right) => compare(left, right) || tieBreak(left, right));
}

/* ── İmleç ─────────────────────────────────────────────────── */

function argumentsHash(tool, filters) {
  return createHash('sha256').update(`${tool}\u0000${JSON.stringify(filters)}`).digest('base64url').slice(0, 16);
}

/** Opak sayfa imleci; başka araç ya da başka süzgeç için üretilmiş imleç reddedilir. */
export function encodeCursor(tool, filters, offset) {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, h: argumentsHash(tool, filters) }), 'utf8').toString('base64url');
}

export function decodeCursor(tool, filters, cursor) {
  if (cursor == null) return 0;
  let value;
  try {
    value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw invalidArguments(['$.cursor:invalid']);
  }
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.o) || value.o < 0 || value.o > TOOL_LIMITS.maxCursorOffset
    || value.h !== argumentsHash(tool, filters)) {
    throw invalidArguments(['$.cursor:invalid']);
  }
  return value.o;
}

/** Sıralı dizinin sayfası ve bir sonraki imleç. */
export function paginate(tool, filters, items, { limit, cursor, anchor = items }) {
  const snapshot = createHash('sha256').update(JSON.stringify(anchor)).digest('base64url');
  const anchoredFilters = { filters, snapshot };
  const offset = decodeCursor(tool, anchoredFilters, cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < items.length && nextOffset <= TOOL_LIMITS.maxCursorOffset
    ? encodeCursor(tool, anchoredFilters, nextOffset)
    : null;
  return { page, offset, nextCursor };
}

/* ── Sorumlular ────────────────────────────────────────────── */

/** Sorumlu satırlarını görev başına, ada göre sıralı olarak toplar. */
export function assigneesByTask(rows = []) {
  const byTask = new Map();
  for (const row of rows) {
    const taskId = canonicalActualId(row.TaskId);
    if (!taskId) continue;
    const identityVisible = Boolean(row.IdentityVisible);
    const person = {
      sicil: identityVisible && row.Sicil != null ? Number(row.Sicil) : null,
      name: row.DisplayName && String(row.DisplayName).trim() !== String(row.Sicil) ? String(row.DisplayName).trim() : null,
      identityVisible,
      resolved: row.Resolved == null ? true : Boolean(row.Resolved)
    };
    if (!person.name && person.sicil == null) continue;
    if (!byTask.has(taskId)) byTask.set(taskId, []);
    byTask.get(taskId).push(person);
  }
  for (const list of byTask.values()) {
    list.sort((left, right) => collator.compare(left.name || '', right.name || '') || (left.sicil ?? 0) - (right.sicil ?? 0));
  }
  return byTask;
}

/** Model için sorumlu görünümü: kimliği açık kişi Sicil ile, kapalı eş sorumlu yalnızca adıyla. */
export function assigneeView(fact, assignees) {
  const visible = assignees.get(fact.id) || [];
  const people = visible.map((person) => (person.identityVisible
    ? { name: person.name || 'Seçilen kişi', sicil: person.sicil }
    : { name: person.name, identityHidden: true }));
  return { assignees: people };
}

/* ── Toplamlar ─────────────────────────────────────────────── */

export function hoursCoverage(facts) {
  const metric = (field, scale) => {
    const known = facts.filter((fact) => fact[field] != null);
    const total = known.length ? decimalFromScaled(known.reduce((sum, fact) => sum + scaledDecimal(fact[field], scale), 0n), scale) : null;
    return { total, tasksWithValue: known.length, tasksWithoutValue: facts.length - known.length };
  };
  return {
    taskCount: facts.length,
    plannedHours: metric('plannedHours', 2),
    actualHours: metric('actualHours', 2),
    budget: metric('budget', 4),
    spent: metric('spent', 4),
    note: 'Boş (NULL) değer sıfır sayılmaz; toplam yalnızca değeri girilmiş görevler üzerindedir. Rota para birimi tutmaz.'
  };
}

export function statusTotals(facts, today) {
  const totals = {
    total: facts.length,
    todo: 0,
    inProgress: 0,
    done: 0,
    open: 0,
    overdue: 0,
    dueToday: 0,
    dueNext7Days: 0,
    openWithoutTargetFinish: 0,
    doneWithoutActualFinish: 0,
    milestonesOpen: 0
  };
  for (const fact of facts) {
    if (fact.status === 'done') {
      totals.done += 1;
      if (!fact.actualFinish) totals.doneWithoutActualFinish += 1;
      continue;
    }
    totals.open += 1;
    if (fact.status === 'in_progress') totals.inProgress += 1;
    else totals.todo += 1;
    if (isOverdue(fact, today)) totals.overdue += 1;
    if (fact.targetFinish === today) totals.dueToday += 1;
    if (isDueWithin(fact, today, DUE_SOON_DAYS)) totals.dueNext7Days += 1;
    if (!fact.targetFinish) totals.openWithoutTargetFinish += 1;
    if (fact.milestone) totals.milestonesOpen += 1;
  }
  totals.completionRatePercent = taskCompletionRate(totals.done, facts.length);
  return totals;
}

export function overdueAging(facts, today) {
  const buckets = OVERDUE_AGING.map((bucket) => ({ id: bucket.id, label: bucket.label, count: 0 }));
  let worst = 0;
  for (const fact of facts) {
    const late = overdueDays(fact, today);
    if (late < 1) continue;
    worst = Math.max(worst, late);
    const index = OVERDUE_AGING.findIndex((bucket) => late >= bucket.min && late <= bucket.max);
    if (index >= 0) buckets[index].count += 1;
  }
  return { buckets, worstOverdueDays: worst };
}

export function statusLabelOf(status) {
  return TASK_STATUS_LABELS[status] || TASK_STATUS_LABELS.todo;
}
