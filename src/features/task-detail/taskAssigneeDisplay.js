function cleanNames(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function assigneeNameKey(value) {
  return String(value ?? '').trim();
}

export function taskAssigneeDisplayNames(task = {}) {
  const taskScopedNames = cleanNames(task.assigneeDisplayNames);
  return taskScopedNames.length ? taskScopedNames : cleanNames(task.sorumlu);
}

export function resolveTaskAssigneeDisplayRecords(task = {}, people = [], includeTaskScopedNames = false) {
  const peopleById = new Map((people || []).map((person) => [String(person.id), person]));
  const taskIdentitiesByName = new Map();
  for (const identity of task.assigneeAvatarIdentities || []) {
    const name = assigneeNameKey(identity?.name);
    const employeeNo = String(identity?.employeeNo ?? '').trim();
    if (!name || !employeeNo) continue;
    if (!taskIdentitiesByName.has(name)) taskIdentitiesByName.set(name, []);
    taskIdentitiesByName.get(name).push({ name, employeeNo });
  }
  const records = [];

  for (const id of task.assigneeIds || []) {
    const person = peopleById.get(String(id));
    if (!person) continue;
    records.push({ key: `person:${person.id}`, id: person.id, name: person.name, person });
  }

  const names = includeTaskScopedNames ? taskAssigneeDisplayNames(task) : cleanNames(task.sorumlu);
  const visibleNameCounts = new Map();
  for (const record of records) {
    const nameKey = assigneeNameKey(record.name);
    visibleNameCounts.set(nameKey, (visibleNameCounts.get(nameKey) || 0) + 1);
  }

  names.forEach((name, index) => {
    const nameKey = assigneeNameKey(name);
    const taskScopedPerson = taskIdentitiesByName.get(nameKey)?.shift() || null;
    const visibleCount = visibleNameCounts.get(nameKey) || 0;
    if (visibleCount > 0) {
      visibleNameCounts.set(nameKey, visibleCount - 1);
      return;
    }
    records.push({ key: `task:${index}:${name}`, id: null, name, person: taskScopedPerson });
  });

  return records;
}

/**
 * Görevde seçili Sicil kayıtları ve kimliği çözülemeyen eski ad kayıtları,
 * sorumlu seçicisinde ikinci kez aday olarak sunulmaz. Eski ad karşılaştırması
 * sunucudan gelen kırpılmış görev kapsamı adlarıyla aynı biçimde normalize edilir.
 */
export function filterTaskAssigneeCandidates(people = [], selectedAssignees = []) {
  const selectedIds = new Set(
    (selectedAssignees || []).map((record) => record.id).filter(Boolean).map(String)
  );
  const legacyNames = new Set(
    (selectedAssignees || [])
      .filter((record) => record.id == null)
      .map((record) => assigneeNameKey(record.name))
      .filter(Boolean)
  );

  return (people || []).filter((person) => (
    !selectedIds.has(String(person.id))
    && !legacyNames.has(assigneeNameKey(person.name))
  ));
}

/**
 * Sorumlu kimlikleri düzenlenirken rehberde çözülemeyen mevcut kimlik ve adlar
 * korunur. Yalnızca çağıranın açıkça çıkardığı kimlik listeden düşer.
 */
export function taskAssigneeMutationPatch(task = {}, people = [], nextAssigneeIds = []) {
  const uniqueIds = [...new Set((nextAssigneeIds || []).map((id) => String(id)).filter(Boolean))];
  const peopleById = new Map((people || []).map((person) => [String(person.id), person]));
  const unresolvedNames = resolveTaskAssigneeDisplayRecords(task, people, true)
    .filter((record) => record.id == null)
    .map((record) => record.name);
  const names = [
    ...uniqueIds.map((id) => peopleById.get(id)?.name).filter(Boolean),
    ...unresolvedNames
  ];

  return {
    assigneeIds: uniqueIds,
    sorumlu: names.filter((name, index) => names.indexOf(name) === index)
  };
}
