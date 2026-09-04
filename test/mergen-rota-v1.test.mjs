import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTaskCalendarWarnings } from '../src/scheduling/calendarWarnings.js';
import { fmtDisplayDate } from '../src/scheduling/dates/index.js';
import {
  dependencyLagDays,
  formatDependencyLag,
  normalizeDependency
} from '../src/scheduling/dependencies/index.js';
import {
  calculateTaskDateRange,
  clearGanttDateRangeOverride,
  getTaskDateRange,
  setGanttDateRangeOverride
} from '../src/scheduling/metrics/index.js';
import { buildProjectCsv, buildProjectWorkbook } from '../src/lib/exportProjectData.js';
import { TAG_COLOR_KEYS, TAG_ICON_KEYS } from '../src/domain/tags/index.js';
import { normalizeProjectTags, prepareProjectCreation, prepareProjectUpdate } from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function projectContext() {
  return {
    calendars: [{ id: 'cal', name: 'Takvim', workingDays: [1, 2, 3, 4, 5], holidays: [] }],
    projects: [{ id: 'p1', name: 'Proje', color: 'blue', leadId: 'u1', lead: 'Ayşe', calendarId: 'cal', dataDate: '2026-07-22', tags: ['Analiz'] }],
    people: [{ id: 'u1', name: 'Ayşe' }],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Proje', sortOrder: 1 }],
    tasks: []
  };
}

test('project tag catalog trims, deduplicates case-insensitively, and sorts values', () => {
  // Etiket artık ad + renk + simge taşır; kırpma/tekilleştirme/sıralama kuralları aynıdır.
  assert.deepEqual(
    normalizeProjectTags([' Test ', 'test', 'Analiz', '', 'ANALİZ']).map((tag) => tag.name),
    ['Analiz', 'Test']
  );
  for (const tag of normalizeProjectTags(['Test'])) {
    assert.ok(TAG_COLOR_KEYS.includes(tag.color));
    assert.ok(TAG_ICON_KEYS.includes(tag.icon));
  }
});

test('project creation persists the controlled tag catalog', () => {
  const context = projectContext();
  const result = prepareProjectCreation({
    name: 'Yeni Proje',
    leadId: 'u1',
    dataDate: '2026-07-22',
    color: 'purple',
    tags: ['Test', ' Analiz ', 'test']
  }, context, { projectId: 'p2', rootWbsId: 'w2' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.project.tags.map((tag) => tag.name), ['Analiz', 'Test']);
});

test('partial project updates preserve an existing tag catalog', () => {
  const context = projectContext();
  const result = prepareProjectUpdate('p1', {
    name: 'Proje Güncel',
    leadId: 'u1',
    dataDate: '2026-07-23',
    color: 'cyan'
  }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.project.tags.map((tag) => tag.name), ['Analiz']);
});

test('lead and lag values support day, week, and month units', () => {
  assert.equal(dependencyLagDays({ lagValue: 3, lagUnit: 'day' }), 3);
  assert.equal(dependencyLagDays({ lagValue: -2, lagUnit: 'week' }), -10);
  assert.equal(dependencyLagDays({ lagValue: 1, lagUnit: 'month' }), 20);
  assert.equal(formatDependencyLag({ lagValue: -2, lagUnit: 'week' }), '-2 hafta');
  assert.deepEqual(normalizeDependency({ predecessorId: 'a', type: 'FS', lagValue: 2, lagUnit: 'week' }), {
    id: 'a', predecessorId: 'a', type: 'FS', lagValue: 2, lagUnit: 'week', lagDays: 10
  });
});

test('calendar warnings identify weekends and official holidays', () => {
  const calendars = [{
    id: 'cal',
    name: 'Takvim',
    workingDays: [1, 2, 3, 4, 5],
    holidays: [{ date: '2026-07-15', name: 'Resmi Tatil' }]
  }];
  const projects = [{ id: 'p1', name: 'Proje', calendarId: 'cal' }];
  const warnings = getTaskCalendarWarnings({
    projectId: 'p1',
    plannedStart: '2026-07-18',
    plannedFinish: '2026-07-20',
    targetFinish: '2026-07-15'
  }, { projects, calendars });
  assert.deepEqual(warnings.map((warning) => warning.type).sort(), ['holiday', 'weekend']);
});

test('application display date helper uses dd/mm/yyyy', () => {
  assert.equal(fmtDisplayDate('2026-07-22'), '22/07/2026');
});

test('Gantt range override can select and reset a custom display window', () => {
  clearGanttDateRangeOverride();
  const automatic = calculateTaskDateRange([{ plannedStart: '2026-07-10', plannedFinish: '2026-07-20' }], { paddingDays: 0 });
  assert.equal(fmtDisplayDate(automatic.start), '10/07/2026');
  setGanttDateRangeOverride({ start: '2026-07-12', end: '2026-07-15' });
  const custom = getTaskDateRange([{ plannedStart: '2026-07-10', plannedFinish: '2026-07-20' }]);
  assert.equal(fmtDisplayDate(custom.start), '12/07/2026');
  assert.equal(fmtDisplayDate(custom.end), '15/07/2026');
  clearGanttDateRangeOverride();
});

test('CSV and Excel exports include structured project data and formatted dates', () => {
  const input = {
    project: { id: 'p1', name: 'Proje', lead: 'Ayşe', dataDate: '2026-07-22' },
    projects: [{ id: 'p1', name: 'Proje' }],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Proje' }],
    tasks: [{
      id: 't1', projectId: 'p1', wbsId: 'w1', task: 'Analiz', keyword: 'Test', sorumlu: ['Ayşe'],
      status: 'todo', priority: 'high', plannedStart: '2026-07-22', plannedFinish: '2026-07-24',
      targetFinish: '2026-07-25', progress: 25, deps: []
    }]
  };
  const csv = buildProjectCsv(input);
  const workbookBytes = Buffer.from(buildProjectWorkbook(input));
  assert.match(csv, /WBS;Görev;Etiket/);
  assert.match(csv, /22\/07\/2026/);
  // Çalışma kitabı GERÇEK bir `.xlsx` kabıdır (ZIP imzası) ve sıkıştırmasız
  // yazıldığı için sayfa içerikleri doğrudan aranabilir.
  assert.equal(workbookBytes.subarray(0, 2).toString('latin1'), 'PK');
  let offset = 0;
  let tasksSheet = null;
  while (offset + 30 <= workbookBytes.length && workbookBytes.readUInt32LE(offset) === 0x04034b50) {
    const dataLength = workbookBytes.readUInt32LE(offset + 18);
    const nameLength = workbookBytes.readUInt16LE(offset + 26);
    const extraLength = workbookBytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = workbookBytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (name === 'xl/worksheets/sheet2.xml') {
      assert.equal(workbookBytes.readUInt16LE(offset + 8), 0, 'çalışma sayfası sıkıştırmasız olmalıdır');
      tasksSheet = workbookBytes.subarray(dataStart, dataStart + dataLength).toString('utf8');
      break;
    }
    offset = dataStart + dataLength;
  }
  assert.notEqual(tasksSheet, null, 'ikinci çalışma sayfası ZIP içinde bulunmalıdır');
  assert.match(tasksSheet, /Görevler/);
  assert.match(tasksSheet, /İlişkiler/);
  assert.match(tasksSheet, /autoFilter/);
  assert.match(tasksSheet, /state="frozen"/);
});

test('Sürüm 1.0 UI contracts place project creation and tag governance in Proje Yapısı', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src/components/shell/AppShell.jsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'src/components/shell/SidebarUserPanel.jsx'), 'utf8');
  const projectView = fs.readFileSync(path.join(ROOT, 'src/features/project/ProjectWorkspaceView.jsx'), 'utf8');
  const taskDrawer = fs.readFileSync(path.join(ROOT, 'src/features/task-detail/TaskDrawer.jsx'), 'utf8');
  const navigation = fs.readFileSync(path.join(ROOT, 'src/components/shell/navigation.js'), 'utf8');
  const help = fs.readFileSync(path.join(ROOT, 'src/features/help/HelpView.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/app/styles/features.css'), 'utf8');

  assert.doesNotMatch(shell, /onClick=\{\(\) => setProjectCreateOpen\(true\)\}/);
  assert.doesNotMatch(shell, /Data Date ·/);
  assert.doesNotMatch(shell, /CPM ·/);
  assert.match(shell, /topbar-project-context/);
  assert.match(sidebar, /Sürüm 1\.0/);
  assert.match(projectView, /Etiket kataloğu/);
  assert.match(projectView, /Yeni Proje/);
  assert.match(taskDrawer, /kontrollü etiket kataloğundan açıkça seçilir/);
  assert.match(taskDrawer, /Lead \/ Lag/);
  assert.match(navigation, /Kullanım Rehberi/);
  assert.match(help, /Gelişmiş Mod akışı/);
  assert.match(css, /\.gantt-left \{ z-index: 30; \}/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/app/styles/components.css'), 'utf8'), /\.col-filter-pop,\s*\n\.gantt-cols-pop/);
});
