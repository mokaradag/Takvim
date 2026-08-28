/**
 * CN43N görev atama kapsamı ve Basit Mod Görevler sayfası.
 *
 * Kapsanan sözleşmeler:
 *   1. Sıradan kullanıcının proje seçicisi YALNIZCA "corporateprojectaccess"
 *      ile tam yetki aldığı projelerdir; kurumsal katalog açılmaz.
 *   2. Direktör/müdür/birim yöneticisi bütün etkin CN43N projelerini seçebilir
 *      ama bu, görev görünürlüğü ya da yönetici yetkisi vermez.
 *   3. Görev görünürlüğü hiçbir kullanıcı için değişmez; herkes kendi atanmış
 *      görevlerini görmeye devam eder.
 *   4. Basit Mod Görevler sayfası yalnızca Hızlı Görev Tanımı alanlarını
 *      gösterir; Gelişmiş Mod tablosu değişmeden durur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  canAssignTasksInProject,
  canWriteProject,
  resolveTaskCreationProject,
  resolveTaskMutationAccess,
  resolveWbsMutationAccess,
  taskAssignableProjects
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
    repository.indexOf('async function readProjectTags')
  );
  // Bayrak YALNIZCA üç yerde kullanılır: seçilebilir proje listesi, kişi
  // rehberinin yöneticinin KENDİ personeliyle sınırlı genişlemesi ve atanabilir
  // çalışan Sicilleri. Rehber genişlemesi olmadan, görünür FULL projesi
  // bulunmayan bir yönetici atayabileceği çalışanı seçicide hiç bulamıyordu;
  // Sicil kümesi olmadan da seçici bütün rehberi gösterip garanti reddedilen
  // kayıtlar ürettiriyordu.
  const usages = snapshot.match(/@canAssignAllCorporate/g) || [];
  assert.equal(usages.length, 3, 'atama bayrağı yalnızca seçilebilir proje, kişi ve kapsam sorgularında kullanılmalıdır');
  // Görünür proje kümesi bayrağa bakmaz.
  const visibleBlock = snapshot.slice(snapshot.indexOf('INSERT @VisibleProjects'), snapshot.indexOf('DECLARE @HasFullScope'));
  assert.doesNotMatch(visibleBlock, /@canAssignAllCorporate/);
  // Görev ve iş dağılım ağacı görünürlüğü de bayraktan etkilenmez.
  const taskBlock = snapshot.slice(snapshot.indexOf('SELECT t.*, v.AccessLevel'), snapshot.indexOf('SELECT ta.TaskId, ta.Sicil'));
  assert.doesNotMatch(taskBlock, /@canAssignAllCorporate/);
  const wbsBlock = snapshot.slice(snapshot.indexOf(';WITH RequiredPartialWbs'), snapshot.indexOf('SELECT t.*, v.AccessLevel'));
  assert.doesNotMatch(wbsBlock, /@canAssignAllCorporate/);
  // Rehber genişlemesi yalnızca yöneticinin kendi kapsamı kadardır.
  const peopleBlock = snapshot.slice(snapshot.indexOf('FROM dbo.MR_V_PeopleDirectory pd'), snapshot.indexOf('-- Görev ATAMA kapsamı: yöneticiler'));
  assert.match(peopleBlock, /@canAssignAllCorporate = 1\s+AND EXISTS \(\s+SELECT 1 FROM dbo\.MR_V_ExecutiveScope es/);
  // Atanabilir çalışan kümesi de yalnızca yöneticinin kendi kapsamıdır.
  const scopeBlock = snapshot.slice(snapshot.indexOf('SELECT es.EmployeeSicil'));
  assert.match(scopeBlock, /WHERE @canAssignAllCorporate = 1 AND es\.ManagerSicil = @sicil/);
});

/* ── 2. Basit Mod Görevler ──────────────────────────────────────── */

test('Görevler sayfası Basit Modda ulaşılabilir', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /const SIMPLE_NAV_IDS = new Set\(\['veri',/);
  assert.match(shell, /<SimpleTasksView onNewTask=/);
});

test('Basit Mod tablosu yalnızca hızlı görev tanımı alanlarını gösterir', () => {
  const fields = SIMPLE_TASK_COLUMNS.map((column) => column.field);
  assert.deepEqual(fields, ['proje', 'task', 'keyword', 'sorumlu', 'priority', 'status', 'targetFinish']);
  for (const field of ADVANCED_ONLY_TASK_FIELDS) {
    assert.equal(isSimpleTaskColumn(field), false, `${field} Basit Modda gösterilmemelidir`);
  }
  // İzdüşüm yalnızca sade alanları taşır.
  const projection = simpleTaskProjection({
    proje: 'Proje', task: 'İş', keyword: 'Teklif', sorumlu: ['Ayşe'],
    priority: 'high', status: 'todo', targetFinish: '2026-08-20',
    progress: 40, plannedHours: 12, plannedStart: '2026-08-01', deps: [{ predecessorId: 'x' }]
  });
  assert.deepEqual(Object.keys(projection).sort(), fields.slice().sort());
});

test('Basit Mod görünümü gelişmiş alanları okumaz', () => {
  const view = read('src/features/tasks/SimpleTasksView.jsx');
  // Gelişmiş moda ait alanlar tablo hücrelerinde HİÇ okunmaz.
  for (const field of ADVANCED_ONLY_TASK_FIELDS) {
    assert.equal(
      view.includes(`task.${field}`),
      false,
      `task.${field} Basit Mod tablosunda okunmamalıdır`
    );
  }
  // Gelişmiş Modun sütun başlıkları da yoktur.
  for (const label of ['Saat (P)', 'İlerleme<', '>Başlangıç<']) {
    assert.equal(view.includes(label), false, `${label} sütunu Basit Modda olmamalıdır`);
  }
  // Buna karşılık öncelik ve termin gösterilir.
  assert.match(view, /resolvePriority\(task\.priority\)/);
  assert.match(view, /fmt\(task\.targetFinish\)/);
});

test('Gelişmiş Mod tablosu ilerlemeyi korur ve efor saatini göstermez', () => {
  const view = read('src/features/tasks/TasksView.jsx');
  for (const label of ['İlerleme', 'Başlangıç', 'Bitiş', 'Hedef']) {
    assert.ok(view.includes(label), `${label} sütunu Gelişmiş Modda kalmalıdır`);
  }
  assert.doesNotMatch(view, /Saat \(P\)|plannedHours|actualHours/);
});

test('Öncelik Basit Modda tanımlanır, listelenir ve düzenlenir', () => {
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

  // Katalog Gelişmiş Modla AYNIDIR: ikinci bir öncelik modeli yoktur.
  for (const file of [panel, drawer, view]) {
    assert.match(file, /from '\.\.\/\.\.\/domain\/constants'/);
  }
  assert.deepEqual(Object.keys(PRIORITIES), ['critical', 'high', 'medium', 'low']);
});

test('Basit Mod düzenleyicisi gelişmiş alanları açmaz', () => {
  const drawer = read('src/features/task-detail/SimpleTaskDrawer.jsx');
  // Yalnızca hızlı görev tanımı alanları düzenlenir; gelişmiş alanlar
  // düzenleyiciye hiç girmez.
  for (const field of ['progress', 'plannedHours', 'actualHours', 'deps', 'recurrence', 'wbsId', 'budget']) {
    assert.equal(drawer.includes(`local.${field}`), false, `local.${field} Basit Mod düzenleyicisinde olmamalıdır`);
  }
  for (const component of ['RecurrenceEditor', 'RelEditor', 'BaselineSection']) {
    assert.equal(drawer.includes(component), false, `${component} Basit Modda kullanılmamalıdır`);
  }
  // Buna karşılık hatırlatma eylemi her iki modda da bulunur.
  assert.match(drawer, /<TaskReminderButton task=\{task\}/);
});
