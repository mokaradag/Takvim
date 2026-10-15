import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
registerServerOnlyShim();
const { lockCommitResources } = await import('../src/server/repository/commitResourceLocks.js');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const T = 'cccccccc-0000-4000-8000-000000000003';
const U = 'dddddddd-0000-4000-8000-000000000004';
function executor(tasks) {
  const calls = [];
  return { calls, request() { const params = {}; return { input(name, _type, value) { params[name] = value; }, async query(sql) {
    calls.push({ sql, params });
    const rows = sql.includes('commit-task-lock') ? tasks.filter((t) => t.TaskId === params.resourceId) : [];
    if (sql.includes('commit-project-code-lock')) return { recordset: [{ LockResult: 0 }] };
    if (sql.includes('commit-resource-discovery')) return { recordsets: [tasks, []] };
    if (sql.includes('commit-topology-members')) return { recordsets: [[], []] };
    return { recordset: rows };
  } }; } };
}

test('content saves acquire shared project stability and their own task, without topology locks', async () => {
  const db = executor([{ TaskId: T, ProjectId: A }]);
  await lockCommitResources(db, { taskUpserts: [{ id: T, projectId: A, version: 'v1', dependencyMutation: false }] });
  assert.equal(db.calls.some(({ sql }) => /MR_Projects WITH \(UPDLOCK/.test(sql)), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes('commit-dependency-lock')), false);
  assert.equal(db.calls.find(({ sql }) => sql.includes('commit-topology-members')).params.topologyProjectIds, '');
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
