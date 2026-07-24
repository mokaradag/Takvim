import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTUAL_ID_ALIAS_STORAGE_KEY,
  loadActualIdAliases,
  persistActualIdAliases
} from '../src/data/api/actualIdAliasStorage.js';
import { restoreActualSnapshotIds } from '../src/data/api/createApiRepository.js';
import { findCommitChangeIssue } from '../src/server/repository/commitChangeValidation.js';

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
    projectUpserts: [{
      id: PROJECT_UUID,
      source: 'manual',
      name: 'New Project',
      leadId: '18068',
      calendarId: CALENDAR_UUID,
      dataDate: '2026-07-24',
      color: 'blue'
    }],
    wbsUpserts: [],
    taskUpserts: [],
    projectDeletes: [],
    wbsDeletes: [],
    taskDeletes: []
  }), null);
});
