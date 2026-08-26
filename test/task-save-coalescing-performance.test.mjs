import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { appStateReducer, createInitialState } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import { closeTaskWithPendingUpdates, createTaskUpdateTracker } from '../src/features/task-detail/taskDraft.js';
import {
  CORPORATE_PROJECT_ID,
  CORPORATE_ROOT_WBS_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';

const AUTHORITATIVE_TASK_ID = 'a7777777-7777-4777-8777-777777777777';

function seed() {
  return {
    calendars: [],
    projects: [{ id: 'p1', name: 'Proje', accessLevel: 'FULL' }],
    people: [{ id: '1', name: 'Kullanıcı' }],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Proje' }],
    tasks: [{
      id: 't1', projectId: 'p1', wbsId: 'w1', task: 'İlk', description: '', keyword: '',
      status: 'todo', priority: 'medium', plannedStart: '2026-08-01', plannedFinish: '2026-08-03',
      targetFinish: '2026-08-03', progress: 0, assigneeIds: ['1'], sorumlu: ['Kullanıcı'], deps: [], version: 'AQ=='
    }],
    baselines: [], taskBaselineSnapshots: []
  };
}

test('çok alanlı görev düzenlemesi ve kapanış boşaltması tek commit üretir', async () => {
  let state = createInitialState(seed());
  const calls = [];
  const repository = {
    async commitChanges(changes) {
      calls.push(changes);
      return {
        ...changes,
        taskUpserts: changes.taskUpserts.map((task) => ({ ...task, version: 'Ag==' }))
      };
    }
  };
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) { state = appStateReducer(state, action); return state; },
    taskPatchDelayMs: 60_000
  });

  const updates = [
    persistence.updateTask('t1', { task: 'Yeni başlık' }),
    persistence.updateTask('t1', { status: 'in_progress' }),
    persistence.updateTask('t1', { priority: 'high' }),
    persistence.updateTask('t1', { targetFinish: '2026-08-10', progress: 45 })
  ];
  const closeFlush = persistence.flushTaskUpdates(['t1']);
  const results = await Promise.all([...updates, closeFlush]);

  assert.equal(results.flat().every((result) => result.ok), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskUpserts[0].task, 'Yeni başlık');
  assert.equal(calls[0].taskUpserts[0].status, 'in_progress');
  assert.equal(calls[0].taskUpserts[0].priority, 'high');
  assert.equal(calls[0].taskUpserts[0].targetFinish, '2026-08-10');
  assert.equal(calls[0].taskUpserts[0].progress, 45);
  assert.equal(calls[0].taskUpserts[0].assigneeMutation, false);
  assert.equal(state.tasks[0].version, 'Ag==');
  persistence.dispose();
});

test('kapanış başarılı kaydı yeniden commit etmez ve etkin kaydı bildirir', async () => {
  const drawer = readFileSync(new URL('../src/features/task-detail/TaskDrawer.jsx', import.meta.url), 'utf8');
  assert.match(drawer, /Kaydediliyor…/);

  const tracker = createTaskUpdateTracker();
  tracker.track(Promise.resolve({ ok: true, value: 'saved' }));
  let closeCalls = 0;
  const result = await closeTaskWithPendingUpdates(tracker, async () => {
    closeCalls += 1;
    return { ok: true, value: 'closed' };
  });
  assert.equal(closeCalls, 1);
  assert.equal(result.value, 'closed');

  const api = readFileSync(new URL('../src/data/api/createApiRepository.js', import.meta.url), 'utf8');
  assert.match(api, /REQUEST_TIMEOUT_MS = 30000/);
});

test('mutasyon yanıtı geniş anlık görüntü yerine yalnızca dokunulan kimlikleri yükler', async () => {
  const stack = await createActualStack(corporateSeed({
    tasks: [{
      TaskId: AUTHORITATIVE_TASK_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Dokunulan görev',
      Status: 'todo'
    }],
    taskAssignees: [{ TaskId: AUTHORITATIVE_TASK_ID, Sicil: 900001 }]
  }));
  try {
    const task = stack.state.tasks.find((entry) => entry.id === AUTHORITATIVE_TASK_ID);
    const response = await stack.repository.commitChanges({
      taskUpserts: [{ ...task, task: 'Güncellenen görev', assigneeMutation: false }]
    });

    assert.deepEqual(response.projectUpserts.map((project) => project.id), [CORPORATE_PROJECT_ID.toLowerCase()]);
    assert.deepEqual(response.wbsUpserts.map((node) => node.id), [CORPORATE_ROOT_WBS_ID.toLowerCase()]);
    assert.deepEqual(response.taskUpserts.map((entry) => entry.id), [AUTHORITATIVE_TASK_ID]);
    assert.deepEqual(response.projectDeletes, []);
    assert.deepEqual(response.wbsDeletes, []);
    assert.deepEqual(response.taskDeletes, []);
  } finally {
    await stack.dispose();
  }
});
