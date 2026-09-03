import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARCHIVED_PROJECT_TYPE_CODES,
  groupProjectsByType,
  isArchivedProject,
  projectTypeMeta,
  visibleProjects
} from '../src/domain/projectTypes.js';
import { normalizeActualChanges } from '../src/data/api/createApiRepository.js';
import { hydrateKnownVersions } from '../src/state/persistence.js';

const UUID = '00010203-0405-4607-8809-0a0b0c0d0e0f';
const UUID_2 = '10111213-1415-4617-9819-1a1b1c1d1e1f';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('tamamlanan ve kapatılan proje türleri başlangıçta gizlenir', () => {
  assert.deepEqual([...ARCHIVED_PROJECT_TYPE_CODES].sort(), ['KF', 'KG', 'KP', 'KT', 'TF', 'TG', 'TP']);
  const projects = [
    { id: '1', code: 'A', name: 'Etkin', projectTypeCode: 'SP' },
    { id: '2', code: 'B', name: 'Tamamlanan', projectTypeCode: 'TP' },
    { id: '3', code: 'C', name: 'Kapatılan', projectTypeCode: 'KP' }
  ];

  assert.equal(isArchivedProject(projects[0]), false);
  assert.equal(isArchivedProject(projects[1]), true);
  assert.deepEqual(visibleProjects(projects).map((project) => project.id), ['1']);
  assert.deepEqual(new Set(visibleProjects(projects, { showArchived: true }).map((project) => project.id)), new Set(['1', '2', '3']));
});

test('proje türü kataloğu grupları profesyonel simge bilgisiyle üretir', () => {
  const groups = groupProjectsByType([
    { id: '1', name: 'Bir', projectTypeCode: 'GP' },
    { id: '2', name: 'İki', projectTypeCode: 'GP' },
    { id: '3', name: 'Üç', projectTypeCode: 'UR' }
  ]);
  assert.equal(groups.find((group) => group.code === 'GP').projects.length, 2);
  assert.equal(projectTypeMeta('GP').icon, 'Sparkle');
  assert.equal(projectTypeMeta('UR').icon, 'Settings');
});

test('var olan kayıtların sürümleri kısmi upsert ve silme yüklerine geri eklenir', () => {
  const state = {
    projects: [{ id: `project-${UUID}`, version: 'project-version' }],
    wbs: [{ id: `wbs-${UUID_2}`, version: 'wbs-version' }],
    tasks: [{ id: `task-${UUID_2}`, version: 'task-version' }]
  };
  const changes = hydrateKnownVersions({
    projectUpserts: [{ id: `project-${UUID}`, color: 'rose' }],
    projectDeletes: [],
    wbsUpserts: [],
    wbsDeletes: [`wbs-${UUID_2}`],
    taskUpserts: [{ id: `task-${UUID_2}`, task: 'Güncel' }],
    taskDeletes: []
  }, state);

  assert.equal(changes.projectUpserts[0].version, 'project-version');
  assert.deepEqual(changes.wbsDeletes[0], { id: `wbs-${UUID_2}`, version: 'wbs-version' });
  assert.equal(changes.taskUpserts[0].version, 'task-version');
});

test('Gerçek Sistem istemcisi ön ekli kimlikleri UUID biçimine indirger', () => {
  const normalized = normalizeActualChanges({
    projectUpserts: [],
    projectDeletes: [],
    wbsUpserts: [],
    wbsDeletes: [],
    taskUpserts: [{
      id: `task-${UUID}`,
      projectId: `project-${UUID_2}`,
      wbsId: `wbs-${UUID}`,
      calendarId: null,
      status: 'todo',
      deps: []
    }],
    taskDeletes: []
  });

  assert.equal(normalized.taskUpserts[0].id, UUID);
  assert.equal(normalized.taskUpserts[0].projectId, UUID_2);
  assert.equal(normalized.taskUpserts[0].wbsId, UUID);
  assert.equal(normalized.taskUpserts[0].status, 'planned');
});

test('Gerçek Sistem istemcisi geçersiz değişiklik kimliğini API çağrısından önce reddeder', () => {
  assert.throws(() => normalizeActualChanges({
    projectUpserts: [],
    projectDeletes: [],
    wbsUpserts: [],
    wbsDeletes: [],
    taskUpserts: [{ id: 'task-invalid', projectId: `project-${UUID}`, deps: [] }],
    taskDeletes: []
  }), /Görev kimliği geçerli bir Gerçek Sistem kimliği \(UUID\) değil/);
});

test('Gerçek Sistem kimlik hatası hangi kaydın hatalı olduğunu iletide açıklar', () => {
  try {
    normalizeActualChanges({
      projectUpserts: [{ id: 'PRJ-WEB-001', calendarId: null }],
      projectDeletes: [],
      wbsUpserts: [],
      wbsDeletes: [],
      taskUpserts: [],
      taskDeletes: []
    });
    assert.fail('geçersiz proje kimliği reddedilmeliydi');
  } catch (error) {
    assert.match(error.message, /Proje kimliği/);
    assert.match(error.message, /"PRJ-WEB-001"/, 'hatalı değer iletide görünmelidir');
    assert.equal(error.details.code, 'ACTUAL_ID_INVALID');
    assert.equal(error.details.value, 'PRJ-WEB-001');
  }
});

test('uzun proje ve personel seçim noktaları canlı arama bileşenini kullanır', () => {
  for (const path of [
    'src/components/shell/AppShell.jsx',
    'src/components/shell/ProjectCreateDialog.jsx',
    'src/features/project/ProjectWorkspaceView.jsx',
    'src/features/simple/SimpleModePanel.jsx',
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/team/TeamView.jsx'
  ]) {
    assert.match(source(path), /SearchableSelect/, `${path} canlı arama seçicisini kullanmalıdır`);
  }
});

test('proje oluşturma kutusu sorumlu varsayılanını dizin GEÇ gelse de doldurur', () => {
  const dialog = source('src/components/shell/ProjectCreateDialog.jsx');

  // Sıfırlama yalnızca `[open]` geçişinde çalışır (açık kutuya girilen veriyi
  // otomatik yenileme silmesin diye). Bunun yan etkisi: kutu kişi dizini henüz
  // BOŞKEN açıldığında `leadId` kalıcı olarak boş kalıyor ve dokunulmamış form
  // sunucudan `PROJECT_LEAD_REQUIRED` alıyordu. Ayrı bir etki bu boşluğu
  // kapatır.
  assert.match(dialog, /\}, \[open\]\);/, 'sıfırlama YALNIZCA açılış geçişine bağlı kalmalıdır');
  assert.match(dialog, /if \(!open \|\| !people\.length\) return;/);
  assert.match(dialog, /\}, \[open, people\]\);/);
  // Yalnızca HÂLÂ BOŞ alan doldurulur: kullanıcının seçtiği sorumlu ezilmez.
  assert.match(dialog, /current\.leadId \? current : \{ \.\.\.current, leadId:/);
});

test('kurumsal proje sorumlusu PROJECT_MANAGER rolünden eşitlenir ve arayüzde salt okunur açıklanır', () => {
  // Sorumlu PROJECT_MANAGER rolünden eşitlenir; kaynakta yönetici satırı YOKSA
  // mevcut sorumlu korunur (OUTER APPLY sonucu NULL olduğunda koşulsuz atama
  // var olan LeadSicil değerini siliyordu).
  assert.match(
    source('src/server/repository/corporateQueries.js'),
    /LeadSicil\s*=\s*ISNULL\(manager\.Sicil,\s*target\.LeadSicil\)/
  );
  assert.match(source('src/server/repository/corporateQueries.js'), /RoleCode\s*=\s*'PROJECT_MANAGER'/);
  assert.match(source('src/features/project/ProjectWorkspaceView.jsx'), /PROJECT_MANAGER rolünden otomatik alınır/);
});

test('temiz kurulum betiği PPTS rolünü doğrudan doğru görünümle oluşturur', () => {
  const createSql = source('database/MR_Create_Durable_Persistence.sql');
  assert.match(createSql, /''PPTS''/);
  assert.match(createSql, /STRING_SPLIT\(pptsSicil,\s*'',''\)/i);
  assert.doesNotMatch(createSql, /''PPTC''/);
  assert.equal(existsSync(new URL('../database/MR_Migrate_0002_Project_Portfolio_Scaling.sql', import.meta.url)), false);
});

test('görev eylem kancası tarayıcı tıklama olayını kayıt yükünden ayırır', () => {
  const hooks = source('src/state/hooks/index.js');
  assert.match(hooks, /normalizeTaskCreationInput/);
  assert.match(hooks, /input\.nativeEvent/);
  assert.match(hooks, /actions\.addTask\(normalizeTaskCreationInput\(input\)\)/);
});

test('kurumsal eşitleme yönetici satırı yokken mevcut sorumluyu KORUR', async () => {
  // Kaynak metin denetimi (yukarıda) gönderilen SQL'i sabitler; bu sınama aynı
  // güvenceyi ÇALIŞTIRARAK doğrular: `ISNULL(manager.Sicil, target.LeadSicil)`
  // koşulsuz atamaya dönerse kurumsal eşitleme, var olan sorumluyu sessizce
  // siler.
  const { createActualStack, corporateSeed } = await import('./helpers/actualStack.mjs');
  // Kurumsal katalogda proje var, ama PROJECT_MANAGER rolü YOK.
  const stack = await createActualStack(
    corporateSeed({ corporateProjectAccess: [] }),
    { corporateWbsSource: false }
  );
  try {
    const findProject = () => stack.db.projects.find(
      (project) => project.SourceType === 'CORPORATE' && project.ProjectCode === 'P4417041'
    );
    const synced = findProject();
    assert.ok(synced, 'kurumsal proje bulunmalıdır');
    // Kalıcı satırda bir sorumlu vardır; kaynakta yönetici satırı yoktur.
    assert.equal(synced.LeadSicil, 900010);

    // Eşitleme yeniden çalıştırılır.
    await stack.repository.loadSnapshot();

    assert.equal(findProject().LeadSicil, 900010, 'yönetici satırı yokken mevcut sorumlu korunmalıdır');
  } finally {
    await stack.dispose();
  }
});
