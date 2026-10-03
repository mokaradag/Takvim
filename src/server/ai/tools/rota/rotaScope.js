import 'server-only';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { ACCESS_REASONS } from '../../../authorization/authorization.js';

/**
 * Araç sorgularının YETKİ KAPSAMI.
 *
 * Kapsam ikinci bir yetki modeli DEĞİLDİR: Rota'nın kanonik yetki bağlamından
 * (`loadAuthorizationContext` → `deriveEffectiveAccess`) türetilir ve sabit SQL
 * metinlerine parametre olarak verilir. Görünürlük kuralı anlık görüntüyle
 * aynıdır (bkz. sqlAppRepository · `#VisibleProjects`, `#VisibleTasks`):
 *
 *  - FULL (sistem yöneticisi, kurumsal proje rolü, proje lideri/sahibi,
 *    manuel FULL hibe) → projenin bütün görevleri, bağımlılıkları ve baz
 *    planları;
 *  - READ hibesi → projenin bütün görevleri (salt okunur); bağımlılık ve baz
 *    plan YOK;
 *  - KISMİ → yalnızca kullanıcının oluşturduğu, sorumlusu olduğu ya da yönetim
 *    kapsamındaki çalışanın sorumlu olduğu görevler.
 *
 * Proje belirteci `<kimlik>:<F|P><READ 0|1><kendi görev kapsamı 0|1>`
 * biçimindedir; sistem yöneticisinde SQL belirteç listesi boştur ve SQL
 * `@isAdmin` ile bütün etkin projeleri FULL kabul eder. Kapsamın proje kümesi
 * (`projects`) ise yöneticide de bütün etkin projeleri içerir: proje kapıları
 * ve yetki dönemi bu kümeye dayanır.
 */

export const SCOPE_KINDS = Object.freeze({
  COMPLETE: 'complete-projects',
  SUBSET: 'authorized-task-subset',
  CURRENT_USER: 'current-user',
  PARTICIPANT: 'participant',
  DIRECTORY: 'directory',
  REFERENCE: 'reference'
});

const REASON_LABELS = Object.freeze({
  [ACCESS_REASONS.SYSTEM_ADMIN]: 'Sistem yöneticisi',
  [ACCESS_REASONS.CORPORATE_PROJECT_ROLE]: 'Kurumsal proje rolü',
  [ACCESS_REASONS.MANUAL_OWNER]: 'Manuel proje sahibi',
  [ACCESS_REASONS.MANUAL_PROJECT_LEAD]: 'Proje lideri',
  [ACCESS_REASONS.MANUAL_GRANT]: 'Proje erişim hibesi',
  [ACCESS_REASONS.EXECUTIVE_SCOPE]: 'Yönetim kapsamındaki çalışanın görevi',
  [ACCESS_REASONS.ASSIGNEE]: 'Görev sorumlusu',
  [ACCESS_REASONS.TASK_CREATOR]: 'Görevi oluşturan'
});

export function accessReasonLabel(reason) {
  return REASON_LABELS[reason] || 'Diğer';
}

function projectEntry(projectId, entry) {
  const reasons = [...new Set(entry?.reasons || [])].sort();
  const full = entry?.accessLevel === 'FULL';
  return Object.freeze({
    projectId,
    accessLevel: full ? 'FULL' : 'PARTIAL',
    readGrant: !full && reasons.includes(ACCESS_REASONS.MANUAL_GRANT),
    ownScoped: !full && (reasons.includes(ACCESS_REASONS.ASSIGNEE) || reasons.includes(ACCESS_REASONS.TASK_CREATOR)),
    reasons: Object.freeze(reasons)
  });
}

/** Yetki bağlamından sorgu kapsamı; kimlikler kanoniktir (küçük harf). */
export function buildRotaScope(auth) {
  const isAdmin = Boolean(auth?.isSystemAdmin);
  const projects = new Map();
  for (const [rawId, entry] of auth?.effective?.access || []) {
    const projectId = canonicalActualId(rawId);
    if (projectId) projects.set(projectId, projectEntry(projectId, entry));
  }
  // Yöneticinin etkin proje kümesi proje kapılarının ve yetki döneminin parçasıdır.
  if (isAdmin) {
    for (const rawId of auth?.effective?.fullProjectIds || []) {
      const projectId = canonicalActualId(rawId);
      if (projectId && !projects.has(projectId)) {
        projects.set(projectId, projectEntry(projectId, { accessLevel: 'FULL', reasons: [ACCESS_REASONS.SYSTEM_ADMIN] }));
      }
    }
  }
  const tokens = [];
  if (!isAdmin) {
    for (const project of projects.values()) {
      tokens.push(`${project.projectId}:${project.accessLevel === 'FULL' ? 'F' : 'P'}${project.readGrant ? 1 : 0}${project.ownScoped ? 1 : 0}`);
    }
  }
  const scopedTaskIds = isAdmin ? [] : [...(auth?.effective?.partialTaskIds || [])]
    .map((id) => canonicalActualId(id))
    .filter(Boolean);
  return Object.freeze({
    sicil: Number(auth.sicil),
    isAdmin,
    isExecutive: Boolean(auth?.isExecutive),
    canAssignAllCorporate: Boolean(auth?.canAssignAllCorporateProjects),
    projects,
    projectTokens: tokens.join(','),
    scopedTaskIds: [...new Set(scopedTaskIds)].join(',')
  });
}

/** Proje bu kapsamda görünüyor mu ve görev görünümü tam mı? */
export function projectAccess(scope, projectId) {
  const id = canonicalActualId(projectId);
  if (!id) return null;
  return scope.projects.get(id) || null;
}

/** Görev listesi tam proje görünümü mü (FULL ya da READ)? */
export function isCompleteTaskView(access) {
  return Boolean(access && (access.accessLevel === 'FULL' || access.readGrant));
}

/**
 * Model için kapsam künyesi. `projectRows` sonucun dayandığı projelerdir
 * (`AccessLevel`, `HasReadGrant` sütunlarıyla); biri bile kısmi ise sonuç
 * yetkili görev alt kümesidir ve proje bütününü temsil etmez.
 */
export function describeTaskScope(projectRows = [], { emptyComplete = true } = {}) {
  let full = 0;
  let read = 0;
  let partial = 0;
  for (const row of projectRows) {
    if (row.AccessLevel === 'FULL' || row.accessLevel === 'FULL') full += 1;
    else if (row.HasReadGrant || row.readGrant) read += 1;
    else partial += 1;
  }
  const complete = partial === 0 && (emptyComplete || full + read > 0);
  return {
    kind: complete ? SCOPE_KINDS.COMPLETE : SCOPE_KINDS.SUBSET,
    completeProjectView: complete,
    projects: { full, read, partial },
    note: complete
      ? 'Sonuç, ilgili projelerin görüntüleme yetkiniz olan bütün görevlerini kapsar.'
      : 'Kısmi erişimli projelerde yalnızca oluşturduğunuz, sorumlusu olduğunuz ya da yönetim kapsamınızdaki görevler sayılır; sayılar proje bütününü temsil etmez.'
  };
}

/** Sabit SQL'e kapsam parametrelerini bağlar. */
export function bindScope(request, sql, scope, { projectId = null, taskIds = [] } = {}) {
  request.input('sicil', sql.Int, scope.sicil);
  request.input('isAdmin', sql.Bit, scope.isAdmin ? 1 : 0);
  request.input('canAssignAllCorporate', sql.Bit, scope.canAssignAllCorporate ? 1 : 0);
  request.input('scopeProjects', sql.NVarChar(sql.MAX), scope.projectTokens);
  request.input('scopeTasks', sql.NVarChar(sql.MAX), scope.scopedTaskIds);
  request.input('projectId', sql.UniqueIdentifier, projectId);
  request.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  return request;
}
