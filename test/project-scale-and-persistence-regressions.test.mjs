import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  }), /Görev kimliği geçerli UUID olmalıdır/);
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

test('kurumsal proje sorumlusu PROJECT_MANAGER rolünden eşitlenir ve arayüzde salt okunur açıklanır', () => {
  assert.match(source('src/server/repository/corporateQueries.js'), /LeadSicil\s*=\s*manager\.Sicil/);
  assert.match(source('src/server/repository/corporateQueries.js'), /RoleCode\s*=\s*'PROJECT_MANAGER'/);
  assert.match(source('src/features/project/ProjectWorkspaceView.jsx'), /PROJECT_MANAGER rolünden otomatik alınır/);
});

test('PPTS geçiş betiği görünümü doğru rol koduyla yeniden oluşturur', () => {
  const migration = source('database/MR_Migrate_0002_Project_Portfolio_Scaling.sql');
  assert.match(migration, /''PPTS''/);
  assert.match(migration, /STRING_SPLIT\(pptsSicil,\s*'',''\)/i);
  assert.doesNotMatch(migration, /''PPTC''/);
});

test('görev eylem kancası tarayıcı tıklama olayını kayıt yükünden ayırır', () => {
  const hooks = source('src/state/hooks/index.js');
  assert.match(hooks, /normalizeTaskCreationInput/);
  assert.match(hooks, /input\.nativeEvent/);
  assert.match(hooks, /actions\.addTask\(normalizeTaskCreationInput\(input\)\)/);
});
