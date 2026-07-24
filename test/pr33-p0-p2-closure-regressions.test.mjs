import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  fromPersistenceStatus,
  toPersistenceStatus
} from '../src/data/api/createApiRepository.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Actual-mode task statuses round-trip through the canonical UI state model', () => {
  assert.equal(toPersistenceStatus('todo'), 'planned');
  assert.equal(toPersistenceStatus('in_progress'), 'in-progress');
  assert.equal(toPersistenceStatus('done'), 'done');

  assert.equal(fromPersistenceStatus('planned'), 'todo');
  assert.equal(fromPersistenceStatus('not-started'), 'todo');
  assert.equal(fromPersistenceStatus('in-progress'), 'in_progress');
  assert.equal(fromPersistenceStatus('blocked'), 'in_progress');
  assert.equal(fromPersistenceStatus('done'), 'done');
  assert.equal(fromPersistenceStatus('completed'), 'done');
  assert.equal(fromPersistenceStatus('cancelled'), 'done');
});

test('commit validation only accepts statuses the Actual-mode client can persist canonically', () => {
  for (const status of ['planned', 'in-progress', 'done']) {
    assert.equal(findCommitScalarIssue({ taskUpserts: [{ task: 'Task', status }] }), null);
  }

  for (const status of ['blocked', 'cancelled', 'not-started', 'completed']) {
    assert.equal(
      findCommitScalarIssue({ taskUpserts: [{ task: 'Task', status }] })?.code,
      'TASK_STATUS_INVALID'
    );
  }
});

test('manual project code collisions are locked and rejected before SQL writes', () => {
  const source = read('src/server/repository/orderedSqlAppRepository.js');
  const guardPosition = source.indexOf('assertManualProjectCodesAvailable(transaction, orderedChanges)');
  const commitPosition = source.indexOf('repository.commitChanges(orderedChanges)');

  assert.match(source, /FROM dbo\.MR_Projects WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(source, /WHERE ProjectId <> @projectId AND ProjectCode = @projectCode/);
  assert.match(source, /PROJECT_CODE_RESERVED/);
  assert.match(source, /PROJECT_CODE_CONFLICT/);
  assert.match(source, /new ServerPersistenceError\('CONFLICT'/);
  assert.ok(guardPosition >= 0);
  assert.ok(commitPosition > guardPosition);
});
