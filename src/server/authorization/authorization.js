import 'server-only';
import { ServerPersistenceError } from '../errors.js';

export const ACCESS_REASONS = Object.freeze({
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
  CORPORATE_PROJECT_ROLE: 'CORPORATE_PROJECT_ROLE',
  MANUAL_OWNER: 'MANUAL_OWNER',
  MANUAL_GRANT: 'MANUAL_GRANT',
  EXECUTIVE_SCOPE: 'EXECUTIVE_SCOPE',
  ASSIGNEE: 'ASSIGNEE'
});

export function deriveEffectiveAccess({ isSystemAdmin, fullProjectIds = [], partialTaskRows = [] }) {
  const access = new Map();
  if (isSystemAdmin) {
    return { isSystemAdmin: true, access, partialTaskIds: new Set(), fullProjectIds: new Set(fullProjectIds) };
  }
  for (const projectId of fullProjectIds) {
    access.set(projectId, { projectId, accessLevel: 'FULL', reasons: [ACCESS_REASONS.CORPORATE_PROJECT_ROLE] });
  }
  const partialTaskIds = new Set();
  for (const row of partialTaskRows) {
    partialTaskIds.add(row.taskId);
    if (!access.has(row.projectId)) {
      access.set(row.projectId, { projectId: row.projectId, accessLevel: 'PARTIAL', reasons: [row.reason] });
    } else if (access.get(row.projectId).accessLevel === 'PARTIAL') {
      access.get(row.projectId).reasons = [...new Set([...access.get(row.projectId).reasons, row.reason])];
    }
  }
  return {
    isSystemAdmin: false,
    access,
    partialTaskIds,
    fullProjectIds: new Set([...access.values()].filter((entry) => entry.accessLevel === 'FULL').map((entry) => entry.projectId))
  };
}

export function assertProjectWriteAccess(effective, projectId) {
  if (effective.isSystemAdmin) return;
  if (effective.access.get(projectId)?.accessLevel !== 'FULL') {
    throw new ServerPersistenceError('FORBIDDEN', 'Bu proje için tam yazma yetkiniz yok.');
  }
}

export function assertCanCreateManualProject({ isSystemAdmin, isExecutive }) {
  if (!isSystemAdmin && !isExecutive) {
    throw new ServerPersistenceError('FORBIDDEN', 'Yalnızca sistem yöneticileri ve kurumsal yöneticiler manuel proje oluşturabilir.');
  }
}

export function projectSchedulingCapability(accessLevel) {
  return accessLevel === 'FULL'
    ? { canRunCompleteCpm: true, canShowCriticalPath: true }
    : { canRunCompleteCpm: false, canShowCriticalPath: false };
}
