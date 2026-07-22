import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';
import { buildProjectCsv, buildProjectExcelHtml } from '../src/lib/exportProjectData.js';
import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import { calculateCpm } from '../src/scheduling/cpm/index.js';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('legacy day lags are materialized before users change the lag unit', () => {
  const task = normalizeTaskRecord({
    id: 't1',
    projectId: 'p1',
    deps: [{ id: 'pred', type: 'FS', lagDays: 3 }]
  }, {
    projects: [{ id: 'p1', name: 'Project' }],
    people: [],
    wbs: [],
    calendars: []
  });

  assert.deepEqual(task.deps[0], {
    id: 'pred',
    predecessorId: 'pred',
    type: 'FS',
    lagDays: 3,
    lagValue: 3,
    lagUnit: 'day'
  });
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
  assert.deepEqual(result.project.tags, ['Test']);
  assert.deepEqual(
    result.changes.taskUpserts.map((task) => [task.id, task.keyword]),
    [['t1', 'Test'], ['t2', 'Test']]
  );
});

test('topbar popovers can escape the header and every task-table header stays sticky', () => {
  const css = read('src/app/enhancements.css');

  assert.match(css, /\.topbar\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.topbar\s*\{[^}]*z-index:\s*100;/s);
  assert.match(css, /\.tbl thead th\s*\{[^}]*position:\s*sticky\s*!important;[^}]*top:\s*0;/s);
});
