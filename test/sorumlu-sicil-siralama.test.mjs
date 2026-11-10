import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { button, click, mountDom } from './helpers/clientDomHarness.mjs';
import { filterState, tasks as fixtureTasks } from './helpers/columnFilterFixtures.mjs';
import { createPersonLookup } from '../src/components/avatarIdentity.js';
import { ganttAssigneeGroup } from '../src/features/gantt/ganttAssignees.js';
import { taskAssigneeEntries, taskAssigneeFilterEntries } from '../src/features/tasks/taskAssigneeIdentity.js';
import { createTaskAssigneeOrganizationIndex, filterTasksByOrganization, organizationPeopleForTasks } from '../src/domain/organization/taskOrganizationFilter.js';
import { compareAssigneesBySicil } from '../src/features/tasks/taskDisplayValues.js';

const { TasksView } = await import('../src/features/tasks/TasksView.jsx');
const { SimpleTasksView } = await import('../src/features/tasks/SimpleTasksView.jsx');
const { GanttView } = await import('../src/features/gantt/GanttView.jsx');
const { PeopleDirectoryProvider } = await import('../src/components/PeopleDirectoryContext.jsx');
const { TaskOrganizationFilterProvider } = await import('../src/features/tasks/TaskOrganizationFilterContext.jsx');
const { TaskOrganizationFilterControls } = await import('../src/features/tasks/TaskOrganizationFilterControls.jsx');

const people = [
  { id: 'internal-10000', employeeNo: '10000', name: 'Ali' },
  { id: 'internal-9000', employeeNo: '9000', name: 'Zeynep' }
];
const tasks = [
  { ...fixtureTasks[0], id: 'buyuk', task: 'On bin görevi', sorumlu: ['Ali'], assigneeIds: ['internal-10000'], assigneeAvatarIdentities: [{ name: 'Ali', employeeNo: '10000' }], deps: [] },
  { ...fixtureTasks[1], id: 'kucuk', task: 'Dokuz bin görevi', sorumlu: ['Zeynep'], assigneeIds: ['internal-9000'], assigneeAvatarIdentities: [{ name: 'Zeynep', employeeNo: '9000' }], deps: [] }
];

function screenState() {
  const state = filterState(tasks);
  return { ...state, people, workspace: { ...state.workspace, people } };
}

function Screen({ gantt, simple = false }) {
  const view = React.createElement(gantt ? GanttView : simple ? SimpleTasksView : TasksView,
    simple ? { onNewTask() {} } : null);
  return React.createElement(PeopleDirectoryProvider, { people },
    gantt ? view : React.createElement(TaskOrganizationFilterProvider, null, view));
}

function taskNames(gantt) {
  return gantt
    ? [...document.querySelectorAll('.gantt-task-row .tr-name')].map((node) => node.textContent)
    : [...document.querySelectorAll('tbody tr')].map((node) => node.textContent);
}

function assertTaskOrder(gantt, labels) {
  const rows = taskNames(gantt);
  assert.equal(rows.length, labels.length);
  labels.forEach((label, index) => assert.ok(rows[index].includes(label), `${index + 1}. görev ${label} olmalıdır`));
}

function showSorumluColumn() {
  click(document.querySelector('[title="Sütunları yönet"]'));
  const option = [...document.querySelectorAll('.gantt-cols-pop label')]
    .find((node) => node.textContent.trim() === 'Sorumlu');
  assert.ok(option, 'Gantt sorumlu sütunu bulunmalıdır');
  click(option.querySelector('input'));
  click(document.body);
}

test('Siciller sayısal, iç kimlikten bağımsız ve eşit değerlerde kararlı sıralanır', () => {
  assert.deepEqual([...people].sort(compareAssigneesBySicil).map((person) => person.employeeNo), ['9000', '10000']);
  assert.deepEqual([...people].sort((a, b) => compareAssigneesBySicil(a, b, 'desc')).map((person) => person.employeeNo), ['10000', '9000']);
  const equal = [{ employeeNo: '09000', name: 'A' }, { employeeNo: '9000', name: 'B' }];
  assert.equal(compareAssigneesBySicil(equal[0], equal[1]), 0);
  assert.deepEqual([...equal].sort(compareAssigneesBySicil), equal);
  const absent = { id: '1', name: 'İsimsiz' };
  const malformed = { id: '2', employeeNo: '9X00', name: 'Bozuk' };
  assert.equal(compareAssigneesBySicil(absent, people[0]), 1);
  assert.equal(compareAssigneesBySicil(absent, people[0], 'desc'), 1);
  assert.ok(compareAssigneesBySicil(malformed, absent) < 0);
  assert.equal(compareAssigneesBySicil({ id: '9000', name: 'Kimlik' }, people[1]), 1);
  assert.ok(compareAssigneesBySicil({ employeeNo: '100000000000000000000' }, { employeeNo: '99999999999999999999' }) > 0);
  assert.ok(compareAssigneesBySicil({ employeeNo: '', sicil: '9000' }, people[0]) < 0);
  assert.ok(compareAssigneesBySicil({ employeeNo: 'bozuk', sicil: '9000' }, people[0]) < 0);
  assert.ok(compareAssigneesBySicil({ employeeNo: '10000', sicil: '9000' }, people[1]) > 0);
  assert.equal(compareAssigneesBySicil({ employeeNo: 'bozuk', sicil: 'geçersiz' }, people[0]), 1);
  assert.ok(compareAssigneesBySicil({ person: { employeeNo: 'bozuk', sicil: '9000' } }, people[0]) < 0);
});

test('Görev kapsamlı ve maskeli kimlikte ilk sorumlunun Sicili korunur', () => {
  const lookup = createPersonLookup(people);
  assert.equal(ganttAssigneeGroup(tasks[0], lookup).person.employeeNo, '10000');
  assert.equal(ganttAssigneeGroup(tasks[1], lookup).person.employeeNo, '9000');
  const masked = { sorumlu: ['Zeynep', 'Ali'], assigneeIds: ['internal-10000'], assigneeAvatarIdentities: [{ name: 'Zeynep', employeeNo: '9000' }, { name: 'Ali', employeeNo: '10000' }] };
  assert.equal(ganttAssigneeGroup(masked, createPersonLookup([])).person.employeeNo, '9000');
});

for (const gantt of [false, true]) {
  test(`${gantt ? 'Gantt' : 'Görevler'} sorumlu süzgeci ve iki sıralama yönü doğru çalışır`, () => {
    const view = mountDom(Screen, { gantt }, screenState());
    try {
      if (gantt) showSorumluColumn();
      const header = () => button('Sorumlu', gantt ? document.querySelector('.gantt-left-head') : document.querySelector('thead'));
      click(header());
      const labels = [...document.querySelectorAll('.col-filter-opt > span:last-child')].map((node) => node.textContent);
      assert.deepEqual(labels, ['9000 · Zeynep', '10000 · Ali']);
      click(button('Artan'));
      assertTaskOrder(gantt, ['Dokuz bin görevi', 'On bin görevi']);
      click(header());
      click(button('Azalan'));
      assertTaskOrder(gantt, ['On bin görevi', 'Dokuz bin görevi']);
      click(header());
      click(document.querySelector('.col-filter-opt input'));
      click(button('Uygula'));
      assertTaskOrder(gantt, ['Dokuz bin görevi']);
    } finally {
      view.unmount();
    }
  });
}

test('Gantt sorumlu grupları Sicile göre artan ve azalan sıralanır', () => {
  const view = mountDom(Screen, { gantt: true }, screenState());
  try {
    click(button('Sorumluya göre'));
    let headers = [...document.querySelectorAll('.gantt-group-header')].map((node) => node.textContent);
    assert.ok(headers[0].includes('Zeynep') && headers[1].includes('Ali'));
    showSorumluColumn();
    click(button('Sorumlu', document.querySelector('.gantt-left-head')));
    click(button('Azalan'));
    headers = [...document.querySelectorAll('.gantt-group-header')].map((node) => node.textContent);
    assert.ok(headers[0].includes('Ali') && headers[1].includes('Zeynep'));
  } finally {
    view.unmount();
  }
});

test('Temel Kip sorumlu süzgeci ve iki sıralama yönü sayısal Sicili kullanır', () => {
  const view = mountDom(Screen, { simple: true }, screenState());
  try {
    const header = () => button('Sorumlular', document.querySelector('.simple-tasks-table thead'));
    click(header());
    const labels = [...document.querySelectorAll('.col-filter-opt > span:last-child')].map((node) => node.textContent);
    assert.deepEqual(labels, ['9000 · Zeynep', '10000 · Ali']);
    click(button('Artan'));
    assertTaskOrder(false, ['Dokuz bin görevi', 'On bin görevi']);
    click(header());
    click(button('Azalan'));
    assertTaskOrder(false, ['On bin görevi', 'Dokuz bin görevi']);
    click(header());
    click(document.querySelector('.col-filter-opt input'));
    click(button('Uygula'));
    assertTaskOrder(false, ['Dokuz bin görevi']);
  } finally {
    view.unmount();
  }
});

test('Atanmamış görevler geçersiz Sicilli atanmış görevlerden her iki yönde sonra gelir', () => {
  const lookup = createPersonLookup([]);
  const unassigned = ganttAssigneeGroup({ sorumlu: [], assigneeIds: [] }, lookup);
  const invalid = ganttAssigneeGroup({
    sorumlu: ['Bora'], assigneeIds: ['bilinmeyen'],
    assigneeAvatarIdentities: [{ name: 'Bora', employeeNo: 'geçersiz' }]
  }, lookup);
  const noSicil = ganttAssigneeGroup({ sorumlu: ['Cem'], assigneeIds: ['başka-kimlik'] }, lookup);
  assert.equal(unassigned.key, 'unassigned:');
  for (const direction of ['asc', 'desc']) {
    assert.ok(compareAssigneesBySicil(invalid, unassigned, direction) < 0);
    assert.ok(compareAssigneesBySicil(unassigned, noSicil, direction) > 0);
    assert.ok(compareAssigneesBySicil(unassigned, people[0], direction) > 0);
  }
  assert.ok(compareAssigneesBySicil(invalid, noSicil) < 0);
  assert.ok(compareAssigneesBySicil(invalid, noSicil, 'desc') > 0);
});

// İç kişi kimliği ile Sicil ayrıldığında seçenek değeri görev kimliği kalmalıdır.
test('Sicil anahtarlı sorumlular süzgeç ve kurumsal kapsamda kaybolmaz', () => {
  const scopedPeople = people.map((person) => ({
    ...person,
    organization: { directorate: person.employeeNo === '9000' ? 'D9' : 'D10' }
  }));
  const lookup = createPersonLookup(scopedPeople);
  const options = taskAssigneeFilterEntries(new Set(['10000', '9000']), lookup);
  assert.deepEqual(options.map(([id]) => id), ['9000', '10000']);
  assert.deepEqual(options.map(([, person]) => person.id), ['internal-9000', 'internal-10000']);

  const sicilTasks = [{ id: 'a', assigneeIds: ['10000'] }, { id: 'b', assigneeIds: ['9000'] }];
  const index = createTaskAssigneeOrganizationIndex(scopedPeople);
  assert.deepEqual(organizationPeopleForTasks(sicilTasks, index).map((person) => person.id), ['internal-10000', 'internal-9000']);
  assert.deepEqual(filterTasksByOrganization(sicilTasks, { directorate: 'D9', department: '', unit: '' }, index).map((task) => task.id), ['b']);
});


// Kimlik, employeeNo ve sicil ayrı kaynaklardır; ikisi de geçerli Sicil takma adıdır.
test('Farklı employeeNo ve sicil değerleri aynı kişiye güvenle çözülür', () => {
  const directory = [
    { id: 'ic-a', employeeNo: '7000', sicil: '8000', name: 'Ayşe', organization: { directorate: 'D-A' } },
    { id: 'ic-b', employeeNo: '9000', name: 'Bora', organization: { directorate: 'D-B' } }
  ];
  const lookup = createPersonLookup(directory);
  assert.equal(lookup.byId('7000')?.id, 'ic-a');
  assert.equal(lookup.byId('8000')?.id, 'ic-a');
  assert.deepEqual(taskAssigneeFilterEntries(new Set(['8000', '9000']), lookup)
    .map(([, person]) => person.id), ['ic-a', 'ic-b']);
  const index = createTaskAssigneeOrganizationIndex(directory);
  const scoped = [{ id: 'gorev-a', assigneeIds: ['8000'] }];
  assert.deepEqual(filterTasksByOrganization(scoped,
    { directorate: 'D-A', department: '', unit: '' }, index).map((task) => task.id), ['gorev-a']);
});

test('Çakışan iç kimlik ve Sicil başka bir kişiyle eşleştirilmez', () => {
  const directory = [
    { id: 'ic-a', employeeNo: '7000', sicil: '8000', name: 'Ayşe', organization: { directorate: 'D-A' } },
    { id: '8000', employeeNo: '9000', name: 'Bora', organization: { directorate: 'D-B' } }
  ];
  const lookup = createPersonLookup(directory);
  const index = createTaskAssigneeOrganizationIndex(directory);
  assert.equal(lookup.byId('8000'), null);
  assert.equal(lookup.isAmbiguousId('8000'), true);
  assert.equal(lookup.isAmbiguousId('7000'), false);
  assert.equal(index.ambiguousIds.has('8000'), true);
  assert.equal(index.peopleById.get('8000'), undefined);
  assert.equal(lookup.byId('7000')?.id, 'ic-a');
  assert.equal(lookup.byId('9000')?.name, 'Bora');
  const tasks = [{ id: 'belirsiz', assigneeIds: ['8000'] }];
  for (const directorate of ['D-A', 'D-B']) {
    assert.deepEqual(filterTasksByOrganization(tasks,
      { directorate, department: '', unit: '' }, index), []);
  }
});

test('Yalnızca sicil alanı olan kişi sorumlu seçeneklerinden düşmez', () => {
  const directory = [{ id: 'ic-z', sicil: '9000', name: 'Zeynep', organization: { directorate: 'D9' } }];
  const lookup = createPersonLookup(directory);
  assert.equal(lookup.byId('9000')?.id, 'ic-z');
  assert.deepEqual(taskAssigneeFilterEntries(new Set(['9000']), lookup)
    .map(([id, person]) => [id, person.name]), [['9000', 'Zeynep']]);
  assert.equal(ganttAssigneeGroup({ assigneeIds: ['9000'] }, lookup).person.id, 'ic-z');
  const index = createTaskAssigneeOrganizationIndex(directory);
  assert.deepEqual(organizationPeopleForTasks([{ assigneeIds: ['9000'] }], index)
    .map((person) => person.name), ['Zeynep']);
});

test('Dizinde bulunmayan kimlikle atanmış görev atanmamış sayılmaz', () => {
  const lookup = createPersonLookup(people);
  const unknown = ganttAssigneeGroup({ assigneeIds: ['kimlik-yok'], sorumlu: [] }, lookup);
  const another = ganttAssigneeGroup({ assigneeIds: ['ikinci-kimlik'], sorumlu: [] }, lookup);
  const unassigned = ganttAssigneeGroup({ assigneeIds: [], sorumlu: [] }, lookup);
  assert.equal(unknown.key, 'unresolved:kimlik-yok');
  assert.notEqual(unknown.key, another.key);
  assert.equal(unknown.person, null);
  assert.equal(unknown.name, 'Bilinmeyen sorumlu');
  assert.equal(unassigned.key, 'unassigned:');
  for (const direction of ['asc', 'desc']) {
    assert.ok(compareAssigneesBySicil(unknown, unassigned, direction) < 0);
  }
  assert.equal(ganttAssigneeGroup({
    assigneeIds: ['kimlik-yok', 'internal-9000'], sorumlu: []
  }, lookup).key, 'unresolved:kimlik-yok');
});


test('Eksik görev projeksiyonu saklı sorumluyu adla tahmin etmez', () => {
  const lookup = createPersonLookup(people);
  const projected = {
    sorumlu: ['Zeynep', 'Ali'],
    assigneeIds: ['internal-10000'],
    assigneeAvatarIdentities: [{ name: 'Ali', employeeNo: '10000' }]
  };
  const entries = taskAssigneeEntries(projected, lookup);
  assert.equal(entries[0].name, 'Zeynep');
  assert.equal(entries[0].person, null);
  assert.equal(entries[1].person?.employeeNo, '10000');
  assert.equal(ganttAssigneeGroup(projected, lookup).person, null);
  const legacy = taskAssigneeEntries({ sorumlu: ['Zeynep'] }, lookup);
  assert.equal(legacy[0].person?.employeeNo, '9000');
});

test('Çakışan kimlik görev kapsamındaki kişiye de bağlanmaz', () => {
  const directory = [
    { id: '9000', employeeNo: '11000', name: 'Birinci' },
    { id: 'ikinci', employeeNo: '9000', name: 'İkinci' }
  ];
  const lookup = createPersonLookup(directory);
  const task = {
    sorumlu: ['İkinci'], assigneeIds: ['9000'],
    assigneeAvatarIdentities: [{ name: 'İkinci', employeeNo: '9000' }]
  };
  assert.equal(lookup.isAmbiguousId('9000'), true);
  assert.equal(taskAssigneeEntries(task, lookup)[0].person, null);
  assert.equal(ganttAssigneeGroup(task, lookup).person, null);
});

test('Kurumsal süzgeç çakışma uyarısını kişisel kimlik ifşa etmeden gösterir', () => {
  const organization = {
    selection: { directorate: '', department: '', unit: '' },
    directorateOptions: [], departmentOptions: [], unitOptions: [],
    hasIdentityConflicts: true,
    selectLevel() {}
  };
  const view = mountDom(TaskOrganizationFilterControls, { organization });
  try {
    const warning = view.host.querySelector('[role="status"]');
    assert.ok(warning);
    assert.match(warning.textContent, /kimlikleri çakışıyor/);
    assert.equal(warning.textContent.includes('9000'), false);
  } finally {
    view.unmount();
  }
});

test('Görev kapsamındaki çakışma isimli ve isimsiz görevde çözülmez', () => {
  const directory = [
    { id: 'ic-a', employeeNo: '9000', name: 'Ayşe' },
    { id: '9000', employeeNo: '10000', name: 'Bora' }
  ];
  const lookup = createPersonLookup(directory);
  const scoped = { id: 'ic-a', employeeNo: '9000', name: 'Ayşe' };
  for (const sorumlu of [['Ayşe'], []]) {
    const task = { assigneeIds: ['ic-a'], sorumlu, assigneeAvatarIdentities: [scoped] };
    const entry = taskAssigneeEntries(task, lookup)[0];
    assert.equal(entry.person, null);
    assert.match(entry.key, /^unresolved:/);
    assert.equal(ganttAssigneeGroup(task, lookup).person, null);
  }

  // Görevdeki iç kimlik, dizindeki başka kişiye ait Sicil'e dönüşemez.
  const onePersonLookup = createPersonLookup([{ id: '9000', name: 'Dizindeki kişi' }]);
  const task = {
    assigneeIds: ['gorev-ic'], sorumlu: ['Görevdeki kişi'],
    assigneeAvatarIdentities: [{ id: 'gorev-ic', employeeNo: '9000', name: 'Görevdeki kişi' }]
  };
  assert.equal(taskAssigneeEntries(task, onePersonLookup)[0].person, null);
});

test('Belirsiz kimlik çözülmüş Sicil ile aynı Gantt grubuna girmez', () => {
  const lookup = createPersonLookup([
    { id: 'ic-a', employeeNo: '9000', name: 'Ayşe' },
    { id: '9000', employeeNo: '10000', name: 'Bora' }
  ]);
  const resolved = ganttAssigneeGroup({ assigneeIds: ['ic-a'] }, lookup);
  const ambiguous = ganttAssigneeGroup({ assigneeIds: ['9000'] }, lookup);
  assert.equal(resolved.key, 'person:9000');
  assert.equal(ambiguous.key, 'unresolved:9000');
  assert.notEqual(resolved.key, ambiguous.key);
});

test('Belirsiz ve bulunamayan sorumlu kimlikleri süzgeçten düşmez', () => {
  const lookup = createPersonLookup([
    { id: 'ic-a', employeeNo: '9000', name: 'Ayşe' },
    { id: '9000', employeeNo: '10000', name: 'Bora' }
  ]);
  const options = taskAssigneeFilterEntries(new Set(['ic-a', '9000', 'kimlik-yok']), lookup);
  assert.deepEqual(new Set(options.map(([id]) => id)), new Set(['ic-a', '9000', 'kimlik-yok']));
  assert.match(options.find(([id]) => id === '9000')[1].name, /9000/);
  assert.match(options.find(([id]) => id === 'kimlik-yok')[1].name, /kimlik-yok/);
});

test('Aynı görünen ada sahip çözümsüz sorumlular Gantt üzerinde birleşmez', () => {
  const lookup = createPersonLookup([]);
  const first = ganttAssigneeGroup({ sorumlu: ['Ortak ad'], assigneeIds: ['bilinmeyen-1'] }, lookup);
  const second = ganttAssigneeGroup({ sorumlu: ['Ortak ad'], assigneeIds: ['bilinmeyen-2'] }, lookup);
  assert.equal(first.key, 'unresolved:bilinmeyen-1');
  assert.equal(second.key, 'unresolved:bilinmeyen-2');
  assert.notEqual(first.key, second.key);
});
