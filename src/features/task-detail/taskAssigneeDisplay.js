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
    const identities = taskIdentitiesByName.get(assigneeNameKey(person.name)) || [];
    const matching = identities.findIndex((identity) => identity.employeeNo === String(person.employeeNo || person.id));
    if (matching >= 0) identities.splice(matching, 1);
  }

  const names = includeTaskScopedNames ? taskAssigneeDisplayNames(task) : cleanNames(task.sorumlu);
  const visibleNameCounts = new Map();
  for (const record of records) {
    const nameKey = assigneeNameKey(record.name);
    visibleNameCounts.set(nameKey, (visibleNameCounts.get(nameKey) || 0) + 1);
  }

  names.forEach((name, index) => {
    const nameKey = assigneeNameKey(name);
    const visibleCount = visibleNameCounts.get(nameKey) || 0;
    if (visibleCount > 0) {
      visibleNameCounts.set(nameKey, visibleCount - 1);
      return;
    }
    // `shift()` ATLAMA denetiminden SONRA çağrılır. Önce çağrıldığında, adı
    // zaten çözülmüş bir kişi yüzünden atlanan kayıt sıradaki kimliği tüketiyor
    // ve aynı adı taşıyan sonraki kayıt yanlış `employeeNo` alıyordu.
    const taskScopedPerson = taskIdentitiesByName.get(nameKey)?.shift() || null;
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
 * Kurumsal dizin aramasından seçilen kişinin rehber kaydı biçimi.
 *
 * Kurum dışı kişi anlık görüntü rehberinde BULUNMAZ (bkz. directoryClient.js).
 * Yalnızca Sicili yamaya yazmak kişiyi ekliyor ama adını ve fotoğraf kimliğini
 * düşürüyordu: `resolveTaskAssigneeDisplayRecords` bilinmeyen kimliği atlıyor,
 * kişi hem arama sonuçlarından hem sorumlu listesinden kaydedip yeniden
 * yükleyene kadar kayboluyordu. Kimlik yine Sicil'dir; ad yalnızca gösterilir.
 */
export function directoryPersonRecord(person = {}) {
  const sicil = String(person?.sicil ?? '').trim();
  if (!sicil) return null;
  const organization = person.organization || {};
  return {
    id: sicil,
    employeeNo: sicil,
    name: String(person.name || '').trim() || sicil,
    role: person.jobTitle || '',
    organization: {
      directorate: organization.directorate || null,
      department: organization.department || null,
      unit: organization.unit || null
    }
  };
}

/** Rehbere, bu düzenlemede dizinden seçilen kişileri (yinelemeden) ekler. */
export function withDirectoryPeople(people = [], directoryPeople = []) {
  const base = people || [];
  if (!directoryPeople?.length) return base;
  const known = new Set(base.map((person) => String(person.id)));
  const extra = directoryPeople.filter((person) => person && !known.has(String(person.id)));
  return extra.length ? [...base, ...extra] : base;
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
    assigneeIdsCanonical: true,
    assigneeCount: uniqueIds.length,
    assigneeDisplayNames: names,
    sorumlu: names
  };
}
