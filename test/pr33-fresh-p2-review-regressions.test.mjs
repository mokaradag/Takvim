import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTaskPatchCoalescer, loadApplicationData } from '../src/state/persistence.js';

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
    currentUser: { id: '18068', name: 'Test User' },
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

test('task-derived session access excludes inactive projects', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(
    source,
    /FROM dbo\.MR_Tasks t\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId AND p\.IsActive = 1\s+JOIN dbo\.MR_TaskAssignees ta ON ta\.TaskId = t\.TaskId/s
  );
});
