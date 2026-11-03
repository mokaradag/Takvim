import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anlamsal düzen sahipliği denetimi: boyutlar özellik CSS dosyasına aittir ve
// satır içi biçim değişimi yerine katmanlama da bu dosyaya aittir.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test("alan Gantt yüksekliği sabit satır içi yükseklik yerine özellik CSS dosyasına aittir", () => {
  const gantt = read('src/features/gantt/GanttView.jsx');
  const wbsGantt = read('src/features/gantt/WbsGanttView.jsx');
  const css = read('src/app/styles/features.css');

  assert.doesNotMatch(gantt, /height:\s*['"]calc\(100vh - 240px\)['"]/);
  assert.doesNotMatch(wbsGantt, /height:\s*['"]calc\(100vh - 240px\)['"]/);
  assert.match(css, /\.gantt-chart-host \.gantt-wrap\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*auto;[^}]*min-height:\s*0;/s);
});

test("görev tablosu esnek boyutu anlamsaldır; satır içi azami yükseklik bunu aşamaz", () => {
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

test("süzülebilir tablo başlığı satır içi konum değişimi olmadan sabit kalır", () => {
  const shared = read('src/components/ui-extras.jsx');
  const date = read('src/components/DateFilterableTH.jsx');
  const css = read('src/app/styles/components.css');

  assert.match(shared, /className=\{`filterable-th\$\{open \? ' is-filter-open' : ''\}`\} style=\{style\}/);
  assert.match(date, /className=\{`filterable-th\$\{open \? ' is-filter-open' : ''\}`\} style=\{style\}/);
  assert.doesNotMatch(shared, /<th style=\{\{ \.\.\.style, position: 'relative' \}\}>/);
  assert.doesNotMatch(date, /<th style=\{\{ \.\.\.style, position: 'relative' \}\}>/);
  assert.match(css, /\.tbl thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*var\(--z-sticky\);/s);
});

test("açık sütun süzgeci kendi başlığını kardeş sabit başlıkların üstüne yükseltir", () => {
  const shared = read('src/components/ui-extras.jsx');
  const css = read('src/app/styles/components.css');

  assert.match(shared, /filterable-th\$\{open \? ' is-filter-open' : ''\}/);
  assert.match(css, /\.tbl thead th\.filterable-th\.is-filter-open\s*\{\s*z-index:\s*var\(--z-popover\);\s*\}/s);
  assert.match(css, /\.col-filter-pop,[\s\S]*?z-index:\s*var\(--z-popover\);/);
  assert.doesNotMatch(css, /th:has\(\.col-filter-pop\)/);
});
