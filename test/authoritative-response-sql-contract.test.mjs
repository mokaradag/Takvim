/**
 * Yetkili mutasyon yanıtının (phase.commit.authoritative-response) SQL
 * sözleşmesi.
 *
 * İki şeyi birlikte korur:
 *   1. GÜVENLİK — yanıt, aktörün gerçekten görebildiği satırlarla sınırlıdır ve
 *      kimlik kararları yalnızca Sicil üzerinden verilir.
 *   2. MALİYET — yetkilendirme kararları toplu işte BİR KEZ maddileştirilir;
 *      kimlik listeleri bir kez ayrıştırılır ve pahalı kurumsal görünümler
 *      satır başına yeniden okunmaz.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const ACTOR = 830001;
const OWNER = 830002;
const EMPLOYEE = 830003;
const OUTSIDER = 830004;
const MISSING = 830005;
const HIDDEN_CREATOR = 830006;

const id = (number) => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const PROJECT = id(1);
const OTHER_PROJECT = id(2);
const CLOSED_PROJECT = id(3);
const ROOT_WBS = id(21);
const CHILD_WBS = id(22);
const OTHER_WBS = id(23);
const TASK = id(11);
const CO_TASK = id(12);
const OTHER_TASK = id(13);
const CLOSED_TASK = id(14);

/** Yetkili mutasyon toplu işi: `loadAuthoritativeMutationRows` gövdesi. */
function authoritativeBatch() {
  const source = read('src/server/repository/sqlAppRepository.js');
  return source
    .split('async function loadAuthoritativeMutationRows(')[1]
    .split('async function readProjectTags(')[0];
}

/** Aynı toplu işin YALNIZCA SQL metni; yorum satırları ayıklanmış hâlde. */
function authoritativeStatements() {
  return authoritativeBatch()
    .split('await req.query(`')[1]
    .split('`);')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * @param {'admin'|'lead'|'corporate'|'full'|'assignee'|'creator'} mode
 */
function seed(mode) {
  const manualLead = mode === 'lead' ? ACTOR : OWNER;
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    // EMPLOYEE ile OUTSIDER aynı adı taşır: kimlik yalnızca Sicil üzerinden
    // çözülmelidir.
    people: [ACTOR, OWNER, EMPLOYEE, OUTSIDER, HIDDEN_CREATOR].map((Sicil) => ({
      Sicil,
      DisplayName: [EMPLOYEE, OUTSIDER].includes(Sicil) ? 'Aynı Ad Soyad' : `Kişi ${Sicil}`
    })),
    systemAdminSicils: mode === 'admin' ? [ACTOR] : [],
    projects: [
      {
        ProjectId: PROJECT,
        SourceType: mode === 'corporate' ? 'CORPORATE' : 'MANUAL',
        ProjectCode: 'AP1',
        ProjectName: 'Dokunulan Proje',
        LeadSicil: manualLead,
        CalendarId: DEFAULT_CALENDAR_ID
      },
      {
        ProjectId: OTHER_PROJECT,
        SourceType: 'MANUAL',
        ProjectCode: 'AP2',
        ProjectName: 'Dokunulmayan Proje',
        LeadSicil: mode === 'lead' ? ACTOR : OWNER,
        CalendarId: DEFAULT_CALENDAR_ID
      },
      { ProjectId: CLOSED_PROJECT, ProjectName: 'Kapalı Proje', IsActive: 0, LeadSicil: ACTOR }
    ],
    corporateProjectAccess: mode === 'corporate' ? [{ ProjectCode: 'AP1', Sicil: ACTOR }] : [],
    projectAccess: mode === 'full'
      ? [PROJECT, OTHER_PROJECT].map((ProjectId) => ({ ProjectId, Sicil: ACTOR, AccessLevel: 'FULL' }))
      : [],
    executiveScope: [{ ManagerSicil: OWNER, EmployeeSicil: OUTSIDER }],
    projectTags: [
      { ProjectId: PROJECT, TagName: 'Görünür', SortOrder: 1 },
      { ProjectId: CLOSED_PROJECT, TagName: 'Kapalı', SortOrder: 1 }
    ],
    wbs: [
      { WbsId: ROOT_WBS, ProjectId: PROJECT, Code: '1', Name: 'Kök' },
      { WbsId: CHILD_WBS, ProjectId: PROJECT, ParentWbsId: ROOT_WBS, Code: '1.1', Name: 'Düğüm' },
      { WbsId: OTHER_WBS, ProjectId: OTHER_PROJECT, Code: '1', Name: 'Diğer kök' }
    ],
    tasks: [
      {
        TaskId: TASK, ProjectId: PROJECT, WbsId: CHILD_WBS, Title: 'Dokunulan görev',
        // Gizli oluşturan, proje lideri DEĞİLDİR: künye yalnızca aktörün kendi
        // yetkisiyle açılmalıdır.
        CreatedBySicil: mode === 'creator' ? ACTOR : HIDDEN_CREATOR
      },
      { TaskId: CO_TASK, ProjectId: PROJECT, WbsId: CHILD_WBS, Title: 'Komşu görev', CreatedBySicil: OWNER },
      { TaskId: OTHER_TASK, ProjectId: OTHER_PROJECT, WbsId: OTHER_WBS, Title: 'Başka proje', CreatedBySicil: OWNER },
      { TaskId: CLOSED_TASK, ProjectId: CLOSED_PROJECT, Title: 'Kapalı görev', CreatedBySicil: ACTOR }
    ],
    taskAssignees: [
      // Aktör yalnızca `assignee` ve `creator` kiplerinde göreve bağlıdır;
      // eş sorumlular her kipte aynıdır.
      ...(['assignee'].includes(mode) ? [{ TaskId: TASK, Sicil: ACTOR }] : []),
      { TaskId: TASK, Sicil: EMPLOYEE },
      { TaskId: TASK, Sicil: OUTSIDER },
      { TaskId: TASK, Sicil: MISSING },
      { TaskId: CO_TASK, Sicil: OWNER },
      { TaskId: OTHER_TASK, Sicil: OWNER }
    ],
    taskDependencies: [{ ProjectId: PROJECT, TaskId: TASK, PredecessorTaskId: CO_TASK }]
  };
}

const WRITES_FULL = ['admin', 'lead', 'corporate', 'full'];

/** Aktörün yazabildiği en dar alan: ilerleme yüzdesi. */
async function commitProgress(stack, progress) {
  const task = stack.state.tasks.find((entry) => entry.id === TASK);
  assert.ok(task, 'dokunulan görev anlık görüntüde bulunmalıdır');
  return stack.repository.commitChanges({ taskUpserts: [{ ...task, progress }] });
}

/* ── 1 · Yetkilendirme matrisi ──────────────────────────────────── */

for (const mode of [...WRITES_FULL, 'assignee', 'creator']) {
  test(`yetkili mutasyon yanıtı ${mode} kipinde yalnızca dokunulan satırları döndürür`, async () => {
    const stack = await createActualStack(seed(mode), { sicil: ACTOR, corporateWbsSource: false });
    try {
      stack.db.statements.length = 0;
      stack.db.transactions.length = 0;
      const committed = await commitProgress(stack, 42);

      // Yanıt HEDEFLİDİR: dokunulmayan proje, WBS ve görev geri gelmez.
      assert.deepEqual(committed.taskUpserts.map((task) => task.id), [TASK]);
      assert.deepEqual(committed.projectUpserts.map((project) => project.id), [PROJECT]);
      assert.deepEqual(committed.wbsUpserts.map((node) => node.id).sort(), [CHILD_WBS]);
      assert.equal(committed.taskUpserts[0].progress, 42);

      const accessLevel = WRITES_FULL.includes(mode) ? 'FULL' : 'PARTIAL';
      assert.equal(committed.projectUpserts[0].accessLevel, accessLevel);
      assert.equal(
        committed.projectUpserts[0].schedulingCapability,
        accessLevel === 'FULL' ? 'COMPLETE' : 'SUPPRESSED_PARTIAL'
      );
      // Bağımlılıklar yalnızca TAM erişimde döner.
      assert.equal(committed.taskUpserts[0].deps.length, accessLevel === 'FULL' ? 1 : 0);
      // Kapalı projenin etiketi ve görevi hiçbir kipte yanıta karışmaz.
      const payload = JSON.stringify(committed);
      assert.equal(payload.includes(CLOSED_PROJECT), false);
      assert.equal(payload.includes(OTHER_PROJECT), false);
      assert.equal(payload.includes(OTHER_TASK), false);

      // Yazma işlemi anlık görüntü toplu işini YENİDEN KURMAZ.
      assert.equal(
        stack.db.statements.some((entry) => entry.sql.includes('CREATE TABLE #VisibleProjects')),
        false,
        'mutasyon yanıtı bütün portföyü yeniden kurmamalıdır'
      );
      const batches = stack.db.statements.filter((entry) => entry.sql.includes('CREATE TABLE #RequestedTasks'));
      assert.equal(batches.length, 1, 'yetkili yanıt tek SQL gidiş-dönüşünde okunur');
      assert.equal(
        stack.db.transactions.filter((entry) => entry.isolationLevel === sql.ISOLATION_LEVEL.SERIALIZABLE).length,
        1
      );
    } finally { await stack.dispose(); }
  });
}

test('eş sorumlu gizliliği yetkili yanıtta da korunur ve kimlik Sicil ile çözülür', async () => {
  const stack = await createActualStack(seed('assignee'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    const committed = await commitProgress(stack, 15);
    const task = committed.taskUpserts[0];
    // Kapsam dışı eş sorumluların SİCİLİ gizlenir; ADLARI görev kapsamında kalır.
    assert.deepEqual(task.assigneeIds, [String(ACTOR)]);
    assert.deepEqual(task.assigneeDisplayNames, [`Kişi ${ACTOR}`, 'Aynı Ad Soyad', 'Aynı Ad Soyad']);
    // Aynı adı taşıyan iki kişi AYRI fotoğraf kimliğiyle döner: eşleşme addan
    // değil Sicil'den türer.
    assert.deepEqual(task.assigneeAvatarIdentities, [
      { name: `Kişi ${ACTOR}`, employeeNo: String(ACTOR) },
      { name: 'Aynı Ad Soyad', employeeNo: String(EMPLOYEE) },
      { name: 'Aynı Ad Soyad', employeeNo: String(OUTSIDER) }
    ]);
    // Gizlenmiş sorumlu SAYISI korunur; rehberde bulunmayan Sicil sızmaz.
    assert.equal(task.assigneeCount, 4);
    assert.equal(task.isCurrentUserAssignee, true);
    assert.equal(JSON.stringify(committed).includes(String(MISSING)), false);
  } finally { await stack.dispose(); }
});

test('yetkili yanıt oluşturan künyesini sayılı ve Sicil tabanlı kurallarla açar', async () => {
  // Künye üç yoldan açılır: aktör görevin SORUMLUSU, görevin OLUŞTURANI ya da
  // proje düzeyinde tam kapsam sahibi olabilir. Üçü de yazma yetkisi taşıdığı
  // için mutasyon yolunda künye kapalı kalamaz; gizleme kuralı anlık görüntü
  // sözleşmesinde (yönetim kapsamı kipi) sınanır.
  for (const mode of ['assignee', 'creator', 'full']) {
    const stack = await createActualStack(seed(mode), { sicil: ACTOR, corporateWbsSource: false });
    try {
      const expected = mode === 'creator' ? ACTOR : HIDDEN_CREATOR;
      const task = (await commitProgress(stack, 7)).taskUpserts[0];
      assert.equal(task.isCurrentUserCreator, mode === 'creator');
      assert.equal(task.createdBySicil, String(expected), mode);
      assert.equal(task.createdByName, `Kişi ${expected}`, mode);
    } finally { await stack.dispose(); }
  }
});

test('oluşturan künyesi yalnızca sayılı kaynaklardan ve Sicil eşleşmesinden türer', () => {
  const statements = authoritativeStatements();
  const taskSelect = statements.find((statement) => statement.startsWith('SELECT t.*,'));
  assert.ok(taskSelect, 'görev seçimi bulunmalıdır');

  // Hem Sicil hem AD aynı kapıdan geçer; ikisi de maskeleme dışında kalamaz.
  assert.match(taskSelect, /CASE WHEN creatorAuth\.IdentityVisible = 1 THEN t\.CreatedBySicil ELSE NULL END AS VisibleCreatedBySicil/);
  assert.match(taskSelect, /LEFT JOIN #DirectoryNames creator\s+ON creator\.Sicil = t\.CreatedBySicil AND creatorAuth\.IdentityVisible = 1/);

  const gate = taskSelect.slice(taskSelect.indexOf('CROSS APPLY'), taskSelect.indexOf(') creatorAuth'));
  const sources = [
    '@hasFullScope = 1',
    't.CreatedBySicil = @sicil',
    'facts.IsOwnAssignee = 1',
    'p.LeadSicil = t.CreatedBySicil',
    '@canAssignAllCorporate = 1',
    'creatorRead.Sicil = t.CreatedBySicil'
  ];
  for (const source of sources) assert.ok(gate.includes(source), `künye kaynağı korunmalıdır: ${source}`);
  assert.equal((gate.match(/\bOR\b/g) || []).length, sources.length - 1, 'künye kaynakları çoğaltılmamalıdır');
  // Kimlik yalnızca Sicil ile çözülür; ada göre eşleştirme yapılmaz.
  assert.doesNotMatch(gate, /DisplayName|ad_soyad/);
});

test('yetkili yanıt RowVersion değiştirir ve eskimiş istemci sürümünü reddeder', async () => {
  const stack = await createActualStack(seed('full'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    const before = stack.state.tasks.find((entry) => entry.id === TASK);
    const first = await commitProgress(stack, 11);
    assert.notEqual(first.taskUpserts[0].version, before.version);
    const stored = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === TASK);
    assert.equal(first.taskUpserts[0].version, stored.RowVersion.toString('base64'));

    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...before, progress: 12 }] }),
      (error) => error.code === 'CONFLICT'
    );
  } finally { await stack.dispose(); }
});

test('yetki kaldırıldığında yetkili yanıt aynı oturumda kapanır', async () => {
  const stack = await createActualStack(seed('full'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    assert.equal((await commitProgress(stack, 21)).projectUpserts.length, 1);
    const current = stack.state.tasks.find((entry) => entry.id === TASK);
    for (const grant of stack.db.projectAccess) grant.IsActive = 0;
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...current, progress: 22 }] }),
      (error) => ['FORBIDDEN', 'CONFLICT'].includes(error.code)
    );
  } finally { await stack.dispose(); }
});

test('etkin olmayan proje yetkili yanıtta ne yazılabilir ne de görünür', async () => {
  const stack = await createActualStack(seed('admin'), { sicil: ACTOR, corporateWbsSource: false });
  try {
    assert.equal(stack.state.tasks.some((task) => task.id === CLOSED_TASK), false);
    assert.equal(stack.state.projects.some((project) => project.id === CLOSED_PROJECT), false);
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ id: CLOSED_TASK, projectId: CLOSED_PROJECT, task: 'Kapalı görev', progress: 5 }]
      }),
      (error) => ['FORBIDDEN', 'MUTATION_FAILED', 'CONFLICT'].includes(error.code)
    );
  } finally { await stack.dispose(); }
});

/* ── 2 · Yinelenen SQL işi sözleşmesi ───────────────────────────── */

test('yetkili yanıt toplu işi kimlik listelerini ve kurumsal görünümleri bir kez okur', () => {
  const batch = authoritativeBatch();

  // Kimlik listeleri üç kez (proje, WBS, görev) ve yalnızca ayrıştırma
  // bloğunda bölünür; çıktı seçimleri hazır kümelerle birleşir.
  assert.equal((batch.match(/STRING_SPLIT\(/g) || []).length, 3);
  for (const list of ['@projectIds', '@wbsIds', '@taskIds']) {
    assert.equal((batch.match(new RegExp(`STRING_SPLIT\\(${list},`, 'g')) || []).length, 1, list);
  }
  assert.equal((batch.match(/TRY_CONVERT\(uniqueidentifier/g) || []).length, 3);

  // Pahalı kurumsal görünümler toplu işte BİR KEZ okunur.
  for (const view of ['MR_V_ExecutiveScope', 'MR_V_CorporateProjectAccess', 'MR_V_PeopleDirectory']) {
    assert.equal((batch.match(new RegExp(`dbo\\.${view}\\b`, 'g')) || []).length, 1, view);
  }
  // Kurumsal erişim yüklemi kaynak türü süzgecini korur.
  assert.match(batch, /MR_V_CorporateProjectAccess a\s+WHERE p\.SourceType = 'CORPORATE'/);
  assert.match(batch, /SELECT DISTINCT EmployeeSicil\s+FROM dbo\.MR_V_ExecutiveScope\s+WHERE ManagerSicil = @sicil/);

  // Proje yetkisi proje başına TEK KEZ verilir; çıktı seçimleri kararı okur.
  assert.match(batch, /INSERT #ProjectRole\(ProjectId, IsRoleFull, HasFullGrant, HasReadGrant, HasAnyGrant\)/);
  assert.match(batch, /INSERT #ProjectAuth\(ProjectId, AccessLevel, HasReadGrant, IsTaskScoped, IsVisible\)/);
  assert.equal((batch.match(/JOIN #ProjectAuth pa ON/g) || []).length, 6);

  // Sorumlu sayımı ve kendi sorumluluğu satır başına sorgulanmaz.
  assert.match(batch, /INSERT #TaskAssigneeFacts\(TaskId, AssigneeCount, IsOwnAssignee, IsScopeAssignee\)/);
  assert.equal((batch.match(/SELECT COUNT\(\*\) FROM dbo\.MR_TaskAssignees/g) || []).length, 0);
  assert.equal((batch.match(/ownAssignment/g) || []).length, 0);

  // READ yetkisi üzerinden künye açan kural küme olarak çözülür.
  assert.match(batch, /INSERT #CreatorReadScope\(Sicil\)/);
  assert.match(batch, /EXISTS \(\s+SELECT 1 FROM #CreatorReadScope creatorRead WHERE creatorRead\.Sicil = t\.CreatedBySicil\s+\)/);
});

test('yetkili yanıt çıktıları istenen kimlik kümesiyle sınırlı kalır', () => {
  const batch = authoritativeBatch();
  // Altı çıktı kümesi: proje, etiket, WBS, görev, sorumlu, bağımlılık. Ara
  // kümeler sonuç üretmez; `SELECT ... INTO` da istemciye satır döndürmez.
  const outputs = authoritativeStatements()
    .filter((statement) => statement.startsWith('SELECT') && !/\bINTO #/.test(statement));
  assert.equal(outputs.length, 6, `beklenen çıktı sayısı: ${outputs.map((entry) => entry.slice(0, 40)).join(' | ')}`);
  for (const [statement, requested] of [
    ['SELECT p.*, pa.AccessLevel', '#RequestedProjects'],
    ['SELECT pt.ProjectId, pt.TagName', '#RequestedProjects'],
    ['SELECT w.*', '#RequestedWbs'],
    ['SELECT t.*,', '#RequestedTasks'],
    ['SELECT ta.TaskId,', '#RequestedTasks'],
    ['SELECT d.*', '#RequestedTasks']
  ]) {
    const start = batch.indexOf(`    ${statement}`);
    assert.ok(start > 0, statement);
    const body = batch.slice(start, batch.indexOf(';', start));
    assert.match(body, new RegExp(`JOIN ${requested} `), statement);
    // Görünürlük kararı satır içinde yeniden türetilmez.
    assert.doesNotMatch(body, /MR_V_CorporateProjectAccess|MR_V_ExecutiveScope|MR_ProjectAccess/, statement);
  }
});

test('her iki toplu iş de geçici tablolarını hem başta hem sonda temizler', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const snapshot = source
    .split('async function loadSnapshotFrom(')[1]
    .split('async function loadAuthoritativeMutationRows(')[0];
  for (const [name, batch] of [['snapshot', snapshot], ['authoritative', authoritativeBatch()]]) {
    // Havuzdaki bağlantı yeniden kullanıldığında "nesne zaten var" hatası
    // oluşamaz; yarıda kalan bir toplu iş sonraki isteği düşüremez.
    const dropIfExists = batch.match(/DROP TABLE IF EXISTS ([\s\S]*?);/)?.[1] || '';
    const dropAtEnd = batch.match(/\n {4}DROP TABLE (#[\s\S]*?);/)?.[1] || '';
    const names = (value) => (value.match(/#\w+/g) || []).sort();
    assert.ok(names(dropIfExists).length > 0, `${name}: açılışta temizlik yapılmalıdır`);
    assert.deepEqual(names(dropAtEnd), names(dropIfExists), `${name}: iki liste aynı olmalıdır`);
    const created = [...new Set([
      ...(batch.match(/CREATE TABLE (#\w+)/g) || []).map((entry) => entry.replace('CREATE TABLE ', '')),
      ...(batch.match(/INTO (#\w+)/g) || []).map((entry) => entry.replace('INTO ', ''))
    ])].sort();
    assert.deepEqual(created, names(dropIfExists), `${name}: kurulan ve temizlenen kümeler aynı olmalıdır`);
  }
});
