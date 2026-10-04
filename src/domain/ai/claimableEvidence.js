const TEXT_FIELDS = Object.freeze(['description', 'requesterMessage', 'decisionMessage', 'changes']);

export const EVIDENCE_TEXT_FIELDS = TEXT_FIELDS;

/**
 * Hareket kaydının serbest metin alanları (başlık, etiket, açıklama, yineleme
 * kuralı): eski/yeni değerleri saklanan serbest metindir ve yalnızca kullanıcı
 * değişiklik metnini (`changes`) açıkça istediğinde modele gider.
 */
const FREE_TEXT_CHANGE_FIELDS = Object.freeze(['task', 'keyword', 'description', 'recurrenceRule']);

export function changeEntryVisible(item, textFields) {
  if (TEXT_FIELDS.includes(item?.field) && !textFields.includes(item.field)) return false;
  return !FREE_TEXT_CHANGE_FIELDS.includes(item?.field) || textFields.includes('changes');
}

export function projectEvidenceData(value, textFields = []) {
  if (Array.isArray(value)) return value.filter((item) => changeEntryVisible(item, textFields))
    .map((item) => projectEvidenceData(item, textFields));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !TEXT_FIELDS.includes(key) || textFields.includes(key))
    .map(([key, item]) => [key, projectEvidenceData(item, textFields)]));
}

const ENVELOPE_FIELDS = new Set(['returnedCount', 'totalCount', 'complete', 'truncated']);

const record = (path, fields) => fields.split(' ').map((field) => `${path}.${field}`);
const TOTALS = 'total todo inProgress done open overdue dueToday dueNext7Days openWithoutTargetFinish doneWithoutActualFinish milestonesOpen completionRatePercent';
const TASK = 'title keyword status priority milestone progressPercent targetFinish plannedStart plannedFinish actualStart actualFinish overdue overdueDays createdAt updatedAt access';
const PROJECT = 'name code sourceType lead type calendar dataDate tagCount wbsNodeCount dependencyCount baselineCount';
const ACCESS = 'level completeTaskView dependenciesAndBaselines';
const DATE = 'plannedStart plannedFinish plannedDurationDays targetFinish calendarDate actualStart actualFinish remainingDurationDays';
const SERIES = 'title project rule ruleDescription visibleOccurrences open done overdue upcomingCount nextTruncated completionDatesComplete';
const seriesPaths = (path) => [`${path}.lastCompleted`, ...record(path, SERIES), ...record(`${path}.next.*`, 'occurrenceDate targetFinish status'), ...record(`${path}.lastCompleted`, 'occurrenceDate actualFinish')];
const itemPaths = (path) => [...record(path, TASK), ...record(`${path}.project`, PROJECT), ...record(`${path}.assignees.*`, 'name')];
const workflowPaths = (path) => [...record(path, 'status requester decisionOwner requestedAssignee requestedAssigneeOrganization suggestedAssignee requesterMessage decisionMessage decidedBy createdAt decidedAt yourRole awaitingYourDecision actionRequiredFromYou mode targetFinish'), ...record(`${path}.task`, 'title available'), ...record(`${path}.project`, 'name code')];

const PATHS = Object.freeze({
  rota_task_search: [...record('project', PROJECT), ...itemPaths('tasks.*')],
  rota_task_detail: [...itemPaths('task'), 'task.description', 'task.wbsPath.*', ...record('task.dates', DATE), ...record('task.hours', 'planned actual'), ...record('task.cost', 'budget spent'), ...record('task.access', ACCESS), 'task.access.reasons.*', 'task.createdBy.name', 'task.calendar', 'task.calendarSource', ...record('task.dependencies', 'predecessorCount successorCount'), ...record('task.recurrence', 'rule ruleDescription occurrenceDate')],
  rota_task_analytics: [...record('definitions', 'overdue dueNext7Days completionRatePercent today assignee'), ...record('totals', TOTALS), ...record('overdueAging.buckets.*', 'label count'), 'overdueAging.worstOverdueDays', 'hours.taskCount', ...['plannedHours', 'actualHours', 'budget', 'spent'].flatMap((field) => record(`hours.${field}`, 'total tasksWithValue tasksWithoutValue')), ...record('groups.*', `label count ${TOTALS}`), 'groupCount'],
  rota_project_search: [...record('matches.*', PROJECT), ...record('matches.*.access', ACCESS), 'ambiguous'],
  rota_project_detail: [...record('project', PROJECT), 'project.tags.*', ...record('access', ACCESS), 'access.reasons.*', ...record('visibleTasks', TOTALS), ...record('definitions', 'overdue dueNext7Days today')],
  rota_portfolio_summary: [...record('definitions', 'overdue dueNext7Days today completeTaskView'), ...record('totals', 'projects tasks open done overdue dueNext7Days openWithoutTargetFinish projectsWithOverdue'), ...record('projects.*', `${PROJECT} access completeTaskView`), ...record('projects.*.tasks', TOTALS)],
  rota_wbs_inspect: [...record('project', PROJECT), 'nodeCount', ...record('tasksWithoutWbs', 'tasks done overdue'), ...record('nodes.*', 'name code depth childCount directTasks subtreeTasks subtreeOpen subtreeOverdue')],
  rota_person_search: [...record('people.*', 'name jobTitle'), ...record('people.*.organization', 'directorate department unit'), 'ambiguous'],
  rota_workload_summary: ['openTaskCount', 'unassignedOpenTasks', ...record('people.*', 'name openTasks inProgress overdue dueNext7Days plannedHoursOnAssignedTasks tasksWithPlannedHours')],
  rota_baseline_compare: [...record('definitions', 'varianceDays removedSinceBaseline addedSinceBaseline comparisonBasis'), 'baseline',...record('baseline', 'name createdAt isPrimary taskCount'), ...record('availableBaselines.*', 'name createdAt isPrimary taskCount'), 'availableBaselinesTruncated', ...record('counts', 'snapshotTasks compared finishSlipped finishEarlier finishUnchanged missingDates removedSinceBaseline addedSinceBaseline startSlipped missingTasks'), ...record('finishVariance', 'averageDays maxSlipDays maxEarlierDays'), ...record('mostSlipped.*', 'title status baselineFinish plannedFinish varianceDays targetFinish')],
  rota_dependency_inspect: [...record('task', TASK), ...['predecessors.*', 'successors.*'].flatMap((path) => [...record(path, `${TASK} type`), ...record(`${path}.lag`, 'value unit')]), ...record('coverage', 'taskCount dependencyCount tasksWithPredecessor tasksWithSuccessor tasksWithoutAnyDependency withPositiveLag withNegativeLag'), ...record('coverage.byType', 'FS SS FF SF'), ...record('mostConnected.*', 'title relationCount')],
  rota_recurrence_inspect: ['task.title', 'recurring', 'visibleEntryCount', ...seriesPaths('series'), ...seriesPaths('series.*')],
  rota_calendar_inspect: [...record('calendar', 'name source timeZone'), 'calendar.workingWeekdays.*', ...record('range', 'from to calendarDays'), 'workingDayCount', ...record('holidays.*', 'date name short')],
  rota_activity_search: [...record('range', 'from to'), ...record('summary', 'events tasks people completedTasks'), ...record('items.*', 'occurredAt actor kind'), ...record('items.*.task', 'title available'), ...record('items.*.project', 'name code'), 'items.*.changes.*', ...record('items.*.structuredChanges.*', 'before after')],
  rota_schedule_requests: [...record('counts', 'awaitingYourDecision sent history'), ...workflowPaths('items.*'), ...['plannedStart', 'plannedFinish', 'targetFinish'].flatMap((field) => record(`items.*.proposedChanges.${field}`, 'from to'))],
  rota_assignment_requests: [...record('counts', 'actionRequired sent history'), ...workflowPaths('items.*'), ...record('items.*.you', 'requester requestedAssignee canDecide')],
  rota_notifications: ['unreadCount', 'actionRequiredCount', ...['scheduleRequests', 'assignmentCoordination', 'taskEvents'].flatMap((path) => [...record(path, 'unread awaitingYourDecision actionRequired'), ...record(`${path}.latest.*`, 'title project status actionRequired unread at requestedAssignee label by taskCount')])],
  rota_outlook_status: ['task.title', 'activeSubscriptions', 'byStateComplete', ...record('byState', 'failed suspended pending delivered'), ...record('items.*', 'state attempts calendarDate deliveredCalendarDate lastDeliveredAt'), ...record('items.*.task', 'title project'), ...record('items.*.failure', 'code message')],
  rota_data_quality: ['openTaskCount', 'cleanOpenTaskCount', ...record('checks.*', 'label count'), ...record('checks.*.examples.*', 'title project'), 'completedWithoutActualFinish.count', ...record('completedWithoutActualFinish.examples.*', 'title project')]
});

export function claimableContract(tool, textFields = []) {
  return { version: 1, textFields: TEXT_FIELDS.filter((field) => textFields.includes(field)), paths: PATHS[tool] || [] };
}

export function claimableField(envelope, path, canonicalFields, changeField = null) {
  if (ENVELOPE_FIELDS.has(path)) return true;
  const parts = path.split('.');
  if (parts[0] !== 'data') return false;
  const canonicalPath = parts.slice(1).map((part) => /^\d+$/.test(part) ? '*' : part).join('.');
  if (!PATHS[envelope.tool]?.includes(canonicalPath)) return false;
  const leaf = parts.findLast((part) => !/^\d+$/.test(part));
  const textField = TEXT_FIELDS.includes(leaf) ? leaf : (TEXT_FIELDS.includes(changeField) ? changeField : null);
  if (textField && !envelope.claimable?.textFields?.includes(textField)) return false;
  if (FREE_TEXT_CHANGE_FIELDS.includes(changeField) && !envelope.claimable?.textFields?.includes('changes')) return false;
  return canonicalFields.has(leaf);
}

const DATE_FIELDS = new Set(['plannedStart', 'plannedFinish', 'targetFinish', 'calendarDate', 'actualStart', 'actualFinish', 'dataDate', 'date', 'from', 'to', 'baselineFinish', 'occurrenceDate', 'deliveredCalendarDate', 'today']);
const INSTANT_FIELDS = new Set(['occurredAt', 'createdAt', 'updatedAt', 'decidedAt', 'at', 'lastDeliveredAt']);

const RESULT_COUNT_UNITS = Object.freeze({
  rota_task_search: 'tasks', rota_task_detail: 'tasks', rota_task_analytics: 'tasks',
  rota_project_search: 'projects', rota_project_detail: 'projects', rota_portfolio_summary: 'projects',
  rota_person_search: 'people', rota_workload_summary: 'people', rota_wbs_inspect: 'wbs-nodes',
  rota_baseline_compare: 'tasks', rota_dependency_inspect: 'dependencies', rota_recurrence_inspect: 'recurrence-entries',
  rota_calendar_inspect: 'holidays', rota_activity_search: 'activity-groups', rota_schedule_requests: 'requests',
  rota_assignment_requests: 'requests', rota_notifications: 'notifications', rota_outlook_status: 'subscriptions', rota_data_quality: 'checks'
});

function countUnit(envelope, path, value) {
  if (typeof value !== 'number' && value !== null) return null;
  if (['totalCount', 'returnedCount'].includes(path)) return RESULT_COUNT_UNITS[envelope.tool] || null;
  const leaf = path.split('.').at(-1);
  if (/Days$|^workingDayCount$/.test(leaf)) return 'days';
  if (/projects|projectCount/i.test(leaf)) return 'projects';
  if (/people|personCount|sameNameCount/i.test(leaf)) return 'people';
  if (/dependencyCount|edgeCount/i.test(leaf)) return 'dependencies';
  if (/task|overdue|done|todo|inProgress/i.test(leaf) || /^data\.(totals|visibleTasks)\.(total|open)$/.test(path)) return 'tasks';
  if (leaf === 'count' && /groups|overdueAging/.test(path)) return 'tasks';
  return null;
}

function rowContext(envelope, parts) {
  const index = parts.findIndex((part, position) => position > 1 && /^\d+$/.test(part));
  if (index < 0 || index === parts.length - 1) return null;
  const row = parts.slice(1, index + 1).reduce((value, key) => value?.[key], envelope.data);
  if (!row || typeof row !== 'object') return null;
  return { path: parts.slice(0, index + 1).join('.'),
    identity: row.taskId || row.projectId || row.wbsId || row.requestId || row.coordinationId || row.sicil || row.key || null,
    name: row.title || row.name || row.task?.title || row.person?.name || row.label || null,
    project: typeof row.project === 'string' ? row.project : row.project?.name || null,
    projectCode: row.project?.code || null,
    organization: row.organization ? [row.organization.unit, row.organization.department, row.organization.directorate].filter(Boolean).join(' / ') : null };
}

export function evidenceSemantic(envelope, path, value, label, changeField = null) {
  const parts = path.split('.');
  const hour = parts.includes('hours') || parts.some((part) => ['plannedHours', 'actualHours', 'plannedHoursOnAssignedTasks'].includes(part));
  const cost = parts.some((part) => ['budget', 'spent'].includes(part));
  const row = rowContext(envelope, parts);
  const group = parts[1] === 'groups' ? envelope.data?.groups?.[Number(parts[2])] : null;
  return {
    identity: `${envelope.tool}:${parts.map((part) => /^\d+$/.test(part) ? '*' : part).join('.')}`,
    valueType: DATE_FIELDS.has(changeField || parts.at(-1)) ? 'date' : INSTANT_FIELDS.has(changeField || parts.at(-1)) ? 'instant' : null,
    canonicalPath: path, type: value === null ? 'null' : typeof value, label,
    unit: parts.includes('lag') && parts.at(-1) === 'value' ? (path.split('.').slice(1, -1).reduce((data, key) => data?.[key], envelope.data)?.unit || 'unknown-lag') : ['tasksWithValue', 'tasksWithoutValue', 'taskCount'].includes(parts.at(-1)) ? 'tasks' : cost ? 'unspecified-currency' : hour ? 'hours' : null,
    countUnit: countUnit(envelope, path, value),
    entity: envelope.entity || null,
    row,
    renderable: true,
    displayValue: parts.at(-1) === 'rule' ? parts.slice(1, -1).reduce((data, key) => data?.[key], envelope.data)?.ruleDescription || null : null,
    filters: row?.project ? { ...(envelope.data?.filters || {}), project: row.project } : envelope.data?.filters || null,
    groupBy: envelope.data?.groupBy || null,
    group: group ? { key: group.key, label: group.label } : null,
    provenance: { tool: envelope.tool, generatedAt: envelope.generatedAt, today: envelope.today },
    complete: envelope.complete === true,
    countScope: envelope.data?.countsScope || null,
    decimalScale: cost ? 4 : null,
    nullMeaning: envelope.data?.nodes?.[Number(parts[2])]?.malformedCycle && parts.at(-1)?.startsWith('subtree') ? 'undefined-cycle'
      : parts[1] === 'project' && envelope.data?.project?.countsOverLimit?.includes(parts.at(-1)) ? 'over-limit' : 'unknown'
  };
}
