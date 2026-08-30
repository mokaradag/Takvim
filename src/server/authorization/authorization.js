import { ServerPersistenceError } from '../errors.js';

export const ACCESS_REASONS = Object.freeze({
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
  CORPORATE_PROJECT_ROLE: 'CORPORATE_PROJECT_ROLE',
  MANUAL_OWNER: 'MANUAL_OWNER',
  MANUAL_PROJECT_LEAD: 'MANUAL_PROJECT_LEAD',
  MANUAL_GRANT: 'MANUAL_GRANT',
  EXECUTIVE_SCOPE: 'EXECUTIVE_SCOPE',
  ASSIGNEE: 'ASSIGNEE',
  TASK_CREATOR: 'TASK_CREATOR'
});

export function deriveEffectiveAccess({ isSystemAdmin, fullProjectIds = [], partialProjectRows = [], partialTaskRows = [] }) {
  const access = new Map();
  if (isSystemAdmin) {
    return { isSystemAdmin: true, access, partialTaskIds: new Set(), fullProjectIds: new Set(fullProjectIds) };
  }
  for (const projectId of fullProjectIds) {
    access.set(projectId, { projectId, accessLevel: 'FULL', reasons: [ACCESS_REASONS.CORPORATE_PROJECT_ROLE] });
  }
  for (const row of partialProjectRows) {
    if (!access.has(row.projectId)) {
      access.set(row.projectId, { projectId: row.projectId, accessLevel: 'PARTIAL', reasons: [row.reason] });
    } else if (access.get(row.projectId).accessLevel === 'PARTIAL') {
      access.get(row.projectId).reasons = [...new Set([...access.get(row.projectId).reasons, row.reason])];
    }
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

/**
 * Görev ATAMA kapsamı.
 *
 * İş kuralı: direktör/müdür/birim yöneticileri, kendilerine "corporateprojectaccess"
 * verilmemiş olsa bile HERHANGİ bir CN43N projesi altında KENDİ personeline iş
 * tanımlayabilmelidir. Kapsam bilinçli olarak DAR tutulur:
 *
 *  - yalnızca GÖREV yazmalarını kapsar (proje üst verisi, iş dağılım ağacı,
 *    erişim kayıtları ve manuel proje oluşturma dışarıdadır);
 *  - yalnızca ETKİN KURUMSAL projeleri kapsar;
 *  - görevin sorumlularının tamamı yöneticinin `MR_V_ExecutiveScope` kapsamında
 *    olmalıdır.
 *
 * Görev GÖRÜNÜRLÜĞÜ değişmez: yönetici bu projelerin diğer görevlerini görmez,
 * yalnızca kendi personeline atanmış olanları görmeye devam eder.
 */
export function hasTaskAssignmentScope({ isSystemAdmin = false, isExecutive = false } = {}) {
  return Boolean(isSystemAdmin || isExecutive);
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