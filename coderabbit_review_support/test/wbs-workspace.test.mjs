import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWbsTree,
  flattenWbsTree,
  formatWbsPath,
  selectWbsDescendantIds,
  selectWbsTaskRollup
} from '../src/domain/selectors/index.js';
import {
  normalizeTaskReferences,
  validateTaskWbsMove,
  validateWbsReparent,
  validateWbsStructure
} from '../src/domain/validation/index.js';
import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import {
  appStateReducer,
  createInitialState,
  createNewTask
} from '../src/state/appState.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';
import {
  normalizeWorkspaceSelection,
  selectWorkspaceContext
} from '../src/state/selectors/workspaceSelectors.js';
import { resolveTaskCalendar } from '../src/scheduling/calendars/index.js';

const SAMPLE_WBS = [
  { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 },
  { id: 'b', projectId: 'p1', parentId: 'root', code: '1.2', name: 'B', sortOrder: 2 },
  { id: 'a', projectId: 'p1', parentId: 'root', code: '1.1', name: 'A', sortOrder: 1 },
  { id: 'a1', projectId: 'p1', parentId: 'a', code: '1.1.1', name: 'A1', sortOrder: 1 }
];

const MOCK_SNAPSHOT = await createMockRepository().loadSnapshot();
function createMockState() {
  return createInitialState(structuredClone(MOCK_SNAPSHOT));
}

test('WBS tree construction supports multiple hierarchy levels', () => {
  const tree = buildWbsTree(SAMPLE_WBS);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, 'root');
  assert.deepEqual(tree[0].children.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(tree[0].children[0].children.map((node) => node.id), ['a1']);
});

test('WBS flattening respects deterministic sibling order', () => {
  const flattened = flattenWbsTree(buildWbsTree([...SAMPLE_WBS].reverse()));
  assert.deepEqual(flattened.map(({ node, depth }) => [node.id, depth]), [
    ['root', 0],
    ['a', 1],
    ['a1', 2],
    ['b', 1]
  ]);
});

test('WBS descendants include every nested child exactly once', () => {
  assert.deepEqual(selectWbsDescendantIds(SAMPLE_WBS, 'root'), ['a', 'a1', 'b']);
  assert.deepEqual(selectWbsDescendantIds(SAMPLE_WBS, 'a'), ['a1']);
});

test('WBS path exposes the readable ancestor chain', () => {
  assert.equal(formatWbsPath(SAMPLE_WBS, 'a1'), '1 Root / 1.1 A / 1.1.1 A1');
});

test('WBS validation detects a cross-project parent', () => {
  const issues = validateWbsStructure([
    { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'P1' },
    { id: 'p2-child', projectId: 'p2', parentId: 'p1-root', code: '2.1', name: 'Wrong child' }
  ]);
  assert.equal(issues.some((item) => item.code === 'CROSS_PROJECT_WBS_PARENT'), true);
});

test('WBS validation detects cycles deterministically without recursive failure', () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'b', code: '1.1', name: 'A' },
    { id: 'b', projectId: 'p1', parentId: 'a', code: '1.2', name: 'B' }
  ];
  const issues = validateWbsStructure(cycle);
  const cycleIssue = issues.find((item) => item.code === 'WBS_CYCLE');
  assert.deepEqual(cycleIssue?.details?.nodeIds, ['a', 'b']);
  assert.doesNotThrow(() => flattenWbsTree(buildWbsTree(cycle)));
});

test('WBS validation reports missing parents explicitly', () => {
  const issues = validateWbsStructure([
    { id: 'orphan', projectId: 'p1', parentId: 'missing', code: '1.1', name: 'Orphan' }
  ]);
  assert.equal(issues[0].code, 'MISSING_WBS_PARENT');
});

test('Task WBS move validation allows same-project moves and rejects cross-project targets', () => {
  const state = createMockState();
  assert.deepEqual(validateTaskWbsMove(state.tasks, state.wbs, ['t1'], 'wbs-p-web-frontend'), []);
  const issues = validateTaskWbsMove(state.tasks, state.wbs, ['t1'], 'wbs-p-mobile-backend');
  assert.equal(issues[0].code, 'CROSS_PROJECT_TASK_WBS_MOVE');
});

test('WBS reparent validation blocks roots and descendant targets', () => {
  const state = createMockState();
  assert.equal(
    validateWbsReparent(state.wbs, 'wbs-p-web-root', 'wbs-p-web-design')[0].code,
    'WBS_ROOT_REPARENT_FORBIDDEN'
  );
  assert.equal(
    validateWbsReparent(state.wbs, 'wbs-p-web-development', 'wbs-p-web-frontend')[0].code,
    'WBS_REPARENT_TO_DESCENDANT'
  );
});

test('Task normalization never retains a WBS from another project', () => {
  const projects = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  const wbs = [
    { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'One' },
    { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Two' }
  ];
  const task = normalizeTaskReferences({ id: 't', projectId: 'p2', wbsId: 'p1-root' }, { projects, people: [], wbs });
  assert.equal(task.projectId, 'p2');
  assert.equal(task.wbsId, 'p2-root');
});

test('Changing a Task project safely reassigns the unique root WBS', () => {
  const state = createMockState();
  const original = state.tasks.find((task) => task.id === 't1');
  const next = appStateReducer(state, { type: 'task/update', id: original.id, patch: { projectId: 'p-mobile' } });
  const updated = next.tasks.find((task) => task.id === original.id);
  assert.equal(updated.projectId, 'p-mobile');
  assert.equal(updated.wbsId, 'wbs-p-mobile-root');
  assert.equal(updated.proje, 'Mobil Uygulama');
});

test('Portfolio workspace exposes all project, task and WBS data', () => {
  const state = createMockState();
  const workspace = selectWorkspaceContext(state);
  assert.equal(workspace.mode, 'portfolio');
  assert.equal(workspace.projects.length, state.projects.length);
  assert.equal(workspace.tasks.length, state.tasks.length);
  assert.equal(workspace.wbs.length, state.wbs.length);
});

test('Project workspace scopes tasks, WBS and participating people', () => {
  const state = createMockState();
  const workspace = selectWorkspaceContext({ ...state, workspaceMode: 'project', selectedProjectId: 'p-web' });
  assert.equal(workspace.mode, 'project');
  assert.equal(workspace.selectedProject?.id, 'p-web');
  assert.equal(workspace.tasks.every((task) => task.projectId === 'p-web'), true);
  assert.equal(workspace.wbs.every((node) => node.projectId === 'p-web'), true);
  assert.equal(workspace.people.length > 0, true);
});

test('Invalid selected project safely falls back to Portfolio workspace', () => {
  const state = createMockState();
  assert.deepEqual(
    normalizeWorkspaceSelection({ workspaceMode: 'project', selectedProjectId: 'missing' }, state.projects),
    { workspaceMode: 'portfolio', selectedProjectId: null }
  );
});

test('New Task in Project Workspace uses selected project, root WBS and project calendar', () => {
  const state = createMockState();
  const projectState = { ...state, workspaceMode: 'project', selectedProjectId: 'p-infra' };
  const task = createNewTask(projectState, '2026-07-21', 'new-project-task');
  const effectiveCalendar = resolveTaskCalendar(task, state.projects, state.calendars);
  assert.equal(task.projectId, 'p-infra');
  assert.equal(task.wbsId, 'wbs-p-infra-root');
  assert.equal(effectiveCalendar.id, 'cal-tr-operations-2026');
});

test('Changing Task WBS assignment leaves historical baseline snapshots unchanged', () => {
  const state = createMockState();
  const before = structuredClone(state.taskBaselineSnapshots);
  const next = appStateReducer(state, { type: 'task/update', id: 't1', patch: { wbsId: 'wbs-p-web-development' } });
  assert.equal(next.tasks.find((task) => task.id === 't1').wbsId, 'wbs-p-web-development');
  assert.deepEqual(next.taskBaselineSnapshots, before);
});

test('Controlled single Task move changes only the WBS assignment', () => {
  const state = createMockState();
  const beforeTask = state.tasks.find((task) => task.id === 't1');
  const beforeSnapshots = structuredClone(state.taskBaselineSnapshots);
  const next = appStateReducer(state, { type: 'task/move-wbs', id: 't1', wbsId: 'wbs-p-web-frontend' });
  const moved = next.tasks.find((task) => task.id === 't1');
  assert.equal(moved.wbsId, 'wbs-p-web-frontend');
  assert.deepEqual({ ...moved, wbsId: beforeTask.wbsId }, beforeTask);
  assert.deepEqual(next.taskBaselineSnapshots, beforeSnapshots);
});

test('Bulk Task move is atomic and changes only selected same-project Tasks', () => {
  const state = createMockState();
  const next = appStateReducer(state, {
    type: 'task/bulk-move-wbs',
    ids: ['t2', 't4'],
    wbsId: 'wbs-p-web-design'
  });
  assert.equal(next.tasks.find((task) => task.id === 't2').wbsId, 'wbs-p-web-design');
  assert.equal(next.tasks.find((task) => task.id === 't4').wbsId, 'wbs-p-web-design');
  assert.equal(next.tasks.find((task) => task.id === 't1').wbsId, state.tasks.find((task) => task.id === 't1').wbsId);
  assert.equal(next.wbsActionError, null);
});

test('Bulk Task move rejects mixed-project selections without partial updates', () => {
  const state = createMockState();
  const next = appStateReducer(state, {
    type: 'task/bulk-move-wbs',
    ids: ['t1', 't5'],
    wbsId: 'wbs-p-web-design'
  });
  assert.deepEqual(next.tasks, state.tasks);
  assert.equal(next.wbsActionError.code, 'CROSS_PROJECT_TASK_WBS_MOVE');
});

test('Safe WBS reparenting preserves IDs and Task assignments while rebasing subtree codes', () => {
  const state = createMockState();
  const beforeAssignments = new Map(state.tasks.map((task) => [task.id, task.wbsId]));
  const next = appStateReducer(state, {
    type: 'wbs/reparent',
    id: 'wbs-p-web-development',
    parentId: 'wbs-p-web-design'
  });
  const moved = next.wbs.find((node) => node.id === 'wbs-p-web-development');
  const frontend = next.wbs.find((node) => node.id === 'wbs-p-web-frontend');
  const cms = next.wbs.find((node) => node.id === 'wbs-p-web-cms');
  assert.equal(moved.parentId, 'wbs-p-web-design');
  assert.equal(moved.code, '1.2.1');
  assert.equal(frontend.code, '1.2.1.1');
  assert.equal(cms.code, '1.2.1.2');
  assert.deepEqual(validateWbsStructure(next.wbs), []);
  assert.deepEqual(new Map(next.tasks.map((task) => [task.id, task.wbsId])), beforeAssignments);
});

test('Unsafe WBS reparenting is rejected without changing the hierarchy', () => {
  const state = createMockState();
  const next = appStateReducer(state, {
    type: 'wbs/reparent',
    id: 'wbs-p-web-development',
    parentId: 'wbs-p-web-frontend'
  });
  assert.deepEqual(next.wbs, state.wbs);
  assert.equal(next.wbsActionError.code, 'WBS_REPARENT_TO_DESCENDANT');
});

test('WBS rollup derives descendant current-plan range, counts and progress', () => {
  const tasks = [
    { id: 't1', wbsId: 'a', plannedStart: '2026-01-10', plannedFinish: '2026-01-12', plannedDurationDays: 3, progress: 50, status: 'in_progress' },
    { id: 't2', wbsId: 'a1', plannedStart: '2026-01-05', plannedFinish: '2026-01-20', plannedDurationDays: 10, progress: 100, status: 'done' }
  ];
  const rollup = selectWbsTaskRollup(SAMPLE_WBS, tasks, 'a', { t2: { isCritical: true } });
  assert.equal(rollup.taskCount, 2);
  assert.equal(rollup.directTaskCount, 1);
  assert.equal(rollup.completedTaskCount, 1);
  assert.equal(rollup.criticalTaskCount, 1);
  assert.equal(rollup.plannedStart, '2026-01-05');
  assert.equal(rollup.plannedFinish, '2026-01-20');
  assert.equal(Number.isFinite(rollup.progress), true);
});

test('Empty WBS nodes produce safe empty rollups', () => {
  const rollup = selectWbsTaskRollup(SAMPLE_WBS, [], 'b');
  assert.deepEqual(rollup, {
    wbsId: 'b',
    taskCount: 0,
    directTaskCount: 0,
    completedTaskCount: 0,
    criticalTaskCount: 0,
    progress: 0,
    plannedStart: null,
    plannedFinish: null
  });
});

test('WBS changes do not alter existing project-scoped CPM output', () => {
  const state = createMockState();
  const before = buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars });
  const updatedState = appStateReducer(state, { type: 'task/update', id: 't1', patch: { wbsId: 'wbs-p-web-development' } });
  const after = buildPortfolioSchedule({ tasks: updatedState.tasks, projects: updatedState.projects, calendars: updatedState.calendars });
  assert.deepEqual(after.projects['p-web'], before.projects['p-web']);
});

test('Bulk Task moves and WBS reparenting remain outside CPM calculations', () => {
  const state = createMockState();
  const before = buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars });
  const movedTasks = appStateReducer(state, {
    type: 'task/bulk-move-wbs',
    ids: ['t2', 't4'],
    wbsId: 'wbs-p-web-design'
  });
  const reparented = appStateReducer(movedTasks, {
    type: 'wbs/reparent',
    id: 'wbs-p-web-development',
    parentId: 'wbs-p-web-design'
  });
  const after = buildPortfolioSchedule({ tasks: reparented.tasks, projects: reparented.projects, calendars: reparented.calendars });
  assert.deepEqual(after.projects['p-web'], before.projects['p-web']);
});

test('Intentional cross-project CPM dependency remains explicit and unchanged', () => {
  const state = createMockState();
  const schedule = buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars });
  assert.equal(schedule.projects['p-infra'].status, 'invalid');
  assert.equal(schedule.projects['p-infra'].error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.equal(schedule.projects['p-web'].status, 'valid');
});

test('Safe WBS deletion blocks nodes with children or directly assigned Tasks', () => {
  const state = createMockState();
  const withChildren = appStateReducer(state, { type: 'wbs/delete', id: 'wbs-p-web-root' });
  assert.equal(withChildren.wbs.length, state.wbs.length);
  assert.equal(withChildren.wbsActionError.code, 'WBS_HAS_CHILDREN');

  const withTasks = appStateReducer(state, { type: 'wbs/delete', id: 'wbs-p-web-design' });
  assert.equal(withTasks.wbs.length, state.wbs.length);
  assert.equal(withTasks.wbsActionError.code, 'WBS_HAS_TASKS');
});

test('Professional scheduling fields remain canonical after WBS normalization', () => {
  const state = createMockState();
  const task = state.tasks.find((item) => item.id === 't2');
  assert.equal(typeof task.plannedStart, 'string');
  assert.equal(typeof task.plannedFinish, 'string');
  assert.equal(Number.isFinite(task.plannedDurationDays), true);
  assert.equal(Object.prototype.hasOwnProperty.call(task, 'baslangicTarihi'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(task, 'bitisTarihi'), false);
});
