import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDependencyCycle } from '../src/server/repository/dependencyGraphValidation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('dependency cycle detection accepts a directed acyclic project network', () => {
  const cycle = findDependencyCycle([
    { predecessorId: 'a', taskId: 'b' },
    { predecessorId: 'a', taskId: 'c' },
    { predecessorId: 'b', taskId: 'd' },
    { predecessorId: 'c', taskId: 'd' }
  ]);
  assert.deepEqual(cycle, []);
});

test('dependency cycle detection returns only the tasks in a persisted cycle', () => {
  const cycle = findDependencyCycle([
    { PredecessorTaskId: 'a', TaskId: 'b' },
    { PredecessorTaskId: 'b', TaskId: 'c' },
    { PredecessorTaskId: 'c', TaskId: 'a' },
    { PredecessorTaskId: 'c', TaskId: 'downstream' }
  ]);
  assert.deepEqual(new Set(cycle), new Set(['a', 'b', 'c']));
  assert.equal(cycle.includes('downstream'), false);
});

test('nested SQL repository work reuses the outer transaction', () => {
  const source = read('src/server/db/pool.js');
  assert.match(source, /const transactionContext = new AsyncLocalStorage\(\);/);
  assert.match(source, /const activeTransaction = transactionContext\.getStore\(\);/);
  assert.match(source, /if \(activeTransaction\) return work\(activeTransaction, sql\);/);
  assert.match(source, /return await transactionContext\.run\(transaction, async \(\) => \{/);
});

test('Actual commits lock and preserve the single-root WBS invariant', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_WBS WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE ProjectId = @projectId/s
  );
  assert.match(source, /if \(roots\.length !== 1\)/);
  assert.match(source, /if \(existingRoots\.length === 1 && roots\[0\]\.id !== existingRoots\[0\]\)/);
});

test('Actual commits validate the final dependency graph under transaction locks', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_TaskDependencies WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE ProjectId = @projectId/s
  );
  assert.match(source, /projectEdges\.set\(previousProjectId, removeTaskEdges/);
  assert.match(source, /projectEdges\.set\(projectId, removeTaskEdges/);
  assert.match(source, /const cycleTaskIds = findDependencyCycle\(projectEdges\.get\(projectId\) \|\| \[\]\);/);
  assert.match(source, /return withSqlTransaction\(async \(transaction\) => \{\s+await assertIntegrity\(transaction, changes\);\s+return baseRepository\.commitChanges\(input\);/s);
});

test('Project and Task writes accept only active calendar references', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_Calendars WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE CalendarId = @calendarId AND IsActive = 1/s
  );
  assert.match(source, /for \(const entity of \[\.\.\.changes\.projectUpserts, \.\.\.changes\.taskUpserts\]\)/);
});

test('the commit API uses the hardened SQL repository boundary', () => {
  const source = read('src/app/api/mergen-rota/commit/route.js');
  assert.match(source, /createHardenedSqlAppRepository/);
  assert.doesNotMatch(source, /createSqlAppRepository/);
});
