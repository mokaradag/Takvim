import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeTaskReferences } from '../src/domain/validation/index.js';
import { applyProjectTagPropagation, planProjectTagPropagation } from '../src/domain/tags/index.js';
import {
  prepareProjectCreation,
  prepareProjectUpdateChanges
} from '../src/state/projectCreation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function context() {
  return {
    calendars: [{ id: 'calendar-1', name: 'Calendar' }],
    people: [{ id: '100', employeeNo: '100', name: 'Project Lead' }],
    projects: [{
      id: 'project-1',
      name: 'Project One',
      code: 'P-1',
      source: 'manual',
      color: 'blue',
      leadId: '100',
      lead: 'Project Lead',
      calendarId: 'calendar-1',
      dataDate: '2026-07-24',
      tags: ['Risk'],
      version: 'AAAAAAAAAAA='
    }],
    wbs: [{
      id: 'wbs-1',
      projectId: 'project-1',
      parentId: null,
      code: '1',
      name: 'Project One',
      sortOrder: 1,
      version: 'AAAAAAAAAAA='
    }],
    tasks: [{
      id: 'task-1',
      projectId: 'project-1',
      projectCode: 'P-1',
      proje: 'Project One',
      color: 'blue',
      wbsId: 'wbs-1',
      task: 'Task One',
      keyword: 'Risk',
      assigneeIds: ['100'],
      sorumlu: ['Project Lead'],
      deps: [],
      version: 'AAAAAAAAAAA='
    }]
  };
}

test('new project root WBS codes are project-local and always start at 1', () => {
  const base = context();
  base.wbs.push({
    id: 'another-root',
    projectId: 'another-project',
    parentId: null,
    code: '9',
    name: 'Another Project',
    sortOrder: 1
  });

  const result = prepareProjectCreation({
    name: 'Project Two',
    code: 'P-2',
    color: 'emerald',
    leadId: '100',
    calendarId: 'calendar-1',
    dataDate: '2026-07-24',
    tags: []
  }, base, {
    projectId: 'project-2',
    rootWbsId: 'wbs-2'
  });

  assert.equal(result.ok, true);
  assert.equal(result.rootWbs.code, '1');
  assert.equal(result.changes.wbsUpserts[0].code, '1');
});

test('project display metadata changes do not rewrite every persisted task', () => {
  const base = context();
  const result = prepareProjectUpdateChanges('project-1', {
    name: 'Renamed Project',
    code: 'P-RENAMED',
    color: 'emerald'
  }, base);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.taskUpserts, []);
  assert.equal(result.changes.projectUpserts.length, 1);
  assert.equal(result.changes.wbsUpserts.length, 1);

  const normalizedTask = normalizeTaskReferences(base.tasks[0], {
    projects: [result.project],
    people: base.people,
    wbs: [{ ...base.wbs[0], name: 'Renamed Project' }]
  });
  assert.equal(normalizedTask.proje, 'Renamed Project');
  assert.equal(normalizedTask.projectCode, 'P-RENAMED');
  assert.equal(normalizedTask.color, 'emerald');
});

test('project tag canonicalization still persists only the affected task keyword', () => {
  const base = context();
  base.tasks = [
    { ...base.tasks[0], keyword: 'risk' },
    { ...base.tasks[0], id: 'task-2', keyword: 'Other' }
  ];

  const result = prepareProjectUpdateChanges('project-1', { tags: ['Risk'] }, base);

  assert.equal(result.ok, true);
  // Kanonikleştirme kalıcı katmanda canlı satırlara uygulanır: istemcinin
  // gördüğü görev listesinden türetilen bir yama, eşzamanlı bir kullanıcının
  // aynı anda oluşturduğu görevi kapsamazdı.
  assert.deepEqual(result.changes.taskUpserts, []);
  const plan = planProjectTagPropagation({ storedTags: base.projects[0].tags, nextTags: result.project.tags });
  const propagated = applyProjectTagPropagation(base.tasks, 'project-1', plan);
  assert.deepEqual(propagated.map((task) => [task.id, task.keyword]), [['task-1', 'Risk'], ['task-2', 'Other']]);
});

test('persisted data mode is read in the state initializer, not after the first render', () => {
  const source = read('src/components/shell/ApplicationRoot.jsx');
  const page = read('src/app/page.js');

  // Uygulama kökü YALNIZCA tarayıcıda çizilir; tembel başlatıcı hidrasyon
  // uyuşmazlığı üretemez. Modu etkiyle okumak ilk karede her zaman
  // `DataModeChooser` çiziyor, kullanıcı her yeniden yüklemede pencereyi
  // görüyor ve o karedeki tıklama saklanan modu eziyordu.
  assert.match(page, /dynamic\(\(\) => import\('\.\.\/components\/shell\/ApplicationRoot'\), \{ ssr: false \}\)/);
  assert.match(source, /const \[dataMode, setDataModeState\] = useState\(readInitialDataMode\);/);
  assert.doesNotMatch(source, /setDataModeState\(readInitialDataMode\(\)\)/);
});

test('snapshot and co-assignee projection reuse one serializable SQL transaction', () => {
  const poolSource = read('src/server/db/pool.js');
  const projectionSource = read('src/server/repository/projectedSqlAppRepository.js');

  assert.match(poolSource, /const activeTransaction = transactionContext\.getStore\(\);\s*if \(activeTransaction\) return activeTransaction;/s);
  assert.match(poolSource, /withSqlTransaction\(work, \{ isolationLevel = sql\.ISOLATION_LEVEL\.READ_COMMITTED \} = \{\}\)/);
  assert.match(projectionSource, /return withSqlTransaction\(async \(transaction\) => \{/);
  assert.match(projectionSource, /const \{ snapshot, auth \} = await baseRepository\.readSnapshotWithAuthorization\(\);/);
  // Kurumsal katalog tazelemesi bilinçli olarak serileştirilebilir işlemin dışındadır.
  assert.match(projectionSource, /await baseRepository\.refreshCorporateCatalog\(\);\s*return withSqlTransaction\(/s);
  // Tamamlama aynı işlemde ve YETKİ BAĞLAMIYLA çalışır: satır düzeyinde
  // görünürlük süzgeci olmadan, kısmi anlık görüntünün gizlediği eş sorumlular
  // geri getiriliyordu.
  assert.match(projectionSource, /loadVisibleTaskAssignees\(transaction, taskIds, auth\)/);
  assert.match(projectionSource, /WHERE @isAdmin = 1/);
  assert.match(projectionSource, /FROM dbo\.MR_V_ExecutiveScope es\s+WHERE es\.ManagerSicil = @sicil AND es\.EmployeeSicil = ta\.Sicil/);
  assert.match(projectionSource, /isolationLevel: sql\.ISOLATION_LEVEL\.SERIALIZABLE/);
});
