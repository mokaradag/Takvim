/**
 * Anlık görüntü ana sorgusunun (phase.snapshot.main-query) yapı sözleşmesi.
 *
 * Birleştirilmiş toplu iş, yetkili yükü değiştirmeden YİNELENEN SQL işini
 * kaldırmalıdır: kurumsal görünümler bir kez okunur, yetkilendirme kararları
 * satır başına yeniden türetilmez ve ara kümeler iyileştiricinin gerçek satır
 * sayısını görebileceği geçici tablolarda tutulur.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function snapshotBatch() {
  return read('src/server/repository/sqlAppRepository.js')
    .split('async function loadSnapshotFrom(')[1]
    .split('async function loadAuthoritativeMutationRows(')[0];
}

/** Toplu işin YALNIZCA SQL deyimleri; yorum satırları ayıklanmış hâlde. */
function snapshotStatements() {
  return snapshotBatch()
    .split('await req.query(`')[1]
    .split('`);')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/* ── 1 · Yinelenen SQL işi ──────────────────────────────────────── */

test('pahalı kurumsal görünümler anlık görüntüde bir kez okunur', () => {
  const batch = snapshotBatch();
  for (const view of ['MR_V_ExecutiveScope', 'MR_V_CorporateProjectAccess', 'MR_V_PeopleDirectory']) {
    assert.equal((batch.match(new RegExp(`dbo\\.${view}\\b`, 'g')) || []).length, 1, view);
  }
  assert.match(batch, /INSERT #ExecutiveScope\(EmployeeSicil\)\s+SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope\s+WHERE ManagerSicil = @sicil/);
  // HR09 erişimi yalnızca KURUMSAL projelerde sayılır.
  assert.match(batch, /JOIN dbo\.MR_V_CorporateProjectAccess a ON a\.ProjectCode = UPPER\(p\.ProjectCode\)\s+WHERE @isAdmin = 0 AND p\.SourceType = 'CORPORATE'/);
  // Rehber tek geçişte maddileştirilir; görev künyesi ve sorumlu satırları bu
  // kümeden okur.
  assert.match(batch, /INTO #Directory\s+FROM dbo\.MR_V_PeopleDirectory pd/);
  assert.match(batch, /LEFT JOIN #Directory creator ON creator\.Sicil = t\.CreatedBySicil/);
  assert.match(batch, /LEFT JOIN #Directory pd ON pd\.Sicil = ta\.Sicil/);
});

test('sorumlu gerçekleri ve ata zinciri satır başına değil küme olarak çözülür', () => {
  const batch = snapshotBatch();
  // Sorumlu sayımı, kendi sorumluluğu ve yönetim kapsamı tek toplamadadır.
  assert.match(batch, /INSERT #TaskAssigneeFacts\(TaskId, AssigneeCount, IsOwnAssignee, IsScopeAssignee\)/);
  assert.equal((batch.match(/SELECT COUNT\(\*\) FROM dbo\.MR_TaskAssignees/g) || []).length, 0);
  assert.equal((batch.match(/ownAssignment|creatorViewerAssignment/g) || []).length, 0);
  assert.match(batch, /facts\.AssigneeCount/);
  assert.match(batch, /facts\.IsOwnAssignee AS IsCurrentUserAssignee/);

  // Özyinelemeli WBS ata zinciri bir kez toplanır; WBS seçimi hazır kümeyi okur.
  assert.match(batch, /INSERT #RequiredPartialWbs\(WbsId\)\s+SELECT DISTINCT WbsId FROM RequiredPartialWbs\s+OPTION \(MAXRECURSION 1000\)/);
  const wbsSelect = snapshotStatements().find((statement) => statement.startsWith('SELECT w.*'));
  assert.ok(wbsSelect, 'WBS seçimi bulunmalıdır');
  assert.match(wbsSelect, /EXISTS \(SELECT 1 FROM #RequiredPartialWbs r WHERE r\.WbsId = w\.WbsId\)/);
  assert.doesNotMatch(wbsSelect, /RequiredPartialWbs AS \(|dbo\.MR_Tasks|dbo\.MR_TaskAssignees/);

  // Rehberde görünen kişiler de küme olarak çözülür.
  const directory = snapshotStatements()
    .find((statement) => statement.startsWith('SELECT pd.Sicil, pd.DisplayName, pd.Username') && !statement.includes('INTO #'));
  assert.ok(directory, 'kişi rehberi seçimi bulunmalıdır');
  assert.match(directory, /FROM #Directory pd/);
  assert.doesNotMatch(directory, /dbo\.MR_TaskAssignees|dbo\.MR_Tasks|dbo\.MR_Projects/);
});

test('görev tabanlı görünürlük tablo taraması yerine dizin aramalarından kurulur', () => {
  const statements = snapshotStatements();
  const ownScope = statements.find((statement) => statement.startsWith('INSERT #OwnScopedProjects'));
  const teamScope = statements.find((statement) => statement.startsWith('INSERT #ScopeAssignedProjects'));
  assert.ok(ownScope && teamScope);
  // Kendi kapsamı: oluşturan + kendi ataması. Yönetim kapsamı AYRI kümedir;
  // WBS kataloğunu açan küme yalnızca birincisidir.
  assert.match(ownScope, /t\.CreatedBySicil = @sicil/);
  assert.match(ownScope, /FROM dbo\.MR_TaskAssignees ta\s+JOIN dbo\.MR_Tasks t ON t\.TaskId = ta\.TaskId\s+WHERE ta\.Sicil = @sicil/);
  assert.doesNotMatch(ownScope, /#ExecutiveScope/);
  assert.match(teamScope, /FROM #ExecutiveScope es\s+JOIN dbo\.MR_TaskAssignees ta ON ta\.Sicil = es\.EmployeeSicil/);

  // KISMİ proje kümesi artık satır başına sorumlu yoklaması yapmaz.
  const partial = statements.find((statement) => statement.includes("SELECT DISTINCT scoped.ProjectId, 'PARTIAL'"));
  assert.ok(partial);
  assert.doesNotMatch(partial, /dbo\.MR_TaskAssignees|dbo\.MR_Tasks/);
  assert.match(partial, /WHERE @isAdmin = 0 AND p\.IsActive = 1/);

  // Görünür görev kümesi de hazır gerçeklerden okunur.
  const visibleTasks = statements.find((statement) => statement.startsWith('INSERT #VisibleTasks'));
  assert.ok(visibleTasks);
  assert.match(visibleTasks, /JOIN #TaskAssigneeFacts facts ON facts\.TaskId = t\.TaskId/);
  assert.doesNotMatch(visibleTasks, /dbo\.MR_TaskAssignees/);
});

test('ara kümeler tablo değişkeni değil geçici tablodur', () => {
  const batch = snapshotBatch();
  // Tablo değişkeni tahmini tek satırdır; binlerce satırlık görünür görev
  // kümesinde bu tahmin sıralamayı tempdb'ye taşıyordu.
  assert.doesNotMatch(batch, /DECLARE @\w+ TABLE\(/);
  const created = (batch.match(/CREATE TABLE (#\w+)/g) || []).map((entry) => entry.replace('CREATE TABLE ', ''));
  for (const name of [
    '#VisibleProjects', '#ReadGrantedProjects', '#TaskScopedWbsProjects', '#ExecutiveScope',
    '#OwnScopedProjects', '#ScopeAssignedProjects', '#VisibleTasks', '#TaskAssigneeFacts',
    '#RequiredPartialWbs', '#DirectoryVisibleSicils', '#DirectoryNameSicils'
  ]) {
    assert.ok(created.includes(name), `${name} geçici tablo olmalıdır`);
  }
  // Anahtarlar aranabilir kalır.
  assert.match(batch, /CREATE TABLE #VisibleProjects\(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar\(10\)\)/);
  assert.match(batch, /CREATE CLUSTERED INDEX IX_Directory_Sicil ON #Directory\(Sicil\)/);
});

test('anlık görüntü toplu işi on iki sonuç kümesini aynı sırada döndürür', () => {
  const outputs = snapshotStatements()
    .filter((statement) => statement.startsWith('SELECT') && !/\bINTO #/.test(statement))
    .map((statement) => statement.split('\n')[0].trim());
  assert.deepEqual(outputs, [
    'SELECT p.*, v.AccessLevel',
    'SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder',
    'SELECT w.*',
    'SELECT t.*, v.AccessLevel,',
    'SELECT ta.TaskId,',
    'SELECT d.*',
    'SELECT b.*',
    'SELECT s.*',
    'SELECT c.*, wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName',
    'SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit',
    'SELECT p.ProjectId, p.ProjectCode, p.ProjectName, p.ProjectTypeCode, p.ProjectTypeName,',
    'SELECT es.EmployeeSicil'
  ]);
  // JavaScript tarafı aynı sırayı konum konum çözer.
  assert.match(
    snapshotBatch(),
    /const \[projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows, snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows\] = result\.recordsets;/
  );
});

/* ── 2 · Kalıcı şema ────────────────────────────────────────────── */

test('görev oluşturan dizini hem kurulumda hem göçte tanımlıdır ve göç yinelenebilir', () => {
  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  const upgrade = read('database/MR_Upgrade_0014_Task_Creator_Index.sql');
  const definition = /CREATE INDEX IX_MR_Tasks_CreatedBySicil ON dbo\.MR_Tasks\(CreatedBySicil\) INCLUDE \(ProjectId\)/;

  // Yeni kurulum ile yükseltilen kurulum AYNI dizini alır.
  assert.match(createSql, definition);
  assert.match(upgrade, definition);
  assert.match(createSql, /\(N'0014_task_creator_index', N'[^']+'\);/);

  // Göç yinelenebilir ve sıralıdır: 0013 uygulanmadan çalışmaz.
  assert.match(upgrade, /IF NOT EXISTS \(\s+SELECT 1 FROM sys\.indexes\s+WHERE object_id = OBJECT_ID\(N'dbo\.MR_Tasks'\) AND name = N'IX_MR_Tasks_CreatedBySicil'\s+\)\s+CREATE INDEX/);
  assert.match(upgrade, /WHERE MigrationId = N'0013_corporate_wbs_sync_freshness'\s+\)\s+THROW 51014/);
  assert.match(upgrade, /WHERE MigrationId = N'0014_task_creator_index'\s+\)\s+INSERT dbo\.MR_SchemaMigrations/);
  // Dizin göçü VERİYE dokunmaz.
  assert.doesNotMatch(upgrade, /\b(UPDATE|DELETE|MERGE)\s+dbo\./);
  assert.match(upgrade, /ROLLBACK TRANSACTION/);

  // Yüklem gerçekten bu dizinin hedefidir.
  const repository = read('src/server/repository/sqlAppRepository.js');
  const authorization = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(authorization, /WHERE t\.CreatedBySicil = @sicil/);
  assert.ok((repository.match(/CreatedBySicil = @sicil/g) || []).length >= 2);
});

/* ── 3 · Yetkili yük değişmez ───────────────────────────────────── */

const ACTOR = 840001;
const OWNER = 840002;
const EMPLOYEE = 840003;
const CO_ASSIGNEE = 840004;
const id = (number) => `d0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const READ_PROJECT = id(1);
const PARTIAL_PROJECT = id(2);

function directorySeed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [ACTOR, OWNER, EMPLOYEE, CO_ASSIGNEE].map((Sicil) => ({ Sicil, DisplayName: `Kişi ${Sicil}` })),
    projects: [
      { ProjectId: READ_PROJECT, SourceType: 'MANUAL', ProjectCode: 'R1', ProjectName: 'Okunan', LeadSicil: OWNER, CalendarId: DEFAULT_CALENDAR_ID },
      { ProjectId: PARTIAL_PROJECT, SourceType: 'MANUAL', ProjectCode: 'R2', ProjectName: 'Kısmi', LeadSicil: OWNER, CalendarId: DEFAULT_CALENDAR_ID }
    ],
    projectAccess: [{ ProjectId: READ_PROJECT, Sicil: ACTOR, AccessLevel: 'READ' }],
    executiveScope: [{ ManagerSicil: ACTOR, EmployeeSicil: EMPLOYEE, ScopeType: 'UNIT' }],
    wbs: [
      { WbsId: id(21), ProjectId: READ_PROJECT, Code: '1', Name: 'Kök' },
      { WbsId: id(22), ProjectId: PARTIAL_PROJECT, Code: '1', Name: 'Kök' }
    ],
    tasks: [
      { TaskId: id(11), ProjectId: READ_PROJECT, WbsId: id(21), Title: 'Okunan görev', CreatedBySicil: OWNER },
      { TaskId: id(12), ProjectId: PARTIAL_PROJECT, WbsId: id(22), Title: 'Kısmi görev', CreatedBySicil: OWNER }
    ],
    taskAssignees: [
      { TaskId: id(11), Sicil: OWNER },
      { TaskId: id(12), Sicil: EMPLOYEE },
      { TaskId: id(12), Sicil: CO_ASSIGNEE }
    ]
  };
}

test('kişi rehberi READ yetkisini ve yönetim kapsamını taşır, eş sorumluyu taşımaz', async () => {
  const stack = await createActualStack(directorySeed(), { sicil: ACTOR, corporateWbsSource: false });
  try {
    const directory = stack.state.people.map((person) => person.id).sort();
    // READ yetkili projenin sorumluları ve yöneticinin kendi personeli rehberde
    // görünür; proje liderleri de görünür. Kapsam dışı EŞ SORUMLU görünmez.
    assert.deepEqual(directory, [ACTOR, OWNER, EMPLOYEE].map(String).sort());
    assert.equal(stack.state.people.some((person) => person.id === String(CO_ASSIGNEE)), false);

    // Yönetici kendi personelini görür; kapsam dışı EŞ SORUMLUNUN satırı hiç
    // dönmez. Yalnızca SAYI gizlenmiş bir sorumlu olduğunu söyler.
    const partialTask = stack.state.tasks.find((task) => task.id === id(12));
    assert.deepEqual(partialTask.assigneeIds, [String(EMPLOYEE)]);
    assert.deepEqual(partialTask.assigneeDisplayNames, [`Kişi ${EMPLOYEE}`]);
    assert.equal(partialTask.assigneeCount, 2);
    assert.equal(JSON.stringify(stack.state.tasks).includes(String(CO_ASSIGNEE)), false);

    // READ yetkisi görev künyesini açar ama proje TAM erişime yükselmez.
    const readTask = stack.state.tasks.find((task) => task.id === id(11));
    assert.equal(readTask.createdBySicil, String(OWNER));
    assert.equal(stack.state.projects.find((project) => project.id === READ_PROJECT).accessLevel, 'PARTIAL');
  } finally { await stack.dispose(); }
});

test('yönetim kapsamı kaldırıldığında rehber ve görev kümesi aynı istekte daralır', async () => {
  const stack = await createActualStack(directorySeed(), { sicil: ACTOR, corporateWbsSource: false });
  try {
    assert.equal(stack.state.tasks.length, 2);
    stack.db.executiveScope = [];
    const reloaded = await stack.reload();
    assert.deepEqual(reloaded.tasks.map((task) => task.id), [id(11)]);
    assert.deepEqual(reloaded.people.map((person) => person.id).sort(), [ACTOR, OWNER].map(String).sort());
    assert.equal(reloaded.projects.some((project) => project.id === PARTIAL_PROJECT), false);
  } finally { await stack.dispose(); }
});
