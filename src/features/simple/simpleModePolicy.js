export function canWriteProject(project) {
  if (!project) return false;
  return !project.accessLevel || project.accessLevel === 'FULL';
}

export function writableSimpleModeProjects(projects = []) {
  return (projects || []).filter(canWriteProject);
}

export function resolveSimpleProjectChoice(currentChoice, projects = [], canCreateProjects = false) {
  const writableProjects = writableSimpleModeProjects(projects);
  if (writableProjects.some((project) => project.id === currentChoice)) return currentChoice;
  if (currentChoice === '__manual_project__' && canCreateProjects) return currentChoice;
  return writableProjects[0]?.id || (canCreateProjects ? '__manual_project__' : '');
}

export function findProjectRootWbsId(wbs = [], projectId = null) {
  if (!projectId) return null;
  return (wbs || []).find((node) => node.projectId === projectId && node.parentId == null)?.id || null;
}
