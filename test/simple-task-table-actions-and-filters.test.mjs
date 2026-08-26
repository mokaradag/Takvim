import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createEmptySimpleTaskFilterState, SIMPLE_TASK_COLUMNS } from '../src/features/tasks/simpleTaskColumns.js';
import { simpleCalendarTabForIntent } from '../src/components/shell/navigation.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Basit Görevler üst sağdaki Yeni Görev eylemini mevcut hızlı girişe yönlendirir', () => {
  const view = read('src/features/tasks/SimpleTasksView.jsx');
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(view, /className="btn primary"[\s\S]*onClick=\{onNewTask\}[\s\S]*disabled=\{!canAddTask\}[\s\S]*Yeni Görev/);
  assert.equal(simpleCalendarTabForIntent('entry'), 'entry');
  assert.equal(simpleCalendarTabForIntent(null), 'calendar');
  assert.match(shell, /onNewTask=\{\(\) => navigate\('takvim', 'entry'\)\}/);
  assert.match(shell, /<SimpleModePanel \/>/);
});

test('Basit Görevler yalnızca sade sütunlarda ortak filtre bileşenlerini kullanır', () => {
  assert.deepEqual(SIMPLE_TASK_COLUMNS.map((column) => column.label), [
    'Proje', 'Görev', 'Kısa açıklama', 'Sorumlular', 'Öncelik', 'Durum', 'Termin'
  ]);
  const view = read('src/features/tasks/SimpleTasksView.jsx');
  for (const label of ['Proje', 'Görev', 'Kısa açıklama', 'Sorumlular', 'Öncelik', 'Durum']) {
    assert.match(view, new RegExp(`<FilterableTH label="${label}"`));
  }
  assert.match(view, /<DateFilterableTH label="Termin"/);
  assert.match(view, /filterType="text"/);
  assert.match(view, /filterType="multi"/);
  assert.match(view, /dateMatchesFilter\(task\.targetFinish, filters\.targetFinish\)/);
});

test('Basit Görevler filtre sıfırlama ve klavye ile görev açma davranışını korur', () => {
  assert.deepEqual(createEmptySimpleTaskFilterState(), {
    search: '',
    filters: { proje: [], task: '', keyword: [], sorumlu: [], priority: [], status: [], targetFinish: null }
  });
  const view = read('src/features/tasks/SimpleTasksView.jsx');
  assert.match(view, /Filtreleri temizle/);
  assert.match(view, /<button[\s\S]*className="simple-tasks-open"[\s\S]*openTask\(task\)/);

  const filter = read('src/components/ui-extras.jsx');
  assert.match(filter, /event\.key === 'Enter'/);
  assert.match(filter, /event\.key === 'Escape'/);
});
