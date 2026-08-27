import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TASK_PRIORITY_FILTER_OPTIONS,
  TASK_STATUS_FILTER_OPTIONS
} from '../src/domain/constants/index.js';
import {
  simpleTaskFacetValues,
  simpleTaskMatches
} from '../src/features/tasks/simpleTaskFacets.js';

const referenceDay = new Date(2026, 7, 27);
const tasks = [
  {
    id: 'alpha', projectId: 'project-a', task: 'Alpha', proje: 'A', projectCode: 'A', keyword: 'Teklif',
    assigneeIds: ['ayse'], sorumlu: ['Ayşe'], priority: 'high', status: 'todo', targetFinish: '2026-08-20'
  },
  {
    id: 'beta', projectId: 'project-a', task: 'Beta', proje: 'A', projectCode: 'A', keyword: 'Onay',
    assigneeIds: ['mehmet'], sorumlu: ['Mehmet'], priority: 'medium', status: 'done', targetFinish: '2026-08-29'
  },
  {
    id: 'gamma', projectId: 'project-b', task: 'Gamma', proje: 'B', projectCode: 'B', keyword: 'Teslim',
    assigneeIds: ['can'], sorumlu: ['Can'], priority: 'low', status: 'in_progress', targetFinish: '2026-09-10'
  }
];

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Basit Mod sorumlu seçeneklerini ilgili görev satırlarından üretir', () => {
  const state = { search: '', filters: { proje: ['project-a'], sorumlu: ['ayse'] } };
  const values = simpleTaskFacetValues(tasks, state, 'sorumlu', referenceDay);

  assert.deepEqual([...values].sort(), ['ayse', 'mehmet']);
  assert.equal(values.has('unrelated-directory-user'), false);
});

test('sorumlu faseti kendi seçimini yok sayar, diğer süzgeçlerle daralır', () => {
  const state = {
    search: '',
    filters: { proje: ['project-a'], sorumlu: ['ayse'], status: ['done'] }
  };
  const values = simpleTaskFacetValues(tasks, state, 'sorumlu', referenceDay);

  assert.deepEqual([...values], ['mehmet']);
  assert.equal(simpleTaskMatches(tasks[1], state, 'sorumlu', referenceDay), true);
  assert.equal(simpleTaskMatches(tasks[0], state, 'sorumlu', referenceDay), false);
});

test('kısa açıklama faseti seçenek ve satır eşlemesinde aynı kırpmayı kullanır', () => {
  const spaced = { ...tasks[0], keyword: '  Teklif  ' };
  const state = { search: '', filters: { keyword: ['Teklif'] } };
  assert.equal(simpleTaskMatches(spaced, state, null, referenceDay), true);
  assert.deepEqual([...simpleTaskFacetValues([spaced], { filters: {} }, 'keyword', referenceDay)], ['Teklif']);
});

test('Basit Mod öncelik seçenekleri ortak renk ve simge üst verisini kullanır', () => {
  assert.deepEqual(TASK_PRIORITY_FILTER_OPTIONS.map(({ id, label }) => ({ id, label })), [
    { id: 'critical', label: 'Kritik' },
    { id: 'high', label: 'Yüksek' },
    { id: 'medium', label: 'Orta' },
    { id: 'low', label: 'Düşük' }
  ]);
  assert.ok(TASK_PRIORITY_FILTER_OPTIONS.every((option) => option.color));

  const simple = read('src/features/tasks/SimpleTasksView.jsx');
  const advanced = read('src/features/tasks/TasksView.jsx');
  for (const source of [simple, advanced]) {
    assert.match(source, /TASK_PRIORITY_FILTER_OPTIONS/);
    assert.match(source, /<PriorityIcon color=\{priority\.color\} size=\{11\} \/>/);
  }
});

test('Basit Mod durum süzgeci mevcut ortak durum simgesi anlamlarını korur', () => {
  assert.deepEqual(TASK_STATUS_FILTER_OPTIONS, [
    { value: 'todo', label: 'Yapılacak' },
    { value: 'in_progress', label: 'Devam ediyor' },
    { value: 'done', label: 'Tamamlandı' },
    { value: 'overdue', label: 'Geciken' }
  ]);

  const simple = read('src/features/tasks/SimpleTasksView.jsx');
  const advanced = read('src/features/tasks/TasksView.jsx');
  for (const source of [simple, advanced]) {
    assert.match(source, /TASK_STATUS_FILTER_OPTIONS/);
    assert.match(source, /<StatusIcon id=\{status\.value\} size=\{11\} \/>/);
  }
  assert.deepEqual([...simpleTaskFacetValues(tasks, { filters: {} }, 'status', referenceDay)].sort(), [
    'done', 'in_progress', 'overdue', 'todo'
  ]);
});
