function indexByName(items) {
  return new Map(items.map((item) => [item.name, item]));
}

export function normalizeProjectReferences(project, people) {
  const peopleByName = indexByName(people);
  return {
    ...project,
    leadId: project.leadId || peopleByName.get(project.lead)?.id || null
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
