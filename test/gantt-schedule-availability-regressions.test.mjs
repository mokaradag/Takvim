import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { taskDurationDays, taskPlannedDurationDays } from '../src/scheduling/metrics/index.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('legacy Gantt duration export remains compatible with the scheduling metric', () => {
  const task = { plannedDurationDays: 7 };
  assert.equal(taskDurationDays(task), 7);
  assert.equal(taskDurationDays(task), taskPlannedDurationDays(task));
});

test('presentation polish never rewrites user data or changes responsive SVG aspect ratios', () => {
  const source = read('src/components/shell/PresentationPolish.jsx');

  assert.doesNotMatch(source, /TEXT_REPLACEMENTS/);
  assert.doesNotMatch(source, /createTreeWalker/);
  assert.doesNotMatch(source, /setAttribute\(['"]preserveAspectRatio/);
  assert.doesNotMatch(source, /preserveAspectRatio\s*=\s*['"]xMidYMid meet/);
  assert.match(source, /vector-effect:\s*non-scaling-stroke/);
  assert.match(source, /shape-rendering:\s*geometricPrecision/);
});

test('WBS Gantt reattaches scroll and pan listeners when WBS availability changes', () => {
  const source = read('src/features/gantt/WbsGanttView.jsx');

  assert.match(source, /const hasWbs = wbs\.length > 0/);
  assert.ok((source.match(/\}, \[hasWbs\]\);/g) || []).length >= 2);
  assert.match(source, /\}, \[hasWbs, today_, xForDate, zoom\]\);/);
  assert.match(source, /if \(!hasWbs\) \{\s*return <div className="card muted">/);
});

test('WBS Gantt gates critical-path data behind a valid project schedule', () => {
  const source = read('src/features/gantt/WbsGanttView.jsx');

  assert.match(source, /const scheduleAvailable = projectSchedule\?\.status === 'valid'/);
  assert.match(source, /const criticalPathUnavailable = projectSchedule\?\.status === 'invalid'/);
  assert.match(source, /const scheduleTasks = scheduleAvailable \? projectSchedule\.tasks : EMPTY_SCHEDULE_TASKS/);
  assert.match(source, /critical:\s*scheduleAvailable && Boolean/);
  assert.match(source, /const critical = scheduleAvailable && Boolean/);
  assert.match(source, /Kritik yol bilgisi şu anda kullanılamıyor/);
  assert.match(source, /Görev tarihleri veya bağımlılık ilişkileri gözden geçirilmeli/);
});

test('portfolio Gantt does not render missing planned dates as today', () => {
  const source = read('src/features/gantt/GanttView.jsx');

  assert.match(source, /function hasPlannedRange\(task\)/);
  assert.match(source, /return value \? fmt\(value, pattern\) : <span className="muted">—<\/span>/);
  assert.match(source, /if \(!hasPlannedRange\(depTask\) \|\| !hasPlannedRange\(r\.task\)\) return/);
  assert.match(source, /if \(!hasPlannedRange\(t\)\) \{/);
});

test('cross-project dependencies produce an invalid project schedule for the UI unavailable state', () => {
  const schedule = buildPortfolioSchedule({
    projects: [
      { id: 'p-a', name: 'A' },
      { id: 'p-b', name: 'B' }
    ],
    tasks: [
      {
        id: 'a-1',
        projectId: 'p-a',
        plannedStart: '2026-07-01',
        plannedFinish: '2026-07-02',
        deps: [{ id: 'b-1', type: 'FS' }]
      },
      {
        id: 'b-1',
        projectId: 'p-b',
        plannedStart: '2026-07-01',
        plannedFinish: '2026-07-02',
        deps: []
      }
    ],
    calendars: []
  });

  assert.equal(schedule.projects['p-a'].status, 'invalid');
  assert.equal(schedule.projects['p-a'].error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.equal(schedule.tasks['a-1'], undefined);
  assert.equal(schedule.warnings.some((warning) => warning.code === 'CROSS_PROJECT_DEPENDENCY'), true);
});

test('proje dışı bağımlılık, görev kimliği SAYI iken de yakalanır', () => {
  // `tasksById` anahtarları ham `task.id` ile kurulduğunda sayısal kimlik,
  // metin gelen `predecessorId` ile eşleşmiyordu. Iskalanan öncül sessizce
  // atlandığı için denetim hiç çalışmıyor ve `calculateCpm` çözümlenmemiş
  // öncüllü bir ağı "geçerli" olarak zamanlıyordu.
  const schedule = buildPortfolioSchedule({
    projects: [
      { id: 'p-a', name: 'A' },
      { id: 'p-b', name: 'B' }
    ],
    tasks: [
      { id: 1, projectId: 'p-a', plannedStart: '2026-07-01', plannedFinish: '2026-07-02', deps: [{ id: '2', type: 'FS' }] },
      { id: 2, projectId: 'p-b', plannedStart: '2026-07-01', plannedFinish: '2026-07-02', deps: [] }
    ],
    calendars: []
  });

  assert.equal(schedule.projects['p-a'].status, 'invalid');
  assert.equal(schedule.projects['p-a'].error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.equal(schedule.projects['p-a'].error.details.dependencies[0].predecessorProjectId, 'p-b');
});
