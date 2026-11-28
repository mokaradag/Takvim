import 'server-only';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { sql } from '../../../db/pool.js';
import { bindScope } from './rotaScope.js';
import {
  AI_TOOL_BASELINE_SQL,
  AI_TOOL_CALENDAR_SQL,
  AI_TOOL_DEPENDENCIES_SQL,
  AI_TOOL_OUTLOOK_SQL,
  AI_TOOL_PORTFOLIO_SQL,
  AI_TOOL_PROJECT_DETAIL_SQL,
  AI_TOOL_PROJECT_SEARCH_SQL,
  AI_TOOL_TASK_DETAIL_SQL,
  AI_TOOL_TASK_FACTS_SQL,
  AI_TOOL_TASK_VISIBILITY_SQL,
  AI_TOOL_WBS_SQL,
  AI_TOOL_WBS_SELECTOR_SQL,
  AI_TOOL_TASK_NOTES_SQL,
  AI_TOOL_REPORT_TASK_NOTES_SQL,
  AI_TOOL_REPORT_NOTE_AUDIT_SQL,
  AI_TOOL_REPORT_SCOPE_ROSTER_SQL,
  AI_TOOL_REPORT_PROJECT_SELECTORS_SQL,
  AI_TOOL_REPORT_DEPENDENCIES_SQL,
  AI_TOOL_REPORT_ACTIVITY_SUMMARY_SQL
} from './rotaToolQueries.js';
import { readTaskActivityReport } from '../../../reports/taskActivityReport.js';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { assigneesByTask, factFromRow } from './taskFacts.js';

/** Tek toplu işte okunan ekip kadrosunun satır sınırı. */
export const TEAM_ROSTER_LIMIT = 50;

/**
 * Araç SQL'inin TEK yürütücüsü.
 *
 * Yalnızca `rotaToolQueries.js` içindeki sabit metinler çalıştırılır; her
 * değer parametredir. Yürütücü çağıranın verdiği sınırlı yürütücüdür (araç
 * SQL kapısı, süre sınırı ve iptal; bkz. toolContext.js).
 */

const recordsets = (result) => result?.recordsets || [];

function scoped(executor, scope, options) {
  const request = bindScope(executor.request(), sql, scope, options);
  const query = request.query.bind(request);
  request.query = async (statement) => {
    try { return await query(statement); } catch (error) {
      const number = error?.number ?? error?.originalError?.info?.number;
      if (number === 51001 || ([AI_TOOL_WBS_SQL, AI_TOOL_WBS_SELECTOR_SQL].includes(statement) && number === 530)) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      // İstenen ekip düzeyinde yönetim kapsamı yok (kullanıcının kendi yetki bağlamı; başka kayıt açıklanmaz).
      if (number === 51002 && statement === AI_TOOL_TASK_FACTS_SQL) throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Ekip kapsamı yalnızca yönetim kapsamı olan kullanıcılara açıktır.', details: ['$.assignee:team'] });
      throw error;
    }
  };
  request.input('sourceFilter', sql.VarChar(12), options?.source || 'all');
  request.input('projectSearchText', sql.NVarChar(160), options?.projectSearchText || '');
  request.input('analysisMaxRows', sql.Int, TOOL_LIMITS.maxAnalyzedTasks + 1);
  request.input('analysisAssignmentRows', sql.Int, TOOL_LIMITS.maxAnalyzedAssignments + 1);
  return request;
}

/** Toplamın dayandığı görev nüfusu (güncel proje kimliğiyle). */
function populationOf(rows = []) {
  return rows.map((row) => ({ taskId: canonicalActualId(row.TaskId), projectId: canonicalActualId(row.ProjectId) }))
    .filter((row) => row.taskId);
}

/** `rows.length > limit` ise sonuç kesilmiştir; en fazla `limit` satır döner. */
function capped(rows = [], limit) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function readTaskFacts(executor, scope, {
  projectId = null, projectIds = [], taskIds = [], wbsId = null, seriesId = null, recurringOnly = false, text = '',
  openOnly = false, targetFrom = null, targetTo = null, createdByMe = false, hasDescription = false, includeUndated = false,
  statuses = [], priorities = [], milestone = null, deadline = null,
  dateField = null, dateFrom = null, dateTo = null, today = null, cutOffUtc = null,
  assigneeMode = 'any', personSicil = null, teamLevel = null, assigneeSicils = [], includeHasDescription = true,
  withAssignees = false, maxRows, rosterRows = 0
}) {
  const normalizedCutOff = normalizeCutOffUtc(cutOffUtc, { required: false });
  const request = scoped(executor, scope, { projectId, projectIds, taskIds });
  request.input('maxRows', sql.Int, maxRows + 1);
  request.input('wbsId', sql.UniqueIdentifier, wbsId);
  request.input('seriesId', sql.UniqueIdentifier, seriesId);
  request.input('recurringOnly', sql.Bit, recurringOnly ? 1 : 0);
  request.input('text', sql.NVarChar(120), text || '');
  request.input('openOnly', sql.Bit, openOnly ? 1 : 0);
  request.input('targetFrom', sql.Date, targetFrom);
  request.input('targetTo', sql.Date, targetTo);
  request.input('statusCsv', sql.VarChar(80), statuses.join(','));
  request.input('priorityCsv', sql.VarChar(80), priorities.join(','));
  request.input('milestone', sql.Bit, milestone);
  request.input('deadline', sql.VarChar(24), deadline);
  request.input('dateField', sql.VarChar(24), dateField);
  request.input('dateFrom', sql.Date, dateFrom);
  request.input('dateTo', sql.Date, dateTo);
  request.input('today', sql.Date, today);
  request.input('cutOffUtc', sql.DateTime2, normalizedCutOff);
  request.input('hasDescription', sql.Bit, hasDescription ? 1 : 0);
  request.input('includeUndated', sql.Bit, includeUndated ? 1 : 0);
  request.input('createdByMe', sql.Bit, createdByMe ? 1 : 0);
  request.input('assigneeMode', sql.VarChar(12), assigneeMode);
  request.input('personSicil', sql.Int, personSicil);
  request.input('teamLevel', sql.VarChar(20), teamLevel || '');
  const safeAssigneeSicils = [...new Set((assigneeSicils || []).map(Number).filter((s) => Number.isSafeInteger(s) && s > 0))];
  request.input('assigneeSicils', sql.NVarChar(sql.MAX), safeAssigneeSicils.join(','));
  request.input('includeHasDescription', sql.Bit, includeHasDescription ? 1 : 0);
  request.input('withAssignees', sql.Bit, withAssignees ? 1 : 0);
  // Aşama G: ekip kadrosu yalnızca istenirse ve ekip süzgeciyle aynı toplu işte okunur (`rosterRows` + 1 kesikliği gösterir).
  const withRoster = rosterRows > 0 && assigneeMode === 'team';
  request.input('withRoster', sql.Bit, withRoster ? 1 : 0);
  request.input('rosterRows', sql.Int, withRoster ? rosterRows + 1 : 0);
  const sets = recordsets(await request.query(AI_TOOL_TASK_FACTS_SQL));
  const [factRows = [], projectRows = [], assigneeRows = []] = sets;
  const rosterRowsRead = withRoster ? (sets[3] || []) : [];
  const postCutoffRows = normalizedCutOff ? (sets[withRoster ? 4 : 3] || []) : [];
  const auditTransitionRows = normalizedCutOff ? (sets[withRoster ? 5 : 4] || []) : [];
  const hasPostCutoffDeletion = Boolean(postCutoffRows[0]?.HasPostCutoffDeletion);
  const hasPostCutoffScopeMove = Boolean(postCutoffRows[0]?.HasPostCutoffScopeMove);
  const taskAuditTransitions = auditTransitionRows.map((row) => ({
    taskId: canonicalActualId(row.TaskId),
    lastCompletedAuditAt: row.LastCompletedAuditAt ? new Date(row.LastCompletedAuditAt).toISOString() : null,
    lastReopenAt: row.LastReopenAt ? new Date(row.LastReopenAt).toISOString() : null,
    lastReopenAuditId: row.LastReopenAuditId != null && Number.isFinite(Number(row.LastReopenAuditId)) ? Number(row.LastReopenAuditId) : null,
    lastTargetFinishChangeAt: row.LastTargetFinishChangeAt ? new Date(row.LastTargetFinishChangeAt).toISOString() : null,
    lastTargetFinishChangeAuditId: row.LastTargetFinishChangeAuditId != null && Number.isFinite(Number(row.LastTargetFinishChangeAuditId)) ? Number(row.LastTargetFinishChangeAuditId) : null
  })).filter((row) => Boolean(row.taskId));
  const { rows, truncated } = capped(factRows, maxRows);
  const roster = withRoster ? capped(rosterRowsRead, rosterRows) : null;
  return {
    facts: rows.map(factFromRow),
    truncated,
    hasPostCutoffDeletion,
    hasPostCutoffScopeMove,
    taskAuditTransitions,
    projects: projectRows,
    assignees: assigneesByTask(assigneeRows),
    ...(roster ? { roster: {
      members: roster.rows.map((row) => ({ sicil: Number(row.Sicil), name: row.DisplayName && String(row.DisplayName).trim() !== String(row.Sicil) ? String(row.DisplayName).trim() : null }))
        .filter((member) => Number.isSafeInteger(member.sicil) && member.sicil > 0),
      // Görev olguları okunurken üyelik değiştiyse kadro görev sayılarıyla aynı anı göstermez: tamlık için kesik sayılır.
      // Toplu iş, ekipte en az bir üye olduğunu baştan doğrular (yoksa kapalı ret); boş anlık görüntü bu yüzden üyeliğin
      // değiştiğini gösterir ve değişim işareti satırsız sonuçta taşınamaz: boş kadro hiçbir zaman tam sayılmaz.
      truncated: roster.truncated || roster.rows.length === 0 || roster.rows.some((row) => Number(row.MembershipChanged) === 1 || !(Number.isSafeInteger(Number(row.Sicil)) && Number(row.Sicil) > 0))
    } } : {})
  };
}

/** Verilen görevlerden şu an görünenler: `taskId → { projectId, identityBase, accessLevel }`. */
export async function readVisibleTasks(executor, scope, taskIds) {
  const request = scoped(executor, scope, { taskIds });
  const [rows = []] = recordsets(await request.query(AI_TOOL_TASK_VISIBILITY_SQL));
  return new Map(rows.map((row) => [canonicalActualId(row.TaskId), { projectId: canonicalActualId(row.ProjectId),
    identityBase: Boolean(row.IdentityBase), accessLevel: row.AccessLevel }]));
}

/** Açıklamanın yanıta taşınan Unicode kod noktası sınırı; sorgu kesikliği göstermek için bir fazla okur. */
export const TASK_NOTE_CHARS = 400;

/** Görünür görevlerin kesilmiş açıklamaları: `taskId → { text, clipped }` (bkz. AI_TOOL_TASK_NOTES_SQL). */
export async function readTaskNotes(executor, scope, taskIds) {
  if (!taskIds.length) return new Map();
  const request = scoped(executor, scope, { taskIds });
  const [rows = []] = recordsets(await request.query(AI_TOOL_TASK_NOTES_SQL));
  return new Map(rows.map((row) => {
    const characters = Array.from(String(row.Description ?? ''));
    return [canonicalActualId(row.TaskId), { text: characters.slice(0, TASK_NOTE_CHARS).join(''), clipped: characters.length > TASK_NOTE_CHARS }];
  }));
}

export async function readTaskDetail(executor, scope, taskId) {
  const request = scoped(executor, scope, { taskIds: [taskId] });
  request.input('withAssignees', sql.Bit, 1);
  // Ortak görev sütunları ekip bayrağını taşır; tek görev ayrıntısında süzgeç yoktur.
  request.input('assigneeMode', sql.VarChar(12), 'any');
  request.input('teamLevel', sql.VarChar(20), '');
  const [detailRows = [], chainRows = [], assigneeRows = []] = recordsets(await request.query(AI_TOOL_TASK_DETAIL_SQL));
  const row = detailRows[0] || null;
  if ([row?.PredecessorCount, row?.SuccessorCount].some((value) => Number(value) > TOOL_LIMITS.maxAnalyzedTasks)) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  return {
    row,
    fact: row ? factFromRow(row) : null,
    wbsChain: chainRows,
    assignees: assigneesByTask(assigneeRows)
  };
}

export async function readProjectSearch(executor, scope, { text, limit, projectId = null, projectIds = [] }) {
  const request = scoped(executor, scope, { projectId, projectIds, projectSearchText: text });
  request.input('text', sql.NVarChar(160), text);
  request.input('limit', sql.Int, limit);
  const [[count] = [], rows = [], population = []] = recordsets(await request.query(AI_TOOL_PROJECT_SEARCH_SQL));
  return { total: Number(count?.Total || 0), exactCount: Number(count?.ExactCount || 0), rows, projectIds: population.map((row) => canonicalActualId(row.ProjectId)) };
}

export async function readPortfolio(executor, scope, { today, soonEnd, source = 'all' }) {
  const request = scoped(executor, scope, { source });
  request.input('today', sql.Date, today);
  request.input('soonEnd', sql.Date, soonEnd);
  const [rows = [], populationRows = []] = recordsets(await request.query(AI_TOOL_PORTFOLIO_SQL));
  return { rows, population: populationOf(populationRows), snapshot: populationRows.map(factFromRow) };
}

export async function readProjectDetail(executor, scope, { projectId, today, soonEnd }) {
  const request = scoped(executor, scope, { projectId });
  request.input('today', sql.Date, today);
  request.input('soonEnd', sql.Date, soonEnd);
  const [projectRows = [], tagRows = [], [totals] = [], populationRows = []] = recordsets(await request.query(AI_TOOL_PROJECT_DETAIL_SQL));
  // Sayımlar sınır + 1 satırla yoklanır: sınırı aşan ölçü kesin sayı olarak verilmez, bilinmiyor olarak işaretlenir.
  const overLimit = (value) => value != null && Number(value) > TOOL_LIMITS.maxAnalyzedTasks;
  const row = projectRows[0] || null;
  const countsOverLimit = row ? ['DependencyCount', 'BaselineCount', 'WbsNodeCount'].filter((column) => overLimit(row[column])) : [];
  if (tagRows.length > TOOL_LIMITS.maxAnalyzedTasks) countsOverLimit.push('TagCount');
  const project = row ? { ...row, ...Object.fromEntries(countsOverLimit.filter((column) => column !== 'TagCount').map((column) => [column, null])) } : null;
  return {
    project,
    countsOverLimit,
    tags: tagRows.slice(0, TOOL_LIMITS.maxAnalyzedTasks).map((row) => String(row.TagName)),
    totals: totals || null,
    population: populationOf(populationRows)
  };
}

export async function readWbsSelector(executor, scope, { projectId = null, wbsId }) {
  const request = scoped(executor, scope, { projectId });
  request.input('wbsId', sql.UniqueIdentifier, wbsId);
  request.input('wbsIds', sql.NVarChar(sql.MAX), wbsId);
  const [[node] = []] = recordsets(await request.query(AI_TOOL_WBS_SELECTOR_SQL));
  return node || null;
}

/** Yalnızca istenen düğümlerin güncel görünürlüğü; görev sayıları veya bütün proje ağacı okunmaz. */
export async function readWbsVisibility(executor, scope, { projectId, wbsIds }) {
  const request = scoped(executor, scope, { projectId });
  request.input('wbsId', sql.UniqueIdentifier, null);
  request.input('wbsIds', sql.NVarChar(sql.MAX), wbsIds.join(','));
  const [nodes = []] = recordsets(await request.query(AI_TOOL_WBS_SELECTOR_SQL));
  return nodes;
}

export async function readWbs(executor, scope, { projectId, wbsId = null, today, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('today', sql.Date, today);
  request.input('wbsId', sql.UniqueIdentifier, wbsId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [nodeRows = [], countRows = [], projectRows = [], populationRows = []] = recordsets(await request.query(AI_TOOL_WBS_SQL));
  const { rows, truncated } = capped(nodeRows, maxRows);
  return { nodes: rows, truncated, counts: countRows, project: projectRows[0] || null, population: populationOf(populationRows) };
}

export async function readDependencies(executor, scope, { projectId, focusTaskId = null, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('focusTaskId', sql.UniqueIdentifier, focusTaskId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [dependencyRows = [], taskRows = [], [totals] = [], populationRows = []] = recordsets(await request.query(AI_TOOL_DEPENDENCIES_SQL));
  const { rows, truncated } = capped(dependencyRows, maxRows);
  return { dependencies: rows, truncated, tasks: taskRows, totals: totals || { TaskCount: 0, OpenCount: 0 }, population: populationOf(populationRows) };
}

export async function readBaseline(executor, scope, { projectId, baselineId = null, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('baselineId', sql.UniqueIdentifier, baselineId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [baselineRows = [], [selection] = [], snapshotRows = [], [added] = [], populationRows = []] = recordsets(await request.query(AI_TOOL_BASELINE_SQL));
  if (Number(selection?.BaselineTotal) > TOOL_LIMITS.maxAnalyzedTasks) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  const { rows, truncated } = capped(snapshotRows, maxRows);
  return {
    projectFull: Boolean(selection?.ProjectFull),
    selectedBaselineId: selection?.SelectedBaselineId || null,
    baselines: baselineRows,
    baselinesTruncated: Number(selection?.BaselineTotal || 0) > baselineRows.length,
    snapshots: rows,
    truncated,
    addedSinceBaseline: Number(added?.AddedSinceBaseline || 0),
    population: populationOf(populationRows)
  };
}

export async function readCalendar(executor, scope, { projectId = null, from, to }) {
  const request = scoped(executor, scope, { projectId });
  request.input('from', sql.Date, from);
  request.input('to', sql.Date, to);
  const [[calendar] = [], weekdayRows = [], holidayRows = []] = recordsets(await request.query(AI_TOOL_CALENDAR_SQL));
  return {
    projectVisible: Boolean(calendar?.ProjectVisible),
    calendar: calendar?.CalendarId ? calendar : null,
    workingDays: weekdayRows.map((row) => Number(row.Weekday)).filter((value) => Number.isInteger(value)),
    holidays: holidayRows
  };
}

export async function readOutlook(executor, scope, { taskIds = [], maxRows }) {
  const request = scoped(executor, scope, { taskIds });
  request.input('maxRows', sql.Int, maxRows + 1);
  const [subscriptionRows = []] = recordsets(await request.query(AI_TOOL_OUTLOOK_SQL));
  const { rows, truncated } = capped(subscriptionRows, maxRows);
  return {
    subscriptions: rows,
    truncated
  };
}

/** Yönetici raporunda tek görev notunun Unicode kod noktası sınırı (sohbet sınırı 400 değişmez). */
export const REPORT_TASK_NOTE_CHARS = 1600;

/** Veri kesiti zaman damgasını doğrular; geçersiz veya zorunlu olup eksikse kapalı reddeder. */
function normalizeCutOffUtc(cutOffUtc, { required = false } = {}) {
  if (cutOffUtc == null) {
    if (required) {
      throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
        message: 'Veri kesiti zaman damgası (cutOffUtc) zorunludur.'
      });
    }
    return null;
  }
  const date = cutOffUtc instanceof Date ? new Date(cutOffUtc.getTime()) : new Date(cutOffUtc);
  if (!Number.isFinite(date.getTime())) {
    throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
      message: 'Geçersiz veri kesiti zaman damgası (cutOffUtc).'
    });
  }
  return date;
}

/**
 * Yönetici raporu için görünür görevlerin güncel açıklamalarını (en çok 1600 kod noktası) ve tam metin özetini okur.
 * Yalnızca rapor düzeyinde açık `notlar: dahil` rızası doğrulandıktan sonra çağrılmalıdır.
 */
export async function readReportTaskNotes(executor, scope, taskIds, { maxRows = 60, cutOffUtc = null } = {}) {
  const normalizedCutOff = normalizeCutOffUtc(cutOffUtc, { required: false });
  if (!taskIds.length) return { notes: new Map(), truncated: false, withheldTaskIds: new Set() };
  const request = scoped(executor, scope, { taskIds });
  request.input('maxNoteRows', sql.Int, maxRows + 1);
  request.input('cutOffUtc', sql.DateTime2, normalizedCutOff);
  const [noteRows = [], withheldRows = []] = recordsets(await request.query(AI_TOOL_REPORT_TASK_NOTES_SQL));
  const { rows, truncated } = capped(noteRows, maxRows);
  const notes = new Map(rows.map((row) => {
    const characters = Array.from(String(row.Description ?? ''));
    return [canonicalActualId(row.TaskId), {
      projectId: canonicalActualId(row.ProjectId),
      text: characters.slice(0, REPORT_TASK_NOTE_CHARS).join(''),
      clipped: characters.length > REPORT_TASK_NOTE_CHARS,
      fullHash: row.DescriptionHash ? String(row.DescriptionHash) : null
    }];
  }));
  const withheldTaskIds = new Set(withheldRows.map((row) => canonicalActualId(row.TaskId)).filter(Boolean));
  return { notes, truncated, withheldTaskIds };
}

/**
 * Yönetici raporu için görünür görevlerin yetkili `MR_AuditLog` açıklama geçişlerini veri kesitine kadar okur.
 * Yalnızca rapor düzeyinde açık `notlar: dahil` rızası doğrulandıktan sonra çağrılmalıdır.
 */
export async function readReportNoteAuditHistory(executor, scope, taskIds, { cutOffUtc, maxRows = 250 } = {}) {
  const normalizedCutOff = normalizeCutOffUtc(cutOffUtc, { required: true });
  if (!taskIds.length) return { events: [], truncated: false, corruptedCount: 0 };
  const request = scoped(executor, scope, { taskIds });
  request.input('cutOffUtc', sql.DateTime2, normalizedCutOff);
  request.input('maxAuditRows', sql.Int, maxRows + 1);
  const [auditRows = []] = recordsets(await request.query(AI_TOOL_REPORT_NOTE_AUDIT_SQL));
  const { rows, truncated } = capped(auditRows, maxRows);
  const clipDesc = (raw) => {
    if (raw == null) return { text: null, clipped: false };
    const characters = Array.from(String(raw));
    return {
      text: characters.slice(0, REPORT_TASK_NOTE_CHARS).join(''),
      clipped: characters.length > REPORT_TASK_NOTE_CHARS
    };
  };
  let corruptedCount = 0;
  const events = rows.map((row) => {
    const malformed = Boolean(row.SnapshotMalformed);
    if (malformed) corruptedCount += 1;
    const before = clipDesc(row.BeforeDescription);
    const after = clipDesc(row.AfterDescription);
    return {
      auditId: Number(row.AuditId),
      occurredAt: row.OccurredAt ? new Date(row.OccurredAt).toISOString() : null,
      actionCode: String(row.ActionCode || ''),
      taskId: canonicalActualId(row.TaskId),
      projectId: canonicalActualId(row.ProjectId),
      beforeProjectId: canonicalActualId(row.BeforeProjectId),
      beforeDescription: before.text,
      afterDescription: after.text,
      beforeClipped: before.clipped,
      afterClipped: after.clipped,
      beforeHash: row.BeforeDescHash ? String(row.BeforeDescHash) : null,
      afterHash: row.AfterDescHash ? String(row.AfterDescHash) : null,
      beforeReadable: row.BeforeReadable !== undefined ? Boolean(row.BeforeReadable) : true,
      afterReadable: row.AfterReadable !== undefined ? Boolean(row.AfterReadable) : true,
      beforeOriginUnauthorized: Boolean(row.BeforeOriginUnauthorized),
      snapshotMalformed: malformed
    };
  });
  return { events, truncated, corruptedCount };
}

const ISTANBUL_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function istanbulDateParts(instantMs) {
  const parts = Object.fromEntries(
    ISTANBUL_CLOCK.formatToParts(new Date(instantMs))
      .filter((part) => part.type !== 'literal')
      .map(({ type, value }) => [type, value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    localUtcMs: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  };
}

function istanbulMidnightUtc(isoDay, offsetDays = 0) {
  const wallTime = Date.parse(`${isoDay}T00:00:00Z`) + offsetDays * 86400000;
  const targetDay = new Date(wallTime).toISOString().slice(0, 10);
  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info = istanbulDateParts(instant);
    if (info.day === targetDay && info.hour === 0 && info.minute === 0 && info.second === 0) {
      return new Date(instant);
    }
    instant = wallTime - (info.localUtcMs - instant);
  }
  const finalInfo = istanbulDateParts(instant);
  if (finalInfo.day === targetDay && finalInfo.hour === 0 && finalInfo.minute === 0 && finalInfo.second === 0) {
    return new Date(instant);
  }
  // Yaz saati geçişinde gece yarısı atlandıysa (ör. 1964-05-15) istenen yerel güne düşen ilk geçerli UTC anını bul.
  let lowSec = Math.floor((wallTime - 14 * 3600000) / 1000);
  let highSec = Math.ceil((wallTime + 14 * 3600000) / 1000);
  while (lowSec < highSec) {
    const midSec = Math.floor((lowSec + highSec) / 2);
    if (istanbulDateParts(midSec * 1000).day >= targetDay) {
      highSec = midSec;
    } else {
      lowSec = midSec + 1;
    }
  }
  return new Date(lowSec * 1000);
}

/**
 * Yönetici raporu kişi, ekip ve kurumsal birim kapsamını yetkili sınırlar içinde doğrulamak için kadro okur.
 * Proje analiz sınırından bağımsızdır ve seçici süzgecini satır sınırından önce uygular.
 */
export async function readReportScopeRoster(executor, scope, {
  maxRows = 500,
  mode = 'all',
  includeSelf = true,
  rosterSicil = null,
  text = '',
  hierarchyKey = '',
  scopeType = ''
} = {}) {
  const request = executor.request();
  request.input('sicil', sql.Int, scope.sicil);
  request.input('isAdmin', sql.Bit, scope.isAdmin ? 1 : 0);
  request.input('scopeProjects', sql.NVarChar(sql.MAX), scope.projectTokens);
  request.input('maxRosterRows', sql.Int, maxRows + 1);
  request.input('rosterIncludeSelf', sql.Bit, includeSelf ? 1 : 0);
  request.input('rosterMode', sql.VarChar(20), mode);
  request.input('rosterSicil', sql.Int, rosterSicil);
  request.input('rosterText', sql.NVarChar(500), text || '');
  request.input('rosterHierarchyKey', sql.NVarChar(500), hierarchyKey || '');
  request.input('rosterScopeType', sql.VarChar(20), scopeType || '');
  const [rosterRows = []] = recordsets(await request.query(AI_TOOL_REPORT_SCOPE_ROSTER_SQL));
  const { rows, truncated } = capped(rosterRows, maxRows);
  return {
    members: rows.map((row) => {
      const sicil = Number(row.Sicil);
      const rawName = row.DisplayName ? String(row.DisplayName).trim() : '';
      // Dizin adının sayısal Sicil'e eşit olduğu yedek kayıtlar model-görünür ad olarak yayımlanmaz.
      const safeName = rawName && rawName !== String(row.Sicil).trim() ? rawName : null;
      return {
        sicil,
        name: safeName,
        team: row.Team ? String(row.Team).trim() : null,
        unit: row.Unit ? String(row.Unit).trim() : null,
        department: row.Department ? String(row.Department).trim() : null,
        directorate: row.Directorate ? String(row.Directorate).trim() : null,
        scopeType: String(row.ScopeType || '')
      };
    }).filter((member) => Number.isSafeInteger(member.sicil) && member.sicil > 0),
    truncated
  };
}

/**
 * Çok projeli rapor seçicilerini (1–25 proje) tek sınırlı SQL sorgusuyla yetkili projeler içinde çözer.
 */
export async function readReportProjectsBySelectors(executor, scope, selectors = []) {
  if (!selectors.length) return [];
  const payload = selectors.map((raw, index) => ({
    index,
    raw: String(raw),
    guid: canonicalActualId(raw) || null
  }));
  const request = executor.request();
  request.input('sicil', sql.Int, scope.sicil);
  request.input('isAdmin', sql.Bit, scope.isAdmin ? 1 : 0);
  request.input('scopeProjects', sql.NVarChar(sql.MAX), scope.projectTokens);
  request.input('selectorJson', sql.NVarChar(sql.MAX), JSON.stringify(payload));
  const [rows = []] = recordsets(await request.query(AI_TOOL_REPORT_PROJECT_SELECTORS_SQL));
  return rows;
}

/**
 * Seçili FULL erişimli projelerin bağımlılıklarını tek sınırlı SQL sorgusuyla okur.
 */
export async function readReportDependencies(executor, scope, { projectIds = [], taskIds = [], maxRows = 1000 } = {}) {
  if (!projectIds.length) return { dependencies: [], truncated: false };
  const request = scoped(executor, scope, { projectIds, taskIds });
  request.input('maxRows', sql.Int, maxRows + 1);
  const [dependencyRows = []] = recordsets(await request.query(AI_TOOL_REPORT_DEPENDENCIES_SQL));
  const { rows, truncated } = capped(dependencyRows, maxRows);
  return { dependencies: rows, truncated };
}

/**
 * Yönetici raporu için dönem hareket özetini tek sınırlı sorguda (ham not/JSON metni olmadan) okur.
 */
export async function readReportActivitySummary(executor, scope, {
  from,
  to,
  projectIds = [],
  assigneeSicils = [],
  cutOffUtc = null,
  analyzedActivityLimit = TOOL_LIMITS.maxAnalyzedActivities
}) {
  const normalizedCutOff = normalizeCutOffUtc(cutOffUtc, { required: false });
  const startUtc = istanbulMidnightUtc(from, 0);
  const endUtc = istanbulMidnightUtc(to, 1);
  const request = executor.request();
  const safeProjectIds = [...new Set((projectIds || []).map(canonicalActualId).filter(Boolean))];
  const safeAssigneeSicils = [...new Set((assigneeSicils || []).map(Number).filter((s) => Number.isSafeInteger(s) && s > 0))];
  request.input('sicil', sql.Int, scope.sicil);
  request.input('isAdmin', sql.Bit, scope.isAdmin ? 1 : 0);
  request.input('scopeProjects', sql.NVarChar(sql.MAX), scope.projectTokens);
  request.input('scopeTasks', sql.NVarChar(sql.MAX), scope.scopedTaskIds);
  request.input('projectIds', sql.NVarChar(sql.MAX), safeProjectIds.join(','));
  request.input('assigneeSicils', sql.NVarChar(sql.MAX), safeAssigneeSicils.join(','));
  request.input('startUtc', sql.DateTime2, startUtc);
  request.input('endUtc', sql.DateTime2, endUtc);
  request.input('cutOffUtc', sql.DateTime2, normalizedCutOff);
  request.input('activityProbeRows', sql.Int, analyzedActivityLimit + 1);
  let result;
  try {
    result = await request.query(AI_TOOL_REPORT_ACTIVITY_SUMMARY_SQL);
  } catch (error) {
    const number = error?.number ?? error?.originalError?.info?.number;
    if (number === 51001) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    throw error;
  }
  const [[counts = {}] = [], taskRows = [], projectRows = []] = recordsets(result);
  return {
    events: Number(counts.Total || 0),
    tasks: Number(counts.TaskCount || 0),
    people: Number(counts.ActorCount || 0),
    completed: Number(counts.CompletedCount || 0),
    deletedCompleted: Number(counts.DeletedCompletedCount || 0),
    created: Number(counts.CreatedCount || 0),
    deleted: Number(counts.DeletedCount || 0),
    reopened: Number(counts.ReopenedCount || 0),
    updatedOnly: Number(counts.UpdatedOnlyCount || 0),
    hasPostCutoffDeletion: Boolean(counts.HasPostCutoffDeletion),
    liveTasks: taskRows.map((row) => ({
      taskId: canonicalActualId(row.TaskId),
      projectId: canonicalActualId(row.CurrentProjectId),
      lastActivityDay: row.LastActivityDay ? String(row.LastActivityDay).slice(0, 10) : null,
      completedInPeriod: Boolean(row.CompletedInPeriod),
      completedInPeriodDay: row.CompletedInPeriodDay ? String(row.CompletedInPeriodDay).slice(0, 10) : null,
      completedProjectId: canonicalActualId(row.CompletedProjectId),
      lastReopenAt: row.LastReopenAt ? new Date(row.LastReopenAt).toISOString() : null,
      lastReopenAuditId: row.LastReopenAuditId != null && Number.isFinite(Number(row.LastReopenAuditId)) ? Number(row.LastReopenAuditId) : null
    })).filter((row) => row.taskId),
    contributingProjects: projectRows.map((row) => ({
      projectId: canonicalActualId(row.ProjectId),
      code: row.ProjectCode ? String(row.ProjectCode).trim() : null,
      name: row.ProjectName ? String(row.ProjectName).trim() : null,
      deletedCompleted: Number(row.DeletedCompletedCount || 0)
    })).filter((row) => row.projectId)
  };
}

/**
 * Görev Hareketleri gizlilik kurallarıyla aynı yetkili hareket okumasını yönetici raporu katmanına sunar.
 */
export function readReportTaskActivity(executor, auth, input, now, options) {
  return readTaskActivityReport(executor, auth, input, now, options);
}
