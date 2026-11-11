import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonLookup } from '../src/components/avatarIdentity.js';
import { ganttAssigneeGroup } from '../src/features/gantt/ganttAssignees.js';
import { compareAssigneesBySicil } from '../src/features/tasks/taskDisplayValues.js';

const people = [
  { id: 'ic-10000', employeeNo: '10000', name: 'Ali' },
  { id: 'ic-9000', employeeNo: '9000', name: 'Zeynep' }
];
const lookup = createPersonLookup(people);
const tasks = [
  { id: 'buyuk', sorumlu: ['Ali'], assigneeIds: ['ic-10000'] },
  { id: 'kucuk', sorumlu: ['Zeynep'], assigneeIds: ['ic-9000'] }
];

test('Görev sorumluları ad yerine sayısal Sicil ile sıralanır', () => {
  const groups = tasks.map((task) => ganttAssigneeGroup(task, lookup));
  assert.deepEqual([...groups].sort(compareAssigneesBySicil).map((group) => group.person.employeeNo), ['9000', '10000']);
  assert.deepEqual([...groups].sort((a, b) => compareAssigneesBySicil(a, b, 'desc'))
    .map((group) => group.person.employeeNo), ['10000', '9000']);
});

test('Sicil değerleri her iki yönde sıralanır ve atanamayanlar sonda kalır', () => {
  const valid = { employeeNo: '9000' };
  const invalid = { employeeNo: '9X00', name: 'Bilinmeyen' };
  const unassigned = { key: 'unassigned:', name: 'Atanmamış' };
  assert.ok(compareAssigneesBySicil(valid, invalid) < 0);
  assert.ok(compareAssigneesBySicil(valid, invalid, 'desc') < 0);
  assert.ok(compareAssigneesBySicil(invalid, unassigned) < 0);
  const smaller = { employeeNo: '8000' };
  const mixed = [unassigned, invalid, valid, smaller];
  assert.deepEqual([...mixed].sort(compareAssigneesBySicil), [smaller, valid, invalid, unassigned]);
  assert.deepEqual([...mixed].sort((a, b) => compareAssigneesBySicil(a, b, 'desc')),
    [valid, smaller, invalid, unassigned]);
  assert.ok(compareAssigneesBySicil({ employeeNo: '100000000000000000000' },
    { employeeNo: '99999999999999999999' }) > 0);
  assert.ok(compareAssigneesBySicil({ employeeNo: '', sicil: '9000' },
    { employeeNo: '10000' }) < 0);
});

test('Eşit sayısal Sicillerin mevcut sırası korunur', () => {
  const same = [{ employeeNo: '09000', name: 'A' }, { employeeNo: '9000', name: 'B' }];
  assert.equal(compareAssigneesBySicil(same[0], same[1]), 0);
  assert.deepEqual([...same].sort(compareAssigneesBySicil), same);
});
