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
      const candidateIds = new Set([hiddenId]);
      const hidden = await post({ [collection]: [entry] });
      assert.equal(hidden.status, 409);
      assert.equal(hidden.body.error.details.code, 'CREATION_ALLOCATION_INVALID');
      for (const creationProof of [undefined, 'bad', randomUUID()]) {
        const unusedId = randomUUID(); candidateIds.add(unusedId);
        assert.deepEqual(await post({ [collection]: [{ ...entry, creationProof }] }),
          await post({ [collection]: [{ ...entry, id: unusedId, creationProof }] }));
      }
      const reads = stack.db.statements.slice(start).filter(({ sql, params }) =>
        /(?:FROM|JOIN)\s+dbo\.MR_(?:Projects|WBS|Tasks)\b/i.test(sql)
        && Object.values(params).some((value) => candidateIds.has(String(value).toLowerCase())));
      assert.deepEqual(reads, [], 'no candidate-table read may use any candidate parameter before proof validation');
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
      if (init.method === 'GET') return fetch(url, init);
    const body = JSON.parse(init.body); sent.push(body);
      const response = await fetch(url, init);
      if (!body.operation && lose) { lose = false; throw new TypeError('response lost'); }
      return response;
    };
    const changes = { taskUpserts: [task(clientId)] };
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes));
    assert.equal(stack.db.tasks.length, 2);
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes), (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
    assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 1);
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
    if (init.method === 'GET') return Response.json({ authenticated: true, currentUser: { sicil: 900010 } });
    const body = JSON.parse(init.body); envelopes.push(body);
    // The old commit handler ignores unknown operation/allocationChanges fields.
    assert.deepEqual(body.changes, {});
    return Response.json({ projectUpserts: [], wbsUpserts: [], taskUpserts: [] });
  };
  try {
    await assert.rejects(createApiRepository({ aliasStorage: sharedCreationStorage().client() }).commitChanges({ taskUpserts: [task()] }));
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
    if (init.method === 'GET') return fetch(url, init);
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
    assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 2, 'a failed remember left no reusable proof in memory');
    const submitted = sent.find((body) => !body.operation).changes.taskUpserts[0];
    assert.notEqual(submitted.id, firstId);
    const persisted = JSON.parse([...values].find(([key]) => key.endsWith('.creations.v1'))[1]).pending;
    assert.equal(persisted[0].proof, submitted.creationProof);
    assert.equal(persisted[0].id, submitted.id);
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges(changes),
      (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
    assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 2, 'reload replays the durably stored proof');
    assert.equal(stack.db.tasks.length, 2);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('proof durability requirements do not block versioned edits when browser storage is full', async () => {
  const stack = await createActualStack(seed());
  try {
    const current = stack.state.tasks.find((row) => row.id === HIDDEN_TASK);
    assert.ok(current?.version);
    const repository = createApiRepository({ aliasStorage: { getItem() { return null; }, setItem() { throw new Error('quota'); } } });
    await repository.loadSnapshot();
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
      if (init.method === 'GET') return fetch(url, init);
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
      assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 2);
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
    if (init.method === 'GET') return fetch(url, init);
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
    assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 2);
  } finally { releaseB(); globalThis.fetch = fetch; await stack.dispose(); }
});

for (const committed of [false, true]) {
  test(`expired uncertain creation reconciles before replacement (committed=${committed})`, async (t) => {
    const stack = await createActualStack(seed(), { sicil: 900010 });
    const shared = sharedCreationStorage(), fetch = globalThis.fetch, sent = [];
    let lose = true;
    globalThis.fetch = async (url, init) => {
      if (init.method === 'GET') return fetch(url, init);
      const body = JSON.parse(init.body); sent.push(body);
      if (!body.operation && lose) {
        lose = false;
        if (committed) await fetch(url, init);
        throw new TypeError('response lost');
      }
      return fetch(url, init);
    };
    try {
      const changes = { taskUpserts: [task(`task-${randomUUID()}`)] };
      await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
      const old = shared.state().pending[0];
      const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
      t.mock.method(Date, 'now', () => old.allocatedAt + CREATION_ALLOCATION_CLIENT_TTL_MS + 600000);
      for (const row of stack.db.creationAllocations) row.ExpiresAt = new Date(0).toISOString();
      const repository = createApiRepository({ aliasStorage: shared.client() });
      if (committed) {
        await assert.rejects(repository.commitChanges(changes), (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
        assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 1);
        assert.equal((await repository.loadSnapshot()).tasks.find((entry) => entry.id === changes.taskUpserts[0].id)?.version != null, true);
        assert.deepEqual(shared.state().pending, []);
        assert.ok(shared.state().aliases.some(([id]) => id === old.id));
      } else {
        const saved = await repository.commitChanges(changes);
        assert.equal(saved.taskUpserts[0].id, changes.taskUpserts[0].id);
        assert.equal(sent.filter((body) => body.operation === 'allocate-creation-ids').length, 2);
        assert.ok(sent.some((body) => body.operation === 'release-creation-ids'));
        assert.deepEqual(shared.state().pending, []);
      }
      assert.equal(stack.db.tasks.filter((row) => row.Title === 'Allocated task').length, 1);
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
  const a = createCreationIdStorage(client(), undefined, { accountId: '900010' }), b = createCreationIdStorage(client(), undefined, { accountId: '900010' });
  const allocations = ['TASK', 'WBS'].map((entityType) => ({ entityType, clientId: randomUUID(), id: randomUUID(), proof: randomUUID(), projectId: CORPORATE_PROJECT_ID }));
  const pendingA = a.remember([allocations[0]], aliasesA, { taskUpserts: [{ id: allocations[0].clientId }] });
  const pendingB = b.remember([allocations[1]], aliasesB, { wbsUpserts: [{ id: allocations[1].clientId }] });
  assert.equal(reads, 0); assert.equal(aliasesA.size, 0); assert.equal(aliasesB.size, 0);
  release(); await Promise.all([pendingA, pendingB]);
  assert.equal(new Set(names).size, 1); assert.equal(names.length, 2);
  assert.equal(shared.state().pending.length, 2);
  assert.equal(aliasesB.get(allocations[0].id), allocations[0].clientId, 'the later lock holder publishes the merged state');
});

test('account-scoped creation state restores only after the authenticated owner is known', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  const completed = { taskUpserts: [task(`task-${randomUUID()}`)] };
  const pending = { taskUpserts: [task(`task-${randomUUID()}`)] };
  try {
    const a = createApiRepository({ aliasStorage: shared.client() });
    await a.commitChanges(completed);
    globalThis.fetch = async (url, init) => {
      if (init.method !== 'GET' && !JSON.parse(init.body).operation) throw new TypeError('not sent');
      return fetch(url, init);
    };
    await assert.rejects(a.commitChanges(pending));
    globalThis.fetch = fetch;
    const savedA = JSON.stringify(shared.state());
    process.env.MERGEN_ROTA_DEV_SICIL = '900001';
    const b = createApiRepository({ aliasStorage: shared.client() });
    const snapshotB = await b.loadSnapshot();
    assert.equal(snapshotB.tasks.some((entry) => entry.id === completed.taskUpserts[0].id), false);
    assert.equal(translateEntityRequest(`/tasks?taskId=${completed.taskUpserts[0].id}`, {}).path,
      `/tasks?taskId=${completed.taskUpserts[0].id}`);
    await assert.rejects(a.commitChanges({ taskDeletes: [{ id: completed.taskUpserts[0].id, version: 'AAAAAAAAAAA=' }] }, { keepalive: true }),
      { code: 'UNAUTHORIZED' });
    assert.equal(JSON.stringify(shared.state()), savedA, 'another account cannot overwrite the owner envelope');
    process.env.MERGEN_ROTA_DEV_SICIL = '900010';
    const restoredA = createApiRepository({ aliasStorage: shared.client() });
    assert.ok((await restoredA.loadSnapshot()).tasks.find((entry) => entry.id === completed.taskUpserts[0].id));
    assert.equal(JSON.stringify(shared.state()), savedA);
    assert.equal((await restoredA.commitChanges(pending)).taskUpserts[0].id, pending.taskUpserts[0].id);
    assert.deepEqual(shared.state().pending, []);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('unscoped legacy creation envelopes are never activated for an authenticated account', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), old = randomUUID(), client = randomUUID(), proof = randomUUID();
  shared.values.set('mergen-rota.actual-id-aliases.v1', JSON.stringify([[old, client, 'TASK']]));
  shared.values.set('mergen-rota.actual-id-aliases.v1.creations.v1', JSON.stringify({ version: 2,
    aliases: [[old, client, 'TASK']], pending: [{ entityType: 'TASK', id: old, clientId: client, proof, projectId: CORPORATE_PROJECT_ID }] }));
  try {
    const repository = createApiRepository({ aliasStorage: shared.client() });
    await repository.loadSnapshot();
    const translated = translateEntityRequest(`/tasks?taskId=${client}`, { body: JSON.stringify({ taskId: client }) });
    assert.equal(translated.path, `/tasks?taskId=${client}`);
    assert.equal(JSON.parse(translated.init.body).taskId, client);
    assert.equal(stack.db.creationAllocations.length, 0);
  } finally { await stack.dispose(); }
});

test('bounded completed-alias compaction preserves older live identities and rebases fresh snapshots to canonical IDs', async () => {
  const stack = await createActualStack(seed());
  const shared = sharedCreationStorage();
  const client = randomUUID();
  const aliases = Array.from({ length: 5000 }, (_, index) => [index ? randomUUID() : HIDDEN_TASK, index ? randomUUID() : client, 'TASK']);
  shared.values.set('mergen-rota.actual-id-aliases.v1.account.900001.creations.v1', JSON.stringify({ version: 2, pending: [], aliases }));
  try {
    const repository = createApiRepository({ aliasStorage: shared.client() });
    const old = (await repository.loadSnapshot()).tasks.find((entry) => entry.id === client);
    assert.ok(old?.version);
    const otherTab = createApiRepository({ aliasStorage: shared.client() });
    await otherTab.loadSnapshot();
    const added = await repository.commitChanges({ taskUpserts: [task(randomUUID())] });
    assert.ok(added.taskUpserts[0].version);
    await otherTab.commitChanges({ taskUpserts: [task(randomUUID())] });
    const edited = await repository.commitChanges({ taskUpserts: [{ ...old, task: 'Older identity still works' }] });
    assert.equal(edited.taskUpserts[0].id, client);
    assert.equal(stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK).Title, 'Older identity still works');
    assert.equal(shared.state().aliases.filter((entry) => entry[2] === 'TASK').length, 5000);
    assert.equal(stack.db.creationAllocations.length, 0);
    const restarted = createApiRepository({ aliasStorage: shared.client() });
    const canonical = (await restarted.loadSnapshot()).tasks.find((entry) => entry.id === HIDDEN_TASK);
    assert.ok(canonical?.version, 'a new state uses the server ID for a retired completed alias');
    assert.equal((await restarted.commitChanges({ taskUpserts: [{ ...canonical, task: 'Edited after restart' }] })).taskUpserts[0].id, HIDDEN_TASK);
    assert.equal(stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK).Title, 'Edited after restart');
  } finally { await stack.dispose(); }
});

test('verified keepalive update/delete dispatches fetch in the same task without Web Locks or IndexedDB', async (t) => {
  const stack = await createActualStack(seed());
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const repository = createApiRepository({ aliasStorage: shared.client() });
  const made = await repository.commitChanges({ taskUpserts: [task(randomUUID())] });
  const serverId = stack.db.tasks.find((row) => row.Title === 'Allocated task').TaskId.toLowerCase();
  const loaded = (await repository.loadSnapshot()).tasks.find((entry) => entry.id === made.taskUpserts[0].id);
  let locks = 0, calls = [];
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { navigator: { locks: {
    request() { locks += 1; return new Promise(() => {}); }
  } } } });
  globalThis.fetch = (url, init) => { calls.push(init); return fetch(url, init); };
  try {
    const pending = repository.commitChanges({ taskUpserts: [{ ...loaded, task: 'Unload edit' }] }, { keepalive: true });
    assert.equal(calls.length, 1); assert.equal(locks, 0);
    assert.equal(calls[0].keepalive, true);
    assert.equal(JSON.parse(calls[0].body).changes.taskUpserts[0].id, serverId);
    const edited = await pending;
    calls = [];
    const deletion = repository.commitChanges({ taskDeletes: [{ id: loaded.id, version: edited.taskUpserts[0].version }] }, { keepalive: true });
    assert.equal(calls.length, 1); assert.equal(locks, 0);
    assert.equal(JSON.parse(calls[0].body).changes.taskDeletes[0].id, serverId);
    await deletion;
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('a late session response cannot reactivate aliases after another account takes the browser', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  const a = createApiRepository({ aliasStorage: shared.client() });
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  try {
    await a.loadSessionContext();
    globalThis.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/session')) { entered(); await held; }
      return response;
    };
    const pending = a.loadSessionContext();
    await started;
    shared.values.set('mergen-rota.actual-id-aliases.v1.active-account', '900001');
    release();
    await assert.rejects(pending, { code: 'UNAUTHORIZED' });
    assert.equal(shared.values.get('mergen-rota.actual-id-aliases.v1.active-account'), '900001');
  } finally { release?.(); globalThis.fetch = fetch; await stack.dispose(); }
});

test('an older server ignoring release cannot authorize replacing an uncertain identity', async (t) => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  let lose = true, issued = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'GET') return fetch(url, init);
    const body = JSON.parse(init.body);
    if (body.operation === 'release-creation-ids') return Response.json({ taskUpserts: [] });
    if (body.operation === 'allocate-creation-ids') issued += 1;
    const response = await fetch(url, init);
    if (!body.operation && lose) { lose = false; throw new TypeError('lost successful response'); }
    return response;
  };
  try {
    const changes = { taskUpserts: [task(randomUUID())] };
    await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
    const old = shared.state().pending[0];
    const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
    t.mock.method(Date, 'now', () => old.allocatedAt + CREATION_ALLOCATION_CLIENT_TTL_MS + 1);
    await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
    assert.equal(issued, 1); assert.equal(stack.db.tasks.length, 2);
    assert.equal(shared.state().pending[0].id, old.id);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('expiry reconciliation retires consumed proofs without stranding a separate uncommitted draft in the same batch', async (t) => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  const a = { taskUpserts: [{ ...task(randomUUID()), task: 'Committed once' }] };
  const b = { taskUpserts: [{ ...task(randomUUID()), task: 'Uncommitted once' }] };
  let phase = 'lost';
  globalThis.fetch = async (url, init) => {
    if (init.method === 'GET' || JSON.parse(init.body).operation) return fetch(url, init);
    if (phase === 'lost') { await fetch(url, init); throw new TypeError('lost successful response'); }
    if (phase === 'not-sent') throw new TypeError('not sent');
    return fetch(url, init);
  };
  try {
    const repository = createApiRepository({ aliasStorage: shared.client() });
    await assert.rejects(repository.commitChanges(a));
    phase = 'not-sent';
    await assert.rejects(repository.commitChanges(b));
    const pending = shared.state().pending;
    assert.equal(pending.length, 2);
    const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
    t.mock.method(Date, 'now', () => Math.max(...pending.map((record) => record.allocatedAt)) + CREATION_ALLOCATION_CLIENT_TTL_MS + 1);
    for (const row of stack.db.creationAllocations) row.ExpiresAt = new Date(0).toISOString();
    phase = 'retry';
    const expiredRepository = createApiRepository({ aliasStorage: shared.client() });
    await assert.rejects(expiredRepository.commitChanges({ taskUpserts: [...a.taskUpserts, ...b.taskUpserts] }),
      (error) => error.details.code === 'CREATION_ALLOCATION_INVALID');
    assert.deepEqual(shared.state().pending, []);
    assert.equal((await expiredRepository.commitChanges(b)).taskUpserts[0].id, b.taskUpserts[0].id);
    assert.equal(stack.db.tasks.filter((row) => row.Title === 'Committed once').length, 1);
    assert.equal(stack.db.tasks.filter((row) => row.Title === 'Uncommitted once').length, 1);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('expired uncommitted project/WBS/task allocations recover as one correctly rebound creation graph', async (t) => {
  const stack = await createActualStack(seed());
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, init) => {
    if (init.method !== 'GET' && !JSON.parse(init.body).operation && fail) { fail = false; throw new TypeError('not sent'); }
    return fetch(url, init);
  };
  try {
    const projectId = randomUUID(), wbsId = randomUUID(), taskId = randomUUID();
    const changes = { projectUpserts: [{ id: projectId, name: 'Expired graph', leadId: '900001', calendarId: DEFAULT_CALENDAR_ID, color: 'blue' }],
      wbsUpserts: [{ id: wbsId, projectId, name: 'Root', code: '1', parentId: null }],
      taskUpserts: [{ ...task(taskId), projectId, wbsId, assigneeIds: ['900001'] }] };
    await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
    assert.equal(shared.state().pending.length, 3);
    const old = shared.state().pending;
    const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
    t.mock.method(Date, 'now', () => old[0].allocatedAt + CREATION_ALLOCATION_CLIENT_TTL_MS + 1);
    for (const row of stack.db.creationAllocations) row.ExpiresAt = new Date(0).toISOString();
    const saved = await createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes);
    assert.equal(saved.projectUpserts[0].id, projectId);
    assert.equal(saved.wbsUpserts[0].projectId, projectId);
    assert.equal(saved.taskUpserts[0].wbsId, wbsId);
    assert.deepEqual(shared.state().pending, []);
    assert.equal(stack.db.tasks.filter((row) => row.Title === 'Allocated task').length, 1);
    assert.ok(old.every((record) => !shared.state().aliases.some(([id]) => id === record.id)));
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('snapshot inbox references open a server-allocated task using its live client identity across reloads', async () => {
  const { sameActualReference } = await import('../src/domain/identity/actualId.js');
  const stack = await createActualStack(seed());
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  try {
    const projectId = randomUUID(), wbsId = randomUUID(), taskId = randomUUID();
    const repository = createApiRepository({ aliasStorage: shared.client() });
    await repository.commitChanges({ projectUpserts: [{ id: projectId, name: 'Inbox project', calendarId: DEFAULT_CALENDAR_ID, leadId: '900001', color: 'blue' }],
      wbsUpserts: [{ id: wbsId, projectId, parentId: null, code: '1', name: 'Root' }],
      taskUpserts: [{ ...task(taskId), projectId, wbsId, assigneeIds: ['900001'] }] });
    const actualTask = stack.actualId(taskId), actualProject = stack.actualId(projectId);
    const row = { id: actualTask, taskId: actualTask, projectId: actualProject, currentProjectId: actualProject,
      taskAvailable: true, requesterSicil: '900001', message: actualTask };
    const collections = ['scheduleRequests', 'assignmentCoordinations', 'taskNotifications'];
    let raw;
    globalThis.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!url.endsWith('/snapshot')) return response;
      raw = { ...(await response.json()), ...Object.fromEntries(collections.map((key) => [key,
        [row, { id: 'unavailable', taskId: null, projectId: null }, { id: 'without-project', taskId: actualTask }]])) };
      return Response.json(raw);
    };
    for (const client of [repository, createApiRepository({ aliasStorage: shared.client() })]) {
      for (const refreshMode of ['initial', 'manual']) {
        const snapshot = await client.loadSnapshot({ refreshMode });
        assert.ok(snapshot.tasks.some((entry) => entry.id === taskId));
        for (const collection of collections) {
          const [item, unavailable, withoutProject] = snapshot[collection];
          assert.ok(snapshot.tasks.some((entry) => sameActualReference(entry.id, item.taskId)), `${collection} opens the accessible task`);
          assert.equal(item.projectId, projectId); assert.equal(item.currentProjectId, projectId);
          assert.equal(item.id, actualTask, 'the inbox row identity belongs to its own namespace');
          assert.equal(item.message, actualTask); assert.equal(item.requesterSicil, '900001');
          assert.equal(unavailable.taskId, null); assert.equal(unavailable.projectId, null);
          assert.equal(Object.hasOwn(withoutProject, 'projectId'), false);
          assert.equal(Object.hasOwn(withoutProject, 'currentProjectId'), false);
        }
        assert.equal(raw.scheduleRequests[0].taskId, actualTask, 'wire payload is not mutated');
      }
    }
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('large alias-heavy commits inspect existing alias values once without changing deduplication', async () => {
  const { restoreActualCommitIds } = await import('../src/data/api/createApiRepository.js');
  class CountedAliases extends Map {
    scans = 0;
    values() { assert.equal(++this.scans, 1, 'bulk ID collection must not repeatedly scan all live aliases'); return super.values(); }
  }
  const aliases = new CountedAliases(Array.from({ length: 10000 }, () => [randomUUID(), `task-${randomUUID()}`]));
  const changes = { taskUpserts: Array.from({ length: 1000 }, () => ({ id: `task-${randomUUID()}`, projectId: `project-${randomUUID()}`,
    wbsId: `wbs-${randomUUID()}`, calendarId: `calendar-${randomUUID()}`, deps: [{ id: `dependency-${randomUUID()}`, predecessorId: `task-${randomUUID()}` }] })),
    wbsUpserts: Array.from({ length: 1000 }, () => ({ id: `wbs-${randomUUID()}`, projectId: `project-${randomUUID()}`, parentId: `wbs-${randomUUID()}` })) };
  restoreActualCommitIds({}, changes, aliases);
  assert.equal(aliases.scans, 1);
  const actual = randomUUID(), other = randomUUID();
  for (const duplicate of [false, true]) {
    const map = new Map([[actual, `project-${actual}`], ...(duplicate ? [[other, `project-${actual}`]] : [])]);
    restoreActualCommitIds({}, { taskUpserts: [{ id: `task-${actual}`, projectId: `project-${actual}` }] }, map);
    assert.equal(map.get(actual), `${duplicate ? 'task' : 'project'}-${actual}`, 'overwritten values are retained only while another mapping still references them');
  }
});

test('fake allocation owner lock is reentrant and preserves competing-transaction rollback snapshots', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const { getSqlPool } = await import('../src/server/db/pool.js');
  const { allocateCreationIds, consumeCreationAllocations } = await import('../src/server/repository/creationAllocations.js');
  const first = new stack.driver.Transaction(await getSqlPool());
  const second = new stack.driver.Transaction(await getSqlPool());
  let consume, waiting;
  try {
    await first.begin('SERIALIZABLE');
    const changes = { taskUpserts: [task()] };
    const issued = await allocateCreationIds(first, { sicil: 900010 }, changes, async () => {});
    const record = issued.allocations[0];
    const prepared = { taskUpserts: [{ ...changes.taskUpserts[0], id: record.id, creationProof: record.proof }] };
    await second.begin('SERIALIZABLE');
    let entered = false;
    waiting = allocateCreationIds(second, { sicil: 900010 }, { taskUpserts: [task()] }, async () => {}).then((value) => { entered = true; return value; });
    await new Promise(setImmediate);
    assert.equal(entered, false, 'a different transaction must wait for the owner');
    let consumed = false;
    consume = consumeCreationAllocations(first, { sicil: 900010 }, prepared).then(() => { consumed = true; });
    await new Promise(setImmediate);
    assert.equal(consumed, true, 'the owner must not await its own release promise');
    await first.rollback();
    await waiting;
    assert.equal(stack.db.creationAllocations.length, 1);
    assert.notEqual(stack.db.creationAllocations[0].Proof.toLowerCase(), record.proof);
    await second.rollback();
    assert.deepEqual(stack.db.creationAllocations, [], 'the waiter snapshots after the first rollback, and repeated owner queries do not resnapshot their own writes');
  } finally {
    first.releaseLocks();
    await waiting?.catch(() => {});
    second.releaseLocks();
    await consume?.catch(() => {});
    first.releaseLocks();
    await stack.dispose();
  }
});

for (const clientPath of ['../src/features/shared/jsonRequest.js', '../src/data/api/scheduleChangeClient.js']) {
  test(`feature account transitions preserve the request/result boundary (${clientPath})`, async () => {
    const { activateActualIdAliases } = await import('../src/data/api/activeActualIdAliases.js');
    const { actualIdAliasType } = await import('../src/data/api/actualIdAliasStorage.js');
    const { AppRepositoryError } = await import('../src/data/contracts/appRepository.js');
    const { requestJson } = await import(clientPath);
    const id = randomUUID(), client = `project-${randomUUID()}`, aliases = new Map([[id, client]]);
    actualIdAliasType(aliases, id, 'PROJECT');
    let current = false, calls = 0;
    const guard = () => { if (!current) throw new AppRepositoryError({ code: 'UNAUTHORIZED', message: 'Account changed' }); };
    activateActualIdAliases(aliases, guard);
    const fetch = globalThis.fetch;
    const body = { currentProjectId: id, projectId: id, message: id };
    try {
      globalThis.fetch = async () => { calls += 1; return Response.json(body); };
      assert.deepEqual(await requestJson('/api/mergen-rota/schedule-changes', { method: 'POST', body: '{}' }),
        { ok: false, code: 'UNAUTHORIZED', message: 'Account changed' });
      assert.equal(calls, 0, 'account mismatch cannot issue a network mutation');
      current = true;
      const success = await requestJson('/api/mergen-rota/schedule-changes', { method: 'POST', body: '{}' });
      const restored = success.value || success;
      assert.equal(restored.currentProjectId, client); assert.equal(restored.projectId, client);
      assert.equal(restored.message, id, 'non-entity fields are not rewritten');
      globalThis.fetch = async () => { calls += 1; current = false; return Response.json(body); };
      const changed = await requestJson('/api/mergen-rota/schedule-changes', { method: 'POST', body: '{}' });
      assert.equal(changed.ok, true, 'an applied mutation remains successful');
      assert.equal((changed.value || changed).currentProjectId, id);
      assert.equal(calls, 2);
    } finally { globalThis.fetch = fetch; activateActualIdAliases(new Map()); }
  });
}

test('creation storage preserves the unauthorized account error raised inside its lock', async () => {
  const { createCreationIdStorage } = await import('../src/data/api/creationIdStorage.js');
  const { AppRepositoryError } = await import('../src/data/contracts/appRepository.js');
  const error = new AppRepositoryError({ code: 'UNAUTHORIZED', message: 'Account changed' });
  const store = createCreationIdStorage(null, undefined, { accountId: '900001', validateAccount() { throw error; } });
  for (const changes of [{ taskUpserts: [task()] }, { taskDeletes: [{ id: randomUUID(), version: 'version' }] }]) {
    await assert.rejects(store.prepare(changes, new Map()), (received) => received === error);
  }
});

test('release response loss and expiry cleanup retain a bound retry receipt without replaying consumption', async (t) => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  const changes = { taskUpserts: [task(`task-${randomUUID()}`)] };
  let phase = 'not-sent', releaseAttempts = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'GET') return fetch(url, init);
    const body = JSON.parse(init.body);
    if (!body.operation && phase === 'not-sent') throw new TypeError('mutation not sent');
    const response = await fetch(url, init);
    if (body.operation === 'release-creation-ids' && ++releaseAttempts === 1) throw new TypeError('release response lost');
    return response;
  };
  try {
    const repository = createApiRepository({ aliasStorage: shared.client() });
    await assert.rejects(repository.commitChanges(changes));
    const old = shared.state().pending[0];
    const { CREATION_ALLOCATION_CLIENT_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
    t.mock.method(Date, 'now', () => old.allocatedAt + CREATION_ALLOCATION_CLIENT_TTL_MS + 1);
    stack.db.creationAllocations[0].ExpiresAt = new Date(new Date().getTime() - 1000).toISOString();
    // Another reservation runs normal expiry cleanup before the old draft resumes.
    await allocate({ taskUpserts: [task()] });
    assert.ok(stack.db.creationAllocations.some((row) => row.Proof.toLowerCase() === old.proof));
    phase = 'retry';
    await assert.rejects(createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes));
    assert.equal(shared.state().pending[0].proof, old.proof);
    assert.equal(releaseAttempts, 1, 'the first release lost only its response');
    const saved = await createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes);
    assert.equal(saved.taskUpserts[0].id, changes.taskUpserts[0].id);
    assert.equal(releaseAttempts, 2); assert.deepEqual(shared.state().pending, []);
    assert.equal(stack.db.tasks.filter((row) => row.Title === 'Allocated task').length, 1);
    const oldChanges = { taskUpserts: [{ ...task(old.id), creationProof: old.proof }] };
    assert.deepEqual((await post(oldChanges, 'release-creation-ids')).body.released, [{ id: old.id, entityType: 'TASK' }]);
    assert.equal((await post(oldChanges)).status, 409, 'released receipt cannot be consumed');
    for (const altered of [{ ...oldChanges.taskUpserts[0], id: randomUUID() },
      { ...oldChanges.taskUpserts[0], projectId: HIDDEN_PROJECT }, { ...oldChanges.taskUpserts[0], creationProof: randomUUID() }]) {
      assert.deepEqual((await post({ taskUpserts: [altered] }, 'release-creation-ids')).body.released, []);
    }
    assert.deepEqual((await post({ wbsUpserts: [{ ...oldChanges.taskUpserts[0], parentId: null, code: '2', name: 'wrong type' }] }, 'release-creation-ids')).body.released, []);
    process.env.MERGEN_ROTA_DEV_SICIL = '900001';
    assert.deepEqual((await post(oldChanges, 'release-creation-ids')).body.released, [], 'receipt remains private to its caller');
    process.env.MERGEN_ROTA_DEV_SICIL = '900010';
    const consumed = await allocate({ taskUpserts: [task()] });
    assert.equal((await post(consumed.changes)).status, 200);
    assert.deepEqual((await post(consumed.changes, 'release-creation-ids')).body.released, [], 'consumed proof never becomes releasable');
    assert.equal((await post(consumed.changes)).status, 409);
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('expired abandoned local proofs free capacity while referenced drafts and typed aliases stay protected', async () => {
  const { createCreationIdStorage, CREATION_ALLOCATION_SERVER_TTL_MS } = await import('../src/data/api/creationIdStorage.js');
  const { MAX_ACTUAL_ID_ALIASES } = await import('../src/data/api/actualIdAliasStorage.js');
  const shared = sharedCreationStorage(), now = Date.now();
  const records = Array.from({ length: MAX_ACTUAL_ID_ALIASES }, () => ({ clientId: randomUUID(), id: randomUUID(), proof: randomUUID(),
    projectId: CORPORATE_PROJECT_ID.toLowerCase(), entityType: 'TASK', allocatedAt: now - CREATION_ALLOCATION_SERVER_TTL_MS - 1 }));
  shared.values.set('mergen-rota.actual-id-aliases.v1.account.900001.creations.v1', JSON.stringify({ version: 2, pending: records,
    aliases: records.map((row) => [row.id, row.clientId, row.entityType]) }));
  const store = createCreationIdStorage(shared.client(), undefined, { accountId: '900001', now: () => now });
  const aliases = new Map(); store.restoreAliases(aliases);
  // An existing expired draft must go through server reconciliation, never replacement.
  await assert.rejects(store.prepare({ taskUpserts: [task(records[0].clientId)] }, aliases));
  assert.equal(shared.state().pending.length, MAX_ACTUAL_ID_ALIASES);
  await store.prepare({ taskUpserts: [{ ...task(), deps: [{ predecessorId: records[0].clientId, type: 'FS' }] }] }, aliases);
  assert.equal(shared.state().pending.length, 1, 'references in the operation protect an expired draft record');
  assert.equal(shared.state().pending[0].proof, records[0].proof);
  assert.equal((await store.prepare({ taskUpserts: [task()] }, aliases)).taskUpserts.length, 1);
  assert.equal(shared.state().pending.length, 0);
  assert.ok(shared.state().aliases.some(([id]) => id === records[0].id));
  await assert.rejects(store.prepare({ taskUpserts: [task(records[0].clientId)] }, aliases),
    (error) => error.details.code === 'CREATION_ALLOCATION_STORAGE');
});

for (const clientPath of ['../src/features/shared/jsonRequest.js', '../src/data/api/scheduleChangeClient.js']) {
  test(`stale reads discard the previous account response (${clientPath})`, async () => {
    const { activateActualIdAliases } = await import('../src/data/api/activeActualIdAliases.js');
    const { requestJson } = await import(clientPath);
    const fetch = globalThis.fetch;
    let current = true;
    const guard = () => { if (!current) throw { code: 'UNAUTHORIZED', message: 'Account changed' }; };
    try {
      for (const method of [undefined, 'GET', 'HEAD']) {
        for (const replaceGuard of [false, true]) {
          current = true; activateActualIdAliases(new Map(), guard);
          globalThis.fetch = async () => {
            current = false;
            if (replaceGuard) activateActualIdAliases(new Map(), () => {});
            return Response.json({ content: 'private previous-account text' });
          };
          const result = await requestJson('/api/mergen-rota/ai/assistant/conversations/private', { method });
          assert.equal(result.ok, false); assert.equal(result.code, 'UNAUTHORIZED');
          assert.equal(JSON.stringify(result).includes('private previous-account text'), false);
        }
      }
      let owner = 'A';
      const sameGuard = () => owner;
      activateActualIdAliases(new Map(), sameGuard);
      globalThis.fetch = async () => { owner = 'B'; return Response.json({ content: 'private previous-account text' }); };
      const rebound = await requestJson('/api/mergen-rota/ai/assistant/conversations/private', { method: 'GET' });
      assert.equal(rebound.ok, false); assert.equal(rebound.code, 'UNAUTHORIZED');
      assert.equal(JSON.stringify(rebound).includes('private previous-account text'), false);
    } finally { globalThis.fetch = fetch; activateActualIdAliases(new Map()); }
  });
}

test('missing durable storage rejects creation before allocation while canonical versioned edits still work', async () => {
  const stack = await createActualStack(seed());
  try {
    const repository = createApiRepository();
    await assert.rejects(repository.commitChanges({ taskUpserts: [task()] }),
      (error) => error.details.code === 'CREATION_ALLOCATION_STORAGE');
    assert.equal(stack.db.creationAllocations.length, 0);
    assert.equal(stack.db.tasks.length, 1);
    const snapshot = await repository.loadSnapshot();
    const existing = snapshot.tasks.find((row) => row.id === HIDDEN_TASK);
    await repository.commitChanges({ taskUpserts: [{ ...existing, task: 'Still editable' }] });
    assert.equal(stack.db.tasks[0].Title, 'Still editable');
  } finally { await stack.dispose(); }
});

test('competing tabs release the unused reservation for the same draft without duplicating the task', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), fetch = globalThis.fetch;
  let allocated = 0, release;
  const bothAllocated = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (init.method !== 'GET' && JSON.parse(init.body).operation === 'allocate-creation-ids') {
      if (++allocated === 2) release();
      await bothAllocated;
    }
    return response;
  };
  try {
    const changes = { taskUpserts: [task()] };
    const results = await Promise.allSettled([createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes),
      createApiRepository({ aliasStorage: shared.client() }).commitChanges(changes)]);
    assert.ok(results.some((result) => result.status === 'fulfilled'));
    assert.equal(allocated, 2);
    assert.equal(stack.db.tasks.filter((row) => row.Title === 'Allocated task').length, 1);
    assert.equal(stack.db.creationAllocations.filter((row) => new Date(row.ExpiresAt) > new Date()).length, 0);
    assert.equal(stack.db.creationAllocations.length, 1, 'the unused proof remains only as a released retry receipt');
  } finally { globalThis.fetch = fetch; await stack.dispose(); }
});

test('proof write failure releases untracked server reservations before retry', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  const shared = sharedCreationStorage(), storage = shared.client();
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith('.creations.v1') && JSON.parse(value).pending.length) throw new Error('quota');
    setItem(key, value);
  };
  try {
    await assert.rejects(createApiRepository({ aliasStorage: storage }).commitChanges({ taskUpserts: [task()] }));
    assert.equal(stack.db.creationAllocations.length, 1);
    assert.ok(new Date(stack.db.creationAllocations[0].ExpiresAt) < new Date());
    assert.equal(stack.db.tasks.length, 1);
    assert.deepEqual(shared.state().pending, []);
  } finally { await stack.dispose(); }
});

test('retained release receipts share a bounded caller quota without reducing active capacity or crossing owners', async () => {
  const stack = await createActualStack(seed(), { sicil: 900010 });
  try {
    const { allocateCreationIds } = await import('../src/server/repository/creationAllocations.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const receipt = () => ({ Proof: randomUUID(), EntityId: randomUUID(), EntityType: 'TASK', ProjectId: CORPORATE_PROJECT_ID,
      Sicil: 900010, ExpiresAt: new Date(Date.now() - 1000).toISOString() });
    stack.db.creationAllocations = Array.from({ length: 15999 }, receipt);
    const transaction = new stack.driver.Transaction(await getSqlPool());
    await transaction.begin('SERIALIZABLE');
    await allocateCreationIds(transaction, { sicil: 900010 }, { taskUpserts: [task()] }, async () => {});
    await transaction.commit();
    assert.equal(stack.db.creationAllocations.length, 16000);
    const full = await post({ taskUpserts: [task()] }, 'allocate-creation-ids');
    assert.equal(full.status, 409); assert.equal(full.body.error.details.code, 'CREATION_ALLOCATION_LIMIT');
    stack.db.creationAllocations[0].ExpiresAt = new Date(Date.now() - 8 * 86400000).toISOString();
    await allocate({ taskUpserts: [task()] });
    process.env.MERGEN_ROTA_DEV_SICIL = '900001';
    await allocate({ taskUpserts: [task()] });
    const reserve = stack.db.statements.find(({ sql }) => sql.includes('-- creation-allocation: reserve')).sql;
    assert.match(reserve, /@retained.*COUNT\(\*\).*Sicil = @sicil/);
    assert.match(reserve, /@retained \+.*> @pendingLimit \* 4/);
    assert.match(reserve, /WITH \(UPDLOCK, HOLDLOCK\)/);
  } finally { await stack.dispose(); }
});

test('large creation batches traverse maps linearly inside the storage critical section', async (t) => {
  const { createCreationIdStorage } = await import('../src/data/api/creationIdStorage.js');
  const shared = sharedCreationStorage(), storage = shared.client(), aliases = new Map();
  const store = createCreationIdStorage(storage, undefined, { accountId: '900001' });
  const records = Array.from({ length: 1200 }, () => ({ clientId: randomUUID(), id: randomUUID(), proof: randomUUID(),
    projectId: CORPORATE_PROJECT_ID.toLowerCase(), entityType: 'TASK' }));
  await store.remember(records, aliases, { taskUpserts: records.map((row) => task(row.clientId)) });
  const more = Array.from({ length: 1000 }, () => ({ clientId: randomUUID(), id: randomUUID(), proof: randomUUID(),
    projectId: CORPORATE_PROJECT_ID.toLowerCase(), entityType: 'TASK' }));
  const changes = { taskUpserts: more.map((row) => task(row.clientId)) };
  let visited = 0;
  for (const key of [Symbol.iterator, 'values']) {
    const original = Map.prototype[key];
    t.mock.method(Map.prototype, key, function* () { for (const item of original.call(this)) { visited += 1; yield item; } });
  }
  await store.reconciliationRecords(changes, aliases);
  await store.prepare(changes, aliases);
  await store.remember(more, aliases, changes);
  const prepared = await store.prepare(changes, aliases);
  assert.equal(prepared.taskUpserts.length, 1000);
  assert.ok(prepared.taskUpserts.every((entry) => entry.creationProof));
  assert.ok(visited < 250000, `bounded linear traversals, observed ${visited} map entries`);
});
