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

test('snapshot API reuses authorized task scopes for co-assignee projection', async () => {
  const repositorySource = read('src/server/repository/projectedSqlAppRepository.js');
  const routeSource = read('src/app/api/mergen-rota/snapshot/route.js');

  assert.match(repositorySource, /const \{ snapshot, auth \} = await baseRepository\.readSnapshotWithAuthorization\(transaction\);/);
  assert.match(repositorySource, /loadVisibleTaskAssignees\(transaction, snapshot\.tasks, auth\)/);
  assert.match(repositorySource, /request\.input\('taskIds', sql\.NVarChar\(sql\.MAX\), scopes\.taskIds\.join\(','\)\);/);
  assert.match(repositorySource, /request\.input\('identityVisibleTaskIds', sql\.NVarChar\(sql\.MAX\), scopes\.identityVisibleTaskIds\.join\(','\)\);/);
  assert.match(repositorySource, /request\.input\('coAssigneeTaskIds', sql\.NVarChar\(sql\.MAX\), scopes\.coAssigneeTaskIds\.join\(','\)\);/);
  assert.match(repositorySource, /JOIN STRING_SPLIT\(@taskIds, ','\) visible/);
  assert.match(repositorySource, /LEFT JOIN STRING_SPLIT\(@identityVisibleTaskIds, ','\) identityVisibleTask/);
  assert.match(repositorySource, /LEFT JOIN STRING_SPLIT\(@coAssigneeTaskIds, ','\) coAssigneeTask/);
  assert.match(repositorySource, /SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope/s);
  assert.match(repositorySource, /CASE WHEN visibility\.IdentityVisible = 1 THEN ta\.Sicil ELSE NULL END AS Sicil/);
  assert.match(repositorySource, /WHERE visibility\.IdentityVisible = 1\s+OR coAssigneeTask\.value IS NOT NULL/);
  assert.match(repositorySource, /LEFT JOIN dbo\.MR_V_PeopleDirectory pd ON pd\.Sicil = ta\.Sicil/);
  assert.doesNotMatch(repositorySource, /MR_V_CorporateProjectAccess/);
  assert.doesNotMatch(repositorySource, /MR_ProjectAccess/);
  assert.doesNotMatch(repositorySource, /JOIN dbo\.MR_Tasks/);
  assert.doesNotMatch(repositorySource, /JOIN dbo\.MR_Projects/);
  assert.match(repositorySource, /snapshot: \{ \.\.\.applyTaskAssigneeProjection\(snapshot, assigneeRows\), scheduleRequests: scheduleInbox\.items, scheduleRequestSummary:/);
  assert.match(repositorySource, /session: await baseRepository\.sessionContextFrom\(auth\)/);
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

test('co-assignee projection scopes preserve FULL, READ, creator and direct-assignee privacy rules', async () => {
  registerServerOnlyShim();
  const { assigneeProjectionScopes } = await import('../src/server/repository/projectedSqlAppRepository.js');

  const projects = {
    full: '31111111-1111-4111-8111-111111111111',
    read: '32222222-2222-4222-8222-222222222222',
    partial: '33333333-3333-4333-8333-333333333333'
  };
  const tasks = [
    { id: '41111111-1111-4111-8111-111111111111', projectId: projects.full },
    { id: '42222222-2222-4222-8222-222222222222', projectId: projects.read },
    { id: '43333333-3333-4333-8333-333333333333', projectId: projects.partial, isCurrentUserCreator: true },
    { id: '44444444-4444-4444-8444-444444444444', projectId: projects.partial, isCurrentUserAssignee: true },
    { id: '45555555-5555-4555-8555-555555555555', projectId: projects.partial }
  ];
  const auth = {
    sicil: 10001,
    isSystemAdmin: false,
    effective: {
      access: new Map([
        [projects.full, { accessLevel: 'FULL', reasons: ['CORPORATE_PROJECT_ROLE'] }],
        [projects.read, { accessLevel: 'PARTIAL', reasons: ['MANUAL_GRANT'] }],
        [projects.partial, { accessLevel: 'PARTIAL', reasons: ['ASSIGNEE'] }]
      ])
    }
  };

  const scopes = assigneeProjectionScopes(tasks, auth);
  assert.deepEqual(scopes.taskIds, tasks.map((task) => task.id));
  assert.deepEqual(scopes.identityVisibleTaskIds, [tasks[0].id, tasks[1].id, tasks[2].id]);
  assert.deepEqual(scopes.coAssigneeTaskIds, [tasks[3].id]);

  const adminScopes = assigneeProjectionScopes(tasks, { ...auth, isSystemAdmin: true });
  assert.deepEqual(adminScopes.identityVisibleTaskIds, tasks.map((task) => task.id));
  assert.deepEqual(adminScopes.coAssigneeTaskIds, [tasks[3].id]);
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
