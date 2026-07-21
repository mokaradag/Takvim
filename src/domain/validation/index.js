function indexByName(items) {
  return new Map(items.map((item) => [item.name, item]));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function normalizeProjectReferences(project, people) {
  const peopleByName = indexByName(people);
  return {
    ...project,
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

export function normalizeTaskReferences(task, { projects, people, wbs }) {
  const project = projects.find((item) => item.id === task.projectId || item.name === task.proje) || null;
  const peopleByName = indexByName(people);
  const peopleById = new Map(people.map((item) => [item.id, item]));

  const assigneeIds = task.assigneeIds?.length
    ? task.assigneeIds.filter((id) => peopleById.has(id))
    : (task.sorumlu || []).map((name) => peopleByName.get(name)?.id).filter(Boolean);
  const assigneeNames = task.sorumlu?.length
    ? task.sorumlu
    : assigneeIds.map((id) => peopleById.get(id)?.name).filter(Boolean);
  const projectWbs = wbs.find((node) => node.projectId === project?.id && node.parentId == null) || null;

  return {
    ...task,
    projectId: project?.id || task.projectId || null,
    proje: task.proje || project?.name || '',
    assigneeIds,
    sorumlu: assigneeNames,
    wbsId: task.wbsId || projectWbs?.id || null,
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
