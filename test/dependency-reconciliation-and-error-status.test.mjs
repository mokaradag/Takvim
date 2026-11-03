import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ServerPersistenceError } from '../src/server/errors.js';
import { findTaskDependencyReconciliationIssue } from '../src/server/repository/dependencyReconciliationPolicy.js';

const PREDECESSOR_ID = '11111111-1111-4111-8111-111111111111';
const SUCCESSOR_A_ID = '22222222-2222-4222-8222-222222222222';
const SUCCESSOR_B_ID = '33333333-3333-4333-8333-333333333333';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test("öncül geçersizleştirme kalan her ardılın uzlaştırılmasını ister", () => {
  const issue = findTaskDependencyReconciliationIssue({
    invalidatedPredecessorIds: new Set([PREDECESSOR_ID]),
    incomingTaskIdsByPredecessor: new Map([
      [PREDECESSOR_ID, [SUCCESSOR_B_ID, SUCCESSOR_A_ID]]
    ]),
    taskUpsertIds: [SUCCESSOR_A_ID],
    taskDeleteIds: []
  });

  assert.equal(issue?.code, 'TASK_DEPENDENCY_RECONCILIATION_REQUIRED');
  assert.equal(issue?.predecessorId, PREDECESSOR_ID);
  assert.deepEqual(issue?.taskIds, [SUCCESSOR_B_ID]);
});

test("açık ardıl değiştirme veya silme bağımlılık uzlaştırmasını karşılar", () => {
  const issue = findTaskDependencyReconciliationIssue({
    invalidatedPredecessorIds: [PREDECESSOR_ID],
    incomingTaskIdsByPredecessor: {
      [PREDECESSOR_ID]: [SUCCESSOR_A_ID, SUCCESSOR_B_ID]
    },
    taskUpsertIds: [SUCCESSOR_A_ID],
    taskDeleteIds: [SUCCESSOR_B_ID]
  });

  assert.equal(issue, null);
});

test("sıralı SQL kalıcılığı bağımlılık uzlaştırmasını yazmadan önce kilitler ve doğrular", () => {
  const validation = read('src/server/repository/dependencyReconciliationValidation.js');
  const ordered = read('src/server/repository/orderedSqlAppRepository.js');

  assert.match(validation, /MR_TaskDependencies dependency WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(validation, /MR_Tasks successor WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(validation, /storedProjectId !== nextProjectId/);
  assert.match(validation, /invalidatedPredecessorIds = new Set\(taskDeleteIds\)/);

  const guardPosition = ordered.indexOf('await assertTaskDependencyReconciliationCovered');
  const commitPosition = ordered.indexOf('return repository.commitChanges');
  assert.ok(guardPosition >= 0, 'dependency reconciliation guard must run');
  assert.ok(commitPosition > guardPosition, 'dependency reconciliation guard must precede writes');
  assert.match(ordered, /isolationLevel: sql\.ISOLATION_LEVEL\.SERIALIZABLE/);
});

test("bilinen değişim reddi HTTP 400 olur; bilinmeyen hata sunucu hatası kalır", () => {
  assert.equal(new ServerPersistenceError('MUTATION_FAILED', 'invalid').status, 400);
  assert.equal(new ServerPersistenceError('CONFLICT', 'stale').status, 409);
  assert.equal(new ServerPersistenceError('INTERNAL_FAILURE', 'internal').status, 500);
});
