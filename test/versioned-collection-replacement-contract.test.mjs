import assert from 'node:assert/strict';
import test from 'node:test';

import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';
import { prepareProjectCreation } from '../src/state/projectCreation.js';

const VERSION = 'AQIDBA==';

function completeProjectUpdate(overrides = {}) {
  return {
    id: 'project-1',
    version: VERSION,
    name: 'Project',
    code: null,
    leadId: null,
    dataDate: null,
    color: 'blue',
    calendarId: 'calendar-1',
    ...overrides
  };
}

function completeTaskUpdate(overrides = {}) {
  return {
    id: 'task-1',
    version: VERSION,
    projectId: 'project-1',
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
    ...overrides
  };
}

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

test("sürümlü proje güncellemesi tam etiket değişimini taşımalıdır", () => {
  assert.deepEqual(findNestedCommitCollectionIssue({
    projectUpserts: [completeProjectUpdate()]
  }), {
    code: 'PROJECT_TAGS_REQUIRED_FOR_UPDATE',
    path: 'projectUpserts[0].tags',
    message: 'Güncellenen proje için etiketlerin tümü gönderilmelidir.'
  });

  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [completeProjectUpdate({ tags: [] })]
  }), null);
});

test("sürümlü görev güncellemesi tam sorumlu ve bağımlılık değişimini taşımalıdır", () => {
  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [completeTaskUpdate({ deps: [] })]
  })?.code, 'TASK_ASSIGNEES_REQUIRED_FOR_UPDATE');

  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [completeTaskUpdate({ assigneeIds: [] })]
  })?.code, 'TASK_DEPENDENCIES_REQUIRED_FOR_UPDATE');

  assert.equal(findNestedCommitCollectionIssue({
    taskUpserts: [completeTaskUpdate({ assigneeIds: [], deps: [] })]
  }), null);
});

test("oluşturma verisi iç koleksiyon atlanınca geriye uyumlu kalır", () => {
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ id: 'project-new' }],
    taskUpserts: [{ id: 'task-new' }]
  }), null);
});

test("oturum yeteneği yoksa proje oluşturma durum politikasında durur", () => {
  const result = prepareProjectCreation(
    validProjectInput(),
    validProjectContext({ canCreateProjects: false }),
    { projectId: 'project-new', rootWbsId: 'wbs-new' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROJECT_CREATE_FORBIDDEN');
  assert.equal(result.error.field, 'project');
});

test("yetkili proje oluşturma atomik proje ve kök WBS değişimini üretir", () => {
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
