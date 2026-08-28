import { canWriteProject } from '../../state/projectWritePolicy.js';

export { canWriteProject };

/**
 * Basit Modda görev tanımlanabilecek projeler.
 *
 * Liste artık hazır gelir (bkz. state/projectWritePolicy · taskAssignableProjects):
 * sıradan kullanıcıda FULL ve sorumluluktan doğan dar oluşturma projeleri,
 * yöneticide ek olarak görev atama kapsamındaki CN43N projeleri. Liste zaten
 * merkezi politikadan geçtiği için burada ikinci bir yetki modeli kurulmaz.
 */
export function writableSimpleModeProjects(projects = [], { alreadyAuthorized = false } = {}) {
  // Ürün akışı `alreadyAuthorized` ile merkezi `taskAssignableProjects`
  // sonucunu aynen kullanır; ikinci bir accessLevel süzgeci ASSIGNEE_CREATE
  // projelerini sessizce düşürürdü. Yardımcı tek başına çağrıldığında ise
  // güvenli varsayılanını korur ve yalnızca FULL/demo projeleri geçirir.
  return (projects || []).filter((project) => project && (alreadyAuthorized || canWriteProject(project)));
}

export function resolveSimpleProjectChoice(
  currentChoice,
  projects = [],
  canCreateProjects = false,
  { alreadyAuthorized = false } = {}
) {
  const writable = writableSimpleModeProjects(projects, { alreadyAuthorized });
  if (writable.some((project) => project.id === currentChoice)) return currentChoice;
  if (currentChoice === '__manual_project__' && canCreateProjects) return currentChoice;
  return writable[0]?.id || (canCreateProjects ? '__manual_project__' : '');
}

export const MANUAL_PROJECT_OPTION_VALUE = '__manual_project__';

/**
 * Serbest (kurumsal olmayan) proje tanımlama seçeneğini listenin başına ekler.
 * Kurumsal katalog binlerce kayıt içerebildiği ve açılır liste yalnızca ilk N
 * sonucu gösterdiği için seçenek sona eklendiğinde kullanıcıya hiç görünmüyordu.
 */
export function withManualProjectOption(options = [], canCreateProjects = false, manualOption = null) {
  const list = [...(options || [])];
  if (!canCreateProjects) return list;
  return [manualOption || { value: MANUAL_PROJECT_OPTION_VALUE }, ...list];
}

export function findProjectRootWbsId(wbs = [], projectId = null) {
  if (!projectId) return null;
  return (wbs || []).find((node) => node.projectId === projectId && node.parentId == null)?.id || null;
}

export function simpleAssignmentScope({
  selectedProject = null,
  creationScope = null,
  currentUserId = null,
  assignmentScopeSicils = []
} = {}) {
  if (!selectedProject || creationScope === 'FULL') return null;
  if (creationScope === 'ASSIGNEE_CREATE') {
    return currentUserId == null ? new Set() : new Set([String(currentUserId)]);
  }
  return new Set((assignmentScopeSicils || []).map(String));
}

export function simpleTaskRequiredFieldsError({
  task = '',
  dueDate = '',
  assigneeIds = [],
  creationScope = null
} = {}) {
  const assigneeCreateOnly = creationScope === 'ASSIGNEE_CREATE';
  if (String(task).trim() && (assigneeCreateOnly || dueDate) && assigneeIds.length > 0) return null;
  return assigneeCreateOnly
    ? 'Görev ve sorumlu alanlarını tamamlayın.'
    : 'Görev, sorumlu ve termin tarihi alanlarını tamamlayın.';
}
