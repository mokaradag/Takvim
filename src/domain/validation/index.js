import { normalizePriorityId } from '../constants/index.js';

const TASK_REFERENCE_INDEX = Symbol('taskReferenceIndex');

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

function normalizeProjectWithPeopleIndex(project = {}, peopleByName = new Map()) {
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

export function normalizeProjectReferences(project = {}, people = []) {
  const normalizedPeople = people.map(normalizePersonReferences);
  return normalizeProjectWithPeopleIndex(project, indexByUniqueName(normalizedPeople));
}

/**
 * Aynı snapshot bağlamı binlerce görev için kullanılır. Proje/kişi/WBS
 * dizinlerini görev başına yeniden kurmak görev × katalog maliyeti üretir;
 * Hazırlanmış bağlam görevler arasında tek bir güvenli, salt-okunur dizin
 * paylaşır. Ham bağlam kullanan tekil çağrıların önceki semantiği değişmez.
 */
function buildTaskReferenceIndex(context) {
  const source = context && typeof context === 'object' ? context : {};
  const projects = source.projects || [];
  const people = source.people || [];
  const wbs = source.wbs || [];
  const normalizedPeople = people.map(normalizePersonReferences);
  const peopleByName = indexByUniqueName(normalizedPeople);
  const normalizedProjects = projects.map((project) => normalizeProjectWithPeopleIndex(project, peopleByName));
  const rootsByProjectId = new Map();
  for (const node of wbs) {
    if (node?.parentId != null) continue;
    const roots = rootsByProjectId.get(node.projectId) || [];
    roots.push(node);
    rootsByProjectId.set(node.projectId, roots);
  }

  return {
    projectsById: new Map(normalizedProjects.map((item) => [item.id, item])),
    // Ad yedeği BELİRSİZ adları düşürür. `indexByName` aynı ada sahip iki
    // projeden yalnızca SONUNCUSUNU tutuyordu: kimliği ve kodu olmayan bir
    // görev, dizi sırasına göre YANLIŞ projeye bağlanabiliyor, onun takvimini
    // ve WBS ağacını miras alıyordu. Proje adları sunucuda benzersiz değildir
    // (kurumsal eşitleme aynı `ProjeAdi` taşıyan iki kodu iki proje yazar), bu
    // yüzden kişi/sorumlu aramalarındaki aynı koruma buraya da uygulanır: ad
    // belirsizse görevin kimliği ya da kodu gereklidir.
    projectsByName: indexByUniqueName(normalizedProjects),
    projectsByCode: new Map(normalizedProjects.filter((item) => item.code).map((item) => [item.code, item])),
    peopleByName,
    peopleById: new Map(normalizedPeople.map((item) => [item.id, item])),
    wbsById: new Map(wbs.map((node) => [node.id, node])),
    defaultWbsByProjectId: new Map([...rootsByProjectId]
      .filter(([, roots]) => roots.length === 1)
      .map(([projectId, roots]) => [projectId, roots[0]]))
  };
}

export function prepareTaskReferenceContext(context = {}) {
  const source = context && typeof context === 'object' ? context : {};
  return { ...source, [TASK_REFERENCE_INDEX]: buildTaskReferenceIndex(source) };
}

function taskReferenceIndex(context) {
  return context?.[TASK_REFERENCE_INDEX] || buildTaskReferenceIndex(context);
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
    remainingDurationDays: task.remainingDurationDays ?? null,
    // Tekrar kuralı (RFC 5545 RRULE gövdesi) yalnızca SERİ ŞABLONUNDA bulunur;
    // üretilen yinelemeler `recurrenceParentId` ile şablona bağlanır.
    recurrence: task.recurrence || null,
    recurrenceParentId: task.recurrenceParentId || null,
    // Yinelemenin değişmez seri kimliği (RFC 5545 RECURRENCE-ID karşılığı):
    // görev ertelense bile bu tarih korunur, böylece aynı yineleme ikinci kez
    // üretilmez ve kalıcı katman seride tekilliği uygulayabilir.
    recurrenceOccurrenceDate: task.recurrenceOccurrenceDate || null
  };
}

export function normalizeTaskReferences(task, context = {}) {
  const {
    projectsById,
    projectsByName,
    projectsByCode,
    peopleByName,
    peopleById,
    wbsById,
    defaultWbsByProjectId
  } = taskReferenceIndex(context);
  const project = (task.projectId ? projectsById.get(task.projectId) : null)
    || (task.projectCode ? projectsByCode.get(task.projectCode) : null)
    || projectsByName.get(task.proje)
    || null;

  const explicitAssigneeNames = Array.isArray(task.sorumlu) ? task.sorumlu : [];
  const taskScopedAssigneeNames = (Array.isArray(task.assigneeDisplayNames) ? task.assigneeDisplayNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const canonicalAssigneePatch = task.assigneeIdsCanonical === true;
  const hasCanonicalAssigneeIds = Array.isArray(task.assigneeIds)
    && (task.assigneeIds.length > 0 || canonicalAssigneePatch || explicitAssigneeNames.length === 0);
  const assigneeIds = hasCanonicalAssigneeIds
    ? [...new Set(task.assigneeIds.filter((id) => peopleById.has(id)))]
    : [...new Set(explicitAssigneeNames.map((name) => peopleByName.get(name)?.id).filter(Boolean))];
  const directoryAssigneeNames = canonicalAssigneePatch || explicitAssigneeNames.length === 0
    ? assigneeIds.map((id) => peopleById.get(id)?.name).filter(Boolean)
    : explicitAssigneeNames.filter((name) => peopleByName.has(name));
  const hasTaskScopedCoAssignees = taskScopedAssigneeNames.length > 0
    && Number(task.assigneeCount ?? assigneeIds.length) > assigneeIds.length;
  const assigneeNames = hasTaskScopedCoAssignees ? taskScopedAssigneeNames : directoryAssigneeNames;

  const requestedWbs = task.wbsId ? wbsById.get(task.wbsId) : null;
  const validRequestedWbs = requestedWbs && requestedWbs.projectId === project?.id ? requestedWbs : null;
  const defaultWbs = project ? defaultWbsByProjectId.get(project.id) || null : null;
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

  // GEÇERSİZ tarih sessizce `null` sayılmaz. `validDate` reddettiğinde değer
  // yalnızca sıralama denetiminin dışında kalıyor ve fonksiyon hiçbir sorun
  // bildirmiyordu: `plannedStart: '2026-02-30'` taşıyan bir başlangıç anlık
  // görüntüsü "geçerli" sayılıp kalıcılaştırılabiliyordu. Görev zamanlama
  // doğrulayıcısı aynı durumu zaten bildiriyor; başlangıç anlık görüntüsü de
  // aynı kuralı uygular.
  if (snapshot.plannedStart && !start) {
    issues.push({ code: 'INVALID_BASELINE_START', field: 'plannedStart' });
  }
  if (snapshot.plannedFinish && !finish) {
    issues.push({ code: 'INVALID_BASELINE_FINISH', field: 'plannedFinish' });
  }

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
