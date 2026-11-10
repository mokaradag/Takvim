import { selectProjectById, selectProjectWbs, selectTasksByProject } from '../../domain/selectors/index.js';

export const WORKSPACE_MODE_PORTFOLIO = 'portfolio';
export const WORKSPACE_MODE_PROJECT = 'project';

export function normalizeWorkspaceSelection(selection, projects = []) {
  const requestedProjectId = selection?.selectedProjectId || null;
  const requestedMode = selection?.workspaceMode || (requestedProjectId ? WORKSPACE_MODE_PROJECT : WORKSPACE_MODE_PORTFOLIO);
  const selectedProject = requestedProjectId ? selectProjectById(projects, requestedProjectId) : null;

  if (requestedMode !== WORKSPACE_MODE_PROJECT || !selectedProject) {
    return { workspaceMode: WORKSPACE_MODE_PORTFOLIO, selectedProjectId: null };
  }

  return { workspaceMode: WORKSPACE_MODE_PROJECT, selectedProjectId: selectedProject.id };
}

export function selectSelectedProject(state) {
  if (state?.workspaceMode !== WORKSPACE_MODE_PROJECT) return null;
  return selectProjectById(state.projects || [], state.selectedProjectId);
}

export function selectWorkspaceProjects(state) {
  const selectedProject = selectSelectedProject(state);
  return selectedProject ? [selectedProject] : [...(state?.projects || [])];
}

export function selectWorkspaceTasks(state) {
  const selectedProject = selectSelectedProject(state);
  return selectedProject
    ? selectTasksByProject(state.tasks || [], selectedProject.id)
    : [...(state?.tasks || [])];
}

export function selectWorkspaceWbs(state) {
  const selectedProject = selectSelectedProject(state);
  return selectedProject
    ? selectProjectWbs(state.wbs || [], selectedProject.id)
    : [...(state?.wbs || [])];
}

export function selectWorkspacePeople(state) {
  const selectedProject = selectSelectedProject(state);
  if (!selectedProject) return [...(state?.people || [])];

  const projectTasks = selectTasksByProject(state.tasks || [], selectedProject.id);
  // Görev kimliği iç ID, çalışan numarası veya Sicil olabilir; proje lideri
  // yalnızca kendi iç kimliğiyle alınır. Belirsiz takma adlar dizinde çözülmez.
  const participantIds = new Set(projectTasks.flatMap((task) =>
    (task.assigneeIds || []).map((id) => String(id ?? '').trim()).filter(Boolean)));
  const leadId = String(selectedProject.leadId ?? '').trim();
  return (state?.people || []).filter((person) => (
    (leadId && String(person.id) === leadId)
    || [person.id, person.employeeNo, person.sicil].some((candidate) => {
      const id = String(candidate ?? '').trim();
      return id && participantIds.has(id);
    })
  ));
}

export function selectWorkspaceContext(state) {
  const normalized = normalizeWorkspaceSelection(state, state?.projects || []);
  const safeState = { ...state, ...normalized };
  return {
    mode: normalized.workspaceMode,
    selectedProjectId: normalized.selectedProjectId,
    selectedProject: selectSelectedProject(safeState),
    projects: selectWorkspaceProjects(safeState),
    tasks: selectWorkspaceTasks(safeState),
    wbs: selectWorkspaceWbs(safeState),
    people: selectWorkspacePeople(safeState)
  };
}
