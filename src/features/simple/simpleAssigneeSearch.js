export const SIMPLE_ASSIGNEE_RESULT_LIMIT = 8;

export function simpleAssigneeNumber(person = {}) {
  return person.sicil || person.Sicil || person.employeeNo || person.SicilNo || person.PersonelNo || person.id;
}

export function simpleAssignmentCandidates(people = [], assignmentScopeSicils = null) {
  if (!assignmentScopeSicils) return people;
  const allowed = new Set(Array.from(assignmentScopeSicils, String));
  return people.filter((person) => allowed.has(String(simpleAssigneeNumber(person))));
}

export function searchSimpleAssignees(people = [], queryValue = '', selectedIds = [], limit = Infinity) {
  const query = String(queryValue).trim().toLocaleLowerCase('tr-TR');
  if (!query) return [];
  const selected = new Set(selectedIds.map(String));
  return people.filter((person) => {
    if (selected.has(String(person.id))) return false;
    return [
      person.name,
      simpleAssigneeNumber(person),
      person.role,
      person.team,
      person.organization?.directorate,
      person.organization?.department,
      person.organization?.unit
    ].map((value) => String(value || '')).join(' ').toLocaleLowerCase('tr-TR').includes(query);
  }).slice(0, limit);
}
