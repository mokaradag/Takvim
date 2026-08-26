import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { appStateReducer, createInitialState } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import {
  clearCompletedClosingTaskId,
  closeTaskWithPendingUpdates,
  createTaskUpdateTracker,
  reconcileTaskDraft,
  taskDraftValuesEqual
} from '../src/features/task-detail/taskDraft.js';

async function createHarness(repository = createMockRepository(), options = {}) {
  let state = createInitialState(await repository.loadSnapshot());
  const applyStateAction = (action) => {
    state = appStateReducer(state, action);
    return state;
  };
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction,
    taskPatchDelayMs: options.taskPatchDelayMs ?? 5,
    now: () => '2026-07-22T12:00:00.000Z'
  });
  return {
    repository,
    persistence,
    get state() { return state; },
    applyStateAction
  };
}

test('Task Detail draft equality handles nested arrays and dependency objects', () => {
  const left = [{ id: 't2', type: 'FS', lag: 2 }, { id: 't3', type: 'SS' }];
  const same = [{ id: 't2', type: 'FS', lag: 2 }, { id: 't3', type: 'SS' }];
  const changed = [{ id: 't2', type: 'FS', lag: 3 }, { id: 't3', type: 'SS' }];

  assert.equal(taskDraftValuesEqual(left, same), true);
  assert.equal(taskDraftValuesEqual(left, changed), false);
});

test('newer dirty Task Detail fields survive an older canonical acknowledgement', () => {
  const canonical = { id: 't1', task: 'A', status: 'done', description: 'Sunucudan' };
  const local = { id: 't1', task: 'AB', status: 'todo', description: 'Yerel' };
  const result = reconcileTaskDraft(canonical, local, new Set(['task']));

  assert.equal(result.task.task, 'AB');
  assert.equal(result.task.status, 'done');
  assert.equal(result.task.description, 'Sunucudan');
  assert.deepEqual([...result.dirtyFields], ['task']);
});

test('dirty Task Detail fields clear only after canonical data catches up', () => {
  const local = {
    id: 't1',
    task: 'Yeni başlık',
    deps: [{ id: 't2', type: 'FS' }]
  };
  const result = reconcileTaskDraft(
    {
      id: 't1',
      task: 'Yeni başlık',
      deps: [{ id: 't2', type: 'FS' }]
    },
    local,
    new Set(['task', 'deps'])
  );

  assert.equal(result.dirtyFields.size, 0);
  assert.equal(result.task.task, 'Yeni başlık');
  assert.deepEqual(result.task.deps, [{ id: 't2', type: 'FS' }]);
});

test('Task Detail update tracker waits for an in-flight save before allowing close', async () => {
  const tracker = createTaskUpdateTracker();
  let release;
  const save = new Promise((resolve) => { release = resolve; });
  tracker.track(save);

  let settled = false;
  const closeCheck = tracker.waitForIdle().then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(tracker.getPendingCount(), 1);

  release({ ok: true, value: null });
  const result = await closeCheck;
  assert.equal(result.ok, true);
  assert.equal(tracker.getPendingCount(), 0);
});

test('Task Detail close starts immediately and still reports a failed pending save', async () => {
  const tracker = createTaskUpdateTracker();
  let releaseSave;
  const save = new Promise((resolve) => { releaseSave = resolve; });
  tracker.track(save);
  let closeStarted = false;

  const closing = closeTaskWithPendingUpdates(tracker, async () => {
    closeStarted = true;
    return { ok: true, value: 'closed' };
  });

  assert.equal(closeStarted, true, 'kapanış bekleyen kayıtla eşzamanlı başlar');
  const failure = { ok: false, error: { code: 'MUTATION_FAILED' } };
  releaseSave(failure);
  assert.deepEqual(await closing, failure);
});

test('an older Task Detail close cannot clear the saving state of a newer task', () => {
  assert.equal(clearCompletedClosingTaskId('task-2', 'task-1'), 'task-2');
  assert.equal(clearCompletedClosingTaskId('task-2', 'task-2'), null);
});

test('Task Detail update tracker remembers a failure even after the failed save settles', async () => {
  const tracker = createTaskUpdateTracker();
  const failed = {
    ok: false,
    error: { kind: 'persistence', code: 'MUTATION_FAILED', operation: 'task/update' }
  };

  await tracker.track(Promise.resolve(failed));
  assert.equal(tracker.getPendingCount(), 0);
  assert.equal((await tracker.waitForIdle()).ok, false);
  assert.deepEqual(tracker.getFailure(), failed);

  tracker.clearFailure();
  assert.equal((await tracker.waitForIdle()).ok, true);
});

test('Task Detail update tracker keeps an earlier failure sticky across a later successful save', async () => {
  const tracker = createTaskUpdateTracker();
  const failed = {
    ok: false,
    error: { kind: 'persistence', code: 'MUTATION_FAILED', operation: 'task/update' }
  };

  await tracker.track(Promise.resolve(failed));
  await tracker.track(Promise.resolve({ ok: true, value: { taskUpserts: [] } }));

  const result = await tracker.waitForIdle();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MUTATION_FAILED');
});

test('Task Detail update tracker also waits for work added while a close wait is already running', async () => {
  const tracker = createTaskUpdateTracker();
  let releaseFirst;
  let releaseSecond;
  tracker.track(new Promise((resolve) => { releaseFirst = resolve; }));

  const waiting = tracker.waitForIdle();
  tracker.track(new Promise((resolve) => { releaseSecond = resolve; }));
  releaseFirst({ ok: true, value: null });
  await Promise.resolve();
  assert.equal(tracker.getPendingCount(), 1);

  releaseSecond({ ok: true, value: null });
  assert.equal((await waiting).ok, true);
});

test('persistence reducer keeps an earlier save error through later start and success actions', async () => {
  const repository = createMockRepository();
  let state = createInitialState(await repository.loadSnapshot());
  const error = {
    code: 'MUTATION_FAILED',
    message: 'İlk değişiklik kaydedilemedi.',
    operation: 'task/update',
    details: null
  };

  state = appStateReducer(state, { type: 'persistence/start', operation: 'task/update' });
  state = appStateReducer(state, { type: 'persistence/failure', error });
  assert.deepEqual(state.saveError, error);

  state = appStateReducer(state, { type: 'persistence/start', operation: 'task/update' });
  assert.deepEqual(state.saveError, error);
  assert.equal(state.pendingMutationCount, 1);

  state = appStateReducer(state, {
    type: 'persistence/success',
    changes: {},
    savedAt: '2026-07-22T12:00:00.000Z'
  });
  assert.deepEqual(state.saveError, error);
  assert.equal(state.pendingMutationCount, 0);

  state = appStateReducer(state, { type: 'persistence/clear-error' });
  assert.equal(state.saveError, null);
});

test('a failed coalesced Task edit is retained and retried with the following edit', async () => {
  const memory = createMockRepository();
  let commitCount = 0;
  const repository = {
    loadSnapshot: () => memory.loadSnapshot(),
    async commitChanges(changes) {
      commitCount += 1;
      if (commitCount === 1) throw new Error('first queued save fails');
      return memory.commitChanges(changes);
    }
  };
  const harness = await createHarness(repository);
  const before = structuredClone(harness.state.tasks.find((task) => task.id === 't1'));

  const first = harness.persistence.updateTask('t1', { status: 'done' });
  const [firstResult] = await Promise.all([
    first,
    harness.persistence.flushTaskUpdates(['t1'])
  ]);

  assert.equal(firstResult.ok, false);
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').status, before.status);

  const second = harness.persistence.updateTask('t1', { targetFinish: '2026-12-31' });
  const [secondResult] = await Promise.all([
    second,
    harness.persistence.flushTaskUpdates(['t1'])
  ]);

  assert.equal(secondResult.ok, true);
  assert.equal(commitCount, 2);
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').status, 'done');
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').targetFinish, '2026-12-31');
  assert.equal(harness.state.saveError.code, 'MUTATION_FAILED');
});

test('an in-flight failed Task patch is merged under a newer pending patch', async () => {
  const memory = createMockRepository();
  let commitCount = 0;
  const committedChanges = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const repository = {
    loadSnapshot: () => memory.loadSnapshot(),
    async commitChanges(changes) {
      commitCount += 1;
      committedChanges.push(changes);
      if (commitCount === 1) {
        markFirstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
        throw new Error('first in-flight save fails');
      }
      return memory.commitChanges(changes);
    }
  };
  const harness = await createHarness(repository, { taskPatchDelayMs: 60_000 });

  const first = harness.persistence.updateTask('t1', { status: 'done' });
  const firstFlush = harness.persistence.flushTaskUpdates(['t1']);
  await firstStarted;
  const newer = harness.persistence.updateTask('t1', { targetFinish: '2026-12-31' });
  const forcedFlush = harness.persistence.flushTaskUpdates(['t1']);
  releaseFirst();
  const [[firstFlushResult], [forcedFlushResult], firstResult, newerResult] = await Promise.all([
    firstFlush,
    forcedFlush,
    first,
    newer
  ]);
  assert.equal(firstFlushResult.ok, false);
  assert.equal(forcedFlushResult.ok, true);
  assert.equal(firstResult.ok, false);
  assert.equal(newerResult.ok, true);
  assert.equal(commitCount, 2);
  assert.equal(committedChanges[1].taskUpserts[0].status, 'done');
  assert.equal(committedChanges[1].taskUpserts[0].targetFinish, '2026-12-31');
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').status, 'done');
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').targetFinish, '2026-12-31');
  harness.persistence.dispose();
});

test('a failed coalesced Task save keeps the newer local draft available for retry', async () => {
  const canonicalAfterOlderSave = {
    id: 't1',
    task: 'Older saved value',
    description: 'Canonical note'
  };
  const newerLocalDraft = {
    id: 't1',
    task: 'Newest unsaved value',
    description: 'Local note'
  };
  const tracker = createTaskUpdateTracker();
  const failed = {
    ok: false,
    error: { kind: 'persistence', code: 'MUTATION_FAILED', operation: 'task/update' }
  };
  await tracker.track(Promise.resolve(failed));

  const reconciled = reconcileTaskDraft(
    canonicalAfterOlderSave,
    newerLocalDraft,
    new Set(['task', 'description'])
  );

  assert.equal(reconciled.task.task, 'Newest unsaved value');
  assert.equal(reconciled.task.description, 'Local note');
  assert.equal(reconciled.dirtyFields.size, 2);
  assert.equal((await tracker.waitForIdle()).ok, false);
});
