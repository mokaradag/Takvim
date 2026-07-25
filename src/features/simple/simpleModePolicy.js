import { canWriteProject, writableProjects } from '../../state/projectWritePolicy.js';

export { canWriteProject };

export function writableSimpleModeProjects(projects = []) {
  return writableProjects(projects);
}

export function resolveSimpleProjectChoice(currentChoice, projects = [], canCreateProjects = false) {
  const writable = writableSimpleModeProjects(projects);
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
