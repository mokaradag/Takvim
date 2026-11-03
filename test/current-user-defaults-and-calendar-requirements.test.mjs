import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNewTask } from '../src/state/appState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function taskState(overrides = {}) {
  return {
    session: { dataMode: 'demo' },
    currentUser: null,
    workspaceMode: 'project',
    selectedProjectId: 'project-1',
    projects: [{
      id: 'project-1',
      name: 'Test Project',
      color: 'blue',
      calendarId: 'calendar-1'
    }],
    calendars: [{
      id: 'calendar-1',
      name: 'Standard',
      timezone: 'Europe/Istanbul',
      workingDays: [1, 2, 3, 4, 5],
      holidays: []
    }],
    wbs: [{
      id: 'wbs-root',
      projectId: 'project-1',
      parentId: null,
      code: '1',
      name: 'Test Project',
      sortOrder: 1
    }],
    people: [
      { id: '100', employeeNo: '100', name: 'Alphabetical First' },
      { id: '200', employeeNo: '200', name: 'Trusted Current User' }
    ],
    tasks: [],
    ...overrides
  };
}

test("gerçek kip yeni görevde ilk dizin kişisi yerine güvenilir kullanıcıyı atar", () => {
  const state = taskState({
    session: { dataMode: 'actual' },
    currentUser: { id: '200', employeeNo: '200', name: 'Trusted Current User' }
  });

  const task = createNewTask(state, '2026-07-24', 'task-actual');

  assert.deepEqual(task.assigneeIds, ['200']);
  assert.deepEqual(task.sorumlu, ['Trusted Current User']);
});

test("güvenilir kimlik yokken gerçek kip yeni görevi atanmamış bırakır", () => {
  const state = taskState({ session: { dataMode: 'actual' }, currentUser: null });

  const task = createNewTask(state, '2026-07-24', 'task-unassigned');

  assert.deepEqual(task.assigneeIds, []);
  assert.deepEqual(task.sorumlu, []);
});

test("demo kip yeni görevde örnek kişi varsayılanını korur", () => {
  const task = createNewTask(taskState(), '2026-07-24', 'task-demo');

  assert.deepEqual(task.assigneeIds, ['100']);
  assert.deepEqual(task.sorumlu, ['Alphabetical First']);
});

test("güçlendirilmiş proje yazımı takvim ister; görev değişimi isteğe bağlı kalır", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');

  assert.match(source, /for \(const project of changes\.projectUpserts\) \{\s+if \(!project\.calendarId\) \{\s+throw new ServerPersistenceError\('MUTATION_FAILED', 'Proje için etkin bir çalışma takvimi seçilmelidir\.'\);/);
  assert.match(source, /calendarIds\.add\(uuid\(project\.calendarId, 'Takvim kimliği'\)\);/);
  assert.match(source, /for \(const task of changes\.taskUpserts\) \{\s+if \(task\.calendarId\) calendarIds\.add\(uuid\(task\.calendarId, 'Takvim kimliği'\)\);\s+\}/);
});
