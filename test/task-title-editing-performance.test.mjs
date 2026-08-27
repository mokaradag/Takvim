import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canCloseWithTaskTitle,
  createTaskTitleDraftController
} from '../src/features/task-detail/taskTitleDraft.js';

function createScheduler() {
  const jobs = [];
  return {
    schedule(run) {
      const job = { run, cancelled: false };
      jobs.push(job);
      return job;
    },
    clear(job) {
      job.cancelled = true;
    },
    runAll() {
      for (const job of jobs.splice(0)) {
        if (!job.cancelled) job.run();
      }
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function thrownOrRejected(mode, error) {
  if (mode === 'throw') throw error;
  return Promise.reject(error);
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('hızlı görev başlığı yazımı son taslağı anında korur', async () => {
  const scheduler = createScheduler();
  const persisted = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'Eski',
    persist: (value) => { persisted.push(value); return { ok: true }; },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  for (const value of ['Y', 'Ye', 'Yeni', 'Yeni başlık']) controller.update(value);

  assert.equal(controller.getDraft(), 'Yeni başlık');
  assert.deepEqual(persisted, []);
  scheduler.runAll();
  await Promise.resolve();
  assert.deepEqual(persisted, ['Yeni başlık']);
});

test('bekleme süresi sonunda yalnızca son amaçlanan başlık kalıcılaştırılır', async () => {
  const scheduler = createScheduler();
  const persisted = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'A',
    persist: async (value) => { persisted.push(value); return { ok: true }; },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('AB');
  controller.update('ABC');
  controller.update('ABCD');
  scheduler.runAll();
  await Promise.resolve();

  assert.deepEqual(persisted, ['ABCD']);
  assert.equal(controller.getDraft(), 'ABCD');
});

test('panel kapanışı bekleyen son başlığı tek kez gönderir', async () => {
  const scheduler = createScheduler();
  const persisted = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'Önce',
    persist: async (value) => { persisted.push(value); return { ok: true }; },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('Kapanıştaki son değer');
  const result = await controller.commit();
  scheduler.runAll();
  await Promise.resolve();

  assert.equal(result.ok, true);
  assert.deepEqual(persisted, ['Kapanıştaki son değer']);
});

test('eski kayıt yanıtı daha yeni yerel başlık taslağını geri alamaz', async () => {
  const scheduler = createScheduler();
  const requests = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'Başlangıç',
    persist(value) {
      const request = deferred();
      requests.push({ value, ...request });
      return request.promise;
    },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('İlk istek');
  scheduler.runAll();
  assert.equal(requests.length, 1);

  controller.update('Daha yeni taslak');
  assert.equal(controller.reconcile('İlk istek'), 'Daha yeni taslak');
  requests[0].resolve({ ok: true });
  await requests[0].promise;
  await Promise.resolve();
  assert.equal(controller.getDraft(), 'Daha yeni taslak');

  scheduler.runAll();
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true });
  await requests[1].promise;
  await Promise.resolve();
  assert.equal(controller.reconcile('İlk istek'), 'Daha yeni taslak');
  assert.equal(controller.reconcile('Daha yeni taslak'), 'Daha yeni taslak');
});

test('iyimser başlık zaten geldiyse sonraki yetkili başlık güncellemesi kabul edilir', async () => {
  const scheduler = createScheduler();
  const requests = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'A',
    persist(value) {
      const request = deferred();
      requests.push({ value, ...request });
      return request.promise;
    },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('B');
  scheduler.runAll();
  assert.equal(requests.length, 1);

  // TaskDetailOverlay kalıcılaştırma tamamlanmadan önce iyimser başlığı yayınlar.
  assert.equal(controller.reconcile('B'), 'B');
  requests[0].resolve({ ok: true, value: { taskUpserts: [{ task: 'B' }] } });
  await requests[0].promise;
  await Promise.resolve();

  assert.equal(controller.isDirty(), false);
  assert.equal(controller.reconcile('C'), 'C');
  assert.equal(controller.getDraft(), 'C');
});

test('uçuşan kayıt sırasında önceki başlığa dönüş son değeri yeniden kalıcılaştırır', async () => {
  const scheduler = createScheduler();
  const requests = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'A',
    persist(value) {
      const request = deferred();
      requests.push({ value, ...request });
      return request.promise;
    },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('B');
  scheduler.runAll();
  assert.deepEqual(requests.map((request) => request.value), ['B']);

  controller.update('A');
  assert.equal(controller.getDraft(), 'A');
  requests[0].resolve({ ok: true, value: { taskUpserts: [{ task: 'B' }] } });
  await requests[0].promise;
  await Promise.resolve();

  assert.deepEqual(requests.map((request) => request.value), ['B', 'A']);
  assert.equal(controller.reconcile('B'), 'A');
  requests[1].resolve({ ok: true, value: { taskUpserts: [{ task: 'A' }] } });
  await requests[1].promise;
  await Promise.resolve();
  assert.equal(controller.reconcile('A'), 'A');
  assert.equal(controller.isDirty(), false);
});

for (const mode of ['throw', 'reject']) {
  test(`${mode === 'throw' ? 'fırlatılan' : 'reddedilen'} başlık kaydı aynı değerin yeniden denenmesini engellemez`, async () => {
    const scheduler = createScheduler();
    let attempts = 0;
    const failure = new Error('Kayıt bağlantısı kesildi');
    const controller = createTaskTitleDraftController({
      initialTitle: 'Önce',
      persist(value) {
        attempts += 1;
        if (attempts === 1) return thrownOrRejected(mode, failure);
        return { ok: true, value: { taskUpserts: [{ task: value }] } };
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clear
    });

    controller.update('Yeniden denenecek başlık');
    const failed = await controller.commit();
    assert.equal(failed.ok, false);
    assert.strictEqual(failed.error, failure);
    assert.equal(controller.isDirty(), true);

    const retried = await controller.commit();
    assert.equal(retried.ok, true);
    assert.equal(attempts, 2);
    assert.equal(controller.isDirty(), false);
  });
}

test('iki görev düzenleyicisi de başlığı yerel taslakla işler ve kapanışta boşaltır', () => {
  for (const file of [
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/SimpleTaskDrawer.jsx'
  ]) {
    const source = read(file);
    assert.match(source, /useTaskTitleDraft\(/);
    assert.match(source, /value=\{titleDraft\}/);
    assert.match(source, /onChange=\{\((?:event|e)\) => changeTitle\((?:event|e)\.target\.value\)\}/);
    assert.match(source, /onBlur=\{flushTitle\}/);
    assert.match(source, /await flushTitle\(\)|Promise\.all\(\[[\s\S]*?flushTitle\(\)|closeAfterTaskDrafts\(\{/);
    assert.match(source, /if \(!canCloseWithTaskTitle\(titleDraft\)\)/);
    assert.doesNotMatch(source, /onChange=\{[^}]*onUpdate\([^}]*task:/);
  }
});

test('boş başlık panel kapanışını engeller', () => {
  assert.equal(canCloseWithTaskTitle('Yeni başlık'), true);
  assert.equal(canCloseWithTaskTitle('   '), false);
  assert.equal(canCloseWithTaskTitle(null), false);
});
