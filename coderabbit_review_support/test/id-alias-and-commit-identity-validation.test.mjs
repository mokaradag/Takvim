import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTUAL_ID_ALIAS_STORAGE_KEY,
  loadActualIdAliases,
  persistActualIdAliases
} from '../src/data/api/actualIdAliasStorage.js';
import { restoreActualSnapshotIds } from '../src/data/api/createApiRepository.js';
import {
  canonicalizeCommitChanges,
  findCommitChangeIssue
} from '../src/server/repository/commitChangeValidation.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

const PROJECT_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROJECT_CLIENT_ID = `project-${PROJECT_UUID}`;
const CALENDAR_UUID = '3d594650-3436-4cfe-8dce-2ad94f5569bf';
const WBS_UUID = '29c14d17-4084-4d3e-a792-bfa5d75c3fc5';
const TASK_UUID = '74e60d52-773d-46b5-a7c8-cf8ca30efe3c';

function completeProject(id = PROJECT_UUID) {
  return {
    id,
    source: 'manual',
    name: 'New Project',
    leadId: '900002',
    calendarId: CALENDAR_UUID,
    dataDate: '2026-07-24',
    color: 'blue'
  };
}

test('Actual ID aliases survive repository recreation and restore a reloaded snapshot', () => {
  const storage = memoryStorage();
  const firstSessionAliases = new Map([[PROJECT_UUID, PROJECT_CLIENT_ID]]);

  assert.equal(persistActualIdAliases(firstSessionAliases, storage), true);
  const reloadedAliases = loadActualIdAliases(storage);
  const snapshot = restoreActualSnapshotIds({
    projects: [{ id: PROJECT_UUID, calendarId: CALENDAR_UUID }],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  }, reloadedAliases);

  assert.equal(snapshot.projects[0].id, PROJECT_CLIENT_ID);
  assert.deepEqual([...reloadedAliases], [[PROJECT_UUID, PROJECT_CLIENT_ID]]);
});

test('Actual alias storage ignores malformed and mismatched entries', () => {
  const storage = memoryStorage({
    [ACTUAL_ID_ALIAS_STORAGE_KEY]: JSON.stringify([
      ['not-a-uuid', 'project-not-a-uuid'],
      [PROJECT_UUID, 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      [PROJECT_UUID, PROJECT_CLIENT_ID],
      [PROJECT_UUID]
    ])
  });

  assert.deepEqual([...loadActualIdAliases(storage)], [[PROJECT_UUID, PROJECT_CLIENT_ID]]);
});

test('commit change validation rejects malformed collection shapes', () => {
  assert.deepEqual(findCommitChangeIssue({ taskUpserts: {} }), {
    code: 'CHANGE_COLLECTION_NOT_ARRAY',
    path: 'taskUpserts',
    message: 'taskUpserts dizi olmalıdır.',
    details: null
  });
});

test('commit change validation rejects duplicate and conflicting identities', () => {
  assert.equal(findCommitChangeIssue({
    wbsUpserts: [{ id: 'wbs-1' }, { id: 'wbs-1' }]
  })?.code, 'DUPLICATE_UPSERT');

  assert.equal(findCommitChangeIssue({
    taskUpserts: [{ id: 'task-1', deps: [] }],
    taskDeletes: [{ id: 'task-1', version: 'AAAAAAAAAAA=' }]
  })?.code, 'UPSERT_DELETE_CONFLICT');
});

test('commit UUID canonicalization keeps one logical Project identity across root planning', () => {
  const changes = canonicalizeCommitChanges({
    projectUpserts: [completeProject(PROJECT_UUID.toUpperCase())],
    projectDeletes: [],
    wbsUpserts: [{
      id: WBS_UUID.toUpperCase(),
      projectId: PROJECT_UUID,
      parentId: null,
      code: '1',
      name: 'New Project',
      sortOrder: 1
    }],
    wbsDeletes: [],
    taskUpserts: [],
    taskDeletes: []
  });

  assert.equal(changes.projectUpserts[0].id, PROJECT_UUID);
  assert.equal(changes.wbsUpserts[0].id, WBS_UUID);
  assert.equal(changes.wbsUpserts[0].projectId, changes.projectUpserts[0].id);
  assert.equal(findCommitChangeIssue(changes), null);
});

test('commit validation treats differently-cased UUIDs as duplicate logical identities', () => {
  const issue = findCommitChangeIssue(canonicalizeCommitChanges({
    taskUpserts: [
      { id: TASK_UUID.toUpperCase(), projectId: PROJECT_UUID, deps: [] },
      { id: TASK_UUID, projectId: PROJECT_UUID, deps: [] }
    ]
  }));

  assert.equal(issue?.code, 'DUPLICATE_UPSERT');
  assert.equal(issue?.details?.id, TASK_UUID);
});

test('commit validation rejects malformed entity and relationship UUIDs before SQL work', () => {
  const invalidEntity = findCommitChangeIssue(canonicalizeCommitChanges({
    taskUpserts: [{ id: 'not-a-uuid', projectId: PROJECT_UUID, deps: [] }]
  }));
  assert.equal(invalidEntity?.code, 'CHANGE_ID_INVALID');
  assert.equal(invalidEntity?.path, 'taskUpserts[0].id');

  const invalidReference = findCommitChangeIssue(canonicalizeCommitChanges({
    taskUpserts: [{ id: TASK_UUID, projectId: 'not-a-project-uuid', deps: [] }]
  }));
  assert.equal(invalidReference?.code, 'CHANGE_REFERENCE_INVALID');
  assert.equal(invalidReference?.path, 'taskUpserts[0].projectId');
});

test('commit change validation requires complete manual project creation fields', () => {
  const incomplete = findCommitChangeIssue({
    projectUpserts: [{
      id: PROJECT_UUID,
      source: 'manual',
      name: 'New Project',
      calendarId: CALENDAR_UUID,
      dataDate: '2026-07-24',
      color: 'blue'
    }]
  });
  assert.equal(incomplete?.code, 'PROJECT_CREATE_FIELD_REQUIRED');
  assert.equal(incomplete?.path, 'projectUpserts[0].leadId');

  assert.equal(findCommitChangeIssue({
    projectUpserts: [completeProject()],
    wbsUpserts: [],
    taskUpserts: [],
    projectDeletes: [],
    wbsDeletes: [],
    taskDeletes: []
  }), null);
});
