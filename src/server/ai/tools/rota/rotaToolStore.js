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
  AI_TOOL_WBS_SQL
} from './rotaToolQueries.js';
import { assigneesByTask, factFromRow } from './taskFacts.js';

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
      if (number === 51001 || (statement === AI_TOOL_WBS_SQL && number === 530)) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      throw error;
    }
  };
  request.input('sourceFilter', sql.VarChar(12), options?.source || 'all');
  request.input('analysisMaxRows', sql.Int, TOOL_LIMITS.maxAnalyzedTasks + 1);
  request.input('analysisAssignmentRows', sql.Int, TOOL_LIMITS.maxAnalyzedAssignments + 1);
  return request;
}

/** `rows.length > limit` ise sonuç kesilmiştir; en fazla `limit` satır döner. */
function capped(rows = [], limit) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function readTaskFacts(executor, scope, {
  projectId = null, taskIds = [], wbsId = null, seriesId = null, recurringOnly = false, text = '',
  openOnly = false, targetFrom = null, targetTo = null, createdByMe = false,
  statuses = [], priorities = [], milestone = null, deadline = null,
  dateField = null, dateFrom = null, dateTo = null, today = null,
  assigneeMode = 'any', personSicil = null, withAssignees = false, maxRows
}) {
  const request = scoped(executor, scope, { projectId, taskIds });
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
  request.input('createdByMe', sql.Bit, createdByMe ? 1 : 0);
  request.input('assigneeMode', sql.VarChar(12), assigneeMode);
  request.input('personSicil', sql.Int, personSicil);
  request.input('withAssignees', sql.Bit, withAssignees ? 1 : 0);
  const [factRows = [], projectRows = [], assigneeRows = []] = recordsets(await request.query(AI_TOOL_TASK_FACTS_SQL));
  const { rows, truncated } = capped(factRows, maxRows);
  return {
    facts: rows.map(factFromRow),
    truncated,
    projects: projectRows,
    assignees: assigneesByTask(assigneeRows)
  };
}

export async function readTaskDetail(executor, scope, taskId) {
  const request = scoped(executor, scope, { taskIds: [taskId] });
  request.input('withAssignees', sql.Bit, 1);
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

export async function readProjectSearch(executor, scope, { text, limit, projectId = null }) {
  const request = scoped(executor, scope, { projectId });
  request.input('text', sql.NVarChar(120), text);
  request.input('limit', sql.Int, limit);
  const [[count] = [], rows = []] = recordsets(await request.query(AI_TOOL_PROJECT_SEARCH_SQL));
  return { total: Number(count?.Total || 0), exactCount: Number(count?.ExactCount || 0), rows };
}

export async function readPortfolio(executor, scope, { today, soonEnd, source = 'all' }) {
  const request = scoped(executor, scope, { source });
  request.input('today', sql.Date, today);
  request.input('soonEnd', sql.Date, soonEnd);
  const [rows = []] = recordsets(await request.query(AI_TOOL_PORTFOLIO_SQL));
  return rows;
}

export async function readProjectDetail(executor, scope, { projectId, today, soonEnd }) {
  const request = scoped(executor, scope, { projectId });
  request.input('today', sql.Date, today);
  request.input('soonEnd', sql.Date, soonEnd);
  const [projectRows = [], tagRows = [], [totals] = []] = recordsets(await request.query(AI_TOOL_PROJECT_DETAIL_SQL));
  if (tagRows.length > TOOL_LIMITS.maxAnalyzedTasks || [projectRows[0]?.DependencyCount, projectRows[0]?.BaselineCount, projectRows[0]?.WbsNodeCount].some((value) => Number(value) > TOOL_LIMITS.maxAnalyzedTasks)) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  return { project: projectRows[0] || null, tags: tagRows.map((row) => String(row.TagName)), totals: totals || null };
}

export async function readWbs(executor, scope, { projectId, wbsId = null, today, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('today', sql.Date, today);
  request.input('wbsId', sql.UniqueIdentifier, wbsId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [nodeRows = [], countRows = [], projectRows = []] = recordsets(await request.query(AI_TOOL_WBS_SQL));
  const { rows, truncated } = capped(nodeRows, maxRows);
  return { nodes: rows, truncated, counts: countRows, project: projectRows[0] || null };
}

export async function readDependencies(executor, scope, { projectId, focusTaskId = null, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('focusTaskId', sql.UniqueIdentifier, focusTaskId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [dependencyRows = [], taskRows = [], [totals] = []] = recordsets(await request.query(AI_TOOL_DEPENDENCIES_SQL));
  const { rows, truncated } = capped(dependencyRows, maxRows);
  return { dependencies: rows, truncated, tasks: taskRows, totals: totals || { TaskCount: 0, OpenCount: 0 } };
}

export async function readBaseline(executor, scope, { projectId, baselineId = null, maxRows }) {
  const request = scoped(executor, scope, { projectId });
  request.input('baselineId', sql.UniqueIdentifier, baselineId);
  request.input('maxRows', sql.Int, maxRows + 1);
  const [baselineRows = [], [selection] = [], snapshotRows = [], [added] = []] = recordsets(await request.query(AI_TOOL_BASELINE_SQL));
  if (Number(selection?.BaselineTotal) > TOOL_LIMITS.maxAnalyzedTasks) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  const { rows, truncated } = capped(snapshotRows, maxRows);
  return {
    projectFull: Boolean(selection?.ProjectFull),
    selectedBaselineId: selection?.SelectedBaselineId || null,
    baselines: baselineRows,
    baselinesTruncated: Number(selection?.BaselineTotal || 0) > baselineRows.length,
    snapshots: rows,
    truncated,
    addedSinceBaseline: Number(added?.AddedSinceBaseline || 0)
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
