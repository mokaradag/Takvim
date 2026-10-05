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

/* ── Ölçü kayıt defteri ───────────────────────────────────────
 * Her iddia edilebilir yol bir ölçüye (`metric`) ve açık bir ölçme birimine
 * (`measure`) bağlıdır. Satır ya da kaydı adlandıran alanlar bağlamdır
 * (`context`): istenmeden de seçilebilir, ama istenen bir ölçünün yerine geçmez.
 * Bir varlığın kendi özelliği (`property`) nüfus koşulundan bağımsızdır;
 * toplamlar ve sayımlar nüfusa bağlıdır. Ölçü kimliği yalnızca bu tablodan
 * gelir; alan adından tahmin edilmez.
 */
const entry = (metric, measure, { context = false, property = false, display = null } = {}) => Object.freeze({ metric, measure, context, property, display });
/** Nüfusa bağlı toplam ya da sayım. */
const m = (metric, measure, display = null) => entry(metric, measure, { display });
/** Varlığın kendi özelliği. */
const p = (metric, measure) => entry(metric, measure, { property: true });
/** Adlandıran alan: istenmeden bağlam olarak seçilebilir, istenirse kendi ölçüsüdür. */
const c = (metric, measure = 'text') => entry(metric, measure, { context: true, property: true });
/** Yalnızca bağlam: grup etiketi, aralık, tanım ya da sonuç bayrağı hiçbir ölçünün yanıtı değildir. */
const x = (measure = 'text') => entry(null, measure, { context: true });

function fields(prefix, spec) {
  return Object.entries(spec).map(([field, item]) => [prefix ? `${prefix}.${field}` : field, item]);
}

const TOTALS = Object.freeze({
  total: m('tasks.total', 'tasks'), todo: m('tasks.todo', 'tasks'), inProgress: m('tasks.inProgress', 'tasks'), done: m('tasks.done', 'tasks'),
  open: m('tasks.open', 'tasks'), overdue: m('tasks.overdue', 'tasks'), dueToday: m('tasks.dueToday', 'tasks'),
  dueNext7Days: m('tasks.dueNext7Days', 'tasks'), openWithoutTargetFinish: m('tasks.openWithoutTargetFinish', 'tasks'),
  doneWithoutActualFinish: m('tasks.doneWithoutActualFinish', 'tasks'), milestonesOpen: m('tasks.milestonesOpen', 'tasks'),
  completionRatePercent: m('tasks.completionRatePercent', 'percent')
});
const TASK = Object.freeze({
  title: c('task.title'), keyword: p('task.keyword', 'text'), status: p('task.status', 'enum'), priority: p('task.priority', 'enum'),
  milestone: p('task.milestone', 'boolean'), progressPercent: p('task.progressPercent', 'percent'),
  targetFinish: p('task.targetFinish', 'date'), plannedStart: p('task.plannedStart', 'date'), plannedFinish: p('task.plannedFinish', 'date'),
  actualStart: p('task.actualStart', 'date'), actualFinish: p('task.actualFinish', 'date'), overdue: p('task.overdue', 'boolean'),
  overdueDays: p('task.overdueDays', 'days'), createdAt: p('task.createdAt', 'instant'), updatedAt: p('task.updatedAt', 'instant'),
  access: p('task.access', 'enum'), assignment: p('task.assignment', 'enum')
});
const PROJECT = Object.freeze({
  name: c('project.name'), code: c('project.code'), sourceType: p('project.sourceType', 'enum'), lead: p('project.lead', 'text'),
  type: p('project.type', 'text'), calendar: p('project.calendar', 'text'), dataDate: p('project.dataDate', 'date'),
  tagCount: p('project.tagCount', 'tags'), wbsNodeCount: p('project.wbsNodeCount', 'wbs-nodes'),
  dependencyCount: p('project.dependencyCount', 'dependencies'), baselineCount: p('project.baselineCount', 'baselines')
});
/** Görev satırındaki proje künyesi: adı ve kodu satırın bağlamıdır. */
const TASK_PROJECT = Object.freeze({ ...PROJECT, name: c('task.project'), code: c('task.project') });
const ACCESS = Object.freeze({
  level: p('project.access', 'enum'), completeTaskView: p('project.completeTaskView', 'boolean'),
  dependenciesAndBaselines: p('project.dependenciesAndBaselines', 'boolean')
});
const TASK_ACCESS = Object.freeze({
  level: p('task.access', 'enum'), completeTaskView: p('task.completeTaskView', 'boolean'),
  dependenciesAndBaselines: p('task.dependenciesAndBaselines', 'boolean')
});
const DATES = Object.freeze({
  plannedStart: TASK.plannedStart, plannedFinish: TASK.plannedFinish, plannedDurationDays: p('task.plannedDurationDays', 'days'),
  targetFinish: TASK.targetFinish, calendarDate: p('task.calendarDate', 'date'), actualStart: TASK.actualStart,
  actualFinish: TASK.actualFinish, remainingDurationDays: p('task.remainingDurationDays', 'days')
});
const HOURS = Object.freeze({
  plannedHours: ['tasks.plannedHours', 'hours'], actualHours: ['tasks.actualHours', 'hours'],
  budget: ['tasks.budget', 'currency-unspecified'], spent: ['tasks.spent', 'currency-unspecified']
});
/** Saat ve maliyet kapsamındaki görev sayıları birimiyle ("N görev") yazılır. */
const hoursPaths = () => Object.entries(HOURS).flatMap(([key, [metric, measure]]) => {
  const name = `${key[0].toUpperCase()}${key.slice(1)}`;
  return fields(`hours.${key}`, { total: m(metric, measure), tasksWithValue: m(`tasks.with${name}`, 'tasks', 'tasks'), tasksWithoutValue: m(`tasks.without${name}`, 'tasks', 'tasks') });
});
const DEFINITION = x('definition');
const WORKFLOW = Object.freeze({
  status: p('request.status', 'enum'), requester: p('request.requester', 'text'), decisionOwner: p('request.decisionOwner', 'text'),
  requestedAssignee: p('request.requestedAssignee', 'text'), requestedAssigneeOrganization: p('request.requestedAssigneeOrganization', 'text'),
  suggestedAssignee: p('request.suggestedAssignee', 'text'), requesterMessage: p('request.requesterMessage', 'text'),
  decisionMessage: p('request.decisionMessage', 'text'), decidedBy: p('request.decidedBy', 'text'), createdAt: p('request.createdAt', 'instant'),
  decidedAt: p('request.decidedAt', 'instant'), yourRole: p('request.yourRole', 'enum'), awaitingYourDecision: p('request.awaitingYourDecision', 'boolean'),
  actionRequiredFromYou: p('request.actionRequiredFromYou', 'boolean'), mode: p('request.mode', 'enum'), targetFinish: p('request.targetFinish', 'date')
});
const workflowPaths = (path) => [...fields(path, WORKFLOW), ...fields(`${path}.task`, { title: c('task.title'), available: p('request.taskAvailable', 'boolean') }),
  ...fields(`${path}.project`, { name: c('task.project'), code: c('task.project') })];
const SERIES = Object.freeze({
  title: c('task.title'), project: c('task.project'), rule: p('recurrence.rule', 'text'), ruleDescription: p('recurrence.rule', 'text'),
  visibleOccurrences: m('recurrence.occurrences', 'occurrences'), open: m('recurrence.openOccurrences', 'occurrences'),
  done: m('recurrence.doneOccurrences', 'occurrences'), overdue: m('recurrence.overdueOccurrences', 'occurrences'),
  upcomingCount: m('recurrence.upcomingOccurrences', 'occurrences'), nextTruncated: x('boolean'),
  completionDatesComplete: x('boolean')
});
const seriesPaths = (path) => [[`${path}.lastCompleted`, p('recurrence.lastCompletedFinish', 'date')], ...fields(path, SERIES),
  ...fields(`${path}.next.*`, { occurrenceDate: p('recurrence.occurrenceDate', 'date'), targetFinish: TASK.targetFinish, status: TASK.status }),
  ...fields(`${path}.lastCompleted`, { occurrenceDate: p('recurrence.lastCompletedOccurrence', 'date'), actualFinish: p('recurrence.lastCompletedFinish', 'date') })];
const NOTIFICATION_SOURCES = Object.freeze({ scheduleRequests: 'schedule', assignmentCoordination: 'assignment', taskEvents: 'taskEvent' });
const notificationPaths = () => Object.entries(NOTIFICATION_SOURCES).flatMap(([path, source]) => [
  ...fields(path, { unread: m(`notifications.${source}Unread`, 'notifications'), awaitingYourDecision: m(`notifications.${source}ActionRequired`, 'notifications'),
    actionRequired: m(`notifications.${source}ActionRequired`, 'notifications') }),
  ...fields(`${path}.latest.*`, { title: c('task.title'), project: c('task.project'), status: p('notification.status', 'enum'),
    actionRequired: p('notification.actionRequired', 'boolean'), unread: p('notification.unread', 'boolean'), at: p('notification.at', 'instant'),
    requestedAssignee: p('notification.requestedAssignee', 'text'), label: p('notification.label', 'text'), by: p('notification.by', 'text'),
    taskCount: p('notification.taskCount', 'tasks') })
]);

const REGISTRY_ENTRIES = Object.freeze({
  rota_task_search: [...fields('project', PROJECT), ...fields('tasks.*', TASK), ...fields('tasks.*.project', TASK_PROJECT),
    ['tasks.*.assignees.*.name', p('task.assignees', 'text')]],
  rota_task_detail: [...fields('task', TASK), ...fields('task.project', TASK_PROJECT), ['task.assignees.*.name', p('task.assignees', 'text')],
    ['task.description', p('task.description', 'text')], ['task.wbsPath.*', p('task.wbsPath', 'text')], ...fields('task.dates', DATES),
    ...fields('task.hours', { planned: p('task.plannedHours', 'hours'), actual: p('task.actualHours', 'hours') }),
    ...fields('task.cost', { budget: p('task.budget', 'currency-unspecified'), spent: p('task.spent', 'currency-unspecified') }),
    ...fields('task.access', TASK_ACCESS), ['task.access.reasons.*', p('task.accessReasons', 'enum')], ['task.createdBy.name', p('task.createdBy', 'text')],
    ['task.calendar', p('task.calendar', 'text')], ['task.calendarSource', p('task.calendarSource', 'enum')],
    ...fields('task.dependencies', { predecessorCount: p('task.predecessorCount', 'dependencies'), successorCount: p('task.successorCount', 'dependencies') }),
    ...fields('task.recurrence', { rule: p('recurrence.rule', 'text'), ruleDescription: p('recurrence.rule', 'text'), occurrenceDate: p('recurrence.occurrenceDate', 'date') })],
  rota_task_analytics: [...fields('definitions', { overdue: DEFINITION, dueNext7Days: DEFINITION, completionRatePercent: DEFINITION, today: x('date'), assignee: DEFINITION }),
    ...fields('totals', TOTALS), ...fields('overdueAging.buckets.*', { label: x(), count: m('tasks.overdue', 'tasks') }),
    ['overdueAging.worstOverdueDays', m('tasks.worstOverdueDays', 'days')], ['hours.taskCount', m('tasks.total', 'tasks', 'tasks')], ...hoursPaths(),
    ...fields('groups.*', { label: x(), count: TOTALS.total, ...TOTALS }), ['groupCount', m('tasks.groupCount', 'groups')]],
  rota_project_search: [...fields('matches.*', PROJECT), ...fields('matches.*.access', ACCESS), ['ambiguous', x('boolean')]],
  rota_project_detail: [...fields('project', PROJECT), ['project.tags.*', p('project.tags', 'text')], ...fields('access', ACCESS),
    ['access.reasons.*', p('project.accessReasons', 'enum')], ...fields('visibleTasks', TOTALS),
    ...fields('definitions', { overdue: DEFINITION, dueNext7Days: DEFINITION, today: x('date') })],
  rota_portfolio_summary: [...fields('definitions', { overdue: DEFINITION, dueNext7Days: DEFINITION, today: x('date'), completeTaskView: DEFINITION }),
    ...fields('totals', { projects: m('projects.total', 'projects'), tasks: TOTALS.total, open: TOTALS.open, done: TOTALS.done, overdue: TOTALS.overdue,
      dueNext7Days: TOTALS.dueNext7Days, openWithoutTargetFinish: TOTALS.openWithoutTargetFinish, projectsWithOverdue: m('projects.withOverdue', 'projects') }),
    ...fields('projects.*', { ...PROJECT, access: ACCESS.level, completeTaskView: ACCESS.completeTaskView }), ...fields('projects.*.tasks', TOTALS)],
  rota_wbs_inspect: [...fields('project', PROJECT), ['nodeCount', m('wbs.nodes', 'wbs-nodes')],
    ...fields('tasksWithoutWbs', { tasks: m('wbs.unplacedTasks', 'tasks'), done: m('wbs.unplacedDone', 'tasks'), overdue: m('wbs.unplacedOverdue', 'tasks') }),
    ...fields('nodes.*', { name: c('wbs.name'), code: c('wbs.name'), depth: p('wbs.depth', 'wbs-levels'), childCount: p('wbs.childCount', 'wbs-nodes'),
      directTasks: m('wbs.directTasks', 'tasks'), subtreeTasks: m('wbs.subtreeTasks', 'tasks'), subtreeOpen: m('wbs.subtreeOpen', 'tasks'),
      subtreeOverdue: m('wbs.subtreeOverdue', 'tasks') })],
  rota_person_search: [...fields('people.*', { name: c('person.name'), jobTitle: p('person.jobTitle', 'text') }),
    ...fields('people.*.organization', { directorate: p('person.organization', 'text'), department: p('person.organization', 'text'), unit: p('person.organization', 'text') }),
    ['ambiguous', x('boolean')]],
  rota_workload_summary: [['openTaskCount', TOTALS.open], ['unassignedOpenTasks', m('tasks.unassignedOpen', 'tasks')],
    ...fields('people.*', { name: c('person.name'), openTasks: TOTALS.open, inProgress: TOTALS.inProgress, overdue: TOTALS.overdue,
      dueNext7Days: TOTALS.dueNext7Days, plannedHoursOnAssignedTasks: m('tasks.plannedHours', 'hours'), tasksWithPlannedHours: m('tasks.withPlannedHours', 'tasks') })],
  rota_baseline_compare: [...fields('definitions', { varianceDays: DEFINITION, removedSinceBaseline: DEFINITION, addedSinceBaseline: DEFINITION, comparisonBasis: DEFINITION }),
    ['baseline', c('baseline.name')], ...fields('baseline', { name: c('baseline.name'), createdAt: p('baseline.createdAt', 'instant'),
      isPrimary: p('baseline.isPrimary', 'boolean'), taskCount: p('baseline.taskCount', 'tasks') }),
    ...fields('availableBaselines.*', { name: c('baseline.name'), createdAt: p('baseline.createdAt', 'instant'), isPrimary: p('baseline.isPrimary', 'boolean'),
      taskCount: p('baseline.taskCount', 'tasks') }), ['availableBaselinesTruncated', x('boolean')],
    ...fields('counts', Object.fromEntries(['snapshotTasks', 'compared', 'finishSlipped', 'finishEarlier', 'finishUnchanged', 'missingDates',
      'removedSinceBaseline', 'addedSinceBaseline', 'startSlipped', 'missingTasks'].map((field) => [field, m(`baseline.${field}`, 'tasks')]))),
    ...fields('finishVariance', { averageDays: m('baseline.averageVarianceDays', 'days'), maxSlipDays: m('baseline.maxSlipDays', 'days'),
      maxEarlierDays: m('baseline.maxEarlierDays', 'days') }),
    ...fields('mostSlipped.*', { title: c('task.title'), status: TASK.status, baselineFinish: p('task.baselineFinish', 'date'), plannedFinish: TASK.plannedFinish,
      varianceDays: p('task.varianceDays', 'days'), targetFinish: TASK.targetFinish })],
  rota_dependency_inspect: [...fields('task', TASK),
    ...['predecessors.*', 'successors.*'].flatMap((path) => [...fields(path, { ...TASK, type: p('dependency.type', 'enum') }),
      ...fields(`${path}.lag`, { value: p('dependency.lag', 'lag'), unit: p('dependency.lag', 'lag') })]),
    ...fields('coverage', { taskCount: TOTALS.total, dependencyCount: m('dependencies.total', 'dependencies'),
      tasksWithPredecessor: m('dependencies.tasksWithPredecessor', 'tasks'), tasksWithSuccessor: m('dependencies.tasksWithSuccessor', 'tasks'),
      tasksWithoutAnyDependency: m('dependencies.tasksWithoutAny', 'tasks'), withPositiveLag: m('dependencies.withPositiveLag', 'dependencies'),
      withNegativeLag: m('dependencies.withNegativeLag', 'dependencies') }),
    ...fields('coverage.byType', Object.fromEntries(['FS', 'SS', 'FF', 'SF'].map((type) => [type, m('dependencies.byType', 'dependencies')]))),
    ...fields('mostConnected.*', { title: c('task.title'), relationCount: m('dependencies.relationCount', 'dependencies') })],
  rota_recurrence_inspect: [['task.title', c('task.title')], ['recurring', p('recurrence.recurring', 'boolean')],
    ['visibleEntryCount', m('recurrence.entries', 'series')], ...seriesPaths('series'), ...seriesPaths('series.*')],
  rota_calendar_inspect: [...fields('calendar', { name: c('calendar.name'), source: p('calendar.source', 'enum'), timeZone: p('calendar.timeZone', 'text') }),
    ['calendar.workingWeekdays.*', p('calendar.workingWeekdays', 'enum')],
    ...fields('range', { from: x('date'), to: x('date'), calendarDays: m('calendar.calendarDays', 'days') }),
    ['workingDayCount', m('calendar.workingDays', 'days')],
    ...fields('holidays.*', { date: p('calendar.holidayDate', 'date'), name: c('calendar.holidayName'), short: c('calendar.holidayName') })],
  rota_activity_search: [...fields('range', { from: x('date'), to: x('date') }),
    ...fields('summary', { events: m('activity.events', 'events'), tasks: m('activity.tasks', 'tasks'), people: m('activity.people', 'people'),
      completedTasks: m('activity.completedTasks', 'tasks') }),
    ...fields('items.*', { occurredAt: p('activity.occurredAt', 'instant'), actor: p('activity.actor', 'text'), kind: p('activity.kind', 'enum') }),
    ...fields('items.*.task', { title: c('task.title'), available: p('activity.taskAvailable', 'boolean') }),
    ...fields('items.*.project', { name: c('task.project'), code: c('task.project') }), ['items.*.changes.*', p('activity.changes', 'text')],
    ...fields('items.*.structuredChanges.*', { before: p('activity.changeBefore', 'value'), after: p('activity.changeAfter', 'value') })],
  rota_schedule_requests: [...fields('counts', { awaitingYourDecision: m('requests.awaitingYourDecision', 'requests'), sent: m('requests.sent', 'requests'),
    history: m('requests.history', 'requests') }), ...workflowPaths('items.*'),
    ...['plannedStart', 'plannedFinish', 'targetFinish'].flatMap((field) => fields(`items.*.proposedChanges.${field}`,
      { from: p(`request.proposed${field[0].toUpperCase()}${field.slice(1)}`, 'date'), to: p(`request.proposed${field[0].toUpperCase()}${field.slice(1)}`, 'date') }))],
  rota_assignment_requests: [...fields('counts', { actionRequired: m('requests.actionRequired', 'requests'), sent: m('requests.sent', 'requests'),
    history: m('requests.history', 'requests') }), ...workflowPaths('items.*'),
    ...fields('items.*.you', { requester: p('request.youRequester', 'boolean'), requestedAssignee: p('request.youRequestedAssignee', 'boolean'),
      canDecide: p('request.canDecide', 'boolean') })],
  rota_notifications: [['unreadCount', m('notifications.unread', 'notifications')], ['actionRequiredCount', m('notifications.actionRequired', 'notifications')],
    ...notificationPaths()],
  rota_outlook_status: [['task.title', c('task.title')], ['activeSubscriptions', m('subscriptions.active', 'subscriptions')],
    ['byStateComplete', x('boolean')],
    ...fields('byState', Object.fromEntries(['failed', 'suspended', 'pending', 'delivered'].map((state) => [state, m(`subscriptions.${state}`, 'subscriptions')]))),
    ...fields('items.*', { state: p('subscription.state', 'enum'), attempts: p('subscription.attempts', 'attempts'), calendarDate: p('subscription.calendarDate', 'date'),
      deliveredCalendarDate: p('subscription.deliveredCalendarDate', 'date'), lastDeliveredAt: p('subscription.lastDeliveredAt', 'instant') }),
    ...fields('items.*.task', { title: c('task.title'), project: c('task.project') }),
    ...fields('items.*.failure', { code: p('subscription.failureCode', 'enum'), message: p('subscription.failureMessage', 'text') })],
  rota_data_quality: [['openTaskCount', TOTALS.open], ['cleanOpenTaskCount', m('quality.cleanOpen', 'tasks')],
    ...fields('checks.*', { label: x(), count: m('quality.flagged', 'tasks') }),
    ...fields('checks.*.examples.*', { title: m('quality.examples', 'text'), project: c('task.project') }),
    ['completedWithoutActualFinish.count', TOTALS.doneWithoutActualFinish],
    ...fields('completedWithoutActualFinish.examples.*', { title: m('quality.examples', 'text'), project: c('task.project') })]
});

/** Aracın sonuç toplamının (`totalCount`) ölçüsü: her araç kendi nüfusunu sayar. */
const TOTAL_COUNT = Object.freeze({
  rota_task_search: TOTALS.total, rota_task_detail: TOTALS.total, rota_task_analytics: TOTALS.total, rota_data_quality: TOTALS.total,
  rota_project_search: m('projects.total', 'projects'), rota_project_detail: m('projects.total', 'projects'), rota_portfolio_summary: m('projects.total', 'projects'),
  rota_person_search: m('people.total', 'people'), rota_workload_summary: m('people.total', 'people'), rota_wbs_inspect: m('wbs.nodes', 'wbs-nodes'),
  rota_baseline_compare: m('baseline.finishSlipped', 'tasks'), rota_dependency_inspect: m('dependencies.total', 'dependencies'),
  rota_recurrence_inspect: m('recurrence.entries', 'series'), rota_calendar_inspect: m('calendar.holidays', 'holidays'),
  rota_activity_search: m('activity.events', 'events'), rota_schedule_requests: m('requests.total', 'requests'),
  rota_assignment_requests: m('requests.total', 'requests'), rota_notifications: m('notifications.total', 'notifications'),
  rota_outlook_status: m('subscriptions.active', 'subscriptions')
});
const ENVELOPE_ENTRIES = Object.freeze({
  returnedCount: m('records.returned', 'records'), complete: x('boolean'), truncated: x('boolean')
});

const REGISTRY = new Map(Object.entries(REGISTRY_ENTRIES).map(([tool, entries]) => [tool, new Map(entries)]));
const PATHS = Object.freeze(Object.fromEntries([...REGISTRY].map(([tool, entries]) => [tool, [...entries.keys()]])));

/** Kapalı ölçü sözlüğü: kimlik → ölçme birimi. Bir ölçünün birimi her yolda aynıdır. */
export const METRICS = Object.freeze(Object.fromEntries([...REGISTRY.values(), new Map(Object.entries(TOTAL_COUNT)), new Map(Object.entries(ENVELOPE_ENTRIES))]
  .flatMap((entries) => [...entries.values()]).filter((entry) => entry.metric)
  .map((entry) => [entry.metric, entry.measure]).sort(([left], [right]) => left.localeCompare(right))));

/** Kanıt olgusunun kayıtlı ölçüsü; kayıt dışı yol `null`. */
export function metricEntry(tool, canonicalPath) {
  if (canonicalPath === 'totalCount') return TOTAL_COUNT[tool] || null;
  if (ENVELOPE_ENTRIES[canonicalPath]) return ENVELOPE_ENTRIES[canonicalPath];
  return REGISTRY.get(tool)?.get(canonicalPath) || null;
}

/** Bir ölçüyü taşıyan kanonik yollar (doğrulama yönergesi için). */
export function metricPaths(tool, metric) {
  const paths = [...(REGISTRY.get(tool) || [])].filter(([, entry]) => entry.metric === metric).map(([path]) => `data.${path}`);
  if (TOTAL_COUNT[tool]?.metric === metric) paths.push('totalCount');
  if (ENVELOPE_ENTRIES.returnedCount.metric === metric) paths.push('returnedCount');
  return paths;
}

/**
 * Kayıt satırı koleksiyonları. Bir kaydın çok değerli alanı (sorumlular, WBS
 * yolu, etiketler, erişim nedenleri, çalışma günleri) satır değildir.
 */
const ROW_COLLECTIONS = Object.freeze({
  rota_task_search: ['tasks'], rota_task_detail: [], rota_task_analytics: ['overdueAging.buckets', 'groups'],
  rota_project_search: ['matches'], rota_project_detail: [], rota_portfolio_summary: ['projects'], rota_wbs_inspect: ['nodes'],
  rota_person_search: ['people'], rota_workload_summary: ['people'], rota_baseline_compare: ['availableBaselines', 'mostSlipped'],
  rota_dependency_inspect: ['predecessors', 'successors', 'mostConnected'], rota_recurrence_inspect: ['series', 'series.next'],
  rota_calendar_inspect: ['holidays'], rota_activity_search: ['items'], rota_schedule_requests: ['items'], rota_assignment_requests: ['items'],
  rota_notifications: ['scheduleRequests.latest', 'assignmentCoordination.latest', 'taskEvents.latest'], rota_outlook_status: ['items'],
  rota_data_quality: ['checks', 'completedWithoutActualFinish.examples']
});

export function rowCollections(tool) {
  return ROW_COLLECTIONS[tool] || [];
}

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

/** Hareket kaydındaki değişen görev sütununun türü (değişen alan adı sunucunun kapalı sütun kümesidir). */
const CHANGE_DATE_FIELDS = new Set(['plannedStart', 'plannedFinish', 'targetFinish', 'actualStart', 'actualFinish', 'recurrenceOccurrenceDate']);
const CHANGE_INSTANT_FIELDS = new Set(['createdAt', 'updatedAt']);
/** Ölçme biriminin yazımı: birim kayıt defterinden gelir, alan adından tahmin edilmez. */
const DISPLAY_UNITS = Object.freeze({ hours: 'hours', 'currency-unspecified': 'unspecified-currency' });

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
  const canonical = parts.slice(1).map((part) => /^\d+$/.test(part) ? '*' : part).join('.');
  const row = rowContext(envelope, parts);
  const group = parts[1] === 'groups' ? envelope.data?.groups?.[Number(parts[2])] : null;
  const registered = metricEntry(envelope.tool, parts[0] === 'data' ? canonical : path);
  const measure = registered?.measure || null;
  // Bağımlılık gecikmesinin birimi satırdaki `unit` alanıdır.
  const lagUnit = measure === 'lag' && parts.at(-1) === 'value'
    ? (path.split('.').slice(1, -1).reduce((data, key) => data?.[key], envelope.data)?.unit || 'unknown-lag') : null;
  const changeType = CHANGE_DATE_FIELDS.has(changeField) ? 'date' : CHANGE_INSTANT_FIELDS.has(changeField) ? 'instant' : null;
  return {
    identity: `${envelope.tool}:${parts.map((part) => /^\d+$/.test(part) ? '*' : part).join('.')}`,
    metric: registered?.metric || null,
    measure,
    context: registered?.context === true,
    property: registered?.property === true,
    valueType: changeField ? changeType : ['date', 'instant'].includes(measure) ? measure : null,
    canonicalPath: path, type: value === null ? 'null' : typeof value, label,
    unit: lagUnit || registered?.display || DISPLAY_UNITS[measure] || null,
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
    decimalScale: measure === 'currency-unspecified' ? 4 : null,
    nullMeaning: envelope.data?.nodes?.[Number(parts[2])]?.malformedCycle && parts.at(-1)?.startsWith('subtree') ? 'undefined-cycle'
      : parts[1] === 'project' && envelope.data?.project?.countsOverLimit?.includes(parts.at(-1)) ? 'over-limit' : 'unknown'
  };
}
