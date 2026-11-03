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

test("kanonik varlık başvurusu değişmezse createPersistenceChangeSet boştur", () => {
  const task = { id: 't1', task: 'One' };
  const node = { id: 'w1', name: 'Root' };
  const before = { tasks: [task], wbs: [node] };
  const after = { tasks: [task], wbs: [node] };
  assert.deepEqual(createPersistenceChangeSet(before, after), emptyChanges());
});

test("createPersistenceChangeSet değiştirilmiş görev nesnesini güncelleme sayar", () => {
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

test("createPersistenceChangeSet yapısal eşit kopyayı değişmiş kimlik sayar", () => {
  const before = { tasks: [{ id: 't1', task: 'One' }], wbs: [] };
  const cloned = { id: 't1', task: 'One' };
  const changes = createPersistenceChangeSet(before, { tasks: [cloned], wbs: [] });
  assert.deepEqual(changes.taskUpserts, [cloned]);
});

test("createPersistenceChangeSet aynı geçişte eklenen ve silinen görevi bulur", () => {
  const before = { tasks: [{ id: 'old' }, { id: 'keep' }], wbs: [] };
  const keep = before.tasks[1];
  const added = { id: 'new' };
  const changes = createPersistenceChangeSet(before, { tasks: [added, keep], wbs: [] });
  assert.deepEqual(changes.taskUpserts, [added]);
  assert.deepEqual(changes.taskDeletes, ['old']);
});

test("createPersistenceChangeSet WBS güncelleme ekleme ve silmesini bulur", () => {
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

test("createPersistenceChangeSet eksik koleksiyonu güvenle boş dizi varsayar", () => {
  assert.deepEqual(createPersistenceChangeSet({}, {}), emptyChanges());
  assert.deepEqual(createPersistenceChangeSet({}, { tasks: [{ id: 't1' }] }), {
    taskUpserts: [{ id: 't1' }],
    taskDeletes: [],
    wbsUpserts: [],
    wbsDeletes: []
  });
});

test("isEmptyChangeSet yalnızca bütün kanonik kovalar boşsa doğru döner", () => {
  assert.equal(isEmptyChangeSet(emptyChanges()), true);
  for (const field of ['taskUpserts', 'taskDeletes', 'wbsUpserts', 'wbsDeletes']) {
    const changes = emptyChanges();
    changes[field] = [{}];
    assert.equal(isEmptyChangeSet(changes), false, field);
  }
});

test("sıralı değişim kuyruğu işi tam eklenme sırasıyla yürütür", async () => {
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

test("sıralı değişim kuyruğu eski ret sonrası sonraki işlerle sürer", async () => {
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

test("sıralı değişim kuyruğu eşzamanlı istisnadan sonra da sürer", async () => {
  const queue = createOrderedMutationQueue();
  const first = queue.enqueue(() => { throw new Error('sync failure'); });
  const second = queue.enqueue(() => 'recovered');
  await assert.rejects(first, /sync failure/);
  assert.equal(await second, 'recovered');
});

test("sıralı kuyruğun whenIdle işlevi mevcut işleri bekler", async () => {
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

test("sıralı kuyruğun whenIdle işlevi iş reddedilse de sonuçlanır", async () => {
  const queue = createOrderedMutationQueue();
  const failed = queue.enqueue(async () => { throw new Error('failure'); });
  await assert.rejects(failed, /failure/);
  await assert.doesNotReject(queue.whenIdle());
});

test("görev yama birleştiricisi aynı görevin bekleyen yamalarını birleştirir", async () => {
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

test("görev yama birleştiricisi aynı görev bekleyicilerini tam aynı sonuçla tamamlar", async () => {
  const result = { ok: true, value: { saved: true } };
  const coalescer = createTaskPatchCoalescer(async () => result, { delayMs: 1000 });
  const first = coalescer.schedule('t1', { task: 'A' });
  const second = coalescer.schedule('t1', { progress: 20 });
  await coalescer.flush('t1');
  assert.strictEqual(await first, result);
  assert.strictEqual(await second, result);
});

test("görev yama birleştiricisi farklı kimlikleri bağımsız kovada tutar", async () => {
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

test("görev yama boşaltması bekleyen yama yoksa başarılı değişimsiz sonuç verir", async () => {
  let calls = 0;
  const coalescer = createTaskPatchCoalescer(async () => { calls += 1; }, { delayMs: 1000 });
  assert.deepEqual(await coalescer.flush('missing'), { ok: true, value: null });
  assert.equal(calls, 0);
});

test("bütün yamaları boşaltma bekleyen yoksa boş sonuç verir", async () => {
  const coalescer = createTaskPatchCoalescer(async () => ({ ok: true }), { delayMs: 1000 });
  assert.deepEqual(await coalescer.flushAll(), []);
});

test("görev yama birleştiricisi atılan kalıcılık hatasını kararlı hata sonucuna çevirir", async () => {
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

test("görev yama birleştiricisi elle boşaltmadan sonra yeni yama kabul eder", async () => {
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
