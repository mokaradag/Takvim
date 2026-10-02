import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalActualId } from '../../../domain/identity/actualId.js';

/** A population-wide result keeps the full epoch; entity-focused results bind only their population. */
export function authorizationFingerprint(auth, scope, { projectIds = null, taskIds = null } = {}) {
  const projects = projectIds ? new Set(projectIds) : null;
  const tasks = taskIds ? new Set(taskIds) : null;
  const rights = (auth.scopeTaskRights || []).filter((row) => (!projects || projects.has(row.projectId)) && (!tasks || tasks.has(row.taskId)));
  return createHash('sha256').update(JSON.stringify({
    sicil: scope.sicil, admin: scope.isAdmin, executive: scope.isExecutive,
    projects: [...scope.projects].filter(([id]) => !projects || projects.has(id)).sort(([a], [b]) => a.localeCompare(b)),
    tasks: projects || tasks ? [...new Set(rights.map((row) => row.taskId))].sort() : scope.scopedTaskIds.split(',').sort(),
    taskRights: rights.map(({ projectId, taskId, reason }) => [projectId, taskId, reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    people: [...(auth.scopeIdentities || [])].sort((a, b) => a - b), assignment: scope.canAssignAllCorporate
  })).digest('hex');
}

export function evidenceTaskReferences(envelope) {
  const tasks = new Map();
  const visit = (value, inheritedProject = null) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, inheritedProject)); return; }
    const projectId = canonicalActualId(value.projectId || value.project?.projectId) || inheritedProject;
    for (const [key, item] of Object.entries(value)) {
      if (['taskId', 'seriesTaskId', 'templateTaskId'].includes(key)) {
        const id = canonicalActualId(item);
        if (id) tasks.set(id, projectId || tasks.get(id) || null);
      } else if (item && typeof item === 'object') visit(item, projectId);
    }
  };
  visit(envelope?.data);
  return [...tasks].map(([taskId, projectId]) => ({ taskId, projectId }));
}

export function scopedEvidenceAuthorization(auth, scope, args, envelope) {
  const taskIds = envelope.tool === 'rota_task_detail' ? evidenceTaskReferences(envelope).map((row) => row.taskId) : null;
  const projectId = args.projectId || (taskIds ? envelope.data?.task?.project?.projectId : null);
  if (!projectId) return null;
  const population = { projectIds: [projectId], taskIds };
  return { version: 1, ...population, epoch: authorizationFingerprint(auth, scope, population) };
}
