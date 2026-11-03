import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryStorage } from './helpers/actualStack.mjs';
import { creationEntries } from '../src/domain/identity/creationIds.js';
import { fileURLToPath } from 'node:url';

import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';
import { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';
import { ACCESS_REASONS, deriveEffectiveAccess } from '../src/server/authorization/authorization.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createStateMutationOrchestrator, loadApplicationData } from '../src/state/persistence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_ID = '2d9f0b82-bf72-4b9d-b44e-21506f486697';
const WBS_ID = '3eaf1c93-c083-4cad-8f3f-32617f597708';
const TASK_ID = '4fb02da4-d194-4dbe-9040-4372806a8819';

function allocationResponse(changes) {
  const allocations = creationEntries(changes).map(({ entry, entityType }) => ({
    clientId: entry.id, entityType, id: randomUUID(), proof: randomUUID()
  }));
  for (const record of allocations) {
    const { entry } = creationEntries(changes).find(({ entry, entityType }) => entityType === record.entityType && entry.id === record.clientId);
    record.projectId = record.entityType === 'PROJECT' ? record.id
      : allocations.find((value) => value.entityType === 'PROJECT' && value.clientId === entry.projectId)?.id || entry.projectId;
  }
  return { ok: true, status: 200, async json() { return { allocations }; } };
}

test("gerçek kayıt yanıtı normal SQL kimliğini bekleyen istemci kimliğine eşler", async () => {
  const projectClientId = `project-${PROJECT_ID}`;
  const wbsClientId = `wbs-${WBS_ID}`;
  const taskClientId = `task-${TASK_ID}`;
  const originalFetch = globalThis.fetch;
  let postedChanges;

  globalThis.fetch = async (_url, init) => {
    if (String(_url).endsWith('/session')) return Response.json({ authenticated: true, currentUser: { sicil: 900001 } });
    const payload = JSON.parse(init.body);
    if (payload.operation) return allocationResponse(payload.allocationChanges);
    postedChanges = payload.changes;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          projectUpserts: [{ id: postedChanges.projectUpserts[0].id, name: 'New Project', version: 'project-version' }],
          wbsUpserts: [{ id: postedChanges.wbsUpserts[0].id, projectId: postedChanges.projectUpserts[0].id, parentId: null, code: '1', name: 'Root', version: 'wbs-version' }],
          taskUpserts: [{
            id: postedChanges.taskUpserts[0].id,
            projectId: postedChanges.projectUpserts[0].id,
            wbsId: postedChanges.wbsUpserts[0].id,
            status: 'planned',
            deps: [{ predecessorId: postedChanges.taskUpserts[0].id, type: 'FS' }],
            version: 'task-version'
          }],
          taskDeletes: [postedChanges.taskUpserts[0].id]
        };
      }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/test-api', aliasStorage: memoryStorage() });
    const result = await repository.commitChanges({
      projectUpserts: [{ id: projectClientId, name: 'New Project' }],
      wbsUpserts: [{ id: wbsClientId, projectId: projectClientId, parentId: null, code: '1', name: 'Root' }],
      taskUpserts: [{
        id: taskClientId,
        projectId: projectClientId,
        wbsId: wbsClientId,
        status: 'todo',
        deps: [{ id: taskClientId, predecessorId: taskClientId, type: 'FS' }]
      }],
      taskDeletes: [taskClientId]
    });

    assert.notEqual(postedChanges.projectUpserts[0].id, PROJECT_ID);
    assert.ok(postedChanges.projectUpserts[0].creationProof);
    assert.notEqual(postedChanges.wbsUpserts[0].id, WBS_ID);
    assert.ok(postedChanges.wbsUpserts[0].creationProof);
    assert.notEqual(postedChanges.taskUpserts[0].id, TASK_ID);
    assert.ok(postedChanges.taskUpserts[0].creationProof);
    assert.equal(result.projectUpserts[0].id, projectClientId);
    assert.equal(result.projectUpserts[0].version, 'project-version');
    assert.equal(result.wbsUpserts[0].id, wbsClientId);
    assert.equal(result.wbsUpserts[0].projectId, projectClientId);
    assert.equal(result.taskUpserts[0].id, taskClientId);
    assert.equal(result.taskUpserts[0].projectId, projectClientId);
    assert.equal(result.taskUpserts[0].wbsId, wbsClientId);
    assert.equal(result.taskUpserts[0].status, 'todo');
    assert.equal(result.taskUpserts[0].deps[0].predecessorId, taskClientId);
    assert.equal(result.taskDeletes[0], taskClientId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bağımlılık kaydı öncül kimliğini kullanmak yerine yeni ilişki kimliği üretir", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /dep\.input\('dependencyId', sql\.UniqueIdentifier, randomUUID\(\)\)/);
  assert.doesNotMatch(source, /dependencyId[^\n]*dependency\.id/);
});

test("veri kipi anahtarı yalnızca ayarlar sayfasındadır", () => {
  // Anahtar kenar çubuğunu sade tutmak için Ayarlar sayfasına taşındı.
  const boundary = read('src/components/shell/AppDataBoundary.jsx');
  const shell = read('src/components/shell/AppShell.jsx');
  const settings = read('src/features/settings/SettingsView.jsx');
  const root = read('src/components/shell/ApplicationRoot.jsx');

  assert.doesNotMatch(boundary, /DataModeIndicator/);
  // Ayarlar'a yalnızca kabuk üzerinden ulaşıldığı için ilk yükleme hatasında
  // Demo kipine dönüş yolu korunur.
  assert.match(boundary, /Demo kipine geç/);
  assert.doesNotMatch(shell, /DataModeIndicator/);
  assert.match(settings, /<DataModeIndicator variant="settings" \/>/);
  assert.ok(
    settings.indexOf('<DataModeIndicator variant="settings" />') > settings.indexOf('Veri kaynağı'),
    'settings switch must live in the data source card'
  );
  assert.doesNotMatch(root, /<DataModeIndicator/);
});

test("veri kipi anahtarı kalıcılık bildiriminin köşesini kaplamaz", () => {
  const experience = read('src/app/styles/experience.css');
  const shellCss = read('src/app/styles/shell.css');
  const indicatorBlock = experience.slice(
    experience.indexOf('.data-mode-indicator {'),
    experience.indexOf('.data-mode-current {')
  );

  assert.doesNotMatch(indicatorBlock, /position:\s*fixed/);
  assert.doesNotMatch(indicatorBlock, /bottom:/);
  assert.match(shellCss, /\.persistence-status \{[^}]*position:\s*fixed/s);
});

test("görev güncellemesi proje değişikliğini ProjectId ile saklar", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /UPDATE dbo\.MR_Tasks\s+SET ProjectId = @projectId, WbsId = @wbsId/s);
});

test("kip değişimi bekleyen düzenlemeleri boşaltır ve sıralı değişiklik kuyruğunu bekler", async () => {
  let state = createInitialState({
    calendars: [],
    projects: [{ id: 'p1', name: 'Project One' }],
    people: [],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 }],
    tasks: [{ id: 't1', projectId: 'p1', wbsId: 'w1', task: 'Before', description: '', status: 'todo', deps: [] }],
    baselines: [],
    taskBaselineSnapshots: []
  });
  const commits = [];
  const repository = {
    async commitChanges(changes) {
      commits.push(changes);
      return changes;
    }
  };
  const orchestrator = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) {
      state = appStateReducer(state, action);
      return state;
    },
    taskPatchDelayMs: 60_000,
    now: () => '2026-07-23T00:00:00.000Z'
  });

  const pending = orchestrator.updateTask('t1', { description: 'Saved before mode switch' });
  const flushed = await orchestrator.flush();

  assert.deepEqual(flushed, { ok: true });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].taskUpserts[0].description, 'Saved before mode switch');
  assert.equal((await pending).ok, true);
  assert.equal(state.tasks[0].description, 'Saved before mode switch');
  orchestrator.dispose();

  const indicator = read('src/components/shell/DataModeIndicator.jsx');
  assert.ok(indicator.indexOf('await actions.flushPendingChanges()') < indicator.indexOf('await setDataMode(nextMode)'));
});

test("proje oluşturma kaydedilmiş kök WBS kaydını yeniden eklemez", () => {
  // Yetkili değişiklik kümesi indirgeyicide kimlik üzerinden uygulanır; aynı kök
  // düğüm iki kez işlense bile durumda tek kayıt kalır.
  const state = createInitialState({
    calendars: [],
    projects: [{ id: PROJECT_ID, name: 'Proje', color: 'blue', version: 'v1' }],
    people: [],
    wbs: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Proje', version: 'v1' }],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  });
  const committed = {
    projectUpserts: [{ id: PROJECT_ID, name: 'Proje', color: 'blue', version: 'v2' }],
    wbsUpserts: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Proje', version: 'v2' }]
  };

  const once = appStateReducer(state, { type: 'data/apply-changes', changes: committed });
  const twice = appStateReducer(once, { type: 'data/apply-changes', changes: committed });

  assert.equal(twice.wbs.filter((node) => node.id === WBS_ID).length, 1);
  assert.equal(twice.projects.filter((project) => project.id === PROJECT_ID).length, 1);
  assert.equal(twice.projects[0].version, 'v2', 'authoritative project version must replace the stale one');

  const source = read('src/state/AppStateProvider.jsx');
  assert.doesNotMatch(source, /const committedRoot/);
  assert.doesNotMatch(source, /wbs: \[\.\.\.latest\.wbs, committedRoot\]/);
});

test("kısmi görev görünürlüğü etkin olmayan projeyi görünür yapmaz", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  // Görev tabanlı KISMİ görünürlük TEK geçişte toplanan kişisel kapsamdan
  // türer; kendi kapsamı ile yönetim kapsamı ayrı bayraklarda kalır ve her
  // ikisi de ETKİN proje süzgecinden geçtikten sonra görünür kümeye yazılır.
  assert.match(source, /INSERT #ScopedTasks\(TaskId, ProjectId, IsCreator, IsOwnAssignee, IsScopeAssignee\)[\s\S]*t\.CreatedBySicil = @sicil[\s\S]*FROM dbo\.MR_TaskAssignees ta[\s\S]*WHERE ta\.Sicil = @sicil[\s\S]*FROM #ExecutiveScope es[\s\S]*JOIN dbo\.MR_TaskAssignees ta ON ta\.Sicil = es\.EmployeeSicil/);
  assert.match(source, /INSERT #OwnScopedProjects\(ProjectId\)\s+SELECT DISTINCT s\.ProjectId FROM #ScopedTasks s WHERE s\.IsCreator = 1 OR s\.IsOwnAssignee = 1/);
  assert.match(source, /INSERT #ScopeAssignedProjects\(ProjectId\)\s+SELECT DISTINCT s\.ProjectId FROM #ScopedTasks s WHERE s\.IsScopeAssignee = 1/);
  assert.match(
    source,
    /SELECT DISTINCT scoped\.ProjectId, 'PARTIAL'[\s\S]*SELECT own\.ProjectId FROM #OwnScopedProjects own[\s\S]*SELECT team\.ProjectId FROM #ScopeAssignedProjects team[\s\S]*JOIN dbo\.MR_Projects p ON p\.ProjectId = scoped\.ProjectId\s+WHERE p\.IsActive = 1/s
  );
  // Yönetici olmayan bütün proje kümeleri `IF @isAdmin = 1 ... ELSE` bloğunun
  // ELSE dalındadır: yüklem yerine dal kullanmak kümeyi yöneticide hiç
  // çalıştırmaz, yetki anlamı ise değişmez.
  assert.match(source, /IF @isAdmin = 1\s+INSERT #VisibleProjects\(ProjectId, AccessLevel\)\s+SELECT ProjectId, 'FULL'\s+FROM dbo\.MR_Projects\s+WHERE IsActive = 1;\s+ELSE\s+BEGIN/);
});

test("gerçek kip UUID normalleştirmesi yalnızca yerel oluşturma önekini kaldırır", () => {
  assert.equal(toActualUuid(`task-${TASK_ID}`), TASK_ID);
  assert.equal(toActualUuid(TASK_ID), TASK_ID);
});


test("WBS güncellemesi kayıtlı projeyi yetkilendirir ve sahte proje değişimini reddeder", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  const loadIndex = body.indexOf('const before = hasVersion(node.version) ? await wbsRowForUpdate(executor, wbsId) : null');
  assert.ok(loadIndex >= 0 && loadIndex < body.indexOf('assertProjectWriteAccess(actor.effective, storedProjectId)'));
  assert.match(body, /const storedProjectId = id\(before\.ProjectId\);/);
  // Karşılaştırma kanoniktir: SQL Server büyük harfli GUID döndürdüğü için
  // düz `!==` aynı projeyi farklı sanıp yazmayı reddediyordu.
  assert.match(body, /if \(!sameActualId\(storedProjectId, projectId\)\)/);
});

test("görev güncellemesi kaynak ve hedef projeyi yetkilendirir", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const loadIndex = body.indexOf('const before = hasVersion(task.version) ? await taskRow(executor, taskId) : null');
  // Proje yetkisi, sorumlu doğrulamasından ÖNCE verilir: `ensurePeople` daha
  // erken çalıştığında yetkisiz bir kullanıcı, geçerli ve geçersiz sicillerin
  // farklı hata üretmesinden kurumsal rehberi okuyabiliyordu.
  const sourceScopeIndex = body.indexOf('await assertTaskProjectScope(executor, actor, beforeProjectId)');
  const destinationScopeIndex = body.indexOf('await assertTaskProjectScope(executor, actor, projectId,');
  const peopleIndex = body.indexOf('await ensurePeople(executor, task.assigneeIds');
  const sourceAssigneeIndex = body.indexOf('await assertAssigneeScope(executor, actor, beforeProjectId');
  const destinationAssigneeIndex = body.indexOf('await assertAssigneeScope(executor, actor, projectId, assigneeSicils, destinationProjectScope)');
  assert.ok(loadIndex >= 0 && loadIndex < sourceScopeIndex);
  assert.ok(sourceScopeIndex < destinationScopeIndex);
  assert.ok(destinationScopeIndex < peopleIndex, 'proje yetkisi rehber yoklamasından önce denetlenmelidir');
  assert.ok(peopleIndex < sourceAssigneeIndex);
  assert.ok(sourceAssigneeIndex < destinationAssigneeIndex);
});

test('görev atama kapsamı yalnızca etkin kurumsal projeleri ve kendi personelini kapsar', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function assertTaskProjectScope'), source.indexOf('async function projectRootWbsId'));
  // FULL erişim ve sistem yöneticisi kısa devre yapar; yönetici yine de ETKİN
  // OLMAYAN bir projeye yazamaz (etkin FULL yetkileri de etkin projelerden kurulur).
  assert.match(body, /if \(actor\.isSystemAdmin\) \{\s+await assertActiveProject\(executor, projectId\);\s+return TASK_PROJECT_SCOPES\.FULL;\s+\}/);
  assert.match(body, /accessLevel === 'FULL'\) \{\s+await assertActiveProject\(executor, projectId\);\s+return TASK_PROJECT_SCOPES\.FULL;\s+\}/);
  // Kapsam yalnızca yöneticilere açıktır.
  assert.match(body, /if \(hasTaskAssignmentScope\(actor\) && actor\.isExecutive\)/);
  // Yalnızca ETKİN KURUMSAL proje.
  assert.match(body, /SourceType = 'CORPORATE' AND IsActive = 1/);
  assert.match(body, /MR_Projects WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*SourceType = 'CORPORATE' AND IsActive = 1/);
  // Sorumluların tamamı yöneticinin kapsamında olmalı.
  assert.match(body, /FROM dbo\.MR_V_ExecutiveScope es\s+WHERE es\.ManagerSicil = @managerSicil/);
  assert.match(body, /görevin en az bir sorumlusu olmalıdır/);

  const activeLock = source.slice(
    source.indexOf('async function assertActiveProject'),
    source.indexOf('const TASK_PROJECT_SCOPES')
  );
  assert.match(activeLock, /MR_Projects WITH \(UPDLOCK, HOLDLOCK\)/);
  const assigneeCreateLock = source.slice(
    source.indexOf('async function hasAuthoritativeAssigneeTaskCreateScope'),
    source.indexOf('async function assertTaskProjectScope')
  );
  assert.match(assigneeCreateLock, /MR_Projects p WITH \(UPDLOCK, HOLDLOCK\)/);
});

test("projeler arası görev taşıma ProjectId değişmeden gelen ve giden bağımlılıkları siler", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const cleanupIndex = body.indexOf('WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;');
  const updateIndex = body.indexOf('UPDATE dbo.MR_Tasks');
  assert.match(body, /const projectChanged = before && !sameActualId\(before\.ProjectId, projectId\);/);
  assert.ok(cleanupIndex >= 0 && cleanupIndex < updateIndex);
});

test("etkin olmayan projenin elle verilmiş FULL yetkisi kullanılmaz", () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(
    source,
    /FROM dbo\.MR_ProjectAccess pa\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = pa\.ProjectId\s+WHERE p\.IsActive = 1 AND pa\.Sicil = @sicil AND pa\.IsActive = 1 AND pa\.AccessLevel IN \('FULL', 'READ'\)/s
  );
});

test("loadSessionContext olmayan depo kısıtlı varsayılan oturumla yüklenir", async () => {
  const result = await loadApplicationData({
    kind: 'legacy-test',
    async loadSnapshot() {
      return { calendars: [], projects: [], people: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [] };
    },
    async commitChanges(changes) { return changes; }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.session, {
    dataMode: 'demo',
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  });
});

test("gerçek depo kimlik eşlemelerini sonraki görüntülerde ve yalnızca silme yanıtında korur", async () => {
  const projectClientId = `project-${PROJECT_ID}`;
  const wbsClientId = `wbs-${WBS_ID}`;
  const taskClientId = `task-${TASK_ID}`;
  const originalFetch = globalThis.fetch;
  let step = 0;
  let allocated;

  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/session')) return Response.json({ authenticated: true, currentUser: { sicil: 900001 } });
    if (init?.body) {
      const payload = JSON.parse(init.body);
      if (payload.operation) return allocationResponse(payload.allocationChanges);
      if (payload.changes.projectUpserts?.length) allocated = payload.changes;
    }
    step += 1;
    if (String(url).endsWith('/commit') && step === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            projectUpserts: [{ id: allocated.projectUpserts[0].id, name: 'Persistent Alias', version: 'pv' }],
            wbsUpserts: [{ id: allocated.wbsUpserts[0].id, projectId: allocated.projectUpserts[0].id, parentId: null, code: '1', name: 'Root', version: 'wv' }],
            taskUpserts: [{ id: allocated.taskUpserts[0].id, projectId: allocated.projectUpserts[0].id, wbsId: allocated.wbsUpserts[0].id, status: 'planned', deps: [], version: 'tv' }]
          };
        }
      };
    }
    if (String(url).endsWith('/snapshot')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            session: { authenticated: true, currentUser: { sicil: 900001 } },
            projects: [{ id: allocated.projectUpserts[0].id, name: 'Persistent Alias' }],
            wbs: [{ id: allocated.wbsUpserts[0].id, projectId: allocated.projectUpserts[0].id, parentId: null, code: '1', name: 'Root' }],
            tasks: [{ id: allocated.taskUpserts[0].id, projectId: allocated.projectUpserts[0].id, wbsId: allocated.wbsUpserts[0].id, status: 'planned', deps: [] }]
          };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { taskDeletes: [allocated.taskUpserts[0].id] }; }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/alias-api', aliasStorage: memoryStorage() });
    await repository.commitChanges({
      projectUpserts: [{ id: projectClientId, name: 'Persistent Alias' }],
      wbsUpserts: [{ id: wbsClientId, projectId: projectClientId, parentId: null, code: '1', name: 'Root' }],
      taskUpserts: [{ id: taskClientId, projectId: projectClientId, wbsId: wbsClientId, status: 'todo', deps: [] }]
    });

    const snapshot = await repository.loadSnapshot();
    assert.equal(snapshot.projects[0].id, projectClientId);
    assert.equal(snapshot.wbs[0].id, wbsClientId);
    assert.equal(snapshot.wbs[0].projectId, projectClientId);
    assert.equal(snapshot.tasks[0].id, taskClientId);
    assert.equal(snapshot.tasks[0].projectId, projectClientId);
    assert.equal(snapshot.tasks[0].wbsId, wbsClientId);

    const deleted = await repository.commitChanges({ taskDeletes: [taskClientId] });
    assert.equal(deleted.taskDeletes[0], taskClientId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("kurumsal proje eşitlemesi eşzamanlı ilk eklemeyi ProjectCode ile serileştirir", () => {
  const source = read('src/server/repository/corporateQueries.js');
  assert.match(
    source,
    /NOT EXISTS \(\s*SELECT 1\s*FROM dbo\.MR_Projects p WITH \(UPDLOCK, HOLDLOCK\)\s*WHERE p\.SourceType = 'CORPORATE' AND UPPER\(p\.ProjectCode\) = source\.ProjectCode\s*\)/s
  );
});

test("görev sorumluları yalnızca doğrulanmış sicil listesiyle saklanır", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /function normalizeSicils\(sicils\)/);
  assert.match(source, /: await ensurePeople\(executor, task\.assigneeIds \|\| \[\]\);/);
  assert.match(source, /\(narrowTaskWrite && !creatorAssigneeWrite\) \|\| assigneesUnchanged\s+\? authoritativeAssigneeSicils/);
  assert.match(source, /for \(const sicil of assigneeSicils\)/);
  assert.doesNotMatch(source, /\(sicils \|\| \[\]\)\.filter\(Boolean\)\.map\(Number\)/);
});

test("görüntüde HR09 FULL görünürlüğü yalnızca kurumsal projelere uygulanır", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(
    source,
    /JOIN dbo\.MR_V_CorporateProjectAccess a ON a\.ProjectCode = UPPER\(p\.ProjectCode\)\s+WHERE p\.SourceType = 'CORPORATE' AND p\.IsActive = 1 AND a\.Sicil = @sicil/s
  );
});

test("kısmi görüntü WBS kataloğunu oluşturan veya atanan kişiye açarken üst öğe dönüşünü korur", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  // Katalog kümesi yalnızca KENDİ oluşturduğu/sorumlusu olduğu projelerden
  // türer; yönetim kapsamı (#ScopeAssignedProjects) bu kümeyi genişletmez.
  // Karar proje satırında `IsTaskScoped` olarak taşınır.
  const taskScopedFlag = source.slice(source.indexOf('IsTaskScoped = CASE'), source.indexOf('FROM #VisibleProjects v;'));
  assert.match(taskScopedFlag, /^IsTaskScoped = CASE WHEN v\.AccessLevel = 'PARTIAL' AND EXISTS \(\s+SELECT 1 FROM #OwnScopedProjects own WHERE own\.ProjectId = v\.ProjectId\s+\) THEN 1 ELSE 0 END/);
  assert.doesNotMatch(taskScopedFlag, /#ScopeAssignedProjects/);
  assert.match(source, /;WITH RequiredPartialWbs AS \(/);
  assert.match(source, /WHERE visible\.AccessLevel = 'PARTIAL'[\s\S]*JOIN RequiredPartialWbs child ON child\.ParentWbsId = parent\.WbsId/);
  // Özyinelemeli ata zinciri bir kez toplanır ve WBS seçimi hazır kümeyi okur.
  assert.match(source, /INSERT #RequiredPartialWbs\(WbsId\)\s+SELECT DISTINCT WbsId FROM RequiredPartialWbs\s+OPTION \(MAXRECURSION 1000\)/);
  assert.match(source, /WHERE v\.AccessLevel = 'FULL'\s+OR v\.HasReadGrant = 1\s+OR v\.IsTaskScoped = 1\s+OR EXISTS \(SELECT 1 FROM #RequiredPartialWbs r WHERE r\.WbsId = w\.WbsId\)/s);
});

test("WBS üst öğe doğrulaması soy ağacı boyunca güncelleme ve serileştirme kilitlerini tutar", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  assert.match(source, /FROM dbo\.MR_WBS WITH \(UPDLOCK, HOLDLOCK\) WHERE WbsId = @id/);
  assert.match(body, /const before = hasVersion\(node\.version\) \? await wbsRowForUpdate\(executor, wbsId\) : null/);
  assert.match(body, /let parent = await wbsRowForUpdate\(executor, node\.parentId\)/);
  assert.match(body, /await wbsRowForUpdate\(executor, parent\.ParentWbsId\)/);
});

test("proje güncellemesi LeadSicil değerini bağlamadan ve yazmadan doğrular", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitProject'), source.indexOf('async function commitWbs'));
  const updateStart = body.lastIndexOf('assertProjectWriteAccess(actor.effective, projectId)');
  const validationIndex = body.indexOf("await ensurePeople(executor, project.leadId ? [project.leadId] : []);", updateStart);
  const bindIndex = body.indexOf("req.input('leadSicil', sql.Int", updateStart);
  assert.ok(updateStart >= 0 && validationIndex > updateStart && validationIndex < bindIndex);
});


test("geliştirme kimliği kısmi ondalık boş güvensiz ve pozitif olmayan sicili reddeder", () => {
  assert.equal(parseDevelopmentSicil('900002'), 900002);
  assert.equal(parseDevelopmentSicil(' 900002 '), 900002);
  assert.equal(parseDevelopmentSicil('2147483647'), 2147483647);
  assert.equal(parseDevelopmentSicil('2147483648'), null);
  for (const invalid of ['900002abc', '900002.5', '0', '-1', '', '   ', '9007199254740992']) {
    assert.equal(parseDevelopmentSicil(invalid), null, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
  const providerSource = read('src/server/identity/currentUserProvider.js');
  assert.doesNotMatch(providerSource, /Number\.parseInt/);
  assert.match(providerSource, /parseDevelopmentSicil\(process\.env\.MERGEN_ROTA_DEV_SICIL\)/);
});

test("elle verilen proje kodu kurumsal eşitlemeyi bastıramaz veya çakıştıramaz", () => {
  const sync = read('src/server/repository/corporateQueries.js');
  assert.match(sync, /FROM dbo\.MR_Projects manual WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*manual\.SourceType = 'MANUAL'/);
  assert.match(sync, /THROW 51002, 'A manual project code conflicts with the corporate project source\.'/);
  assert.match(sync, /WHERE p\.SourceType = 'CORPORATE' AND UPPER\(p\.ProjectCode\) = source\.ProjectCode/);
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /async function assertManualProjectCodeAvailable\(executor, projectCode\)/);
  assert.ok((repository.match(/await assertManualProjectCodeAvailable\(executor, projectCode\);/g) || []).length >= 2);
});

test("yalnızca kısmi görüntü kişi dizinini yetkili proje bağlamıyla sınırlar", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /DECLARE @HasFullScope bit = CASE[\s\S]*AccessLevel = 'FULL'/);
  // Rehber kümesi önceden toplanır; yayınlanan satırlar yine aynı iki kuralla
  // sınırlanır: tam kapsam ya da YAYINLANAN kişi kümesinde olmak. Yalnızca adı
  // çözülen kişiler (IsPublished = 0) genel rehbere GİRMEZ.
  assert.match(source, /FROM #Directory pd\s+WHERE @HasFullScope = 1\s+OR EXISTS \(SELECT 1 FROM #DirectorySicils ds WHERE ds\.Sicil = pd\.Sicil AND ds\.IsPublished = 1\)/s);
  assert.match(source, /INSERT #DirectorySicils\(Sicil, IsPublished\)[\s\S]*SELECT @sicil AS Sicil, 1 AS IsPublished/);
  assert.match(source, /SELECT p\.LeadSicil, 1\s+FROM dbo\.MR_Projects p\s+JOIN #VisibleProjects v ON v\.ProjectId = p\.ProjectId/);
  // Sorumlu kimliği yalnızca READ hibesi, kişinin kendisi ya da yönetim
  // kapsamı ile yayınlanır; kapsam dışı eş sorumlu adı IsPublished = 0 kalır.
  assert.match(source, /CASE WHEN visible\.HasReadGrant = 1\s+OR ta\.Sicil = @sicil\s+OR EXISTS \(SELECT 1 FROM #ExecutiveScope es WHERE es\.EmployeeSicil = ta\.Sicil\)\s+THEN 1 ELSE 0 END/s);
  assert.doesNotMatch(source, /visibilityGate\.TaskId = visibleTask\.TaskId/);
});

test("kurumsal proje görünümü kullanılabilir ProjectName sağlar", () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  const view = source.match(/CREATE VIEW dbo\.MR_V_CorporateProjects AS([\s\S]*?)GROUP BY/i)?.[0] || '';
  assert.match(
    view,
    /COALESCE\s*\(\s*NULLIF\(LTRIM\(RTRIM\(ProjeAdi\)\)[\s\S]*NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\)[\s\S]*AS ProjectName/i
  );
});


test("ProjectCode yazma kaynak eşitleme ve erişim birleşimlerinde kanonikleşir", () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /String\(project\.code\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(repository, /WHERE UPPER\(reserved\.ProjectCode\) = @projectCode/);
  assert.match(repository, /a\.ProjectCode = UPPER\(p\.ProjectCode\)/);

  const sync = read('src/server/repository/corporateQueries.js');
  assert.match(sync, /source\.ProjectCode = UPPER\(manual\.ProjectCode\)/);
  assert.match(sync, /SET ProjectCode = source\.ProjectCode/);
  assert.match(sync, /UPPER\(p\.ProjectCode\) = source\.ProjectCode/);

  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  assert.match(createSql, /UPPER\(NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\)/i);
  const accessView = createSql.match(/CREATE VIEW dbo\.MR_V_CorporateProjectAccess AS([\s\S]*?);'\);/i)?.[0] || '';
  assert.match(accessView, /UPPER\(NULLIF\(LTRIM\(RTRIM\(projeKodu\)\)/i);
});

test("kurumsal eşitleme kök WBS kaydını yalnızca eski proje adı veya kodunu izliyorsa günceller", () => {
  const sync = read('src/server/repository/corporateQueries.js');
  const rootUpdate = sync.slice(sync.indexOf('UPDATE root'), sync.indexOf('UPDATE target'));
  assert.match(rootUpdate, /root\.ParentWbsId IS NULL/);
  assert.match(rootUpdate, /root\.Name = target\.ProjectName OR root\.Name = target\.ProjectCode/);
  assert.match(rootUpdate, /SELECT COUNT\(\*\) FROM dbo\.MR_WBS roots/);
  assert.match(rootUpdate, /SET Name = source\.ProjectName/);
});

test("proje READ yetkisi oturumda PARTIAL görünür; FULL önceliğini korur", () => {
  const effective = deriveEffectiveAccess({
    isSystemAdmin: false,
    fullProjectIds: ['full-project'],
    partialProjectRows: [
      { projectId: 'read-project', reason: ACCESS_REASONS.MANUAL_GRANT },
      { projectId: 'full-project', reason: ACCESS_REASONS.MANUAL_GRANT }
    ],
    partialTaskRows: []
  });
  assert.equal(effective.access.get('read-project')?.accessLevel, 'PARTIAL');
  assert.equal(effective.access.get('full-project')?.accessLevel, 'FULL');

  const context = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(context, /pa\.AccessLevel IN \('FULL', 'READ'\)/);
  assert.match(context, /partialProjectRows/);
  assert.match(context, /row\.AccessLevel === 'READ'/);
});

test("HR02 kişi dizini yinelenme sıralaması belirlenimci alan eşitlik çözümü kullanır", () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  const view = source.match(/CREATE VIEW dbo\.MR_V_PeopleDirectory AS([\s\S]*?);'\);/i)?.[0] || '';
  const order = view.match(/ROW_NUMBER\(\) OVER \([\s\S]*?\) AS rn/i)?.[0] || '';
  for (const field of ['kullanici_adi', 'ad_soyad', 'unvan', 'sektor', 'direktorluk', 'mudurluk', 'birim']) {
    assert.match(order, new RegExp(field, 'i'));
  }
});


test("sunucu dönüş proje kökleri kayıt WBS yanıtına eklenir", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const responseWbsScope = source.slice(source.indexOf('const wbsIds = new Set(['), source.indexOf('const taskIds = new Set('));
  assert.match(responseWbsScope, /changes\.wbsUpserts\.map\(\(value\) => id\(value\.id\)\)/);
  assert.match(responseWbsScope, /\.\.\.consumedRootIds/);
  assert.match(responseWbsScope, /\.\.\.touchedTaskWbs/);
  assert.match(source, /return \{ created: true, consumedRootId: authoritativeRoot\.id, tagPlan \}/);
});

test("sicil doğrulaması SQL Server int üst sınırını toplu bağlamadan önce reddeder", async () => {
  const { createActualStack, corporateSeed } = await import('./helpers/actualStack.mjs');
  const stack = await createActualStack(corporateSeed(), {
    sicil: 900001,
    corporateWbsSource: false
  });

  try {
    const project = stack.state.projects.find((entry) => entry.code === 'P4417041');
    assert.ok(project, 'test projesi yüklenmelidir');
    const statementStart = stack.db.statements.length;
    const { createSqlAppRepository } = await import('../src/server/repository/sqlAppRepository.js');

    await assert.rejects(
      createSqlAppRepository().commitChanges({
        projectUpserts: [{ ...project, leadId: '2147483648' }]
      }),
      (error) => error.code === 'MUTATION_FAILED' && /2147483648/.test(error.message)
    );

    const statements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);
    assert.equal(
      statements.filter((sqlText) => sqlText.includes('STRING_SPLIT(@sicils')).length,
      0,
      'geçersiz Sicil batch rehber sorgusu bağlanmadan reddedilmelidir'
    );
  } finally {
    await stack.dispose();
  }
});

test("proje READ yetkisi gerekli görev WBS ve kişileri açar; tam çizelgeleme verisi vermez", () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /CREATE TABLE #ReadGrantedProjects\(ProjectId uniqueidentifier PRIMARY KEY\)/);
  assert.match(source, /pa\.AccessLevel = 'READ'/);
  // READ kararı proje ve görev satırlarında TAŞINIR; WBS, görev, sorumlu ve
  // rehber kümeleri aynı kararı satır başına yeniden türetmez.
  assert.match(source, /SELECT 1 FROM #ReadGrantedProjects readProject WHERE readProject\.ProjectId = v\.ProjectId/);
  assert.match(source, /AND \(v\.AccessLevel = 'FULL' OR v\.HasReadGrant = 1\)/);
  assert.match(source, /SELECT w\.\*[\s\S]*OR v\.HasReadGrant = 1/);
  // FULL/READ dalında oluşturan kimliği zaten açıktır; KISMİ dalda yalnızca
  // görevi oluşturan kullanıcı için açılır.
  assert.match(source, /-- FULL ya da READ projesinde oluşturan kimliği zaten açıktır\.\s+1\s+FROM dbo\.MR_Tasks t/);
  assert.match(source, /scoped\.IsOwnAssignee, scoped\.IsScopeAssignee,\s+CASE WHEN t\.CreatedBySicil = @sicil THEN 1 ELSE 0 END/);
  assert.match(source, /CASE WHEN visible\.HasReadGrant = 1/);
  assert.match(source, /SELECT d\.\*[\s\S]*WHERE v\.AccessLevel = 'FULL';/);
  // Yetkili mutasyon yanıtında da READ yetkisi görev/WBS görünürlüğünü açar,
  // bağımlılıkları AÇMAZ.
  assert.match(source, /JOIN #ProjectAuth pa ON pa\.ProjectId = w\.ProjectId\s+WHERE pa\.AccessLevel = 'FULL' OR pa\.HasReadGrant = 1 OR pa\.IsTaskScoped = 1;/);
  assert.match(source, /JOIN #ProjectAuth pa ON pa\.ProjectId = d\.ProjectId\s+WHERE pa\.AccessLevel = 'FULL';/);
});

test("kök WBS silme alan durumunda ve SQL kalıcılığında reddedilir", () => {
  const snapshot = {
    projects: [{ id: 'p1', name: 'Project' }], people: [], calendars: [],
    wbs: [{ id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 }],
    tasks: [], baselines: [], taskBaselineSnapshots: []
  };
  const state = appStateReducer(createInitialState(snapshot), { type: 'wbs/delete', id: 'root' });
  assert.equal(state.wbs.length, 1);
  assert.equal(state.wbsActionError?.code, 'WBS_ROOT_DELETE_FORBIDDEN');
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function deleteWbs'), source.indexOf('export function createSqlAppRepository'));
  assert.match(body, /if \(before\.ParentWbsId == null\)/);
});

test("oturum yetenekleri normalleştirme ve koleksiyon yenilemesinde korunur", () => {
  const session = {
    dataMode: 'actual', currentUser: { id: '900002', name: 'User' },
    isSystemAdmin: false, isExecutive: true, canCreateProjects: true,
    projectAccess: [{ projectId: 'p1', accessLevel: 'PARTIAL', reasons: ['MANUAL_GRANT'] }]
  };
  const snapshot = {
    session, projects: [{ id: 'p1', name: 'Project' }], people: [], calendars: [],
    wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: []
  };
  let state = createInitialState(snapshot);
  assert.deepEqual(state.session, session);
  assert.equal(state.currentUser.id, '900002');
  assert.equal(state.canCreateProjects, true);
  assert.deepEqual(state.projectAccess, session.projectAccess);
  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: { projects: snapshot.projects, people: [], calendars: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [] }
  });
  assert.deepEqual(state.session, session);
  assert.equal(state.currentUser.id, '900002');
  assert.equal(state.canCreateProjects, true);
  assert.deepEqual(state.projectAccess, session.projectAccess);
});
