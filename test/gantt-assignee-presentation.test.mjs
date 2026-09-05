import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonLookup } from '../src/components/avatarIdentity.js';
import { ganttAssigneeEntries, ganttAssigneeGroup } from '../src/features/gantt/ganttAssignees.js';
import { taskTableMatches } from '../src/features/tasks/taskTableFacets.js';

const first = { id: '1001', employeeNo: '1001', name: 'Deniz Kaya' };
const second = { id: '1002', employeeNo: '1002', name: 'Deniz Kaya' };
const lookup = createPersonLookup([first, second]);

test('Gantt aynı adlı sorumluları ayrı Sicil gruplarında tutar', () => {
  const a = ganttAssigneeGroup({ assigneeIds: ['1001'], sorumlu: ['Deniz Kaya'] }, lookup);
  const b = ganttAssigneeGroup({ assigneeIds: ['1002'], sorumlu: ['Deniz Kaya'] }, lookup);
  assert.equal(a.name, b.name);
  assert.notEqual(a.key, b.key);
  assert.equal(a.person, first);
  assert.equal(b.person, second);
});

test('görev kapsamlı fotoğraflar dar kişi dizininde de tüm sorumluları korur', () => {
  const task = { assigneeIds: ['1001'], sorumlu: ['Deniz Kaya', 'Deniz Kaya'], assigneeAvatarIdentities: [first, second] };
  const entries = ganttAssigneeEntries(task, createPersonLookup([first]));
  assert.deepEqual(entries.map((entry) => entry.person.employeeNo), ['1001', '1002']);
  assert.equal(ganttAssigneeGroup(task, lookup).person, first);
  const directory = createPersonLookup([{ ...first, id: 'directory-person' }]);
  const visible = ganttAssigneeGroup({ assigneeIds: ['directory-person'] }, directory);
  const scoped = ganttAssigneeGroup({ assigneeAvatarIdentities: [{ name: first.name, employeeNo: first.employeeNo }] }, directory);
  assert.equal(visible.key, scoped.key);
});

test('kısmi fotoğraf kimliği görünür sorumluyu düşürmez ve ilk sorumlu sırasını korur', () => {
  const photographed = { id: '2002', employeeNo: '2002', name: 'Mehmet Görevli' };
  const task = {
    assigneeIds: ['2002'],
    assigneeDisplayNames: ['Rehber Dışı Görevli', 'Mehmet Görevli'],
    sorumlu: ['Rehber Dışı Görevli', 'Mehmet Görevli'],
    assigneeAvatarIdentities: [photographed]
  };
  const narrowLookup = createPersonLookup([photographed]);
  const entries = ganttAssigneeEntries(task, narrowLookup);

  assert.deepEqual(entries.map((entry) => entry.name), ['Rehber Dışı Görevli', 'Mehmet Görevli']);
  assert.equal(entries[0].person, null);
  assert.equal(entries[1].person.employeeNo, '2002');
  assert.equal(ganttAssigneeGroup(task, narrowLookup).key, 'name:Rehber Dışı Görevli');
});

test('belirsiz ad başka kişinin fotoğrafını almaz; sorumlusuz ve bozuk eski değerler güvenlidir', () => {
  const ambiguous = ganttAssigneeGroup({ sorumlu: ['Deniz Kaya'] }, lookup);
  assert.equal(ambiguous.person, null);
  assert.equal(ambiguous.key, 'name:Deniz Kaya');
  for (const sorumlu of [undefined, null, [], {}, 'Deniz Kaya']) {
    assert.deepEqual(ganttAssigneeEntries({ sorumlu }, lookup), []);
    assert.equal(ganttAssigneeGroup({ sorumlu }, lookup).key, 'unassigned:');
  }
});

test('ortak arama Türkçe ad, proje kodu ve etiketi destekler; bozuk sorumlu alanı panoyu düşürmez', () => {
  const task = { task: 'İletişim', proje: 'Radar', projectCode: 'P123', keyword: 'Tasarım', sorumlu: ['Işıl Şen'] };
  for (const search of ['iletişim', 'P123', 'tasarım', 'ışıl']) assert.equal(taskTableMatches(task, { search }), true);
  assert.equal(taskTableMatches(task, { search: 'bulunmayan' }), false);
  assert.equal(taskTableMatches({ ...task, sorumlu: {} }, { search: 'radar' }), true);
});
