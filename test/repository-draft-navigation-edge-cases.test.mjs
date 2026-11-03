import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppRepositoryError,
  REPOSITORY_ERROR_CODES,
  assertAppRepository,
  normalizeRepositoryError
} from '../src/data/contracts/appRepository.js';
import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import {
  createTaskUpdateTracker,
  reconcileTaskDraft,
  taskDraftValuesEqual
} from '../src/features/task-detail/taskDraft.js';
import { NAV_ITEMS, PAGE_META } from '../src/components/shell/navigation.js';

function seed() {
  return {
    calendars: [],
    projects: [{ id: 'p1', name: 'One' }],
    people: [],
    wbs: [
      { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 },
      { id: 'leaf', projectId: 'p1', parentId: 'root', code: '1.1', name: 'Leaf', sortOrder: 1 }
    ],
    tasks: [
      { id: 't1', projectId: 'p1', wbsId: 'leaf', task: 'One', status: 'todo', deps: [] },
      { id: 't2', projectId: 'p1', wbsId: 'leaf', task: 'Two', status: 'todo', deps: [] }
    ],
    baselines: [],
    taskBaselineSnapshots: []
  };
}

test("depo hata kodları donmuş ve kararlıdır", () => {
  assert.equal(Object.isFrozen(REPOSITORY_ERROR_CODES), true);
  assert.deepEqual(REPOSITORY_ERROR_CODES, {
    LOAD_FAILED: 'LOAD_FAILED',
    MUTATION_FAILED: 'MUTATION_FAILED',
    UNAUTHORIZED: 'UNAUTHORIZED',
    SESSION_REQUIRED: 'SESSION_REQUIRED',
    FORBIDDEN: 'FORBIDDEN',
    CONFLICT: 'CONFLICT',
    DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE'
  });
});

test("AppRepositoryError depo üstverisini ve Error anlamını sunar", () => {
  const cause = new Error('root cause');
  const error = new AppRepositoryError({
    code: 'X', message: 'Boom', operation: 'save', details: { id: 1 }, cause
  });
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'AppRepositoryError');
  assert.equal(error.message, 'Boom');
  assert.equal(error.code, 'X');
  assert.equal(error.operation, 'save');
  assert.deepEqual(error.details, { id: 1 });
  assert.strictEqual(error.cause, cause);
});

test("AppRepositoryError ayrıntıyı boş varsayar ve eksik nedeni eklemez", () => {
  const error = new AppRepositoryError({ code: 'X', message: 'Boom', operation: 'save' });
  assert.equal(error.details, null);
  assert.equal('cause' in error, false);
});

test("normalizeRepositoryError yapısal depo hatasını korur", () => {
  const error = new AppRepositoryError({
    code: 'LOAD_FAILED', message: 'Load', operation: 'loadSnapshot', details: { retry: true }
  });
  assert.deepEqual(normalizeRepositoryError(error), {
    code: 'LOAD_FAILED', message: 'Load', operation: 'loadSnapshot', details: { retry: true }
  });
});

test("normalizeRepositoryError genel hataya açık dönüş alanlarını uygular", () => {
  assert.deepEqual(normalizeRepositoryError(new Error('raw'), {
    code: 'CUSTOM', message: 'Friendly', operation: 'custom', details: { source: 'x' }
  }), {
    code: 'CUSTOM', message: 'Friendly', operation: 'custom', details: { source: 'x' }
  });
});

test("normalizeRepositoryError genel hataya değişim varsayılanını sağlar", () => {
  assert.deepEqual(normalizeRepositoryError(new Error('raw')), {
    code: 'MUTATION_FAILED',
    message: 'Değişiklik kaydedilemedi.',
    operation: 'unknown',
    details: null
  });
});

test("assertAppRepository geçerli depoyu değiştirmeden döndürür", () => {
  const repository = { loadSnapshot() {}, commitChanges() {} };
  assert.strictEqual(assertAppRepository(repository), repository);
});

for (const [name, repository] of [
  ['null repository', null],
  ['missing loadSnapshot', { commitChanges() {} }],
  ['missing commitChanges', { loadSnapshot() {} }],
  ['non-function loadSnapshot', { loadSnapshot: true, commitChanges() {} }],
  ['non-function commitChanges', { loadSnapshot() {}, commitChanges: true }]
]) {
  test(`assertAppRepository ${name} değerini reddeder`, () => {
    assert.throws(() => assertAppRepository(repository), /loadSnapshot\(\).*commitChanges\(\)/);
  });
}

test("sahte depo kendini asenkron bellek deposu diye tanımlar", () => {
  assert.equal(createMockRepository(seed()).kind, 'async-memory');
});

test("sahte depo loadSnapshot derin kopya döndürür", async () => {
  const repository = createMockRepository(seed());
  const first = await repository.loadSnapshot();
  first.tasks[0].task = 'Mutated outside';
  first.wbs.push({ id: 'outside' });
  const second = await repository.loadSnapshot();
  assert.equal(second.tasks[0].task, 'One');
  assert.equal(second.wbs.some((node) => node.id === 'outside'), false);
});

test("sahte depo özel başlangıç verisini kurulurken kopyalar", async () => {
  const original = seed();
  const repository = createMockRepository(original);
  original.tasks[0].task = 'Changed after construction';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, 'One');
});

test("sahte depo mevcut görevi yerinde günceller", async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskUpserts: [{ ...seed().tasks[0], task: 'Updated' }] });
  const loaded = await repository.loadSnapshot();
  assert.equal(loaded.tasks[0].id, 't1');
  assert.equal(loaded.tasks[0].task, 'Updated');
  assert.equal(result.taskUpserts[0].task, 'Updated');
});

test("sahte depo yeni görevi başa ekler", async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ taskUpserts: [{ id: 't3', task: 'Three' }] });
  assert.deepEqual((await repository.loadSnapshot()).tasks.map((task) => task.id), ['t3', 't1', 't2']);
});

test("sahte depo görev siler", async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ taskDeletes: ['t1'] });
  assert.deepEqual((await repository.loadSnapshot()).tasks.map((task) => task.id), ['t2']);
});

test("sahte depo sonuçtaki silme kimliklerini tekilleştirir", async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskDeletes: ['t1', 't1', 't2'] });
  assert.deepEqual(result.taskDeletes, ['t1', 't2']);
});

test("sahte depo aynı görevi güncelleyip silen değişimi reddeder", async () => {
  // Eskiden silme kazanıyor, ekleme sessizce düşüyor ve çağrı yine de başarıyla
  // çözülüyordu: istemci durumu ile depo anlık görüntüsü ayrışıyordu.
  const repository = createMockRepository(seed());
  await assert.rejects(
    () => repository.commitChanges({
      taskUpserts: [{ ...seed().tasks[0], task: 'Should not survive' }],
      taskDeletes: ['t1']
    }),
    (error) => error.code === 'MUTATION_FAILED' && /hem güncellenip hem silinemez/.test(error.message)
  );
  // Reddedilen küme anlık görüntüyü DEĞİŞTİRMEZ.
  assert.equal((await repository.loadSnapshot()).tasks.some((task) => task.id === 't1'), true);
});

test("sahte depo aynı yeni görevi ekleyip silen değişimi reddeder", async () => {
  const repository = createMockRepository(seed());
  await assert.rejects(
    () => repository.commitChanges({ taskUpserts: [{ id: 't3', task: 'Three' }], taskDeletes: ['t3'] }),
    (error) => error.code === 'MUTATION_FAILED'
  );
  assert.equal((await repository.loadSnapshot()).tasks.some((task) => task.id === 't3'), false);
});

test("sahte depo mevcut WBS düğümünü koleksiyon sırasını bozmadan günceller", async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ wbsUpserts: [{ ...seed().wbs[1], name: 'Renamed' }] });
  const loaded = await repository.loadSnapshot();
  assert.deepEqual(loaded.wbs.map((node) => node.id), ['root', 'leaf']);
  assert.equal(loaded.wbs[1].name, 'Renamed');
});

test("sahte depo yeni WBS düğümünü sona ekler", async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({
    wbsUpserts: [{ id: 'new', projectId: 'p1', parentId: 'root', code: '1.2', name: 'New' }]
  });
  assert.deepEqual((await repository.loadSnapshot()).wbs.map((node) => node.id), ['root', 'leaf', 'new']);
});

test("sahte depo WBS düğümünü siler", async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ wbsDeletes: ['leaf'] });
  assert.deepEqual((await repository.loadSnapshot()).wbs.map((node) => node.id), ['root']);
});

test("sahte depo atlanan değişim koleksiyonunu boş diziye çevirir", async () => {
  const repository = createMockRepository(seed());
  assert.deepEqual(await repository.commitChanges(), {
    taskUpserts: [], taskDeletes: [], wbsUpserts: [], wbsDeletes: []
  });
});

test("sahte depo kayıt sonuçları derin kopyadır", async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskUpserts: [{ ...seed().tasks[0], task: 'Updated' }] });
  result.taskUpserts[0].task = 'Mutated result';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, 'Updated');
});

test("sahte depo örnekleri değişim durumunu paylaşmaz", async () => {
  const first = createMockRepository(seed());
  const second = createMockRepository(seed());
  await first.commitChanges({ taskDeletes: ['t1'] });
  assert.equal((await first.loadSnapshot()).tasks.length, 1);
  assert.equal((await second.loadSnapshot()).tasks.length, 2);
});

test("sahte depo failNextMutation tam bir kaydı başarısız yapar", async () => {
  const repository = createMockRepository(seed(), { failNextMutation: true });
  await assert.rejects(repository.commitChanges({ taskDeletes: ['t1'] }), (error) => {
    assert.equal(error instanceof AppRepositoryError, true);
    assert.equal(error.code, REPOSITORY_ERROR_CODES.MUTATION_FAILED);
    assert.equal(error.operation, 'commitChanges');
    return true;
  });
  await repository.commitChanges({ taskDeletes: ['t1'] });
  assert.equal((await repository.loadSnapshot()).tasks.some((task) => task.id === 't1'), false);
});

test("sahte depoda başarısız değişim kayıtlı veriyi değiştirmez", async () => {
  const repository = createMockRepository(seed(), { failNextMutation: true });
  await assert.rejects(repository.commitChanges({ taskDeletes: ['t1'] }));
  assert.deepEqual((await repository.loadSnapshot()).tasks.map((task) => task.id), ['t1', 't2']);
});

test("sahte depo failMutation sıralı deneme numarası alır", async () => {
  const attempts = [];
  const repository = createMockRepository(seed(), {
    failMutation(context) {
      attempts.push(context.attempt);
      return context.attempt === 2;
    }
  });
  await repository.commitChanges({});
  await assert.rejects(repository.commitChanges({}));
  await repository.commitChanges({});
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("sahte depo failMutation kopyalanmış değişim alır", async () => {
  let seen;
  const changes = { taskUpserts: [{ id: 't3', task: 'Three' }] };
  const repository = createMockRepository(seed(), {
    failMutation(context) {
      seen = context.changes;
      context.changes.taskUpserts[0].task = 'Changed inside callback';
      return false;
    }
  });
  await repository.commitChanges(changes);
  assert.equal(changes.taskUpserts[0].task, 'Three');
  assert.notStrictEqual(seen, changes);
});

test("sahte depo failLoad sıralı deneme numarası alır", async () => {
  const attempts = [];
  const repository = createMockRepository(seed(), {
    failLoad(context) {
      attempts.push(context.attempt);
      return context.attempt === 1;
    }
  });
  await assert.rejects(repository.loadSnapshot(), (error) => {
    assert.equal(error.code, REPOSITORY_ERROR_CODES.LOAD_FAILED);
    assert.equal(error.operation, 'loadSnapshot');
    return true;
  });
  await repository.loadSnapshot();
  assert.deepEqual(attempts, [1, 2]);
});

test("görev taslak eşitliği ilkel değer için Object.is kullanır", () => {
  assert.equal(taskDraftValuesEqual(Number.NaN, Number.NaN), true);
  assert.equal(taskDraftValuesEqual(0, -0), false);
  assert.equal(taskDraftValuesEqual('x', 'x'), true);
  assert.equal(taskDraftValuesEqual('x', 'y'), false);
});

test("görev taslak eşitliği iç diziyi özyinelemeli karşılaştırır", () => {
  assert.equal(taskDraftValuesEqual([1, ['x', { a: 2 }]], [1, ['x', { a: 2 }]]), true);
  assert.equal(taskDraftValuesEqual([1, ['x', { a: 2 }]], [1, ['x', { a: 3 }]]), false);
});

test("görev taslak eşitliği dizi ve dizi olmayan uyuşmazlığını reddeder", () => {
  assert.equal(taskDraftValuesEqual([], {}), false);
  assert.equal(taskDraftValuesEqual([], null), false);
});

test("görev taslak eşitliği farklı uzunluklu diziyi reddeder", () => {
  assert.equal(taskDraftValuesEqual([1], [1, 2]), false);
});

test("görev taslak eşitliği nesne anahtarı eklenme sırasını yok sayar", () => {
  assert.equal(taskDraftValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
});

test("görev taslak eşitliği farklı anahtar kümeli nesneyi reddeder", () => {
  assert.equal(taskDraftValuesEqual({ a: 1 }, { a: 1, b: undefined }), false);
});

test("görev taslak eşitliği kayıt ve ilkel değer uyuşmazlığını reddeder", () => {
  assert.equal(taskDraftValuesEqual({ a: 1 }, 1), false);
});

test("reconcileTaskDraft eksik yerel taslağı kanonik veriye döndürür", () => {
  const canonical = { id: 't1', task: 'Canonical' };
  const result = reconcileTaskDraft(canonical, null, new Set(['task']));
  assert.deepEqual(result.task, canonical);
  assert.equal(result.dirtyFields.size, 0);
});

test("reconcileTaskDraft eksik kanonik görevi boş kayda döndürür", () => {
  const result = reconcileTaskDraft(null, { task: 'Local' }, new Set(['task']));
  assert.equal(result.task.task, 'Local');
  assert.deepEqual([...result.dirtyFields], ['task']);
});

test("reconcileTaskDraft yalnızca değişmiş işaretli yerel alanı korur", () => {
  const result = reconcileTaskDraft(
    { task: 'Server', status: 'done', description: 'Server note' },
    { task: 'Local', status: 'todo', description: 'Local note' },
    new Set(['task', 'description'])
  );
  assert.deepEqual(result.task, { task: 'Local', status: 'done', description: 'Local note' });
});

test("reconcileTaskDraft kanonik değerle eşleşen değişmiş alanı temizler", () => {
  const result = reconcileTaskDraft({ task: 'Same' }, { task: 'Same' }, new Set(['task']));
  assert.equal(result.dirtyFields.size, 0);
});

test("reconcileTaskDraft verilen değişmiş alan kümesini değiştirmez", () => {
  const dirty = new Set(['task']);
  reconcileTaskDraft({ task: 'Same' }, { task: 'Same' }, dirty);
  assert.deepEqual([...dirty], ['task']);
});

test("reconcileTaskDraft eksik yerel alanı değer uydurmadan değişmiş tutar", () => {
  const result = reconcileTaskDraft({ task: 'Server' }, {}, new Set(['task']));
  assert.equal(result.task.task, 'Server');
  assert.deepEqual([...result.dirtyFields], ['task']);
});

test("görev güncelleme izleyicisi boş ve başarılı başlar", async () => {
  const tracker = createTaskUpdateTracker();
  assert.equal(tracker.getPendingCount(), 0);
  assert.equal(tracker.getFailure(), null);
  assert.deepEqual(await tracker.waitForIdle(), { ok: true, value: null });
});

test("görev güncelleme izleyicisi Promise olmayan sonucu kabul eder", async () => {
  const tracker = createTaskUpdateTracker();
  const result = await tracker.track({ ok: true, value: 42 });
  assert.deepEqual(result, { ok: true, value: 42 });
  assert.equal(tracker.getPendingCount(), 0);
});

test("görev güncelleme izleyicisi reddedilen sözü yapısal hata sonucuna çevirir", async () => {
  const tracker = createTaskUpdateTracker();
  const error = new Error('save failed');
  const result = await tracker.track(Promise.reject(error));
  assert.equal(result.ok, false);
  assert.strictEqual(result.error, error);
  assert.deepEqual(tracker.getFailure(), result);
});

test("görev güncelleme izleyicisi çok hatada ilkini korur", async () => {
  const tracker = createTaskUpdateTracker();
  const first = { ok: false, error: { code: 'FIRST' } };
  const second = { ok: false, error: { code: 'SECOND' } };
  await tracker.track(first);
  await tracker.track(second);
  assert.equal(tracker.getFailure().error.code, 'FIRST');
});

test("görev izleyicisi clearFailure başarılı boş sonucu geri getirir", async () => {
  const tracker = createTaskUpdateTracker();
  await tracker.track({ ok: false, error: { code: 'X' } });
  tracker.clearFailure();
  assert.equal(tracker.getFailure(), null);
  assert.deepEqual(await tracker.waitForIdle(), { ok: true, value: null });
});

test("gezinme öğesi kimlikleri tekildir", () => {
  const ids = NAV_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("gezinme üstverisi her öğeyi tam bir kez kapsar", () => {
  assert.deepEqual(Object.keys(PAGE_META).sort(), NAV_ITEMS.map((item) => item.id).sort());
});

test("her gezinme öğesinin dolu etiketi ve simgesi vardır", () => {
  for (const item of NAV_ITEMS) {
    assert.equal(typeof item.label, 'string');
    assert.equal(item.label.trim().length > 0, true);
    assert.equal(typeof item.icon, 'string');
    assert.equal(item.icon.trim().length > 0, true);
  }
});

test("her sayfa üstverisinde dolu başlık ve alt başlık vardır", () => {
  for (const meta of Object.values(PAGE_META)) {
    assert.equal(meta.title.trim().length > 0, true);
    assert.equal(meta.sub.trim().length > 0, true);
  }
});

test("gezinme etiketi ve sayfa başlığı uyumlu kalır", () => {
  for (const item of NAV_ITEMS) {
    assert.equal(PAGE_META[item.id].title, item.label);
  }
});

test("ekip sayfası açık ekip sekme kimliğini korur", () => {
  assert.equal(PAGE_META.kisi.tab, 'kisi');
});
