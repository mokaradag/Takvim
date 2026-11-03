import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findUpsertIntentIssue } from '../src/server/repository/upsertIntentPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test("sürümlü güncelleme artık olmayan proje WBS veya görevi yeniden oluşturamaz", () => {
  for (const entityType of ['PROJECT', 'WBS', 'TASK']) {
    assert.deepEqual(findUpsertIntentIssue({
      exists: false,
      version: 'AAAAAAAAAAA=',
      entityType,
      id: `${entityType.toLowerCase()}-id`
    }), {
      code: 'UPSERT_TARGET_MISSING',
      entityType,
      id: `${entityType.toLowerCase()}-id`,
      message: 'Kayıt artık bulunamadı. Verileri yeniden yükleyin.'
    });
  }
});

test("oluşturma niyetli güncelleme mevcut kimliğin üzerine yazamaz", () => {
  const issue = findUpsertIntentIssue({
    exists: true,
    version: null,
    entityType: 'TASK',
    id: 'task-id'
  });

  assert.equal(issue?.code, 'UPSERT_CREATE_COLLISION');
  assert.equal(issue?.entityType, 'TASK');
});

test("eşleşen oluşturma ve güncelleme niyeti geçerli kalır", () => {
  assert.equal(findUpsertIntentIssue({ exists: false, version: null }), null);
  assert.equal(findUpsertIntentIssue({ exists: false, version: '   ' }), null);
  assert.equal(findUpsertIntentIssue({ exists: true, version: 'AAAAAAAAAAA=' }), null);
});

test("sıralı SQL kaydı bütün değişebilir hedefleri kalıcılıktan önce kilitler", () => {
  const validation = read('src/server/repository/upsertIntentValidation.js');

  for (const value of ['projectUpserts', 'wbsUpserts', 'taskUpserts']) {
    assert.match(validation, new RegExp(`collection: '${value}'`));
  }
  for (const table of ['MR_Projects', 'MR_WBS', 'MR_Tasks']) {
    assert.match(validation, new RegExp(`table: '${table}'`));
  }
  assert.match(validation, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(validation, /\.sort\(\(left, right\) => String\(left\.id\)\.localeCompare\(String\(right\.id\)\)\)/);
});

test("yetki niyet bütünlük planlama ve yazma tek SERIALIZABLE işlemi paylaşır", () => {
  const wrapper = read('src/server/repository/orderedSqlAppRepository.js');
  const intentPosition = wrapper.indexOf('await assertUpsertIntentMatchesPersistence');
  const commitPosition = wrapper.indexOf('return repository.commitChanges');

  assert.ok(intentPosition >= 0, 'upsert-intent validation must run');
  assert.ok(commitPosition > intentPosition, 'intent validation must precede repository writes');
  assert.match(wrapper, /withSqlTransaction\(async \(transaction\) =>/);
  assert.match(wrapper, /isolationLevel: sql\.ISOLATION_LEVEL\.SERIALIZABLE/);
});
