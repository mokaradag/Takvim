import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findFinalTaskReferenceIssue,
  orderTaskUpsertsByDependencies
} from '../src/server/repository/taskCommitPlanning.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const TASK_C = '33333333-3333-4333-8333-333333333333';

test("görev güncellemeleri istemci sırasından bağımsız öncül önce sıralanır", () => {
  const ordered = orderTaskUpsertsByDependencies([
    { id: TASK_B, projectId: PROJECT_B, deps: [{ predecessorId: TASK_A }] },
    { id: TASK_C, projectId: PROJECT_B, deps: [{ predecessorId: TASK_B }] },
    { id: TASK_A, projectId: PROJECT_B, deps: [] }
  ]);

  assert.deepEqual(ordered.map((task) => task.id), [TASK_A, TASK_B, TASK_C]);
});

test("son durum bağımlılık doğrulaması birlikte taşınmış görevleri kabul eder", () => {
  const issue = findFinalTaskReferenceIssue({
    existingTaskProjects: new Map([[TASK_A, PROJECT_A], [TASK_B, PROJECT_A]]),
    taskUpserts: [
      { id: TASK_B, projectId: PROJECT_B, deps: [{ predecessorId: TASK_A }] },
      { id: TASK_A, projectId: PROJECT_B, deps: [] }
    ]
  });

  assert.equal(issue, null);
});

test("son durum bağımlılık doğrulaması silinmiş ve başka projeli öncülü reddeder", () => {
  const deletedIssue = findFinalTaskReferenceIssue({
    existingTaskProjects: new Map([[TASK_A, PROJECT_A], [TASK_B, PROJECT_A]]),
    taskUpserts: [{ id: TASK_B, projectId: PROJECT_A, deps: [{ predecessorId: TASK_A }] }],
    taskDeletes: [{ id: TASK_A }]
  });
  assert.equal(deletedIssue?.code, 'DEPENDENCY_TARGET_DELETED');

  const movedIssue = findFinalTaskReferenceIssue({
    existingTaskProjects: new Map([[TASK_A, PROJECT_A], [TASK_B, PROJECT_A]]),
    taskUpserts: [
      { id: TASK_B, projectId: PROJECT_A, deps: [{ predecessorId: TASK_A }] },
      { id: TASK_A, projectId: PROJECT_B, deps: [] }
    ]
  });
  assert.equal(movedIssue?.code, 'CROSS_PROJECT_DEPENDENCY');
});

test("son durum bağımlılık doğrulaması yinelenen ilişkiyi SQL öncesi reddeder", () => {
  const issue = findFinalTaskReferenceIssue({
    existingTaskProjects: new Map([[TASK_A, PROJECT_A], [TASK_B, PROJECT_A]]),
    taskUpserts: [{
      id: TASK_B,
      projectId: PROJECT_A,
      deps: [{ predecessorId: TASK_A }, { predecessorId: TASK_A }]
    }]
  });

  assert.equal(issue?.code, 'DUPLICATE_DEPENDENCY');
});

test("güçlendirilmiş kayıt kaynak ve hedef projenin etkinliğini ister", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(source, /async function assertActiveProjectMutationTargets/);
  assert.match(source, /if \(!row \|\| !Boolean\(row\.IsActive\)\)/);
  assert.match(source, /await requireActiveProject\(task\.projectId\);/);
  // Satır kimlikleri kanonikleştirilerek okunur (SQL Server büyük harf döndürür).
  assert.match(source, /if \(before\) await requireActiveProject\(rowId\(before\.ProjectId\)\);/);
  assert.match(source, /await assertActiveProjectMutationTargets\(executor, changes\);/);
});

test("bağımlılık kaldırma yeni son kenarlar eklenmeden biter", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  const deleteLoop = source.indexOf('for (const entry of changes.taskDeletes)');
  const additionLoop = source.indexOf("const nextEdges = projectEdges.get(projectId) || [];");
  assert.ok(deleteLoop >= 0);
  assert.ok(additionLoop > deleteLoop);
  assert.match(source, /const plannedChanges = await planTaskCommits\(executor, changes\);/);
  assert.match(source, /return baseRepository\.commitChanges\(plannedChanges\);/);
});
