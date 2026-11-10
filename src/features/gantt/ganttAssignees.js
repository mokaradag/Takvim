import { EMPTY_PERSON_LOOKUP, resolveAvatarEntries } from '../../components/avatarIdentity.js';
import { taskAssigneeDisplayNames } from '../task-detail/taskAssigneeDisplay.js';

function text(value) {
  return value == null ? '' : String(value).trim();
}

export function ganttAssigneeEntries(task = {}, lookup = EMPTY_PERSON_LOOKUP) {
  const names = taskAssigneeDisplayNames(task);
  const scopedPeople = Array.isArray(task.assigneeAvatarIdentities) ? task.assigneeAvatarIdentities : [];

  // Ad yoksa önceki kimlik/kişi çözümünü koru. Görev kapsamlı adlar varsa ise
  // bunlar görünür sıra için kanoniktir; assigneeIds yetki nedeniyle daha kısa olabilir.
  if (!names.length) {
    return resolveAvatarEntries({
      personIds: task.assigneeIds,
      people: scopedPeople,
      lookup
    });
  }

  const identityQueues = new Map();
  for (const person of scopedPeople) {
    const name = text(person?.name);
    if (!name) continue;
    if (!identityQueues.has(name)) identityQueues.set(name, []);
    identityQueues.get(name).push(person);
  }

  const visibleIds = (Array.isArray(task.assigneeIds) ? task.assigneeIds : [])
    .map((value) => text(value));
  const visibleIdSet = new Set(visibleIds.filter(Boolean));
  const positionallyAligned = visibleIds.length === names.length;
  const keyCounts = new Map();

  return names.map((name, index) => {
    const scopedPerson = identityQueues.get(name)?.shift() || null;
    const scopedIdentity = text(scopedPerson?.employeeNo)
      || text(scopedPerson?.sicil)
      || text(scopedPerson?.id);
    const assigneeId = scopedIdentity && visibleIdSet.has(scopedIdentity)
      ? scopedIdentity
      : (positionallyAligned ? visibleIds[index] : '');

    const directoryPerson = scopedIdentity
      ? lookup.byId(scopedIdentity)
      : assigneeId
        ? lookup.byId(assigneeId)
        : null;
    const person = directoryPerson || scopedPerson || lookup.byName(name);

    const identity = text(person?.employeeNo)
      || text(person?.sicil)
      || text(person?.id)
      || assigneeId;
    const baseKey = identity || `name:${name}`;
    const occurrence = keyCounts.get(baseKey) || 0;
    keyCounts.set(baseKey, occurrence + 1);

    return {
      key: occurrence ? `${baseKey}:${occurrence}` : baseKey,
      name,
      person: person || null
    };
  });
}

export function ganttAssigneeGroup(task, lookup) {
  const entry = ganttAssigneeEntries(task, lookup)[0];
  if (!entry) return { key: 'unassigned:', name: 'Atanmamış', person: null };
  const identity = entry.person?.employeeNo || entry.person?.sicil || entry.person?.id;
  return { ...entry, key: identity ? `person:${identity}` : `name:${entry.name}` };
}
