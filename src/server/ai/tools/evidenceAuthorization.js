import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalActualId } from '../../../domain/identity/actualId.js';

/**
 * Yüklenen yetki bağlamı başına bir kez hesaplanan kanonik parçalar: yönetim
 * kapsamındaki kimlik kümesi (en fazla yetki satırı sınırı kadar) ve bütün
 * nüfusun parmak izi her kanıt doğrulamasında yeniden sıralanmaz; olay
 * döngüsünde yinelenen O(N log N) iş yapılmaz.
 */
const canonicalParts = new WeakMap();

function partsOf(auth, scope) {
  let entry = canonicalParts.get(auth);
  if (!entry || entry.scope !== scope) {
    entry = {
      scope,
      people: createHash('sha256').update(JSON.stringify([...(auth.scopeIdentities || [])].sort((a, b) => a - b))).digest('hex'),
      full: null
    };
    canonicalParts.set(auth, entry);
  }
  return entry;
}

function digest(auth, scope, { projects, tasks, rights }) {
  return createHash('sha256').update(JSON.stringify({
    sicil: scope.sicil, admin: scope.isAdmin, executive: scope.isExecutive,
    projects: [...scope.projects].filter(([id]) => !projects || projects.has(id)).sort(([a], [b]) => a.localeCompare(b)),
    tasks: projects || tasks ? [...new Set(rights.map((row) => row.taskId))].sort() : scope.scopedTaskIds.split(',').sort(),
    taskRights: rights.map(({ projectId, taskId, reason }) => [projectId, taskId, reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    people: partsOf(auth, scope).people, assignment: scope.canAssignAllCorporate
  })).digest('hex');
}

/** A population-wide result keeps the full epoch; entity-focused results bind only their population. */
export function authorizationFingerprint(auth, scope, { projectIds = null, taskIds = null } = {}) {
  const projects = projectIds ? new Set(projectIds) : null;
  const tasks = taskIds ? new Set(taskIds) : null;
  if (!projects && !tasks) {
    const parts = partsOf(auth, scope);
    parts.full ??= digest(auth, scope, { projects: null, tasks: null, rights: auth.scopeTaskRights || [] });
    return parts.full;
  }
  const rights = (auth.scopeTaskRights || []).filter((row) => (!projects || projects.has(row.projectId)) && (!tasks || tasks.has(row.taskId)));
  return digest(auth, scope, { projects, tasks, rights });
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
