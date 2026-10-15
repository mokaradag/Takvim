import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
registerServerOnlyShim();
const { lockCommitResources } = await import('../src/server/repository/commitResourceLocks.js');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const T = 'cccccccc-0000-4000-8000-000000000003';
const U = 'dddddddd-0000-4000-8000-000000000004';
function executor(tasks, onProjectLock = () => {}) {
  const calls = [];
  return { calls, request() { const params = {}; return { input(name, _type, value) { params[name] = value; }, async query(sql) {
    calls.push({ sql, params });
    if (sql.includes('commit-project-lock')) onProjectLock();
    const rows = sql.includes('commit-task-lock') ? tasks.filter((t) => t.TaskId === params.resourceId) : [];
    if (sql.includes('commit-project-code-lock')) return { recordset: [{ LockResult: 0 }] };
    if (sql.includes('commit-resource-discovery')) return { recordsets: [tasks, []] };
    if (sql.includes('commit-topology-members')) return { recordsets: [tasks, []] };
    return { recordset: rows };
  } }; } };
}

test('content saves acquire shared project stability and their own task, without topology locks', async () => {
  const db = executor([{ TaskId: T, ProjectId: A }]);
  await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A, version: 'v1', dependencyMutation: false }] });
  assert.equal(db.calls.some(({ sql }) => /MR_Projects WITH \(UPDLOCK/.test(sql)), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes('commit-dependency-lock')), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes('commit-topology-members')), false);
  assert.deepEqual(db.calls.filter(({ sql }) => sql.includes('commit-task-lock')).map(({ params }) => params.resourceId), [T]);
});

for (const [source, destination] of [[A, B], [B, A]]) {
  test(`mixed transaction locks source ${source[0]} / destination ${destination[0]} in global order`, async () => {
    const db = executor([{ TaskId: T, ProjectId: source }, { TaskId: U, ProjectId: destination }]);
    await lockCommitResources(db, { projectUpserts: [{ id: destination }], taskDeletes: [{ id: U }],
      taskUpserts: [{ id: T, projectId: destination, version: 'v1', dependencyMutation: true, dependencyChanges: { upserts: [], removals: [] } }] });
    const projectCalls = db.calls.filter(({ sql }) => sql.includes('commit-project-lock'));
    assert.deepEqual(projectCalls.map(({ params }) => params.resourceId), [A, B]);
    const taskCalls = db.calls.filter(({ sql }) => sql.includes('commit-task-lock'));
    assert.deepEqual(taskCalls.map(({ params }) => params.resourceId), [T, U]);
    const lastProject = db.calls.findLastIndex(({ sql }) => sql.includes('commit-project-lock'));
    const firstTask = db.calls.findIndex(({ sql }) => sql.includes('commit-task-lock'));
    const lastTask = db.calls.findLastIndex(({ sql }) => sql.includes('commit-task-lock'));
    const edge = db.calls.findIndex(({ sql }) => sql.includes('commit-dependency-lock'));
    assert.ok(lastProject < firstTask && lastTask < edge);
  });
}


test('project GUID casing cannot remove assignment dependency write permission', async () => {
  const { indexTaskWriteState, resolveTaskMutationAccess } = await import('../src/state/projectWritePolicy.js');
  const state = { currentUser: { id: '1' }, tasks: [{ id: T.toUpperCase(), projectId: A.toUpperCase(), assigneeIds: ['2'] }],
    projects: [{ id: A.toLowerCase(), accessLevel: 'PARTIAL' }], assignableProjects: [{ id: A.toUpperCase() }], assignmentScopeSicils: ['2'] };
  for (const value of [state, indexTaskWriteState(state)]) {
    const access = resolveTaskMutationAccess(value, T.toLowerCase(), { projectId: A.toUpperCase() });
    assert.equal(access.ok, true);
    assert.equal(access.canManageDependencies, true);
  }
});

for (const count of [10, 500]) {
  test(`content resource work stays bounded with ${count} tasks and WBS rows`, async () => {
    const W = 'eeeeeeee-0000-4000-8000-000000000005';
    const tasks = [{ TaskId: T, ProjectId: A, WbsId: W }, ...Array.from({ length: count }, (_, i) => ({
      TaskId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ProjectId: A, WbsId: W
    }))];
    const db = executor(tasks);
    await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A, wbsId: W, dependencyMutation: false }] });
    assert.equal(db.calls.length, 3);
    assert.equal(db.calls.some(({ sql }) => sql.includes('commit-wbs-lock')), false);
    assert.deepEqual(db.calls.filter(({ sql }) => sql.includes('commit-task-lock')).map(({ params }) => params.resourceId), [T]);
  });
}

test('content on a 400-occurrence series locks only the edited row and shared parent', async () => {
  const tasks = [{ TaskId: U, ProjectId: A }, { TaskId: T, ProjectId: A, RecurrenceParentTaskId: U },
    ...Array.from({ length: 400 }, (_, i) => ({ TaskId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ProjectId: A, RecurrenceParentTaskId: U }))];
  const db = executor(tasks);
  await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A, recurrenceParentId: U, dependencyMutation: false }] });
  const locks = db.calls.filter(({ sql }) => sql.includes('commit-task-lock'));
  assert.deepEqual(locks.map(({ params }) => params.resourceId), [U, T]);
  assert.match(locks.find(({ params }) => params.resourceId === U).sql, /WITH \(HOLDLOCK\)/);
  assert.equal(db.calls.some(({ sql }) => sql.includes('commit-topology-members')), false);
});

for (const kind of ['create', 'dependency']) {
  test(`${kind} reads the post-mutex population once and locks only explicit rows`, async () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({ TaskId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ProjectId: A }));
    if (kind === 'dependency') tasks.push({ TaskId: T, ProjectId: A }, { TaskId: U, ProjectId: A });
    const db = executor(tasks);
    await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A,
      ...(kind === 'dependency' ? { dependencyChanges: { upserts: [{ predecessorId: U, type: 'FS' }], removals: [] } } : {}) }] });
    const population = db.calls.filter(({ sql }) => sql.includes('commit-topology-members'));
    assert.equal(population.length, 1);
    assert.ok(db.calls.findIndex(({ sql }) => sql.includes('commit-project-lock')) < db.calls.indexOf(population[0]));
    assert.equal(db.calls.filter(({ sql }) => sql.includes('commit-task-lock')).length, kind === 'create' ? 1 : 2);
    assert.equal(db.calls.some(({ sql }) => sql.includes('commit-wbs-lock')), false);
    assert.match(db.calls.find(({ sql }) => sql.includes('commit-dependency-lock')).sql, /WITH \(READCOMMITTED\)/);
  });
}

test('string and object deletes enter the same canonical resource plan', async () => {
  for (const entry of [T, { id: T, version: 'v1' }]) {
    const db = executor([{ TaskId: T, ProjectId: A }]);
    await lockCommitResources(db, { taskDeletes: [entry] });
    assert.deepEqual(db.calls.filter(({ sql }) => sql.includes('commit-task-lock')).map(({ params }) => params.resourceId), [T]);
    assert.match(db.calls.find(({ sql }) => sql.includes('commit-project-lock')).sql, /XLOCK/);
  }
});

test('relationship capability respects the successor assignee scope and unknown graph state', async () => {
  const { indexTaskWriteState, resolveTaskMutationAccess } = await import('../src/state/projectWritePolicy.js');
  const state = { currentUser: { id: '1' }, projects: [{ id: A, accessLevel: 'PARTIAL' }], assignableProjects: [{ id: A }],
    assignmentScopeSicils: ['2'], tasks: [{ id: T, projectId: A, assigneeIds: ['3'], assigneeCount: 1 }] };
  assert.equal(resolveTaskMutationAccess(indexTaskWriteState(state), T).canManageDependencies, false);
  state.tasks[0].assigneeIds = ['2'];
  assert.equal(resolveTaskMutationAccess(indexTaskWriteState(state), T).canManageDependencies, true);
  state.tasks[0].dependenciesLoaded = false;
  assert.equal(resolveTaskMutationAccess(indexTaskWriteState(state), T).canManageDependencies, false);
});


test('membership committed while waiting for a topology mutex becomes the authoritative population', async () => {
  const tasks = [];
  const db = executor(tasks, () => tasks.push({ TaskId: U, ProjectId: A }));
  const plan = await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A, deps: [] }] });
  assert.ok(plan.rows.has(U));
  assert.equal(db.calls.filter(({ sql }) => sql.includes('commit-topology-members')).length, 1);
});


test('code-catalog readers precede project topology locks; metadata writers reserve it exclusively', async () => {
  for (const metadata of [false, true]) {
    const db = executor([{ TaskId: T, ProjectId: A }]);
    await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: B, deps: [] }], ...(metadata ? { projectUpserts: [{ id: B, code: 'B' }] } : {}) });
    const catalog = db.calls.find(({ sql }) => sql.includes('commit-project-code-lock'));
    assert.equal(catalog.params.lockMode, metadata ? 'Exclusive' : 'Shared');
    assert.ok(db.calls.indexOf(catalog) < db.calls.findIndex(({ sql }) => sql.includes('commit-project-lock')));
    assert.deepEqual(db.calls.filter(({ sql }) => sql.includes('commit-project-lock')).map(({ params }) => params.resourceId), [A, B]);
  }
});
