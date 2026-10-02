import 'server-only';
import { taskCompletionRate } from '../../../../scheduling/metrics/taskCompletionRate.js';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { describeTaskScope, isCompleteTaskView } from './rotaScope.js';
import { readPortfolio, readProjectDetail, readProjectSearch, readWbs } from './rotaToolStore.js';
import {
  accessExplanation,
  accessLevelOf,
  dataText,
  ID_PROPERTY,
  LIMIT_PROPERTY,
  notFound,
  requireVisibleProject
} from './rotaToolSupport.js';
import { addDays, DUE_SOON_DAYS, foldText, sqlDay, sqlInstant } from './taskFacts.js';

function sourceLabel(sourceType) {
  return sourceType === 'CORPORATE' ? 'Kurumsal (CN43N)' : 'Manuel';
}

function scopeAccess(row) {
  return { accessLevel: row.AccessLevel === 'FULL' ? 'FULL' : 'PARTIAL', readGrant: Boolean(row.HasReadGrant) };
}

/* ── rota_project_search ──────────────────────────────────── */

const projectSearch = {
  name: 'rota_project_search',
  version: 1,
  topic: 'projects',
  evidenceKind: 'project-list',
  authorization: 'Yalnızca kullanıcının görmeye yetkili olduğu etkin projeler aranır.',
  description: 'Proje adı ya da kodu parçasıyla yetkili projeleri arar ve proje kimliğini çözer. Birden çok aday dönerse (ambiguous = true) tahmin etmeyin; kullanıcıya hangisini kastettiğini sorun.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 2, maxLength: 120, description: 'Proje adı ya da kodu (parça yeterli).' },
      limit: LIMIT_PROPERTY(10, 5)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 5;
    const { scope } = await call.authorization();
    const result = await call.sql((executor) => readProjectSearch(executor, scope, { text: args.text, limit: Math.max(2, limit) }));
    const needle = foldText(args.text);
    const uniqueExact = result.exactCount === 1;
    const ambiguous = !uniqueExact && result.total > 1;
    const matches = result.rows.slice(0, ambiguous ? Math.max(2, limit) : limit).map((row) => {
      const access = accessExplanation({ ...scopeAccess(row), reasons: scope.projects.get(canonicalActualId(row.ProjectId))?.reasons || [] });
      return {
        projectId: canonicalActualId(row.ProjectId),
        name: dataText(row.ProjectName, 160),
        ...(row.ProjectCode ? { code: dataText(row.ProjectCode, 60) } : {}),
        source: sourceLabel(row.SourceType),
        sourceType: row.SourceType === 'CORPORATE' ? 'corporate' : 'manual',
        access: { level: access.level, label: access.label },
        ...(row.LeadName ? { lead: dataText(row.LeadName, 120) } : {}),
        exactMatch: Number(row.MatchRank) === 0
          || foldText(row.ProjectName) === needle || foldText(row.ProjectCode || '') === needle
      };
    });
    return {
      data: {
        matches,
        ambiguous,
        guidance: ambiguous
          ? 'Birden çok proje eşleşti. Kullanıcıya adayları sunup hangisini kastettiğini sorun; tahmin etmeyin.'
          : (result.total === 0 ? 'Görüntüleme yetkiniz olan projeler arasında eşleşme yok.' : null)
      },
      scope: { kind: 'complete-projects', completeProjectView: true, note: 'Arama yalnızca görüntüleme yetkiniz olan projeleri kapsar.' },
      complete: result.total <= matches.length,
      truncated: result.total > matches.length,
      returnedCount: matches.length,
      totalCount: result.total,
      nextCursor: null,
      evidence: {
        label: `Proje araması · ${result.total} eşleşme`,
        entity: null,
        highlights: matches.slice(0, 3).map((match) => (match.code ? `${match.code} · ${match.name}` : match.name))
      }
    };
  }
};

/* ── Görev toplamları (portföy ve proje künyesi) ──────────── */

function taskTotals(row) {
  const total = Number(row?.TaskCount || 0);
  const done = Number(row?.DoneCount || 0);
  return {
    total,
    todo: Number(row?.TodoCount || 0),
    inProgress: Number(row?.InProgressCount || 0),
    done,
    open: total - done,
    overdue: Number(row?.OverdueCount || 0),
    dueNext7Days: Number(row?.DueSoonCount || 0),
    openWithoutTargetFinish: Number(row?.NoTargetCount || 0),
    milestonesOpen: Number(row?.OpenMilestoneCount || 0),
    nextTargetFinish: sqlDay(row?.NextTargetFinish),
    lastTaskUpdateAt: sqlInstant(row?.LastTaskUpdateAt),
    completionRatePercent: taskCompletionRate(done, total)
  };
}

const TOTAL_DEFINITIONS = Object.freeze({
  overdue: 'Tamamlanmamış ve termini (targetFinish) bugünden önce olan görev.',
  dueNext7Days: 'Tamamlanmamış ve termini bugün dahil 7 takvim günü içinde olan görev.'
});

/* ── rota_project_detail ──────────────────────────────────── */

const projectDetail = {
  name: 'rota_project_detail',
  version: 1,
  topic: 'projects',
  evidenceKind: 'project-detail',
  authorization: 'Proje görünür değilse "bulunamadı". Görev toplamları yalnızca görünür görevler üzerindedir; erişim nedeni kullanıcının kendi yetkisidir.',
  description: 'Tek projenin künyesi: kaynak, lider, takvim, etiketler, kullanıcının erişim düzeyi ve NEDENİ, görünür görevlerin durum/gecikme toplamları ve (tam erişimde) bağımlılık ile baz plan sayıları. "Neden bu projeyi görüyorum / neden göremiyorum" sorularında da kullanın.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: { projectId: ID_PROPERTY('Proje kimliği (rota_project_search ile bulunan).') }
  },
  async handler(args, call) {
    const { scope } = await call.authorization();
    const access = await requireVisibleProject(scope, args.projectId, call);
    const soonEnd = addDays(call.today, DUE_SOON_DAYS - 1);
    const detail = await call.sql((executor) => readProjectDetail(executor, scope, { projectId: args.projectId, today: call.today, soonEnd }));
    if (!detail.project) throw notFound();
    const row = detail.project;
    const explanation = accessExplanation(access);
    const totals = taskTotals(detail.totals);
    const descriptor = describeTaskScope([access]);
    const name = dataText(row.ProjectName, 160);
    const tagsTruncated = detail.tags.length > 20;
    const tags = detail.tags.slice(0, 20).map((tag) => dataText(tag, 60));
    return {
      data: {
        project: {
          projectId: canonicalActualId(row.ProjectId),
          name,
          ...(row.ProjectCode ? { code: dataText(row.ProjectCode, 60) } : {}),
          source: sourceLabel(row.SourceType),
          sourceType: row.SourceType === 'CORPORATE' ? 'corporate' : 'manual',
          ...(row.ProjectTypeName ? { type: dataText(row.ProjectTypeName, 120) } : {}),
          lead: row.LeadName ? dataText(row.LeadName, 120) : null,
          calendar: row.CalendarName ? dataText(row.CalendarName, 120) : null,
          dataDate: sqlDay(row.DataDate),
          tags,
          tagCount: detail.tags.length,
          wbsNodeCount: row.WbsNodeCount == null ? null : Number(row.WbsNodeCount),
          dependencyCount: row.DependencyCount == null ? null : Number(row.DependencyCount),
          baselineCount: row.BaselineCount == null ? null : Number(row.BaselineCount)
        },
        access: explanation,
        visibleTasks: totals,
        definitions: { ...TOTAL_DEFINITIONS, today: call.today }
      },
      scope: descriptor,
      complete: !tagsTruncated,
      truncated: tagsTruncated,
      returnedCount: 1,
      totalCount: 1,
      nextCursor: null,
      evidence: {
        label: `Proje · ${name}`,
        entity: { type: 'project', id: canonicalActualId(row.ProjectId), name },
        highlights: [explanation.label, `Görünür görev: ${totals.total}`, `Gecikmiş: ${totals.overdue}`]
      }
    };
  }
};

/* ── rota_portfolio_summary ───────────────────────────────── */

const PORTFOLIO_SORTS = Object.freeze({
  overdue_desc: (left, right) => right.tasks.overdue - left.tasks.overdue || right.tasks.open - left.tasks.open,
  open_desc: (left, right) => right.tasks.open - left.tasks.open || right.tasks.overdue - left.tasks.overdue,
  due_soon_desc: (left, right) => right.tasks.dueNext7Days - left.tasks.dueNext7Days || right.tasks.overdue - left.tasks.overdue,
  name_asc: () => 0
});

const portfolioSummary = {
  name: 'rota_portfolio_summary',
  version: 1,
  topic: 'portfolio',
  evidenceKind: 'portfolio',
  authorization: 'Yalnızca kullanıcının görebildiği projeler; kısmi projelerde yalnızca görünür görevler sayılır.',
  description: 'Kullanıcının görebildiği bütün projelerin görev toplamları (açık, gecikmiş, 7 gün içinde terminli, termini olmayan) ve proje sıralaması. "Hangi projede en çok gecikme var", "portföyün durumu" gibi sorularda kullanın.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sort: { type: 'string', enum: Object.keys(PORTFOLIO_SORTS), description: 'overdue_desc (varsayılan), open_desc, due_soon_desc, name_asc.' },
      source: { type: 'string', enum: ['all', 'corporate', 'manual'], description: 'Proje kaynağı (varsayılan all).' },
      includeEmpty: { type: 'boolean', description: 'Görünür görevi olmayan projeler de listelensin mi (varsayılan true; false ise hariç tutulur).' },
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const sort = args.sort || 'overdue_desc';
    const limit = args.limit ?? 10;
    const source = args.source || 'all';
    const { scope } = await call.authorization();
    const soonEnd = addDays(call.today, DUE_SOON_DAYS - 1);
    const rows = await call.sql((executor) => readPortfolio(executor, scope, { today: call.today, soonEnd, source }));
    const filteredRows = rows
      .filter((row) => source === 'all' || (source === 'corporate') === (row.SourceType === 'CORPORATE'))
      .filter((row) => args.includeEmpty !== false || taskTotals(row).total > 0);
    const projects = filteredRows.map((row) => ({
      projectId: canonicalActualId(row.ProjectId),
      name: dataText(row.ProjectName, 160),
      ...(row.ProjectCode ? { code: dataText(row.ProjectCode, 60) } : {}),
      access: accessLevelOf(scopeAccess(row)),
      completeTaskView: isCompleteTaskView(scopeAccess(row)),
      tasks: taskTotals(row)
    }));
    const compare = PORTFOLIO_SORTS[sort];
    projects.sort((left, right) => compare(left, right) || left.name.localeCompare(right.name, 'tr') || left.projectId.localeCompare(right.projectId));
    const totals = projects.reduce((sum, project) => ({
      projects: sum.projects + 1,
      tasks: sum.tasks + project.tasks.total,
      open: sum.open + project.tasks.open,
      done: sum.done + project.tasks.done,
      overdue: sum.overdue + project.tasks.overdue,
      dueNext7Days: sum.dueNext7Days + project.tasks.dueNext7Days,
      openWithoutTargetFinish: sum.openWithoutTargetFinish + project.tasks.openWithoutTargetFinish,
      projectsWithOverdue: sum.projectsWithOverdue + (project.tasks.overdue > 0 ? 1 : 0)
    }), { projects: 0, tasks: 0, open: 0, done: 0, overdue: 0, dueNext7Days: 0, openWithoutTargetFinish: 0, projectsWithOverdue: 0 });
    const descriptor = describeTaskScope(filteredRows.map(scopeAccess));
    const page = projects.slice(0, limit);
    return {
      data: {
        totals,
        projects: page,
        sort,
        definitions: { ...TOTAL_DEFINITIONS, today: call.today, completeTaskView: 'false ise projede yalnızca yetkili görevleriniz sayılmıştır.' }
      },
      scope: descriptor,
      complete: page.length === projects.length,
      truncated: page.length < projects.length,
      returnedCount: page.length,
      totalCount: projects.length,
      nextCursor: null,
      evidence: {
        label: `Portföy özeti · ${totals.projects} proje`,
        entity: { type: 'portfolio', id: 'portfolio', name: 'Portföy' },
        highlights: [`Açık görev: ${totals.open}`, `Gecikmiş: ${totals.overdue}`, `Gecikmeli proje: ${totals.projectsWithOverdue}`]
      }
    };
  }
};

/* ── rota_wbs_inspect ─────────────────────────────────────── */

const wbsInspect = {
  name: 'rota_wbs_inspect',
  version: 1,
  topic: 'wbs',
  evidenceKind: 'wbs',
  authorization: 'İş dağılım ağacı anlık görüntüyle aynı kuralla görünür: tam/okuma/kendi görev kapsamında katalog, yalnızca yönetim kapsamında görünür görevlerin düğümleri ve ataları.',
  description: 'Bir projenin iş dağılım ağacını (WBS) inceler: düğümler, alt düğüm sayıları ve düğüm/alt ağaç başına GÖRÜNÜR görev, açık ve gecikmiş sayıları. Kritik yol ya da zaman çizelgesi hesaplamaz.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      projectId: ID_PROPERTY('Proje kimliği.'),
      wbsId: ID_PROPERTY('İncelenecek alt ağacın kök düğümü (verilmezse projenin kökü).'),
      depth: { type: 'integer', minimum: 1, maximum: 4, description: 'Kökten itibaren gösterilecek düzey sayısı (varsayılan 2).' },
      limit: LIMIT_PROPERTY(60, 40)
    }
  },
  async handler(args, call) {
    const depthLimit = args.depth ?? 2;
    const limit = args.limit ?? 40;
    const { scope } = await call.authorization();
    const access = await requireVisibleProject(scope, args.projectId, call);
    const result = await call.sql((executor) => readWbs(executor, scope, {
      projectId: args.projectId, wbsId: args.wbsId ?? null, today: call.today, maxRows: TOOL_LIMITS.maxAnalyzedTasks
    }));
    if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    const nodes = new Map();
    for (const row of result.nodes) {
      const id = canonicalActualId(row.WbsId);
      nodes.set(id, {
        id,
        parentId: row.ParentWbsId ? canonicalActualId(row.ParentWbsId) : null,
        code: dataText(row.Code, 60),
        name: dataText(row.Name, 160),
        sortOrder: row.SortOrder == null ? Number.MAX_SAFE_INTEGER : Number(row.SortOrder),
        children: [],
        direct: { tasks: 0, done: 0, overdue: 0 },
        subtree: { tasks: 0, done: 0, overdue: 0 }
      });
    }
    let unplacedTasks = { tasks: 0, done: 0, overdue: 0 };
    for (const row of result.counts) {
      const counts = { tasks: Number(row.TaskCount || 0), done: Number(row.DoneCount || 0), overdue: Number(row.OverdueCount || 0) };
      const node = row.WbsId ? nodes.get(canonicalActualId(row.WbsId)) : null;
      if (node) node.direct = counts;
      else unplacedTasks = { tasks: unplacedTasks.tasks + counts.tasks, done: unplacedTasks.done + counts.done, overdue: unplacedTasks.overdue + counts.overdue };
    }
    const roots = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const order = (left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code, 'tr') || left.id.localeCompare(right.id);
    const rollupState = new Map();
    const cycleNodes = new Set();
    const path = [];
    const rollup = (node) => {
      const state = rollupState.get(node.id);
      if (state === 'done') return node.subtree;
      if (state === 'visiting') {
        const cycleStart = path.lastIndexOf(node.id);
        for (const id of path.slice(Math.max(0, cycleStart))) cycleNodes.add(id);
        cycleNodes.add(node.id);
        return { tasks: 0, done: 0, overdue: 0 };
      }
      if (path.length > 200) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      rollupState.set(node.id, 'visiting');
      path.push(node.id);
      node.children.sort(order);
      node.subtree = { ...node.direct };
      for (const child of node.children) {
        const sub = rollup(child);
        if (cycleNodes.has(child.id)) cycleNodes.add(node.id);
        node.subtree.tasks += sub.tasks;
        node.subtree.done += sub.done;
        node.subtree.overdue += sub.overdue;
      }
      path.pop();
      rollupState.set(node.id, 'done');
      return node.subtree;
    };
    roots.sort(order);
    roots.forEach((root) => rollup(root));
    for (const node of [...nodes.values()].sort(order)) {
      if (rollupState.get(node.id) === 'done') continue;
      roots.push(node);
      rollup(node);
    }
    let start = roots;
    if (args.wbsId) {
      const focus = nodes.get(args.wbsId);
      if (!focus) throw notFound();
      start = [focus];
    }
    const subtreeNodes = new Set();
    const collectSubtree = (node) => {
      if (subtreeNodes.has(node.id)) return;
      subtreeNodes.add(node.id);
      node.children.forEach(collectSubtree);
    };
    start.forEach(collectSubtree);
    const nodeCount = subtreeNodes.size;
    const listed = [];
    const walked = new Set();
    let omitted = 0;
    let depthTruncated = false;
    const walk = (node, depth) => {
      if (walked.has(node.id)) return;
      walked.add(node.id);
      if (listed.length >= limit) {
        omitted += 1;
        return;
      }
      listed.push({
        wbsId: node.id,
        code: node.code,
        name: node.name,
        depth,
        ...(node.parentId ? { parentWbsId: node.parentId } : {}),
        ...(cycleNodes.has(node.id) ? { malformedCycle: true } : {}),
        childCount: node.children.length,
        directTasks: node.direct.tasks,
        subtreeTasks: cycleNodes.has(node.id) ? null : node.subtree.tasks,
        subtreeOpen: cycleNodes.has(node.id) ? null : node.subtree.tasks - node.subtree.done,
        subtreeOverdue: cycleNodes.has(node.id) ? null : node.subtree.overdue
      });
      if (depth + 1 < depthLimit) node.children.forEach((child) => walk(child, depth + 1));
      else if (node.children.length) depthTruncated = true;
    };
    start.forEach((node) => walk(node, 0));
    const catalogVisible = result.nodes.some((row) => Boolean(row.CatalogVisible)) || access.accessLevel === 'FULL' || access.readGrant || access.ownScoped;
    const descriptor = describeTaskScope([access]);
    return {
      data: {
        project: { projectId: canonicalActualId(args.projectId), name: result.project ? dataText(result.project.ProjectName, 160) : null },
        catalogVisibility: catalogVisible ? 'full-catalog' : 'ancestor-chain-of-visible-tasks',
        nodeCount,
        nodes: listed,
        tasksWithoutWbs: args.wbsId ? null : unplacedTasks,
        notes: [
          'Görev sayıları yalnızca görünür görevler üzerindedir.',
          ...(catalogVisible ? [] : ['Bu projede yalnızca yetkili görevlerinizin bağlı olduğu düğümler ve ataları görünür.']),
          ...(cycleNodes.size ? ['WBS yapısında döngü algılandı; döngülü bağlantılar tekrar izlenmeden düğümler görünür tutuldu.'] : []),
          ...(depthTruncated ? ['İş dağılım ağacı istenen derinlikte kesildi; daha derin düğümler bu sonuçta yer almaz.'] : [])
        ]
      },
      scope: descriptor,
      complete: omitted === 0 && !depthTruncated && cycleNodes.size === 0,
      truncated: omitted > 0 || depthTruncated || cycleNodes.size > 0,
      returnedCount: listed.length,
      totalCount: nodeCount,
      nextCursor: null,
      evidence: {
        label: `İş dağılım yapısı · ${nodeCount} düğüm`,
        entity: { type: 'project', id: canonicalActualId(args.projectId), name: result.project ? dataText(result.project.ProjectName, 120) : null },
        highlights: listed.slice(0, 3).map((node) => `${node.code} · ${node.name}`)
      }
    };
  }
};

export const PROJECT_TOOLS = Object.freeze([projectSearch, projectDetail, portfolioSummary, wbsInspect]);
