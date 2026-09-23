/**
 * Anlık görüntü ana sorgusunun (phase.snapshot.main-query) yapı sözleşmesi.
 *
 * Birleştirilmiş toplu iş, yetkili yükü değiştirmeden YİNELENEN SQL işini
 * kaldırmalıdır: kurumsal görünümler bir kez okunur, yetkilendirme kararları
 * satır başına yeniden türetilmez, pahalı kümeler yalnızca gerçekten
 * gerektiğinde hesaplanır ve ara kümeler iyileştiricinin gerçek satır sayısını
 * görebileceği geçici tablolarda tutulur.
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
    .split('req.query(`')[1]
    .split('`));')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const CONTROL_LINE = /^(IF\s+.*|ELSE|BEGIN|END)$/;

/**
 * Sonuç kümesi üreten deyimler, akış denetimi soyularak.
 *
 * `guard` alanı deyimin bir `IF`/`ELSE` dalında olup olmadığını söyler:
 * korumalı bir küme HER ZAMAN çift hâlinde bulunmalıdır, aksi hâlde yetenek
 * kapalıyken sonuç kümesi hiç dönmez ve konumsal sözleşme kayar.
 */
function outputStatements() {
  const outputs = [];
  for (const statement of snapshotStatements()) {
    const lines = statement.split('\n').map((line) => line.trim()).filter(Boolean);
    let guard = null;
    while (lines.length && CONTROL_LINE.test(lines[0])) {
      const line = lines.shift();
      if (line.startsWith('IF ')) guard = 'IF';
      else if (line === 'ELSE') guard = 'ELSE';
    }
    const body = lines.join('\n');
    if (!body.startsWith('SELECT') || /\bINTO #/.test(body)) continue;
    outputs.push({ guard, head: lines[0] });
  }
  return outputs;
}

/** Akış denetimi soyulduktan sonra verilen önekle BAŞLAYAN ilk deyim. */
function statementStartingWith(prefix) {
  for (const statement of snapshotStatements()) {
    const lines = statement.split('\n').map((line) => line.trim()).filter(Boolean);
    while (lines.length && CONTROL_LINE.test(lines[0])) lines.shift();
    if (lines.join('\n').startsWith(prefix)) return statement;
  }
  assert.fail(`deyim bulunmalıdır: ${prefix}`);
}

/* ── 1 · Yinelenen SQL işi ──────────────────────────────────────── */

test('pahalı kurumsal görünümler anlık görüntüde bir kez okunur', () => {
  const batch = snapshotBatch();
  for (const view of ['MR_V_ExecutiveScope', 'MR_V_CorporateProjectAccess', 'MR_V_PeopleDirectory']) {
    assert.equal((batch.match(new RegExp(`dbo\\.${view}\\b`, 'g')) || []).length, 1, view);
  }
  assert.match(batch, /INSERT #ExecutiveScope\(EmployeeSicil\)\s+SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope\s+WHERE ManagerSicil = @sicil/);
  // HR09 erişimi yalnızca KURUMSAL projelerde sayılır.
  assert.match(batch, /JOIN dbo\.MR_V_CorporateProjectAccess a ON a\.ProjectCode = UPPER\(p\.ProjectCode\)\s+WHERE p\.SourceType = 'CORPORATE'/);
  // Rehber tek geçişte maddileştirilir; görev künyesi ve sorumlu satırları bu
  // kümeden okur.
  assert.match(batch, /INTO #Directory\s+FROM dbo\.MR_V_PeopleDirectory pd/);
  assert.match(batch, /LEFT JOIN #Directory creator ON creator\.Sicil = t\.CreatedBySicil/);
  assert.match(batch, /LEFT JOIN #Directory pd ON pd\.Sicil = ta\.Sicil/);
});

test('yönetim kapsamı yalnızca yönetici için okunur', () => {
  // `isExecutive`, aynı işlemde MR_V_ExecutiveScope üzerinde çalıştırılmış
  // EXISTS yanıtıdır. 0 olduğunda kapsam sorgusu tanım gereği boş döner; HR02
  // taraması bu yüzden yüklemle değil DALLA atlanır.
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /req\.input\('isExecutive', sql\.Bit, Boolean\(auth\.isExecutive\)\)/);
  assert.match(snapshotBatch(), /IF @isExecutive = 1\s+INSERT #ExecutiveScope\(EmployeeSicil\)/);
  assert.match(
    read('src/server/authorization/loadAuthorizationContext.js'),
    /SELECT 1 FROM dbo\.MR_V_ExecutiveScope WHERE ManagerSicil = @sicil/
  );
});

test('kişisel görev kapsamı tek geçişte toplanır ve proje kümeleri bu kümeden türer', () => {
  const scoped = statementStartingWith('INSERT #ScopedTasks(TaskId, ProjectId, IsCreator, IsOwnAssignee, IsScopeAssignee)');
  // Üç dizin araması (oluşturan, kendi ataması, yönetim kapsamı) TEK toplamada
  // birleşir; proje kümeleri MR_Tasks/MR_TaskAssignees tablolarını yeniden
  // taramaz.
  assert.match(scoped, /WHERE @isAdmin = 0 AND t\.CreatedBySicil = @sicil/);
  assert.match(scoped, /FROM dbo\.MR_TaskAssignees ta\s+JOIN dbo\.MR_Tasks t ON t\.TaskId = ta\.TaskId\s+WHERE ta\.Sicil = @sicil/);
  assert.match(scoped, /FROM #ExecutiveScope es\s+JOIN dbo\.MR_TaskAssignees ta ON ta\.Sicil = es\.EmployeeSicil/);

  const own = statementStartingWith('INSERT #OwnScopedProjects(ProjectId)');
  const team = statementStartingWith('INSERT #ScopeAssignedProjects(ProjectId)');
  for (const statement of [own, team]) {
    assert.doesNotMatch(statement, /dbo\.MR_Tasks|dbo\.MR_TaskAssignees/);
  }
  // Kendi kapsamı WBS kataloğunu açar; yönetim kapsamı AÇMAZ.
  assert.match(own, /WHERE s\.IsCreator = 1 OR s\.IsOwnAssignee = 1/);
  assert.match(team, /WHERE s\.IsScopeAssignee = 1/);
});

test('FULL ve READ görevleri pahalı kısmi görünürlük hesabına girmez', () => {
  const batch = snapshotBatch();
  const inserts = snapshotStatements().filter((statement) => statement.includes('INSERT #VisibleTasks(TaskId'));
  assert.equal(inserts.length, 2, 'görünür görev kümesi iki ayrık daldan kurulur');
  // 1. dal: proje düzeyinde kesinleşen görünürlük.
  assert.match(inserts[0], /JOIN #VisibleProjects v ON v\.ProjectId = t\.ProjectId\s+AND \(v\.AccessLevel = 'FULL' OR v\.HasReadGrant = 1\)/);
  // 2. dal: KISMİ projede yalnızca hazır kişisel kapsam; görev tablosu proje
  // boyunca taranmaz ve dal kısmi kapsam yokken hiç çalışmaz.
  assert.match(batch, /IF @HasPartialScope = 1\s+INSERT #VisibleTasks\(TaskId/);
  assert.match(inserts[1], /FROM #ScopedTasks scoped\s+JOIN #VisibleProjects v ON v\.ProjectId = scoped\.ProjectId\s+AND v\.AccessLevel = 'PARTIAL' AND v\.HasReadGrant = 0/);
  assert.doesNotMatch(inserts[1], /LEFT JOIN dbo\.MR_Tasks/);
});

test('sorumlu sayımı yalnızca görünür görevler için toplanır', () => {
  const facts = statementStartingWith('INSERT #TaskAssigneeFacts(TaskId, AssigneeCount)');
  assert.match(facts, /FROM dbo\.MR_TaskAssignees ta\s+JOIN #VisibleTasks visible ON visible\.TaskId = ta\.TaskId\s+GROUP BY ta\.TaskId/);
  // Görünür projedeki BÜTÜN görevler değil; sayım kümesi görünür görevlerdir.
  assert.doesNotMatch(facts, /dbo\.MR_Tasks\b|#VisibleProjects/);
  assert.equal((snapshotBatch().match(/SELECT COUNT\(\*\) FROM dbo\.MR_TaskAssignees/g) || []).length, 0);
  // Sayısı olmayan görev için yük yine 0 taşır.
  assert.match(snapshotBatch(), /COALESCE\(facts\.AssigneeCount, 0\) AS AssigneeCount/);
});

test('yetki kararları görev satırında bir kez verilir; MR_Tasks yeniden birleştirilmez', () => {
  const batch = snapshotBatch();
  // MR_Tasks yalnızca ALTI yerde okunur: kişisel kapsam toplamasının üç dalı,
  // görünür görev kümesinin iki dalı ve görev sonuç kümesi. Ata zinciri,
  // rehber kümesi, sorumlu sayımı ve sorumlu satırları hazır #VisibleTasks
  // kümesinden çözülür; önceki biçimde bunlar da tabloyu yeniden birleştiriyor
  // ve başvuru sayısı ona çıkıyordu.
  assert.equal((batch.match(/dbo\.MR_Tasks\b/g) || []).length, 6);
  const taskSelect = statementStartingWith('SELECT t.*, visible.AccessLevel,');
  assert.match(taskSelect, /JOIN #VisibleTasks visible ON visible\.TaskId = t\.TaskId/);
  assert.doesNotMatch(taskSelect, /#VisibleProjects|#ReadGrantedProjects|CROSS APPLY/);
  assert.match(taskSelect, /visible\.IsOwnAssignee AS IsCurrentUserAssignee/);
  assert.match(taskSelect, /visible\.IsCreator AS IsCurrentUserCreator/);

  const assigneeSelect = statementStartingWith('SELECT ta.TaskId,');
  assert.match(assigneeSelect, /JOIN #VisibleTasks visible ON visible\.TaskId = ta\.TaskId/);
  assert.doesNotMatch(assigneeSelect, /dbo\.MR_Tasks|#VisibleProjects|#ReadGrantedProjects/);
  // Kimlik görünürlüğü TABANI görev satırında hazırdır; kalan iki koşul satıra
  // özgüdür (kişinin kendisi ve yönetim kapsamı).
  assert.match(assigneeSelect, /visible\.IdentityBase = 1\s+OR ta\.Sicil = @sicil/);
});

test('ata zinciri ve rehber kümesi gereksiz yere hesaplanmaz', () => {
  const batch = snapshotBatch();
  // Özyinelemeli ata zinciri KISMİ proje yoksa hiç çalışmaz.
  assert.match(batch, /IF @HasPartialScope = 1\s+BEGIN\s+;WITH RequiredPartialWbs AS \(/);
  assert.match(batch, /INSERT #RequiredPartialWbs\(WbsId\)\s+SELECT DISTINCT WbsId FROM RequiredPartialWbs\s+OPTION \(MAXRECURSION 1000\)/);
  const anchor = statementStartingWith('WITH RequiredPartialWbs AS (');
  assert.doesNotMatch(anchor, /dbo\.MR_Tasks|dbo\.MR_TaskAssignees|#VisibleProjects/);

  // Rehber Sicil kümesi TAM kapsamlı kullanıcıda hiç hesaplanmaz.
  assert.match(batch, /IF @HasFullScope = 0\s+INSERT #DirectorySicils\(Sicil, IsPublished\)/);
  const sicils = statementStartingWith('INSERT #DirectorySicils(Sicil, IsPublished)');
  // Sorumlu tablosu bu küme için TEK kez okunur: yayınlanan ve yalnızca adı
  // çözülen kişiler aynı geçişte ayrılır.
  assert.equal((sicils.match(/dbo\.MR_TaskAssignees/g) || []).length, 1);
  assert.doesNotMatch(sicils, /dbo\.MR_Tasks\b/);

  const wbsSelect = statementStartingWith('SELECT w.*');
  assert.match(wbsSelect, /EXISTS \(SELECT 1 FROM #RequiredPartialWbs r WHERE r\.WbsId = w\.WbsId\)/);
  assert.doesNotMatch(wbsSelect, /RequiredPartialWbs AS \(|dbo\.MR_Tasks|dbo\.MR_TaskAssignees/);

  const directory = statementStartingWith('SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector');
  assert.match(directory, /FROM #Directory pd/);
  assert.doesNotMatch(directory, /dbo\.MR_TaskAssignees|dbo\.MR_Tasks|dbo\.MR_Projects/);
});

test('atanabilir proje listesi yetenek kapalıyken kök düğüm aramaz', () => {
  const batch = snapshotBatch();
  // Yüklem olarak yazıldığında kurumsal proje başına OUTER APPLY kök araması
  // yine çalışıyordu; dal, kümeyi hiç üretmez ama sonuç kümesi korunur.
  assert.match(batch, /IF @canAssignAllCorporate = 1\s+SELECT p\.ProjectId, p\.ProjectCode/);
  assert.match(batch, /ELSE\s+SELECT TOP \(0\) p\.ProjectId, p\.ProjectCode/);
});

test('ara kümeler tablo değişkeni değil geçici tablodur ve erişim yolları anahtarlıdır', () => {
  const batch = snapshotBatch();
  // Tablo değişkeni tahmini tek satırdır; binlerce satırlık görünür görev
  // kümesinde bu tahmin sıralamayı tempdb'ye taşıyordu.
  assert.doesNotMatch(batch, /DECLARE @\w+ TABLE\(/);
  const created = (batch.match(/CREATE TABLE (#\w+)/g) || []).map((entry) => entry.replace('CREATE TABLE ', ''));
  for (const name of [
    '#VisibleProjects', '#ReadGrantedProjects', '#ExecutiveScope', '#ScopedTasks',
    '#OwnScopedProjects', '#ScopeAssignedProjects', '#VisibleTasks',
    '#TaskAssigneeFacts', '#RequiredPartialWbs', '#DirectorySicils'
  ]) {
    assert.ok(created.includes(name), `${name} geçici tablo olmalıdır`);
  }
  // Aşağı akıştaki her arama anahtar üzerindendir.
  assert.match(batch, /CREATE TABLE #VisibleProjects\(\s+ProjectId uniqueidentifier PRIMARY KEY,\s+AccessLevel varchar\(10\) NOT NULL,\s+HasReadGrant bit NOT NULL DEFAULT \(0\),\s+IsTaskScoped bit NOT NULL DEFAULT \(0\)\s+\)/);
  assert.match(batch, /CREATE TABLE #ScopedTasks\(\s+TaskId uniqueidentifier PRIMARY KEY/);
  assert.match(batch, /CREATE TABLE #VisibleTasks\(\s+TaskId uniqueidentifier PRIMARY KEY/);
  assert.match(batch, /CREATE TABLE #TaskAssigneeFacts\(TaskId uniqueidentifier PRIMARY KEY, AssigneeCount int NOT NULL\)/);
  assert.match(batch, /CREATE TABLE #DirectorySicils\(Sicil int PRIMARY KEY, IsPublished bit NOT NULL\)/);
  assert.match(batch, /CREATE CLUSTERED INDEX IX_Directory_Sicil ON #Directory\(Sicil\)/);
  // Oluşturulan her geçici tablo toplu işin başında temizlenir, sonunda düşürülür.
  const statements = snapshotStatements();
  const openingDrop = statements.find((statement) => statement.startsWith('DROP TABLE IF EXISTS'));
  const closingDrop = statements.find((statement) => statement.startsWith('DROP TABLE #'));
  assert.ok(openingDrop && closingDrop, 'açılış ve kapanış DROP TABLE deyimleri bulunmalıdır');
  for (const name of [...created, '#Directory']) {
    const listed = new RegExp(`${name}\\b`);
    assert.match(openingDrop, listed, `${name} temizlenmelidir`);
    assert.match(closingDrop, listed, `${name} düşürülmelidir`);
  }
});

test('anlık görüntü toplu işi on iki sonuç kümesini aynı sırada döndürür', () => {
  const outputs = outputStatements();
  // Korumalı küme HER ZAMAN çift hâlindedir: yetenek kapalıyken de aynı
  // konumda (boş) bir sonuç kümesi döner.
  const guarded = outputs.filter((entry) => entry.guard);
  assert.deepEqual(guarded.map((entry) => entry.guard), ['IF', 'ELSE']);
  const positions = outputs
    .filter((entry) => entry.guard !== 'ELSE')
    .map((entry) => entry.head);
  assert.deepEqual(positions, [
    'SELECT p.*, v.AccessLevel',
    'SELECT pt.ProjectId, pt.TagName, pt.ColorToken, pt.IconKey, pt.SortOrder',
    'SELECT w.*',
    'SELECT t.*, visible.AccessLevel,',
    'SELECT ta.TaskId,',
    'SELECT d.*',
    'SELECT b.*',
    'SELECT s.*',
    'SELECT c.*, wd.Weekday, h.HolidayDate, h.Name AS HolidayName, h.ShortName',
    'SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit',
    'SELECT p.ProjectId, p.ProjectCode, p.ProjectName, p.ProjectTypeCode, p.ProjectTypeName,',
    'SELECT es.EmployeeSicil',
    'SELECT DATEDIFF(millisecond, @BatchStartedAt, @ScopeResolvedAt) AS ScopeMs,'
  ]);
  // JavaScript tarafı aynı sırayı konum konum çözer; tanı kümesi SONDADIR ve
  // yükün on iki kümesinin yerini değiştirmez.
  assert.match(
    snapshotBatch(),
    /const \[projectRows, tagRows, wbsRows, taskRows, assigneeRows, dependencyRows, baselineRows,\s+snapshotRows, calendarRows, peopleRows, assignableRows, assignmentScopeRows,\s+sqlStageRows\] = result\.recordsets;/
  );
});

/* ── 1b · SQL / izdüşüm tanısı ──────────────────────────────────── */

test('SQL beklemesi ile JavaScript izdüşümü ayrı ölçülür ve kişisel veri taşımaz', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  const observe = read('src/server/observability/observeOperation.js');
  // Var olan üretim ölçümü korunur; yeni adlar onun ALTINDADIR.
  assert.match(repository, /observePhase\('phase.snapshot.main-query', \(\) => loadSnapshotFrom\(connection, auth\)\)/);
  assert.match(repository, /observePhase\('phase.snapshot.main-query.sql', \(\) => req\.query\(/);
  assert.match(repository, /'phase.snapshot.main-query.projection'/);
  // Alt ölçümler var olan kaydediciyi kullanır; ayrı bir telemetri yolu yoktur.
  assert.match(observe, /export function recordPhaseDuration\(operation, durationMs/);
  assert.match(observe, /safely\(\(\) => recordOperation\(\{ operation, durationMs: Math\.max\(0, durationMs\), ok: true, at \}\)\)/);
  assert.doesNotMatch(repository, /recordOperation\(/);

  // SQL içi aşamalar TEK sonuç kümesinde döner: toplu iş gidiş-dönüşe bölünmez.
  const stageRow = statementStartingWith('SELECT DATEDIFF(millisecond, @BatchStartedAt, @ScopeResolvedAt) AS ScopeMs,');
  for (const column of ['ScopeMs', 'TaskScopeMs', 'DirectoryMs', 'ResultSetsMs']) {
    assert.ok(stageRow.includes(`AS ${column}`), column);
  }
  // Tanı satırı yalnızca süre taşır.
  assert.doesNotMatch(stageRow, /Sicil|DisplayName|ProjectId|TaskId|ProjectName|Title|Username|Description/);
  assert.match(repository, /ScopeMs: 'phase\.snapshot\.main-query\.sql\.scope'/);
  assert.match(repository, /TaskScopeMs: 'phase\.snapshot\.main-query\.sql\.task-scope'/);
  assert.match(repository, /DirectoryMs: 'phase\.snapshot\.main-query\.sql\.directory'/);
  assert.match(repository, /ResultSetsMs: 'phase\.snapshot\.main-query\.sql\.result-sets'/);
});

test('JavaScript izdüşümü aynı satırları iki kez eşlemez', () => {
  const projection = read('src/server/repository/sqlAppRepository.js')
    .split('function projectSnapshotRecordsets(')[1]
    .split('async function loadAuthoritativeMutationRows(')[0];
  // Sorumlu satırları TEK kez eşlenir. İkinci eşleme (`assignees`) yalnızca
  // `applyTaskAssigneeProjection` tarafından hemen üzerine yazılan bir liste
  // üretiyordu; SQL sayımı da artık her satırda dolu döner.
  assert.doesNotMatch(projection, /const assignees = new Map\(\)/);
  assert.match(projection, /assigneeCount: Number\(row\.AssigneeCount \?\? 0\)/);
  // Kimlik kanonikleştirmesi kayıt başına bir kez yapılır.
  assert.match(projection, /const taskId = id\(row\.TaskId\);/);
  assert.match(projection, /const projectId = id\(row\.ProjectId\);/);
  assert.doesNotMatch(projection, /tags\.get\(id\(row\.ProjectId\)\)/);
  assert.doesNotMatch(projection, /dependencies\.get\(id\(row\.TaskId\)\)/);
});

/* ── 2 · Kalıcı şema ────────────────────────────────────────────── */

test('görev oluşturan dizini hem kurulumda hem göçte tanımlıdır ve göç yinelenebilir', () => {
  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  const upgrade = read('database/MR_Upgrade_0014_Task_Creator_Index.sql');
  const definition = /CREATE INDEX IX_MR_Tasks_CreatedBySicil ON dbo\.MR_Tasks\(CreatedBySicil\) INCLUDE \(ProjectId\)/;

  // Yeni kurulum ile yükseltilen kurulum AYNI dizini alır.
  assert.match(createSql, definition);
  assert.match(upgrade, definition);
  assert.match(createSql, /\(N'0014_task_creator_index', N'[^']+'\),/);

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
