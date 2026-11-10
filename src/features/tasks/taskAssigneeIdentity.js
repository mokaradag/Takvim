import { EMPTY_PERSON_LOOKUP, resolveAvatarEntries } from '../../components/avatarIdentity.js';
import { taskAssigneeDisplayNames } from '../task-detail/taskAssigneeDisplay.js';
import { compareAssigneesBySicil } from './taskDisplayValues.js';

function text(value) {
  return value == null ? '' : String(value).trim();
}

/** Süzgeç değeri görevdeki kimliktir; kişi yalnızca Sicil sıralaması için çözülür. */
export function taskAssigneeFilterEntries(ids, lookup = EMPTY_PERSON_LOOKUP) {
  return [...ids]
    .map((id) => [String(id), lookup.byId(id)])
    .filter(([, person]) => person)
    .sort(([, left], [, right]) => compareAssigneesBySicil(left, right));
}

export function taskAssigneeEntries(task = {}, lookup = EMPTY_PERSON_LOOKUP) {
  const names = taskAssigneeDisplayNames(task);
  const scopedPeople = Array.isArray(task.assigneeAvatarIdentities) ? task.assigneeAvatarIdentities : [];

  // Görev kapsamlı kişi bilgisi varsa önce onu kullan; dizin dışı kimlikten
  // başka bir kişi türetme. Yalnızca kimliği bilinen atama kaybolmasın.
  if (!names.length) {
    if (scopedPeople.length) {
      return resolveAvatarEntries({ personIds: task.assigneeIds, people: scopedPeople, lookup });
    }
    const entries = [];
    const seen = new Set();
    for (const rawId of Array.isArray(task.assigneeIds) ? task.assigneeIds : []) {
      const id = text(rawId);
      if (!id) continue;
      const person = lookup.byId(id);
      const key = person
        ? (text(person.id) || text(person.employeeNo) || text(person.sicil) || id)
        : `unresolved:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, name: text(person?.name) || 'Bilinmeyen sorumlu', person: person || null });
    }
    return entries;
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
    // Belirsiz kimliği başka kişiye bağlama; eksik görev projeksiyonunu ada göre tamamlama.
    const ambiguousIdentity = assigneeId && lookup.isAmbiguousId(assigneeId);
    const allowLegacyName = !Array.isArray(task.assigneeAvatarIdentities)
      && !visibleIds.some(Boolean);
    const person = ambiguousIdentity ? null
      : directoryPerson || scopedPerson || (allowLegacyName ? lookup.byName(name) : null);

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

export function taskAssigneeGroup(task, lookup) {
  const entry = taskAssigneeEntries(task, lookup)[0];
  if (!entry) return { key: 'unassigned:', name: 'Atanmamış', person: null };
  const identity = entry.person?.employeeNo || entry.person?.sicil || entry.person?.id;
  return {
    ...entry,
    key: identity ? `person:${identity}`
      : entry.key.startsWith('unresolved:') ? entry.key : `name:${entry.name}`
  };
}
