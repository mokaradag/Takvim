/**
 * Rota AI alan araçlarının SQL metinleri için bellek içi ikiz.
 *
 * Gerçek metinler (`src/server/ai/tools/rota/rotaToolQueries.js`) ilk
 * satırdaki işaret yorumuyla tanınır ve SQL Server'daki anlamlarıyla BAĞIMSIZ
 * olarak uygulanır: kapsam belirteçleri (`@scopeProjects`, `@scopeTasks`,
 * `@isAdmin`) aynı biçimde çözülür, görünür görev kümesi anlık görüntünün
 * kuralıyla kurulur (FULL/READ → projenin bütün görevleri; kısmi → yalnızca
 * kişisel kapsam), kimlik görünürlüğü ve kişi süzgeci aynı kuralla uygulanır,
 * bağımlılık ve baz plan yalnızca FULL projede döner.
 *
 * İkiz, yetki kararını KENDİSİ vermez: kapsamı yalnızca uygulamanın verdiği
 * parametrelerden okur (tıpkı SQL gibi). Uygulamanın yetki bağlamı ise
 * `loadAuthorizationContext` ikizinden (fakeSqlServer.authorizationRecordsets)
 * gelir. GUID'ler SQL Server gibi BÜYÜK harfle döner.
 */

const MARKER = /^\/\* rota-ai-tool:([a-z-]+) \*\//;

const upper = (value) => (value == null ? null : String(value).toUpperCase());
const same = (left, right) => left != null && right != null && upper(left) === upper(right);
const isGuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const day = (value) => (value == null || value === '' ? null : String(value).slice(0, 10));

/** Turkish_100_CI_AI yaklaşımı: büyük/küçük harf ve aksan duyarsız içerme. */
function fold(value) {
  return String(value ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function charindex(needle, haystack) {
  return fold(needle) ? fold(haystack).indexOf(fold(needle)) + 1 : 0;
}

function executiveOf(db, manager, employee) {
  return db.executiveScope.some((entry) => entry.ManagerSicil === manager && entry.EmployeeSicil === employee);
}

function personName(db, sicil) {
  const person = db.people.find((entry) => Number(entry.Sicil) === Number(sicil));
  const name = person?.DisplayName ? String(person.DisplayName).trim() : '';
  return name || null;
}

function projectRow(db, projectId) {
  return db.projects.find((project) => same(project.ProjectId, projectId)) || null;
}

/** SCOPE_PROJECTS + VISIBLE_TASKS parçalarının karşılığı. */
function scopeOf(db, params, { restrictTasks = null } = {}) {
  const sicil = Number(params.sicil);
  const isAdmin = Boolean(params.isAdmin);
  const projectFilter = params.projectId ? upper(params.projectId) : null;
  const taskFilter = String(params.taskIds || '').split(',').map((value) => value.trim()).filter(isGuid).map(upper);
  const filterActive = restrictTasks ? true : String(params.taskIds || '').length > 0;
  const allowedTasks = new Set(restrictTasks ? restrictTasks.map(upper) : taskFilter);
  const projects = new Map();
  const activeProject = (id) => {
    const project = projectRow(db, id);
    return project && project.IsActive && (!params.sourceFilter || params.sourceFilter === 'all' || (params.sourceFilter === 'corporate') === (project.SourceType === 'CORPORATE')) && (!projectFilter || same(project.ProjectId, projectFilter)) ? project : null;
  };
  if (isAdmin) {
    for (const project of db.projects) {
      if (activeProject(project.ProjectId)) projects.set(upper(project.ProjectId), { AccessLevel: 'FULL', HasReadGrant: 0, IsTaskScoped: 0 });
    }
  } else {
    for (const token of String(params.scopeProjects || '').split(',')) {
      if (token.length !== 40) continue;
      const id = token.slice(0, 36);
      if (!isGuid(id) || !activeProject(id)) continue;
      projects.set(upper(id), {
        AccessLevel: token[37] === 'F' ? 'FULL' : 'PARTIAL',
        HasReadGrant: token[38] === '1' ? 1 : 0,
        IsTaskScoped: token[39] === '1' ? 1 : 0
      });
    }
  }
  const scopedTasks = isAdmin ? new Set() : new Set(String(params.scopeTasks || '').split(',').map((value) => value.trim()).filter(isGuid).map(upper));
  const visible = new Map();
  for (const task of db.tasks) {
    const project = projects.get(upper(task.ProjectId));
    if (!project) continue;
    if (filterActive && !allowedTasks.has(upper(task.TaskId))) continue;
    if (project.AccessLevel === 'FULL' || project.HasReadGrant) {
      visible.set(upper(task.TaskId), { task, AccessLevel: project.AccessLevel, IdentityBase: 1 });
    } else if (scopedTasks.has(upper(task.TaskId))) {
      visible.set(upper(task.TaskId), { task, AccessLevel: 'PARTIAL', IdentityBase: Number(task.CreatedBySicil) === sicil ? 1 : 0 });
    }
  }
  return { sicil, isAdmin, projects, visible };
}

function assigneesOf(db, taskId) {
  return db.taskAssignees.filter((entry) => same(entry.TaskId, taskId));
}

function factRow(db, scope, entry) {
  const { task } = entry;
  const assignees = assigneesOf(db, task.TaskId);
  return {
    TaskId: task.TaskId,
    ProjectId: task.ProjectId,
    WbsId: task.WbsId,
    Title: task.Title,
    Keyword: task.Keyword,
    Status: task.Status,
    Priority: task.Priority,
    IsMilestone: task.IsMilestone ? 1 : 0,
    PlannedStart: task.PlannedStart,
    PlannedFinish: task.PlannedFinish,
    PlannedDurationDays: task.PlannedDurationDays,
    TargetFinish: task.TargetFinish,
    ActualStart: task.ActualStart,
    ActualFinish: task.ActualFinish,
    Progress: task.Progress,
    PlannedHours: task.PlannedHours,
    ActualHours: task.ActualHours,
    Budget: task.Budget,
    Spent: task.Spent,
    RecurrenceRule: task.RecurrenceRule,
    RecurrenceParentTaskId: task.RecurrenceParentTaskId,
    RecurrenceOccurrenceDate: task.RecurrenceOccurrenceDate,
    CreatedAt: task.CreatedAt ?? null,
    UpdatedAt: task.UpdatedAt ?? null,
    AccessLevel: entry.AccessLevel,
    IdentityBase: entry.IdentityBase,
    IsCreator: Number(task.CreatedBySicil) === scope.sicil ? 1 : 0,
    IsOwnAssignee: assignees.some((row) => row.Sicil === scope.sicil) ? 1 : 0,
    AssigneeCount: assignees.length,
    ResolvedAssigneeCount: assignees.filter((row) => personName(db, row.Sicil) != null && (entry.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil))).length
  };
}

function assigneeRows(db, scope, facts) {
  const rows = [];
  for (const fact of facts) {
    for (const assignment of assigneesOf(db, fact.TaskId)) {
      const identityVisible = fact.IdentityBase === 1 || assignment.Sicil === scope.sicil || executiveOf(db, scope.sicil, assignment.Sicil);
      if (!identityVisible && !fact.IsOwnAssignee) continue;
      rows.push({
        TaskId: fact.TaskId,
        Sicil: identityVisible ? assignment.Sicil : null,
        DisplayName: personName(db, assignment.Sicil) ?? (identityVisible ? String(assignment.Sicil) : null),
        IdentityVisible: identityVisible ? 1 : 0,
        Resolved: personName(db, assignment.Sicil) != null ? 1 : 0
      });
    }
  }
  return rows;
}

function taskFacts(db, params) {
  const scope = scopeOf(db, params);
  const text = String(params.text || '');
  const statuses = new Set(String(params.statusCsv || '').split(',').filter(Boolean));
  const priorities = new Set(String(params.priorityCsv || '').split(',').filter(Boolean));
  const dateValue = (task) => {
    switch (params.dateField) {
      case 'targetFinish': return day(task.TargetFinish);
      case 'calendarDate': return day(task.TargetFinish) || day(task.PlannedFinish);
      case 'plannedStart': return day(task.PlannedStart);
      case 'plannedFinish': return day(task.PlannedFinish);
      case 'actualStart': return day(task.ActualStart);
      case 'actualFinish': return day(task.ActualFinish);
      default: return null;
    }
  };
  const matches = [...scope.visible.values()].filter(({ task, IdentityBase }) => {
    if (params.wbsId && !same(task.WbsId, params.wbsId)) return false;
    if (params.seriesId && !same(task.TaskId, params.seriesId) && !same(task.RecurrenceParentTaskId, params.seriesId)) return false;
    if (params.recurringOnly && !task.RecurrenceRule && !task.RecurrenceParentTaskId) return false;
    if (text && charindex(text, `${task.Title} ${task.Keyword || ''}`) === 0) return false;
    if (params.openOnly && task.Status === 'done') return false;
    const target = day(task.TargetFinish);
    if (params.targetFrom && !(target && target >= day(params.targetFrom))) return false;
    if (params.targetTo && !(target && target <= day(params.targetTo))) return false;
    const status = task.Status === 'done' ? 'done' : task.Status === 'in-progress' ? 'in_progress' : 'todo';
    if (statuses.size && !statuses.has(status)) return false;
    const rawPriority = String(task.Priority || '').trim().toLocaleLowerCase('en-US');
    const priority = ['critical', 'high', 'low'].includes(rawPriority) ? rawPriority : 'medium';
    if (priorities.size && !priorities.has(priority)) return false;
    if (params.milestone != null && Boolean(task.IsMilestone) !== Boolean(params.milestone)) return false;
    if (params.deadline) {
      const today = day(params.today);
      const add = (count) => day(new Date(Date.parse(`${today}T00:00:00Z`) + count * 86400000));
      const open = task.Status !== 'done';
      if (params.deadline === 'overdue' && !(open && target && target < today)) return false;
      if (params.deadline === 'due_today' && !(open && target === today)) return false;
      if (params.deadline === 'due_next_7_days' && !(open && target && target >= today && target <= add(6))) return false;
      if (params.deadline === 'due_next_30_days' && !(open && target && target >= today && target <= add(29))) return false;
      if (params.deadline === 'no_target_finish' && !(open && !target)) return false;
    }
    if (params.dateField) {
      const value = dateValue(task);
      if (!value) return false;
      if (params.dateFrom && value < day(params.dateFrom)) return false;
      if (params.dateTo && value > day(params.dateTo)) return false;
    }
    if (params.createdByMe && Number(task.CreatedBySicil) !== scope.sicil) return false;
    const assignments = assigneesOf(db, task.TaskId);
    switch (params.assigneeMode) {
      case 'me': return assignments.some((row) => row.Sicil === scope.sicil);
      case 'unassigned': return !assignments.some((row) => personName(db, row.Sicil) != null && (IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)));
      case 'person': return assignments.some((row) => row.Sicil === Number(params.personSicil)
        && (IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)));
      default: return true;
    }
  }).sort((left, right) => upper(left.task.TaskId).localeCompare(upper(right.task.TaskId)))
    .slice(0, Number(params.maxRows));
  const facts = matches.map((entry) => factRow(db, scope, entry));
  const projects = [...scope.projects.entries()]
    .filter(([id]) => params.projectId || facts.some((fact) => same(fact.ProjectId, id)))
    .map(([id, access]) => {
      const project = projectRow(db, id);
      return { ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, SourceType: project.SourceType, ...access };
    });
  return [facts, projects, params.withAssignees ? assigneeRows(db, scope, facts) : []];
}

function taskDetail(db, params) {
  const scope = scopeOf(db, params);
  const entry = [...scope.visible.values()][0];
  if (!entry) return [[], [], []];
  const fact = factRow(db, scope, entry);
  const { task } = entry;
  const project = projectRow(db, task.ProjectId);
  const access = scope.projects.get(upper(task.ProjectId));
  const creatorVisible = entry.IdentityBase === 1 || fact.IsOwnAssignee === 1;
  const parent = task.RecurrenceParentTaskId ? db.tasks.find((row) => same(row.TaskId, task.RecurrenceParentTaskId) && same(row.ProjectId, task.ProjectId)) : null;
  const scopedTasks = new Set(String(params.scopeTasks || '').split(',').map(upper));
  const parentVisible = parent && (entry.AccessLevel === 'FULL' || access.HasReadGrant || scopedTasks.has(upper(parent.TaskId)));
  const calendar = (id) => db.calendars.find((row) => same(row.CalendarId, id) && row.IsActive);
  const description = task.Description == null ? null : String(task.Description);
  const row = {
    ...fact,
    CalendarId: task.CalendarId,
    RemainingDurationDays: task.RemainingDurationDays,
    Description: description == null ? null : description.slice(0, 1600),
    DescriptionClipped: description != null && description.length > 1600 ? 1 : 0,
    VisibleCreatedBySicil: creatorVisible ? task.CreatedBySicil : null,
    PredecessorCount: entry.AccessLevel === 'FULL' ? db.taskDependencies.filter((dep) => same(dep.ProjectId, task.ProjectId) && same(dep.TaskId, task.TaskId)).length : null,
    SuccessorCount: entry.AccessLevel === 'FULL' ? db.taskDependencies.filter((dep) => same(dep.ProjectId, task.ProjectId) && same(dep.PredecessorTaskId, task.TaskId)).length : null,
    ParentTitle: parentVisible ? parent.Title : null,
    ProjectName: project.ProjectName,
    ProjectCode: project.ProjectCode,
    SourceType: project.SourceType,
    HasReadGrant: access.HasReadGrant,
    IsTaskScoped: access.IsTaskScoped,
    CalendarName: (calendar(task.CalendarId) || calendar(project.CalendarId))?.Name ?? null,
    CreatedByName: creatorVisible && task.CreatedBySicil != null ? personName(db, task.CreatedBySicil) : null
  };
  const chain = [];
  let node = task.WbsId ? db.wbs.find((item) => same(item.WbsId, task.WbsId) && same(item.ProjectId, task.ProjectId)) : null;
  let depth = 0;
  while (node && depth <= 40) {
    chain.push({ WbsId: node.WbsId, ParentWbsId: node.ParentWbsId ?? null, Code: node.Code, Name: node.Name, Depth: depth });
    node = node.ParentWbsId ? db.wbs.find((item) => same(item.WbsId, node.ParentWbsId) && same(item.ProjectId, node.ProjectId)) : null;
    depth += 1;
  }
  chain.sort((left, right) => right.Depth - left.Depth);
  return [[row], chain, assigneeRows(db, scope, [fact])];
}

function projectSearch(db, params) {
  const scope = scopeOf(db, params);
  const text = String(params.text || '');
  const matches = [...scope.projects.entries()].map(([id, access]) => ({ project: projectRow(db, id), access }))
    .filter(({ project }) => (!text && params.projectId) || charindex(text, `${project.ProjectCode || ''} ${project.ProjectName}`) > 0)
    .map(({ project, access }) => {
      const code = String(project.ProjectCode || '');
      const rank = code.toLocaleUpperCase('tr-TR') === text.toLocaleUpperCase('tr-TR') || fold(project.ProjectName) === fold(text) ? 0
        : charindex(text, project.ProjectName) === 1 || charindex(text, code) === 1 ? 1 : 2;
      return {
        ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, SourceType: project.SourceType,
        LeadSicil: project.LeadSicil, ...access, MatchRank: rank
      };
    })
    .sort((left, right) => left.MatchRank - right.MatchRank || left.ProjectName.localeCompare(right.ProjectName, 'tr') || left.ProjectId.localeCompare(right.ProjectId));
  return [[{ Total: matches.length }], matches.slice(0, Number(params.limit)).map((row) => ({ ...row, LeadName: row.LeadSicil == null ? null : personName(db, row.LeadSicil) }))];
}

function aggregate(tasks, params) {
  const today = day(params.today);
  const soonEnd = day(params.soonEnd);
  const open = (task) => task.Status !== 'done';
  const targets = tasks.filter((task) => open(task) && day(task.TargetFinish) && day(task.TargetFinish) >= today).map((task) => day(task.TargetFinish)).sort();
  return {
    TaskCount: tasks.length,
    DoneCount: tasks.filter((task) => task.Status === 'done').length,
    InProgressCount: tasks.filter((task) => task.Status === 'in-progress').length,
    TodoCount: tasks.filter((task) => task.Status !== 'done' && task.Status !== 'in-progress').length,
    OverdueCount: tasks.filter((task) => open(task) && day(task.TargetFinish) && day(task.TargetFinish) < today).length,
    DueSoonCount: tasks.filter((task) => open(task) && day(task.TargetFinish) && day(task.TargetFinish) >= today && day(task.TargetFinish) <= soonEnd).length,
    NoTargetCount: tasks.filter((task) => open(task) && !day(task.TargetFinish)).length,
    OpenMilestoneCount: tasks.filter((task) => open(task) && task.IsMilestone).length,
    NextTargetFinish: targets[0] ?? null,
    LastTaskUpdateAt: null
  };
}

function portfolio(db, params) {
  const scope = scopeOf(db, params);
  const rows = [...scope.projects.entries()].map(([id, access]) => {
    const project = projectRow(db, id);
    const tasks = [...scope.visible.values()].filter((entry) => same(entry.task.ProjectId, id)).map((entry) => entry.task);
    return {
      ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, SourceType: project.SourceType,
      LeadSicil: project.LeadSicil, CalendarId: project.CalendarId, ...access, ...aggregate(tasks, params)
    };
  });
  return [rows];
}

function projectDetail(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access) return [[], [], [aggregate([], params)]];
  const project = projectRow(db, params.projectId);
  const calendar = db.calendars.find((row) => same(row.CalendarId, project.CalendarId) && row.IsActive)
    || db.calendars.find((row) => row.IsDefault && row.IsActive);
  const tasks = [...scope.visible.values()].map((entry) => entry.task);
  return [
    [{
      ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, SourceType: project.SourceType,
      ProjectTypeName: project.ProjectTypeName, LeadSicil: project.LeadSicil, DataDate: project.DataDate, ...access,
      LeadName: project.LeadSicil == null ? null : personName(db, project.LeadSicil),
      CalendarName: calendar?.Name ?? null,
      DependencyCount: access.AccessLevel === 'FULL' ? db.taskDependencies.filter((dep) => same(dep.ProjectId, project.ProjectId)).length : null,
      BaselineCount: access.AccessLevel === 'FULL' ? db.baselines.filter((row) => same(row.ProjectId, project.ProjectId)).length : null,
      WbsNodeCount: access.AccessLevel === 'FULL'
        ? db.wbs.filter((node) => same(node.ProjectId, project.ProjectId)).length
        : null
    }],
    db.projectTags.filter((tag) => same(tag.ProjectId, project.ProjectId)).map((tag) => ({ TagName: tag.TagName })),
    [aggregate(tasks, params)]
  ];
}

function wbs(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access) return [[], [], []];
  const catalog = access.AccessLevel === 'FULL' || access.HasReadGrant || access.IsTaskScoped;
  const required = new Set();
  if (!catalog) {
    for (const entry of scope.visible.values()) {
      let node = entry.task.WbsId ? db.wbs.find((item) => same(item.WbsId, entry.task.WbsId)) : null;
      while (node && !required.has(upper(node.WbsId))) {
        required.add(upper(node.WbsId));
        node = node.ParentWbsId ? db.wbs.find((item) => same(item.WbsId, node.ParentWbsId) && same(item.ProjectId, node.ProjectId)) : null;
      }
    }
  }
  const nodes = db.wbs.filter((node) => same(node.ProjectId, params.projectId) && (catalog || required.has(upper(node.WbsId))))
    .slice(0, Number(params.maxRows))
    .map((node) => ({ ...node, CatalogVisible: catalog ? 1 : 0 }));
  const counts = new Map();
  for (const { task } of scope.visible.values()) {
    const key = task.WbsId ? upper(task.WbsId) : null;
    if (!counts.has(key)) counts.set(key, { WbsId: task.WbsId ?? null, TaskCount: 0, DoneCount: 0, OverdueCount: 0 });
    const entry = counts.get(key);
    entry.TaskCount += 1;
    if (task.Status === 'done') entry.DoneCount += 1;
    else if (day(task.TargetFinish) && day(task.TargetFinish) < day(params.today)) entry.OverdueCount += 1;
  }
  const project = projectRow(db, params.projectId);
  return [nodes, [...counts.values()], [{ ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, ...access }]];
}

function dependencies(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access || access.AccessLevel !== 'FULL') return [[], [], [{ TaskCount: 0, OpenCount: 0 }]];
  const focus = params.focusTaskId ? upper(params.focusTaskId) : null;
  const rows = db.taskDependencies
    .filter((dep) => same(dep.ProjectId, params.projectId) && (!focus || same(dep.TaskId, focus) || same(dep.PredecessorTaskId, focus)))
    .slice(0, Number(params.maxRows))
    .map((dep) => ({ TaskId: dep.TaskId, PredecessorTaskId: dep.PredecessorTaskId, DependencyType: dep.DependencyType, LagDays: dep.LagDays, LagValue: dep.LagValue, LagUnit: dep.LagUnit }));
  const involved = new Set([focus, ...rows.flatMap((row) => [upper(row.TaskId), upper(row.PredecessorTaskId)])].filter(Boolean));
  const projectTasks = db.tasks.filter((task) => same(task.ProjectId, params.projectId));
  return [
    rows,
    projectTasks.filter((task) => involved.has(upper(task.TaskId))).map((task) => ({
      TaskId: task.TaskId, Title: task.Title, Status: task.Status, PlannedStart: task.PlannedStart, PlannedFinish: task.PlannedFinish,
      TargetFinish: task.TargetFinish, IsMilestone: task.IsMilestone
    })),
    [{ TaskCount: projectTasks.length, OpenCount: projectTasks.filter((task) => task.Status !== 'done').length }]
  ];
}

function baseline(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  const full = Boolean(access && access.AccessLevel === 'FULL');
  const ordered = db.baselines.filter((row) => full && same(row.ProjectId, params.projectId))
    .sort((left, right) => (Number(right.IsPrimary) - Number(left.IsPrimary)) || String(right.CreatedAt).localeCompare(String(left.CreatedAt)));
  const selected = ordered.find((row) => !params.baselineId || same(row.BaselineId, params.baselineId)) || null;
  const snapshots = selected
    ? db.taskBaselineSnapshots.filter((row) => same(row.BaselineId, selected.BaselineId)).slice(0, Number(params.maxRows)).map((row) => {
      const task = db.tasks.find((item) => same(item.TaskId, row.TaskId) && same(item.ProjectId, params.projectId));
      return {
        TaskId: row.TaskId, BaselineStart: row.PlannedStart, BaselineFinish: row.PlannedFinish, BaselineDuration: row.PlannedDurationDays,
        TaskExists: task ? 1 : 0, Title: task?.Title ?? null, Status: task?.Status ?? null, PlannedStart: task?.PlannedStart ?? null,
        PlannedFinish: task?.PlannedFinish ?? null, TargetFinish: task?.TargetFinish ?? null, ActualFinish: task?.ActualFinish ?? null
      };
    })
    : [];
  const added = selected
    ? db.tasks.filter((task) => same(task.ProjectId, params.projectId)
      && !db.taskBaselineSnapshots.some((row) => same(row.BaselineId, selected.BaselineId) && same(row.TaskId, task.TaskId))).length
    : 0;
  return [
    ordered.slice(0, 10).map((row) => ({ BaselineId: row.BaselineId, Name: row.Name, CreatedAt: row.CreatedAt, IsPrimary: row.IsPrimary ? 1 : 0,
      SnapshotCount: (() => { const count = db.taskBaselineSnapshots.filter((snapshot) => same(snapshot.BaselineId, row.BaselineId)).length; return count >= Number(params.analysisMaxRows) ? null : count; })() })),
    [{ ProjectFull: full ? 1 : 0, SelectedBaselineId: selected?.BaselineId ?? null, BaselineTotal: ordered.length }],
    snapshots,
    [{ AddedSinceBaseline: added }]
  ];
}

function calendar(db, params) {
  const scope = scopeOf(db, params);
  const projectVisible = Boolean(params.projectId && scope.projects.has(upper(params.projectId)));
  const project = projectVisible ? projectRow(db, params.projectId) : null;
  const active = (id) => db.calendars.find((row) => same(row.CalendarId, id) && row.IsActive) || null;
  const chosen = (project && active(project.CalendarId)) || db.calendars.find((row) => row.IsDefault && row.IsActive) || null;
  return [
    [{ ProjectVisible: projectVisible ? 1 : 0, CalendarId: chosen?.CalendarId ?? null, Name: chosen?.Name ?? null, TimeZone: chosen?.TimeZone ?? null, IsDefault: chosen?.IsDefault ? 1 : 0 }],
    chosen ? chosen.WorkingDays.map((weekday) => ({ Weekday: weekday })) : [],
    chosen ? chosen.Holidays.filter((holiday) => holiday.date >= day(params.from) && holiday.date <= day(params.to))
      .map((holiday) => ({ HolidayDate: holiday.date, Name: holiday.name, ShortName: holiday.short ?? null })) : []
  ];
}

function outlook(db, params) {
  const sicil = Number(params.sicil);
  const own = db.taskOutlookSubscriptions.filter((row) => row.UserSicil === sicil && row.IsActive);
  const explicit = String(params.taskIds || '').split(',').filter(isGuid).map(upper);
  const candidates = explicit.length ? explicit : own.map((row) => upper(row.TaskId));
  const scope = scopeOf(db, params, { restrictTasks: candidates });
  const counted = own.filter((row) => !explicit.length || explicit.includes(upper(row.TaskId)));
  const visibleRows = counted.filter((row) => scope.visible.has(upper(row.TaskId))).slice(0, Number(params.maxRows)).map((row) => {
    const task = scope.visible.get(upper(row.TaskId)).task;
    const project = projectRow(db, task.ProjectId);
    return {
      TaskId: row.TaskId, Title: task.Title, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, TargetFinish: task.TargetFinish,
      PlannedFinish: task.PlannedFinish, Status: task.Status, PendingMethod: row.PendingMethod, DeliveredSequence: row.DeliveredSequence,
      DeliveredMethod: row.DeliveredMethod, DeliveredDate: row.DeliveredDate, LastDeliveredAt: row.LastDeliveredAt ?? null,
      LastFailureCode: row.LastFailureCode ?? null, AttemptCount: row.AttemptCount, CompletionSuspended: row.CompletionSuspended, UpdatedAt: null
    };
  });
  return [visibleRows, [{ HasNonVisibleSubscriptions: counted.some((row) => !scope.visible.has(upper(row.TaskId))) }]];
}

const HANDLERS = Object.freeze({
  'task-facts': taskFacts,
  'task-detail': taskDetail,
  'project-search': projectSearch,
  portfolio,
  'project-detail': projectDetail,
  wbs,
  dependencies,
  baseline,
  calendar,
  outlook
});

export function runAiToolQuery(db, sqlText, params) {
  const marker = MARKER.exec(sqlText);
  if (!marker) return null;
  db.aiToolLog ||= [];
  db.aiToolLog.push({ query: marker[1], params: { ...params } });
  if (db.aiToolFailure?.[marker[1]]) throw db.aiToolFailure[marker[1]];
  // Independently enforce the SQL population budget before computing result sets.
  const boundedTaskQueries = new Set(['task-facts', 'task-detail', 'portfolio', 'project-detail', 'wbs', 'baseline']);
  if (boundedTaskQueries.has(marker[1]) || (marker[1] === 'dependencies' && !params.focusTaskId)) {
    const scope = scopeOf(db, params);
    const cap = Number(params.analysisMaxRows);
    const tooLarge = () => { const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error; };
    const hasSelectedBaseline = marker[1] !== 'baseline' || db.baselines.some((row) => scope.projects.get(upper(params.projectId))?.AccessLevel === 'FULL'
      && same(row.ProjectId, params.projectId) && (!params.baselineId || same(row.BaselineId, params.baselineId)));
    if (hasSelectedBaseline && scope.visible.size >= cap) tooLarge();
    if (['task-facts', 'task-detail'].includes(marker[1])) {
      const ownTasks = new Set(db.taskAssignees.filter((row) => row.Sicil === scope.sicil).map((row) => upper(row.TaskId)));
      const associations = db.taskAssignees.filter((row) => {
        const visible = scope.visible.get(upper(row.TaskId));
        return visible && (visible.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)
          || ownTasks.has(upper(row.TaskId)));
      });
      if (associations.length >= cap) tooLarge();
    }
    if (marker[1] === 'baseline') {
      const access = scope.projects.get(upper(params.projectId));
      const selected = db.baselines.filter((row) => access?.AccessLevel === 'FULL' && same(row.ProjectId, params.projectId)
        && (!params.baselineId || same(row.BaselineId, params.baselineId)))
        .sort((a, b) => Number(b.IsPrimary) - Number(a.IsPrimary) || String(b.CreatedAt).localeCompare(String(a.CreatedAt)))[0];
      if (selected && db.taskBaselineSnapshots.filter((row) => same(row.BaselineId, selected.BaselineId)).length >= cap) tooLarge();
    }
  }
  const handler = HANDLERS[marker[1]];
  if (!handler) throw new Error(`Fake SQL Server: desteklenmeyen araç sorgusu: ${marker[1]}`);
  return handler(db, params);
}
