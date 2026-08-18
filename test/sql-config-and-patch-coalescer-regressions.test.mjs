import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApiRepository } from '../src/data/api/createApiRepository.js';
import { createTaskPatchCoalescer, loadApplicationData } from '../src/state/persistence.js';
import { prepareProjectUpdate } from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function emptySnapshot() {
  return {
    calendars: [],
    projects: [],
    people: [],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() { return body; }
  };
}

test('SQL numeric configuration requires complete decimal values and a valid TCP port', () => {
  const source = read('src/server/db/config.js');
  assert.doesNotMatch(source, /Number\.parseInt/);
  assert.match(source, /const normalized = raw\.trim\(\);/);
  assert.match(source, /!\/\^\\d\+\$\/\.test\(normalized\)/);
  assert.match(source, /!Number\.isSafeInteger\(value\)/);
  assert.match(source, /port: integerValue\('MERGEN_ROTA_DB_PORT', 1433, \{ max: 65535 \}\)/);
});

test('application loading waits for snapshot synchronization before reading session capabilities', async () => {
  let synchronized = false;
  let sessionObservedSynchronized = null;
  const events = [];
  const session = {
    dataMode: 'actual',
    currentUser: { id: '900002', name: 'Test User' },
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: [{ projectId: 'project-1', accessLevel: 'FULL' }]
  };

  const result = await loadApplicationData({
    kind: 'actual-api',
    async loadSnapshot() {
      events.push('snapshot:start');
      await new Promise((resolve) => setTimeout(resolve, 0));
      synchronized = true;
      events.push('snapshot:end');
      return emptySnapshot();
    },
    async loadSessionContext() {
      events.push('session');
      sessionObservedSynchronized = synchronized;
      return session;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(sessionObservedSynchronized, true);
  assert.deepEqual(events, ['snapshot:start', 'snapshot:end', 'session']);
  assert.deepEqual(result.snapshot.session, session);
});

test('disposing a task patch coalescer settles every pending caller with a failure', async () => {
  const coalescer = createTaskPatchCoalescer(async () => {
    throw new Error('flush should not run after disposal');
  }, { delayMs: 60_000 });

  const first = coalescer.schedule('task-1', { description: 'pending' });
  const second = coalescer.schedule('task-1', { progress: 50 });
  coalescer.dispose();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'persistence');
    assert.equal(result.error.code, 'MUTATION_FAILED');
    assert.equal(result.error.operation, 'task/update');
  }
});

test('a disposed task patch coalescer rejects stale updates immediately', async () => {
  const coalescer = createTaskPatchCoalescer(async () => ({ ok: true }), { delayMs: 60_000 });
  coalescer.dispose();

  const result = await coalescer.schedule('task-stale', { progress: 75 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MUTATION_FAILED');
  assert.equal(result.error.operation, 'task/update');
});

test('flushAll drains edits queued while an earlier coalesced edit is being persisted', async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    calls.push({ taskId, patch });
    if (calls.length === 1) {
      markFirstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { ok: true, value: patch };
  }, { delayMs: 60_000 });

  const first = coalescer.schedule('task-1', { description: 'first' });
  const draining = coalescer.flushAll();
  await firstStarted;
  const second = coalescer.schedule('task-1', { progress: 25 });
  releaseFirst();

  const [results, firstResult, secondResult] = await Promise.all([draining, first, second]);
  assert.equal(results.length, 2);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(calls, [
    { taskId: 'task-1', patch: { description: 'first' } },
    { taskId: 'task-1', patch: { progress: 25 } }
  ]);
});

test('Actual repository restores persistent aliases in session and baseline references', async () => {
  const projectUuid = '11111111-1111-4111-8111-111111111111';
  const taskUuid = '22222222-2222-4222-8222-222222222222';
  const projectId = `project-${projectUuid}`;
  const taskId = `task-${taskUuid}`;
  const responses = [
    {
      projectUpserts: [{ id: projectUuid, calendarId: null }],
      projectDeletes: [],
      wbsUpserts: [],
      wbsDeletes: [],
      taskUpserts: [{ id: taskUuid, projectId: projectUuid, wbsId: null, calendarId: null, status: 'planned', deps: [] }],
      taskDeletes: []
    },
    {
      dataMode: 'actual',
      currentUser: { id: '900002' },
      projectAccess: [{ projectId: projectUuid, accessLevel: 'FULL' }]
    },
    {
      ...emptySnapshot(),
      projects: [{ id: projectUuid, calendarId: null }],
      baselines: [{ id: 'baseline-1', projectId: projectUuid }],
      taskBaselineSnapshots: [{ baselineId: 'baseline-1', taskId: taskUuid, calendarId: null }]
    }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(responses.shift());

  try {
    const repository = createApiRepository({ basePath: '/test-api' });
    const committed = await repository.commitChanges({
      projectUpserts: [{ id: projectId, calendarId: null }],
      taskUpserts: [{ id: taskId, projectId, wbsId: null, calendarId: null, status: 'todo', deps: [] }]
    });
    assert.equal(committed.projectUpserts[0].id, projectId);
    assert.equal(committed.taskUpserts[0].id, taskId);

    const session = await repository.loadSessionContext();
    assert.equal(session.projectAccess[0].projectId, projectId);

    const snapshot = await repository.loadSnapshot();
    assert.equal(snapshot.projects[0].id, projectId);
    assert.equal(snapshot.baselines[0].projectId, projectId);
    assert.equal(snapshot.taskBaselineSnapshots[0].taskId, taskId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project updates honor an explicitly selected calendar', () => {
  const context = {
    projects: [{
      id: 'project-1',
      name: 'Project One',
      code: 'P-1',
      source: 'manual',
      leadId: '100',
      lead: 'Lead',
      calendarId: 'calendar-old',
      dataDate: '2026-07-24',
      color: 'blue',
      tags: []
    }],
    people: [{ id: '100', name: 'Lead' }],
    calendars: [{ id: 'calendar-old' }, { id: 'calendar-new' }]
  };

  const result = prepareProjectUpdate('project-1', { calendarId: 'calendar-new' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.project.calendarId, 'calendar-new');
});

test('task-derived session access excludes inactive projects', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(
    source,
    /FROM dbo\.MR_Tasks t\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId AND p\.IsActive = 1\s+JOIN dbo\.MR_TaskAssignees ta ON ta\.TaskId = t\.TaskId/s
  );
});
