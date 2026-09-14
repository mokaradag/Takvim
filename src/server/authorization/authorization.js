import { canonicalActualId } from '../../domain/identity/actualId.js';
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
  // Anahtarlar BURADA da kanonikleştirilir. Tek üretim çağıranı
  // (`loadAuthorizationContext`) değerleri zaten `rowId` ile kanonikleştirir ve
  // `assertProjectWriteAccess` aramayı aynı biçimde yapar; yine de işlev dışa
  // aktarıldığı için ham kimlik geçiren bir çağıran, yalnızca harf büyüklüğü
  // farklı bir GUID yüzünden FULL yetkiyi ıskalatabilirdi. Kanonikleştirme
  // etkisizdir (idempotent), bu yüzden ek maliyet getirmez.
  const key = (value) => (value == null ? value : (canonicalActualId(value) ?? String(value)));
  if (isSystemAdmin) {
    return {
      isSystemAdmin: true,
      access,
      partialTaskIds: new Set(),
      fullProjectIds: new Set(fullProjectIds.map(key))
    };
  }
  for (const projectId of fullProjectIds) {
    const id = key(projectId);
    access.set(id, { projectId: id, accessLevel: 'FULL', reasons: [ACCESS_REASONS.CORPORATE_PROJECT_ROLE] });
  }
  const mergePartial = (rawProjectId, reason) => {
    const id = key(rawProjectId);
    if (!access.has(id)) {
      access.set(id, { projectId: id, accessLevel: 'PARTIAL', reasons: [reason] });
    } else if (access.get(id).accessLevel === 'PARTIAL') {
      access.get(id).reasons = [...new Set([...access.get(id).reasons, reason])];
    }
  };
  for (const row of partialProjectRows) mergePartial(row.projectId, row.reason);
  const partialTaskIds = new Set();
  for (const row of partialTaskRows) {
    partialTaskIds.add(row.taskId);
    mergePartial(row.projectId, row.reason);
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
  // Anahtarlar `loadAuthorizationContext` içinde KANONİK kimliklerle kurulur.
  // Ham `projectId` ile arama, yalnızca büyük/küçük harf ya da biçim farkı olan
  // (ama tamamen geçerli) bir GUID geldiğinde ıskalıyor ve FULL yetkisi olan
  // kullanıcı FORBIDDEN alıyordu.
  const canonicalId = projectId == null ? projectId : (canonicalActualId(projectId) ?? projectId);
  if (effective.access.get(canonicalId)?.accessLevel !== 'FULL') {
    throw new ServerPersistenceError('FORBIDDEN', 'Bu proje için tam yazma yetkiniz yok.');
  }
}

/**
 * Sistem yönetimi uçlarının TEK yetki kapısı.
 *
 * Gezinme öğesini gizlemek güvenlik değildir: her yönetim ucu, oturumdan
 * türetilen yetkiyi bağımsız olarak yeniden denetler ve yetkisiz kullanıcıya
 * FORBIDDEN döner.
 */
export function assertSystemAdmin(actor) {
  if (!actor?.isSystemAdmin) {
    throw new ServerPersistenceError('FORBIDDEN', 'Sistem Yönetimi yalnızca sistem yöneticilerine açıktır.');
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