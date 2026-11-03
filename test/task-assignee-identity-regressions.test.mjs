import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeTaskReferences } from '../src/domain/validation/index.js';
import { normalizeTaskAssigneePatch } from '../src/features/task-detail/taskAssigneePatch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const people = [
  { id: '100', employeeNo: '100', name: 'Aynı Ad' },
  { id: '200', employeeNo: '200', name: 'Aynı Ad' },
  { id: '300', employeeNo: '300', name: 'Tekil Ad' }
];

const context = {
  projects: [{ id: 'project-1', name: 'Proje', code: 'P-1' }],
  people,
  wbs: []
};

test("görev sorumlu yaması belirsiz olmayan adı kararlı sicile çevirir", () => {
  const result = normalizeTaskAssigneePatch({ sorumlu: ['Tekil Ad'] }, people);

  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.assigneeIds, ['300']);
  assert.equal(result.patch.assigneeIdsCanonical, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.patch, 'sorumlu'), false);
});

test("yinelenen görünüm adı keyfî sicil atamak yerine erişimi kapatır", () => {
  const result = normalizeTaskAssigneePatch({ sorumlu: ['Aynı Ad'] }, people);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TASK_ASSIGNEE_AMBIGUOUS');
  assert.match(result.error.message, /Sicil/);
});

test("yetkili sorumlu yaması eski görünüm adını geçersiz kılar ve tümünü temizlemeye izin verir", () => {
  const reassigned = normalizeTaskReferences({
    id: 'task-1',
    projectId: 'project-1',
    assigneeIds: ['300'],
    assigneeIdsCanonical: true,
    sorumlu: ['Aynı Ad']
  }, context);
  assert.deepEqual(reassigned.assigneeIds, ['300']);
  assert.deepEqual(reassigned.sorumlu, ['Tekil Ad']);
  assert.equal(Object.prototype.hasOwnProperty.call(reassigned, 'assigneeIdsCanonical'), false);

  const cleared = normalizeTaskReferences({
    id: 'task-1',
    projectId: 'project-1',
    assigneeIds: [],
    assigneeIdsCanonical: true,
    sorumlu: ['Tekil Ad']
  }, context);
  assert.deepEqual(cleared.assigneeIds, []);
  assert.deepEqual(cleared.sorumlu, []);
});

test("eski yinelenen ad başvurusu keyfî çalışana eşlenmez", () => {
  const normalized = normalizeTaskReferences({
    id: 'task-legacy',
    projectId: 'project-1',
    sorumlu: ['Aynı Ad']
  }, context);

  assert.deepEqual(normalized.assigneeIds, []);
  assert.deepEqual(normalized.sorumlu, []);
});

test("görev çekmecesi açık kayda kadar normal yamayı hazırlıkta tutar", () => {
  const source = read('src/features/task-detail/TaskDetailOverlay.jsx');

  assert.match(source, /normalizeTaskAssigneePatch\(patch, people\)/);
  assert.match(source, /pendingRef\.current\.set\(taskId, entry\)/);
  assert.match(source, /saveTaskEdits\(\[\.\.\.edits\.values\(\)\]/);
  assert.doesNotMatch(source, /updateTask\(taskId, patch\)/);
});
