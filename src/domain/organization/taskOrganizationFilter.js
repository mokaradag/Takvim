import { hasOrgSelection, matchesOrgFilter } from './organizationHierarchy.js';

function normalizedId(value) {
  return value == null ? '' : String(value).trim();
}

function normalizedName(value) {
  return String(value || '').trim();
}

/**
 * Görev süzgeci için kişi kimliği ve yalnızca benzersiz eski ad eşleşmelerini
 * bir kez indeksler. Aynı adlı iki kişi varsa ad, kimlik yerine kullanılmaz.
 */
export function createTaskAssigneeOrganizationIndex(people = []) {
  const peopleById = new Map();
  const peopleByUniqueName = new Map();
  const duplicateNames = new Set();

  for (const person of people) {
    const id = normalizedId(person?.id);
    if (id && !peopleById.has(id)) peopleById.set(id, person);

    const name = normalizedName(person?.name);
    if (!name || duplicateNames.has(name)) continue;
    if (peopleByUniqueName.has(name)) {
      peopleByUniqueName.delete(name);
      duplicateNames.add(name);
    } else {
      peopleByUniqueName.set(name, person);
    }
  }

  return { peopleById, peopleByUniqueName };
}

/**
 * Görevin mevcut kişi projeksiyonunda çözülebilen sorumluları.
 *
 * En az bir kararlı sorumlu kimliği varsa yalnızca kimlikler kullanılır. Eski
 * ad eşleşmesi ancak görevde hiç kimlik bulunmadığında ve ad tekil olduğunda
 * devreye girer; gizli veya projeksiyon dışı kişi bilgisi türetilmez.
 */
export function taskAssigneeOrganizationPeople(task, index) {
  const ids = [...new Set((Array.isArray(task?.assigneeIds) ? task.assigneeIds : [])
    .map(normalizedId)
    .filter(Boolean))];
  const matched = [];
  const seen = new Set();

  if (ids.length) {
    for (const id of ids) {
      const person = index?.peopleById?.get(id);
      if (!person || seen.has(id)) continue;
      seen.add(id);
      matched.push(person);
    }
    return matched;
  }

  for (const name of Array.isArray(task?.sorumlu) ? task.sorumlu : []) {
    const person = index?.peopleByUniqueName?.get(normalizedName(name));
    const id = normalizedId(person?.id);
    if (!person || !id || seen.has(id)) continue;
    seen.add(id);
    matched.push(person);
  }
  return matched;
}

/** Seçenekleri yalnızca mevcut görevlerdeki projekte edilmiş sorumlulardan üretir. */
export function organizationPeopleForTasks(tasks = [], index) {
  const result = [];
  const seen = new Set();
  for (const task of tasks) {
    for (const person of taskAssigneeOrganizationPeople(task, index)) {
      const id = normalizedId(person.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(person);
    }
  }
  return result;
}

/** Çok sorumlulu görevde sorumlulardan EN AZ BİRİNİN eşleşmesi yeterlidir. */
export function taskMatchesOrganization(task, selection, index) {
  if (!hasOrgSelection(selection)) return true;
  return taskAssigneeOrganizationPeople(task, index)
    .some((person) => matchesOrgFilter(person, selection));
}

/** Yetkili/çalışma alanı görev kümesini yalnızca seçili kurumsal kapsamla daraltır. */
export function filterTasksByOrganization(tasks = [], selection, index) {
  if (!hasOrgSelection(selection)) return tasks;
  return tasks.filter((task) => taskMatchesOrganization(task, selection, index));
}
