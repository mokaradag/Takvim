import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';
import { createInitialState, appStateReducer } from '../src/state/appState.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';

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
