import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { button, click, mountDom } from './helpers/clientDomHarness.mjs';
import { filterState, tasks as fixtureTasks } from './helpers/columnFilterFixtures.mjs';
import { createPersonLookup } from '../src/components/avatarIdentity.js';
import { ganttAssigneeGroup } from '../src/features/gantt/ganttAssignees.js';
import { compareAssigneesBySicil } from '../src/features/tasks/taskDisplayValues.js';

const { TasksView } = await import('../src/features/tasks/TasksView.jsx');
const { SimpleTasksView } = await import('../src/features/tasks/SimpleTasksView.jsx');
const { GanttView } = await import('../src/features/gantt/GanttView.jsx');
const { PeopleDirectoryProvider } = await import('../src/components/PeopleDirectoryContext.jsx');
const { TaskOrganizationFilterProvider } = await import('../src/features/tasks/TaskOrganizationFilterContext.jsx');

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
