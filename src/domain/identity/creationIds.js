export const CREATION_COLLECTIONS = Object.freeze([
  ['projectUpserts', 'PROJECT'], ['wbsUpserts', 'WBS'], ['taskUpserts', 'TASK']
]);

export function creationEntries(changes) {
  return CREATION_COLLECTIONS.flatMap(([collection, entityType]) =>
    (changes[collection] || []).filter((entry) => entry.version == null || String(entry.version).trim() === '')
      .map((entry) => ({ entry, entityType })));
}

// Only entity references are remapped. Calendars, people and dependency-row IDs
// belong to separate namespaces and must never be rewritten by an allocation.
export function remapCommitIds(changes, mappings) {
  const id = (type, value) => mappings.get(`${type}:${value}`) || value;
  const deletes = (type, values) => values?.map((entry) => typeof entry === 'string'
    ? id(type, entry) : { ...entry, id: id(type, entry.id) });
  return {
    ...changes,
    projectUpserts: changes.projectUpserts?.map((entry) => ({ ...entry, id: id('PROJECT', entry.id) })),
    projectDeletes: deletes('PROJECT', changes.projectDeletes),
    wbsUpserts: changes.wbsUpserts?.map((entry) => ({ ...entry,
      id: id('WBS', entry.id), projectId: id('PROJECT', entry.projectId), parentId: id('WBS', entry.parentId) })),
    wbsDeletes: deletes('WBS', changes.wbsDeletes),
    taskUpserts: changes.taskUpserts?.map((entry) => ({ ...entry,
      id: id('TASK', entry.id), projectId: id('PROJECT', entry.projectId), wbsId: id('WBS', entry.wbsId),
      recurrenceParentId: id('TASK', entry.recurrenceParentId),
      ...(Array.isArray(entry.deps) ? { deps: entry.deps.map((dependency) => ({ ...dependency,
        predecessorId: id('TASK', dependency.predecessorId) })) } : {}) })),
    taskDeletes: deletes('TASK', changes.taskDeletes)
  };
}
