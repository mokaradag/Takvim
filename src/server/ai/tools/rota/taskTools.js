import 'server-only';
import { searchCorporateDirectory } from '../../../directory/directorySearch.js';
import { CLARIFICATION_LIMITS } from '../../../../domain/ai/clarification.js';
import { METRIC_DEFINITIONS } from '../../../../domain/ai/metricDefinitions.js';
import { describeRecurrenceRule } from '../../../../scheduling/recurrence/index.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { describeTaskScope, projectAccess } from './rotaScope.js';
import { readTaskDetail, readTaskFacts, readWbsSelector } from './rotaToolStore.js';
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
  assignmentState,
  assigneeView,
  coarseTargetRange,
  DATE_FIELDS,
  DEADLINE_FILTERS,
  DUE_MONTH_DAYS,
  DUE_SOON_DAYS,
  filtersOpenOnly,
  foldText,
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
  if (filters.wbsId) {
    const node = await call.sql((executor) => readWbsSelector(executor, scope, { projectId: filters.projectId, wbsId: filters.wbsId }));
    if (!node) throw notFound();
    filters.projectId = String(node.ProjectId).toLowerCase();
    filters.project = dataText(node.ProjectName, 120);
    filters.wbs = [node.Code, node.Name].filter(Boolean).map((text) => dataText(text, 120)).join(' · ');
  }
  if (filters.projectId) {
    await requireVisibleProject(scope, filters.projectId, call);
    call.noteProjects?.([filters.projectId]);
  }
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
  // Toplamlar sonuçta listelenmeyen görevlere de dayanır: sayılan nüfus son yetki
  // denetiminde yeniden doğrulanmak üzere (modele gitmeden) kaydedilir.
  call.notePopulation?.(facts.map((fact) => ({ taskId: fact.id, projectId: fact.projectId })));
  const projects = projectIndex(result.projects);
  if (filters.projectId) filters.project = projects.get(filters.projectId)?.name || filters.project || 'Seçilen proje';
  if (filters.personSicil != null) {
    const person = [...result.assignees.values()].flat().find((person) => person.sicil === filters.personSicil);
    const resolved = person?.name || (await call.sql((executor) => searchCorporateDirectory({ query: String(filters.personSicil) }, executor, { rateScope: 'ai' })))
      .items.find((person) => person.sicil === filters.personSicil)?.name;
    filters.person = resolved && resolved !== String(filters.personSicil) ? dataText(resolved, 120) : 'Seçilen kişi';
  }
  return { facts, projects, assignees: result.assignees };
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
  const dateLabels = { targetFinish: 'Termin', calendarDate: 'Takvim günü', plannedStart: 'Planlanan başlangıç',
    plannedFinish: 'Planlanan bitiş', actualStart: 'Gerçekleşen başlangıç', actualFinish: 'Gerçekleşen bitiş' };
  if (dateLabels[filters.dateField]) highlights.push(`${dateLabels[filters.dateField]}: ${filters.dateFrom || '…'} – ${filters.dateTo || '…'}`);
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
  description: 'Kullanıcının görmeye yetkili olduğu görevleri süzgeçlerle arar. Tek olgu okumasından sıralı ve sayfalı liste ile süzgece uyan KESİN toplam sayıyı döndürür. Sayı sorularında totalCount kullanın; liste yalnızca bir sayfadır.',
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
    // Sorumlu izdüşümü bütün nüfus için değil, yalnızca dönen sayfa için okunur.
    const { facts, projects, assignees } = await loadFilteredFacts(call, scope, filters);
    const sorted = sortFacts(facts, sort, call.today);
    // Sıralı kimlikler nüfus ve sıra kaymasını yakalar; sorumlu izdüşümü yalnız sayfaya uygulanır.
    const anchor = sorted.map((fact) => fact.id);
    const { page, offset, nextCursor } = paginate('rota_task_search', { filters, sort }, sorted, { limit, cursor: args.cursor ?? null, anchor });
    const pageFacts = page;
    const pageAssignees = filters.assignee === 'person' || !pageFacts.length ? assignees
      : (await call.sql((executor) => readTaskFacts(executor, scope, {
        taskIds: pageFacts.map((fact) => fact.id), withAssignees: true, maxRows: pageFacts.length
      }))).assignees;
    const pageProjects = projects;
    const exactTotal = sorted.length;
    const stableNextCursor = nextCursor;
    const descriptor = searchedScope(scope, filters.projectId);
    // Metinle ad çözümü: yalnızca TEK KESİN başlık eşleşmesi görevi çözer. Tek
    // kısmi eşleşme ya da birden çok aday kimlik değildir; sunucu, sayfa
    // sınırından bağımsız olarak sınırlı aday kümesini kullanıcıya sorulmak üzere taşır.
    const needle = filters.text ? foldText(filters.text).trim() : '';
    const exactFacts = needle ? sorted.filter((fact) => foldText(fact.title).trim() === needle) : [];
    const resolvedFact = exactFacts.length === 1 ? exactFacts[0] : null;
    const titleResolution = !needle ? null : resolvedFact ? 'unique'
      : exactFacts.length > 1 || sorted.length > 1 ? 'ambiguous' : sorted.length === 1 ? 'partial' : 'none';
    const candidatePool = titleResolution === 'ambiguous' ? (exactFacts.length > 1 ? exactFacts : sorted) : titleResolution === 'partial' ? sorted : [];
    const candidates = candidatePool.slice(0, CLARIFICATION_LIMITS.maxCandidates).map((fact) => ({
      taskId: fact.id,
      title: dataText(fact.title, 160),
      project: projectRef(projects.get(fact.projectId), fact.projectId),
      status: fact.status,
      statusLabel: statusLabelOf(fact.status),
      ...(fact.targetFinish ? { targetFinish: fact.targetFinish } : {})
    }));
    const rankSort = { target_finish_asc: ['targetFinish', 'asc'], target_finish_desc: ['targetFinish', 'desc'],
      planned_start_asc: ['plannedStart', 'asc'], updated_desc: ['updatedAt', 'desc'], overdue_days_desc: ['overdueDays', 'desc'] }[sort];
    const next = sorted[page.length];
    const nextValue = next && rankSort ? (rankSort[0] === 'overdueDays'
      ? (isOverdue(next, call.today) ? overdueDays(next, call.today) : null) : next[rankSort[0]] ?? null) : null;
    return {
      ...(rankSort && offset === 0 && next ? { rankingBoundary: {
        collection: 'tasks', metric: `task.${rankSort[0]}`, order: rankSort[1], returnedCount: page.length, nextValue
      } } : {}),
      data: {
        ...(filters.projectId ? { project: projectRef(projects.get(filters.projectId), filters.projectId) } : {}),
        tasks: pageFacts.map((fact) => ({
          ...taskItem(fact, { projects: pageProjects, assignees: pageAssignees, today: call.today }),
          ...(needle ? { exactTitleMatch: foldText(fact.title).trim() === needle } : {})
        })),
        ...(titleResolution ? {
          titleResolution,
          ...(resolvedFact ? { resolvedTask: { taskId: resolvedFact.id, title: dataText(resolvedFact.title, 160) } } : {}),
          ...(candidates.length ? { candidates, ...(candidatePool.length > candidates.length ? { candidatesTruncated: true } : {}) } : {}),
          ...(titleResolution === 'ambiguous' ? { guidance: 'Arama metni tek bir görevi belirlemiyor. Ayrıntı gerekiyorsa {"kind":"clarification","evidence":"<kanıt>"} ile kullanıcıya sorun; adayları sunucu gösterir. Tahmin etmeyin.' } : {}),
          ...(titleResolution === 'partial' ? { guidance: 'Arama metni yalnızca bir görevin adına kısmen uyuyor; görev kesin olarak belirlenmedi. Ayrıntısı gerekiyorsa {"kind":"clarification","evidence":"<kanıt>"} ile kullanıcıdan onay isteyin.' } : {})
        } : {}),
        sort,
        filters
      },
      scope: descriptor,
      complete: offset + page.length >= sorted.length,
      truncated: !stableNextCursor && offset + page.length < sorted.length,
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
    return { role: 'series-template', rule: dataText(fact.recurrenceRule, 200), ruleDescription: describeRecurrenceRule(fact.recurrenceRule) };
  }
  if (fact.recurrenceParentId) {
    const seriesTitle = row.ParentTitle ? dataText(row.ParentTitle, 160) : null;
    return {
      role: 'occurrence',
      ...(seriesTitle ? { seriesTaskId: fact.recurrenceParentId, seriesTitle } : {}),
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
    // Açıklama yalnızca istendiğinde modele gider; kısaltma bilgisi de yalnızca o zaman taşınır.
    const descriptionClipped = Boolean(row.DescriptionClipped) && (args.textFields || []).includes('description');
    const access = projectAccess(scope, fact.projectId)
      || (scope.isAdmin ? { accessLevel: fact.accessLevel, readGrant: false, reasons: [] } : null);
    const creatorVisible = row.VisibleCreatedBySicil != null;
    const wbsPathIssue = detail.wbsChain.find((node) => node.PathIssue)?.PathIssue || (detail.wbsChain[0]?.ParentWbsId ? 'depth' : null);
    const wbsPathTruncated = Boolean(wbsPathIssue);
    const task = {
      taskId: fact.id,
      title: dataText(fact.title, 300),
      ...(fact.keyword ? { keyword: dataText(fact.keyword, 80) } : {}),
      description: dataText(row.Description, 1600),
      ...(descriptionClipped ? { descriptionClipped: true } : {}),
      project: projectRef({ projectId: fact.projectId, name: dataText(row.ProjectName, 160), code: row.ProjectCode ? dataText(row.ProjectCode, 60) : null }),
      wbsPath: detail.wbsChain.map((node) => dataText(node.Name, 120)),
      ...(wbsPathTruncated ? { wbsPathTruncated: true, wbsPathIssue } : {}),
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
        ? { name: row.CreatedByName ? dataText(row.CreatedByName, 120) : 'Adı belirtilmemiş kişi', sicil: Number(row.VisibleCreatedBySicil) }
        : null,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      calendar: row.CalendarName ? dataText(row.CalendarName, 120) : null,
      calendarSource: row.CalendarSource || null,
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
      complete: !wbsPathTruncated && !descriptionClipped,
      truncated: wbsPathTruncated || descriptionClipped,
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
/** Görünür kişiye bağlanamayan görevlerin grupları; gizli ve olmayan atama aynı gruptadır. */
const ASSIGNMENT_GROUPS = Object.freeze({
  unassigned: ['unassigned', 'Sorumlusuz'],
  unresolved: ['unresolved', 'Sorumlu kaydı çözülemiyor'],
  undisclosed: ['undisclosed', 'Sorumlu bilgisi gösterilemiyor']
});

function deadlineBucket(fact, today) {
  if (fact.status === 'done') return ['done', 'Tamamlandı'];
  if (isOverdue(fact, today)) return ['overdue', 'Gecikmiş'];
  if (!fact.targetFinish) return ['no_target_finish', 'Termini yok'];
  if (fact.targetFinish === today) return ['due_today', 'Termini bugün'];
  if (isDueWithin(fact, today, DUE_SOON_DAYS)) return ['due_days_1_to_6', 'Termini 1–6 gün sonra'];
  if (isDueWithin(fact, today, DUE_MONTH_DAYS)) return ['due_days_7_to_29', 'Termini 7–29 gün sonra'];
  return ['later', 'Termini 30 gün veya daha sonra'];
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
      const state = assignmentState(fact);
      const people = state === 'visible'
        ? (assignees.get(fact.id) || []).filter((person) => person.resolved && person.identityVisible && person.sicil != null) : [];
      if (people.length) return people.map((person) => [`sicil:${person.sicil}`, person.name || 'Seçilen kişi']);
      return [ASSIGNMENT_GROUPS[state] || ASSIGNMENT_GROUPS.undisclosed];
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
        filters,
        overdueAging: overdueAging(facts, call.today),
        hours: hoursCoverage(facts),
        ...(groups ? { groupBy, groups, groupCount } : {}),
        definitions: {
          ...METRIC_DEFINITIONS.taskTotals,
          today: call.today,
          ...(groupBy === 'assignee' ? { assignee: METRIC_DEFINITIONS.assigneeGrouping } : {})
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
