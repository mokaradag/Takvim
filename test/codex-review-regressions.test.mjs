import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';
import { normalizeTaskScheduleFields } from '../src/domain/validation/index.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import {
  prepareProjectCreation,
  prepareProjectUpdate,
  validateProjectCreationInput
} from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function projectContext(overrides = {}) {
  const base = {
    calendars: [{ id: 'cal-1', name: 'Kurumsal Takvim', workingDays: [1, 2, 3, 4, 5], holidays: [] }],
    projects: [{
      id: 'p-1', code: 'PRJ-INFRA', name: 'Altyapı', source: 'corporate', color: 'blue',
      leadId: 'u-1', lead: 'Ada', calendarId: 'cal-1', dataDate: null, tags: ['Analiz']
    }],
    people: [{ id: 'u-1', employeeNo: '1001', name: 'Ada' }],
    wbs: [{ id: 'w-1', projectId: 'p-1', parentId: null, code: '1', name: 'Altyapı', sortOrder: 1 }],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
  return { ...base, ...overrides };
}

test('project codes use locale-insensitive identifier casing and duplicate detection', () => {
  const context = projectContext();
  const issues = validateProjectCreationInput({
    code: 'prj-infra',
    name: 'Başka Proje',
    leadId: 'u-1',
    calendarId: 'cal-1',
    dataDate: '2026-07-22',
    color: 'blue'
  }, context);
  assert.ok(issues.some((issue) => issue.code === 'PROJECT_CODE_DUPLICATE'));

  const created = prepareProjectCreation({
    code: 'prj-infra',
    name: 'Yeni Proje',
    leadId: 'u-1',
    calendarId: 'cal-1',
    dataDate: '2026-07-22',
    color: 'cyan'
  }, { ...context, projects: [], wbs: [] }, { projectId: 'p-new', rootWbsId: 'w-new' });
  assert.equal(created.ok, true);
  assert.equal(created.project.code, 'PRJ-INFRA');
  assert.equal(created.project.code.includes('İ'), false);
});

test('tag-only project updates preserve a missing data date instead of inventing today', () => {
  const context = projectContext();
  const updated = prepareProjectUpdate('p-1', { tags: ['Analiz', 'Teslim'] }, context);

  assert.equal(updated.ok, true);
  assert.equal(updated.project.dataDate, null);
  assert.equal(updated.project.leadId, 'u-1');
  assert.equal(updated.project.color, 'blue');
  assert.deepEqual(updated.project.tags.map((tag) => tag.name), ['Analiz', 'Teslim']);
});

test('a failed one-step task creation does not leave a placeholder task behind', async () => {
  const context = projectContext();
  const repository = createMockRepository(context, {
    failMutation: ({ changes }) => Boolean(changes.taskUpserts?.length)
  });
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction: (action) => {
      state = appStateReducer(state, action);
      return state;
    },
    now: () => '2026-07-22T12:00:00.000Z'
  });

  const result = await persistence.mutate('task/create', {
    type: 'task/add',
    task: {
      id: 't-new', projectId: 'p-1', projectCode: 'PRJ-INFRA', proje: 'Altyapı', color: 'blue',
      wbsId: null, task: 'Tek adımda oluştur', keyword: 'Teslim', assigneeIds: ['u-1'], sorumlu: ['Ada'],
      status: 'todo', priority: 'medium', progress: 0,
      plannedStart: '2026-07-30', plannedFinish: '2026-07-30', targetFinish: '2026-07-30', deps: []
    }
  });

  assert.equal(result.ok, false);
  assert.equal(state.tasks.some((task) => task.id === 't-new'), false);
  const reloaded = await repository.loadSnapshot();
  assert.equal(reloaded.tasks.some((task) => task.id === 't-new'), false);
  persistence.dispose();
});

test('simple-mode task input preserves selected IDs and the selected project color', () => {
  const context = projectContext({
    projects: [
      ...projectContext().projects,
      { id: 'p-2', code: 'PRJ-2', name: 'İkinci', source: 'manual', color: 'rose', leadId: 'u-2', calendarId: 'cal-1', dataDate: '2026-07-22' }
    ],
    people: [
      { id: 'u-1', employeeNo: '1001', name: 'Ada' },
      { id: 'u-2', employeeNo: '1002', name: 'Ada' }
    ],
    wbs: [
      ...projectContext().wbs,
      { id: 'w-2', projectId: 'p-2', parentId: null, code: '2', name: 'İkinci', sortOrder: 1 }
    ]
  });
  const normalized = normalizeTaskRecord({
    id: 't-2', projectId: 'p-2', projectCode: 'PRJ-2', proje: 'İkinci', color: 'rose',
    wbsId: null, task: 'Görev', keyword: 'Teslim', assigneeIds: ['u-2'], sorumlu: ['Ada'],
    status: 'todo', plannedStart: '2026-07-30', plannedFinish: '2026-07-30', targetFinish: '2026-07-30', deps: []
  }, context);

  assert.deepEqual(normalized.assigneeIds, ['u-2']);
  assert.equal(normalized.projectId, 'p-2');
  assert.equal(normalized.color, 'rose');
  assert.equal(normalized.wbsId, 'w-2');
});

test('simple mode creates the final task in one guarded mutation and keeps project metadata intact', () => {
  const simple = read('src/features/simple/SimpleModePanel.jsx');
  const provider = read('src/state/AppStateProvider.jsx');

  assert.doesNotMatch(simple, /updateTask/);
  // Hızlı giriş etiketi kataloğa kanonik üçlü olarak ekler (ad + varsayılan renk/simge).
  assert.match(simple, /updateProject\(project\.id, \{ tags: \[\.\.\.tags, \{ name: keyword\.trim\(\) \}\] \}\)/);
  assert.match(simple, /const createdTask = await addTask\(\{/);
  assert.match(simple, /projectId: project\.id/);
  assert.match(simple, /color: project\.color \|\| 'blue'/);
  assert.match(simple, /assigneeIds: \[\.\.\.assigneeIds\]/);
  assert.match(provider, /const addTask = useCallback\(async \(input = null\)/);
  assert.match(provider, /const project = resolveTaskCreationProject\(current, input\?\.projectId\)/);
  assert.match(provider, /const result = await persistence\.mutate\('task\/create', \(\) => \{/);
  assert.match(provider, /task:\s*\{\s*\.\.\.baseTask,\s*\.\.\.taskInput,\s*id,\s*projectId: project\.id/s);
});

test('clearing a date propagates an empty value that task normalization stores as null', () => {
  const dateInput = read('src/components/DateInput.jsx');
  assert.match(dateInput, /else onChange\?\.\(''\)/);

  const normalized = normalizeTaskScheduleFields({
    plannedStart: '',
    plannedFinish: '',
    targetFinish: ''
  });
  assert.equal(normalized.plannedStart, null);
  assert.equal(normalized.plannedFinish, null);
  assert.equal(normalized.targetFinish, null);
});

test('required date inputs restore their previous value instead of clearing form state', () => {
  const dateInput = read('src/components/DateInput.jsx');
  assert.match(dateInput, /if \(!allowEmpty\) setDraft\(fmtDisplayDate\(value\)\);\n\s+else onChange\?\.\(''\);/);
});
