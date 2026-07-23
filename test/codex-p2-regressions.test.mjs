import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';
import { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createStateMutationOrchestrator, loadApplicationData } from '../src/state/persistence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_ID = '2d9f0b82-bf72-4b9d-b44e-21506f486697';
const WBS_ID = '3eaf1c93-c083-4cad-8f3f-32617f597708';
const TASK_ID = '4fb02da4-d194-4dbe-9040-4372806a8819';

test('Actual commit responses map normalized SQL UUIDs back to pending client IDs', async () => {
  const projectClientId = `project-${PROJECT_ID}`;
  const wbsClientId = `wbs-${WBS_ID}`;
  const taskClientId = `task-${TASK_ID}`;
  const originalFetch = globalThis.fetch;
  let postedChanges;

  globalThis.fetch = async (_url, init) => {
    postedChanges = JSON.parse(init.body).changes;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          projectUpserts: [{ id: PROJECT_ID, name: 'New Project', version: 'project-version' }],
          wbsUpserts: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Root', version: 'wbs-version' }],
          taskUpserts: [{
            id: TASK_ID,
            projectId: PROJECT_ID,
            wbsId: WBS_ID,
            status: 'planned',
            deps: [{ predecessorId: TASK_ID, type: 'FS' }],
            version: 'task-version'
          }],
          taskDeletes: [TASK_ID]
        };
      }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/test-api' });
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

    assert.equal(postedChanges.projectUpserts[0].id, PROJECT_ID);
    assert.equal(postedChanges.wbsUpserts[0].id, WBS_ID);
    assert.equal(postedChanges.taskUpserts[0].id, TASK_ID);
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

test('dependency persistence generates a fresh relationship row ID instead of reusing canonical predecessor IDs', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /dep\.input\('dependencyId', sql\.UniqueIdentifier, randomUUID\(\)\)/);
  assert.doesNotMatch(source, /dependencyId[^\n]*dependency\.id/);
});

test('data mode switch remains visible when the data boundary renders a load error', () => {
  const source = read('src/components/shell/ApplicationRoot.jsx');
  const indicatorIndex = source.indexOf('<DataModeIndicator />');
  const boundaryIndex = source.indexOf('<AppDataBoundary>');
  assert.ok(indicatorIndex > 0, 'DataModeIndicator must be rendered');
  assert.ok(boundaryIndex > indicatorIndex, 'DataModeIndicator must be outside and before AppDataBoundary');
});

test('persisted task updates include ProjectId so project reassignment is not silently lost', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /UPDATE dbo\.MR_Tasks\s+SET ProjectId = @projectId, WbsId = @wbsId/s);
});

test('mode switching flushes pending coalesced edits and waits for the ordered mutation queue', async () => {
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

test('project creation does not append the committed root WBS a second time', () => {
  const source = read('src/state/AppStateProvider.jsx');
  assert.match(source, /projects: mergeUpserts\(latest\.projects, \[committedProject\]\)/);
  assert.match(source, /wbs: latest\.wbs/);
  assert.doesNotMatch(source, /const committedRoot/);
  assert.doesNotMatch(source, /wbs: \[\.\.\.latest\.wbs, committedRoot\]/);
});

test('partial task visibility cannot add inactive projects to the visible project set', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(
    source,
    /SELECT DISTINCT t\.ProjectId, 'PARTIAL'\s+FROM dbo\.MR_Tasks t\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId\s+JOIN dbo\.MR_TaskAssignees ta ON ta\.TaskId = t\.TaskId\s+WHERE @isAdmin = 0 AND p\.IsActive = 1/s
  );
});

test('Actual UUID normalization still strips only local creation prefixes', () => {
  assert.equal(toActualUuid(`task-${TASK_ID}`), TASK_ID);
  assert.equal(toActualUuid(TASK_ID), TASK_ID);
});


test('existing WBS updates authorize the stored project and reject forged project reassignment', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  assert.ok(body.indexOf('const before = await wbsRowForUpdate(executor, wbsId)') < body.indexOf('assertProjectWriteAccess(actor.effective, storedProjectId)'));
  assert.match(body, /const storedProjectId = id\(before\.ProjectId\);/);
  assert.match(body, /if \(storedProjectId !== projectId\)/);
});

test('existing task updates authorize both stored source and requested destination projects', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const loadIndex = body.indexOf('const before = await taskRow(executor, taskId)');
  const sourceAuthIndex = body.indexOf('if (before) assertProjectWriteAccess(actor.effective, id(before.ProjectId))');
  const destinationAuthIndex = body.indexOf('assertProjectWriteAccess(actor.effective, projectId)');
  assert.ok(loadIndex >= 0 && loadIndex < sourceAuthIndex);
  assert.ok(sourceAuthIndex < destinationAuthIndex);
});

test('cross-project task moves clear incoming and outgoing dependency rows before changing ProjectId', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const cleanupIndex = body.indexOf('WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;');
  const updateIndex = body.indexOf('UPDATE dbo.MR_Tasks');
  assert.match(body, /const projectChanged = before && id\(before\.ProjectId\) !== projectId;/);
  assert.ok(cleanupIndex >= 0 && cleanupIndex < updateIndex);
});

test('manual FULL grants are ignored when their project is inactive', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(
    source,
    /FROM dbo\.MR_ProjectAccess pa\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = pa\.ProjectId\s+WHERE p\.IsActive = 1 AND pa\.Sicil = @sicil AND pa\.IsActive = 1 AND pa\.AccessLevel = 'FULL'/s
  );
});

test('repositories without loadSessionContext still load with a conservative default session', async () => {
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

test('Actual repository keeps client ID aliases across later snapshot loads and delete-only responses', async () => {
  const projectClientId = `project-${PROJECT_ID}`;
  const wbsClientId = `wbs-${WBS_ID}`;
  const taskClientId = `task-${TASK_ID}`;
  const originalFetch = globalThis.fetch;
  let step = 0;

  globalThis.fetch = async (url) => {
    step += 1;
    if (String(url).endsWith('/commit') && step === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            projectUpserts: [{ id: PROJECT_ID, name: 'Persistent Alias', version: 'pv' }],
            wbsUpserts: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Root', version: 'wv' }],
            taskUpserts: [{ id: TASK_ID, projectId: PROJECT_ID, wbsId: WBS_ID, status: 'planned', deps: [], version: 'tv' }]
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
            projects: [{ id: PROJECT_ID, name: 'Persistent Alias' }],
            wbs: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Root' }],
            tasks: [{ id: TASK_ID, projectId: PROJECT_ID, wbsId: WBS_ID, status: 'planned', deps: [] }]
          };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { taskDeletes: [TASK_ID] }; }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/alias-api' });
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



test('corporate project sync serializes concurrent first inserts by ProjectCode', () => {
  const source = read('src/server/repository/corporateQueries.js');
  assert.match(
    source,
    /NOT EXISTS \(\s*SELECT 1\s*FROM dbo\.MR_Projects p WITH \(UPDLOCK, HOLDLOCK\)\s*WHERE p\.SourceType = 'CORPORATE' AND p\.ProjectCode = source\.ProjectCode\s*\)/s
  );
});

test('task assignees persist only the Sicil list that passed normalization and directory validation', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /function normalizeSicils\(sicils\)/);
  assert.match(source, /const assigneeSicils = await ensurePeople\(executor, task\.assigneeIds \|\| \[\]\);/);
  assert.match(source, /for \(const sicil of assigneeSicils\)/);
  assert.doesNotMatch(source, /\(sicils \|\| \[\]\)\.filter\(Boolean\)\.map\(Number\)/);
});

test('snapshot HR09 FULL visibility applies only to corporate projects', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(
    source,
    /JOIN dbo\.MR_V_CorporateProjectAccess a ON a\.ProjectCode = p\.ProjectCode\s+WHERE @isAdmin = 0 AND p\.SourceType = 'CORPORATE' AND p\.IsActive = 1 AND a\.Sicil = @sicil/s
  );
});

test('partial snapshots return only visible-task WBS context and its ancestor chain', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /;WITH RequiredPartialWbs AS \(/);
  assert.match(source, /WHERE v\.AccessLevel = 'PARTIAL'[\s\S]*JOIN RequiredPartialWbs child ON child\.ParentWbsId = parent\.WbsId/);
  assert.match(source, /WHERE v\.AccessLevel = 'FULL'\s+OR EXISTS \(SELECT 1 FROM RequiredPartialWbs r WHERE r\.WbsId = w\.WbsId\)/s);
  assert.match(source, /OPTION \(MAXRECURSION 1000\)/);
});

test('WBS reparent validation holds update and serializable locks across the ancestry walk', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  assert.match(source, /FROM dbo\.MR_WBS WITH \(UPDLOCK, HOLDLOCK\) WHERE WbsId = @id/);
  assert.match(body, /const before = await wbsRowForUpdate\(executor, wbsId\)/);
  assert.match(body, /let parent = await wbsRowForUpdate\(executor, node\.parentId\)/);
  assert.match(body, /await wbsRowForUpdate\(executor, parent\.ParentWbsId\)/);
});

test('project updates validate LeadSicil before binding and writing it', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitProject'), source.indexOf('async function commitWbs'));
  const updateStart = body.lastIndexOf('assertProjectWriteAccess(actor.effective, projectId)');
  const validationIndex = body.indexOf("await ensurePeople(executor, project.leadId ? [project.leadId] : []);", updateStart);
  const bindIndex = body.indexOf("req.input('leadSicil', sql.Int", updateStart);
  assert.ok(updateStart >= 0 && validationIndex > updateStart && validationIndex < bindIndex);
});


test('development identity rejects partial, decimal, non-positive, blank, and unsafe Sicil strings', () => {
  assert.equal(parseDevelopmentSicil('18068'), 18068);
  assert.equal(parseDevelopmentSicil(' 18068 '), 18068);
  for (const invalid of ['18068abc', '18068.5', '0', '-1', '', '   ', '9007199254740992']) {
    assert.equal(parseDevelopmentSicil(invalid), null, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
  const providerSource = read('src/server/identity/currentUserProvider.js');
  assert.doesNotMatch(providerSource, /Number\.parseInt/);
  assert.match(providerSource, /parseDevelopmentSicil\(process\.env\.MERGEN_ROTA_DEV_SICIL\)/);
});

test('manual project codes cannot silently suppress or collide with corporate synchronization', () => {
  const sync = read('src/server/repository/corporateQueries.js');
  assert.match(sync, /FROM dbo\.MR_Projects manual WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*manual\.SourceType = 'MANUAL'/);
  assert.match(sync, /THROW 51002, 'A manual project code conflicts with the corporate project source\.'/);
  assert.match(sync, /WHERE p\.SourceType = 'CORPORATE' AND p\.ProjectCode = source\.ProjectCode/);
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /async function assertManualProjectCodeAvailable\(executor, projectCode\)/);
  assert.ok((repository.match(/await assertManualProjectCodeAvailable\(executor, projectCode\);/g) || []).length >= 2);
});

test('partial-only snapshots constrain the people directory to authorized project context', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /DECLARE @HasFullScope bit = CASE[\s\S]*AccessLevel = 'FULL'/);
  assert.match(source, /FROM dbo\.MR_V_PeopleDirectory pd\s+WHERE @HasFullScope = 1\s+OR pd\.Sicil = @sicil/s);
  assert.match(source, /WHERE p\.LeadSicil = pd\.Sicil/);
  assert.match(source, /WHERE visibleAssignee\.Sicil = pd\.Sicil[\s\S]*visibilityGate\.Sicil = @sicil/s);
});

test('corporate project view always supplies a usable ProjectName', () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  const view = source.match(/CREATE VIEW dbo\.MR_V_CorporateProjects AS([\s\S]*?)GROUP BY/i)?.[0] || '';
  assert.match(
    view,
    /COALESCE\s*\(\s*NULLIF\(LTRIM\(RTRIM\(ProjeAdi\)\)[\s\S]*NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\)[\s\S]*AS ProjectName/i
  );
});
