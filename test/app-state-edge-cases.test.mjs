import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appStateReducer,
  createInitialState,
  createLoadingState,
  createNewTask,
  normalizeStateTask
} from '../src/state/appState.js';

function snapshot() {
  return {
    calendars: [{
      id: 'cal',
      name: 'Weekdays',
      timezone: 'Europe/Istanbul',
      workingDays: [1, 2, 3, 4, 5],
      holidays: []
    }],
    projects: [
      { id: 'p1', name: 'One', color: 'blue', calendarId: 'cal', dataDate: '2026-07-22', leadId: 'u1' },
      { id: 'p2', name: 'Two', color: 'green', calendarId: 'cal', dataDate: '2026-07-22', leadId: 'u2' }
    ],
    people: [
      { id: 'u1', name: 'Ayşe', role: 'Lead', team: 'A', color: 'blue' },
      { id: 'u2', name: 'Bora', role: 'Dev', team: 'B', color: 'green' }
    ],
    wbs: [
      { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'One', sortOrder: 1 },
      { id: 'p1-a', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'A', sortOrder: 1 },
      { id: 'p1-a1', projectId: 'p1', parentId: 'p1-a', code: '1.1.1', name: 'A1', sortOrder: 1 },
      { id: 'p1-b', projectId: 'p1', parentId: 'p1-root', code: '1.2', name: 'B', sortOrder: 2 },
      { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Two', sortOrder: 1 }
    ],
    tasks: [
      {
        id: 't1', projectId: 'p1', wbsId: 'p1-a1', task: 'Task One', status: 'todo',
        assigneeIds: ['u1'], sorumlu: ['Ayşe'], plannedStart: '2026-07-20', plannedFinish: '2026-07-24',
        targetFinish: '2026-07-27', deps: []
      },
      {
        id: 't2', projectId: 'p2', wbsId: 'p2-root', task: 'Task Two', status: 'in_progress',
        assigneeIds: ['u2'], sorumlu: ['Bora'], plannedStart: '2026-07-20', plannedFinish: '2026-07-21',
        targetFinish: '2026-07-22', deps: []
      }
    ],
    baselines: [{ id: 'b1', projectId: 'p1', name: 'Base', createdAt: '2026-07-01', isPrimary: true }],
    taskBaselineSnapshots: [{
      baselineId: 'b1', taskId: 't1', plannedStart: '2026-07-20', plannedFinish: '2026-07-24',
      plannedDurationDays: 5, calendarId: 'cal'
    }]
  };
}

function state() {
  return createInitialState(snapshot());
}

test('loading state starts with empty canonical collections', () => {
  const result = createLoadingState();
  for (const key of ['calendars', 'projects', 'people', 'wbs', 'tasks', 'baselines', 'taskBaselineSnapshots']) {
    assert.deepEqual(result[key], []);
  }
});

test('loading state starts in portfolio mode with no selection', () => {
  const result = createLoadingState();
  assert.equal(result.workspaceMode, 'portfolio');
  assert.equal(result.selectedProjectId, null);
  assert.equal(result.selectedTaskId, null);
});

test('loading state initializes persistence and load status fields', () => {
  const result = createLoadingState();
  assert.equal(result.dataStatus, 'loading');
  assert.equal(result.loadError, null);
  assert.equal(result.pendingMutationCount, 0);
  assert.equal(result.saveError, null);
  assert.equal(result.lastSavedAt, null);
});

test('initial state marks loaded snapshots ready', () => {
  const result = state();
  assert.equal(result.dataStatus, 'ready');
  assert.equal(result.loadError, null);
  assert.equal(result.tasks.length, 2);
});

test('initial state safely accepts an empty snapshot', () => {
  const result = createInitialState();
  assert.equal(result.dataStatus, 'ready');
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.projects, []);
});

test('initial state normalizes task schedule duration', () => {
  const result = state();
  assert.equal(result.tasks.find((task) => task.id === 't1').plannedDurationDays, 5);
});

test('normalizeStateTask re-resolves legacy project and assignee display fields', () => {
  const result = normalizeStateTask({
    id: 'legacy', proje: 'Two', sorumlu: ['Ayşe'], task: 'Legacy', plannedStart: '2026-07-20', plannedFinish: '2026-07-20'
  }, state());
  assert.equal(result.projectId, 'p2');
  assert.equal(result.wbsId, 'p2-root');
  assert.deepEqual(result.assigneeIds, ['u1']);
});

test('data/load-start keeps data but clears a previous load error', () => {
  const current = { ...state(), dataStatus: 'error', loadError: new Error('old') };
  const next = appStateReducer(current, { type: 'data/load-start' });
  assert.equal(next.dataStatus, 'loading');
  assert.equal(next.loadError, null);
  assert.deepEqual(next.tasks, current.tasks);
});

test('data/load-error records the supplied error', () => {
  const error = new Error('load failed');
  const next = appStateReducer(state(), { type: 'data/load-error', error });
  assert.equal(next.dataStatus, 'error');
  assert.strictEqual(next.loadError, error);
});

test('data/load-success replaces canonical collections and clears load errors', () => {
  const current = { ...state(), dataStatus: 'error', loadError: new Error('old') };
  const replacement = snapshot();
  replacement.tasks = [replacement.tasks[1]];
  const next = appStateReducer(current, { type: 'data/load-success', snapshot: replacement });
  assert.equal(next.dataStatus, 'ready');
  assert.equal(next.loadError, null);
  assert.deepEqual(next.tasks.map((task) => task.id), ['t2']);
});

test('data/load-success preserves a valid selected task', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'data/load-success', snapshot: snapshot() });
  assert.equal(next.selectedTaskId, 't1');
});

test('data/load-success clears a selected task missing from the replacement snapshot', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const replacement = snapshot();
  replacement.tasks = replacement.tasks.filter((task) => task.id !== 't1');
  const next = appStateReducer(current, { type: 'data/load-success', snapshot: replacement });
  assert.equal(next.selectedTaskId, null);
});

test('data/load-success preserves pending mutation count and last save time', () => {
  const current = { ...state(), pendingMutationCount: 2, lastSavedAt: '2026-07-22T10:00:00Z' };
  const next = appStateReducer(current, { type: 'data/load-success', snapshot: snapshot() });
  assert.equal(next.pendingMutationCount, 2);
  assert.equal(next.lastSavedAt, '2026-07-22T10:00:00Z');
});

test('persistence/start increments pending mutations', () => {
  const next = appStateReducer({ ...state(), pendingMutationCount: 2 }, { type: 'persistence/start' });
  assert.equal(next.pendingMutationCount, 3);
});

test('persistence/failure decrements pending mutations and stores the error', () => {
  const error = { code: 'MUTATION_FAILED' };
  const next = appStateReducer({ ...state(), pendingMutationCount: 2 }, { type: 'persistence/failure', error });
  assert.equal(next.pendingMutationCount, 1);
  assert.strictEqual(next.saveError, error);
});

test('persistence/failure never decrements pending mutations below zero', () => {
  const next = appStateReducer(state(), { type: 'persistence/failure', error: { code: 'x' } });
  assert.equal(next.pendingMutationCount, 0);
});

test('persistence/clear-error clears only the save error', () => {
  const current = { ...state(), saveError: { code: 'x' }, pendingMutationCount: 2 };
  const next = appStateReducer(current, { type: 'persistence/clear-error' });
  assert.equal(next.saveError, null);
  assert.equal(next.pendingMutationCount, 2);
});

test('persistence/success updates lastSavedAt and decrements pending mutations', () => {
  const next = appStateReducer({ ...state(), pendingMutationCount: 1 }, {
    type: 'persistence/success', changes: {}, savedAt: '2026-07-22T12:00:00Z'
  });
  assert.equal(next.pendingMutationCount, 0);
  assert.equal(next.lastSavedAt, '2026-07-22T12:00:00Z');
});

test('persistence/success preserves lastSavedAt when no new timestamp is supplied', () => {
  const next = appStateReducer({ ...state(), lastSavedAt: 'old' }, { type: 'persistence/success', changes: {} });
  assert.equal(next.lastSavedAt, 'old');
});

test('persistence/success updates and normalizes existing tasks', () => {
  const next = appStateReducer(state(), {
    type: 'persistence/success',
    changes: { taskUpserts: [{ ...snapshot().tasks[0], sorumlu: ['Bora'], assigneeIds: [], plannedFinish: '2026-07-27' }] }
  });
  const task = next.tasks.find((item) => item.id === 't1');
  assert.deepEqual(task.assigneeIds, ['u2']);
  assert.equal(task.plannedDurationDays, 6);
});

test('persistence/success prepends newly committed tasks', () => {
  const newTask = {
    id: 't3', projectId: 'p1', wbsId: 'p1-root', task: 'New', status: 'todo',
    plannedStart: '2026-07-20', plannedFinish: '2026-07-20', deps: []
  };
  const next = appStateReducer(state(), { type: 'persistence/success', changes: { taskUpserts: [newTask] } });
  assert.equal(next.tasks[0].id, 't3');
});

test('persistence/success applies task deletions', () => {
  const next = appStateReducer(state(), { type: 'persistence/success', changes: { taskDeletes: ['t1'] } });
  assert.equal(next.tasks.some((task) => task.id === 't1'), false);
});

test('persistence/success applies WBS upserts', () => {
  const node = { id: 'p1-new', projectId: 'p1', parentId: 'p1-root', code: '1.3', name: 'New', sortOrder: 3 };
  const next = appStateReducer(state(), { type: 'persistence/success', changes: { wbsUpserts: [node] } });
  assert.deepEqual(next.wbs.find((item) => item.id === 'p1-new'), node);
});

test('persistence/success applies WBS deletions', () => {
  const next = appStateReducer(state(), { type: 'persistence/success', changes: { wbsDeletes: ['p1-b'] } });
  assert.equal(next.wbs.some((node) => node.id === 'p1-b'), false);
});

test('persistence/success can explicitly clear a WBS action error', () => {
  const current = { ...state(), wbsActionError: { code: 'WBS_HAS_TASKS' } };
  const next = appStateReducer(current, { type: 'persistence/success', changes: {}, clearWbsError: true });
  assert.equal(next.wbsActionError, null);
});

test('persistence/success preserves a WBS action error unless asked to clear it', () => {
  const error = { code: 'WBS_HAS_TASKS' };
  const current = { ...state(), wbsActionError: error };
  const next = appStateReducer(current, { type: 'persistence/success', changes: {} });
  assert.strictEqual(next.wbsActionError, error);
});

test('task/add prepends and selects the new task', () => {
  const task = { id: 'new' };
  const next = appStateReducer(state(), { type: 'task/add', task });
  assert.strictEqual(next.tasks[0], task);
  assert.equal(next.selectedTaskId, 'new');
});

test('task/update ignores unknown task IDs without changing task records', () => {
  const current = state();
  const next = appStateReducer(current, { type: 'task/update', id: 'missing', patch: { status: 'done' } });
  assert.deepEqual(next.tasks, current.tasks);
});

test('task/update rebuilds assignee IDs when legacy assignee names change', () => {
  const next = appStateReducer(state(), { type: 'task/update', id: 't1', patch: { sorumlu: ['Bora'] } });
  const task = next.tasks.find((item) => item.id === 't1');
  assert.deepEqual(task.assigneeIds, ['u2']);
  assert.deepEqual(task.sorumlu, ['Bora']);
});

test('task/update reassigns project and default WBS when legacy project name changes', () => {
  const next = appStateReducer(state(), { type: 'task/update', id: 't1', patch: { proje: 'Two' } });
  const task = next.tasks.find((item) => item.id === 't1');
  assert.equal(task.projectId, 'p2');
  assert.equal(task.wbsId, 'p2-root');
});

test('task/update replaces an invalid old WBS after canonical projectId changes', () => {
  const next = appStateReducer(state(), { type: 'task/update', id: 't1', patch: { projectId: 'p2' } });
  const task = next.tasks.find((item) => item.id === 't1');
  assert.equal(task.projectId, 'p2');
  assert.equal(task.wbsId, 'p2-root');
});

test('task/update clears selected task when it moves outside the active project workspace', () => {
  const current = { ...state(), workspaceMode: 'project', selectedProjectId: 'p1', selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'task/update', id: 't1', patch: { projectId: 'p2' } });
  assert.equal(next.selectedTaskId, null);
});

test('task/update keeps selected task in portfolio mode when its project changes', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'task/update', id: 't1', patch: { projectId: 'p2' } });
  assert.equal(next.selectedTaskId, 't1');
});

test('task/delete clears selection when deleting the selected task', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'task/delete', id: 't1' });
  assert.equal(next.selectedTaskId, null);
  assert.equal(next.tasks.some((task) => task.id === 't1'), false);
});

test('task/delete keeps selection when deleting another task', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'task/delete', id: 't2' });
  assert.equal(next.selectedTaskId, 't1');
});

test('task/select accepts an ID and clears on a falsy ID', () => {
  const selected = appStateReducer(state(), { type: 'task/select', id: 't1' });
  assert.equal(selected.selectedTaskId, 't1');
  assert.equal(appStateReducer(selected, { type: 'task/select', id: '' }).selectedTaskId, null);
});

test('workspace/select enters a valid project workspace', () => {
  const next = appStateReducer(state(), { type: 'workspace/select', workspaceMode: 'project', selectedProjectId: 'p1' });
  assert.equal(next.workspaceMode, 'project');
  assert.equal(next.selectedProjectId, 'p1');
});

test('workspace/select falls back to portfolio for an invalid project', () => {
  const next = appStateReducer(state(), { type: 'workspace/select', workspaceMode: 'project', selectedProjectId: 'missing' });
  assert.equal(next.workspaceMode, 'portfolio');
  assert.equal(next.selectedProjectId, null);
});

test('workspace/select infers project mode from a valid selectedProjectId', () => {
  const next = appStateReducer(state(), { type: 'workspace/select', selectedProjectId: 'p2' });
  assert.equal(next.workspaceMode, 'project');
  assert.equal(next.selectedProjectId, 'p2');
});

test('workspace/select clears a selected task outside the selected project', () => {
  const current = { ...state(), selectedTaskId: 't1' };
  const next = appStateReducer(current, { type: 'workspace/select', workspaceMode: 'project', selectedProjectId: 'p2' });
  assert.equal(next.selectedTaskId, null);
});

test('workspace/restore shares workspace normalization behavior', () => {
  const next = appStateReducer(state(), { type: 'workspace/restore', workspaceMode: 'project', selectedProjectId: 'p2' });
  assert.equal(next.workspaceMode, 'project');
  assert.equal(next.selectedProjectId, 'p2');
});

test('task/move-wbs reports a missing task without mutating tasks', () => {
  const current = state();
  const next = appStateReducer(current, { type: 'task/move-wbs', id: 'missing', wbsId: 'p1-root' });
  assert.deepEqual(next.tasks, current.tasks);
  assert.equal(next.wbsActionError.code, 'TASK_NOT_FOUND');
});

test('task/bulk-move-wbs rejects an empty selection', () => {
  const next = appStateReducer(state(), { type: 'task/bulk-move-wbs', ids: [], wbsId: 'p1-root' });
  assert.equal(next.wbsActionError.code, 'TASK_MOVE_SELECTION_EMPTY');
});

test('successful task WBS movement clears an earlier WBS action error', () => {
  const current = { ...state(), wbsActionError: { code: 'old' } };
  const next = appStateReducer(current, { type: 'task/move-wbs', id: 't1', wbsId: 'p1-b' });
  assert.equal(next.tasks.find((task) => task.id === 't1').wbsId, 'p1-b');
  assert.equal(next.wbsActionError, null);
});

test('wbs/add-child rejects a missing parent with a localized message', () => {
  const next = appStateReducer(state(), { type: 'wbs/add-child', parentId: 'missing', id: 'x', name: 'X' });
  assert.equal(next.wbsActionError.code, 'WBS_PARENT_NOT_FOUND');
  assert.match(next.wbsActionError.message, /bulunamadı/);
});

test('wbs/add-child rejects a blank name', () => {
  const next = appStateReducer(state(), { type: 'wbs/add-child', parentId: 'p1-root', id: 'x', name: '   ' });
  assert.equal(next.wbsActionError.code, 'WBS_NAME_REQUIRED');
});

test('wbs/add-child trims names and derives the next sibling code and order', () => {
  const next = appStateReducer(state(), { type: 'wbs/add-child', parentId: 'p1-root', id: 'p1-c', name: '  C  ' });
  const node = next.wbs.find((item) => item.id === 'p1-c');
  assert.equal(node.name, 'C');
  assert.equal(node.code, '1.3');
  assert.equal(node.sortOrder, 3);
});

test('wbs/add-child preserves explicit code and finite sort order', () => {
  const next = appStateReducer(state(), {
    type: 'wbs/add-child', parentId: 'p1-root', id: 'p1-x', name: 'X', code: '1.99', sortOrder: 42
  });
  const node = next.wbs.find((item) => item.id === 'p1-x');
  assert.equal(node.code, '1.99');
  assert.equal(node.sortOrder, 42);
});

test('wbs/add-child rejects duplicate IDs without changing the hierarchy', () => {
  const current = state();
  const next = appStateReducer(current, { type: 'wbs/add-child', parentId: 'p1-root', id: 'p1-a', name: 'Duplicate' });
  assert.deepEqual(next.wbs, current.wbs);
  assert.equal(next.wbsActionError.code, 'DUPLICATE_WBS_ID');
});

test('wbs/rename rejects a blank name', () => {
  const next = appStateReducer(state(), { type: 'wbs/rename', id: 'p1-a', name: '\t' });
  assert.equal(next.wbsActionError.code, 'WBS_NAME_REQUIRED');
});

test('wbs/rename trims and updates the target node only', () => {
  const current = state();
  const next = appStateReducer(current, { type: 'wbs/rename', id: 'p1-a', name: '  Renamed  ' });
  assert.equal(next.wbs.find((node) => node.id === 'p1-a').name, 'Renamed');
  assert.equal(next.wbs.find((node) => node.id === 'p1-b').name, current.wbs.find((node) => node.id === 'p1-b').name);
});

test('wbs/reparent to the existing parent is a safe no-op that clears WBS errors', () => {
  const current = { ...state(), wbsActionError: { code: 'old' } };
  const next = appStateReducer(current, { type: 'wbs/reparent', id: 'p1-a', parentId: 'p1-root' });
  assert.deepEqual(next.wbs, current.wbs);
  assert.equal(next.wbsActionError, null);
});

test('wbs/reparent reports a missing source node', () => {
  const next = appStateReducer(state(), { type: 'wbs/reparent', id: 'missing', parentId: 'p1-root' });
  assert.equal(next.wbsActionError.code, 'WBS_NODE_NOT_FOUND');
});

test('wbs/delete rejects a node with children', () => {
  const next = appStateReducer(state(), { type: 'wbs/delete', id: 'p1-a' });
  assert.equal(next.wbsActionError.code, 'WBS_HAS_CHILDREN');
});

test('wbs/delete rejects a node with directly assigned tasks', () => {
  const next = appStateReducer(state(), { type: 'wbs/delete', id: 'p1-a1' });
  assert.equal(next.wbsActionError.code, 'WBS_HAS_TASKS');
});

test('wbs/delete removes an unused leaf', () => {
  const next = appStateReducer(state(), { type: 'wbs/delete', id: 'p1-b' });
  assert.equal(next.wbs.some((node) => node.id === 'p1-b'), false);
  assert.equal(next.wbsActionError, null);
});

test('wbs/clear-error clears WBS action errors', () => {
  const next = appStateReducer({ ...state(), wbsActionError: { code: 'x' } }, { type: 'wbs/clear-error' });
  assert.equal(next.wbsActionError, null);
});

test('unknown reducer actions return the same state object', () => {
  const current = state();
  assert.strictEqual(appStateReducer(current, { type: 'unknown' }), current);
});

test('createNewTask uses the first project in portfolio mode', () => {
  const task = createNewTask(state(), '2026-07-22', 'new');
  assert.equal(task.projectId, 'p1');
  assert.equal(task.wbsId, 'p1-root');
  assert.equal(task.proje, 'One');
});

test('createNewTask uses the selected project in project mode', () => {
  const current = { ...state(), workspaceMode: 'project', selectedProjectId: 'p2' };
  const task = createNewTask(current, '2026-07-22', 'new');
  assert.equal(task.projectId, 'p2');
  assert.equal(task.wbsId, 'p2-root');
  assert.equal(task.color, 'green');
});

test('createNewTask falls back to the first project when selected project is invalid', () => {
  const current = { ...state(), workspaceMode: 'project', selectedProjectId: 'missing' };
  const task = createNewTask(current, '2026-07-22', 'new');
  assert.equal(task.projectId, 'p1');
});

test('createNewTask assigns the first person by default', () => {
  const task = createNewTask(state(), '2026-07-22', 'new');
  assert.deepEqual(task.assigneeIds, ['u1']);
  assert.deepEqual(task.sorumlu, ['Ayşe']);
});

test('createNewTask moves a weekend reference date to the next working day', () => {
  const task = createNewTask(state(), '2026-07-25', 'new');
  assert.equal(task.plannedStart, '2026-07-27');
});

test('createNewTask leaves tag and remaining duration empty until explicitly supplied', () => {
  const task = createNewTask(state(), '2026-07-22', 'new');
  assert.equal(task.keyword, '');
  assert.equal(task.remainingDurationDays, null);
});

test('createNewTask safely works without projects or people', () => {
  const current = createInitialState({ calendars: [], projects: [], people: [], wbs: [], tasks: [] });
  const task = createNewTask(current, '2026-07-22', 'new');
  assert.equal(task.projectId, null);
  assert.equal(task.wbsId, null);
  assert.deepEqual(task.assigneeIds, []);
  assert.equal(task.color, 'blue');
});
