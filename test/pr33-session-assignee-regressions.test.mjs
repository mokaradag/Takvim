import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyTaskAssigneeProjection } from '../src/server/repository/taskAssigneeProjection.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';

test('visible task projection restores every co-assignee without duplicates', () => {
  const snapshot = {
    projects: [],
    tasks: [
      { id: TASK_A, assigneeIds: ['10001'] },
      { id: TASK_B, assigneeIds: ['stale'] }
    ]
  };

  const projected = applyTaskAssigneeProjection(snapshot, [
    { TaskId: TASK_A, Sicil: 10001 },
    { TaskId: TASK_A, Sicil: 10002 },
    { TaskId: TASK_A, Sicil: 10002 }
  ]);

  assert.deepEqual(projected.tasks[0].assigneeIds, ['10001', '10002']);
  assert.deepEqual(projected.tasks[1].assigneeIds, []);
  assert.notEqual(projected.tasks[0], snapshot.tasks[0]);
});

test('snapshot API completes assignees only for already-authorized visible task IDs', () => {
  const repositorySource = read('src/server/repository/projectedSqlAppRepository.js');
  const routeSource = read('src/app/api/mergen-rota/snapshot/route.js');

  assert.match(repositorySource, /const snapshot = await baseRepository\.readSnapshot\(\);/);
  assert.match(repositorySource, /taskIds = \[\.\.\.new Set\(\(snapshot\.tasks \|\| \[\]\)/);
  assert.match(repositorySource, /request\.input\('taskIds', sql\.NVarChar\(sql\.MAX\), taskIds\.join\(','\)\);/);
  assert.match(repositorySource, /JOIN STRING_SPLIT\(@taskIds, ','\) visible/);
  assert.match(repositorySource, /return applyTaskAssigneeProjection\(snapshot, assigneeRows\);/);
  assert.match(routeSource, /createProjectedSqlAppRepository\(\)\.loadSnapshot\(\)/);
});

test('SYSTEM_ADMIN sessions enumerate every active project with an explicit reason', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');

  assert.match(source, /CAST\('SYSTEM_ADMIN' AS varchar\(30\)\) AS Reason/);
  assert.match(source, /FROM dbo\.MR_Projects p\s+WHERE p\.IsActive = 1\s+AND EXISTS \(/s);
  assert.match(source, /ur\.Sicil = @sicil AND ur\.RoleCode = 'SYSTEM_ADMIN' AND ur\.IsActive = 1/);
});

test('FULL access reasons are aggregated and sorted before session projection', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');

  assert.match(source, /const fullReasonsByProject = new Map\(\);/);
  assert.match(source, /fullReasonsByProject\.set\(projectId, new Set\(\)\)/);
  assert.match(source, /fullReasonsByProject\.get\(projectId\)\.add\(row\.Reason\);/);
  assert.match(source, /reasons: \[\.\.\.reasons\]\.sort\(\)/);
});
