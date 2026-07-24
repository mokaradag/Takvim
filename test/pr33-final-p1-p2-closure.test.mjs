import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createApiRepository,
  normalizeActualChanges
} from '../src/data/api/createApiRepository.js';
import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PREDECESSOR_ID = '33333333-3333-4333-8333-333333333333';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function versionedTask(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    version: 'AQIDBAUGBwg=',
    task: 'Versioned task',
    status: 'todo',
    assigneeIds: ['18068'],
    ...overrides
  };
}

test('Actual normalization preserves omitted dependencies so versioned partial updates are rejected', () => {
  const changes = normalizeActualChanges({ taskUpserts: [versionedTask()] });
  const task = changes.taskUpserts[0];

  assert.equal(task.deps, undefined);
  assert.equal(task.status, 'planned');

  const issue = findNestedCommitCollectionIssue(changes);
  assert.equal(issue?.code, 'TASK_DEPENDENCIES_REQUIRED_FOR_UPDATE');
  assert.equal(issue?.path, 'taskUpserts[0].deps');
});

test('Actual normalization preserves malformed dependency collections for deterministic API validation', () => {
  const changes = normalizeActualChanges({ taskUpserts: [versionedTask({ deps: null })] });

  assert.equal(changes.taskUpserts[0].deps, null);
  const issue = findNestedCommitCollectionIssue(changes);
  assert.equal(issue?.code, 'TASK_DEPENDENCIES_NOT_ARRAY');
});

test('Actual repository forwards malformed dependency shapes to the server boundary instead of failing locally', async () => {
  const originalFetch = globalThis.fetch;
  let postedBody = null;
  globalThis.fetch = async (_url, init) => {
    postedBody = JSON.parse(init.body);
    return {
      ok: false,
      status: 400,
      async json() {
        return {
          error: {
            code: 'MUTATION_FAILED',
            message: 'Görev bağımlılıkları dizi olmalıdır.',
            details: { code: 'TASK_DEPENDENCIES_NOT_ARRAY' }
          }
        };
      }
    };
  };

  try {
    const repository = createApiRepository();
    await assert.rejects(
      repository.commitChanges({
        taskUpserts: [versionedTask({ deps: { predecessorId: PREDECESSOR_ID } })]
      }),
      (error) => error?.details?.code === 'TASK_DEPENDENCIES_NOT_ARRAY'
    );
    assert.deepEqual(postedBody?.changes?.taskUpserts?.[0]?.deps, {
      predecessorId: PREDECESSOR_ID
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Actual normalization still canonicalizes valid dependency references', () => {
  const changes = normalizeActualChanges({
    taskUpserts: [versionedTask({
      deps: [{
        predecessorId: PREDECESSOR_ID.toUpperCase(),
        type: 'FS',
        lagDays: 0
      }]
    })]
  });

  assert.deepEqual(changes.taskUpserts[0].deps, [{
    predecessorId: PREDECESSOR_ID,
    type: 'FS',
    lagDays: 0
  }]);
  assert.equal(findNestedCommitCollectionIssue(changes), null);
});

test('Actual session route reads all capabilities inside a serializable transaction', () => {
  const route = read('src/app/api/mergen-rota/session/route.js');

  assert.match(route, /import \{ sql, withSqlTransaction \} from '\.\.\/\.\.\/\.\.\/\.\.\/server\/db\/pool\.js';/);
  assert.match(
    route,
    /withSqlTransaction\([\s\S]*createSqlAppRepository\(\)\.loadSessionContext\(\)[\s\S]*isolationLevel:\s*sql\.ISOLATION_LEVEL\.SERIALIZABLE/
  );
});
