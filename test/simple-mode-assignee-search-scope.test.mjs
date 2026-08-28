import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SIMPLE_ASSIGNEE_RESULT_LIMIT,
  searchSimpleAssignees,
  simpleAssignmentCandidates
} from '../src/features/simple/simpleAssigneeSearch.js';
import { simpleAssignmentScope } from '../src/features/simple/simpleModePolicy.js';

const people = Array.from({ length: 12 }, (_, index) => ({
  id: `person-${index}`,
  name: `Görevli ${index}`,
  employeeNo: `SICIL-${index}`,
  role: index === 9 ? 'Takım Lideri' : 'Uzman',
  team: 'Operasyon',
  organization: { department: index === 10 ? 'Planlama' : 'Üretim' }
}));

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('boş Hızlı Görev Tanımı araması varsayılan kişi önermez', () => {
  assert.deepEqual(searchSimpleAssignees(people, ''), []);
  assert.deepEqual(searchSimpleAssignees(people, '   '), []);

  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(panel, /!peopleQuery\.trim\(\)[\s\S]*?Ad, sicil, unvan veya birim yazarak sorumlu arayın\./);
});

test('sorumlu araması en fazla sekiz eşleşme gösterir ve seçilenleri dışarıda tutar', () => {
  const matches = searchSimpleAssignees(people, 'görevli', ['person-0'], SIMPLE_ASSIGNEE_RESULT_LIMIT);
  assert.equal(matches.length, 8);
  assert.equal(matches.some((person) => person.id === 'person-0'), false);
  assert.equal(searchSimpleAssignees(people, 'takım lideri')[0].id, 'person-9');
  assert.equal(searchSimpleAssignees(people, 'planlama')[0].id, 'person-10');
});

test('yönetici atama kapsamındaki projede yalnızca izinli sorumlular adaydır', () => {
  const restricted = simpleAssignmentCandidates(people, ['SICIL-2', 'SICIL-7']);
  assert.deepEqual(restricted.map((person) => person.id), ['person-2', 'person-7']);
  assert.deepEqual(simpleAssignmentCandidates(people, []), []);
  assert.equal(simpleAssignmentCandidates(people, null).length, people.length);
  const assigneeCreateScope = simpleAssignmentScope({
    selectedProject: { id: 'restricted' },
    creationScope: 'ASSIGNEE_CREATE',
    currentUserId: 'SICIL-3',
    assignmentScopeSicils: ['SICIL-2', 'SICIL-7']
  });
  assert.deepEqual([...assigneeCreateScope], ['SICIL-3']);
  assert.deepEqual(
    simpleAssignmentCandidates(people, assigneeCreateScope).map((person) => person.id),
    ['person-3']
  );

  const panel = read('src/features/simple/SimpleModePanel.jsx');
  const simpleDrawer = read('src/features/task-detail/SimpleTaskDrawer.jsx');
  const advancedDrawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(panel, /simpleAssignmentCandidates\(sortedPeople, assignmentScopeOnly\)/);
  assert.match(panel, /current\.filter\(\(id\) => candidatePersonIds\.has\(String\(id\)\)\)/);
  assert.match(simpleDrawer, /if \(!project \|\| canWriteProject\(project\)\) return null;\s*return new Set\(assignmentScopeSicils\.map\(String\)\)/);
  assert.match(simpleDrawer, /assignmentScopeOnly\.has\(String\(simpleAssigneeNumber\(person\)\)\)/);
  assert.match(advancedDrawer, /assignmentScopeOnly\.has\(String\(simpleAssigneeNumber\(person\)\)\)/);
  assert.doesNotMatch(simpleDrawer, /!assignmentScopeSicils\.length\) return null/);
  assert.doesNotMatch(advancedDrawer, /!assignmentScopeSicils\.length \|\| !local\.projectId/);
});

test('atama kapsamı küçük harfli sicil alanıyla da eşleşir', () => {
  const scopedPeople = [
    { id: 'person-a', sicil: 'SICIL-A', name: 'Ayşe' },
    { id: 'person-b', sicil: 'SICIL-B', name: 'Bora' }
  ];
  assert.deepEqual(
    simpleAssignmentCandidates(scopedPeople, ['SICIL-B']).map((person) => person.id),
    ['person-b']
  );
});
