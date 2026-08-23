import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import {
  appStateReducer,
  createInitialState,
  createLoadingState,
  createNewTask
} from '../src/state/appState.js';
import {
  createStateMutationOrchestrator,
  loadApplicationData
} from '../src/state/persistence.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';

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

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else files.push(full);
  }
  return files;
}

test('async repository load initializes canonical ready application state', async () => {
  const result = await loadApplicationData(createMockRepository({
    calendars: [],
    projects: [{ id: 'p1', name: 'One' }],
    people: [],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Root' }],
    tasks: [{
      id: 't1',
      projectId: 'p1',
      baslangicTarihi: '2026-07-20',
      bitisTarihi: '2026-07-21',
      deps: []
    }],
    baselines: [],
    taskBaselineSnapshots: []
  }));

  assert.equal(result.ok, true);
  const state = appStateReducer(createLoadingState(), { type: 'data/load-success', snapshot: result.snapshot });
  assert.equal(state.dataStatus, 'ready');
  assert.equal(state.tasks[0].plannedStart, '2026-07-20');
  assert.equal('baslangicTarihi' in state.tasks[0], false);
  assert.equal(state.tasks[0].wbsId, 'w1');
});

test('load failure creates explicit error state and retry can succeed', async () => {
  let fail = true;
  const repository = createMockRepository(undefined, { failLoad: () => fail });
  let state = createLoadingState();

  const first = await loadApplicationData(repository);
  assert.equal(first.ok, false);
  state = appStateReducer(state, { type: 'data/load-error', error: first.error });
  assert.equal(state.dataStatus, 'error');
  assert.equal(state.loadError.code, 'LOAD_FAILED');
  assert.equal(state.projects.length, 0);

  fail = false;
  state = appStateReducer(state, { type: 'data/load-start' });
  const retry = await loadApplicationData(repository);
  assert.equal(retry.ok, true);
  state = appStateReducer(state, { type: 'data/load-success', snapshot: retry.snapshot });
  assert.equal(state.dataStatus, 'ready');
  assert.ok(state.projects.length > 0);
});

test('memory repository mutations survive reload within one instance', async () => {
  const repository = createMockRepository();
  const before = await repository.loadSnapshot();
  const task = { ...before.tasks[0], task: 'Persisted in memory' };
  await repository.commitChanges({ taskUpserts: [task] });
  const after = await repository.loadSnapshot();
  assert.equal(after.tasks.find((item) => item.id === task.id).task, 'Persisted in memory');
});

test('fresh memory repository instances are isolated', async () => {
  const first = createMockRepository();
  const second = createMockRepository();
  const snapshot = await first.loadSnapshot();
  await first.commitChanges({ taskUpserts: [{ ...snapshot.tasks[0], task: 'Changed only here' }] });
  assert.notEqual((await second.loadSnapshot()).tasks[0].task, 'Changed only here');
});

test('repository snapshots and mutation inputs are deep-clone safe', async () => {
  const repository = createMockRepository();
  const loaded = await repository.loadSnapshot();
  const originalName = loaded.tasks[0].task;
  loaded.tasks[0].task = 'External mutation';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, originalName);

  const input = { ...(await repository.loadSnapshot()).tasks[0], task: 'Committed clone' };
  await repository.commitChanges({ taskUpserts: [input] });
  input.task = 'Mutated after commit';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, 'Committed clone');
});

test('Task create, update and delete persist through async orchestration', async () => {
  const harness = await createHarness();
  const task = createNewTask(harness.state, '2026-07-22', 'persisted-new-task');

  assert.equal((await harness.persistence.mutate('task/create', { type: 'task/add', task })).ok, true);
  assert.ok(harness.state.tasks.some((item) => item.id === task.id));
  assert.ok((await harness.repository.loadSnapshot()).tasks.some((item) => item.id === task.id));

  assert.equal((await harness.persistence.updateTask(task.id, { status: 'in_progress' })).ok, true);
  assert.equal(harness.state.tasks.find((item) => item.id === task.id).status, 'in_progress');
  assert.equal((await harness.repository.loadSnapshot()).tasks.find((item) => item.id === task.id).status, 'in_progress');

  assert.equal((await harness.persistence.mutate('task/delete', { type: 'task/delete', id: task.id })).ok, true);
  assert.equal(harness.state.tasks.some((item) => item.id === task.id), false);
  assert.equal((await harness.repository.loadSnapshot()).tasks.some((item) => item.id === task.id), false);
});

test('failed Task persistence leaves state and repository unchanged and exposes persistence error', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  const harness = await createHarness(repository);
  const beforeState = structuredClone(harness.state.tasks.find((task) => task.id === 't1'));
  const beforeRepository = structuredClone((await repository.loadSnapshot()).tasks.find((task) => task.id === 't1'));

  const result = await harness.persistence.updateTask('t1', { status: 'done' });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'persistence');
  assert.deepEqual(harness.state.tasks.find((task) => task.id === 't1'), beforeState);
  assert.deepEqual((await repository.loadSnapshot()).tasks.find((task) => task.id === 't1'), beforeRepository);
  assert.equal(harness.state.saveError.code, 'MUTATION_FAILED');
});

test('ordered mutation queue prevents older delayed updates from restoring stale Task data', async () => {
  const memory = createMockRepository();
  let call = 0;
  let active = 0;
  let maxActive = 0;
  const repository = {
    loadSnapshot: () => memory.loadSnapshot(),
    async commitChanges(changes) {
      const index = call++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 30 : 0));
      const result = await memory.commitChanges(changes);
      active -= 1;
      return result;
    }
  };
  const harness = await createHarness(repository);

  const first = harness.persistence.updateTask('t1', { status: 'in_progress' });
  const second = harness.persistence.updateTask('t1', { status: 'done' });
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.equal(harness.state.tasks.find((task) => task.id === 't1').status, 'done');
  assert.equal((await repository.loadSnapshot()).tasks.find((task) => task.id === 't1').status, 'done');
});

test('rapid high-frequency Task patches coalesce into one persistence commit', async () => {
  const memory = createMockRepository();
  let commits = 0;
  const repository = {
    loadSnapshot: () => memory.loadSnapshot(),
    commitChanges(changes) {
      commits += 1;
      return memory.commitChanges(changes);
    }
  };
  const harness = await createHarness(repository, { taskPatchDelayMs: 10 });

  const results = await Promise.all([
    harness.persistence.updateTask('t1', { task: 'A' }),
    harness.persistence.updateTask('t1', { task: 'AB' }),
    harness.persistence.updateTask('t1', { description: 'Son not' })
  ]);

  assert.ok(results.every((result) => result.ok));
  assert.equal(commits, 1);
  const persisted = (await repository.loadSnapshot()).tasks.find((task) => task.id === 't1');
  assert.equal(persisted.task, 'AB');
  assert.equal(persisted.description, 'Son not');
});

test('bulk Task WBS move persists atomically', async () => {
  const harness = await createHarness();
  const result = await harness.persistence.mutate('task/bulk-move-wbs', {
    type: 'task/bulk-move-wbs',
    ids: ['t2', 't4'],
    wbsId: 'wbs-p-web-design'
  });
  assert.equal(result.ok, true);
  const persisted = await harness.repository.loadSnapshot();
  assert.equal(persisted.tasks.find((task) => task.id === 't2').wbsId, 'wbs-p-web-design');
  assert.equal(persisted.tasks.find((task) => task.id === 't4').wbsId, 'wbs-p-web-design');
});

test('failed bulk Task WBS move does not partially update repository or state', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  const harness = await createHarness(repository);
  const before = await repository.loadSnapshot();
  const result = await harness.persistence.mutate('task/bulk-move-wbs', {
    type: 'task/bulk-move-wbs',
    ids: ['t2', 't4'],
    wbsId: 'wbs-p-web-design'
  });
  assert.equal(result.ok, false);
  assert.deepEqual((await repository.loadSnapshot()).tasks, before.tasks);
  assert.equal(harness.state.tasks.find((task) => task.id === 't2').wbsId, before.tasks.find((task) => task.id === 't2').wbsId);
});

test('WBS create, rename and safe delete persist correctly', async () => {
  const harness = await createHarness();
  const id = 'wbs-persist-test';
  assert.equal((await harness.persistence.mutate('wbs/create', {
    type: 'wbs/add-child', id, parentId: 'wbs-p-web-design', name: 'Persistence child'
  })).ok, true);
  assert.ok((await harness.repository.loadSnapshot()).wbs.some((node) => node.id === id));

  assert.equal((await harness.persistence.mutate('wbs/update', {
    type: 'wbs/rename', id, name: 'Renamed persistence child'
  })).ok, true);
  assert.equal((await harness.repository.loadSnapshot()).wbs.find((node) => node.id === id).name, 'Renamed persistence child');

  assert.equal((await harness.persistence.mutate('wbs/delete', { type: 'wbs/delete', id })).ok, true);
  assert.equal((await harness.repository.loadSnapshot()).wbs.some((node) => node.id === id), false);
});

test('WBS subtree reparent persists all rebased nodes atomically with stable IDs', async () => {
  const harness = await createHarness();
  const result = await harness.persistence.mutate('wbs/reparent', {
    type: 'wbs/reparent',
    id: 'wbs-p-web-development',
    parentId: 'wbs-p-web-design'
  });
  assert.equal(result.ok, true);
  assert.ok(result.value.wbsUpserts.length >= 3);
  const persisted = await harness.repository.loadSnapshot();
  assert.equal(persisted.wbs.find((node) => node.id === 'wbs-p-web-development').code, '1.2.1');
  assert.equal(persisted.wbs.find((node) => node.id === 'wbs-p-web-frontend').code, '1.2.1.1');
  assert.equal(persisted.tasks.find((task) => task.id === 't1').wbsId, harness.state.tasks.find((task) => task.id === 't1').wbsId);
});

test('failed WBS reparent leaves the entire persisted subtree unchanged', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  const harness = await createHarness(repository);
  const before = (await repository.loadSnapshot()).wbs;
  const result = await harness.persistence.mutate('wbs/reparent', {
    type: 'wbs/reparent',
    id: 'wbs-p-web-development',
    parentId: 'wbs-p-web-design'
  });
  assert.equal(result.ok, false);
  assert.deepEqual((await repository.loadSnapshot()).wbs, before);
  assert.deepEqual(harness.state.wbs, before);
});

test('Task and WBS persistence mutations never modify baseline data', async () => {
  const harness = await createHarness();
  const beforeBaselines = structuredClone((await harness.repository.loadSnapshot()).baselines);
  const beforeSnapshots = structuredClone((await harness.repository.loadSnapshot()).taskBaselineSnapshots);

  await harness.persistence.updateTask('t1', { status: 'in_progress' });
  await harness.persistence.mutate('wbs/update', {
    type: 'wbs/rename', id: 'wbs-p-web-design', name: 'Tasarım Güncel'
  });

  const after = await harness.repository.loadSnapshot();
  assert.deepEqual(after.baselines, beforeBaselines);
  assert.deepEqual(after.taskBaselineSnapshots, beforeSnapshots);
});

test('reload reconciliation clears missing selected Task and invalid Project workspace', async () => {
  const repository = createMockRepository();
  const snapshot = await repository.loadSnapshot();
  let state = createInitialState(snapshot);
  state = appStateReducer(state, { type: 'workspace/select', workspaceMode: 'project', selectedProjectId: 'p-web' });
  state = appStateReducer(state, { type: 'task/select', id: 't1' });

  const reloaded = {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== 'p-web'),
    tasks: snapshot.tasks.filter((task) => task.projectId !== 'p-web'),
    wbs: snapshot.wbs.filter((node) => node.projectId !== 'p-web')
  };
  state = appStateReducer(state, { type: 'data/load-success', snapshot: reloaded });

  assert.equal(state.workspaceMode, 'portfolio');
  assert.equal(state.selectedProjectId, null);
  assert.equal(state.selectedTaskId, null);
});

test('successful persisted scheduling mutation recomputes derived project CPM', async () => {
  const harness = await createHarness();
  const before = buildPortfolioSchedule({
    tasks: harness.state.tasks,
    projects: harness.state.projects,
    calendars: harness.state.calendars
  });
  const task = harness.state.tasks.find((item) => item.id === 't1');
  const result = await harness.persistence.updateTask('t1', {
    plannedStart: task.plannedStart,
    plannedFinish: '2026-12-31'
  });
  assert.equal(result.ok, true);
  const after = buildPortfolioSchedule({
    tasks: harness.state.tasks,
    projects: harness.state.projects,
    calendars: harness.state.calendars
  });
  assert.notDeepEqual(after.projects['p-web'], before.projects['p-web']);
  assert.equal('earlyStart' in harness.state.tasks.find((item) => item.id === 't1'), false);
});

test('domain validation errors remain distinct from persistence failures', async () => {
  const harness = await createHarness();
  const domain = await harness.persistence.mutate('wbs/delete', {
    type: 'wbs/delete', id: 'wbs-p-web-root'
  });
  assert.equal(domain.ok, false);
  assert.equal(domain.error.kind, 'domain');
  assert.equal(domain.error.code, 'WBS_HAS_CHILDREN');
  assert.equal(harness.state.saveError, null);

  const failingRepository = createMockRepository(undefined, { failNextMutation: true });
  const failingHarness = await createHarness(failingRepository);
  const persistence = await failingHarness.persistence.updateTask('t1', { status: 'done' });
  assert.equal(persistence.ok, false);
  assert.equal(persistence.error.kind, 'persistence');
  assert.equal(failingHarness.state.wbsActionError, null);
});

test('workspace preference stays outside the business-data repository boundary', async () => {
  const dataFiles = await sourceFiles(path.resolve('src/data'));
  for (const file of dataFiles) {
    assert.equal((await readFile(file, 'utf8')).includes('localStorage'), false, path.relative(process.cwd(), file));
  }
  const preferenceSource = await readFile(path.resolve('src/state/workspacePreference.js'), 'utf8');
  assert.ok(preferenceSource.includes('mergen-rota.workspace.v1'));
});

test('static architecture keeps features away from repository implementations and synchronous snapshots', async () => {
  const srcFiles = await sourceFiles(path.resolve('src'));
  const featureFiles = srcFiles.filter((file) => file.includes(`${path.sep}features${path.sep}`));
  const getSnapshotOffenders = [];
  const featureRepositoryOffenders = [];

  for (const file of srcFiles) {
    const content = await readFile(file, 'utf8');
    if (content.includes('getSnapshot(')) getSnapshotOffenders.push(path.relative('src', file));
  }
  for (const file of featureFiles) {
    const content = await readFile(file, 'utf8');
    if (content.includes('/data/mock/') || content.includes('createMockRepository') || content.includes('repository.')) {
      featureRepositoryOffenders.push(path.relative('src', file));
    }
  }

  assert.deepEqual(getSnapshotOffenders, []);
  assert.deepEqual(featureRepositoryOffenders, []);
});
