import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyDefaultCalendarProjection } from '../src/server/repository/calendarProjection.js';
import { orderWbsUpsertsByParents } from '../src/server/repository/wbsCommitPlanning.js';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('WBS upserts are planned parent-first without disturbing unrelated stable order', () => {
  const grandchild = { id: 'grandchild', parentId: 'child' };
  const child = { id: 'child', parentId: 'parent' };
  const parent = { id: 'parent', parentId: 'existing-root' };
  const unrelated = { id: 'unrelated', parentId: 'existing-root' };

  const ordered = orderWbsUpsertsByParents([grandchild, child, parent, unrelated]);
  assert.deepEqual(ordered.map((node) => node.id), ['parent', 'child', 'grandchild', 'unrelated']);
});

test('WBS planning preserves input when no in-batch parent dependency exists', () => {
  const input = [
    { id: 'second', parentId: 'existing-root' },
    { id: 'first', parentId: 'existing-root' }
  ];
  assert.deepEqual(orderWbsUpsertsByParents(input), input);
});

test('default calendar projection marks and places the SQL default first', () => {
  const snapshot = {
    calendars: [
      { id: 'calendar-a', name: 'A Calendar' },
      { id: 'calendar-default', name: 'Z Default' },
      { id: 'calendar-b', name: 'B Calendar' }
    ],
    tasks: []
  };

  const projected = applyDefaultCalendarProjection(snapshot, 'calendar-default');
  assert.equal(projected.calendars[0].id, 'calendar-default');
  assert.equal(projected.calendars[0].isDefault, true);
  assert.equal(projected.calendars.filter((calendar) => calendar.isDefault).length, 1);
  assert.deepEqual(projected.tasks, []);
});

test('commit route canonicalizes IDs and scalars before WBS ordering and hardened SQL planning', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const wrapper = read('src/server/repository/orderedSqlAppRepository.js');

  assert.match(route, /canonicalizeCommitScalars\(canonicalizeCommitChanges\(body\.changes\)\)/);
  assert.match(route, /createOrderedSqlAppRepository/);
  assert.match(wrapper, /createHardenedSqlAppRepository/);

  const idPosition = wrapper.indexOf('canonicalizeCommitChanges(changes)');
  const scalarPosition = wrapper.indexOf('canonicalizeCommitScalars(');
  const orderingPosition = wrapper.indexOf('orderWbsUpsertsByParents(canonicalChanges.wbsUpserts || [])');
  const commitPosition = wrapper.indexOf('repository.commitChanges(orderedChanges)');

  assert.ok(idPosition >= 0, 'UUID canonicalization must run');
  assert.ok(scalarPosition >= 0, 'scalar canonicalization must run');
  assert.ok(orderingPosition > scalarPosition, 'WBS ordering must use fully canonicalized changes');
  assert.ok(commitPosition > orderingPosition, 'hardened persistence must receive ordered changes');
});

test('Actual snapshots resolve the active SQL default calendar in the same transaction', async () => {
  const source = read('src/server/repository/projectedSqlAppRepository.js');

  assert.match(source, /WHERE IsDefault = 1 AND IsActive = 1/);
  assert.match(source, /const defaultCalendarId = await loadDefaultCalendarId\(transaction\);/);
  assert.match(source, /Object\.assign\(snapshot, applyDefaultCalendarProjection\(snapshot, defaultCalendarId\)\);/);

  const projectId = '11111111-1111-4111-8111-888888888888';
  const wbsId = '22222222-2222-4222-8222-888888888888';
  const taskId = '33333333-3333-4333-8333-888888888888';
  const requestId = '44444444-4444-4444-8444-888888888888';
  const sicil = 950001;
  const stack = await createActualStack({
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Varsayılan', IsDefault: 1, IsActive: 1 }],
    people: [{ Sicil: sicil, DisplayName: 'Karar Sahibi', Username: 'ksahibi' }],
    projects: [{
      ProjectId: projectId, SourceType: 'MANUAL', ProjectCode: 'SNAP', ProjectName: 'Anlık Görüntü',
      LeadSicil: sicil, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1
    }],
    projectAccess: [{ ProjectId: projectId, Sicil: sicil, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [{ WbsId: wbsId, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 1 }],
    tasks: [{
      TaskId: taskId, ProjectId: projectId, WbsId: wbsId, Title: 'Anlık görev', Status: 'planned',
      Priority: 'medium', CreatedBySicil: sicil
    }],
    taskAssignees: [{ TaskId: taskId, Sicil: sicil }],
    taskScheduleChangeRequests: [{
      RequestId: requestId, TaskId: taskId, RequesterSicil: 950002,
      DecisionOwnerSicil: sicil, Status: 'PENDING'
    }]
  }, { sicil, corporateWbsSource: false });
  try {
    assert.equal(stack.state.calendars[0].id, DEFAULT_CALENDAR_ID.toLowerCase());
    assert.deepEqual(stack.state.scheduleRequests.map((request) => request.id), [requestId]);
    assert.equal(stack.state.scheduleRequests[0].status, 'PENDING');
  } finally {
    await stack.dispose();
  }
});

test('kısmi kapsam yöneticisi yalnızca ast görevinin WBS yolunu görür, proje kataloğunun tamamını görmez', async () => {
  const projectId = '11111111-1111-4111-8111-999999999999';
  const rootId = '22222222-2222-4222-8222-999999999991';
  const assignedId = '22222222-2222-4222-8222-999999999992';
  const unrelatedId = '22222222-2222-4222-8222-999999999993';
  const taskId = '33333333-3333-4333-8333-999999999999';
  const manager = 960001;
  const assignee = 960002;
  const creator = 960003;
  const stack = await createActualStack({
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Varsayılan', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: manager, DisplayName: 'Kapsam Yöneticisi', Username: 'yonetici' },
      { Sicil: assignee, DisplayName: 'Ast Sorumlu', Username: 'sorumlu' },
      { Sicil: creator, DisplayName: 'Görev Oluşturucusu', Username: 'olusturucu' }
    ],
    projects: [{
      ProjectId: projectId,
      SourceType: 'MANUAL',
      ProjectCode: 'KISMI',
      ProjectName: 'Kısmi WBS Projesi',
      LeadSicil: creator,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    executiveScope: [{ ManagerSicil: manager, EmployeeSicil: assignee }],
    wbs: [
      { WbsId: rootId, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 1 },
      { WbsId: assignedId, ProjectId: projectId, ParentWbsId: rootId, Code: '1.1', Name: 'Görünen Dal', SortOrder: 2 },
      { WbsId: unrelatedId, ProjectId: projectId, ParentWbsId: rootId, Code: '1.2', Name: 'İlgisiz Dal', SortOrder: 3 }
    ],
    tasks: [{
      TaskId: taskId,
      ProjectId: projectId,
      WbsId: assignedId,
      Title: 'Astın görevi',
      Status: 'planned',
      Priority: 'medium',
      CreatedBySicil: creator
    }],
    taskAssignees: [{ TaskId: taskId, Sicil: assignee }]
  }, { sicil: manager, corporateWbsSource: false });
  try {
    assert.equal(stack.state.projects[0].accessLevel, 'PARTIAL');
    assert.equal(stack.state.tasks[0].id, taskId);
    assert.deepEqual(
      stack.state.wbs.map((node) => node.id).sort(),
      [assignedId, rootId].sort()
    );
    assert.equal(stack.state.wbs.some((node) => node.id === unrelatedId), false);
  } finally {
    await stack.dispose();
  }
});
