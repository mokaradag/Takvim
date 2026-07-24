import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeActualChanges } from '../src/data/api/createApiRepository.js';
import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';

const VERSION = 'AAAAAAAAAAA=';

function completeProjectUpdate(overrides = {}) {
  return {
    id: 'project-id',
    version: VERSION,
    name: 'Project',
    code: null,
    leadId: null,
    dataDate: null,
    color: 'blue',
    calendarId: 'calendar-id',
    tags: [],
    ...overrides
  };
}

function completeWbsUpdate(overrides = {}) {
  return {
    id: 'wbs-id',
    version: VERSION,
    projectId: 'project-id',
    parentId: null,
    code: '1',
    name: 'Project',
    sortOrder: null,
    ...overrides
  };
}

function completeTaskUpdate(overrides = {}) {
  return {
    id: 'task-id',
    version: VERSION,
    projectId: 'project-id',
    wbsId: null,
    calendarId: null,
    task: 'Task',
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
    assigneeIds: [],
    deps: [],
    ...overrides
  };
}

function without(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function postedActualChanges(changes) {
  return JSON.parse(JSON.stringify({ changes: normalizeActualChanges(changes) })).changes;
}

test('versioned project replacements reject omitted stored metadata instead of clearing it', () => {
  const issue = findNestedCommitCollectionIssue({
    projectUpserts: [without(completeProjectUpdate(), 'leadId')]
  });

  assert.deepEqual(issue, {
    code: 'PROJECT_UPDATE_FIELD_REQUIRED',
    path: 'projectUpserts[0].leadId',
    message: 'Güncellenen proje için leadId alanı gönderilmelidir.'
  });
});

test('versioned WBS replacements reject omitted hierarchy metadata', () => {
  const issue = findNestedCommitCollectionIssue({
    wbsUpserts: [without(completeWbsUpdate(), 'sortOrder')]
  });

  assert.deepEqual(issue, {
    code: 'WBS_UPDATE_FIELD_REQUIRED',
    path: 'wbsUpserts[0].sortOrder',
    message: 'Güncellenen WBS kaydı için sortOrder alanı gönderilmelidir.'
  });
});

test('versioned task replacements reject omitted scalar fields instead of applying SQL defaults', () => {
  const issue = findNestedCommitCollectionIssue({
    taskUpserts: [without(completeTaskUpdate(), 'status')]
  });

  assert.deepEqual(issue, {
    code: 'TASK_UPDATE_FIELD_REQUIRED',
    path: 'taskUpserts[0].status',
    message: 'Güncellenen görev için status alanı gönderilmelidir.'
  });
});

test('versioned task replacements require title and milestone intent explicitly', () => {
  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [without(completeTaskUpdate(), 'task')]
  })?.path, 'taskUpserts[0].task');

  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [without(completeTaskUpdate(), 'isMilestone')]
  })?.path, 'taskUpserts[0].isMilestone');
});

test('Actual normalization preserves omitted nullable references for API validation', () => {
  const changes = postedActualChanges({
    projectUpserts: [without(completeProjectUpdate(), 'calendarId')],
    wbsUpserts: [without(completeWbsUpdate(), 'parentId')],
    taskUpserts: [without(completeTaskUpdate(), 'wbsId')]
  });

  assert.equal(Object.hasOwn(changes.projectUpserts[0], 'calendarId'), false);
  assert.equal(Object.hasOwn(changes.wbsUpserts[0], 'parentId'), false);
  assert.equal(Object.hasOwn(changes.taskUpserts[0], 'wbsId'), false);
  assert.equal(findNestedCommitCollectionIssue(changes)?.path, 'projectUpserts[0].calendarId');
});

test('Actual normalization preserves explicit null replacement intent', () => {
  const changes = postedActualChanges({
    projectUpserts: [completeProjectUpdate()],
    wbsUpserts: [completeWbsUpdate()],
    taskUpserts: [completeTaskUpdate()]
  });

  assert.equal(changes.projectUpserts[0].code, null);
  assert.equal(changes.wbsUpserts[0].parentId, null);
  assert.equal(changes.taskUpserts[0].wbsId, null);
  assert.equal(changes.taskUpserts[0].calendarId, null);
  assert.equal(findNestedCommitCollectionIssue(changes), null);
});

test('complete versioned replacements accept explicit null values', () => {
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [completeProjectUpdate()],
    wbsUpserts: [completeWbsUpdate()],
    taskUpserts: [completeTaskUpdate()]
  }), null);
});
