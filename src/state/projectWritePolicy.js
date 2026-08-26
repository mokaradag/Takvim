import { CORPORATE_WBS_READ_ONLY_MESSAGE, supportsManualWbsEditing } from '../domain/projectTypes.js';

export { CORPORATE_WBS_READ_ONLY_MESSAGE };

function isActualDataMode(state = {}) {
  return String(state.session?.dataMode || '').toLowerCase() === 'actual';
}

function projectId(value) {
  return value == null || value === '' ? null : String(value);
}

function findProject(projects = [], value = null) {
  const id = projectId(value);
  return id ? (projects || []).find((project) => String(project.id) === id) || null : null;
}

function findProjectByName(projects = [], value = '') {
  const name = String(value || '');
  return name ? (projects || []).find((project) => project.name === name) || null : null;
}

export function canWriteProject(project) {
  if (!project) return false;
  return !project.accessLevel || project.accessLevel === 'FULL';
}

export function writableProjects(projects = []) {
  return (projects || []).filter(canWriteProject);
}

/**
 * Görev TANIMLARKEN seçilebilen projeler.
 *
 * Sıradan kullanıcı için bu küme, "corporateprojectaccess" ile tam yetki
 * aldığı görünür projelerdir — davranış değişmez. Direktör/müdür/birim
 * yöneticisi için ek olarak bütün etkin CN43N projeleri gelir; sunucu bu
 * kapsamı yeniden doğrular ve görevin kendi personeline atanmasını şart koşar.
 *
 * Kapsam YALNIZCA görev yazmasıdır: proje üst verisi, iş dağılım ağacı ve
 * görev görünürlüğü etkilenmez.
 */
export function taskAssignableProjects(state = {}) {
  const visible = writableProjects(state.projects || []);
  const known = new Set(visible.map((project) => String(project.id)));
  const scoped = (state.assignableProjects || []).filter((project) => project && !known.has(String(project.id)));
  return [...visible, ...scoped];
}

/** Bu projeye görev yazılabilir mi? (tam yetki ya da görev atama kapsamı) */
export function canAssignTasksInProject(state = {}, projectId = null) {
  const id = projectId == null || projectId === '' ? null : String(projectId);
  if (!id) return false;
  const visible = findProject(state.projects, id);
  if (canWriteProject(visible)) return true;
  return (state.assignableProjects || []).some((project) => String(project.id) === id);
}

function findAssignableProject(state = {}, value = null) {
  const id = projectId(value);
  if (!id) return null;
  return taskAssignableProjects(state).find((project) => String(project.id) === id) || null;
}

export function resolveTaskCreationProject(state = {}, requestedProjectId = null) {
  const selectable = taskAssignableProjects(state);
  if (requestedProjectId != null && requestedProjectId !== '') {
    return findAssignableProject(state, requestedProjectId);
  }
  if (state.workspaceMode === 'project') {
    // Seçili proje GÖREV ATAMA kapsamıyla da yazılabilir olabilir: yönetici,
    // astına atanmış bir görev üzerinden PARTIAL görünen bir CN43N projesini
    // açmış olabilir. Yalnızca görünür FULL proje aranırsa "Yeni görev" düğmesi
    // etkin görünüyor ama oluşturma daha panel açılmadan reddediliyordu.
    return findAssignableProject(state, state.selectedProjectId);
  }
  return selectable[0] || null;
}

export function resolveTaskMutationAccess(state = {}, taskId, patch = {}) {
  const task = (state.tasks || []).find((item) => String(item.id) === String(taskId)) || null;
  if (!task) {
    return { ok: false, code: 'TASK_NOT_FOUND', field: 'taskId', message: 'Güncellenecek görev bulunamadı.' };
  }

  // Kaynak proje görev atama kapsamında da olabilir: yönetici, kendi
  // personeline tanımladığı görevi düzenleyebilmelidir. Görevin kalıcı
  // sorumlusu ise yalnızca bu görev için dar bir içerik/ilerleme hakkı alır.
  const visibleSourceProject = findProject(state.projects, task.projectId);
  const sourceProject = visibleSourceProject || findAssignableProject(state, task.projectId);
  const hasFullSourceProject = canWriteProject(visibleSourceProject);
  const hasProjectTaskWrite = canAssignTasksInProject(state, task.projectId);
  const hasHiddenAssignees = Number(task.assigneeCount ?? (task.assigneeIds || []).length)
    > (task.assigneeIds || []).length;
  const assigneeWorkOnly = Boolean(task.isCurrentUserAssignee)
    && (!hasProjectTaskWrite || (hasHiddenAssignees && !hasFullSourceProject));
  if (hasHiddenAssignees && !hasFullSourceProject && !task.isCurrentUserAssignee) {
    return {
      ok: false,
      code: 'TASK_HIDDEN_ASSIGNEES_FORBIDDEN',
      field: 'assigneeIds',
      projectId: task.projectId,
      message: 'Görevin kapsam dışı sorumluları bulunduğu için bu görev yalnızca tam proje yetkisiyle değiştirilebilir.'
    };
  }
  if (!hasProjectTaskWrite && !assigneeWorkOnly) {
    return {
      ok: false,
      code: 'PROJECT_WRITE_FORBIDDEN',
      field: 'projectId',
      projectId: task.projectId,
      message: 'Bu görev salt okunur bir projede bulunduğu için değiştirilemez.'
    };
  }


  if (assigneeWorkOnly) {
    const protectedFields = new Set([
      'projectId', 'proje', 'wbsId', 'calendarId', 'assigneeIds', 'deps',
      'isMilestone', 'milestone', 'recurrence', 'recurrenceParentId',
      'recurrenceOccurrenceDate', 'sortOrder',
      // Planlama/hedef/gerçekleşen tarihler bilinçli olarak korunmaz: ürün
      // sözleşmesi görev sorumlusunun bu iş alanlarını düzenlemesine izin verir.
      // Saat alanları veri uyumluluğu için taşınır ama ürün yüzeyinden ve dar
      // sorumlu yetkisinden çıkarılmıştır. Finansal alanlar da proje yönetimidir.
      'plannedHours', 'actualHours', 'budget', 'spent'
    ]);
    const field = Object.keys(patch || {}).find((key) => protectedFields.has(key));
    if (field) {
      return {
        ok: false,
        code: 'TASK_ASSIGNEE_FIELD_FORBIDDEN',
        field,
        projectId: task.projectId,
        message: 'Görev sorumlusu içerik ve ilerleme alanlarını düzenleyebilir; proje yapısı ve sorumlu listesi tam proje yetkisi gerektirir.'
      };
    }
    return {
      ok: true,
      task,
      sourceProject,
      destinationProject: sourceProject,
      scope: 'ASSIGNEE',
      canManageStructure: false,
      canManageAssignees: false,
      canDelete: false
    };
  }

  let destinationProject = sourceProject;
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'projectId')) {
    destinationProject = findProject(state.projects, patch.projectId) || findAssignableProject(state, patch.projectId);
  } else if (Object.prototype.hasOwnProperty.call(patch || {}, 'proje')) {
    destinationProject = findProjectByName(state.projects, patch.proje)
      || findProjectByName(state.assignableProjects, patch.proje);
  }

  if (!canAssignTasksInProject(state, destinationProject?.id)) {
    return {
      ok: false,
      code: 'PROJECT_WRITE_FORBIDDEN',
      field: 'projectId',
      projectId: destinationProject?.id || null,
      message: 'Görev yalnızca tam yazma yetkiniz bulunan bir projeye taşınabilir.'
    };
  }

  // Atama kataloğu kaydı accessLevel taşımayabilir; bu, Demo projesi gibi FULL
  // sayılacağı anlamına gelmez. Tam yetki yalnızca görünür proje kümesindeki
  // kaynak ve hedef kayıtlarından türetilir.
  const visibleDestinationProject = findProject(state.projects, destinationProject?.id);
  const full = hasFullSourceProject && canWriteProject(visibleDestinationProject);
  return {
    ok: true,
    task,
    sourceProject,
    destinationProject,
    scope: full ? 'FULL' : 'ASSIGNMENT',
    canManageStructure: full,
    canManageAssignees: !hasHiddenAssignees,
    canDelete: true
  };
}

/** Liste eylemlerinde sunucunun görev silme sınırını aynı kararla uygular. */
export function canDeleteTask(state = {}, taskId = null) {
  const access = resolveTaskMutationAccess(state, taskId, {});
  return Boolean(access.ok && access.canDelete);
}

export function resolveWbsMutationAccess(state = {}, nodeId, targetNodeId = null) {
  const nodes = state.wbs || [];
  const node = nodes.find((item) => String(item.id) === String(nodeId)) || null;
  if (!node) {
    return { ok: false, code: 'WBS_NODE_NOT_FOUND', field: 'wbsId', message: 'İşlem yapılacak WBS düğümü bulunamadı.' };
  }

  const sourceProject = findProject(state.projects, node.projectId);
  if (!canWriteProject(sourceProject)) {
    return {
      ok: false,
      code: 'PROJECT_WRITE_FORBIDDEN',
      field: 'projectId',
      projectId: node.projectId,
      message: 'Bu projenin iş dağılım ağacı salt okunur görünürlükle açıldı.'
    };
  }

  // Kurumsal projelerin dağılım ağacı yalnızca CN43N eşitlemesiyle yazılır.
  // Kural Gerçek Sistem'e özgüdür: Demo modunda kurumsal kaynak bulunmadığı için
  // örnek projelerin ağacı serbestçe denenebilir.
  if (isActualDataMode(state) && !supportsManualWbsEditing(sourceProject)) {
    return {
      ok: false,
      code: 'CORPORATE_WBS_READ_ONLY',
      field: 'projectId',
      projectId: node.projectId,
      message: CORPORATE_WBS_READ_ONLY_MESSAGE
    };
  }

  if (targetNodeId != null) {
    const targetNode = nodes.find((item) => String(item.id) === String(targetNodeId)) || null;
    const targetProject = targetNode ? findProject(state.projects, targetNode.projectId) : null;
    // Proje kimlikleri METİN olarak karşılaştırılır (modülün geri kalanı gibi):
    // bir kayıt sayısal, ötekisi metin kimlik taşıdığında geçerli bir taşıma
    // "çapraz proje" sanılıp reddediliyordu.
    if (!targetNode || !canWriteProject(targetProject)
      || String(targetNode.projectId) !== String(node.projectId)) {
      return {
        ok: false,
        code: 'PROJECT_WRITE_FORBIDDEN',
        field: 'projectId',
        projectId: targetNode?.projectId || null,
        message: 'WBS düğümü yalnızca aynı yazılabilir proje içinde taşınabilir.'
      };
    }
  }

  return { ok: true, node, sourceProject };
}

export function resolveTaskWbsMoveAccess(state = {}, taskIds = [], targetWbsId = null) {
  const target = (state.wbs || []).find((node) => String(node.id) === String(targetWbsId)) || null;
  const targetProject = target ? findProject(state.projects, target.projectId) : null;
  if (!target || !canWriteProject(targetProject)) {
    return {
      ok: false,
      code: 'PROJECT_WRITE_FORBIDDEN',
      field: 'projectId',
      projectId: target?.projectId || null,
      message: 'Görevler yalnızca yazılabilir bir projenin WBS düğümüne taşınabilir.'
    };
  }

  for (const id of [...new Set(taskIds || [])]) {
    const access = resolveTaskMutationAccess(state, id);
    if (!access.ok) return access;
    if (String(access.task.projectId) !== String(target.projectId)) {
      return {
        ok: false,
        code: 'CROSS_PROJECT_TASK_WBS_MOVE',
        field: 'wbsId',
        projectId: target.projectId,
        message: 'Görevler yalnızca kendi projelerindeki WBS düğümlerine taşınabilir.'
      };
    }
  }

  return { ok: true, target, targetProject };
}

export function projectWriteFailure(operation, issue = {}) {
  return {
    ok: false,
    error: {
      kind: 'domain',
      code: issue.code || 'PROJECT_WRITE_FORBIDDEN',
      field: issue.field || 'projectId',
      message: issue.message || 'Bu işlem için tam proje yazma yetkisi gerekir.',
      operation,
      details: issue.projectId ? { projectId: issue.projectId } : null
    }
  };
}
