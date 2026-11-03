import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDependencyCycle } from '../src/server/repository/dependencyGraphValidation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test("bağımlılık döngü tespiti yönlü döngüsüz proje ağını kabul eder", () => {
  const cycle = findDependencyCycle([
    { predecessorId: 'a', taskId: 'b' },
    { predecessorId: 'a', taskId: 'c' },
    { predecessorId: 'b', taskId: 'd' },
    { predecessorId: 'c', taskId: 'd' }
  ]);
  assert.deepEqual(cycle, []);
});

test("bağımlılık döngüsü tespiti yalnızca kalıcı döngüdeki görevleri döndürür", () => {
  const cycle = findDependencyCycle([
    { PredecessorTaskId: 'a', TaskId: 'b' },
    { PredecessorTaskId: 'b', TaskId: 'c' },
    { PredecessorTaskId: 'c', TaskId: 'a' },
    { PredecessorTaskId: 'c', TaskId: 'downstream' }
  ]);
  assert.deepEqual(new Set(cycle), new Set(['a', 'b', 'c']));
  assert.equal(cycle.includes('downstream'), false);
});

test("iç SQL depo işi dış işlemi yeniden kullanır", () => {
  const source = read('src/server/db/pool.js');
  assert.match(source, /const transactionContext = new AsyncLocalStorage\(\);/);
  assert.match(source, /const activeTransaction = transactionContext\.getStore\(\);/);
  assert.match(source, /if \(activeTransaction\) return work\(activeTransaction, sql\);/);
  assert.match(source, /return await transactionContext\.run\(transaction, async \(\) => \{/);
});

test("gerçek kayıt tek kök WBS değişmezini kilitler ve korur", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_WBS WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE ProjectId = @projectId/s
  );
  assert.match(source, /if \(roots\.length !== 1\)/);
  assert.match(source, /if \(existingRoots\.length === 1 && roots\[0\]\.id !== existingRoots\[0\]\)/);
});

test("gerçek kayıt son bağımlılık ağını işlem kilitlerinde doğrular", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_TaskDependencies WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE ProjectId = @projectId/s
  );
  assert.match(source, /projectEdges\.set\(previousProjectId, removeTaskEdges/);
  assert.match(source, /projectEdges\.set\(projectId, removeTaskEdges/);
  assert.match(source, /const cycleTaskIds = findDependencyCycle\(projectEdges\.get\(projectId\) \|\| \[\]\);/);
  assert.match(
    source,
    /return withSqlTransaction\(async \(transaction\) => \{\s+const plannedChanges = await planIntegrity\(transaction, changes\);[\s\S]*?return baseRepository\.commitChanges\(plannedChanges\);/s
  );
  // İşlem başına e-posta tercihi taşınırken planlanan nesne KOPYALANMAZ:
  // bağımlılık planlama işareti sayılamayan bir simgedir ve yayılma onu düşürür.
  assert.match(source, /if \(input\?\.notifyAssignees === true\) plannedChanges\.notifyAssignees = true;/);
  assert.doesNotMatch(source, /baseRepository\.commitChanges\(\{ \.\.\.plannedChanges/);
});

test("tekrar oluşumu oluşturma şablonu aynı güçlendirilmiş işlemde kilitler", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(source, /recurrenceParentId:\s*task\.recurrenceParentId\s*\?\s*uuid\(task\.recurrenceParentId, 'Tekrar şablonu kimliği'\)/);
  assert.match(source, /\.filter\(\(task\) => task\.recurrenceParentId\)\s*\.map\(\(task\) => task\.recurrenceParentId\)/);
  assert.match(source, /for \(const taskId of \[\.\.\.referencedTaskIds\]\.sort\(\)\) \{\s+if \(creatingTaskIds\.has\(taskId\)\) continue;\s+const row = await rowForUpdate\(executor, 'MR_Tasks', 'TaskId', taskId/s);
  assert.match(source, /FROM dbo\.\$\{safeTable\} WITH \(UPDLOCK, HOLDLOCK\)/);
});

test("proje yazma takvim ister; verilen bütün takvimler etkin olmalıdır", () => {
  const source = read('src/server/repository/hardenedSqlAppRepository.js');
  assert.match(
    source,
    /FROM dbo\.MR_Calendars WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE CalendarId = @calendarId AND IsActive = 1/s
  );
  assert.match(source, /for \(const project of changes\.projectUpserts\) \{/);
  assert.match(source, /if \(!project\.calendarId\) \{/);
  assert.match(source, /calendarIds\.add\(uuid\(project\.calendarId, 'Takvim kimliği'\)\);/);
  assert.match(source, /for \(const task of changes\.taskUpserts\) \{/);
  assert.match(source, /if \(task\.calendarId\) calendarIds\.add\(uuid\(task\.calendarId, 'Takvim kimliği'\)\);/);
});

test("kayıt API güçlendirilmiş SQL sınırından önce WBS sırasını korur", () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const wrapper = read('src/server/repository/orderedSqlAppRepository.js');

  assert.match(route, /createOrderedSqlAppRepository/);
  assert.doesNotMatch(route, /createSqlAppRepository/);
  assert.match(wrapper, /createHardenedSqlAppRepository/);
  assert.match(wrapper, /orderWbsUpsertsByParents/);
});
