import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findCommitProjectWbsIssue } from '../src/server/repository/commitProjectWbsValidation.js';
import { findDeleteIntentIssue } from '../src/server/repository/deleteIntentPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WBS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function validChanges() {
  return {
    projectUpserts: [{
      id: PROJECT_ID,
      name: 'Geçerli Proje',
      code: 'PRJ-1',
      leadId: '18068',
      color: 'blue',
      tags: ['Planlama']
    }],
    wbsUpserts: [{
      id: WBS_ID,
      projectId: PROJECT_ID,
      parentId: null,
      code: '1',
      name: 'Geçerli Proje',
      sortOrder: 1
    }]
  };
}

test('delete intent rejects missing targets and unversioned deletes', () => {
  assert.deepEqual(findDeleteIntentIssue({
    exists: false,
    version: 'AAAAAAAAAAA=',
    entityType: 'TASK',
    id: 'task-id'
  }), {
    code: 'DELETE_TARGET_MISSING',
    entityType: 'TASK',
    id: 'task-id',
    message: 'Silinecek kayıt artık bulunamadı. Verileri yeniden yükleyin.'
  });

  assert.equal(findDeleteIntentIssue({
    exists: true,
    version: null,
    entityType: 'WBS',
    id: 'wbs-id'
  })?.code, 'DELETE_VERSION_REQUIRED');

  assert.equal(findDeleteIntentIssue({
    exists: true,
    version: 'AAAAAAAAAAA=',
    entityType: 'TASK',
    id: 'task-id'
  }), null);
});

test('project metadata validation rejects malformed leads and duplicate or oversized tags', () => {
  const malformedLead = validChanges();
  malformedLead.projectUpserts[0].leadId = '18068abc';
  assert.equal(findCommitProjectWbsIssue(malformedLead)?.code, 'PROJECT_LEAD_INVALID');

  const outOfRangeLead = validChanges();
  outOfRangeLead.projectUpserts[0].leadId = '2147483648';
  assert.equal(findCommitProjectWbsIssue(outOfRangeLead)?.code, 'PROJECT_LEAD_INVALID');

  const duplicateTags = validChanges();
  duplicateTags.projectUpserts[0].tags = ['Planlama', 'PLANLAMA'];
  assert.equal(findCommitProjectWbsIssue(duplicateTags)?.code, 'PROJECT_TAG_DUPLICATE');

  const oversizedTag = validChanges();
  oversizedTag.projectUpserts[0].tags = ['x'.repeat(256)];
  assert.equal(findCommitProjectWbsIssue(oversizedTag)?.code, 'COMMIT_TEXT_TOO_LONG');
});

test('project and WBS SQL scalar limits are enforced before repository execution', () => {
  const blankProject = validChanges();
  blankProject.projectUpserts[0].name = '   ';
  assert.equal(findCommitProjectWbsIssue(blankProject)?.path, 'projectUpserts[0].name');

  const oversizedCode = validChanges();
  oversizedCode.projectUpserts[0].code = 'x'.repeat(256);
  assert.equal(findCommitProjectWbsIssue(oversizedCode)?.path, 'projectUpserts[0].code');

  const invalidColor = validChanges();
  invalidColor.projectUpserts[0].color = 'ultraviolet';
  assert.equal(findCommitProjectWbsIssue(invalidColor)?.code, 'PROJECT_COLOR_INVALID');

  const blankWbs = validChanges();
  blankWbs.wbsUpserts[0].name = '';
  assert.equal(findCommitProjectWbsIssue(blankWbs)?.path, 'wbsUpserts[0].name');

  const invalidSort = validChanges();
  invalidSort.wbsUpserts[0].sortOrder = 2147483648;
  assert.equal(findCommitProjectWbsIssue(invalidSort)?.code, 'WBS_SORT_ORDER_INVALID');

  assert.equal(findCommitProjectWbsIssue(validChanges()), null);
});

test('commit route and ordered repository enforce both new boundaries', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const ordered = read('src/server/repository/orderedSqlAppRepository.js');
  const intent = read('src/server/repository/upsertIntentValidation.js');

  assert.match(route, /findCommitProjectWbsIssue\(changes\)/);
  assert.match(ordered, /await assertDeleteIntentMatchesPersistence\(transaction, orderedChanges\);/);
  assert.match(intent, /collection: 'wbsDeletes'/);
  assert.match(intent, /collection: 'taskDeletes'/);
  assert.match(intent, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(ordered, /isolationLevel: sql\.ISOLATION_LEVEL\.SERIALIZABLE/);
});
