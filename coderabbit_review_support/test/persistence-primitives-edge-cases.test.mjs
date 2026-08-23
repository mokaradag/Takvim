import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrderedMutationQueue,
  createPersistenceChangeSet,
  createTaskPatchCoalescer,
  isEmptyChangeSet
} from '../src/state/persistence.js';

function emptyChanges() {
  return { taskUpserts: [], taskDeletes: [], wbsUpserts: [], wbsDeletes: [] };
}

test('createPersistenceChangeSet is empty when canonical entity references are unchanged', () => {
  const task = { id: 't1', task: 'One' };
  const node = { id: 'w1', name: 'Root' };
  const before = { tasks: [task], wbs: [node] };
  const after = { tasks: [task], wbs: [node] };
  assert.deepEqual(createPersistenceChangeSet(before, after), emptyChanges());
});

test('createPersistenceChangeSet treats a replaced task object as an upsert', () => {
  const before = { tasks: [{ id: 't1', task: 'One' }], wbs: [] };
  const updated = { id: 't1', task: 'Updated' };
  const after = { tasks: [updated], wbs: [] };
  assert.deepEqual(createPersistenceChangeSet(before, after), {
    taskUpserts: [updated],
    taskDeletes: [],
    wbsUpserts: [],
    wbsDeletes: []
  });
});

test('createPersistenceChangeSet treats structurally equal cloned entities as changed identities', () => {
  const before = { tasks: [{ id: 't1', task: 'One' }], wbs: [] };
  const cloned = { id: 't1', task: 'One' };
  const changes = createPersistenceChangeSet(before, { tasks: [cloned], wbs: [] });
  assert.deepEqual(changes.taskUpserts, [cloned]);
});

test('createPersistenceChangeSet detects added and deleted tasks in the same transition', () => {
  const before = { tasks: [{ id: 'old' }, { id: 'keep' }], wbs: [] };
  const keep = before.tasks[1];
  const added = { id: 'new' };
  const changes = createPersistenceChangeSet(before, { tasks: [added, keep], wbs: [] });
  assert.deepEqual(changes.taskUpserts, [added]);
  assert.deepEqual(changes.taskDeletes, ['old']);
});

test('createPersistenceChangeSet detects WBS updates, additions, and deletions', () => {
  const root = { id: 'root', name: 'Root' };
  const removed = { id: 'removed', name: 'Removed' };
  const renamed = { id: 'root', name: 'Renamed' };
  const added = { id: 'added', name: 'Added' };
  const changes = createPersistenceChangeSet(
    { tasks: [], wbs: [root, removed] },
    { tasks: [], wbs: [renamed, added] }
  );
  assert.deepEqual(changes.wbsUpserts, [renamed, added]);
  assert.deepEqual(changes.wbsDeletes, ['removed']);
});

test('createPersistenceChangeSet safely defaults missing collections to empty arrays', () => {
  assert.deepEqual(createPersistenceChangeSet({}, {}), emptyChanges());
  assert.deepEqual(createPersistenceChangeSet({}, { tasks: [{ id: 't1' }] }), {
    taskUpserts: [{ id: 't1' }],
    taskDeletes: [],
    wbsUpserts: [],
    wbsDeletes: []
  });
});

test('isEmptyChangeSet returns true only when every canonical bucket is empty', () => {
  assert.equal(isEmptyChangeSet(emptyChanges()), true);
  for (const field of ['taskUpserts', 'taskDeletes', 'wbsUpserts', 'wbsDeletes']) {
    const changes = emptyChanges();
    changes[field] = [{}];
    assert.equal(isEmptyChangeSet(changes), false, field);
  }
});

test('ordered mutation queue executes jobs strictly in enqueue order', async () => {
  const queue = createOrderedMutationQueue();
  const events = [];
  let releaseFirst;

  const first = queue.enqueue(async () => {
    events.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:end');
    return 'first';
  });
  const second = queue.enqueue(async () => {
    events.push('second:start');
    events.push('second:end');
    return 'second';
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('ordered mutation queue continues with later jobs after an earlier rejection', async () => {
  const queue = createOrderedMutationQueue();
  const events = [];
  const failure = new Error('first failed');

  const first = queue.enqueue(async () => {
    events.push('first');
    throw failure;
  });
  const second = queue.enqueue(async () => {
    events.push('second');
    return 2;
  });

  await assert.rejects(first, (error) => error === failure);
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'second']);
});

test('ordered mutation queue also continues after a synchronous throw', async () => {
  const queue = createOrderedMutationQueue();
  const first = queue.enqueue(() => { throw new Error('sync failure'); });
  const second = queue.enqueue(() => 'recovered');
  await assert.rejects(first, /sync failure/);
  assert.equal(await second, 'recovered');
});

test('ordered mutation queue whenIdle waits for currently queued work', async () => {
  const queue = createOrderedMutationQueue();
  let release;
  let settled = false;

  queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const idle = queue.whenIdle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await idle;
  assert.equal(settled, true);
});

test('ordered mutation queue whenIdle resolves even when queued work rejects', async () => {
  const queue = createOrderedMutationQueue();
  const failed = queue.enqueue(async () => { throw new Error('failure'); });
  await assert.rejects(failed, /failure/);
  await assert.doesNotReject(queue.whenIdle());
});

test('task patch coalescer merges pending patches for the same task', async () => {
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    calls.push({ taskId, patch });
    return { ok: true, value: patch };
  }, { delayMs: 1000 });

  const first = coalescer.schedule('t1', { task: 'First', progress: 10 });
  const second = coalescer.schedule('t1', { task: 'Latest', description: 'Note' });
  const flushed = await coalescer.flush('t1');

  assert.deepEqual(calls, [{
    taskId: 't1',
    patch: { task: 'Latest', progress: 10, description: 'Note' }
  }]);
  assert.deepEqual(flushed, { ok: true, value: { task: 'Latest', progress: 10, description: 'Note' } });
  assert.deepEqual(await first, flushed);
  assert.deepEqual(await second, flushed);
});

test('task patch coalescer resolves all same-task waiters with the exact same flush result', async () => {
  const result = { ok: true, value: { saved: true } };
  const coalescer = createTaskPatchCoalescer(async () => result, { delayMs: 1000 });
  const first = coalescer.schedule('t1', { task: 'A' });
  const second = coalescer.schedule('t1', { progress: 20 });
  await coalescer.flush('t1');
  assert.strictEqual(await first, result);
  assert.strictEqual(await second, result);
});

test('task patch coalescer keeps different task IDs in independent pending buckets', async () => {
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    calls.push({ taskId, patch });
    return { ok: true, value: taskId };
  }, { delayMs: 1000 });

  const first = coalescer.schedule('t1', { progress: 10 });
  const second = coalescer.schedule('t2', { progress: 20 });
  const results = await coalescer.flushAll();

  assert.deepEqual(calls, [
    { taskId: 't1', patch: { progress: 10 } },
    { taskId: 't2', patch: { progress: 20 } }
  ]);
  assert.deepEqual(results, [
    { ok: true, value: 't1' },
    { ok: true, value: 't2' }
  ]);
  assert.deepEqual(await first, results[0]);
  assert.deepEqual(await second, results[1]);
});

test('task patch coalescer flush returns a successful no-op for a task with no pending patch', async () => {
  let calls = 0;
  const coalescer = createTaskPatchCoalescer(async () => { calls += 1; }, { delayMs: 1000 });
  assert.deepEqual(await coalescer.flush('missing'), { ok: true, value: null });
  assert.equal(calls, 0);
});

test('task patch coalescer flushAll returns an empty result when nothing is pending', async () => {
  const coalescer = createTaskPatchCoalescer(async () => ({ ok: true }), { delayMs: 1000 });
  assert.deepEqual(await coalescer.flushAll(), []);
});

test('task patch coalescer converts thrown persistence failures into a stable error result', async () => {
  const coalescer = createTaskPatchCoalescer(async () => {
    throw new Error('repository unavailable');
  }, { delayMs: 1000 });

  const scheduled = coalescer.schedule('t1', { task: 'Unsaved' });
  const result = await coalescer.flush('t1');

  assert.deepEqual(result, {
    ok: false,
    error: {
      kind: 'persistence',
      code: 'MUTATION_FAILED',
      message: 'Değişiklik kaydedilemedi.',
      operation: 'task/update',
      details: null
    }
  });
  assert.deepEqual(await scheduled, result);
});

test('task patch coalescer can accept a fresh patch after a previous manual flush', async () => {
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    calls.push({ taskId, patch });
    return { ok: true, value: calls.length };
  }, { delayMs: 1000 });

  const first = coalescer.schedule('t1', { task: 'First' });
  await coalescer.flush('t1');
  await first;

  const second = coalescer.schedule('t1', { task: 'Second' });
  await coalescer.flush('t1');
  await second;

  assert.deepEqual(calls, [
    { taskId: 't1', patch: { task: 'First' } },
    { taskId: 't1', patch: { task: 'Second' } }
  ]);
});
