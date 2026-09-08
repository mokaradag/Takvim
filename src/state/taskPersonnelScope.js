export function taskPersonnelScope({ project = null, isExecutive = false, isSystemAdmin = false, assignmentScopeSicils = [] } = {}) {
  if (isSystemAdmin) return null;
  if (!isExecutive && (!project?.accessLevel || project.accessLevel === 'FULL')) return null;
  return new Set((assignmentScopeSicils || []).map(String));
}
