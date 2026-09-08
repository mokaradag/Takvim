import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyTaskAssigneeProjection } from '../src/server/repository/taskAssigneeProjection.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

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
    { TaskId: TASK_A, Sicil: 10001, DisplayName: 'Ayşe Kaya' },
    { TaskId: TASK_A, Sicil: 10002, DisplayName: 'Mehmet Demir' },
    { TaskId: TASK_A, Sicil: 10002, DisplayName: 'Mehmet Demir' }
  ]);

  assert.deepEqual(projected.tasks[0].assigneeIds, ['10001', '10002']);
  assert.deepEqual(projected.tasks[0].assigneeDisplayNames, ['Ayşe Kaya', 'Mehmet Demir']);
  assert.deepEqual(projected.tasks[0].assigneeAvatarIdentities, [
    { name: 'Ayşe Kaya', employeeNo: '10001' },
    { name: 'Mehmet Demir', employeeNo: '10002' }
  ]);
  assert.deepEqual(projected.tasks[1].assigneeIds, []);
  assert.deepEqual(projected.tasks[1].assigneeDisplayNames, []);
  assert.deepEqual(projected.tasks[1].assigneeAvatarIdentities, []);
  assert.notEqual(projected.tasks[0], snapshot.tasks[0]);
});

test('snapshot API completes assignees only for already-authorized visible task IDs', async () => {
  const repositorySource = read('src/server/repository/projectedSqlAppRepository.js');
  const routeSource = read('src/app/api/mergen-rota/snapshot/route.js');

  assert.match(repositorySource, /const \{ snapshot, auth \} = await baseRepository\.readSnapshotWithAuthorization\(transaction\);/);
  assert.match(repositorySource, /taskIds = \[\.\.\.new Set\(\(snapshot\.tasks \|\| \[\]\)/);
  assert.match(repositorySource, /request\.input\('taskIds', sql\.NVarChar\(sql\.MAX\), taskIds\.join\(','\)\);/);
  assert.match(repositorySource, /JOIN STRING_SPLIT\(@taskIds, ','\) visible/);
  assert.match(repositorySource, /ownAssignment\.TaskId = ta\.TaskId AND ownAssignment\.Sicil = @sicil/);
  assert.match(repositorySource, /CASE WHEN auth\.IdentityVisible = 1 THEN ta\.Sicil ELSE NULL END AS Sicil/);
  assert.equal((repositorySource.match(/MR_V_CorporateProjectAccess/g) || []).length, 1);
  assert.match(repositorySource, /WHERE auth\.IdentityVisible = 1/);
  assert.match(repositorySource, /LEFT JOIN dbo\.MR_V_PeopleDirectory pd ON pd\.Sicil = ta\.Sicil/);
  assert.match(repositorySource, /snapshot: \{ \.\.\.applyTaskAssigneeProjection\(snapshot, assigneeRows\), scheduleRequests: scheduleInbox\.items, scheduleRequestSummary:/);
  assert.match(routeSource, /const repository = createProjectedSqlAppRepository\(\);/);
  assert.match(routeSource, /loadSnapshotForRequest\(request, repository\)/);

  registerServerOnlyShim();
  const { loadSnapshotForRequest } = await import('../src/app/api/mergen-rota/snapshot/route.js');
  const modes = [];
  const fakeRepository = {
    async loadSnapshotWithSession(options) {
      modes.push(options.catalogSync);
      return { tasks: [] };
    }
  };
  await loadSnapshotForRequest(null, fakeRepository);
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'initial' }
  }), fakeRepository);
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'manual' }
  }), fakeRepository);
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'automatic' }
  }), fakeRepository);
  assert.deepEqual(modes, ['blocking-before', 'blocking-before', 'background-after', 'background-after']);
});

test('0007 şemasıyla açılışta 0008 alanları eksikse talep önizlemesi güvenle boş geçilir', () => {
  const repositorySource = read('src/server/repository/projectedSqlAppRepository.js');

  assert.match(repositorySource, /number === 208[\s\S]*MR_TaskScheduleChangeRequests[\s\S]*MR_ScheduleRequestNotifications/);
  assert.match(repositorySource, /number === 207[\s\S]*TaskTitleSnapshot[\s\S]*ProjectIdSnapshot[\s\S]*ProjectNameSnapshot[\s\S]*ProjectCodeSnapshot/);
  assert.match(repositorySource, /return \{ items: \[\], unreadCount: 0, pendingCount: 0 \};/);
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
