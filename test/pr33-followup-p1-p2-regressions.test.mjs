import assert from 'node:assert/strict';
import test from 'node:test';

import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';
import { prepareProjectCreation } from '../src/state/projectCreation.js';

const VERSION = 'AQIDBA==';

function validProjectContext(overrides = {}) {
  return {
    canCreateProjects: true,
    calendars: [{ id: 'cal-1', name: 'Kurumsal Takvim' }],
    people: [{ id: 'person-1', name: 'Ayşe' }],
    projects: [],
    ...overrides
  };
}

function validProjectInput(overrides = {}) {
  return {
    name: 'Yeni Proje',
    leadId: 'person-1',
    dataDate: '2026-07-24',
    color: 'blue',
    ...overrides
  };
}

test('versioned project updates must carry the complete tag replacement', () => {
  assert.deepEqual(findNestedCommitCollectionIssue({
    projectUpserts: [{ id: 'project-1', version: VERSION }]
  }), {
    code: 'PROJECT_TAGS_REQUIRED_FOR_UPDATE',
    path: 'projectUpserts[0].tags',
    message: 'Güncellenen proje için etiketlerin tümü gönderilmelidir.'
  });

  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ id: 'project-1', version: VERSION, tags: [] }]
  }), null);
});

test('versioned task updates must carry complete assignee and dependency replacements', () => {
  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [{ id: 'task-1', version: VERSION, deps: [] }]
  })?.code, 'TASK_ASSIGNEES_REQUIRED_FOR_UPDATE');

  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [{ id: 'task-1', version: VERSION, assigneeIds: [] }]
  })?.code, 'TASK_DEPENDENCIES_REQUIRED_FOR_UPDATE');

  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [{
      id: 'task-1',
      version: VERSION,
      assigneeIds: [],
      deps: []
    }]
  }), null);
});

test('create payloads remain backward-compatible when nested collections are omitted', () => {
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ id: 'project-new' }],
    taskUpserts: [{ id: 'task-new' }]
  }), null);
});

test('project creation stops at the state policy when the session lacks capability', () => {
  const result = prepareProjectCreation(
    validProjectInput(),
    validProjectContext({ canCreateProjects: false }),
    { projectId: 'project-new', rootWbsId: 'wbs-new' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROJECT_CREATE_FORBIDDEN');
  assert.equal(result.error.field, 'project');
});

test('authorized project creation still produces the atomic project and root WBS change set', () => {
  const result = prepareProjectCreation(
    validProjectInput(),
    validProjectContext(),
    { projectId: 'project-new', rootWbsId: 'wbs-new' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.project.id, 'project-new');
  assert.equal(result.rootWbs.id, 'wbs-new');
  assert.deepEqual(result.changes.projectUpserts, [result.project]);
  assert.deepEqual(result.changes.wbsUpserts, [result.rootWbs]);
});
