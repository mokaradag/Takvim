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
  const state = createInitialState(createMockRepository());
  const original = state.tasks.find((task) => task.id === 't1');
  const next = appStateReducer(state, { type: 'task/update', id: original.id, patch: { projectId: 'p-mobile' } });
  const updated = next.tasks.find((task) => task.id === original.id);
  assert.equal(updated.projectId, 'p-mobile');
  assert.equal(updated.wbsId, 'wbs-p-mobile-root');
  assert.equal(updated.proje, 'Mobil Uygulama');
});

test('Portfolio workspace exposes all project, task and WBS data', () => {
  const state = createInitialState(createMockRepository());
  const workspace = selectWorkspaceContext(state);
  assert.equal(workspace.mode, 'portfolio');
  assert.equal(workspace.projects.length, state.projects.length);
  assert.equal(workspace.tasks.length, state.tasks.length);
  assert.equal(workspace.wbs.length, state.wbs.length);
});

test('Project workspace scopes tasks, WBS and participating people', () => {
  const state = createInitialState(createMockRepository());
  const workspace = selectWorkspaceContext({ ...state, workspaceMode: 'project', selectedProjectId: 'p-web' });
  assert.equal(workspace.mode, 'project');
  assert.equal(workspace.selectedProject?.id, 'p-web');
  assert.equal(workspace.tasks.every((task) => task.projectId === 'p-web'), true);
  assert.equal(workspace.wbs.every((node) => node.projectId === 'p-web'), true);
  assert.equal(workspace.people.length > 0, true);
});

test('Invalid selected project safely falls back to Portfolio workspace', () => {
  const state = createInitialState(createMockRepository());
  assert.deepEqual(
    normalizeWorkspaceSelection({ workspaceMode: 'project', selectedProjectId: 'missing' }, state.projects),
    { workspaceMode: 'portfolio', selectedProjectId: null }
  );
});

test('New Task in Project Workspace uses selected project, root WBS and project calendar', () => {
  const state = createInitialState(createMockRepository());
  const projectState = { ...state, workspaceMode: 'project', selectedProjectId: 'p-infra' };
  const task = createNewTask(projectState, '2026-07-21', 'new-project-task');
  const effectiveCalendar = resolveTaskCalendar(task, state.projects, state.calendars);
  assert.equal(task.projectId, 'p-infra');
  assert.equal(task.wbsId, 'wbs-p-infra-root');
  assert.equal(effectiveCalendar.id, 'cal-tr-operations-2026');
});

test('Changing Task WBS assignment leaves historical baseline snapshots unchanged', () => {
  const state = createInitialState(createMockRepository());
  const before = structuredClone(state.taskBaselineSnapshots);
  const next = appStateReducer(state, { type: 'task/update', id: 't1', patch: { wbsId: 'wbs-p-web-development' } });
  assert.equal(next.tasks.find((task) => task.id === 't1').wbsId, 'wbs-p-web-development');
  assert.deepEqual(next.taskBaselineSnapshots, before);
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
  const state = createInitialState(createMockRepository());
  const before = buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars });
  const updatedState = appStateReducer(state, { type: 'task/update', id: 't1', patch: { wbsId: 'wbs-p-web-development' } });
  const after = buildPortfolioSchedule({ tasks: updatedState.tasks, projects: updatedState.projects, calendars: updatedState.calendars });
  assert.deepEqual(after.projects['p-web'], before.projects['p-web']);
});

test('Intentional cross-project CPM dependency remains explicit and unchanged', () => {
  const state = createInitialState(createMockRepository());
  const schedule = buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars });
  assert.equal(schedule.projects['p-infra'].status, 'invalid');
  assert.equal(schedule.projects['p-infra'].error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.equal(schedule.projects['p-web'].status, 'valid');
});

test('Safe WBS deletion blocks nodes with children or directly assigned Tasks', () => {
  const state = createInitialState(createMockRepository());
  const withChildren = appStateReducer(state, { type: 'wbs/delete', id: 'wbs-p-web-root' });
  assert.equal(withChildren.wbs.length, state.wbs.length);
  assert.equal(withChildren.wbsActionError.code, 'WBS_HAS_CHILDREN');

  const withTasks = appStateReducer(state, { type: 'wbs/delete', id: 'wbs-p-web-design' });
  assert.equal(withTasks.wbs.length, state.wbs.length);
  assert.equal(withTasks.wbsActionError.code, 'WBS_HAS_TASKS');
});

test('Professional scheduling fields remain canonical after WBS normalization', () => {
  const state = createInitialState(createMockRepository());
  const task = state.tasks.find((item) => item.id === 't2');
  assert.equal(typeof task.plannedStart, 'string');
  assert.equal(typeof task.plannedFinish, 'string');
  assert.equal(Number.isFinite(task.plannedDurationDays), true);
  assert.equal(Object.prototype.hasOwnProperty.call(task, 'baslangicTarihi'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(task, 'bitisTarihi'), false);
});
