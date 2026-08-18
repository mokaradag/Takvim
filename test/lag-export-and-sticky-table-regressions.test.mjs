import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProjectCsv, buildProjectExcelHtml } from '../src/lib/exportProjectData.js';
import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import { calculateCpm } from '../src/scheduling/cpm/index.js';
import { dependencyLagDays } from '../src/scheduling/dependencies/index.js';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';
import { applyProjectTagPropagation, planProjectTagPropagation } from '../src/domain/tags/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('legacy day lag values are preserved before a unit-only edit is recalculated', () => {
  const editedDependency = {
    id: 'pred',
    predecessorId: 'pred',
    type: 'FS',
    lagDays: 3,
    lagUnit: 'week'
  };

  assert.equal(dependencyLagDays(editedDependency), 15);
  assert.equal(editedDependency.lagValue, 3);
  assert.equal(editedDependency.lagUnit, 'week');
});

test('legacy lag calculations tolerate immutable dependency snapshots', () => {
  const frozenDependency = Object.freeze({
    id: 'pred',
    predecessorId: 'pred',
    type: 'FS',
    lagDays: 3,
    lagUnit: 'week'
  });

  assert.equal(dependencyLagDays(frozenDependency), 15);
  assert.equal(frozenDependency.lagValue, undefined);
});

test('week lags use the successor active calendar in both CPM passes', () => {
  const sixDayCalendar = normalizeCalendar({
    id: 'cal-six-day',
    name: 'Six Day',
    timezone: 'Europe/Istanbul',
    workingDays: [1, 2, 3, 4, 5, 6],
    holidays: []
  });

  const result = calculateCpm([
    {
      id: 'A', projectId: 'p1', task: 'A', plannedDurationDays: 1, deps: []
    },
    {
      id: 'B', projectId: 'p1', task: 'B', plannedDurationDays: 1,
      deps: [{ predecessorId: 'A', type: 'FS', lagValue: 1, lagUnit: 'week', lagDays: 5 }]
    }
  ], {
    projects: [{ id: 'p1', name: 'Project', calendarId: sixDayCalendar.id }],
    calendars: [sixDayCalendar],
    projectStart: '2026-06-01'
  });

  assert.equal(result.tasks.B.earlyStart, '2026-06-09');
  assert.equal(result.tasks.A.lateStart, '2026-06-01');
  assert.equal(result.tasks.A.totalFloatDays, 0);
  assert.deepEqual(result.criticalTaskIds, ['A', 'B']);
  assert.deepEqual(result.criticalPaths, [['A', 'B']]);
});

test('CSV and Excel-compatible exports neutralize formula-like user values', () => {
  const input = {
    tasks: [{
      id: 't1',
      task: '=2+2',
      keyword: '+SUM(A1:A2)',
      sorumlu: ['@cmd'],
      status: 'todo',
      priority: 'medium',
      progress: 0,
      deps: []
    }],
    wbs: []
  };

  const csv = buildProjectCsv(input);
  const html = buildProjectExcelHtml(input);

  assert.match(csv, /'=2\+2/);
  assert.match(csv, /'\+SUM\(A1:A2\)/);
  assert.match(csv, /'@cmd/);
  assert.doesNotMatch(csv, /(?:^|;)=2\+2(?:;|$)/m);

  assert.match(html, /&#039;=2\+2/);
  assert.match(html, /&#039;\+SUM\(A1:A2\)/);
  assert.match(html, /&#039;@cmd/);
});

test('project tag deduplication remaps legacy task variants to the retained tag', () => {
  const context = {
    projects: [{
      id: 'p1', name: 'Alpha', color: 'blue', leadId: 'u1', lead: 'Ayşe',
      calendarId: 'cal1', dataDate: '2026-07-22', tags: ['Test', ' test ']
    }],
    people: [{ id: 'u1', name: 'Ayşe' }],
    calendars: [{ id: 'cal1', name: 'Calendar' }],
    tasks: [
      { id: 't1', projectId: 'p1', proje: 'Alpha', color: 'blue', keyword: 'test' },
      { id: 't2', projectId: 'p1', proje: 'Alpha', color: 'blue', keyword: ' Test ' }
    ],
    wbs: []
  };

  const result = prepareProjectUpdateChanges('p1', {
    name: 'Alpha',
    color: 'blue',
    leadId: 'u1',
    calendarId: 'cal1',
    dataDate: '2026-07-22',
    tags: ['Test', ' test ']
  }, context);

  assert.equal(result.ok, true);
  assert.deepEqual(result.project.tags.map((tag) => tag.name), ['Test']);
  // Harf varyantlarının kanonik ada çekilmesi artık istemcinin gördüğü görev
  // listesinden türetilmez; plan kalıcı katmanda CANLI satırlara uygulanır.
  assert.deepEqual(result.changes.taskUpserts, []);
  const plan = planProjectTagPropagation({ storedTags: ['Test', ' test '], nextTags: result.project.tags });
  assert.deepEqual(
    applyProjectTagPropagation(context.tasks, 'p1', plan).map((task) => [task.id, task.keyword]),
    [['t1', 'Test'], ['t2', 'Test']]
  );
});

test('topbar popovers can escape the header and every task-table header stays sticky', () => {
  const shellCss = read('src/app/styles/shell.css');
  const componentCss = read('src/app/styles/components.css');

  assert.match(shellCss, /\.topbar\s*\{[^}]*z-index:\s*var\(--z-chrome\);[^}]*overflow:\s*visible;/s);
  assert.match(componentCss, /\.tbl thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*var\(--z-sticky\);/s);
});
