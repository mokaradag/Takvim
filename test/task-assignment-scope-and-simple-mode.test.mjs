/**
 * CN43N görev atama kapsamı ve Temel Kip Görevler sayfası.
 *
 * Kapsanan sözleşmeler:
 *   1. Sıradan kullanıcının proje seçicisi YALNIZCA "corporateprojectaccess"
 *      ile tam yetki aldığı projelerdir; kurumsal katalog açılmaz.
 *   2. Direktör/müdür/birim yöneticisi bütün etkin CN43N projelerini seçebilir
 *      ama bu, görev görünürlüğü ya da yönetici yetkisi vermez.
 *   3. Görev görünürlüğü hiçbir kullanıcı için değişmez; herkes kendi atanmış
 *      görevlerini görmeye devam eder.
 *   4. Temel Kip Görevler sayfası yalnızca Hızlı Görev Tanımı alanlarını
 *      gösterir; Kapsamlı Kip tablosu değişmeden durur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  canAssignTasksInProject,
  canWriteProject,
  assigneeTaskCreateProjects,
  resolveTaskCreationProject,
  resolveTaskMutationAccess,
  resolveWbsMutationAccess,
  resolveTaskWbsMoveAccess,
  taskAssignableProjects,
  taskCreationScopeInProject
} from '../src/state/projectWritePolicy.js';
import { selectAssignableProjects } from '../src/state/appState.js';
import { hasTaskAssignmentScope } from '../src/server/authorization/authorization.js';
import {
  ADVANCED_ONLY_TASK_FIELDS,
  SIMPLE_TASK_COLUMNS,
  isSimpleTaskColumn,
  simpleTaskProjection
} from '../src/features/tasks/simpleTaskColumns.js';
import { PRIORITIES } from '../src/domain/constants/index.js';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const FULL_PROJECT = { id: 'p-full', code: 'P100', name: 'Yetkili proje', accessLevel: 'FULL' };
const PARTIAL_PROJECT = { id: 'p-partial', code: 'P200', name: 'Salt okunur proje', accessLevel: 'PARTIAL' };
const SCOPE_PROJECT = { id: 'p-scope', code: 'P300', name: 'Kapsam projesi', accessLevel: 'ASSIGN', rootWbsId: 'wbs-scope' };

function normalUserState() {
  return {
    projects: [FULL_PROJECT, PARTIAL_PROJECT],
    assignableProjects: [],
    tasks: [
      { id: 't-full', projectId: 'p-full' },
      { id: 't-partial', projectId: 'p-partial' }
    ],
    wbs: [],
    workspaceMode: 'portfolio'
  };
}

function executiveState() {
  return {
    projects: [FULL_PROJECT, PARTIAL_PROJECT],
    // Sunucu, yönetici için bütün etkin CN43N projelerini bu ayrı kümede döner.
    assignableProjects: [SCOPE_PROJECT, { ...FULL_PROJECT, accessLevel: 'ASSIGN' }],
    tasks: [
      { id: 't-full', projectId: 'p-full' },
      { id: 't-scope', projectId: 'p-scope' }
    ],
    wbs: [],
    workspaceMode: 'portfolio'
  };
}

/* ── 1. Proje seçimi ve erişim ──────────────────────────────────── */

test('sıradan kullanıcı yalnızca corporateprojectaccess projelerini seçebilir', () => {
  const state = normalUserState();
  const selectable = taskAssignableProjects(state);
  assert.deepEqual(selectable.map((project) => project.id), ['p-full']);
  // Salt okunur proje seçilemez.
  assert.equal(canAssignTasksInProject(state, 'p-partial'), false);
  assert.equal(canAssignTasksInProject(state, 'p-full'), true);
});

test('sıradan kullanıcı bütün CN43N kataloğuna erişmez', () => {
  const state = normalUserState();
  assert.deepEqual(selectAssignableProjects(state), []);
  // Kapsam dışı bir proje kimliği yazma denemesinde de reddedilir.
  assert.equal(canAssignTasksInProject(state, 'p-scope'), false);
  assert.equal(resolveTaskCreationProject(state, 'p-scope'), null);
});

test('sıradan kullanıcının görev görünürlüğü değişmez', () => {
  const state = normalUserState();
  // Salt okunur projedeki görev hâlâ görünür ama DÜZENLENEMEZ: görünürlük
  // kuralı ile yazma kuralı ayrıdır.
  const access = resolveTaskMutationAccess(state, 't-partial', { task: 'yeni ad' });
  assert.equal(access.ok, false);
  assert.equal(access.code, 'PROJECT_WRITE_FORBIDDEN');
  // Kendi projesindeki görev düzenlenebilir.
  assert.equal(resolveTaskMutationAccess(state, 't-full', { task: 'yeni ad' }).ok, true);
});

test('yönetici bütün etkin CN43N projelerini görev tanımlarken seçebilir', () => {
  const state = executiveState();
  const selectable = taskAssignableProjects(state).map((project) => project.id);
  assert.deepEqual(selectable, ['p-full', 'p-scope']);
  assert.equal(canAssignTasksInProject(state, 'p-scope'), true);
  // Seçici kapsamdaki proje, görev oluşturma hedefine de çözülür.
  assert.equal(resolveTaskCreationProject(state, 'p-scope')?.id, 'p-scope');
  // Kök dağılım düğümü kapsam kaydından okunur (ağaç istemciye yüklenmez).
  assert.equal(resolveTaskCreationProject(state, 'p-scope')?.rootWbsId, 'wbs-scope');
});

test('görev atama kapsamı yinelenen proje kayıtlarını seçicide çoğaltmaz', () => {
  const state = executiveState();
  state.assignableProjects = [
    SCOPE_PROJECT,
    { ...SCOPE_PROJECT },
    { ...FULL_PROJECT, accessLevel: 'ASSIGN' }
  ];
  assert.deepEqual(taskAssignableProjects(state).map((project) => project.id), ['p-full', 'p-scope']);
});

test('geniş proje seçimi yönetici/ilgisiz yetkiler vermez', () => {
  const state = executiveState();
  // Kapsam kaydı TAM YAZMA yetkisi değildir.
  assert.equal(canWriteProject(SCOPE_PROJECT), false);
  // İş dağılım ağacı yazması hâlâ tam yetki ister.
  const wbsState = {
    ...state,
    wbs: [{ id: 'wbs-scope', projectId: 'p-scope', parentId: null, code: 'P300', name: 'Kök' }]
  };
  const wbsAccess = resolveWbsMutationAccess(wbsState, 'wbs-scope');
  assert.equal(wbsAccess.ok, false);
  assert.equal(wbsAccess.code, 'PROJECT_WRITE_FORBIDDEN');
  const assignmentOnlyState = {
    ...state,
    assignableProjects: [{ ...SCOPE_PROJECT, accessLevel: undefined }]
  };
  const taskAccess = resolveTaskMutationAccess(assignmentOnlyState, 't-scope', { task: 'Yeni ad' });
  assert.equal(taskAccess.ok, true);
  assert.equal(taskAccess.scope, 'ASSIGNMENT');
  assert.equal(taskAccess.canManageStructure, false);
  // Kapsam yalnızca yöneticilere açıktır ve sistem yöneticiliğiyle eş değildir.
  assert.equal(hasTaskAssignmentScope({ isExecutive: true }), true);
  assert.equal(hasTaskAssignmentScope({ isSystemAdmin: true }), true);
  assert.equal(hasTaskAssignmentScope({}), false);
});

test('görev atama kapsamı sunucuda YENİDEN doğrulanır', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  const body = repository.slice(
    repository.indexOf('async function assertTaskProjectScope'),
    repository.indexOf('async function projectRootWbsId')
  );
  // Kapsam yalnızca etkin KURUMSAL projeleri ve yöneticinin KENDİ personelini kapsar.
  assert.match(body, /SourceType = 'CORPORATE' AND IsActive = 1/);
  assert.match(body, /dbo\.MR_V_ExecutiveScope es/);
  // Proje üst verisi ve iş dağılım ağacı yazmaları kapsam DIŞINDADIR.
  const projectCommit = repository.slice(
    repository.indexOf('async function commitProject'),
    repository.indexOf('async function commitWbs')
  );
  assert.match(projectCommit, /assertProjectWriteAccess\(actor\.effective, projectId\)/);
  assert.doesNotMatch(projectCommit, /assertTaskProjectAccess/);
});

test('anlık görüntü sorgusu görünürlüğü değil yalnızca SEÇİLEBİLİR listeyi genişletir', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  const snapshot = repository.slice(
    repository.indexOf('async function loadSnapshotFrom'),
    repository.indexOf('async function loadAuthoritativeMutationRows')
  );
  // Bayrak YALNIZCA üç yerde kullanılır: seçilebilir proje listesi, kişi
  // rehberinin yöneticinin KENDİ personeliyle sınırlı genişlemesi ve atanabilir
  // çalışan Sicilleri. Rehber genişlemesi olmadan, görünür FULL projesi
  // bulunmayan bir yönetici atayabileceği çalışanı seçicide hiç bulamıyordu;
  // Sicil kümesi olmadan da seçici bütün rehberi gösterip garanti reddedilen
  // kayıtlar ürettiriyordu.
  const usages = snapshot.match(/@canAssignAllCorporate/g) || [];
  assert.equal(usages.length, 3, 'atama bayrağı yalnızca seçilebilir proje, kişi ve kapsam sorgularında kullanılmalıdır');
  // Deyim sınırlarında dilimleme: bayrağın sızmaması gereken kümeler tek tek
  // sınanır, araya giren başka deyimler sonucu bozmaz.
  const allStatements = (head) => {
    const found = [];
    for (let start = snapshot.indexOf(head); start >= 0; start = snapshot.indexOf(head, start + head.length)) {
      const end = snapshot.indexOf(';', start + head.length);
      assert.ok(end > start, `deyim sonu bulunmalıdır: ${head}`);
      found.push(snapshot.slice(start, end));
    }
    assert.ok(found.length > 0, `deyim bulunmalıdır: ${head}`);
    return found;
  };
  const statement = (head) => allStatements(head)[0];
  // Görünür proje kümesi ve görev kapsamı bayrağa bakmaz.
  for (const head of [
    "INSERT #VisibleProjects(ProjectId, AccessLevel)",
    "INSERT #ScopedTasks(TaskId",
    "INSERT #OwnScopedProjects(ProjectId)",
    "INSERT #ScopeAssignedProjects(ProjectId)",
    "INSERT #TaskAssigneeFacts(TaskId",
    "INSERT #VisibleTasks(TaskId",
    ";WITH RequiredPartialWbs AS ("
  ]) {
    for (const sqlStatement of allStatements(head)) {
      assert.doesNotMatch(sqlStatement, /@canAssignAllCorporate/, `${head} bayraktan etkilenmemelidir`);
    }
  }
  assert.match(statement('INSERT #VisibleTasks(TaskId'), /SELECT t\.TaskId/);
  // Görev ve WBS seçimleri de bayrağı okumaz.
  const taskSelect = statement('SELECT t.*, visible.AccessLevel');
  assert.match(taskSelect, /SELECT t\.\*, visible\.AccessLevel/);
  assert.doesNotMatch(taskSelect, /@canAssignAllCorporate/);
  const wbsSelect = statement('SELECT w.*');
  assert.doesNotMatch(wbsSelect, /@canAssignAllCorporate/);
  // Rehber genişlemesi yalnızca yöneticinin kendi kapsamı kadardır.
  assert.match(statement('INSERT #DirectorySicils(Sicil, IsPublished)'), /SELECT es\.EmployeeSicil, 1 FROM #ExecutiveScope es WHERE @canAssignAllCorporate = 1/);
  // Atanabilir çalışan kümesi de yalnızca yöneticinin kendi kapsamıdır.
  const scopeBlock = snapshot.slice(snapshot.indexOf('SELECT es.EmployeeSicil\n    FROM #ExecutiveScope es'));
  assert.match(snapshot, /INSERT #ExecutiveScope\(EmployeeSicil\)\s+SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope\s+WHERE ManagerSicil = @sicil/);
  assert.match(scopeBlock, /FROM #ExecutiveScope es\s+WHERE @canAssignAllCorporate = 1/);
});

/* ── 2. Temel Kip Görevler ──────────────────────────────────────── */

test('Görevler sayfası Temel Kipte ulaşılabilir', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(read('src/components/shell/navigation.js'), /SIMPLE_NAV_IDS = new Set\(\['ozet', 'veri',/);
  assert.match(shell, /<SimpleTasksView onNewTask=/);
});

test('Temel Kip tablosu yalnızca hızlı görev tanımı alanlarını gösterir', () => {
  const fields = SIMPLE_TASK_COLUMNS.map((column) => column.field);
  assert.deepEqual(fields, ['proje', 'task', 'keyword', 'sorumlu', 'priority', 'status', 'targetFinish']);
  for (const field of ADVANCED_ONLY_TASK_FIELDS) {
    assert.equal(isSimpleTaskColumn(field), false, `${field} Temel Kipte gösterilmemelidir`);
  }
  // İzdüşüm yalnızca sade alanları taşır.
  const projection = simpleTaskProjection({
    proje: 'Proje', task: 'İş', keyword: 'Teklif', sorumlu: ['Ayşe'],
    priority: 'high', status: 'todo', targetFinish: '2026-08-20',
    progress: 40, plannedHours: 12, plannedStart: '2026-08-01', deps: [{ predecessorId: 'x' }]
  });
  assert.deepEqual(Object.keys(projection).sort(), fields.slice().sort());
});

test('Temel Kip görünümü gelişmiş alanları okumaz', () => {
  const view = read('src/features/tasks/SimpleTasksView.jsx');
  // Kapsamlı kipe ait alanlar tablo hücrelerinde HİÇ okunmaz.
  for (const field of ADVANCED_ONLY_TASK_FIELDS) {
    assert.equal(
      view.includes(`task.${field}`),
      false,
      `task.${field} Temel Kip tablosunda okunmamalıdır`
    );
  }
  // Kapsamlı Kipin sütun başlıkları da yoktur.
  for (const label of ['Saat (P)', 'İlerleme<', '>Başlangıç<']) {
    assert.equal(view.includes(label), false, `${label} sütunu Temel Kipte olmamalıdır`);
  }
  // Buna karşılık öncelik ve termin gösterilir.
  assert.match(view, /resolvePriority\(task\.priority\)/);
  assert.match(view, /fmt\(task\.targetFinish\)/);
});

test('Kapsamlı Kip tablosu ilerlemeyi korur ve efor saatini göstermez', () => {
  const view = read('src/features/tasks/TasksView.jsx');
  for (const label of ['İlerleme', 'Başlangıç', 'Bitiş', 'Hedef']) {
    assert.ok(view.includes(label), `${label} sütunu Kapsamlı Kipte kalmalıdır`);
  }
  assert.doesNotMatch(view, /Saat \(P\)|plannedHours|actualHours/);
});

test('Öncelik Temel Kipte tanımlanır, listelenir ve düzenlenir', () => {
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  const drawer = read('src/features/task-detail/SimpleTaskDrawer.jsx');
  const view = read('src/features/tasks/SimpleTasksView.jsx');

  // Hızlı görev tanımında seçilir ve göreve YAZILIR.
  assert.match(panel, /aria-label="Görev önceliği"/);
  assert.match(panel, /priority: normalizePriorityId\(priority\)/);
  // Sade tabloda hem gösterilir hem süzülür.
  assert.match(view, /<FilterableTH label="Öncelik"/);
  assert.match(view, /filter=\{filters\.priority\}/);
  // Basit görev düzenleyicisinde değiştirilir.
  assert.match(drawer, /aria-label="Görev önceliği"/);
  assert.match(drawer, /save\(\{ priority: option\.id \}\)/);

  // Katalog Kapsamlı Kiple AYNIDIR: ikinci bir öncelik modeli yoktur.
  for (const file of [panel, drawer, view]) {
    assert.match(file, /from '\.\.\/\.\.\/domain\/constants'/);
  }
  assert.deepEqual(Object.keys(PRIORITIES), ['critical', 'high', 'medium', 'low']);
});

test('Temel Kip düzenleyicisi gelişmiş alanları açmaz', () => {
  const drawer = read('src/features/task-detail/SimpleTaskDrawer.jsx');
  // Yalnızca hızlı görev tanımı alanları düzenlenir; gelişmiş alanlar
  // düzenleyiciye hiç girmez.
  for (const field of ['progress', 'plannedHours', 'actualHours', 'deps', 'recurrence', 'wbsId', 'budget']) {
    assert.equal(drawer.includes(`local.${field}`), false, `local.${field} Temel Kip düzenleyicisinde olmamalıdır`);
  }
  for (const component of ['RecurrenceEditor', 'RelEditor', 'BaselineSection']) {
    assert.equal(drawer.includes(component), false, `${component} Temel Kipte kullanılmamalıdır`);
  }
  // Buna karşılık hatırlatma eylemi her iki kipte de bulunur.
  assert.match(drawer, /<TaskReminderButton task=\{task\}/);
});

test('atama kapsamı kaynak projede FULL olmadan taşıma sunmaz; aynı proje ve FULL kaynak korunur', () => {
  const state = executiveState();
  const expected = {
    ok: false, code: 'PROJECT_WRITE_FORBIDDEN', field: 'projectId', projectId: FULL_PROJECT.id,
    message: 'Görev yalnızca kaynak projede tam proje yetkisiyle başka projeye taşınabilir.'
  };
  for (const patch of [{ projectId: FULL_PROJECT.id }, { proje: FULL_PROJECT.name }]) {
    assert.deepEqual(resolveTaskMutationAccess(state, 't-scope', patch), expected);
  }
  assert.equal(resolveTaskMutationAccess(state, 't-scope', { projectId: SCOPE_PROJECT.id }).ok, true);
  assert.equal(resolveTaskMutationAccess(state, 't-scope', { task: 'Aynı projede düzenleme' }).ok, true);
  assert.equal(resolveTaskMutationAccess(state, 't-full', { projectId: SCOPE_PROJECT.id }).ok, true);

  const source = 'd5d70aec-0a88-f111-9136-00505699bacd';
  const destination = 'd5d70aec-0a88-f111-9136-00505699bace';
  const actual = { ...state, projects: [{ id: source, accessLevel: 'PARTIAL' }],
    assignableProjects: [{ id: source, accessLevel: 'ASSIGN' }, { id: destination, accessLevel: 'ASSIGN' }],
    tasks: [{ id: 'actual-task', projectId: source }] };
  assert.equal(resolveTaskMutationAccess(actual, 'actual-task', { projectId: source.toUpperCase() }).ok, true);
  assert.deepEqual(resolveTaskMutationAccess(actual, 'actual-task', { projectId: destination.toUpperCase() }), { ...expected, projectId: destination });
});

test('kısmi commit sonrası farklı GUID harf biçimi proje kapsamını değiştirmez', () => {
  const full = 'd5d70aec-0a88-f111-9136-00505699bacd';
  const assigned = 'd5d70aec-0a88-f111-9136-00505699bace';
  const own = 'd5d70aec-0a88-f111-9136-00505699bacf';
  const other = 'd5d70aec-0a88-f111-9136-00505699bad0';
  // Kısmi yanıt görevdeki özgün harf biçimini geri yükler; atama kataloğu yenilenmez.
  const state = {
    currentUser: { id: '900001' },
    projects: [{ id: full, accessLevel: 'FULL' }, { id: full.toUpperCase(), accessLevel: 'FULL' },
      { id: own, accessLevel: 'PARTIAL' }, { id: other, accessLevel: 'READ' }],
    assignableProjects: [{ id: full.toUpperCase() }, { id: assigned }, { id: assigned.toUpperCase() }],
    tasks: [{ id: 'restored', projectId: assigned.toUpperCase() },
      { id: 'own', projectId: own.toUpperCase(), isCurrentUserAssignee: true, assigneeIds: ['900001'] }]
  };
  assert.deepEqual(taskAssignableProjects(state).map(project => project.id), [full, assigned, own]);
  assert.deepEqual(assigneeTaskCreateProjects(state).map(project => project.id), [own]);
  assert.equal(taskCreationScopeInProject(state, full.toUpperCase()), 'FULL');
  assert.equal(taskCreationScopeInProject(state, assigned.toUpperCase()), 'ASSIGNMENT');
  assert.equal(taskCreationScopeInProject(state, own.toUpperCase()), 'ASSIGNEE_CREATE');
  assert.equal(resolveTaskMutationAccess(state, 'restored', { task: 'Güncelleme' }).ok, true);
  assert.equal(resolveTaskMutationAccess(state, 'own', { task: 'Kendi işi' }).scope, 'ASSIGNEE');
  assert.equal(canAssignTasksInProject(state, assigned.toUpperCase()), true);
  assert.equal(canAssignTasksInProject(state, own.toUpperCase()), false);
  assert.equal(taskCreationScopeInProject(state, other.toUpperCase()), null);
  assert.equal(resolveTaskCreationProject(state, other.toUpperCase()), null);
  assert.equal(resolveTaskMutationAccess(state, 'restored', { projectId: full }).ok, false);
});


test('WBS kapsamı aynı GUID harf biçimlerini eşit, farklı projeleri ayrı tutar', () => {
  const source = 'd5d70aec-0a88-f111-9136-00505699bacd';
  const other = 'd5d70aec-0a88-f111-9136-00505699bace';
  const state = {
    projects: [{ id: source, accessLevel: 'FULL' }, { id: other, accessLevel: 'FULL' }],
    tasks: [{ id: 'task', projectId: source }],
    wbs: [{ id: 'source', projectId: source }, { id: 'same', projectId: source.toUpperCase() }, { id: 'other', projectId: other }]
  };
  assert.equal(resolveWbsMutationAccess(state, 'source', 'same').ok, true);
  assert.equal(resolveTaskWbsMoveAccess(state, ['task'], 'same').ok, true);
  assert.equal(resolveWbsMutationAccess(state, 'source', 'other').ok, false);
  assert.equal(resolveTaskWbsMoveAccess(state, ['task'], 'other').code, 'CROSS_PROJECT_TASK_WBS_MOVE');
  state.projects[0].accessLevel = 'PARTIAL';
  assert.equal(resolveWbsMutationAccess(state, 'source', 'same').ok, false);
  assert.equal(resolveTaskWbsMoveAccess(state, ['task'], 'same').ok, false);
});

test('proje seçimi büyük portföyde kimlikleri doğrusal sayıda okur ve ilk adayı korur', () => {
  let reads = 0;
  const count = 256;
  const ids = Array.from({ length: count }, (_, index) => `a1b2c3d4-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
  const record = (id, accessLevel) => ({ get id() { reads += 1; return id; }, accessLevel });
  const state = {
    projects: ids.map(id => record(id, 'PARTIAL')),
    assignableProjects: ids.flatMap(id => [record(id.toUpperCase()), record(id)]),
    tasks: ids.map(projectId => ({ projectId: projectId.toUpperCase(), isCurrentUserAssignee: true }))
  };
  const selected = taskAssignableProjects(state);
  assert.equal(selected.length, count);
  assert.ok(selected.every((project, index) => project === state.assignableProjects[index * 2]));
  assert.ok(reads <= 20 * count, `kimlik okuması portföyle doğrusal kalır (${reads})`);
});
