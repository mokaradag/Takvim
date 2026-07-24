import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeCommitScalars } from '../src/server/repository/commitScalarCanonicalization.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

function validTask(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    task: 'Valid task',
    description: '',
    keyword: '',
    status: 'planned',
    priority: 'normal',
    isMilestone: false,
    plannedStart: null,
    plannedFinish: null,
    plannedDurationDays: null,
    targetFinish: null,
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    progress: null,
    plannedHours: null,
    actualHours: null,
    budget: null,
    spent: null,
    sortOrder: null,
    deps: [],
    ...overrides
  };
}

function canonicalTask(overrides = {}) {
  return canonicalizeCommitScalars({ taskUpserts: [validTask(overrides)] }).taskUpserts[0];
}

function taskIssue(overrides = {}) {
  return findCommitScalarIssue({ taskUpserts: [canonicalTask(overrides)] });
}

test('milestone flags must be booleans instead of truthy strings', () => {
  const issue = taskIssue({ isMilestone: 'false', plannedDurationDays: 0 });

  assert.equal(issue?.code, 'TASK_MILESTONE_FLAG_INVALID');
  assert.equal(issue?.path, 'taskUpserts[0].isMilestone');
});

test('canonical UI milestone intent wins over a stale SQL alias', () => {
  const task = canonicalTask({ isMilestone: true, milestone: false, plannedDurationDays: 0 });

  assert.equal(task.milestone, false);
  assert.equal(task.isMilestone, false);
  assert.equal(findCommitScalarIssue({ taskUpserts: [task] }), null);
});

test('numeric task fields reject booleans, collections, and whitespace-only strings', () => {
  for (const progress of [true, false, [], {}, '   ']) {
    const issue = taskIssue({ progress });
    assert.equal(issue?.code, 'TASK_NUMBER_INVALID');
    assert.equal(issue?.path, 'taskUpserts[0].progress');
  }

  assert.equal(taskIssue({ progress: '12.5' }), null);
  assert.equal(taskIssue({ progress: '' }), null);
});

test('task text fields reject objects before mssql binding', () => {
  assert.equal(taskIssue({ task: { text: 'Task' } })?.code, 'TASK_TITLE_INVALID');
  assert.equal(taskIssue({ description: ['unexpected'] })?.code, 'TASK_TEXT_INVALID');
  assert.equal(taskIssue({ keyword: { value: 'unexpected' } })?.code, 'TASK_TEXT_INVALID');
});

test('date and enum scalars reject non-string values deterministically', () => {
  assert.equal(taskIssue({ plannedStart: 20260724 })?.code, 'TASK_TEXT_INVALID');
  assert.equal(taskIssue({ status: null })?.code, 'TASK_STATUS_INVALID');
  assert.equal(taskIssue({ priority: false })?.code, 'TASK_PRIORITY_INVALID');
});

test('dependency lag scalars reject coercible malformed values', () => {
  const dependency = {
    predecessorId: '33333333-3333-4333-8333-333333333333',
    type: 'FS'
  };

  assert.equal(taskIssue({ deps: [{ ...dependency, lagDays: true }] })?.code, 'DEPENDENCY_LAG_INVALID');
  assert.equal(taskIssue({ deps: [{ ...dependency, lagValue: '   ' }] })?.code, 'DEPENDENCY_LAG_INVALID');
  assert.equal(taskIssue({ deps: [{ ...dependency, lagDays: '-2.5', lagValue: '1.25', lagUnit: 'week' }] }), null);
});
