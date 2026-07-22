import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePersonReferences,
  normalizeProjectReferences
} from '../src/domain/validation/index.js';
import {
  prepareProjectCreation,
  validateProjectCreationInput
} from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('database-shaped project and person rows normalize to canonical code/name and employee number fields', () => {
  const person = normalizePersonReferences({ SicilNo: '4711', AdSoyad: 'Ada Yılmaz' });
  assert.equal(person.id, '4711');
  assert.equal(person.employeeNo, '4711');
  assert.equal(person.name, 'Ada Yılmaz');

  const project = normalizeProjectReferences({ ProjeKodu: 'PRJ-42', ProjeAdi: 'Radar Yenileme' }, [person]);
  assert.equal(project.id, 'PRJ-42');
  assert.equal(project.code, 'PRJ-42');
  assert.equal(project.name, 'Radar Yenileme');
  assert.equal(project.source, 'corporate');
});

test('project creation stores optional project code and rejects duplicate non-empty codes', () => {
  const people = [{ id: 'u1', name: 'Ada Yılmaz' }];
  const calendars = [{ id: 'cal1', name: 'Takvim' }];
  const projects = [{ id: 'p1', code: 'PRJ-42', name: 'Mevcut', color: 'blue' }];

  const duplicateIssues = validateProjectCreationInput({
    code: 'prj-42',
    name: 'Başka Proje',
    leadId: 'u1',
    calendarId: 'cal1',
    dataDate: '2026-07-22',
    color: 'blue'
  }, { projects, people, calendars });
  assert.ok(duplicateIssues.some((issue) => issue.code === 'PROJECT_CODE_DUPLICATE'));

  const created = prepareProjectCreation({
    code: 'prj-99',
    name: 'Yeni Proje',
    source: 'manual',
    leadId: 'u1',
    calendarId: 'cal1',
    dataDate: '2026-07-22',
    color: 'cyan',
    tags: ['Teslim']
  }, { projects: [], people, calendars, wbs: [] }, { projectId: 'p99', rootWbsId: 'w99' });

  assert.equal(created.ok, true);
  assert.equal(created.project.code, 'PRJ-99');
  assert.equal(created.project.source, 'manual');
  assert.deepEqual(created.project.tags, ['Teslim']);
});

test('simple mode uses the existing task/project infrastructure and exposes the requested quick-entry fields', () => {
  const defaults = read('src/lib/tweaks-defaults.js');
  const shell = read('src/components/shell/AppShell.jsx');
  const simple = read('src/features/simple/SimpleModePanel.jsx');
  const settings = read('src/features/settings/SettingsView.jsx');
  const help = read('src/features/help/HelpView.jsx');

  assert.match(defaults, /appMode:\s*'advanced'/);
  assert.match(shell, /SimpleModePanel/);
  assert.match(shell, /SIMPLE_NAV_IDS/);
  assert.match(settings, /Basit Mod/);
  assert.match(settings, /Gelişmiş Mod/);
  assert.match(help, /Çalışma Modları/);

  for (const expected of ['Proje', 'Görev', 'Anahtar sözcük / kısa açıklama', 'Sorumlular', 'Termin tarihi']) {
    assert.match(simple, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(simple, /addProject/);
  assert.match(simple, /addTask/);
  assert.match(simple, /updateTask/);
});

test('topbar project context is truly centered, larger, and the heptagon is clipped by its own header wrapper', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/enhancements.css');

  assert.doesNotMatch(shell, />Aktif Proje</);
  assert.match(shell, /topbar-emblem-clip/);
  assert.match(css, /\.topbar-project-context\s*\{[^}]*left:\s*50%;[^}]*top:\s*50%;[^}]*translate\(-50%,\s*-50%\)/s);
  assert.match(css, /\.topbar-project-context strong\s*\{[^}]*font-size:\s*17px;/s);
  assert.match(css, /\.topbar-emblem-clip\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.topbar\s*\{[^}]*overflow:\s*visible;/s);
});

test('layout regression fixes reserve card info space and keep task/Gantt scrolling inside their content areas', () => {
  const css = read('src/app/enhancements.css');
  const gantt = read('src/features/gantt/WorkspaceGanttView.jsx');

  assert.match(css, /\.card-head-wrap\s*\{[^}]*padding:[^;]*38px/s);
  assert.match(css, /\.card-head-wrap \.card-info-corner\s*\{[^}]*top:\s*50%/s);
  assert.match(css, /\.content-veri\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.content-gantt\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.gantt-holiday-stripe\s*\{[^}]*z-index:\s*12/s);
  assert.match(css, /\.drawer\s*\{[^}]*z-index:\s*310/s);
  assert.match(css, /\.drawer \.rel-item > div:nth-child\(2\)/);
  assert.match(gantt, /gantt-chart-host/);
});
