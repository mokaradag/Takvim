import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fromPersistenceStatus,
  toActualUuid,
  toPersistenceStatus
} from '../src/data/api/createApiRepository.js';

test('Actual mode strips local creation prefixes and keeps valid UUIDs', () => {
  const value = 'task-2d9f0b82-bf72-4b9d-b44e-21506f486697';
  assert.equal(toActualUuid(value), '2d9f0b82-bf72-4b9d-b44e-21506f486697');
  assert.equal(toActualUuid('2d9f0b82-bf72-4b9d-b44e-21506f486697'), '2d9f0b82-bf72-4b9d-b44e-21506f486697');
  assert.equal(toActualUuid(null), null);
});

test('current Task status vocabulary round-trips through SQL boundary', () => {
  assert.equal(toPersistenceStatus('todo'), 'planned');
  assert.equal(toPersistenceStatus('in_progress'), 'in-progress');
  assert.equal(toPersistenceStatus('done'), 'done');
  assert.equal(fromPersistenceStatus('planned'), 'todo');
  assert.equal(fromPersistenceStatus('in-progress'), 'in_progress');
  assert.equal(fromPersistenceStatus('done'), 'done');
});
