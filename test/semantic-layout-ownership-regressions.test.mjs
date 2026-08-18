import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Focused guards for semantic layout ownership: feature CSS owns sizing and
// stacking instead of inline style overrides.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Workspace Gantt height is owned by feature CSS instead of a fixed inline viewport height', () => {
  const gantt = read('src/features/gantt/GanttView.jsx');
  const wbsGantt = read('src/features/gantt/WbsGanttView.jsx');
  const css = read('src/app/styles/features.css');

  assert.doesNotMatch(gantt, /height:\s*['"]calc\(100vh - 240px\)['"]/);
  assert.doesNotMatch(wbsGantt, /height:\s*['"]calc\(100vh - 240px\)['"]/);
  assert.match(css, /\.gantt-chart-host \.gantt-wrap\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*auto;[^}]*min-height:\s*0;/s);
});

test('Tasks table flex sizing is semantic and no inline max-height can override it', () => {
  const tasks = read('src/features/tasks/TasksView.jsx');
  const css = read('src/app/styles/components.css');

  assert.match(tasks, /className="tasks-page col"/);
  assert.match(tasks, /className="tasks-table-card"/);
  assert.match(tasks, /className="tasks-table-scroll"/);
  assert.doesNotMatch(tasks, /tasks-table-scroll[^>]*maxHeight/);
  assert.doesNotMatch(tasks, /maxHeight:\s*['"]calc\(100vh - 240px\)['"]/);
  assert.match(css, /\.tasks-table-card\s*\{[^}]*flex:\s*1 1 0;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.tasks-table-scroll\s*\{[^}]*flex:\s*1 1 0;[^}]*max-height:\s*none;[^}]*overflow:\s*auto;/s);
});

test('Filterable table headers keep sticky positioning by avoiding inline position overrides', () => {
  const shared = read('src/components/ui-extras.jsx');
  const date = read('src/components/DateFilterableTH.jsx');
  const css = read('src/app/styles/components.css');

  assert.match(shared, /className=\{`filterable-th\$\{open \? ' is-filter-open' : ''\}`\} style=\{style\}/);
  assert.match(date, /className=\{`filterable-th\$\{open \? ' is-filter-open' : ''\}`\} style=\{style\}/);
  assert.doesNotMatch(shared, /<th style=\{\{ \.\.\.style, position: 'relative' \}\}>/);
  assert.doesNotMatch(date, /<th style=\{\{ \.\.\.style, position: 'relative' \}\}>/);
  assert.match(css, /\.tbl thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*var\(--z-sticky\);/s);
});

test('An open column filter raises its semantic header stacking context above sibling sticky headers', () => {
  const shared = read('src/components/ui-extras.jsx');
  const css = read('src/app/styles/components.css');

  assert.match(shared, /filterable-th\$\{open \? ' is-filter-open' : ''\}/);
  assert.match(css, /\.tbl thead th\.filterable-th\.is-filter-open\s*\{\s*z-index:\s*var\(--z-popover\);\s*\}/s);
  assert.match(css, /\.col-filter-pop,[\s\S]*?z-index:\s*var\(--z-popover\);/);
  assert.doesNotMatch(css, /th:has\(\.col-filter-pop\)/);
});
