import { normalizePriorityId } from '../constants/index.js';
import { selectDefaultProjectWbs } from '../selectors/wbsSelectors.js';

function indexByName(items) {
  return new Map(items.filter((item) => item?.name).map((item) => [item.name, item]));
}

function indexByUniqueName(items) {
  const values = new Map();
  const duplicates = new Set();
  for (const item of items || []) {
    const name = item?.name;
    if (!name) continue;
    if (values.has(name)) duplicates.add(name);
    else values.set(name, item);
  }
  for (const name of duplicates) values.delete(name);
  return values;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function normalizePersonReferences(person = {}) {
  const employeeNo = String(person.employeeNo || person.SicilNo || person.PersonelNo || person.CalisanNo || '').trim();
  const name = String(person.name || person.AdSoyad || person.CalisanAdi || person.Ad || '').trim();
  return {
    ...person,
    id: person.id || employeeNo || name,
    employeeNo,
    name
  };
}

export function normalizeProjectReferences(project = {}, people = []) {
  const normalizedPeople = people.map(normalizePersonReferences);
  const peopleByName = indexByUniqueName(normalizedPeople);
  const code = String(project.code || project.ProjeKodu || '').trim();
  const name = String(project.name || project.ProjeAdi || '').trim();
  return {
    ...project,
    id: project.id || code || name,
    code,
    name,
    source: project.source || ((project.ProjeKodu || project.ProjeAdi) ? 'corporate' : 'manual'),
    leadId: project.leadId || peopleByName.get(project.lead)?.id || null,
    dataDate: project.dataDate || null
  };
}

export function normalizeTaskScheduleFields(task) {
  return {
    ...task,
    plannedStart: task.plannedStart || null,
    plannedFinish: task.plannedFinish || null,
    plannedDurationDays: task.milestone ? 0 : (task.plannedDurationDays ?? null),
    targetFinish: task.targetFinish || null,
    actualStart: task.actualStart || null,
    actualFinish: task.actualFinish || null,
    remainingDurationDays: task.remainingDurationDays ?? null
  };
}

export function normalizeTaskReferences(task, { projects = [], people = [], wbs = [] }) {
  const normalizedProjects = projects.map((project) => normalizeProjectReferences(project, people));
  const normalizedPeople = people.map(normalizePersonReferences);
  const projectsById = new Map(normalizedProjects.map((item) => [item.id, item]));
  const projectsByName = indexByName(normalizedProjects);
  const projectsByCode = new Map(normalizedProjects.filter((item) => item.code).map((item) => [item.code, item]));
  const project = (task.projectId ? projectsById.get(task.projectId) : null)
    || (task.projectCode ? projectsByCode.get(task.projectCode) : null)
    || projectsByName.get(task.proje)
    || null;
  const peopleByName = indexByUniqueName(normalizedPeople);
  const peopleById = new Map(normalizedPeople.map((item) => [item.id, item]));
  const wbsById = new Map(wbs.map((node) => [node.id, node]));

  const explicitAssigneeNames = Array.isArray(task.sorumlu) ? task.sorumlu : [];
  const canonicalAssigneePatch = task.assigneeIdsCanonical === true;
  const hasCanonicalAssigneeIds = Array.isArray(task.assigneeIds)
    && (task.assigneeIds.length > 0 || canonicalAssigneePatch || explicitAssigneeNames.length === 0);
  const assigneeIds = hasCanonicalAssigneeIds
    ? [...new Set(task.assigneeIds.filter((id) => peopleById.has(id)))]
    : [...new Set(explicitAssigneeNames.map((name) => peopleByName.get(name)?.id).filter(Boolean))];
  const assigneeNames = canonicalAssigneePatch || explicitAssigneeNames.length === 0
    ? assigneeIds.map((id) => peopleById.get(id)?.name).filter(Boolean)
    : explicitAssigneeNames.filter((name) => peopleByName.has(name));

  const requestedWbs = task.wbsId ? wbsById.get(task.wbsId) : null;
  const validRequestedWbs = requestedWbs && requestedWbs.projectId === project?.id ? requestedWbs : null;
  const defaultWbs = project ? selectDefaultProjectWbs(wbs, project.id) : null;
  const { assigneeIdsCanonical: _assigneeIdsCanonical, ...canonicalTask } = task;

  return {
    ...canonicalTask,
    projectId: project?.id || task.projectId || null,
    projectCode: project?.code || task.projectCode || '',
    proje: project?.name || task.proje || '',
    color: project?.color || task.color || 'blue',
    // Öncelik veri sınırında kanonikleştirilir; kaynak ne gönderirse göndersin
    // arayüz katalogda karşılığı olan bir kimlik görür.
    priority: normalizePriorityId(task.priority),
    assigneeIds,
    sorumlu: assigneeNames,
    wbsId: validRequestedWbs?.id || defaultWbs?.id || null,
    deps: task.deps || []
  };
}

export function validateTaskSchedule(task) {
  const issues = [];
  const plannedStart = task.plannedStart ? validDate(task.plannedStart) : null;
  const plannedFinish = task.plannedFinish ? validDate(task.plannedFinish) : null;
  const actualStart = task.actualStart ? validDate(task.actualStart) : null;
  const actualFinish = task.actualFinish ? validDate(task.actualFinish) : null;

  if (task.plannedStart && !plannedStart) {
    issues.push({ code: 'INVALID_PLANNED_START', field: 'plannedStart' });
  }
  if (task.plannedFinish && !plannedFinish) {
    issues.push({ code: 'INVALID_PLANNED_FINISH', field: 'plannedFinish' });
  }
  if (plannedStart && plannedFinish && plannedFinish < plannedStart) {
    issues.push({ code: 'PLANNED_FINISH_BEFORE_START', field: 'plannedFinish' });
  }

  if (task.actualStart && !actualStart) {
    issues.push({ code: 'INVALID_ACTUAL_START', field: 'actualStart' });
  }
  if (task.actualFinish && !actualFinish) {
    issues.push({ code: 'INVALID_ACTUAL_FINISH', field: 'actualFinish' });
  }
  if (task.actualFinish && !task.actualStart) {
    issues.push({ code: 'ACTUAL_FINISH_WITHOUT_START', field: 'actualFinish' });
  }
  if (actualStart && actualFinish && actualFinish < actualStart) {
    issues.push({ code: 'ACTUAL_FINISH_BEFORE_START', field: 'actualFinish' });
  }

  for (const field of ['plannedDurationDays', 'remainingDurationDays']) {
    const value = task[field];
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      issues.push({ code: 'NEGATIVE_OR_INVALID_DURATION', field });
    }
  }

  if (task.milestone && task.plannedDurationDays !== 0) {
    issues.push({ code: 'MILESTONE_NON_ZERO_DURATION', field: 'plannedDurationDays' });
  }

  return issues;
}

export function validateTaskBaselineSnapshot(snapshot) {
  const issues = [];
  const start = snapshot.plannedStart ? validDate(snapshot.plannedStart) : null;
  const finish = snapshot.plannedFinish ? validDate(snapshot.plannedFinish) : null;

  if (start && finish && finish < start) {
    issues.push({ code: 'BASELINE_FINISH_BEFORE_START', field: 'plannedFinish' });
  }

  if (snapshot.plannedDurationDays != null
    && (!Number.isFinite(snapshot.plannedDurationDays) || snapshot.plannedDurationDays < 0)) {
    issues.push({ code: 'NEGATIVE_OR_INVALID_BASELINE_DURATION', field: 'plannedDurationDays' });
  }

  return issues;
}

export {
  validateTaskWbsAssignment,
  validateTaskWbsMove,
  validateWbsDeletion,
  validateWbsReparent,
  validateWbsStructure
} from './wbsValidation.js';
