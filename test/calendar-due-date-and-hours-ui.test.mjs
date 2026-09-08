import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { bucketCalendarTasks, taskCalendarDate } from '../src/features/calendar/calendarTaskBucketing.js';
import { taskProgressValue, taskSortValue } from '../src/features/tasks/taskDisplayValues.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Takvim her görevi yalnızca hedef bitiş gününe kovalar', () => {
  const advanced = {
    id: 'advanced', plannedStart: '2026-08-01', plannedFinish: '2026-08-20', targetFinish: '2026-08-24'
  };
  const simple = {
    id: 'simple', plannedStart: '2026-08-12', plannedFinish: '2026-08-12', targetFinish: '2026-08-12'
  };
  const buckets = bucketCalendarTasks([advanced, simple]);

  assert.deepEqual(Object.keys(buckets).sort(), ['2026-08-12', '2026-08-24']);
  assert.deepEqual(buckets['2026-08-24'].map((task) => task.id), ['advanced']);
  assert.equal(Object.values(buckets).flat().filter((task) => task.id === 'advanced').length, 1);
  assert.equal(taskCalendarDate(simple), '2026-08-12');
});

test('hedef bitişi olmayan eski görev planlanan bitişe güvenli biçimde düşer', () => {
  const legacy = { id: 'legacy', plannedStart: '2026-07-01', plannedFinish: '2026-07-31', targetFinish: null };
  assert.equal(taskCalendarDate(legacy), '2026-07-31');
  assert.deepEqual(bucketCalendarTasks([legacy])['2026-07-31'], [legacy]);
});

test('tamamlanan görev açık ilerleme yüzdesi yokken görünüm ve süzgeçte yüzde yüzdür', () => {
  assert.equal(taskProgressValue({ status: 'done', progress: null }), 100);
  assert.equal(taskProgressValue({ status: 'in_progress', progress: null }), 0);
  assert.equal(taskProgressValue({ status: 'done', progress: 35 }), 35);
});

test('ilerleme sıralaması hücrede gösterilen türetilmiş yüzdeyi kullanır', () => {
  const tasks = [
    { id: 'done', status: 'done', progress: null },
    { id: 'explicit', status: 'in_progress', progress: 35 },
    { id: 'todo', status: 'todo', progress: null }
  ];

  tasks.sort((left, right) => taskSortValue(left, 'progress') - taskSortValue(right, 'progress'));
  assert.deepEqual(tasks.map((task) => task.id), ['todo', 'explicit', 'done']);
});

test('Görevler gerçekleşen tarihi, Gantt planlanan tarihi sıralama anlamı olarak korur', () => {
  const task = {
    plannedStart: '2026-08-01', actualStart: '2026-08-09',
    plannedFinish: '2026-08-10', actualFinish: '2026-08-12'
  };
  assert.equal(taskSortValue(task, 'plannedStart'), '2026-08-01');
  assert.equal(taskSortValue(task, 'plannedFinish'), '2026-08-10');
  assert.equal(taskSortValue(task, 'plannedStart', 'effective'), '2026-08-09');
  assert.equal(taskSortValue(task, 'plannedFinish', 'effective'), '2026-08-12');

  const tasksView = read('src/features/tasks/TasksView.jsx');
  const ganttView = read('src/features/gantt/GanttView.jsx');
  assert.match(tasksView, /dateMode: 'effective'/);
  assert.match(tasksView, /taskSortValue\(a, sort\.key, 'effective'\)/);
  assert.match(ganttView, /taskSortValue\(a, sort\.key\), vb = taskSortValue\(b, sort\.key\)/);
  assert.doesNotMatch(ganttView, /dateMode: 'effective'/);
});

test('normal kullanıcı görünümleri efor saati alanlarını sunmaz, kalıcı model uyumluluğu korunur', () => {
  const visibleFiles = [
    'src/features/tasks/TasksView.jsx',
    'src/features/gantt/GanttView.jsx',
    'src/features/kanban/KanbanView.jsx',
    'src/features/dashboard/DashboardView.jsx',
    'src/features/reports/ReportsView.jsx',
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/SimpleTaskDrawer.jsx'
  ];
  for (const path of visibleFiles) {
    assert.doesNotMatch(read(path), /plannedHours|actualHours|Saat \(P\)|Kalan saat|Planlanan saatler/);
  }

  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /PlannedHours, ActualHours/);
  assert.match(repository, /plannedHours: nullableNumber\(row\.PlannedHours\)/);
  assert.match(repository, /actualHours: nullableNumber\(row\.ActualHours\)/);
});
