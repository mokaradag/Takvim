import assert from 'node:assert/strict';
import test from 'node:test';

import { closeAfterTaskDrafts } from '../src/features/task-detail/taskDraft.js';
import { createTaskTitleDraftController } from '../src/features/task-detail/taskTitleDraft.js';

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

for (const failingDraft of ['title', 'description']) {
  test(`görev paneli ${failingDraft} taslağı reddedilse de kapanır`, async () => {
    const failure = new Error(`${failingDraft} kaydı reddedildi`);
    let closeCalls = 0;
    const result = await closeAfterTaskDrafts({
      flushTitle: () => failingDraft === 'title'
        ? Promise.reject(failure)
        : Promise.resolve({ ok: true }),
      persistDescription: () => failingDraft === 'description'
        ? Promise.reject(failure)
        : Promise.resolve({ ok: true }),
      close: async () => {
        closeCalls += 1;
        return { ok: true };
      }
    });

    assert.equal(closeCalls, 1);
    assert.equal(result.ok, false);
    assert.strictEqual(result.error, failure);
  });
}

test('panel kaldırılırken bekleyen başlık taslağı bir kez kalıcılaştırılır', async () => {
  const scheduler = createScheduler();
  const persisted = [];
  const controller = createTaskTitleDraftController({
    initialTitle: 'Önceki başlık',
    persist: async (value) => {
      persisted.push(value);
      return { ok: true, value: { taskUpserts: [{ task: value }] } };
    },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear
  });

  controller.update('Kaldırılmadan hemen önce yazılan başlık');
  const disposal = controller.dispose();
  assert.deepEqual(persisted, ['Kaldırılmadan hemen önce yazılan başlık']);
  await disposal;

  scheduler.runAll();
  await Promise.resolve();
  assert.deepEqual(persisted, ['Kaldırılmadan hemen önce yazılan başlık']);
});