import 'server-only';
import { describeRecurrenceRule } from '../../../../scheduling/recurrence/index.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { describeTaskScope, projectAccess } from './rotaScope.js';
import { readTaskDetail, readTaskFacts } from './rotaToolStore.js';
import {
  accessExplanation,
  CURSOR_PROPERTY,
  DATE_PROPERTY,
  dataText,
  ID_PROPERTY,
  LIMIT_PROPERTY,
  notFound,
  PERSON_SICIL_PROPERTY,
  projectIndex,
  projectRef,
  requireVisibleProject,
  searchedScope,
  taskItem
} from './rotaToolSupport.js';
import {
  assigneeView,
  coarseTargetRange,
  DATE_FIELDS,
  DEADLINE_FILTERS,
  DUE_MONTH_DAYS,
  DUE_SOON_DAYS,
  filtersOpenOnly,
  hoursCoverage,
  isDueWithin,
  isOverdue,
  matchesTaskFilters,
  normalizeTaskFilters,
  overdueAging,
  overdueDays,
  paginate,
  priorityLabel,
  sortFacts,
  statusLabelOf,
  statusTotals,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES
} from './taskFacts.js';

/* ── Ortak görev süzgeci şeması ───────────────────────────── */

const FILTER_PROPERTIES = Object.freeze({
  text: { type: 'string', minLength: 1, maxLength: 120, description: 'Görev adı ya da etiketinde geçen metin. Büyük/küçük harf duyarsızdır; Rota aramasıyla aynı Türkçe harmanlama kullanılır, bu yüzden Türkçe karakterleri doğru yazın (ş, ı, ğ, ç, ö, ü).' },
  projectId: ID_PROPERTY('Yalnızca bu proje (rota_project_search ile bulunan kimlik).'),
  wbsId: ID_PROPERTY('Yalnızca bu iş dağılım düğümüne DOĞRUDAN bağlı görevler (rota_wbs_inspect ile bulunan kimlik).'),
  status: {
    type: 'array', maxItems: 3, uniqueItems: true,
    items: { type: 'string', enum: [...TASK_STATUSES] },
    description: 'Durum: todo = Yapılacak, in_progress = Devam ediyor, done = Tamamlandı.'
  },
  priority: {
    type: 'array', maxItems: 4, uniqueItems: true,
    items: { type: 'string', enum: [...TASK_PRIORITIES] },
    description: 'Öncelik: critical, high, medium, low.'
  },
  deadline: {
    type: 'string', enum: [...DEADLINE_FILTERS],
    description: 'Termine göre: overdue = gecikmiş (tamamlanmamış ve termini bugünden önce), due_today = termini bugün, due_next_7_days / due_next_30_days = termini bugün dahil 7/30 gün içinde, no_target_finish = termini olmayan açık görev. Yalnızca tamamlanmamış görevler.'
  },
  dateField: {
    type: 'string', enum: [...DATE_FIELDS],
    description: 'dateFrom/dateTo aralığının uygulanacağı alan: targetFinish = termin, calendarDate = takvim günü (termin, yoksa planlanan bitiş), plannedStart, plannedFinish, actualStart, actualFinish. Varsayılan targetFinish.'
  },
  dateFrom: DATE_PROPERTY('Aralık başlangıcı (YYYY-MM-DD, dahil).'),
  dateTo: DATE_PROPERTY('Aralık bitişi (YYYY-MM-DD, dahil).'),
  assignee: {
    type: 'string', enum: ['any', 'me', 'unassigned'],
    description: 'me = kullanıcının kendisinin sorumlu olduğu görevler, unassigned = sorumlusu olmayan görevler.'
  },
  personSicil: PERSON_SICIL_PROPERTY,
  createdByMe: { type: 'boolean', description: 'Yalnızca kullanıcının oluşturduğu görevler.' },
  milestone: { type: 'boolean', description: 'true = yalnızca kilometre taşları, false = kilometre taşı olmayanlar.' }
});

function sqlAssigneeMode(filters) {
  return filters.assignee === 'person' ? 'person' : filters.assignee;
}

/** Yetkili ve kaba süzgeçle daraltılmış görev olguları; sınır aşılırsa "çok büyük". */
async function loadFilteredFacts(call, scope, filters, { withAssignees = false } = {}) {
  if (filters.projectId) requireVisibleProject(scope, filters.projectId);
  const range = coarseTargetRange(filters, call.today);
  const result = await call.sql((executor) => readTaskFacts(executor, scope, {
    projectId: filters.projectId,
    wbsId: filters.wbsId,
    text: filters.text,
    openOnly: filtersOpenOnly(filters),
    targetFrom: range.from,
    targetTo: range.to,
    statuses: filters.statuses,
    priorities: filters.priorities,
    milestone: filters.milestone,
    deadline: filters.deadline,
    dateField: filters.dateField,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    today: call.today,
    createdByMe: filters.createdByMe,
    assigneeMode: sqlAssigneeMode(filters),
    personSicil: filters.personSicil,
    withAssignees: withAssignees || filters.assignee === 'person',
    maxRows: TOOL_LIMITS.maxAnalyzedTasks
  }));
  if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  const facts = result.facts.filter((fact) => matchesTaskFilters(fact, filters, {
    today: call.today, assignees: result.assignees, sicil: call.sicil
  }));
  return { facts, projects: projectIndex(result.projects), assignees: result.assignees };
}

function filterHighlights(filters) {
  const highlights = [];
  if (filters.statuses.length) highlights.push(`Durum: ${filters.statuses.map(statusLabelOf).join(', ')}`);
  if (filters.priorities.length) highlights.push(`Öncelik: ${filters.priorities.map(priorityLabel).join(', ')}`);
  if (filters.deadline) {
    highlights.push({
      overdue: 'Gecikmiş görevler',
      due_today: 'Termini bugün',
      due_next_7_days: 'Termini 7 gün içinde',
      due_next_30_days: 'Termini 30 gün içinde',
      no_target_finish: 'Termini olmayan'
    }[filters.deadline]);
  }
  if (filters.assignee === 'me') highlights.push('Sorumlusu olduğunuz');
  if (filters.assignee === 'unassigned') highlights.push('Sorumlusuz');
  if (filters.createdByMe) highlights.push('Oluşturduğunuz');
  if (filters.text) highlights.push(`Metin: ${dataText(filters.text, 40)}`);
  if (filters.dateField) highlights.push(`${filters.dateField}: ${filters.dateFrom || '…'} – ${filters.dateTo || '…'}`);
  return highlights.slice(0, 4);
}

function projectEntity(scope, filters, projects) {
  if (!filters.projectId) return null;
  const project = projects.get(filters.projectId);
  return { type: 'project', id: filters.projectId, name: project?.name || null };
}

/* ── rota_task_search ─────────────────────────────────────── */

const taskSearch = {
  name: 'rota_task_search',
  version: 1,
  topic: 'tasks',
  evidenceKind: 'task-list',
  authorization: 'Görev görünürlüğü (anlık görüntüyle aynı): FULL/READ projede bütün görevler, kısmi projede yalnızca yetkili görevler.',
  description: 'Kullanıcının görmeye yetkili olduğu görevleri süzgeçlerle arar. Sıralı ve sayfalı liste ile süzgece uyan KESİN toplam sayıyı döndürür. Sayı sorularında totalCount kullanın; liste yalnızca bir sayfadır.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...FILTER_PROPERTIES,
      sort: {
        type: 'string', enum: [...TASK_SORTS],
        description: 'Sıralama: target_finish_asc (varsayılan; gecikme süzgecinde overdue_days_desc), target_finish_desc, overdue_days_desc, priority, planned_start_asc, updated_desc, title_asc.'
      },
      limit: LIMIT_PROPERTY(50, 20),
      cursor: CURSOR_PROPERTY
    }
  },
  async handler(args, call) {
    const filters = normalizeTaskFilters(args);
    const sort = args.sort || (filters.deadline === 'overdue' ? 'overdue_days_desc' : 'target_finish_asc');
    const limit = args.limit ?? 20;
    const { scope } = await call.authorization();
    const { facts, projects, assignees } = await loadFilteredFacts(call, scope, filters);
    const sorted = sortFacts(facts, sort, call.today);
    const { page, offset, nextCursor } = paginate('rota_task_search', { filters, sort }, sorted, { limit, cursor: args.cursor ?? null });
    let pageAssignees = assignees;
    let pageFacts = page;
    let pageProjects = projects;
    let pageChanged = false;
    if (page.length && filters.assignee !== 'person') {
      const detail = await call.sql((executor) => readTaskFacts(executor, scope, {
        taskIds: page.map((fact) => fact.id), withAssignees: true, maxRows: page.length
      }));
      pageAssignees = detail.assignees;
      pageProjects = projectIndex(detail.projects);
      const refreshed = new Map(detail.facts.map((fact) => [fact.id, fact]));
      pageFacts = page.map((fact) => refreshed.get(fact.id)).filter((fact) => fact && matchesTaskFilters(fact, filters, {
        today: call.today, assignees: pageAssignees, sicil: call.sicil
      }));
      pageChanged = pageFacts.length !== page.length
        || pageFacts.some((fact, index) => JSON.stringify(fact) !== JSON.stringify(page[index]));
      if (pageChanged) pageFacts = sortFacts(pageFacts, sort, call.today);
    }
    const exactTotal = pageChanged ? null : sorted.length;
    const stableNextCursor = pageChanged ? null : nextCursor;
    const descriptor = searchedScope(scope, filters.projectId);
    return {
      data: {
        tasks: pageFacts.map((fact) => taskItem(fact, { projects: pageProjects, assignees: pageAssignees, today: call.today })),
        sort
      },
      scope: descriptor,
      complete: !pageChanged && offset + page.length >= sorted.length,
      truncated: pageChanged || (!stableNextCursor && offset + page.length < sorted.length),
      returnedCount: pageFacts.length,
      totalCount: exactTotal,
      nextCursor: stableNextCursor,
      evidence: {
        label: exactTotal == null ? `Görev listesi · ${pageFacts.length} görev gösterildi` : `Görev listesi · ${exactTotal} görev`,
        entity: projectEntity(scope, filters, projects),
        highlights: filterHighlights(filters)
      }
    };
  }
};

/* ── rota_task_detail ─────────────────────────────────────── */

function recurrenceView(fact, row) {
  if (fact.recurrenceRule) {
    return { role: 'series-template', rule: dataText(fact.recurrenceRule, 200), description: describeRecurrenceRule(fact.recurrenceRule) };
  }
  if (fact.recurrenceParentId) {
    return {
      role: 'occurrence',
      seriesTaskId: fact.recurrenceParentId,
      seriesTitle: row.ParentTitle ? dataText(row.ParentTitle, 160) : null,
      occurrenceDate: fact.recurrenceOccurrenceDate
    };
  }
  return null;
}

const taskDetail = {
  name: 'rota_task_detail',
  version: 1,
  topic: 'tasks',
  evidenceKind: 'task-detail',
  authorization: 'Görev görünür değilse "bulunamadı" (var olmayan görevle aynı). Oluşturan ve eş sorumlu kimliği anlık görüntüyle aynı kuralla gösterilir.',
  description: 'Tek bir görevin ayrıntısı: açıklama, proje ve iş dağılım yolu, durum, öncelik, planlanan/termin/gerçekleşen tarihler, ilerleme, saat ve bütçe alanları, tekrar bilgisi, sorumlular ve (tam erişimde) bağımlılık sayıları.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId'],
    properties: {
      taskId: ID_PROPERTY('Görev kimliği (rota_task_search sonucundaki taskId).')
    }
  },
  async handler(args, call) {
    const { scope } = await call.authorization();
    const detail = await call.sql((executor) => readTaskDetail(executor, scope, args.taskId));
    if (!detail.fact) throw notFound();
    const { fact, row } = detail;
    const access = projectAccess(scope, fact.projectId)
      || (scope.isAdmin ? { accessLevel: fact.accessLevel, readGrant: false, reasons: [] } : null);
    const creatorVisible = row.VisibleCreatedBySicil != null;
    const wbsPathTruncated = Boolean(detail.wbsChain[0]?.ParentWbsId);
    const task = {
      taskId: fact.id,
      title: dataText(fact.title, 300),
      ...(fact.keyword ? { keyword: dataText(fact.keyword, 80) } : {}),
      description: dataText(row.Description, 1600),
      ...(row.DescriptionClipped ? { descriptionClipped: true } : {}),
      project: projectRef({ projectId: fact.projectId, name: dataText(row.ProjectName, 160), code: row.ProjectCode ? dataText(row.ProjectCode, 60) : null }),
      wbsPath: detail.wbsChain.map((node) => dataText(node.Name, 120)),
      ...(wbsPathTruncated ? { wbsPathTruncated: true } : {}),
      status: fact.status,
      statusLabel: statusLabelOf(fact.status),
      priority: fact.priority,
      priorityLabel: priorityLabel(fact.priority),
      milestone: fact.milestone,
      dates: {
        plannedStart: fact.plannedStart,
        plannedFinish: fact.plannedFinish,
        plannedDurationDays: fact.plannedDurationDays,
        targetFinish: fact.targetFinish,
        calendarDate: fact.calendarDate,
        actualStart: fact.actualStart,
        actualFinish: fact.actualFinish,
        remainingDurationDays: row.RemainingDurationDays == null ? null : Number(row.RemainingDurationDays)
      },
      overdue: isOverdue(fact, call.today),
      ...(isOverdue(fact, call.today) ? { overdueDays: overdueDays(fact, call.today) } : {}),
      progressPercent: fact.progress,
      hours: { planned: fact.plannedHours, actual: fact.actualHours },
      cost: { budget: fact.budget, spent: fact.spent, currency: null },
      recurrence: recurrenceView(fact, row),
      ...assigneeView(fact, detail.assignees),
      createdBy: creatorVisible
        ? { name: row.CreatedByName ? dataText(row.CreatedByName, 120) : String(row.VisibleCreatedBySicil), sicil: Number(row.VisibleCreatedBySicil) }
        : null,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      calendar: row.CalendarName ? dataText(row.CalendarName, 120) : 'Varsayılan takvim',
      dependencies: fact.accessLevel === 'FULL'
        ? { predecessorCount: Number(row.PredecessorCount || 0), successorCount: Number(row.SuccessorCount || 0) }
        : null,
      access: accessExplanation(access)
    };
    return {
      data: {
        task,
        notes: [
          'NULL saat/bütçe değeri bilinmiyor demektir, sıfır değildir. Rota para birimi tutmaz.',
          ...(creatorVisible ? [] : ['Oluşturan kişinin kimliği bu erişim düzeyinde gösterilmez.']),
          ...(task.dependencies ? [] : ['Bağımlılıklar yalnızca projede tam erişimi olan kullanıcılara açıktır.']),
          ...(wbsPathTruncated ? ['İş dağılım yolu güvenlik derinliği nedeniyle kısaltıldı.'] : [])
        ]
      },
      scope: describeTaskScope(access ? [access] : []),
      complete: !wbsPathTruncated && !row.DescriptionClipped,
      truncated: wbsPathTruncated || Boolean(row.DescriptionClipped),
      returnedCount: 1,
      totalCount: 1,
      nextCursor: null,
      evidence: {
        label: `Görev · ${dataText(fact.title, 60)}`,
        entity: { type: 'task', id: fact.id, name: dataText(fact.title, 120) },
        highlights: [statusLabelOf(fact.status), fact.targetFinish ? `Termin: ${fact.targetFinish}` : 'Termin yok']
      }
    };
  }
};

/* ── rota_task_analytics ──────────────────────────────────── */

const GROUP_BY = Object.freeze(['status', 'priority', 'project', 'assignee', 'deadline', 'target_month']);

function deadlineBucket(fact, today) {
  if (fact.status === 'done') return ['done', 'Tamamlandı'];
  if (isOverdue(fact, today)) return ['overdue', 'Gecikmiş'];
  if (!fact.targetFinish) return ['no_target_finish', 'Termini yok'];
  if (fact.targetFinish === today) return ['due_today', 'Termini bugün'];
  if (isDueWithin(fact, today, DUE_SOON_DAYS)) return ['due_next_7_days', 'Termini 7 gün içinde'];
  if (isDueWithin(fact, today, DUE_MONTH_DAYS)) return ['due_next_30_days', 'Termini 30 gün içinde'];
  return ['later', 'Termini 30 günden sonra'];
}

function groupKeys(fact, groupBy, { projects, assignees, today }) {
  switch (groupBy) {
    case 'status': return [[fact.status, statusLabelOf(fact.status)]];
    case 'priority': return [[fact.priority, priorityLabel(fact.priority)]];
    case 'project': {
      const project = projects.get(fact.projectId);
      return [[fact.projectId, project?.code ? `${project.code} · ${project.name}` : (project?.name || 'Proje')]];
    }
    case 'deadline': return [deadlineBucket(fact, today)];
    case 'target_month': return [fact.targetFinish ? [fact.targetFinish.slice(0, 7), fact.targetFinish.slice(0, 7)] : ['none', 'Termini yok']];
    case 'assignee': {
      if (fact.resolvedAssigneeCount === 0) return [['unassigned', 'Sorumlusuz']];
      const people = (assignees.get(fact.id) || []).filter((person) => person.resolved && person.identityVisible && person.sicil != null);
      if (!people.length) return [['unattributed', 'Kimliği gösterilemeyen sorumlu']];
      return people.map((person) => [`sicil:${person.sicil}`, person.name || String(person.sicil)]);
    }
    default: return [];
  }
}

const taskAnalytics = {
  name: 'rota_task_analytics',
  version: 1,
  topic: 'tasks',
  evidenceKind: 'task-analytics',
  authorization: 'rota_task_search ile aynı görünürlük; toplamlar yalnızca görünür görevler üzerindedir.',
  description: 'Yetkili görevler üzerinde BELİRLENİMCİ toplamlar: durum dağılımı, gecikmiş/yaklaşan termin sayıları, gecikme yaşlandırması, saat ve bütçe kapsaması ve istenirse bir boyuta göre gruplama. Sayı, oran ve dağılım sorularında bu aracı kullanın; sayıları kendiniz hesaplamayın.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...FILTER_PROPERTIES,
      groupBy: {
        type: 'string', enum: [...GROUP_BY],
        description: 'Gruplama boyutu: status, priority, project, assignee (bir görev birden çok sorumluda sayılabilir), deadline (termin kovası), target_month (termin ayı).'
      },
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const filters = normalizeTaskFilters(args);
    const groupBy = args.groupBy || null;
    const limit = args.limit ?? 10;
    const { scope } = await call.authorization();
    const { facts, projects, assignees } = await loadFilteredFacts(call, scope, filters, { withAssignees: groupBy === 'assignee' });
    const context = { projects, assignees, today: call.today };
    let groups = null;
    let groupCount = 0;
    if (groupBy) {
      const byKey = new Map();
      for (const fact of facts) {
        for (const [key, label] of groupKeys(fact, groupBy, context)) {
          if (!byKey.has(key)) byKey.set(key, { key, label: dataText(label, 160), count: 0, open: 0, overdue: 0, done: 0 });
          const group = byKey.get(key);
          group.count += 1;
          if (fact.status === 'done') group.done += 1;
          else group.open += 1;
          if (isOverdue(fact, call.today)) group.overdue += 1;
        }
      }
      const ordered = [...byKey.values()].sort((left, right) => (groupBy === 'target_month'
        ? left.key.localeCompare(right.key)
        : right.count - left.count || left.label.localeCompare(right.label, 'tr')));
      groupCount = ordered.length;
      const visibleGroupLimit = ordered.length > limit ? Math.max(0, limit - 1) : limit;
      groups = ordered.slice(0, visibleGroupLimit);
      if (ordered.length > visibleGroupLimit) {
        const rest = ordered.slice(visibleGroupLimit).reduce((sum, group) => ({
          count: sum.count + group.count, open: sum.open + group.open, overdue: sum.overdue + group.overdue, done: sum.done + group.done
        }), { count: 0, open: 0, overdue: 0, done: 0 });
        groups.push({ key: 'other', label: `Diğer ${ordered.length - visibleGroupLimit} grup`, ...rest });
      }
    }
    const groupsTruncated = Boolean(groupBy && groupCount > limit);
    const totals = statusTotals(facts, call.today);
    const descriptor = searchedScope(scope, filters.projectId);
    return {
      data: {
        totals,
        overdueAging: overdueAging(facts, call.today),
        hours: hoursCoverage(facts),
        ...(groups ? { groupBy, groups, groupCount } : {}),
        definitions: {
          overdue: 'Tamamlanmamış ve termini (targetFinish) bugünden önce olan görev.',
          dueNext7Days: 'Tamamlanmamış ve termini bugün dahil 7 takvim günü içinde olan görev.',
          completionRatePercent: 'Tamamlanan görev / toplam görev.',
          today: call.today,
          ...(groupBy === 'assignee' ? { assignee: 'Bir görev her görünür sorumlusunda ayrı sayılır; grupların toplamı görev sayısını aşabilir.' } : {})
        }
      },
      scope: descriptor,
      complete: !groupsTruncated,
      truncated: groupsTruncated,
      returnedCount: facts.length,
      totalCount: facts.length,
      nextCursor: null,
      evidence: {
        label: `Görev özeti · ${facts.length} görev`,
        entity: projectEntity(scope, filters, projects),
        highlights: [
          `Açık: ${totals.open}`,
          `Gecikmiş: ${totals.overdue}`,
          `Tamamlanan: ${totals.done}`,
          ...filterHighlights(filters).slice(0, 3)
        ]
      }
    };
  }
};

/** Görev olgusu yükleyicisi, başka araçların ortak kullanımı için (iş yükü, kalite, tekrar). */
export { loadFilteredFacts };

export const TASK_TOOLS = Object.freeze([taskSearch, taskDetail, taskAnalytics]);
