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

import { createHash } from 'node:crypto';
import { parseIsoTimestampNanos } from '../../src/domain/ai/report/reportRequest.js';

const canonicalStatus = (value) => ['done', 'completed', 'cancelled'].includes(value) ? 'done'
  : ['in-progress', 'in_progress', 'blocked'].includes(value) ? 'in_progress' : 'todo';

const DONE_AUDIT_STATUS_ALIASES = new Set(['done', 'completed', 'cancelled']);

function isSqlDoneAuditStatus(value) {
  if (typeof value !== 'string') return false;
  // SQL Server ANSI dizge karşılaştırmasında yalnızca sondaki boşlukları yoksayar; baştaki boşluk ve harf büyüklüğü korunur.
  return DONE_AUDIT_STATUS_ALIASES.has(value.replace(/ +$/u, ''));
}

function sqlJsonValueStatus(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // SQL Server lax JSON_VALUE 4000 karakteri aşan skaler değerlerde NULL döner ve COALESCE sonraki alana düşer.
  const asSqlScalar = (val) => {
    if (val === null || val === undefined || typeof val === 'object') return null;
    const str = String(val);
    return str.length <= 4000 ? str : null;
  };
  return asSqlScalar(obj.Status) ?? asSqlScalar(obj.status) ?? null;
}

function wbsSubtree(db, params) {
  if (!params.wbsId) return null;
  const ids = new Set([upper(params.wbsId)]);
  let size;
  do {
    size = ids.size;
    for (const node of db.wbs) if (same(node.ProjectId, params.projectId) && ids.has(upper(node.ParentWbsId))) ids.add(upper(node.WbsId));
  } while (size !== ids.size);
  return ids;
}

const MARKER = /^\/\* rota-ai-tool:([a-z-]+) \*\//;

const upper = (value) => (value == null ? null : String(value).toUpperCase());
const same = (left, right) => left != null && right != null && upper(left) === upper(right);
const isGuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const day = (value) => (value == null || value === '' ? null : String(value).slice(0, 10));

/** SQL Server uniqueidentifier sıralama anahtarı: önce son 6 bayt, sonra 4., 3., 2. ve 1. gruplar. */
function sqlGuidSortKey(guid) {
  const clean = upper(guid || '').replace(/-/g, '');
  if (clean.length !== 32) return clean;
  const g1 = clean.slice(0, 8);
  const g2 = clean.slice(8, 12);
  const g3 = clean.slice(12, 16);
  const g4 = clean.slice(16, 20);
  const g5 = clean.slice(20, 32);
  const swap16 = (hex) => hex.slice(2, 4) + hex.slice(0, 2);
  const swap32 = (hex) => hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);
  return `${g5}${g4}${swap16(g3)}${swap16(g2)}${swap32(g1)}`;
}

/** Üretimdeki Unicode boşluk kırpılmış HASHBYTES('SHA2_256', ...) karşılığı. */
function trimUnicodeSpan(raw) {
  if (raw == null) return '';
  return String(raw).replace(/^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/gu, '');
}

function descriptionHash(raw) {
  if (raw == null) return null;
  const trimmed = trimUnicodeSpan(raw);
  return createHash('sha256').update(trimmed, 'utf16le').digest('hex').toUpperCase();
}

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

/** Ekip üyeliği (MR_V_ExecutiveScope, kullanıcı hariç); düzey verilirse yalnızca o ScopeType. */
function liveTeamMemberOf(db, manager, employee, level) {
  return Number(employee) !== Number(manager) && db.executiveScope.some((entry) => entry.ManagerSicil === manager && entry.EmployeeSicil === Number(employee)
    && (!level || (entry.ScopeType || 'UNIT') === level));
}

/**
 * Kadroyla okunan toplu işin üyelik anlık görüntüsü (üretimde #AiRosterStart): kadro sonuç kümesi, ekip görevi (ROSTER_TEAM_TASK) ve
 * ekip üyesi (ROSTER_TEAM_MEMBER) koşulları AYNI kümeyi kullanır. Kadrosuz okumada null döner (üyelik canlı görünümdendir).
 * Sınama kancaları: `rosterSnapshotEmpty` anlık görüntüyü boşaltır; `rosterSnapshotMembers` toplu işin başında alınmış farklı bir
 * üyeliği taklit eder (canlı görünümden farkı üretimdeki gibi MembershipChanged = 1 verir).
 */
function rosterSnapshot(db, params) {
  if (Number(params.withRoster) !== 1 || params.assigneeMode !== 'team') return null;
  if (db.rosterSnapshotEmpty) return new Set();
  if (Array.isArray(db.rosterSnapshotMembers)) return new Set(db.rosterSnapshotMembers.map(Number).filter((employee) => employee !== Number(params.sicil)));
  return new Set(liveRoster(db, params));
}

function liveRoster(db, params) {
  const sicil = Number(params.sicil);
  const level = params.teamLevel || '';
  const selectedFilter = new Set(
    String(params.assigneeSicils || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
  return [...new Set(db.executiveScope.filter((entry) => entry.ManagerSicil === sicil && Number(entry.EmployeeSicil) !== sicil
    && (!level || (entry.ScopeType || 'UNIT') === level)
    && (selectedFilter.size === 0 || selectedFilter.has(Number(entry.EmployeeSicil)))).map((entry) => Number(entry.EmployeeSicil)))].sort((a, b) => a - b);
}

function teamMemberOf(db, params, manager, employee) {
  const snapshot = rosterSnapshot(db, params);
  return snapshot ? snapshot.has(Number(employee)) : liveTeamMemberOf(db, manager, employee, params.teamLevel);
}

function personName(db, sicil) {
  const person = db.people.find((entry) => Number(entry.Sicil) === Number(sicil));
  const name = person?.DisplayName ? String(person.DisplayName).trim() : '';
  return name || null;
}

function personOrg(db, sicil, field) {
  const person = db.people.find((entry) => Number(entry.Sicil) === Number(sicil));
  const value = person?.[field] == null ? '' : String(person[field]).trim();
  return value || null;
}

/** Görev olgusu toplu işinin ekip kadrosu sonuç kümesi: anlık görüntüdeki çalışanlar (kullanıcı hariç), Sicil sırasıyla. */
function teamRoster(db, params, facts = [], assignees = []) {
  const members = [...rosterSnapshot(db, params)].sort((a, b) => a - b);
  const live = liveRoster(db, params);
  // Üretimdeki kadro/atama tutarlılığı: okunan görevlerde kadro üyesinin ataması kimliği açık atama olarak dönmediyse 1.
  const snapshot = new Set(members);
  const inconsistent = facts.some((fact) => assigneesOf(db, fact.TaskId).some((assignment) => snapshot.has(Number(assignment.Sicil))
    && !assignees.some((row) => row.TaskId === fact.TaskId && Number(row.Sicil) === Number(assignment.Sicil) && row.IdentityVisible === 1)));
  // Üretimdeki @rosterChanged: anlık görüntü ile toplu işin sonundaki canlı üyelik farklıysa 1. `rosterMembershipChanged` kancası,
  // üyeliğin toplu iş sırasında değişip eski hâline dönmesini (kümeler aynı, işaret 1) taklit eder.
  const changed = db.rosterMembershipChanged || inconsistent || JSON.stringify(members) !== JSON.stringify(live) ? 1 : 0;
  return members.slice(0, Number(params.rosterRows)).map((employee) => ({ Sicil: employee, DisplayName: personName(db, employee), MembershipChanged: changed }));
}

function projectRow(db, projectId) {
  return db.projects.find((project) => same(project.ProjectId, projectId)) || null;
}

/** SCOPE_PROJECTS + VISIBLE_TASKS parçalarının karşılığı. */
function scopeOf(db, params, { restrictTasks = null, filterByAssignees = false } = {}) {
  const sicil = Number(params.sicil);
  const isAdmin = Boolean(params.isAdmin);
  const projectFilter = params.projectId ? upper(params.projectId) : null;
  const projectFilters = new Set(String(params.projectIds || '').split(',').filter(isGuid).map(upper));
  const taskFilter = String(params.taskIds || '').split(',').map((value) => value.trim()).filter(isGuid).map(upper);
  const filterActive = restrictTasks ? true : String(params.taskIds || '').length > 0;
  const allowedTasks = new Set(restrictTasks ? restrictTasks.map(upper) : taskFilter);
  const assigneeFilter = filterByAssignees
    ? new Set(String(params.assigneeSicils || '').split(',').map((v) => Number(v.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))
    : new Set();
  const scopeCutOffMs = params.cutOffUtc ? new Date(params.cutOffUtc).getTime() : null;
  const projects = new Map();
  const projectIndex = new Map(db.projects.map((row) => [upper(row.ProjectId), row]));
  const activeProject = (id) => {
    const project = projectIndex.get(upper(id));
    if (!project || !project.IsActive) return null;
    if (params.projectSearchText && charindex(params.projectSearchText, `${project.ProjectCode || ''} ${project.ProjectName}`) <= 0) return null;
    if (params.sourceFilter && params.sourceFilter !== 'all' && (params.sourceFilter === 'corporate') !== (project.SourceType === 'CORPORATE')) return null;
    if (projectFilter && !same(project.ProjectId, projectFilter)) return null;
    if (projectFilters.size && !projectFilters.has(upper(project.ProjectId))) return null;
    if (filterActive && !db.tasks.some((task) => same(task.ProjectId, project.ProjectId) && allowedTasks.has(upper(task.TaskId)))) return null;
    if (assigneeFilter.size > 0 && !db.tasks.some((task) => same(task.ProjectId, project.ProjectId)
      && (scopeCutOffMs == null || !task.CreatedAt || new Date(task.CreatedAt).getTime() <= scopeCutOffMs)
      && assigneesOf(db, task.TaskId).some((ta) => assigneeFilter.has(Number(ta.Sicil))))) {
      return null;
    }
    return project;
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

function factRow(db, scope, entry, params = {}) {
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
    HasDescription: params.includeHasDescription === 0 ? null : (String(task.Description ?? '').trim() ? 1 : 0),
    AccessLevel: entry.AccessLevel,
    IdentityBase: entry.IdentityBase,
    IsCreator: Number(task.CreatedBySicil) === scope.sicil ? 1 : 0,
    IsOwnAssignee: assignees.some((row) => row.Sicil === scope.sicil) ? 1 : 0,
    DisclosedAssigneeCount: assignees.filter((row) => entry.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)).length,
    ResolvedAssigneeCount: assignees.filter((row) => personName(db, row.Sicil) != null && (entry.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil))).length,
    IsTeamTask: params.assigneeMode === 'team' && assignees.some((row) => teamMemberOf(db, params, scope.sicil, row.Sicil)) ? 1 : 0
  };
}

function assigneeRows(db, scope, facts, params = {}) {
  const rows = [];
  for (const fact of facts) {
    for (const assignment of assigneesOf(db, fact.TaskId)) {
      // `assignmentScopeExcluded`: atama okumaları sırasında yönetim kapsamından geçici olarak çıkmış çalışanları taklit eder
      // (kadro anlık görüntüsü ve toplu işin sonundaki canlı üyelik değişmez).
      const identityVisible = fact.IdentityBase === 1 || assignment.Sicil === scope.sicil
        || (executiveOf(db, scope.sicil, assignment.Sicil) && !(db.assignmentScopeExcluded || []).includes(Number(assignment.Sicil)));
      if (!identityVisible && !fact.IsOwnAssignee) continue;
      rows.push({
        TaskId: fact.TaskId,
        Sicil: identityVisible ? assignment.Sicil : null,
        DisplayName: personName(db, assignment.Sicil) ?? (identityVisible ? String(assignment.Sicil) : null),
        IdentityVisible: identityVisible ? 1 : 0,
        Resolved: personName(db, assignment.Sicil) != null ? 1 : 0,
        TeamMember: params.assigneeMode === 'team' && teamMemberOf(db, params, scope.sicil, assignment.Sicil) ? 1 : 0,
        // Aşama G: dizindeki birim/bölüm yalnızca kimliği açık sorumluda döner.
        Unit: identityVisible ? personOrg(db, assignment.Sicil, 'Unit') : null,
        Department: identityVisible ? personOrg(db, assignment.Sicil, 'Department') : null,
        Directorate: identityVisible ? personOrg(db, assignment.Sicil, 'Directorate') : null
      });
    }
  }
  return rows;
}

function taskFacts(db, params) {
  if (params.assigneeMode === 'team' && !db.executiveScope.some((entry) => entry.ManagerSicil === Number(params.sicil) && entry.EmployeeSicil !== Number(params.sicil)
    && (!params.teamLevel || (entry.ScopeType || 'UNIT') === params.teamLevel))) {
    const error = new Error('AI_TOOL_SCOPE_UNAVAILABLE'); error.number = 51002; throw error;
  }
  const scope = scopeOf(db, params, { filterByAssignees: true });
  const text = String(params.text || '');
  const statuses = new Set(String(params.statusCsv || '').split(',').filter(Boolean));
  const priorities = new Set(String(params.priorityCsv || '').split(',').filter(Boolean));
  const cutOffMs = params.cutOffUtc ? new Date(params.cutOffUtc).getTime() : null;
  const assigneeSicilsFilter = new Set(
    String(params.assigneeSicils || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
  const dateValue = (task) => {
    switch (params.dateField) {
      case 'targetFinish': return day(task.TargetFinish);
      case 'calendarDate': return day(task.TargetFinish) || day(task.PlannedFinish);
      case 'plannedStart': return day(task.PlannedStart);
      case 'plannedFinish': return day(task.PlannedFinish);
      case 'actualStart': return day(task.ActualStart);
      case 'actualFinish': return day(task.ActualFinish);
      // SQL: kayıt anının Türkiye günü (UTC → Turkey Standard Time).
      case 'createdAt': return task.CreatedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(task.CreatedAt)) : null;
      default: return null;
    }
  };
  const filtered = [...scope.visible.values()].filter(({ task, IdentityBase }) => {
    if (cutOffMs != null && task.CreatedAt && new Date(task.CreatedAt).getTime() > cutOffMs) return false;
    if (params.wbsId && !same(task.WbsId, params.wbsId)) return false;
    if (params.seriesId && !same(task.TaskId, params.seriesId) && !same(task.RecurrenceParentTaskId, params.seriesId)) return false;
    if (params.recurringOnly && !task.RecurrenceRule && !task.RecurrenceParentTaskId) return false;
    if (text && charindex(text, `${task.Title} ${task.Keyword || ''}`) === 0) return false;
    if (params.openOnly && canonicalStatus(task.Status) === 'done') return false;
    const target = day(task.TargetFinish);
    if (params.targetFrom && !(target && target >= day(params.targetFrom))) return false;
    if (params.targetTo && !(target && target <= day(params.targetTo))) return false;
    const status = canonicalStatus(task.Status);
    if (statuses.size && !statuses.has(status)) return false;
    const rawPriority = String(task.Priority || '').trim().toLocaleLowerCase('en-US');
    const priority = ['critical', 'high', 'low'].includes(rawPriority) ? rawPriority : 'medium';
    if (priorities.size && !priorities.has(priority)) return false;
    if (params.milestone != null && Boolean(task.IsMilestone) !== Boolean(params.milestone)) return false;
    if (params.deadline) {
      const today = day(params.today);
      const add = (count) => day(new Date(Date.parse(`${today}T00:00:00Z`) + count * 86400000));
      const open = canonicalStatus(task.Status) !== 'done';
      if (params.deadline === 'overdue' && !(open && target && target < today)) return false;
      if (params.deadline === 'due_today' && !(open && target === today)) return false;
      if (params.deadline === 'due_next_7_days' && !(open && target && target >= today && target <= add(6))) return false;
      if (params.deadline === 'due_next_30_days' && !(open && target && target >= today && target <= add(29))) return false;
      if (params.deadline === 'no_target_finish' && !(open && !target)) return false;
    }
    if (params.hasDescription && !String(task.Description || '').trim()) return false;
    if (params.dateField && !(params.includeUndated && !day(task.ActualFinish) && status === 'done')) {
      if (params.dateField === 'actualFinish' && (!params.today || day(task.ActualFinish) > day(params.today))) return false;
      const value = dateValue(task);
      if (!value) return false;
      if (params.dateFrom && value < day(params.dateFrom)) return false;
      if (params.dateTo && value > day(params.dateTo)) return false;
    }
    if (params.createdByMe && Number(task.CreatedBySicil) !== scope.sicil) return false;
    const assignments = assigneesOf(db, task.TaskId);
    if (assigneeSicilsFilter.size > 0) {
      const matchesSelected = assignments.some((row) => assigneeSicilsFilter.has(Number(row.Sicil))
        && (IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)));
      if (!matchesSelected) return false;
    }
    switch (params.assigneeMode) {
      case 'me': return assignments.some((row) => row.Sicil === scope.sicil);
      case 'unassigned': return IdentityBase === 1 && assignments.length === 0;
      case 'person': return assignments.some((row) => row.Sicil === Number(params.personSicil)
        && (IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)));
      case 'team': return assignments.some((row) => teamMemberOf(db, params, scope.sicil, row.Sicil));
      default: return true;
    }
  });
  // Üretimdeki #AiTasks analiz sınırı: süzgeç sonrası kalan görevler @analysisMaxRows sınırına ulaşamaz.
  if (Number.isFinite(Number(params.analysisMaxRows)) && filtered.length >= Number(params.analysisMaxRows)) {
    const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error;
  }
  // Üretimdeki ASSIGNMENT_FACTS sınırı: tüm süzülmüş görevlerin görünür atama sayısı @analysisAssignmentRows sınırını aşamaz.
  if (Number.isFinite(Number(params.analysisAssignmentRows)) && Number(params.analysisAssignmentRows) > 0) {
    let totalAssignments = 0;
    for (const entry of filtered) {
      for (const row of assigneesOf(db, entry.task.TaskId)) {
        if (entry.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)) {
          totalAssignments += 1;
        }
      }
      if (totalAssignments >= Number(params.analysisAssignmentRows)) {
        const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error;
      }
    }
  }
  const matches = filtered
    .sort((left, right) => sqlGuidSortKey(left.task.TaskId).localeCompare(sqlGuidSortKey(right.task.TaskId)))
    .slice(0, Number(params.maxRows));
  const facts = matches.map((entry) => factRow(db, scope, entry, params));
  const projects = [...scope.projects.entries()]
    .filter(([id]) => params.projectId || facts.some((fact) => same(fact.ProjectId, id)))
    .map(([id, access]) => {
      const project = projectRow(db, id);
      return { ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, SourceType: project.SourceType, ...access };
    });
  const assignees = params.withAssignees ? assigneeRows(db, scope, facts, params) : [];
  const results = [facts, projects, assignees];
  if (Number(params.withRoster) === 1 && params.assigneeMode === 'team') {
    results.push(teamRoster(db, params, facts, assignees));
  }
  if (cutOffMs != null) {
    const fullOrRead = new Set();
    for (const token of String(params.scopeProjects || '').split(',')) {
      if (token.length !== 40) continue;
      const id = token.slice(0, 36);
      if (isGuid(id) && (token[37] === 'F' || token[38] === '1')) fullOrRead.add(upper(id));
    }
    const projectFilter = params.projectId ? upper(params.projectId) : null;
    const projectFilters = new Set(String(params.projectIds || '').split(',').filter(isGuid).map(upper));
    const hasPostCutoffDeletion = (db.auditLog || []).some((row) => {
      if (row.EntityType !== 'TASK' || row.ActionCode !== 'DELETE') return false;
      if (new Date(row.OccurredAt).getTime() <= cutOffMs) return false;
      const proj = projectRow(db, row.ProjectId);
      if (!proj?.IsActive) return false;
      if (projectFilter && !same(proj.ProjectId, projectFilter)) return false;
      if (projectFilters.size > 0 && !projectFilters.has(upper(proj.ProjectId))) return false;
      let snap = null;
      try {
        const parsed = typeof row.BeforeJson === 'string' ? JSON.parse(row.BeforeJson) : row.BeforeJson;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snap = parsed;
      } catch {
        snap = null;
      }
      const deletedAssignees = Array.isArray(snap?.assigneeIds)
        ? snap.assigneeIds.filter((v) => typeof v === 'number' || typeof v === 'string').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
        : [];
      const createdByVal = snap?.CreatedBySicil;
      const createdBySicil = (typeof createdByVal === 'string' || typeof createdByVal === 'number') ? Number(createdByVal) : Number.NaN;
      const authorized = scope.isAdmin
        || fullOrRead.has(upper(proj.ProjectId))
        || createdBySicil === scope.sicil
        || deletedAssignees.some((id) => id === scope.sicil || executiveOf(db, scope.sicil, id));
      if (!authorized) return false;
      if (assigneeSicilsFilter.size > 0 && !deletedAssignees.some((id) => assigneeSicilsFilter.has(id))) return false;
      const mode = params.assigneeMode || 'any';
      if (mode === 'any') return true;
      if (mode === 'me') return deletedAssignees.includes(scope.sicil);
      if (mode === 'person') return deletedAssignees.includes(Number(params.personSicil));
      if (mode === 'team') return deletedAssignees.some((id) => teamMemberOf(db, params, scope.sicil, id));
      return false;
    });
    const factTaskIds = new Set(facts.map((row) => upper(row.TaskId)));
    const scopedTaskSet = new Set(String(params.scopeTasks || '').split(',').map((v) => v.trim()).filter(isGuid).map(upper));
    const taskCreatedAfterCutoff = (entityId) => {
      const live = (db.tasks || []).find((t) => same(t.TaskId, entityId));
      return Boolean(live?.CreatedAt && new Date(live.CreatedAt).getTime() > cutOffMs);
    };
    const hasPostCutoffProjectMove = Boolean(projectFilter || projectFilters.size > 0) && (db.auditLog || []).some((row) => {
      if (row.EntityType !== 'TASK' || row.ActionCode !== 'UPDATE') return false;
      if (new Date(row.OccurredAt).getTime() <= cutOffMs) return false;
      let snap = null;
      try {
        const parsed = typeof row.BeforeJson === 'string' ? JSON.parse(row.BeforeJson) : row.BeforeJson;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snap = parsed;
      } catch {
        snap = null;
      }
      const rawBeforeProj = snap?.ProjectId ?? snap?.projectId ?? null;
      if (typeof rawBeforeProj !== 'string' || !isGuid(rawBeforeProj)) return false;
      const beforeProjId = upper(rawBeforeProj);
      if (same(beforeProjId, row.ProjectId)) return false;
      const bp = projectRow(db, beforeProjId);
      if (!bp?.IsActive) return false;
      if (projectFilter && !same(beforeProjId, projectFilter)) return false;
      if (projectFilters.size > 0 && !projectFilters.has(beforeProjId)) return false;
      const entityId = isGuid(row.EntityId) ? upper(row.EntityId) : null;
      if (!entityId || factTaskIds.has(entityId) || taskCreatedAfterCutoff(entityId)) return false;
      return scope.isAdmin || fullOrRead.has(beforeProjId) || scopedTaskSet.has(entityId);
    });
    const modeForMove = params.assigneeMode || 'any';
    const hasAssigneeScopeFilter = ['me', 'person', 'team'].includes(modeForMove) || assigneeSicilsFilter.size > 0;
    const hasPostCutoffAssigneeMove = hasAssigneeScopeFilter && (db.auditLog || []).some((row) => {
      if (row.EntityType !== 'TASK' || row.ActionCode !== 'UPDATE') return false;
      if (new Date(row.OccurredAt).getTime() <= cutOffMs) return false;
      const proj = projectRow(db, row.ProjectId);
      if (!proj?.IsActive) return false;
      if (projectFilter && !same(proj.ProjectId, projectFilter)) return false;
      if (projectFilters.size > 0 && !projectFilters.has(upper(proj.ProjectId))) return false;
      const entityId = isGuid(row.EntityId) ? upper(row.EntityId) : null;
      if (!entityId || factTaskIds.has(entityId) || taskCreatedAfterCutoff(entityId)) return false;
      let snap = null;
      try {
        const parsed = typeof row.BeforeJson === 'string' ? JSON.parse(row.BeforeJson) : row.BeforeJson;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snap = parsed;
      } catch {
        snap = null;
      }
      if (!Array.isArray(snap?.assigneeIds)) return false;
      const beforeAssignees = snap.assigneeIds
        .filter((v) => typeof v === 'number' || typeof v === 'string')
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      if (beforeAssignees.length === 0) return false;
      const createdByVal = snap?.CreatedBySicil;
      const createdBySicil = (typeof createdByVal === 'string' || typeof createdByVal === 'number') ? Number(createdByVal) : Number.NaN;
      const authorized = scope.isAdmin
        || fullOrRead.has(upper(proj.ProjectId))
        || scopedTaskSet.has(entityId)
        || createdBySicil === scope.sicil
        || beforeAssignees.some((id) => id === scope.sicil || executiveOf(db, scope.sicil, id));
      if (!authorized) return false;
      if (assigneeSicilsFilter.size > 0 && !beforeAssignees.some((id) => assigneeSicilsFilter.has(id))) return false;
      if (modeForMove === 'any') return true;
      if (modeForMove === 'me') return beforeAssignees.includes(scope.sicil);
      if (modeForMove === 'person') return beforeAssignees.includes(Number(params.personSicil));
      if (modeForMove === 'team') return beforeAssignees.some((id) => teamMemberOf(db, params, scope.sicil, id));
      return false;
    });
    const hasPostCutoffScopeMove = hasPostCutoffProjectMove || hasPostCutoffAssigneeMove;
    results.push([{
      HasPostCutoffDeletion: hasPostCutoffDeletion ? 1 : 0,
      HasPostCutoffScopeMove: hasPostCutoffScopeMove ? 1 : 0
    }]);
    const factTaskProject = new Map(facts.map((row) => [upper(row.TaskId), upper(row.ProjectId)]));
    const transitionsByTask = new Map();
    for (const row of db.auditLog || []) {
      if (row.EntityType !== 'TASK' || !['CREATE', 'UPDATE'].includes(row.ActionCode)) continue;
      const occurredMs = new Date(row.OccurredAt).getTime();
      if (!Number.isFinite(occurredMs) || occurredMs > cutOffMs) continue;
      const taskId = isGuid(row.EntityId) ? upper(row.EntityId) : null;
      if (!taskId || !factTaskProject.has(taskId)) continue;
      const proj = projectRow(db, row.ProjectId);
      if (!proj?.IsActive) continue;
      const auditProjectId = upper(proj.ProjectId);
      if (!scope.isAdmin && auditProjectId !== factTaskProject.get(taskId) && !fullOrRead.has(auditProjectId)) continue;
      const parseObj = (raw) => {
        if (!raw) return null;
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      };
      const targetFinishField = (obj) => {
        if (!obj) return { present: false, value: '' };
        const hasUpper = Object.hasOwn(obj, 'TargetFinish');
        const hasLower = Object.hasOwn(obj, 'targetFinish');
        if (!hasUpper && !hasLower) return { present: false, value: '' };
        const raw = typeof obj.TargetFinish === 'string' ? obj.TargetFinish : (typeof obj.targetFinish === 'string' ? obj.targetFinish : '');
        return { present: true, value: raw ? raw.slice(0, 10) : '' };
      };
      const beforeObj = parseObj(row.BeforeJson);
      const afterObj = parseObj(row.AfterJson);
      const beforeStatus = sqlJsonValueStatus(beforeObj);
      const afterStatus = sqlJsonValueStatus(afterObj);
      const isCompletion = afterStatus != null && isSqlDoneAuditStatus(afterStatus)
        && (row.ActionCode === 'CREATE' || (beforeStatus != null && !isSqlDoneAuditStatus(beforeStatus)));
      const isReopen = row.ActionCode === 'UPDATE'
        && beforeStatus != null && isSqlDoneAuditStatus(beforeStatus)
        && afterStatus != null && !isSqlDoneAuditStatus(afterStatus);
      const btf = targetFinishField(beforeObj);
      const atf = targetFinishField(afterObj);
      const isTargetFinishChange = row.ActionCode === 'UPDATE'
        && (btf.present || atf.present)
        && btf.value !== atf.value;
      if (!isCompletion && !isReopen && !isTargetFinishChange) continue;
      const entry = transitionsByTask.get(taskId) || {
        TaskId: taskId,
        LastCompletedAuditAt: null,
        LastReopenAt: null,
        LastReopenAuditId: null,
        LastTargetFinishChangeAt: null,
        LastTargetFinishChangeAuditId: null
      };
      const occurredDate = new Date(occurredMs);
      const auditId = Number(row.AuditId) || 0;
      if (isCompletion && (!entry.LastCompletedAuditAt || occurredMs > entry.LastCompletedAuditAt.getTime())) {
        entry.LastCompletedAuditAt = occurredDate;
      }
      if (isReopen) {
        if (!entry.LastReopenAt
          || occurredMs > entry.LastReopenAt.getTime()
          || (occurredMs === entry.LastReopenAt.getTime() && auditId > (entry.LastReopenAuditId ?? -1))) {
          entry.LastReopenAt = occurredDate;
          entry.LastReopenAuditId = auditId;
        }
      }
      if (isTargetFinishChange) {
        if (!entry.LastTargetFinishChangeAt
          || occurredMs > entry.LastTargetFinishChangeAt.getTime()
          || (occurredMs === entry.LastTargetFinishChangeAt.getTime() && auditId > (entry.LastTargetFinishChangeAuditId ?? -1))) {
          entry.LastTargetFinishChangeAt = occurredDate;
          entry.LastTargetFinishChangeAuditId = auditId;
        }
      }
      transitionsByTask.set(taskId, entry);
    }
    results.push([...transitionsByTask.values()]);
  }
  return results;
}

function taskVisibility(db, params) {
  const scope = scopeOf(db, params);
  return [[...scope.visible.values()].map(({ task, AccessLevel, IdentityBase }) => ({ TaskId: upper(task.TaskId), ProjectId: upper(task.ProjectId), AccessLevel, IdentityBase }))];
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
    CalendarName: (calendar(task.CalendarId) || calendar(project.CalendarId) || db.calendars.find((row) => row.IsActive && row.IsDefault))?.Name ?? null,
    CalendarSource: calendar(task.CalendarId) ? 'task' : calendar(project.CalendarId) ? 'project' : db.calendars.some((row) => row.IsActive && row.IsDefault) ? 'default' : null,
    CreatedByName: creatorVisible && task.CreatedBySicil != null ? personName(db, task.CreatedBySicil) : null
  };
  const chain = [];
  let node = task.WbsId ? db.wbs.find((item) => same(item.WbsId, task.WbsId) && same(item.ProjectId, task.ProjectId)) : null;
  let depth = 0;
  const visited = new Set();
  while (node && depth <= 40 && !visited.has(upper(node.WbsId))) {
    visited.add(upper(node.WbsId));
    chain.push({ WbsId: node.WbsId, ParentWbsId: node.ParentWbsId ?? null, Code: node.Code, Name: node.Name, Depth: depth, PathIssue: node.ParentWbsId && visited.has(upper(node.ParentWbsId)) ? 'cycle' : node.ParentWbsId && !db.wbs.some((parent) => same(parent.WbsId, node.ParentWbsId) && same(parent.ProjectId, node.ProjectId)) ? 'dangling' : depth === 40 && node.ParentWbsId ? 'depth' : null });
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
    .filter(({ project }) => (!text && (params.projectId || params.projectIds)) || charindex(text, `${project.ProjectCode || ''} ${project.ProjectName}`) > 0)
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
  return [[{ Total: matches.length, ExactCount: matches.filter((row) => row.MatchRank === 0).length }], matches.slice(0, Number(params.limit)).map((row) => ({ ...row, LeadName: row.LeadSicil == null ? null : personName(db, row.LeadSicil) })), matches.map((row) => ({ ProjectId: row.ProjectId }))];
}

/** Toplamın dayandığı görünür görev nüfusu (`#AiTasks`). */
function populationRows(entries) {
  return entries.map(({ task }) => ({ TaskId: upper(task.TaskId), ProjectId: upper(task.ProjectId) }));
}

function aggregate(tasks, params) {
  const today = day(params.today);
  const soonEnd = day(params.soonEnd);
  const open = (task) => canonicalStatus(task.Status) !== 'done';
  const targets = tasks.filter((task) => open(task) && day(task.TargetFinish) && day(task.TargetFinish) >= today).map((task) => day(task.TargetFinish)).sort();
  return {
    TaskCount: tasks.length,
    DoneCount: tasks.filter((task) => canonicalStatus(task.Status) === 'done').length,
    InProgressCount: tasks.filter((task) => canonicalStatus(task.Status) === 'in_progress').length,
    TodoCount: tasks.filter((task) => canonicalStatus(task.Status) !== 'done' && canonicalStatus(task.Status) !== 'in_progress').length,
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
  return [rows, populationRows([...scope.visible.values()])];
}

function projectDetail(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access) return [[], [], [aggregate([], params)], []];
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
      WbsNodeCount: access.AccessLevel === 'FULL' || access.HasReadGrant || access.IsTaskScoped
        ? db.wbs.filter((node) => same(node.ProjectId, project.ProjectId)).length
        : null
    }],
    db.projectTags.filter((tag) => same(tag.ProjectId, project.ProjectId)).map((tag) => ({ TagName: tag.TagName })),
    [aggregate(tasks, params)],
    populationRows([...scope.visible.values()])
  ];
}

function wbs(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access) return [[], [], [], []];
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
  const focused = wbsSubtree(db, params);
  const nodes = db.wbs.filter((node) => same(node.ProjectId, params.projectId) && (catalog || required.has(upper(node.WbsId))) && (!focused || focused.has(upper(node.WbsId))))
    .slice(0, Number(params.maxRows))
    .map((node) => ({ ...node, CatalogVisible: catalog ? 1 : 0 }));
  const counts = new Map();
  for (const { task } of scope.visible.values()) {
    if (focused && !focused.has(upper(task.WbsId))) continue;
    const key = task.WbsId ? upper(task.WbsId) : null;
    if (!counts.has(key)) counts.set(key, { WbsId: task.WbsId ?? null, TaskCount: 0, DoneCount: 0, OverdueCount: 0 });
    const entry = counts.get(key);
    entry.TaskCount += 1;
    if (canonicalStatus(task.Status) === 'done') entry.DoneCount += 1;
    else if (day(task.TargetFinish) && day(task.TargetFinish) < day(params.today)) entry.OverdueCount += 1;
  }
  const project = projectRow(db, params.projectId);
  const counted = [...scope.visible.values()].filter(({ task }) => same(task.ProjectId, params.projectId) && (!focused || focused.has(upper(task.WbsId))));
  return [nodes, [...counts.values()], [{ ProjectId: project.ProjectId, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, ...access }], populationRows(counted)];
}

function dependencies(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  if (!access || access.AccessLevel !== 'FULL') return [[], [], [{ TaskCount: 0, OpenCount: 0 }], []];
  const focus = params.focusTaskId ? upper(params.focusTaskId) : null;
  const rows = db.taskDependencies
    .filter((dep) => same(dep.ProjectId, params.projectId) && (!focus || same(dep.TaskId, focus) || same(dep.PredecessorTaskId, focus)))
    .slice(0, Number(params.maxRows))
    .map((dep) => ({ TaskId: dep.TaskId, PredecessorTaskId: dep.PredecessorTaskId, DependencyType: dep.DependencyType, LagDays: dep.LagDays, LagValue: dep.LagValue, LagUnit: dep.LagUnit }));
  const involved = new Set([focus, ...rows.flatMap((row) => [upper(row.TaskId), upper(row.PredecessorTaskId)])].filter(Boolean));
  const projectTasks = db.tasks.filter((task) => same(task.ProjectId, params.projectId));
  return [
    rows,
    projectTasks.filter((task) => focus ? involved.has(upper(task.TaskId)) : scope.visible.has(upper(task.TaskId))).map((task) => ({
      TaskId: task.TaskId, Title: task.Title, Status: task.Status, PlannedStart: task.PlannedStart, PlannedFinish: task.PlannedFinish,
      TargetFinish: task.TargetFinish, IsMilestone: task.IsMilestone
    })),
    [{ TaskCount: projectTasks.length, OpenCount: projectTasks.filter((task) => canonicalStatus(task.Status) !== 'done').length }],
    focus ? [] : populationRows([...scope.visible.values()])
  ];
}

function baseline(db, params) {
  const scope = scopeOf(db, params);
  const access = scope.projects.get(upper(params.projectId));
  const full = Boolean(access && access.AccessLevel === 'FULL');
  const ordered = db.baselines.filter((row) => full && same(row.ProjectId, params.projectId))
    .sort((left, right) => (Number(right.IsPrimary) - Number(left.IsPrimary)) || String(right.CreatedAt).localeCompare(String(left.CreatedAt)));
  const selected = ordered.find((row) => !params.baselineId || same(row.BaselineId, params.baselineId)) || null;
  const projectTasks = new Map(db.tasks.filter((task) => same(task.ProjectId, params.projectId)).map((task) => [upper(task.TaskId), task]));
  const snapshotIds = new Set(db.taskBaselineSnapshots.filter((row) => selected && same(row.BaselineId, selected.BaselineId)).map((row) => upper(row.TaskId)));
  const snapshots = selected
    ? db.taskBaselineSnapshots.filter((row) => same(row.BaselineId, selected.BaselineId)).slice(0, Number(params.maxRows)).map((row) => {
      const task = projectTasks.get(upper(row.TaskId));
      return {
        TaskId: row.TaskId, BaselineStart: row.PlannedStart, BaselineFinish: row.PlannedFinish, BaselineDuration: row.PlannedDurationDays,
        TaskExists: task ? 1 : 0, Title: task?.Title ?? null, Status: task?.Status ?? null, PlannedStart: task?.PlannedStart ?? null,
        PlannedFinish: task?.PlannedFinish ?? null, TargetFinish: task?.TargetFinish ?? null, ActualFinish: task?.ActualFinish ?? null
      };
    })
    : [];
  const added = selected
    ? db.tasks.filter((task) => same(task.ProjectId, params.projectId)
      && !snapshotIds.has(upper(task.TaskId))).length
    : 0;
  return [
    ordered.slice(0, 10).map((row) => ({ BaselineId: row.BaselineId, Name: row.Name, CreatedAt: row.CreatedAt, IsPrimary: row.IsPrimary ? 1 : 0,
      SnapshotCount: (() => { const count = db.taskBaselineSnapshots.filter((snapshot) => same(snapshot.BaselineId, row.BaselineId)).length; return count >= Number(params.analysisMaxRows) ? null : count; })() })),
    [{ ProjectFull: full ? 1 : 0, SelectedBaselineId: selected?.BaselineId ?? null, BaselineTotal: ordered.length }],
    snapshots,
    [{ AddedSinceBaseline: added }],
    selected ? populationRows([...scope.visible.values()]) : []
  ];
}

function calendar(db, params) {
  const scope = scopeOf(db, params);
  const projectVisible = Boolean(params.projectId && scope.projects.has(upper(params.projectId)));
  const project = projectVisible ? projectRow(db, params.projectId) : null;
  const active = (id) => db.calendars.find((row) => same(row.CalendarId, id) && row.IsActive) || null;
  const chosen = (project && active(project.CalendarId)) || db.calendars.find((row) => row.IsDefault && row.IsActive) || null;
  return [
    [{ ProjectVisible: projectVisible ? 1 : 0, ProjectCalendarSelected: project && active(project.CalendarId) ? 1 : 0, CalendarId: chosen?.CalendarId ?? null, Name: chosen?.Name ?? null, TimeZone: chosen?.TimeZone ?? null, IsDefault: chosen?.IsDefault ? 1 : 0 }],
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
      TaskId: row.TaskId, ProjectId: task.ProjectId, Title: task.Title, ProjectName: project.ProjectName, ProjectCode: project.ProjectCode, TargetFinish: task.TargetFinish,
      PlannedFinish: task.PlannedFinish, Status: task.Status, PendingMethod: row.PendingMethod, DeliveredSequence: row.DeliveredSequence,
      DeliveredMethod: row.DeliveredMethod, DeliveredDate: row.DeliveredDate, LastDeliveredAt: row.LastDeliveredAt ?? null,
      LastFailureCode: row.LastFailureCode ?? null, AttemptCount: row.AttemptCount, CompletionSuspended: row.CompletionSuspended, UpdatedAt: null
    };
  });
  if ([...scope.visible.keys()].length >= params.analysisMaxRows) { const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error; }
  return [visibleRows];
}

function reportTaskNotes(db, params) {
  const scope = scopeOf(db, params);
  if (Number.isFinite(Number(params.analysisMaxRows)) && scope.visible.size >= Number(params.analysisMaxRows)) {
    const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error;
  }
  const limit = Number(params.maxNoteRows || 61);
  const cutOffMs = params.cutOffUtc ? new Date(params.cutOffUtc).getTime() : null;
  const rows = [...scope.visible.values()]
    .filter(({ task }) => trimUnicodeSpan(task.Description).length > 0)
    .filter(({ task }) => cutOffMs == null || !task.UpdatedAt || new Date(task.UpdatedAt).getTime() <= cutOffMs)
    .sort((a, b) => sqlGuidSortKey(a.task.TaskId).localeCompare(sqlGuidSortKey(b.task.TaskId)))
    .slice(0, limit)
    .map(({ task }) => {
      const trimmed = trimUnicodeSpan(task.Description);
      return {
        TaskId: upper(task.TaskId),
        ProjectId: upper(task.ProjectId),
        Description: Array.from(trimmed).slice(0, 1601).join(''),
        DescriptionHash: descriptionHash(task.Description)
      };
    });
  const withheldRows = cutOffMs == null
    ? []
    : [...scope.visible.values()]
      .filter(({ task }) => task.UpdatedAt && new Date(task.UpdatedAt).getTime() > cutOffMs)
      .sort((a, b) => sqlGuidSortKey(a.task.TaskId).localeCompare(sqlGuidSortKey(b.task.TaskId)))
      .map(({ task }) => ({ TaskId: upper(task.TaskId) }));
  return [rows, withheldRows];
}

function reportNoteAudit(db, params) {
  const scope = scopeOf(db, params);
  if (Number.isFinite(Number(params.analysisMaxRows)) && scope.visible.size >= Number(params.analysisMaxRows)) {
    const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error;
  }
  const limit = Number(params.maxAuditRows || 251);
  const cutOffMs = new Date(params.cutOffUtc).getTime();
  // `@scopeProjects` belirteçlerinden FULL veya READ yetkili proje kümesini çöz (üretim SQL ile aynı kural).
  const fullOrReadProjects = new Set();
  for (const token of String(params.scopeProjects || '').split(',')) {
    if (token.length !== 40) continue;
    const id = token.slice(0, 36);
    if (isGuid(id) && (token[37] === 'F' || token[38] === '1')) fullOrReadProjects.add(upper(id));
  }
  const parseSnapshot = (raw) => {
    if (raw == null) return { malformed: false, descRaw: null, projectId: null };
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { malformed: true, descRaw: null, projectId: null };
      }
      const hasUpper = Object.hasOwn(parsed, 'Description') && parsed.Description !== undefined;
      const hasLower = Object.hasOwn(parsed, 'description') && parsed.description !== undefined;
      if ((hasUpper && parsed.Description !== null && typeof parsed.Description !== 'string')
        || (hasLower && parsed.description !== null && typeof parsed.description !== 'string')) {
        return { malformed: true, descRaw: null, projectId: null };
      }
      const descVal = parsed.Description ?? parsed.description ?? null;
      const projVal = parsed.ProjectId ?? parsed.projectId ?? null;
      return {
        malformed: false,
        descRaw: descVal == null ? null : String(descVal),
        projectId: typeof projVal === 'string' && isGuid(projVal) ? upper(projVal) : null
      };
    } catch {
      return { malformed: true, descRaw: null, projectId: null };
    }
  };
  const clipExcerpt = (raw) => {
    if (raw == null) return null;
    const trimmed = trimUnicodeSpan(raw);
    if (!trimmed) return null;
    return Array.from(trimmed).slice(0, 1601).join('');
  };

  const rows = [];
  for (const row of db.auditLog || []) {
    if (row.EntityType !== 'TASK' || !['CREATE', 'UPDATE'].includes(row.ActionCode)) continue;
    if (new Date(row.OccurredAt).getTime() > cutOffMs) continue;
    const visible = scope.visible.get(upper(row.EntityId));
    if (!visible) continue;
    const project = projectRow(db, row.ProjectId);
    if (!project || !project.IsActive) continue;
    const authorizedAuditProject = scope.isAdmin || (
      same(row.ProjectId, visible.task.ProjectId)
      || fullOrReadProjects.has(upper(row.ProjectId))
    );
    if (!authorizedAuditProject) continue;

    const before = parseSnapshot(row.BeforeJson);
    const after = parseSnapshot(row.AfterJson);
    const beforeSpan = trimUnicodeSpan(before.descRaw);
    const afterSpan = trimUnicodeSpan(after.descRaw);
    const beforeNonEmpty = beforeSpan.length > 0;
    const afterNonEmpty = afterSpan.length > 0;

    let beforeOriginUnauthorized = false;
    if (before.projectId && !same(before.projectId, row.ProjectId)) {
      const originProject = projectRow(db, before.projectId);
      const originOk = scope.isAdmin
        ? Boolean(originProject?.IsActive)
        : Boolean(originProject?.IsActive && fullOrReadProjects.has(before.projectId));
      if (!originOk) {
        beforeOriginUnauthorized = true;
      }
    }

    const changed = before.malformed || after.malformed || beforeOriginUnauthorized
      || (row.ActionCode === 'CREATE' && afterNonEmpty)
      || (row.ActionCode === 'UPDATE' && (
        (beforeNonEmpty && !afterNonEmpty)
        || (!beforeNonEmpty && afterNonEmpty)
        || (beforeNonEmpty && afterNonEmpty && beforeSpan !== afterSpan)
      ));
    if (!changed) continue;

    const afterRepeatsUnauthorizedOrigin = beforeOriginUnauthorized
      && !before.malformed && !after.malformed
      && beforeNonEmpty && afterNonEmpty
      && beforeSpan === afterSpan;

    rows.push({
      AuditId: Number(row.AuditId),
      OccurredAt: row.OccurredAt,
      ActionCode: row.ActionCode,
      TaskId: upper(row.EntityId),
      ProjectId: upper(row.ProjectId),
      BeforeProjectId: (!before.malformed && !beforeOriginUnauthorized && before.projectId) ? before.projectId : null,
      BeforeDescription: (before.malformed || beforeOriginUnauthorized || !beforeNonEmpty) ? null : clipExcerpt(before.descRaw),
      AfterDescription: (after.malformed || afterRepeatsUnauthorizedOrigin || !afterNonEmpty) ? null : clipExcerpt(after.descRaw),
      BeforeDescHash: (before.malformed || beforeOriginUnauthorized || !beforeNonEmpty) ? null : descriptionHash(before.descRaw),
      AfterDescHash: (after.malformed || afterRepeatsUnauthorizedOrigin || !afterNonEmpty) ? null : descriptionHash(after.descRaw),
      BeforeReadable: (!before.malformed && !beforeOriginUnauthorized) ? 1 : 0,
      AfterReadable: (!after.malformed && !afterRepeatsUnauthorizedOrigin) ? 1 : 0,
      BeforeOriginUnauthorized: beforeOriginUnauthorized ? 1 : 0,
      SnapshotMalformed: (before.malformed || after.malformed) ? 1 : 0
    });
  }

  rows.sort((a, b) => new Date(b.OccurredAt).getTime() - new Date(a.OccurredAt).getTime() || Number(b.AuditId) - Number(a.AuditId));
  return [rows.slice(0, limit)];
}

function reportScopeRoster(db, params) {
  const sicil = Number(params.sicil);
  const isAdmin = Boolean(params.isAdmin);
  const limit = Number(params.maxRosterRows || 501);
  const includeSelf = params.rosterIncludeSelf === undefined ? true : Boolean(params.rosterIncludeSelf);
  const mode = String(params.rosterMode || 'all');
  const rosterSicil = params.rosterSicil != null ? Number(params.rosterSicil) : null;
  const rosterText = String(params.rosterText || '');
  const rosterHierarchyKey = String(params.rosterHierarchyKey || '');
  const rosterScopeType = String(params.rosterScopeType || '');
  const isExecutiveTeamMode = ['all', 'team_level', 'team_name'].includes(mode);
  const bySicil = new Map((db.people || []).map((person) => [Number(person.Sicil), person]));
  const raw = [];
  const pushPerson = (person, scopeType) => {
    if (!person) return;
    raw.push({
      Sicil: Number(person.Sicil),
      DisplayName: person.DisplayName ? String(person.DisplayName).trim() : null,
      Team: person.Team ? String(person.Team).trim() : null,
      Unit: person.Unit ? String(person.Unit).trim() : null,
      Department: person.Department ? String(person.Department).trim() : null,
      Directorate: person.Directorate ? String(person.Directorate).trim() : null,
      ScopeType: scopeType
    });
  };
  pushPerson(bySicil.get(sicil), 'SELF');
  if (!isAdmin || isExecutiveTeamMode) {
    for (const entry of db.executiveScope || []) {
      if (Number(entry.ManagerSicil) === sicil && Number(entry.EmployeeSicil) !== sicil) {
        pushPerson(bySicil.get(Number(entry.EmployeeSicil)), entry.ScopeType || 'UNIT');
      }
    }
  }
  if (isAdmin && !isExecutiveTeamMode) {
    for (const person of db.people || []) {
      if (Number(person.Sicil) !== sicil) pushPerson(person, 'ADMIN');
    }
  }
  const eligible = raw.filter((row) => {
    if (!includeSelf && (row.Sicil === sicil || row.ScopeType === 'SELF')) return false;
    if (rosterScopeType && row.ScopeType !== rosterScopeType) return false;
    return true;
  });
  const foldedText = fold(rosterText);
  const hasExactTeamMatch = mode === 'team_name'
    && eligible.some((row) => row.Team && fold(row.Team) === foldedText);
  const filtered = eligible.filter((row) => {
    if (mode === 'all' || mode === 'team_level') return true;
    if (mode === 'person_sicil') return row.Sicil === rosterSicil;
    if (mode === 'person_name') return Boolean(row.DisplayName && fold(row.DisplayName) === foldedText);
    if (mode === 'team_name') {
      if (hasExactTeamMatch) return Boolean(row.Team && fold(row.Team) === foldedText);
      return Boolean(row.Unit && fold(row.Unit) === foldedText);
    }
    const dir = row.Directorate || '__unassigned__';
    const dept = row.Department || '';
    const unit = row.Unit || '';
    if (mode === 'org_unit') {
      return rosterHierarchyKey
        ? `${dir}\u001F${dept}\u001F${unit}` === rosterHierarchyKey
        : Boolean(row.Unit && fold(row.Unit) === foldedText);
    }
    if (mode === 'org_department') {
      return rosterHierarchyKey
        ? `${dir}\u001F${dept}` === rosterHierarchyKey
        : Boolean(row.Department && fold(row.Department) === foldedText);
    }
    if (mode === 'org_directorate') {
      return rosterHierarchyKey
        ? dir === rosterHierarchyKey
        : Boolean(row.Directorate && fold(row.Directorate) === foldedText);
    }
    return true;
  });
  const deduped = new Map();
  for (const row of filtered) {
    if (!deduped.has(row.Sicil)) deduped.set(row.Sicil, row);
  }
  const rows = [...deduped.values()].sort((a, b) => a.Sicil - b.Sicil);
  return [rows.slice(0, limit)];
}

function reportProjectSelectors(db, params) {
  const scope = scopeOf(db, { ...params, analysisMaxRows: undefined });
  const selectors = JSON.parse(String(params.selectorJson || '[]'));
  const rows = [];
  for (const sel of selectors) {
    const rawText = String(sel.raw || '');
    const folded = fold(rawText);
    const guid = sel.guid ? upper(sel.guid) : null;
    for (const [id, access] of scope.projects.entries()) {
      const project = projectRow(db, id);
      if (!project) continue;
      const matched = guid
        ? same(project.ProjectId, guid)
        : (
          String(project.ProjectCode || '').toLocaleUpperCase('tr-TR') === rawText.toLocaleUpperCase('tr-TR')
          || (project.ProjectCode && fold(project.ProjectCode) === folded)
          || (project.ProjectName && fold(project.ProjectName) === folded)
        );
      if (matched) {
        rows.push({
          SelectorIndex: Number(sel.index),
          ProjectId: project.ProjectId,
          ProjectName: project.ProjectName,
          ProjectCode: project.ProjectCode,
          SourceType: project.SourceType,
          LeadSicil: project.LeadSicil,
          ...access
        });
      }
    }
  }
  rows.sort((a, b) => a.SelectorIndex - b.SelectorIndex || sqlGuidSortKey(a.ProjectId).localeCompare(sqlGuidSortKey(b.ProjectId)));
  return [rows];
}

/**
 * SQL Server `datetime2(7)` karşılaştırmasını kesirli basamak kaybı olmadan taklit eder:
 * değer 100 ns tik cinsinden BigInt'e çevrilir (Date nesneleri milisaniye kesinliğindedir).
 */
function sqlTicks(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? BigInt(ms) * 10000n : null;
  }
  const nanos = parseIsoTimestampNanos(String(value));
  if (nanos != null) return nanos / 100n;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? BigInt(ms) * 10000n : null;
}

function reportDependencies(db, params) {
  const scope = scopeOf(db, params);
  const limit = Number(params.maxRows || 1001);
  const rawTaskIds = String(params.taskIds || '');
  const taskFilterActive = rawTaskIds.trim().length > 0;
  const taskFilter = new Set(rawTaskIds.split(',').map((id) => upper(id.trim())).filter(isGuid));
  const cutOffTicks = params.cutOffUtc ? sqlTicks(params.cutOffUtc) : null;
  const afterCutoff = (value) => {
    const ticks = sqlTicks(value);
    return ticks != null && ticks > cutOffTicks;
  };
  const isPostCutoffDep = (dep) => cutOffTicks != null && (afterCutoff(dep.CreatedAt) || afterCutoff(dep.UpdatedAt));
  // Üretim sorgusundaki sıra: FULL proje ve görev süzgeci, ardından kesit süzgeci, en son TOP.
  const eligibleDeps = (db.taskDependencies || [])
    .filter((dep) => scope.projects.get(upper(dep.ProjectId))?.AccessLevel === 'FULL')
    .filter((dep) => !taskFilterActive || taskFilter.has(upper(dep.TaskId)) || taskFilter.has(upper(dep.PredecessorTaskId)));
  const boundedDeps = eligibleDeps
    .filter((dep) => !isPostCutoffDep(dep))
    .sort((a, b) => (
      sqlGuidSortKey(a.ProjectId).localeCompare(sqlGuidSortKey(b.ProjectId))
      || sqlGuidSortKey(a.TaskId).localeCompare(sqlGuidSortKey(b.TaskId))
      || sqlGuidSortKey(a.PredecessorTaskId).localeCompare(sqlGuidSortKey(b.PredecessorTaskId))
    ))
    .slice(0, limit);
  const isTruncated = boundedDeps.length >= limit;
  // Kaldırılan kenarın karşı ucu süzgeç dışında kalabilir; denetim kaydı görev süzgecinden bağımsızdır.
  // Kesit sonrasında oluşturulduğu kanıtlanan görevler dışlanır, satırı olmayan görevler sayılır.
  const hasPostCutoffAudit = cutOffTicks != null && (db.auditLog || []).some((entry) => {
    if (entry.EntityType !== 'TASK' || !['UPDATE', 'DELETE'].includes(entry.ActionCode)) return false;
    if (!afterCutoff(entry.OccurredAt)) return false;
    if (scope.projects.get(upper(entry.ProjectId))?.AccessLevel !== 'FULL') return false;
    const live = (db.tasks || []).find((task) => same(task.TaskId, entry.EntityId));
    if (live && live.CreatedAt != null && afterCutoff(live.CreatedAt)) return false;
    return true;
  });
  const hasPostCutoffChange = eligibleDeps.some(isPostCutoffDep) || hasPostCutoffAudit;
  const rows = boundedDeps.map((dep) => ({
    ProjectId: dep.ProjectId,
    TaskId: dep.TaskId,
    PredecessorTaskId: dep.PredecessorTaskId,
    DependencyType: dep.DependencyType,
    LagDays: dep.LagDays,
    LagValue: dep.LagValue,
    LagUnit: dep.LagUnit,
    CreatedAt: dep.CreatedAt ?? null,
    UpdatedAt: dep.UpdatedAt ?? null
  }));
  return [rows, [{ IsTruncated: isTruncated ? 1 : 0, HasPostCutoffChange: hasPostCutoffChange ? 1 : 0 }]];
}

function reportActivitySummary(db, params) {
  const sicil = Number(params.sicil);
  const isAdmin = Boolean(params.isAdmin);
  const scope = scopeOf(db, { ...params, projectIds: '', taskIds: '', projectId: null, projectSearchText: '', sourceFilter: 'all', analysisMaxRows: undefined });
  // `scope.projects` haritasının anahtarı büyük harfli proje kimliğidir.
  const visibleProjects = new Set(
    [...scope.projects.entries()]
      .filter(([, entry]) => entry.AccessLevel === 'FULL' || entry.HasReadGrant === 1)
      .map(([projectId]) => upper(projectId))
  );
  const partialTasks = new Set(String(params.scopeTasks || '').split(',').map(upper).filter(isGuid));
  const projectFilter = new Set(String(params.projectIds || '').split(',').map(upper).filter(isGuid));
  const assigneeFilter = new Set(
    String(params.assigneeSicils || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
  const startMs = new Date(params.startUtc).getTime();
  const endMs = new Date(params.endUtc).getTime();
  const cutOffMs = params.cutOffUtc ? new Date(params.cutOffUtc).getTime() : null;
  const probeRows = Number(params.activityProbeRows || 20001);

  const safeJson = (raw) => {
    if (raw == null) return { ok: true, obj: {} };
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, obj: {} };
      return { ok: true, obj: parsed };
    } catch {
      return { ok: false, obj: {} };
    }
  };
  const historicallyVisible = (id) => Number(id) === sicil || executiveOf(db, sicil, Number(id));
  const validAssigneeIds = (arr) => (Array.isArray(arr)
    ? arr.filter((v) => typeof v === 'number' || typeof v === 'string').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
    : []);

  const deletions = new Map();
  for (const event of db.auditLog || []) {
    if (event.EntityType !== 'TASK' || event.ActionCode !== 'DELETE') continue;
    const eventMs = new Date(event.OccurredAt).getTime();
    if (cutOffMs != null && eventMs > cutOffMs) continue;
    const k = `${upper(event.EntityId)}:${upper(event.ProjectId)}`;
    const prev = deletions.get(k);
    if (!prev || eventMs > new Date(prev.OccurredAt).getTime()
      || (eventMs === new Date(prev.OccurredAt).getTime() && Number(event.AuditId) > Number(prev.AuditId))) {
      deletions.set(k, event);
    }
  }

  const scopedRows = [];
  for (const row of db.auditLog || []) {
    if (row.EntityType !== 'TASK' || !['CREATE', 'UPDATE', 'DELETE'].includes(row.ActionCode)) continue;
    const occurredMs = new Date(row.OccurredAt).getTime();
    if (!(occurredMs >= startMs && occurredMs < endMs)) continue;
    if (cutOffMs != null && occurredMs > cutOffMs) continue;
    if (projectFilter.size > 0 && !projectFilter.has(upper(row.ProjectId))) continue;

    const liveTask = (db.tasks || []).find((task) => same(task.TaskId, row.EntityId)) || null;
    const project = projectRow(db, row.ProjectId);
    const deletion = liveTask ? null : deletions.get(`${upper(row.EntityId)}:${upper(row.ProjectId)}`);
    const deletedSnap = deletion ? safeJson(deletion.BeforeJson) : { ok: false, obj: {} };
    const deletedAssignees = deletedSnap.ok ? validAssigneeIds(deletedSnap.obj.assigneeIds) : [];

    const deletedCreatedByRaw = deletedSnap.ok ? deletedSnap.obj.CreatedBySicil : null;
    const deletedCreatedBySicil = (typeof deletedCreatedByRaw === 'string' || typeof deletedCreatedByRaw === 'number')
      ? Number(deletedCreatedByRaw)
      : Number.NaN;
    const visible = Boolean(project?.IsActive) && (
      (isAdmin && (!liveTask || scope.projects.has(upper(liveTask.ProjectId))))
      || (!isAdmin && (
        (visibleProjects.has(upper(row.ProjectId))
          && (!liveTask || visibleProjects.has(upper(liveTask.ProjectId)) || partialTasks.has(upper(liveTask.TaskId))))
        || (liveTask && same(liveTask.ProjectId, row.ProjectId) && partialTasks.has(upper(liveTask.TaskId)))
        || (!liveTask && deletedSnap.ok && (
          deletedCreatedBySicil === sicil
          || deletedAssignees.some(historicallyVisible)
        ))
      ))
    );
    if (!visible) continue;

    if (assigneeFilter.size > 0) {
      let matchesAssignee = false;
      if (liveTask) {
        const taskAssignees = assigneesOf(db, liveTask.TaskId);
        matchesAssignee = taskAssignees.some((ta) => assigneeFilter.has(Number(ta.Sicil)) && (
          isAdmin
          || Number(liveTask.CreatedBySicil) === sicil
          || Number(ta.Sicil) === sicil
          || visibleProjects.has(upper(liveTask.ProjectId))
          || executiveOf(db, sicil, Number(ta.Sicil))
        ));
      } else if (deletedAssignees.length > 0) {
        matchesAssignee = deletedAssignees.some((member) => assigneeFilter.has(member));
      }
      if (!matchesAssignee) continue;
    }

    const beforeParsed = safeJson(row.BeforeJson);
    const afterParsed = safeJson(row.AfterJson);
    const beforeStatus = beforeParsed.ok ? sqlJsonValueStatus(beforeParsed.obj) : null;
    const afterStatus = afterParsed.ok ? sqlJsonValueStatus(afterParsed.obj) : null;
    const completionEvent = afterParsed.ok && afterStatus != null && isSqlDoneAuditStatus(afterStatus)
      && (row.ActionCode === 'CREATE' || (beforeParsed.ok && beforeStatus != null && !isSqlDoneAuditStatus(beforeStatus)));
    const reopenEvent = beforeParsed.ok && afterParsed.ok && beforeStatus != null && isSqlDoneAuditStatus(beforeStatus)
      && afterStatus != null && !isSqlDoneAuditStatus(afterStatus);
    const kind = row.ActionCode === 'DELETE' ? 'deleted' : row.ActionCode === 'CREATE' ? 'created' : completionEvent ? 'completed' : 'updated';

    scopedRows.push({
      AuditId: Number(row.AuditId) || 0,
      ActionGroup: row.CorrelationId ? String(row.CorrelationId).toUpperCase() : `audit:${row.AuditId}`,
      EntityId: upper(row.EntityId),
      ActorSicil: Number(row.ActorSicil),
      ProjectId: upper(row.ProjectId),
      OccurredAt: row.OccurredAt,
      Kind: kind,
      Completed: completionEvent ? 1 : 0,
      Reopened: reopenEvent ? 1 : 0,
      LastReopenAt: reopenEvent ? row.OccurredAt : null,
      LastReopenAuditId: reopenEvent ? (Number(row.AuditId) || 0) : null,
      LiveTask: liveTask
    });
    if (scopedRows.length >= probeRows) {
      const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error;
    }
  }

  // Her görev için dönemdeki en son tamamlama olayının projesini ve zamanını (OccurredAt DESC, AuditId DESC) tekilleştir.
  const latestCompletionByEntity = new Map();
  for (const row of scopedRows) {
    if (!row.Completed) continue;
    const rowMs = new Date(row.OccurredAt).getTime();
    const prev = latestCompletionByEntity.get(row.EntityId);
    if (!prev || rowMs > prev.ms || (rowMs === prev.ms && row.AuditId > prev.auditId)) {
      latestCompletionByEntity.set(row.EntityId, {
        projectId: row.ProjectId,
        occurredAt: row.OccurredAt,
        isLive: Boolean(row.LiveTask),
        ms: rowMs,
        auditId: row.AuditId
      });
    }
  }

  const groups = new Map();
  for (const row of scopedRows) {
    const gk = `${row.ActionGroup}:${row.EntityId}:${row.ActorSicil}:${row.ProjectId}`;
    const existing = groups.get(gk);
    if (!existing) {
      groups.set(gk, {
        EntityId: row.EntityId,
        ActorSicil: row.ActorSicil,
        ProjectId: row.ProjectId,
        OccurredAt: row.OccurredAt,
        Completed: row.Completed,
        Reopened: row.Reopened,
        LastReopenAt: row.LastReopenAt,
        LastReopenAuditId: row.LastReopenAuditId,
        Deleted: row.Kind === 'deleted' ? 1 : 0,
        Created: row.Kind === 'created' ? 1 : 0,
        LiveTask: row.LiveTask
      });
    } else {
      if (new Date(row.OccurredAt).getTime() > new Date(existing.OccurredAt).getTime()) existing.OccurredAt = row.OccurredAt;
      if (row.Completed) existing.Completed = 1;
      if (row.Reopened) existing.Reopened = 1;
      if (row.LastReopenAt && (!existing.LastReopenAt || new Date(row.LastReopenAt).getTime() > new Date(existing.LastReopenAt).getTime())) {
        existing.LastReopenAt = row.LastReopenAt;
      }
      if (row.LastReopenAuditId != null && (existing.LastReopenAuditId == null || row.LastReopenAuditId > existing.LastReopenAuditId)) {
        existing.LastReopenAuditId = row.LastReopenAuditId;
      }
      if (row.Kind === 'deleted') existing.Deleted = 1;
      if (row.Kind === 'created') existing.Created = 1;
    }
  }

  const groupList = [...groups.values()];
  const tasksOf = (pred) => new Set(groupList.filter(pred).map((g) => g.EntityId));
  const touched = new Map();
  for (const g of groupList) {
    const prev = touched.get(g.EntityId) || { Created: 0, Deleted: 0, Completed: 0, Reopened: 0 };
    touched.set(g.EntityId, {
      Created: prev.Created || g.Created,
      Deleted: prev.Deleted || g.Deleted,
      Completed: prev.Completed || g.Completed,
      Reopened: prev.Reopened || g.Reopened
    });
  }
  const hasPostCutoffDeletion = cutOffMs != null && scopedRows.some((row) => (
    !row.LiveTask && (db.auditLog || []).some((d) => (
      d.EntityType === 'TASK'
      && d.ActionCode === 'DELETE'
      && upper(d.EntityId) === row.EntityId
      && new Date(d.OccurredAt).getTime() > cutOffMs
    ))
  ));
  const counts = [{
    Total: groupList.length,
    TaskCount: new Set(groupList.map((g) => g.EntityId)).size,
    ActorCount: new Set(groupList.map((g) => g.ActorSicil)).size,
    CompletedCount: tasksOf((g) => g.Completed).size,
    DeletedCompletedCount: tasksOf((g) => g.Completed && !g.LiveTask).size,
    CreatedCount: tasksOf((g) => g.Created).size,
    DeletedCount: tasksOf((g) => g.Deleted).size,
    ReopenedCount: tasksOf((g) => g.Reopened).size,
    UpdatedOnlyCount: [...touched.values()].filter((f) => !f.Created && !f.Deleted && !f.Completed && !f.Reopened).length,
    HasPostCutoffDeletion: hasPostCutoffDeletion ? 1 : 0
  }];

  const istanbulFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const liveByTask = new Map();
  const contributingProjectMap = new Map();
  for (const g of groupList) {
    if (!contributingProjectMap.has(g.ProjectId)) {
      const p = projectRow(db, g.ProjectId);
      contributingProjectMap.set(g.ProjectId, {
        ProjectId: g.ProjectId,
        ProjectCode: p?.ProjectCode ?? null,
        ProjectName: p?.ProjectName ?? null,
        _deletedCompletedTasks: new Set()
      });
    }
    const latestComp = latestCompletionByEntity.get(g.EntityId);
    if (latestComp && !latestComp.isLive && latestComp.projectId === g.ProjectId) {
      contributingProjectMap.get(g.ProjectId)._deletedCompletedTasks.add(g.EntityId);
    }
    if (!g.LiveTask) continue;
    const tid = upper(g.LiveTask.TaskId);
    const actDay = istanbulFmt.format(new Date(g.OccurredAt));
    const prev = liveByTask.get(tid);
    const winningProjectId = latestComp && latestComp.isLive ? latestComp.projectId : null;
    const winningCompletedDay = latestComp && latestComp.isLive && latestComp.occurredAt
      ? istanbulFmt.format(new Date(latestComp.occurredAt))
      : null;
    if (!prev) {
      liveByTask.set(tid, {
        TaskId: upper(g.LiveTask.TaskId),
        CurrentProjectId: upper(g.LiveTask.ProjectId),
        LastActivityDay: actDay,
        CompletedInPeriod: g.Completed ? 1 : 0,
        CompletedInPeriodDay: winningCompletedDay,
        CompletedProjectId: winningProjectId,
        LastReopenAt: g.LastReopenAt || null,
        LastReopenAuditId: g.LastReopenAuditId ?? null
      });
    } else {
      if (actDay > prev.LastActivityDay) prev.LastActivityDay = actDay;
      if (g.Completed) {
        prev.CompletedInPeriod = 1;
        prev.CompletedInPeriodDay = winningCompletedDay;
        prev.CompletedProjectId = winningProjectId;
      }
      if (g.LastReopenAt && (!prev.LastReopenAt || new Date(g.LastReopenAt).getTime() > new Date(prev.LastReopenAt).getTime())) {
        prev.LastReopenAt = g.LastReopenAt;
      }
      if (g.LastReopenAuditId != null && (prev.LastReopenAuditId == null || g.LastReopenAuditId > prev.LastReopenAuditId)) {
        prev.LastReopenAuditId = g.LastReopenAuditId;
      }
    }
  }
  const contributingProjects = [...contributingProjectMap.values()]
    .sort((a, b) => sqlGuidSortKey(a.ProjectId).localeCompare(sqlGuidSortKey(b.ProjectId)))
    .map(({ ProjectId, ProjectCode, ProjectName, _deletedCompletedTasks }) => ({
      ProjectId,
      ProjectCode,
      ProjectName,
      DeletedCompletedCount: _deletedCompletedTasks.size
    }));
  return [counts, [...liveByTask.values()], contributingProjects];
}

const HANDLERS = Object.freeze({
  'task-facts': taskFacts,
  'task-visibility': taskVisibility,
  // Görünür görevlerin kesilmiş açıklamaları (SQL: SC sıralamasıyla 401 kod noktası; boş açıklama satır döndürmez).
  'task-notes': (db, params) => [[...scopeOf(db, params).visible.values()].filter(({ task }) => String(task.Description ?? '').trim())
    .map(({ task }) => ({ TaskId: upper(task.TaskId), Description: Array.from(String(task.Description).replace(/^\s+/u, '')).slice(0, 401).join('') }))],
  'report-task-notes': reportTaskNotes,
  'report-note-audit': reportNoteAudit,
  'report-scope-roster': reportScopeRoster,
  'report-project-selectors': reportProjectSelectors,
  'report-dependencies': reportDependencies,
  'report-activity-summary': reportActivitySummary,
  'task-detail': taskDetail,
  'project-search': projectSearch,
  portfolio,
  'project-detail': projectDetail,
  wbs,
  'wbs-selector': (db, params) => {
    const ids = new Set(String(params.wbsIds || params.wbsId || '').split(',').map(upper));
    const selected = db.wbs.find(node => ids.has(upper(node.WbsId)) && (!params.projectId || same(node.ProjectId, params.projectId)));
    if (!selected) return [[]];
    const project = projectRow(db, selected.ProjectId);
    const token = String(params.scopeProjects || '').split(',').find(value => value.length === 40 && same(value.slice(0, 36), selected.ProjectId));
    if (!project?.IsActive || !params.isAdmin && !token) return [[]];
    const catalog = params.isAdmin || token[37] === 'F' || token[38] === '1' || token[39] === '1';
    const allowed = new Set();
    const examinedTaskIds = [];
    if (!catalog) for (const taskId of String(params.scopeTasks || '').split(',').filter(isGuid)) {
      examinedTaskIds.push(upper(taskId));
      const task = db.tasks.find(row => same(row.TaskId, taskId));
      if (!task || !same(task.ProjectId, selected.ProjectId)) continue;
      let node = db.wbs.find(row => same(row.WbsId, task.WbsId));
      const visited = new Set();
      while (node && same(node.ProjectId, selected.ProjectId) && !visited.has(upper(node.WbsId))) {
        visited.add(upper(node.WbsId)); allowed.add(upper(node.WbsId));
        node = db.wbs.find(row => same(row.WbsId, node.ParentWbsId));
      }
    }
    db.aiToolLog.at(-1).examinedTaskIds = examinedTaskIds;
    return [db.wbs.filter(row => same(row.ProjectId, selected.ProjectId) && ids.has(upper(row.WbsId)) && (catalog || allowed.has(upper(row.WbsId))))
      .map(row => ({ ...row, ProjectName: project.ProjectName }))];
  },
  dependencies,
  baseline,
  calendar,
  outlook
});

export function runAiToolQuery(db, sqlText, params) {
  const marker = MARKER.exec(sqlText);
  if (!marker) return null;
  db.aiToolLog ||= [];
  const entry = { query: marker[1], params: { ...params } };
  db.aiToolLog.push(entry);
  // Kayıt okumanın sonucunu da taşır (`ok`): yetki reddiyle kapanan okuma kayda düşse de başarılı veri okuması sayılmaz.
  try {
    const rows = runLoggedAiToolQuery(db, marker, params);
    entry.ok = true;
    return rows;
  } catch (error) {
    entry.ok = false;
    throw error;
  }
}

const NO_PROJECT_SCOPE_CAP = new Set(['wbs-selector', 'report-scope-roster', 'report-activity-summary']);

function runLoggedAiToolQuery(db, marker, params) {
  if (db.aiToolFailure?.[marker[1]]) throw db.aiToolFailure[marker[1]];
  const projectScope = scopeOf(db, params, { filterByAssignees: marker[1] === 'task-facts' });
  if (!NO_PROJECT_SCOPE_CAP.has(marker[1]) && projectScope.projects.size >= Number(params.analysisMaxRows)) { const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error; }
  // Sonuç kümesi hesaplanmadan SQL nüfus bütçesi bağımsız uygulanır.
  const boundedTaskQueries = new Set(['task-facts', 'task-detail', 'portfolio', 'project-detail', 'wbs', 'baseline']);
  if (boundedTaskQueries.has(marker[1]) || (marker[1] === 'dependencies' && !params.focusTaskId)) {
    const scope = scopeOf(db, params);
    const cap = Number(params.analysisMaxRows);
    const tooLarge = () => { const error = new Error('AI_TOOL_RESULT_TOO_LARGE'); error.number = 51001; throw error; };
    const hasSelectedBaseline = marker[1] !== 'baseline' || db.baselines.some((row) => scope.projects.get(upper(params.projectId))?.AccessLevel === 'FULL'
      && same(row.ProjectId, params.projectId) && (!params.baselineId || same(row.BaselineId, params.baselineId)));
    const focused = marker[1] === 'wbs' && params.wbsId ? wbsSubtree(db, params) : null;
    const analyzed = [...scope.visible.values()].filter(({ task }) => (!params.seriesId || same(task.TaskId, params.seriesId) || same(task.RecurrenceParentTaskId, params.seriesId))
      && (!params.recurringOnly || task.RecurrenceRule || task.RecurrenceParentTaskId)
      && (marker[1] !== 'wbs' || !params.wbsId || focused.has(upper(task.WbsId))));
    const staged = marker[1] === 'task-facts' ? taskFacts(db, params)[0] : null;
    const analyzedCount = staged ? staged.length : analyzed.length;
    if (hasSelectedBaseline && analyzedCount >= cap) tooLarge();
    if (['task-facts', 'task-detail'].includes(marker[1])) {
      const ownTasks = new Set(db.taskAssignees.filter((row) => row.Sicil === scope.sicil).map((row) => upper(row.TaskId)));
      const stagedIds = staged ? new Set(staged.map((row) => upper(row.TaskId))) : null;
      const associations = db.taskAssignees.filter((row) => {
        const visible = scope.visible.get(upper(row.TaskId));
        return visible && (!stagedIds || stagedIds.has(upper(row.TaskId))) && (visible.IdentityBase === 1 || row.Sicil === scope.sicil || executiveOf(db, scope.sicil, row.Sicil)
          || ownTasks.has(upper(row.TaskId)));
      });
      if (associations.length >= Number(params.analysisAssignmentRows)) tooLarge();
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
