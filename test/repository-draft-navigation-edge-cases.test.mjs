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

test('repository error codes are frozen and stable', () => {
  assert.equal(Object.isFrozen(REPOSITORY_ERROR_CODES), true);
  assert.deepEqual(REPOSITORY_ERROR_CODES, {
    LOAD_FAILED: 'LOAD_FAILED',
    MUTATION_FAILED: 'MUTATION_FAILED',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    CONFLICT: 'CONFLICT',
    DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE'
  });
});

test('AppRepositoryError exposes repository metadata and Error semantics', () => {
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

test('AppRepositoryError defaults details to null and omits an absent cause', () => {
  const error = new AppRepositoryError({ code: 'X', message: 'Boom', operation: 'save' });
  assert.equal(error.details, null);
  assert.equal('cause' in error, false);
});

test('normalizeRepositoryError preserves structured repository errors', () => {
  const error = new AppRepositoryError({
    code: 'LOAD_FAILED', message: 'Load', operation: 'loadSnapshot', details: { retry: true }
  });
  assert.deepEqual(normalizeRepositoryError(error), {
    code: 'LOAD_FAILED', message: 'Load', operation: 'loadSnapshot', details: { retry: true }
  });
});

test('normalizeRepositoryError applies explicit fallback fields to generic errors', () => {
  assert.deepEqual(normalizeRepositoryError(new Error('raw'), {
    code: 'CUSTOM', message: 'Friendly', operation: 'custom', details: { source: 'x' }
  }), {
    code: 'CUSTOM', message: 'Friendly', operation: 'custom', details: { source: 'x' }
  });
});

test('normalizeRepositoryError supplies mutation defaults for generic errors', () => {
  assert.deepEqual(normalizeRepositoryError(new Error('raw')), {
    code: 'MUTATION_FAILED',
    message: 'Değişiklik kaydedilemedi.',
    operation: 'unknown',
    details: null
  });
});

test('assertAppRepository returns a valid repository unchanged', () => {
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
  test(`assertAppRepository rejects ${name}`, () => {
    assert.throws(() => assertAppRepository(repository), /loadSnapshot\(\).*commitChanges\(\)/);
  });
}

test('mock repository identifies itself as async memory storage', () => {
  assert.equal(createMockRepository(seed()).kind, 'async-memory');
});

test('mock repository loadSnapshot returns a deep clone', async () => {
  const repository = createMockRepository(seed());
  const first = await repository.loadSnapshot();
  first.tasks[0].task = 'Mutated outside';
  first.wbs.push({ id: 'outside' });
  const second = await repository.loadSnapshot();
  assert.equal(second.tasks[0].task, 'One');
  assert.equal(second.wbs.some((node) => node.id === 'outside'), false);
});

test('mock repository custom seed is cloned at construction time', async () => {
  const original = seed();
  const repository = createMockRepository(original);
  original.tasks[0].task = 'Changed after construction';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, 'One');
});

test('mock repository updates existing tasks in place', async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskUpserts: [{ ...seed().tasks[0], task: 'Updated' }] });
  const loaded = await repository.loadSnapshot();
  assert.equal(loaded.tasks[0].id, 't1');
  assert.equal(loaded.tasks[0].task, 'Updated');
  assert.equal(result.taskUpserts[0].task, 'Updated');
});

test('mock repository prepends newly inserted tasks', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ taskUpserts: [{ id: 't3', task: 'Three' }] });
  assert.deepEqual((await repository.loadSnapshot()).tasks.map((task) => task.id), ['t3', 't1', 't2']);
});

test('mock repository deletes tasks', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ taskDeletes: ['t1'] });
  assert.deepEqual((await repository.loadSnapshot()).tasks.map((task) => task.id), ['t2']);
});

test('mock repository deduplicates deletion IDs in commit results', async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskDeletes: ['t1', 't1', 't2'] });
  assert.deepEqual(result.taskDeletes, ['t1', 't2']);
});

test('mock repository deletion wins over an upsert for the same existing task', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({
    taskUpserts: [{ ...seed().tasks[0], task: 'Should not survive' }],
    taskDeletes: ['t1']
  });
  assert.equal((await repository.loadSnapshot()).tasks.some((task) => task.id === 't1'), false);
});

test('mock repository deletion wins over insertion of a new task with the same ID', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ taskUpserts: [{ id: 't3', task: 'Three' }], taskDeletes: ['t3'] });
  assert.equal((await repository.loadSnapshot()).tasks.some((task) => task.id === 't3'), false);
});

test('mock repository updates existing WBS nodes without changing collection order', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ wbsUpserts: [{ ...seed().wbs[1], name: 'Renamed' }] });
  const loaded = await repository.loadSnapshot();
  assert.deepEqual(loaded.wbs.map((node) => node.id), ['root', 'leaf']);
  assert.equal(loaded.wbs[1].name, 'Renamed');
});

test('mock repository appends new WBS nodes', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({
    wbsUpserts: [{ id: 'new', projectId: 'p1', parentId: 'root', code: '1.2', name: 'New' }]
  });
  assert.deepEqual((await repository.loadSnapshot()).wbs.map((node) => node.id), ['root', 'leaf', 'new']);
});

test('mock repository deletes WBS nodes', async () => {
  const repository = createMockRepository(seed());
  await repository.commitChanges({ wbsDeletes: ['leaf'] });
  assert.deepEqual((await repository.loadSnapshot()).wbs.map((node) => node.id), ['root']);
});

test('mock repository normalizes omitted change collections to empty arrays', async () => {
  const repository = createMockRepository(seed());
  assert.deepEqual(await repository.commitChanges(), {
    projectUpserts: [], projectDeletes: [], taskUpserts: [], taskDeletes: [], wbsUpserts: [], wbsDeletes: []
  });
});

test('mock repository commit results are deep clones', async () => {
  const repository = createMockRepository(seed());
  const result = await repository.commitChanges({ taskUpserts: [{ ...seed().tasks[0], task: 'Updated' }] });
  result.taskUpserts[0].task = 'Mutated result';
  assert.equal((await repository.loadSnapshot()).tasks[0].task, 'Updated');
});

test('mock repository instances do not share mutation state', async () => {
  const first = createMockRepository(seed());
  const second = createMockRepository(seed());
  await first.commitChanges({ taskDeletes: ['t1'] });
  assert.equal((await first.loadSnapshot()).tasks.length, 1);
  assert.equal((await second.loadSnapshot()).tasks.length, 2);
});

test('mock repository failNextMutation fails exactly one commit', async () => {
  const repository = createMockRepository(seed(), { failNextMutation: true });
  await assert.rejects(repository.commitChanges({ taskDeletes: ['t1'] }), (error) => {
    assert.equal(error instanceof AppRepositoryError, true);
    assert.equal(error.code, REPOSITORY_ERROR_CODES.MUTATION_FAILED);
    assert.equal(error.operation, 'commitChanges');
    return true;
  });
  assert.equal((await repository.loadSnapshot()).tasks.length, 2);
  await repository.commitChanges({ taskDeletes: ['t1'] });
  assert.equal((await repository.loadSnapshot()).tasks.length, 1);
});

test('mock repository configured mutation failure is atomic', async () => {
  const repository = createMockRepository(seed(), { failMutation: true });
  await assert.rejects(repository.commitChanges({
    taskUpserts: [{ id: 't3', task: 'Three' }],
    taskDeletes: ['t1'],
    wbsDeletes: ['leaf']
  }));
  const loaded = await repository.loadSnapshot();
  assert.deepEqual(loaded.tasks.map((task) => task.id), ['t1', 't2']);
  assert.deepEqual(loaded.wbs.map((node) => node.id), ['root', 'leaf']);
});

test('mock repository load failures are surfaced as repository errors', async () => {
  const repository = createMockRepository(seed(), { failLoad: true });
  await assert.rejects(repository.loadSnapshot(), (error) => {
    assert.equal(error instanceof AppRepositoryError, true);
    assert.equal(error.code, REPOSITORY_ERROR_CODES.LOAD_FAILED);
    assert.equal(error.operation, 'loadSnapshot');
    return true;
  });
});

test('task draft equality compares persisted field values rather than object identity', () => {
  const left = { task: 'A', plannedStart: '2026-07-01', assigneeIds: ['u1'] };
  const right = { task: 'A', plannedStart: '2026-07-01', assigneeIds: ['u1'] };
  assert.equal(taskDraftValuesEqual(left, right), true);
  assert.equal(taskDraftValuesEqual(left, { ...right, task: 'B' }), false);
});

test('reconcileTaskDraft keeps unsaved local edits when persisted updates arrive', () => {
  const local = { task: 'Locally edited', description: 'Draft' };
  const persisted = { task: 'Server value', description: 'Saved' };
  assert.deepEqual(reconcileTaskDraft(local, persisted, { task: true }), {
    task: 'Locally edited',
    description: 'Saved'
  });
});

test('task update tracker ignores stale completion tokens', () => {
  const tracker = createTaskUpdateTracker();
  const first = tracker.begin('task');
  const second = tracker.begin('task');
  assert.equal(tracker.complete('task', first), false);
  assert.equal(tracker.complete('task', second), true);
});

test('navigation IDs and paths remain unique', () => {
  assert.equal(new Set(NAV_ITEMS.map((item) => item.id)).size, NAV_ITEMS.length);
  assert.equal(new Set(NAV_ITEMS.map((item) => item.path)).size, NAV_ITEMS.length);
});

test('every navigation item resolves page metadata', () => {
  for (const item of NAV_ITEMS) assert.ok(PAGE_META[item.id], item.id);
});
