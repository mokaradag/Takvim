import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeCommitChanges,
  findCommitChangeIssue
} from '../src/server/repository/commitChangeValidation.js';
import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CALENDAR_ID = '22222222-2222-4222-8222-222222222222';
const WBS_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const PREDECESSOR_ID = '55555555-5555-4555-8555-555555555555';

function validTask(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    wbsId: WBS_ID,
    calendarId: CALENDAR_ID,
    task: 'Valid task',
    status: 'planned',
    priority: 'normal',
    plannedStart: '2026-07-24',
    plannedFinish: '2026-07-25',
    plannedDurationDays: 1,
    targetFinish: '2026-07-26',
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: 1,
    progress: 0,
    plannedHours: 8,
    actualHours: 0,
    budget: 0,
    spent: 0,
    sortOrder: 1,
    deps: [],
    ...overrides
  };
}

function apiIssue(changes) {
  const canonical = canonicalizeCommitChanges(changes);
  return findCommitChangeIssue(canonical)
    || findNestedCommitCollectionIssue(canonical)
    || findCommitScalarIssue(canonical);
}

function taskIssue(overrides) {
  return apiIssue({ taskUpserts: [validTask(overrides)] });
}

test('nested validation rejects malformed assignee Sicils before SQL work', () => {
  for (const value of [null, {}, 0, '900002abc', 2147483648]) {
    const issue = apiIssue({ taskUpserts: [validTask({ assigneeIds: [value] })] });
    assert.equal(issue?.code, 'TASK_ASSIGNEE_INVALID');
    assert.equal(issue?.path, 'taskUpserts[0].assigneeIds[0]');
  }

  assert.equal(apiIssue({
    taskUpserts: [validTask({ assigneeIds: [' 900002 ', 900003] })]
  }), null);
});

test('task scalar validation rejects SQL-constrained enum and title values', () => {
  assert.equal(taskIssue({ task: '   ' })?.code, 'TASK_TITLE_REQUIRED');
  assert.equal(taskIssue({ status: 'todo' })?.code, 'TASK_STATUS_INVALID');
  assert.equal(taskIssue({ priority: 'urgent' })?.code, 'TASK_PRIORITY_INVALID');
});

test('task scalar validation rejects invalid calendar dates and ranges', () => {
  assert.equal(taskIssue({ plannedStart: '2026-02-30' })?.code, 'TASK_DATE_INVALID');
  assert.equal(taskIssue({ plannedStart: '2026-07-25', plannedFinish: '2026-07-24' })?.code, 'TASK_PLANNED_RANGE_INVALID');
  assert.equal(taskIssue({ actualStart: null, actualFinish: '2026-07-24' })?.code, 'TASK_ACTUAL_START_REQUIRED');
  assert.equal(taskIssue({ actualStart: '2026-07-25', actualFinish: '2026-07-24' })?.code, 'TASK_ACTUAL_RANGE_INVALID');
});

test('task scalar validation rejects invalid numeric values before SQL binding', () => {
  assert.equal(taskIssue({ progress: 101 })?.code, 'TASK_PROGRESS_INVALID');
  assert.equal(taskIssue({ plannedDurationDays: -1 })?.code, 'TASK_NUMBER_OUT_OF_RANGE');
  assert.equal(taskIssue({ plannedHours: Number.POSITIVE_INFINITY })?.code, 'TASK_NUMBER_INVALID');
  assert.equal(taskIssue({ sortOrder: 1.5 })?.code, 'TASK_SORT_ORDER_INVALID');
  assert.equal(taskIssue({ milestone: true, plannedDurationDays: 1 })?.code, 'TASK_MILESTONE_DURATION_INVALID');
});

test('dependency validation rejects duplicate, self, and malformed lag values', () => {
  const dependency = { predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: 0 };
  assert.equal(taskIssue({ deps: [dependency, { ...dependency, type: 'SS' }] })?.code, 'DUPLICATE_DEPENDENCY');
  assert.equal(taskIssue({ deps: [{ predecessorId: TASK_ID, type: 'FS', lagDays: 0 }] })?.code, 'SELF_DEPENDENCY');
  assert.equal(taskIssue({ deps: [{ ...dependency, lagDays: Number.NaN }] })?.code, 'DEPENDENCY_LAG_INVALID');
  assert.equal(taskIssue({ deps: [{ ...dependency, lagUnit: 'hour' }] })?.code, 'DEPENDENCY_LAG_UNIT_INVALID');
});

test('strict project dates and valid task scalar values remain deterministic', () => {
  assert.equal(apiIssue({
    projectUpserts: [{
      id: PROJECT_ID,
      source: 'manual',
      name: 'Project',
      leadId: '900002',
      calendarId: CALENDAR_ID,
      dataDate: '2026-02-30',
      color: 'blue'
    }]
  })?.code, 'PROJECT_DATA_DATE_INVALID');

  assert.equal(taskIssue({
    deps: [{ predecessorId: PREDECESSOR_ID, type: 'FS', lagDays: -2.5, lagValue: 1, lagUnit: 'week' }]
  }), null);
});

test('commit route invokes scalar validation before SQL persistence', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const scalarPosition = route.indexOf('findCommitScalarIssue(changes)');
  const commitPosition = route.indexOf('createOrderedSqlAppRepository().commitChanges(changes)');

  assert.match(route, /findNestedCommitCollectionIssue\(changes\)[\s\S]*findCommitScalarIssue\(changes\)/);
  assert.ok(scalarPosition >= 0);
  assert.ok(commitPosition > scalarPosition);
  assert.match(route, /status: 400/);
});
