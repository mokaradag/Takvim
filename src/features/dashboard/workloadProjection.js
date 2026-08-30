import { diffDays } from '../../scheduling/dates/index.js';

function personIndexes(people = []) {
  const byEmployeeNo = new Map();
  const byId = new Map();
  for (const person of people || []) {
    if (person?.employeeNo != null) byEmployeeNo.set(String(person.employeeNo), person);
    if (person?.id != null) byId.set(String(person.id), person);
  }
  return { byEmployeeNo, byId };
}

function taskAssigneeEntries(task, indexes) {
  const projectedNames = Array.isArray(task.assigneeDisplayNames) ? task.assigneeDisplayNames : [];
  const names = (projectedNames.length ? projectedNames : (task.sorumlu || []))
    .map((name) => String(name || '').trim());
  const identities = Array.isArray(task.assigneeAvatarIdentities) ? task.assigneeAvatarIdentities : [];
  const identityQueues = new Map();
  for (const identity of identities) {
    const name = String(identity?.name || '').trim();
    if (!name) continue;
    if (!identityQueues.has(name)) identityQueues.set(name, []);
    identityQueues.get(name).push(identity);
  }

  return names.map((name, index) => ({ name, index })).filter(({ name }) => name).map(({ name, index }) => {
    const identity = identityQueues.get(name)?.shift() || null;
    const employeeNo = identity?.employeeNo == null ? null : String(identity.employeeNo);
    const assigneeId = task.assigneeIds?.[index] == null ? null : String(task.assigneeIds[index]);
    const directoryPerson = employeeNo
      ? indexes.byEmployeeNo.get(employeeNo) || null
      : assigneeId
        ? indexes.byId.get(assigneeId) || null
        : null;
    const resolvedEmployeeNo = employeeNo || (directoryPerson?.employeeNo == null
      ? null
      : String(directoryPerson.employeeNo));
    const person = resolvedEmployeeNo
      ? { ...(directoryPerson || {}), name, employeeNo: resolvedEmployeeNo }
      : directoryPerson;
    return {
      key: resolvedEmployeeNo ? `sicil:${resolvedEmployeeNo}` : assigneeId ? `kimlik:${assigneeId}` : `ad:${name}`,
      name,
      person
    };
  });
}

/** Görev kapsamlı Sicil kimliğini koruyarak ekip iş yükü satırlarını üretir. */
export function selectDashboardWorkload(tasks = [], people = [], referenceDay, limit = 5) {
  const indexes = personIndexes(people);
  const rows = new Map();
  for (const task of tasks || []) {
    for (const assignee of taskAssigneeEntries(task, indexes)) {
      if (!rows.has(assignee.key)) {
        rows.set(assignee.key, {
          id: assignee.key,
          name: assignee.name,
          person: assignee.person,
          total: 0,
          done: 0,
          late: 0,
          active: 0
        });
      }
      const row = rows.get(assignee.key);
      row.total += 1;
      if (task.status === 'done') row.done += 1;
      else row.active += 1;
      if (task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDay) < 0) row.late += 1;
    }
  }
  const selected = [...rows.values()]
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name, 'tr'))
    .slice(0, limit);
  const max = selected.reduce((peak, row) => Math.max(peak, row.total), 1);
  return selected.map((row) => ({ ...row, share: row.total / max }));
}
