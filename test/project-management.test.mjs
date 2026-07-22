import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createPersistenceChangeSet, createStateMutationOrchestrator } from '../src/state/persistence.js';
import { prepareProjectCreation, prepareProjectUpdate, validateProjectCreationInput } from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seed() {
  return {
    calendars: [{ id: 'cal-1', name: 'Kurumsal Takvim', workingDays: [1, 2, 3, 4, 5], holidays: [] }],
    projects: [
      { id: 'p-1', name: 'Mevcut Proje', color: 'blue', leadId: 'u-1', lead: 'Ayşe', calendarId: 'cal-1', dataDate: '2026-07-22' },
      { id: 'p-2', name: 'İkinci Proje', color: 'emerald', leadId: 'u-2', lead: 'Bora', calendarId: 'cal-1', dataDate: '2026-07-22' }
    ],
    people: [{ id: 'u-1', name: 'Ayşe' }, { id: 'u-2', name: 'Bora' }],
    wbs: [{ id: 'w-1', projectId: 'p-1', parentId: null, code: '1', name: 'Mevcut Proje', sortOrder: 1 }],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
}

function validInput(overrides = {}) {
  return {
    name: 'Yeni Proje',
    leadId: 'u-2',
    dataDate: '2026-07-22',
    color: 'purple',
    ...overrides
  };
}

test('project creation validation rejects empty and duplicate names', () => {
  const context = seed();
  const empty = validateProjectCreationInput(validInput({ name: '   ' }), context);
  assert.equal(empty[0].code, 'PROJECT_NAME_REQUIRED');

  const duplicate = validateProjectCreationInput(validInput({ name: '  mevcut proje  ' }), context);
  assert.equal(duplicate[0].code, 'PROJECT_NAME_DUPLICATE');
});

test('project creation uses the corporate calendar automatically', () => {
  const context = seed();
  const issues = validateProjectCreationInput(validInput(), context);
  assert.deepEqual(issues, []);

  const prepared = prepareProjectCreation(validInput(), context, {
    projectId: 'p-new',
    rootWbsId: 'w-new'
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.calendarId, 'cal-1');
});

test('project creation validation checks lead, corporate calendar, date, and color', () => {
  const context = seed();
  const issues = validateProjectCreationInput({
    name: 'Yeni Proje',
    leadId: 'missing-person',
    dataDate: '2026-02-31',
    color: 'not-a-color'
  }, { ...context, calendars: [] });
  assert.deepEqual(issues.map((issue) => issue.code), [
    'PROJECT_LEAD_NOT_FOUND',
    'PROJECT_CALENDAR_NOT_FOUND',
    'PROJECT_DATA_DATE_INVALID',
    'PROJECT_COLOR_INVALID'
  ]);
});

test('prepareProjectCreation creates an atomic project and root work distribution tree change set', () => {
  const context = seed();
  const prepared = prepareProjectCreation(validInput(), context, {
    projectId: 'p-new',
    rootWbsId: 'w-new'
  });

  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.changes.projectUpserts, [prepared.project]);
  assert.deepEqual(prepared.changes.wbsUpserts, [prepared.rootWbs]);
  assert.equal(prepared.project.name, 'Yeni Proje');
  assert.equal(prepared.project.lead, 'Bora');
  assert.equal(prepared.project.calendarId, 'cal-1');
  assert.equal(prepared.rootWbs.projectId, 'p-new');
  assert.equal(prepared.rootWbs.parentId, null);
  assert.equal(prepared.rootWbs.name, 'Yeni Proje');
  assert.equal(prepared.rootWbs.code, '2');
});

test('prepareProjectUpdate edits the selected project while preserving the corporate calendar', () => {
  const context = seed();
  const prepared = prepareProjectUpdate('p-1', {
    name: 'Mevcut Proje Güncel',
    leadId: 'u-2',
    dataDate: '2026-07-23',
    color: 'cyan'
  }, context);

  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.id, 'p-1');
  assert.equal(prepared.project.name, 'Mevcut Proje Güncel');
  assert.equal(prepared.project.lead, 'Bora');
  assert.equal(prepared.project.calendarId, 'cal-1');

  const sameName = prepareProjectUpdate('p-1', {
    name: 'Mevcut Proje',
    leadId: 'u-1',
    dataDate: '2026-07-22',
    color: 'blue'
  }, context);
  assert.equal(sameName.ok, true);

  const duplicate = prepareProjectUpdate('p-1', {
    name: 'İkinci Proje',
    leadId: 'u-1',
    dataDate: '2026-07-22',
    color: 'blue'
  }, context);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'PROJECT_NAME_DUPLICATE');
});

test('persistence diff includes project upserts without changing legacy empty change-set shape', () => {
  const before = seed();
  const newProject = { id: 'p-new', name: 'Yeni Proje' };
  const changes = createPersistenceChangeSet(before, {
    ...before,
    projects: [...before.projects, newProject]
  });
  assert.deepEqual(changes.projectUpserts, [newProject]);
  assert.equal('projectDeletes' in changes, false);

  const unchanged = createPersistenceChangeSet(before, before);
  assert.equal('projectUpserts' in unchanged, false);
  assert.equal('projectDeletes' in unchanged, false);
});

test('project and root work distribution tree persist atomically and survive repository reload', async () => {
  const repository = createMockRepository(seed());
  const prepared = prepareProjectCreation(validInput(), seed(), {
    projectId: 'p-new',
    rootWbsId: 'w-new'
  });

  const committed = await repository.commitChanges(prepared.changes);
  assert.equal(committed.projectUpserts[0].id, 'p-new');
  assert.equal(committed.wbsUpserts[0].id, 'w-new');

  const reloaded = await repository.loadSnapshot();
  assert.equal(reloaded.projects.some((project) => project.id === 'p-new'), true);
  assert.equal(reloaded.wbs.some((node) => node.id === 'w-new' && node.projectId === 'p-new'), true);
});

test('project persistence failure does not partially add the project or root work distribution tree', async () => {
  const repository = createMockRepository(seed(), {
    failMutation: ({ changes }) => Boolean(changes.projectUpserts?.length)
  });
  let state = createInitialState(await repository.loadSnapshot());
  const applyStateAction = (action) => {
    state = appStateReducer(state, action);
    return state;
  };
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction,
    now: () => '2026-07-22T12:00:00.000Z'
  });
  const prepared = prepareProjectCreation(validInput(), state, {
    projectId: 'p-failed',
    rootWbsId: 'w-failed'
  });

  const result = await persistence.commitChanges('project/create', prepared.changes);
  assert.equal(result.ok, false);
  assert.equal(state.pendingMutationCount, 0);
  assert.equal(state.projects.some((project) => project.id === 'p-failed'), false);
  assert.equal(state.wbs.some((node) => node.id === 'w-failed'), false);

  const reloaded = await repository.loadSnapshot();
  assert.equal(reloaded.projects.some((project) => project.id === 'p-failed'), false);
  assert.equal(reloaded.wbs.some((node) => node.id === 'w-failed'), false);
  persistence.dispose();
});

test('project creation and editing UI use one corporate calendar and the combined project structure page', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src/components/shell/AppShell.jsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/shell/ProjectCreateDialog.jsx'), 'utf8');
  const projectView = fs.readFileSync(path.join(ROOT, 'src/features/project/ProjectWorkspaceView.jsx'), 'utf8');
  const provider = fs.readFileSync(path.join(ROOT, 'src/state/AppStateProvider.jsx'), 'utf8');
  const navigation = fs.readFileSync(path.join(ROOT, 'src/components/shell/navigation.js'), 'utf8');

  assert.match(shell, /Yeni proje/);
  assert.match(shell, /onCreate=\{createProject\}/);
  assert.doesNotMatch(shell, /useCalendars/);
  assert.match(dialog, /ProjectColorPicker/);
  assert.doesNotMatch(dialog, /Proje takvimi/);
  assert.match(provider, /prepareProjectUpdate/);
  assert.match(provider, /commitChanges\('project\/update'/);
  assert.match(projectView, /Proje Tanımı/);
  assert.match(projectView, /İş Dağılım Ağacı/);
  assert.match(navigation, /Proje Yapısı/);
});

test('shared line chart keeps a stable aspect ratio and always connects its points', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/ui.jsx'), 'utf8');
  const areaChart = ui.slice(ui.indexOf('export function AreaChart'), ui.indexOf('// ── Heptagon emblem'));

  assert.doesNotMatch(areaChart, /preserveAspectRatio="none"/);
  assert.match(areaChart, /preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(areaChart, /strokeDasharray: var\(--len/);
  assert.doesNotMatch(areaChart, /className=\{animated \? 'chart-line'/);
  assert.match(areaChart, /<polyline/);
});
