import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import { appStateReducer, createInitialState } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';

test('single Task WBS move persists through the async boundary', async () => {
  const repository = createMockRepository();
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) {
      state = appStateReducer(state, action);
      return state;
    },
    taskPatchDelayMs: 5
  });

  const before = structuredClone(state.tasks.find((task) => task.id === 't1'));
  const result = await persistence.mutate('task/move-wbs', {
    type: 'task/move-wbs',
    id: 't1',
    wbsId: 'wbs-p-web-frontend'
  });

  assert.equal(result.ok, true);
  const current = state.tasks.find((task) => task.id === 't1');
  const persisted = (await repository.loadSnapshot()).tasks.find((task) => task.id === 't1');
  assert.equal(current.wbsId, 'wbs-p-web-frontend');
  assert.equal(persisted.wbsId, 'wbs-p-web-frontend');
  assert.deepEqual({ ...current, wbsId: before.wbsId }, before);
});
