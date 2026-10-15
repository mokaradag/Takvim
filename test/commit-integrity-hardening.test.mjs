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
  assert.match(source, /const result = await transactionContext\.run\(transaction, async \(\) => \{/);
});

test('Actual commits lock and preserve the single-root WBS invariant', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_WBS WITH \(READCOMMITTED\)\s+WHERE ProjectId = @projectId/s
  );
  assert.match(source, /if \(roots\.length !== 1\)/);
  assert.match(source, /if \(existingRoots\.length === 1 && roots\[0\]\.id !== existingRoots\[0\]\)/);
});

test('Actual commits share one locked final-graph validator and forward verified context', () => {
  const preparation = read('src/server/repository/taskDependencyAccess.js');
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(preparation, /reconcileDependencyGraph\(/);
  assert.match(source, /const scopedChanges = input\?\.\[TASK_DEPENDENCY_CONTEXT\] \? changes : await prepareScopedTaskDependencies/);
  assert.match(source, /const plannedChanges = await planIntegrity\(transaction, scopedChanges\);/);
  assert.match(source, /return baseRepository\.commitChanges\(plannedChanges\);/);
  assert.match(source, /if \(input\?\.notifyAssignees === true\) plannedChanges\.notifyAssignees = true;/);
});

test('recurrence occurrence creation locks the template in the same hardened transaction', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(source, /recurrenceParentId:\s*task\.recurrenceParentId\s*\?\s*uuid\(task\.recurrenceParentId, 'Tekrar şablonu kimliği'\)/);
  const locks = read('src/server/repository/commitResourceLocks.js');
  assert.match(locks, /const parentIds = ids\(upserts\.flatMap/);
  assert.match(locks, /parentIds\.filter\(\(value\) => !writeTasks\.includes\(value\)\)/);
  assert.match(locks, /commit-task-lock/);
});

test('Project writes require a calendar and all supplied calendar references must be active', () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_Calendars WITH \(HOLDLOCK\)\s+WHERE CalendarId = @calendarId AND IsActive = 1/s
  );
  assert.match(source, /for \(const project of changes\.projectUpserts\) \{/);
  assert.match(source, /if \(!project\.calendarId\) \{/);
  assert.match(source, /calendarIds\.add\(uuid\(project\.calendarId, 'Takvim kimliği'\)\);/);
  assert.match(source, /for \(const task of changes\.taskUpserts\) \{/);
  assert.match(source, /if \(task\.calendarId\) calendarIds\.add\(uuid\(task\.calendarId, 'Takvim kimliği'\)\);/);
});

test('the commit API preserves WBS ordering before the hardened SQL boundary', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const wrapper = read('src/server/repository/orderedSqlAppRepository.js');

  assert.match(route, /createOrderedSqlAppRepository/);
  assert.doesNotMatch(route, /createSqlAppRepository/);
  assert.match(wrapper, /createHardenedSqlAppRepository/);
  assert.match(wrapper, /orderWbsUpsertsByParents/);
});
