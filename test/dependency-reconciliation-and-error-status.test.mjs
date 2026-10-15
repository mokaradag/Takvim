import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerPersistenceError } from '../src/server/errors.js';

test('known mutation rejections default to HTTP 400 while unknown failures remain server errors', () => {
  assert.equal(new ServerPersistenceError('MUTATION_FAILED', 'invalid').status, 400);
  assert.equal(new ServerPersistenceError('CONFLICT', 'stale').status, 409);
  assert.equal(new ServerPersistenceError('INTERNAL_FAILURE', 'internal').status, 500);
});
