import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createActualStack, corporateSeed, CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { remapCommitIds, creationEntries } from '../src/domain/identity/creationIds.js';
import { createApiRepository } from '../src/data/api/createApiRepository.js';
import { translateEntityRequest, restoreEntityResponse } from '../src/data/api/activeActualIdAliases.js';

const HIDDEN_PROJECT = '11111111-1111-4111-8111-111111111111';
const HIDDEN_WBS = '22222222-2222-4222-8222-222222222222';
const HIDDEN_TASK = '33333333-3333-4333-8333-333333333333';
function seed(extra = {}) {
  const base = corporateSeed();
  return { ...base, projects: [...base.projects, { ProjectId: HIDDEN_PROJECT, ProjectName: 'Hidden', SourceType: 'MANUAL' }],
    wbs: [...base.wbs, { WbsId: HIDDEN_WBS, ProjectId: HIDDEN_PROJECT, ParentWbsId: null, Code: '1', Name: 'Hidden' }],
    tasks: [{ TaskId: HIDDEN_TASK, ProjectId: HIDDEN_PROJECT, WbsId: HIDDEN_WBS, Title: 'Hidden', CreatedBySicil: 900001 }], ...extra };
}
function task(id = randomUUID()) {
  return { id, projectId: CORPORATE_PROJECT_ID.toLowerCase(), wbsId: CORPORATE_ROOT_WBS_ID.toLowerCase(),
    task: 'Allocated task', status: 'planned', priority: 'medium', assigneeIds: ['900010'], deps: [] };
}
async function post(changes, operation) {
  const route = await import('../src/app/api/mergen-rota/commit/route.js');
  const response = await route.POST(new Request('http://localhost/api/mergen-rota/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation ? { changes: {}, allocationChanges: changes, operation } : { changes })
  }));
  return { status: response.status, body: await response.json() };
}
async function allocate(changes) {
  const result = await post(changes, 'allocate-creation-ids');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const mappings = new Map(result.body.allocations.map((row) => [`${row.entityType}:${row.clientId}`, row.id]));
  const prepared = remapCommitIds(changes, mappings);
  for (const { entry, entityType } of creationEntries(prepared)) {
    entry.creationProof = result.body.allocations.find((row) => row.entityType === entityType && row.id === entry.id)?.proof;
  }
  return { changes: prepared, allocations: result.body.allocations };
}

for (const [collection, hiddenId] of [['projectUpserts', HIDDEN_PROJECT], ['wbsUpserts', HIDDEN_WBS], ['taskUpserts', HIDDEN_TASK]]) {
  test(`F-024: arbitrary hidden/unused ${collection} IDs reject identically before candidate lookup`, async () => {
    const stack = await createActualStack(seed(), { sicil: 900010 });
    try {
      const entry = collection === 'projectUpserts' ? { id: hiddenId, name: 'Proposed', calendarId: DEFAULT_CALENDAR_ID, leadId: '900010', color: 'blue' }
        : collection === 'wbsUpserts' ? { id: hiddenId, projectId: CORPORATE_PROJECT_ID, parentId: CORPORATE_ROOT_WBS_ID, code: '2', name: 'Proposed' }
          : task(hiddenId);
      const start = stack.db.statements.length;
      const hidden = await post({ [collection]: [entry] });
      assert.equal(hidden.status, 409);
      assert.equal(hidden.body.error.details.code, 'CREATION_ALLOCATION_INVALID');
      for (const creationProof of [undefined, 'bad', randomUUID()]) {
        assert.deepEqual(await post({ [collection]: [{ ...entry, creationProof }] }),
          await post({ [collection]: [{ ...entry, id: randomUUID(), creationProof }] }));
      }
      assert.equal(stack.db.statements.slice(start).some(({ sql }) => /WHERE (?:TaskId|WbsId|ProjectId) = @entityId/.test(sql)), false);
      assert.equal(stack.db.tasks.length, 1);
    } finally { await stack.dispose(); }
  });
}

test('allocation uses fresh server IDs, binds owner/type/destination, and consumes once with commit', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes, allocations } = await allocate({ taskUpserts: [task(HIDDEN_TASK)] });
    assert.notEqual(allocations[0].id, HIDDEN_TASK);
    assert.equal(stack.db.creationAllocations.length, 1);
    const valid = changes.taskUpserts[0];
    const invalid = await post({ taskUpserts: [{ ...valid, id: HIDDEN_TASK }] });
    for (const altered of [{ ...valid, id: randomUUID() }, { ...valid, projectId: HIDDEN_PROJECT }, { ...valid, creationProof: randomUUID() }]) {
      assert.deepEqual(await post({ taskUpserts: [altered] }), invalid);
    }
    assert.deepEqual(await post({ wbsUpserts: [{ id: valid.id, projectId: valid.projectId, creationProof: valid.creationProof, parentId: null, code: '2', name: 'Wrong type' }] }), invalid);
    process.env.MERGEN_ROTA_DEV_SICIL = '900001';
    assert.deepEqual(await post(changes), invalid, 'even an administrator cannot use another caller allocation');
    process.env.MERGEN_ROTA_DEV_SICIL = '900010';
    const result = await post(changes);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(stack.db.creationAllocations.length, 0);
    assert.equal(stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK).Title, 'Hidden');
    assert.deepEqual(await post(changes), invalid, 'successful creation cannot be blindly retried');
    stack.db.tasks = stack.db.tasks.filter((row) => row.TaskId.toLowerCase() !== valid.id);
    assert.deepEqual(await post(changes), invalid, 'deletion does not permit recreation with a consumed proof');
  } finally { await stack.dispose(); }
});

test('failed validation rolls allocation consumption back; authorization still runs on every commit', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes } = await allocate({ taskUpserts: [task()] });
    const invalid = structuredClone(changes);
    invalid.taskUpserts[0].deps = [{ predecessorId: HIDDEN_TASK, type: 'FS' }];
    const rejected = await post(invalid);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.details.code, 'DEPENDENCY_TARGET_NOT_FOUND');
    assert.equal(stack.db.creationAllocations.length, 1);
    stack.db.corporateProjectAccess = [];
    assert.notEqual((await post(changes)).status, 200, 'allocation does not preserve revoked mutation rights');
    assert.equal(stack.db.creationAllocations.length, 1);
    stack.db.corporateProjectAccess = corporateSeed().corporateProjectAccess;
    assert.equal((await post(changes)).status, 200);
  } finally { await stack.dispose(); }
});

test('expired proofs fail closed and missing allocation schema gives controlled deployment errors', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes } = await allocate({ taskUpserts: [task()] });
    stack.db.creationAllocations[0].ExpiresAt = new Date(0).toISOString();
    const expired = await post(changes);
    assert.equal(expired.body.error.details.code, 'CREATION_ALLOCATION_INVALID');
    const unknown = structuredClone(changes); unknown.taskUpserts[0].creationProof = randomUUID();
    assert.deepEqual(await post(unknown), expired);
    stack.db.creationAllocationSchema = false;
    for (const result of [await post(changes), await post({ taskUpserts: [task()] }, 'allocate-creation-ids')]) {
      assert.equal(result.status, 503); assert.equal(result.body.error.code, 'DATABASE_UNAVAILABLE');
      assert.match(result.body.error.message, /0019/);
    }
    assert.equal(stack.db.tasks.length, 1);
  } finally { await stack.dispose(); }
});

test('client persists allocation proof before commit; lost responses replay the same proof after reload', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const fetch = globalThis.fetch;
  const clientId = `task-${randomUUID()}`;
  try {
    let lose = true;
    const sent = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      const response = await fetch(url, init);
      if (!body.operation && lose) { lose = false; throw new TypeError('response lost'); }
      return response;
    };
    const changes = { taskUpserts: [task(clientId)] };
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes));
    assert.equal(stack.db.tasks.length, 2);
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes), (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
    assert.equal(sent.filter((body) => body.operation).length, 1);
    assert.deepEqual(sent[1].changes, sent[2].changes);
    assert.equal(stack.db.tasks.length, 2);
    globalThis.fetch = fetch;
    const repository = createApiRepository({ aliasStorage: storage });
    const loaded = await repository.loadSnapshot();
    const loadedTask = loaded.tasks.find((row) => row.id === clientId);
    assert.ok(loadedTask?.version);
    const updated = await repository.commitChanges({ taskUpserts: [{ ...loadedTask, task: 'Updated' }] });
    assert.equal(updated.taskUpserts[0].id, clientId);
    const serverId = stack.db.tasks.find((row) => row.Title === 'Updated').TaskId.toLowerCase();
    for (const suffix of ['reminder', 'outlook']) {
      assert.equal(translateEntityRequest(`/api/mergen-rota/tasks/${clientId}/${suffix}`, { method: 'POST' }).path,
        `/api/mergen-rota/tasks/${serverId}/${suffix}`);
    }
    const translated = translateEntityRequest(`/api/mergen-rota/reports/task-activities?taskId=${clientId}`, {
      method: 'POST', body: JSON.stringify({ taskId: clientId, taskIds: [clientId] }) });
    assert.match(translated.path, new RegExp(serverId));
    assert.deepEqual(JSON.parse(translated.init.body), { taskId: serverId, taskIds: [serverId] });
    assert.deepEqual(restoreEntityResponse({ results: [{ taskId: serverId }] }), { results: [{ taskId: clientId }] });
    const deleted = await repository.commitChanges({ taskDeletes: [{ id: clientId, version: updated.taskUpserts[0].version }] });
    assert.equal(deleted.taskDeletes[0], clientId);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('project/root/task graph references use allocated IDs with original client IDs restored', async () => {
  const stack = await createActualStack(seed());
  try {
    const projectId = `project-${randomUUID()}`, wbsId = `wbs-${randomUUID()}`, firstId = `task-${randomUUID()}`, secondId = `task-${randomUUID()}`;
    const result = await stack.repository.commitChanges({ projectUpserts: [{ id: projectId, name: 'Allocated project', calendarId: DEFAULT_CALENDAR_ID, leadId: '900001', color: 'blue' }],
      wbsUpserts: [{ id: wbsId, projectId, parentId: null, code: '1', name: 'Root' }],
      taskUpserts: [{ ...task(firstId), projectId, wbsId }, { ...task(secondId), projectId, wbsId, deps: [{ predecessorId: firstId, type: 'FS' }] }] });
    assert.equal(result.projectUpserts[0].id, projectId);
    assert.equal(result.wbsUpserts[0].id, wbsId);
    assert.equal(result.taskUpserts.find((row) => row.id === secondId).deps[0].predecessorId, firstId);
    assert.equal(stack.db.creationAllocations.length, 0);
    assert.equal(stack.db.projects.some((row) => row.ProjectId.toLowerCase() === projectId.slice(8)), false);
  } finally { await stack.dispose(); }
});

test('allocation SQL retains bounded owner ranges, one-use consumption and deployment schema parity', () => {
  const source = fs.readFileSync(new URL('../src/server/repository/creationAllocations.js', import.meta.url), 'utf8');
  assert.match(source, /DELETE TOP \(4000\)/);
  assert.match(source, /@pending \+ \(SELECT COUNT\(\*\) FROM @issued\) > @pendingLimit/);
  assert.match(source, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(source, /DELETE a OUTPUT deleted.Proof/);
  const create = fs.readFileSync(new URL('../database/MR_Create_Durable_Persistence.sql', import.meta.url), 'utf8');
  const upgrade = fs.readFileSync(new URL('../database/MR_Upgrade_0019_Creation_Allocations.sql', import.meta.url), 'utf8');
  assert.equal(create.match(/    CREATE TABLE dbo.MR_CreationAllocations[\s\S]*?Owner ON[^;]+;/)[0],
    upgrade.match(/    CREATE TABLE dbo.MR_CreationAllocations[\s\S]*?Owner ON[^;]+;/)[0]);
  assert.match(upgrade, /0018_ai_message_evidence/);
  assert.match(upgrade, /Incompatible MR_CreationAllocations columns/);
  assert.match(upgrade, /Incompatible MR_CreationAllocations indexes/);
  assert.match(fs.readFileSync(new URL('../database/MR_Rollback_Durable_Persistence.sql', import.meta.url), 'utf8'), /DROP TABLE dbo.MR_CreationAllocations/);
});

test('concurrent use of one allocation waits for the transaction and has one winner', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes } = await allocate({ taskUpserts: [task()] });
    let entered;
    const atCommit = new Promise((resolve) => { entered = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let first = true;
    stack.db.commitHook = async () => { if (first) { first = false; entered(); await held; } };
    const winner = post(changes);
    await atCommit;
    let settled = false;
    const replay = post(changes).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'competing consumption waits for the first commit');
    release();
    assert.equal((await winner).status, 200);
    assert.equal((await replay).body.error.details.code, 'CREATION_ALLOCATION_INVALID');
    assert.equal(stack.db.tasks.length, 2);
    assert.equal(stack.db.creationAllocations.length, 0);
    assert.equal(stack.db.transactions.at(-1).isolationLevel, 4);
  } finally { await stack.dispose(); }
});

test('pending allocation cap is caller-local and expired allocations release capacity', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes } = await allocate({ taskUpserts: [task()] });
    const row = stack.db.creationAllocations[0];
    stack.db.creationAllocations = Array.from({ length: 4000 }, () => ({ ...row, Proof: randomUUID(), EntityId: randomUUID() }));
    assert.equal((await post({ taskUpserts: [task()] }, 'allocate-creation-ids')).body.error.details.code, 'CREATION_ALLOCATION_LIMIT');
    assert.equal(stack.db.creationAllocations.length, 4000);
    stack.db.creationAllocations.forEach((entry) => { entry.ExpiresAt = new Date(0).toISOString(); });
    assert.equal((await post({ taskUpserts: [task()] }, 'allocate-creation-ids')).status, 200);
    assert.equal(stack.db.creationAllocations.length, 1);
    assert.equal((await post(changes)).body.error.details.code, 'CREATION_ALLOCATION_INVALID');
  } finally { await stack.dispose(); }
});

test('mixed valid/invalid proof batches roll back all consumption; storage failures send no mutation', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { changes } = await allocate({ taskUpserts: [task(), task()] });
    const mixed = structuredClone(changes); mixed.taskUpserts[1].creationProof = randomUUID();
    assert.equal((await post(mixed)).body.error.details.code, 'CREATION_ALLOCATION_INVALID');
    assert.equal(stack.db.creationAllocations.length, 2);
    assert.equal((await post(changes)).status, 200);
    const count = stack.db.tasks.length;
    const repository = createApiRepository({ aliasStorage: { getItem() { return null; }, setItem() { throw new Error('quota'); } } });
    await assert.rejects(repository.commitChanges({ taskUpserts: [task()] }), (error) => error.details.code === 'CREATION_ALLOCATION_STORAGE');
    assert.equal(stack.db.tasks.length, count);
  } finally { await stack.dispose(); }
});

test('new client cannot accidentally commit an allocation request to an older server', async () => {
  const fetch = globalThis.fetch;
  const envelopes = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); envelopes.push(body);
    // The old commit handler ignores unknown operation/allocationChanges fields.
    assert.deepEqual(body.changes, {});
    return Response.json({ projectUpserts: [], wbsUpserts: [], taskUpserts: [] });
  };
  try {
    await assert.rejects(createApiRepository().commitChanges({ taskUpserts: [task()] }));
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].operation, 'allocate-creation-ids');
    assert.equal(envelopes[0].allocationChanges.taskUpserts.length, 1);
  } finally { globalThis.fetch = fetch; }
});

test('typed aliases never rewrite other entity namespaces, including after client reload', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  try {
    const local = CORPORATE_PROJECT_ID.toLowerCase();
    const changes = { taskUpserts: [task(`task-${local}`)] };
    const repository = createApiRepository({ aliasStorage: storage });
    const saved = await repository.commitChanges(changes);
    assert.equal(saved.taskUpserts[0].id, `task-${local}`);
    assert.equal(saved.taskUpserts[0].projectId, local);
    const serverId = stack.db.tasks.find((row) => row.Title === 'Allocated task').TaskId.toLowerCase();
    const reloaded = createApiRepository({ aliasStorage: storage });
    const loaded = (await reloaded.loadSnapshot()).tasks.find((row) => row.id === `task-${local}`);
    const updated = await reloaded.commitChanges({ taskUpserts: [{ ...loaded, description: 'same project' }] });
    assert.equal(updated.taskUpserts[0].projectId, local);
    const request = translateEntityRequest(`/api/mergen-rota/reports/task-activities?projectId=${local}&taskId=${local}`, {
      method: 'POST', body: JSON.stringify({ projectId: local, taskId: local }) });
    assert.equal(new URL(request.path, 'http://localhost').searchParams.get('projectId'), local);
    assert.equal(new URL(request.path, 'http://localhost').searchParams.get('taskId'), serverId);
    assert.deepEqual(JSON.parse(request.init.body), { projectId: local, taskId: serverId });
  } finally { await stack.dispose(); }
});

test('failed proof persistence publishes no memory state; retry remains durable across a lost response and reload', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const values = new Map();
  let rejectProof = true;
  const storage = { getItem: (key) => values.get(key), setItem(key, value) {
    if (key.endsWith('.creations.v1') && JSON.parse(value).pending.length && rejectProof) { rejectProof = false; throw new Error('quota'); }
    values.set(key, value);
  } };
  const fetch = globalThis.fetch;
  const sent = [];
  let loseResponse = true;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    const response = await fetch(url, init);
    if (!body.operation && loseResponse) { loseResponse = false; throw new TypeError('response lost'); }
    return response;
  };
  try {
    const changes = { taskUpserts: [task(`task-${randomUUID()}`)] };
    const repository = createApiRepository({ aliasStorage: storage });
    await assert.rejects(repository.commitChanges(changes), (error) => error.details.code === 'CREATION_ALLOCATION_STORAGE');
    assert.equal(stack.db.tasks.length, 1);
    const firstId = stack.db.creationAllocations[0].EntityId.toLowerCase();
    await assert.rejects(repository.commitChanges(changes));
    assert.equal(sent.filter((body) => body.operation).length, 2, 'a failed remember left no reusable proof in memory');
    const submitted = sent.find((body) => !body.operation).changes.taskUpserts[0];
    assert.notEqual(submitted.id, firstId);
    const persisted = JSON.parse([...values].find(([key]) => key.endsWith('.creations.v1'))[1]).pending;
    assert.equal(persisted[0].proof, submitted.creationProof);
    assert.equal(persisted[0].id, submitted.id);
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes),
      (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
    assert.equal(sent.filter((body) => body.operation).length, 2, 'reload replays the durably stored proof');
    assert.equal(stack.db.tasks.length, 2);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('proof durability requirements do not block versioned edits when browser storage is full', async () => {
  const stack = await createActualStack(seed());
  try {
    const current = stack.state.tasks.find((row) => row.id === HIDDEN_TASK);
    assert.ok(current?.version);
    const repository = createApiRepository({ aliasStorage: { getItem() { return null; }, setItem() { throw new Error('quota'); } } });
    const result = await repository.commitChanges({ taskUpserts: [{ ...current, task: 'Versioned edit' }] });
    assert.equal(result.taskUpserts[0].task, 'Versioned edit');
    assert.equal(stack.db.creationAllocations.length, 0);
  } finally { await stack.dispose(); }
});

function sharedCreationStorage() {
  const values = new Map();
  return { values, client: () => ({ getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }),
    state: () => JSON.parse([...values].find(([key]) => key.endsWith('.creations.v1'))?.[1] || '{}') };
}

for (const entityType of ['TASK', 'WBS']) {
  test(`moved ${entityType} draft replaces the project-bound proof and preserves its client ID`, async () => {
    const base = seed();
    const projectB = randomUUID(), wbsB = randomUUID();
    const stack = await createActualStack({ ...base,
      projects: [...base.projects, { ProjectId: projectB, SourceType: 'MANUAL', ProjectName: 'B', LeadSicil: 900010, CalendarId: DEFAULT_CALENDAR_ID }],
      wbs: [...base.wbs, { WbsId: wbsB, ProjectId: projectB, ParentWbsId: null, Code: '1', Name: 'B root' }] }, { sicil: 900010 });
    const shared = sharedCreationStorage();
    const fetch = globalThis.fetch, sent = [];
    let fail = true;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      if (!body.operation && fail) { fail = false; throw new TypeError('commit did not reach server'); }
      return fetch(url, init);
    };
    try {
      const clientId = `${entityType.toLowerCase()}-${randomUUID()}`;
      const collection = entityType === 'TASK' ? 'taskUpserts' : 'wbsUpserts';
      const entry = entityType === 'TASK' ? task(clientId) : { id: clientId, projectId: CORPORATE_PROJECT_ID, parentId: CORPORATE_ROOT_WBS_ID, code: '2', name: 'New WBS' };
      const repository = createApiRepository({ aliasStorage: shared.client() });
      await assert.rejects(repository.commitChanges({ [collection]: [entry] }));
      const old = shared.state().pending[0];
      const moved = { ...entry, projectId: projectB, ...(entityType === 'TASK' ? { wbsId: wbsB } : { parentId: wbsB }) };
      const saved = await repository.commitChanges({ [collection]: [moved] });
      assert.equal(saved[collection][0].id, clientId);
      assert.equal(sent.filter((body) => body.operation).length, 2);
      const submitted = sent.at(-1).changes[collection][0];
      assert.equal(submitted.projectId, projectB);
      assert.notEqual(submitted.id, old.id);
      assert.notEqual(submitted.creationProof, old.proof);
      assert.equal(shared.state().aliases.some(([id]) => id === old.id), false);
      assert.deepEqual(shared.state().pending, []);
      // The same move to an unauthorized destination is still rejected server-side.
      await assert.rejects(repository.commitChanges({ [collection]: [{ ...entry, id: `${entityType.toLowerCase()}-${randomUUID()}`, projectId: HIDDEN_PROJECT }] }));
    } finally { globalThis.fetch = fetch; await stack.dispose(); }
  });
}

test('stale independent tabs merge interleaved proofs and completion never resurrects another pending record', async () => {
  const base = seed(), projectB = randomUUID(), rootB = randomUUID();
  const stack = await createActualStack({ ...base,
    projects: [...base.projects, { ProjectId: projectB, SourceType: 'MANUAL', ProjectName: 'B', LeadSicil: 900010, CalendarId: DEFAULT_CALENDAR_ID }],
    wbs: [...base.wbs, { WbsId: rootB, ProjectId: projectB, ParentWbsId: null, Code: '1', Name: 'B root' }] }, { sicil: 900010 });
  const shared = sharedCreationStorage();
  const a = createApiRepository({ aliasStorage: shared.client() });
  const b = createApiRepository({ aliasStorage: shared.client() });
  const changesA = { taskUpserts: [task(`task-${randomUUID()}`)] };
  const changesB = { wbsUpserts: [{ id: `wbs-${randomUUID()}`, projectId: projectB, parentId: rootB, code: '2', name: 'Tab B' }] };
  const fetch = globalThis.fetch;
  let allocatedB, releaseB;
  const bAllocated = new Promise((resolve) => { allocatedB = resolve; });
  const bHeld = new Promise((resolve) => { releaseB = resolve; });
  let failCommits = true;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    if (!body.operation && failCommits) throw new TypeError('commit not sent');
    const response = await fetch(url, init);
    if (body.operation && body.allocationChanges.wbsUpserts.length) { allocatedB(); await bHeld; }
    return response;
  };
  try {
    // Both clients started empty. B's allocation is in flight while A persists;
    // B must subsequently read shared storage instead of overwriting from memory.
    const pendingB = assert.rejects(b.commitChanges(changesB));
    await bAllocated;
    await assert.rejects(a.commitChanges(changesA));
    const proofA = shared.state().pending[0];
    releaseB(); await pendingB;
    const state = shared.state();
    assert.equal(state.pending.length, 2);
    const proofB = state.pending.find((record) => record.entityType === 'WBS');
    assert.deepEqual(state.pending.find((record) => record.entityType === 'TASK'), proofA);
    assert.equal(state.aliases.find(([id]) => id === proofA.id)[2], 'TASK');
    assert.equal(state.aliases.find(([id]) => id === proofB.id)[2], 'WBS');
    // Original stale clients and fresh clients all recover the durable proof.
    for (const [repository, changes, proof] of [[a, changesA, proofA], [b, changesB, proofB],
      [createApiRepository({ aliasStorage: shared.client() }), changesA, proofA]]) {
      await assert.rejects(repository.commitChanges(changes));
      const submitted = sent.at(-1).changes;
      assert.equal(creationEntries(submitted)[0].entry.creationProof, proof.proof);
    }
    failCommits = false;
    assert.equal((await a.commitChanges(changesA)).taskUpserts[0].id, changesA.taskUpserts[0].id);
    assert.deepEqual(shared.state().pending.map((record) => record.id), [proofB.id]);
    await b.commitChanges(changesB);
    assert.deepEqual(shared.state().pending, []);
    assert.equal(shared.state().aliases.filter((entry) => ['TASK', 'WBS'].includes(entry[2])).length, 2);
    await assert.rejects(a.commitChanges(changesA), (error) => error.details.code === 'CREATION_ALLOCATION_STORAGE');
    assert.deepEqual(shared.state().pending, [], 'a completed proof cannot be resurrected by a stale tab');
    assert.equal(sent.filter((body) => body.operation).length, 2);
  } finally { releaseB(); globalThis.fetch = fetch; await stack.dispose(); }
});

test('pending proof lifetime has a safety margin, drops undated legacy state, and keeps completed typed aliases', async () => {
  const { createCreationIdStorage, CREATION_ALLOCATION_CLIENT_TTL_MS, CREATION_ALLOCATION_SERVER_TTL_MS,
    CREATION_ALLOCATION_SAFETY_MARGIN_MS } = await import('../src/data/api/creationIdStorage.js');
  const { actualIdAliasType } = await import('../src/data/api/actualIdAliasStorage.js');
  assert.equal(CREATION_ALLOCATION_SERVER_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(CREATION_ALLOCATION_CLIENT_TTL_MS + CREATION_ALLOCATION_SAFETY_MARGIN_MS, CREATION_ALLOCATION_SERVER_TTL_MS);
  assert.ok(CREATION_ALLOCATION_SAFETY_MARGIN_MS > 0);
  let time = 1000000000;
  const shared = sharedCreationStorage(), aliases = new Map();
  const storage = shared.client();
  const lifecycle = createCreationIdStorage(storage, undefined, { now: () => time });
  const changes = { taskUpserts: [task()] };
  const allocation = { entityType: 'TASK', clientId: changes.taskUpserts[0].id, id: randomUUID(), projectId: CORPORATE_PROJECT_ID, proof: randomUUID() };
  await lifecycle.remember([allocation], aliases, changes);
  const allocatedAt = time;
  assert.equal((await lifecycle.prepare(changes, aliases)).taskUpserts[0].creationProof, allocation.proof);
  time += CREATION_ALLOCATION_CLIENT_TTL_MS - 1;
  assert.equal((await lifecycle.prepare(changes, aliases)).taskUpserts[0].creationProof, allocation.proof);
  // Restoring also excludes the expired proof/alias before any request uses it.
  time += 1;
  const restoredAliases = new Map();
  const restored = createCreationIdStorage(storage, undefined, { now: () => time });
  restored.restoreAliases(restoredAliases);
  assert.equal(restoredAliases.has(allocation.id), false);
  const fresh = (await restored.prepare(changes, restoredAliases)).taskUpserts[0];
  assert.equal(fresh.id, allocation.clientId); assert.equal(fresh.creationProof, undefined);
  assert.deepEqual(shared.state().pending, []); assert.deepEqual(shared.state().aliases, []);
  assert.equal(actualIdAliasType(restoredAliases, allocation.id), undefined);
  const replacement = { ...allocation, id: randomUUID(), proof: randomUUID() };
  await restored.remember([replacement], restoredAliases, changes);
  const prepared = await restored.prepare(changes, restoredAliases);
  await restored.complete(prepared, restoredAliases);
  time += 3 * CREATION_ALLOCATION_SERVER_TTL_MS;
  const completedAliases = new Map();
  createCreationIdStorage(storage, undefined, { now: () => time }).restoreAliases(completedAliases);
  assert.equal(completedAliases.get(replacement.id), replacement.clientId);
  assert.equal(actualIdAliasType(completedAliases, replacement.id), 'TASK');
  // Older builds saved pending aliases separately and had no allocation age.
  const legacy = sharedCreationStorage();
  legacy.values.set('mergen-rota.actual-id-aliases.v1', JSON.stringify([[allocation.id, allocation.clientId, 'TASK'], [replacement.id, `task-${replacement.id}`, 'TASK']]));
  legacy.values.set('mergen-rota.actual-id-aliases.v1.creations.v1', JSON.stringify([{ ...allocation, clientAlias: allocation.clientId }]));
  const legacyAliases = new Map();
  const migrated = createCreationIdStorage(legacy.client(), undefined, { now: () => allocatedAt });
  migrated.restoreAliases(legacyAliases);
  assert.equal(legacyAliases.has(allocation.id), false);
  assert.equal(legacyAliases.get(replacement.id), `task-${replacement.id}`, 'completed legacy aliases are retained');
  const retry = await migrated.prepare(changes, legacyAliases);
  assert.equal(retry.taskUpserts[0].id, allocation.clientId);
  assert.equal(retry.taskUpserts[0].creationProof, undefined);
  assert.equal(legacy.state().pending.length, 0);
  assert.equal(legacy.state().aliases.some(([id]) => id === allocation.id), false);
});

for (const legacy of [false, true]) {
  test(`expired ${legacy ? 'legacy undated' : 'dated'} allocation gets replaced through the real repository`, async (t) => {
    const stack = await createActualStack(seed(), { sicil: 900010 });
    const shared = sharedCreationStorage();
    const fetch = globalThis.fetch;
    let fail = true, allocations = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.operation) allocations += 1;
      else if (fail) { fail = false; throw new TypeError('not sent'); }
      return fetch(url, init);
    };
    try {
      const changes = { taskUpserts: [task(`task-${randomUUID()}`)] };
      await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
      const state = shared.state(), old = state.pending[0];
      if (legacy) {
        delete old.allocatedAt;
        shared.values.set('mergen-rota.actual-id-aliases.v1', JSON.stringify(state.aliases));
        shared.values.set('mergen-rota.actual-id-aliases.v1.creations.v1', JSON.stringify(state.pending));
      } else {
        const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
        t.mock.method(Date, 'now', () => old.allocatedAt + CREATION_ALLOCATION_CLIENT_TTL_MS + 1);
      }
      const result = await createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes);
      assert.equal(result.taskUpserts[0].id, changes.taskUpserts[0].id);
      assert.equal(allocations, 2);
      assert.equal(shared.state().aliases.some(([id]) => id === old.id), false);
      assert.equal(stack.db.tasks.length, 2);
    } finally { globalThis.fetch = fetch; await stack.dispose(); }
  });
}

test('entity translation passes malformed/non-object string bodies through byte for byte', async () => {
  const { activateActualIdAliases } = await import('../src/data/api/activeActualIdAliases.js');
  const { actualIdAliasType } = await import('../src/data/api/actualIdAliasStorage.js');
  const actual = randomUUID(), client = `task-${randomUUID()}`;
  const aliases = new Map([[actual, client]]); actualIdAliasType(aliases, actual, 'TASK'); activateActualIdAliases(aliases);
  try {
    for (const body of [' { malformed ', ' null ', ' [1, 2] ', ' "text" ', ' 42 ', ' true ', ' false ']) {
      const init = { method: 'POST', body };
      const result = translateEntityRequest(`/api/mergen-rota/tasks/${client}/reminder?taskId=${client}`, init);
      assert.equal(result.init, init); assert.equal(result.init.body, body);
      assert.equal(result.path, `/api/mergen-rota/tasks/${actual}/reminder?taskId=${actual}`);
    }
    const result = translateEntityRequest('/api/mergen-rota/tasks', { body: JSON.stringify({ taskId: client, taskIds: [client], other: client }) });
    assert.deepEqual(JSON.parse(result.init.body), { taskId: actual, taskIds: [actual], other: client });
  } finally { activateActualIdAliases(new Map()); }
});

test('cross-context storage mutations read only after acquiring the shared browser lock', async (t) => {
  const { createCreationIdStorage } = await import('../src/data/api/creationIdStorage.js');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let queue = held;
  const names = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { navigator: { locks: {
    request(name, mutation) { names.push(name); const result = queue.then(mutation); queue = result.catch(() => {}); return result; }
  } } } });
  const shared = sharedCreationStorage(), aliasesA = new Map(), aliasesB = new Map();
  let reads = 0;
  const client = () => ({ getItem: (key) => { reads += 1; return shared.values.get(key); }, setItem: (key, value) => shared.values.set(key, value) });
  const a = createCreationIdStorage(client()), b = createCreationIdStorage(client());
  const allocations = ['TASK', 'WBS'].map((entityType) => ({ entityType, clientId: randomUUID(), id: randomUUID(), proof: randomUUID(), projectId: CORPORATE_PROJECT_ID }));
  const pendingA = a.remember([allocations[0]], aliasesA, { taskUpserts: [{ id: allocations[0].clientId }] });
  const pendingB = b.remember([allocations[1]], aliasesB, { wbsUpserts: [{ id: allocations[1].clientId }] });
  assert.equal(reads, 0); assert.equal(aliasesA.size, 0); assert.equal(aliasesB.size, 0);
  release(); await Promise.all([pendingA, pendingB]);
  assert.equal(new Set(names).size, 1); assert.equal(names.length, 2);
  assert.equal(shared.state().pending.length, 2);
  assert.equal(aliasesB.get(allocations[0].id), allocations[0].clientId, 'the later lock holder publishes the merged state');
});
