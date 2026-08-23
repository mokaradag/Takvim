function hasOwn(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function issue(code, message) {
  return {
    ok: false,
    error: {
      code,
      field: 'assigneeIds',
      message
    }
  };
}

export function normalizeTaskAssigneePatch(patch = {}, people = []) {
  if (!hasOwn(patch, 'sorumlu')) return { ok: true, patch };
  if (!Array.isArray(patch.sorumlu)) {
    return issue('TASK_ASSIGNEES_INVALID', 'Görev sorumluları dizi olmalıdır.');
  }

  const peopleByName = new Map();
  for (const person of people || []) {
    const name = person?.name == null ? '' : String(person.name).trim();
    if (!name || person?.id == null) continue;
    if (!peopleByName.has(name)) peopleByName.set(name, []);
    peopleByName.get(name).push(person);
  }

  const assigneeIds = [];
  for (const rawName of patch.sorumlu) {
    const name = rawName == null ? '' : String(rawName).trim();
    const matches = peopleByName.get(name) || [];
    if (matches.length === 0) {
      return issue('TASK_ASSIGNEE_NOT_FOUND', `Görev sorumlusu kurumsal personel kaynağında bulunamadı: ${name || 'boş değer'}.`);
    }
    if (matches.length > 1) {
      return issue(
        'TASK_ASSIGNEE_AMBIGUOUS',
        `Aynı adda birden fazla çalışan bulunduğu için sorumlu Sicil ile seçilmelidir: ${name}.`
      );
    }
    const id = String(matches[0].id);
    if (!assigneeIds.includes(id)) assigneeIds.push(id);
  }

  const normalizedPatch = { ...patch, assigneeIds, assigneeIdsCanonical: true };
  delete normalizedPatch.sorumlu;
  return { ok: true, patch: normalizedPatch };
}
