import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientEntityId } from '../src/data/clientEntityId.js';
import { toActualUuid } from '../src/data/api/createApiRepository.js';
import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { appStateReducer, createInitialState } from '../src/state/appState.js';
import { createPersistenceChangeSet, createStateMutationOrchestrator } from '../src/state/persistence.js';

function project(id, name, calendarId) {
  return { id, name, code: id.toUpperCase(), color: 'blue', calendarId, dataDate: '2026-07-24' };
}

function task(id, projectId, wbsId, title, deps = []) {
  return {
    id,
    projectId,
    wbsId,
    proje: projectId === 'p-2' ? 'Project Two' : 'Project One',
    task: title,
    description: '',
    keyword: '',
    status: 'todo',
    priority: 'normal',
    plannedStart: '2026-07-24',
    plannedFinish: '2026-07-24',
    targetFinish: '2026-07-24',
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: 1,
    assigneeIds: ['100'],
    sorumlu: ['Test User'],
    deps
  };
}

function seed({ includeOutgoingDependency = false } = {}) {
  const dependency = (predecessorId) => ({ id: predecessorId, predecessorId, type: 'FS', lagDays: 0 });
  return {
    calendars: [{ id: 'cal-1', name: 'Calendar', workingDays: [1, 2, 3, 4, 5], holidays: [] }],
    projects: [project('p-1', 'Project One', 'cal-1'), project('p-2', 'Project Two', 'cal-1')],
    people: [{ id: '100', employeeNo: '100', name: 'Test User' }],
    wbs: [
      { id: 'w-1', projectId: 'p-1', parentId: null, code: '1', name: 'Project One', sortOrder: 1 },
      { id: 'w-2', projectId: 'p-2', parentId: null, code: '2', name: 'Project Two', sortOrder: 1 }
    ],
    tasks: [
      task('task-1', 'p-1', 'w-1', 'Predecessor', includeOutgoingDependency ? [dependency('task-3')] : []),
      task('task-2', 'p-1', 'w-1', 'Successor', [dependency('task-1')]),
      task('task-3', 'p-1', 'w-1', 'Earlier task')
    ],
    baselines: [],
    taskBaselineSnapshots: []
  };
}

test('client entity ID fallback remains UUID-v4 compatible without crypto.randomUUID', () => {
  const cryptoProvider = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    }
  };

  const value = createClientEntityId('task', { cryptoProvider });
  assert.equal(value, 'task-00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.match(value, /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(toActualUuid(value), '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('stable flush persists a coalesced edit scheduled while an earlier mutation is in flight', async () => {
  let state = createInitialState(seed());
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const calls = [];
  const repository = {
    async commitChanges(changes) {
      calls.push(changes);
      if (calls.length === 1) {
        markFirstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return changes;
    }
  };
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) {
      state = appStateReducer(state, action);
      return state;
    },
    taskPatchDelayMs: 60_000,
    now: () => '2026-07-24T06:00:00.000Z'
  });

  const first = persistence.updateTask('task-1', { priority: 'high' });
  await firstStarted;
  const draining = persistence.flush();
  const late = persistence.updateTask('task-1', { description: 'late edit' });
  releaseFirst();

  const [firstResult, flushResult, lateResult] = await Promise.all([first, draining, late]);
  assert.equal(firstResult.ok, true);
  assert.equal(flushResult.ok, true);
  assert.equal(lateResult.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].taskUpserts[0].description, 'late edit');
  assert.equal(state.tasks.find((item) => item.id === 'task-1').description, 'late edit');
  persistence.dispose();
});

test('task deletion removes incoming dependencies and persists successor reconciliation atomically', () => {
  const before = createInitialState(seed());
  const after = appStateReducer(before, { type: 'task/delete', id: 'task-1' });
  const successor = after.tasks.find((item) => item.id === 'task-2');
  const changes = createPersistenceChangeSet(before, after);

  assert.deepEqual(successor.deps, []);
  assert.deepEqual(changes.taskDeletes, ['task-1']);
  assert.deepEqual(changes.taskUpserts.map((item) => item.id), ['task-2']);
  assert.deepEqual(changes.taskUpserts[0].deps, []);
});

test('moving a task across projects clears both outgoing and incoming dependencies', () => {
  const before = createInitialState(seed({ includeOutgoingDependency: true }));
  const after = appStateReducer(before, {
    type: 'task/update',
    id: 'task-1',
    patch: { projectId: 'p-2', wbsId: 'w-2' }
  });
  const moved = after.tasks.find((item) => item.id === 'task-1');
  const successor = after.tasks.find((item) => item.id === 'task-2');
  const changes = createPersistenceChangeSet(before, after);

  assert.equal(moved.projectId, 'p-2');
  assert.equal(moved.wbsId, 'w-2');
  assert.deepEqual(moved.deps, []);
  assert.deepEqual(successor.deps, []);
  assert.deepEqual(new Set(changes.taskUpserts.map((item) => item.id)), new Set(['task-1', 'task-2']));
});

test('Demo repository returns and reloads dependency reconciliation after direct deletion', async () => {
  const repository = createMockRepository(seed());
  const committed = await repository.commitChanges({
    taskUpserts: [],
    taskDeletes: ['task-1'],
    wbsUpserts: [],
    wbsDeletes: []
  });
  const successor = committed.taskUpserts.find((item) => item.id === 'task-2');
  const reloaded = await repository.loadSnapshot();

  assert.ok(successor);
  assert.deepEqual(successor.deps, []);
  assert.equal(reloaded.tasks.some((item) => item.id === 'task-1'), false);
  assert.deepEqual(reloaded.tasks.find((item) => item.id === 'task-2').deps, []);
});
