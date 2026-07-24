import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findNestedCommitCollectionIssue } from '../src/server/repository/commitNestedCollectionValidation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('commit validation rejects project tags supplied as an iterable string', () => {
  const issue = findNestedCommitCollectionIssue({
    projectUpserts: [{ id: 'project-id', tags: 'alpha' }]
  });

  assert.deepEqual(issue, {
    code: 'PROJECT_TAGS_NOT_ARRAY',
    path: 'projectUpserts[0].tags',
    message: 'Proje etiketleri dizi olmalıdır.'
  });
});

test('commit validation rejects task assignees supplied as an iterable string', () => {
  const issue = findNestedCommitCollectionIssue({
    taskUpserts: [{ id: 'task-id', assigneeIds: '18068' }]
  });

  assert.deepEqual(issue, {
    code: 'TASK_ASSIGNEES_NOT_ARRAY',
    path: 'taskUpserts[0].assigneeIds',
    message: 'Görev sorumluları dizi olmalıdır.'
  });
});

test('commit validation rejects blank or non-text project tags', () => {
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ tags: ['valid', '   '] }]
  })?.code, 'PROJECT_TAG_INVALID');
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ tags: ['valid', 42] }]
  })?.code, 'PROJECT_TAG_INVALID');
});

test('valid nested commit collections remain accepted', () => {
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{ tags: ['Alpha', 'Beta'] }],
    taskUpserts: [{ assigneeIds: ['18068', 23977] }]
  }), null);
  assert.equal(findNestedCommitCollectionIssue({
    projectUpserts: [{}],
    taskUpserts: [{}]
  }), null);
});

test('commit route applies nested collection validation before SQL persistence', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const validationPosition = route.indexOf('findNestedCommitCollectionIssue(changes)');
  const commitPosition = route.indexOf('createOrderedSqlAppRepository().commitChanges(changes)');

  assert.match(route, /findCommitChangeIssue\(changes\) \|\| findNestedCommitCollectionIssue\(changes\)/);
  assert.ok(validationPosition >= 0);
  assert.ok(commitPosition > validationPosition);
  assert.match(route, /status: 400/);
});
