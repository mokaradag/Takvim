import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWbsTree,
  compareWbsNodes,
  flattenWbsTree,
  formatWbsPath,
  selectDefaultProjectWbs,
  selectPersonById,
  selectProjectById,
  selectProjectWbs,
  selectTaskById,
  selectTasksByPerson,
  selectTasksByProject,
  selectTasksForWbs,
  selectWbsAncestors,
  selectWbsChildren,
  selectWbsDescendantIds,
  selectWbsPath,
  selectWbsRoots,
  selectWbsTaskRollup
} from '../src/domain/selectors/index.js';
import {
  WORKSPACE_MODE_PORTFOLIO,
  WORKSPACE_MODE_PROJECT,
  normalizeWorkspaceSelection,
  selectSelectedProject,
  selectWorkspaceContext,
  selectWorkspacePeople,
  selectWorkspaceProjects,
  selectWorkspaceTasks,
  selectWorkspaceWbs
} from '../src/state/selectors/workspaceSelectors.js';

const wbs = [
  { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 },
  { id: 'p1-10', projectId: 'p1', parentId: 'p1-root', code: '1.10', name: 'Ten', sortOrder: 10 },
  { id: 'p1-2', projectId: 'p1', parentId: 'p1-root', code: '1.2', name: 'Two', sortOrder: 2 },
  { id: 'p1-2-a', projectId: 'p1', parentId: 'p1-2', code: '1.2.1', name: 'Leaf', sortOrder: 1 },
  { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Other', sortOrder: 1 }
];

const projects = [
  { id: 'p1', name: 'Project One', leadId: 'u3' },
  { id: 'p2', name: 'Project Two', leadId: 'u4' }
];
const people = [
  { id: 'u1', name: 'One' },
  { id: 'u2', name: 'Two' },
  { id: 'u3', name: 'Lead One' },
  { id: 'u4', name: 'Lead Two' },
  { id: 'u5', name: 'Unrelated' }
];
const tasks = [
  { id: 't1', projectId: 'p1', wbsId: 'p1-2', assigneeIds: ['u1'] },
  { id: 't2', projectId: 'p1', wbsId: 'p1-2-a', assigneeIds: ['u2', 'u1'] },
  { id: 't3', projectId: 'p2', wbsId: 'p2-root', assigneeIds: ['u4'] }
];

function state(overrides = {}) {
  return {
    workspaceMode: 'portfolio',
    selectedProjectId: null,
    projects,
    people,
    tasks,
    wbs,
    ...overrides
  };
}

test('compareWbsNodes prioritizes explicit sortOrder', () => {
  assert.equal(compareWbsNodes({ sortOrder: 1, code: '9' }, { sortOrder: 2, code: '1' }) < 0, true);
});

test('compareWbsNodes uses numeric code ordering when sortOrder is absent', () => {
  assert.equal(compareWbsNodes({ code: '1.2' }, { code: '1.10' }) < 0, true);
});

test('compareWbsNodes uses name then ID as deterministic tie breakers', () => {
  assert.equal(compareWbsNodes({ code: '1', name: 'Alpha', id: 'z' }, { code: '1', name: 'Beta', id: 'a' }) < 0, true);
  assert.equal(compareWbsNodes({ code: '1', name: 'Same', id: 'a' }, { code: '1', name: 'Same', id: 'b' }) < 0, true);
});

test('selectProjectWbs returns an empty list when projectId is missing', () => {
  assert.deepEqual(selectProjectWbs(wbs, null), []);
});

test('selectProjectWbs keeps parents before descendants and sibling order without mutating the source array', () => {
  const reversed = [...wbs].reverse();
  const before = reversed.map((node) => node.id);
  const result = selectProjectWbs(reversed, 'p1');
  assert.deepEqual(result.map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a', 'p1-10']);
  assert.deepEqual(reversed.map((node) => node.id), before);
});

test('selectWbsRoots treats null-parent nodes as roots', () => {
  assert.deepEqual(selectWbsRoots(wbs).map((node) => node.id), ['p1-root', 'p2-root']);
});

test('selectWbsRoots exposes orphaned nodes instead of hiding them', () => {
  const nodes = [{ id: 'orphan', projectId: 'p1', parentId: 'missing', code: '1.1', name: 'Orphan' }];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['orphan']);
});

test('selectWbsRoots exposes cross-project parent links as roots', () => {
  const nodes = [
    { id: 'a', projectId: 'p1', parentId: null },
    { id: 'b', projectId: 'p2', parentId: 'a' }
  ];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['a', 'b']);
});

test('selectWbsRoots treats self-parented nodes as roots', () => {
  const nodes = [{ id: 'a', projectId: 'p1', parentId: 'a' }];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['a']);
});

test('selectDefaultProjectWbs returns the only natural root', () => {
  assert.equal(selectDefaultProjectWbs(wbs, 'p1')?.id, 'p1-root');
});

test('selectDefaultProjectWbs returns null when there are multiple natural roots', () => {
  const nodes = [...wbs, { id: 'p1-root-2', projectId: 'p1', parentId: null, code: '9', name: 'Second' }];
  assert.equal(selectDefaultProjectWbs(nodes, 'p1'), null);
});

test('selectWbsChildren returns sorted direct children only', () => {
  assert.deepEqual(selectWbsChildren([...wbs].reverse(), 'p1-root').map((node) => node.id), ['p1-2', 'p1-10']);
});

test('selectWbsDescendantIds traverses depth-first in deterministic sibling order', () => {
  assert.deepEqual(selectWbsDescendantIds(wbs, 'p1-root'), ['p1-2', 'p1-2-a', 'p1-10']);
});

test('selectWbsDescendantIds is cycle-safe and never returns the starting node', () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'c', sortOrder: 1 },
    { id: 'b', projectId: 'p1', parentId: 'a', sortOrder: 1 },
    { id: 'c', projectId: 'p1', parentId: 'b', sortOrder: 1 }
  ];
  assert.deepEqual(selectWbsDescendantIds(cycle, 'a'), ['b', 'c']);
});

test('selectWbsDescendantIds returns empty for unknown nodes', () => {
  assert.deepEqual(selectWbsDescendantIds(wbs, 'missing'), []);
});

test('selectWbsAncestors returns root-to-parent order', () => {
  assert.deepEqual(selectWbsAncestors(wbs, 'p1-2-a').map((node) => node.id), ['p1-root', 'p1-2']);
});

test('selectWbsAncestors stops at cross-project parent boundaries', () => {
  const nodes = [
    { id: 'foreign', projectId: 'p2', parentId: null },
    { id: 'child', projectId: 'p1', parentId: 'foreign' }
  ];
  assert.deepEqual(selectWbsAncestors(nodes, 'child'), []);
});

test('selectWbsAncestors terminates cycles without duplicate ancestors', () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'c' },
    { id: 'b', projectId: 'p1', parentId: 'a' },
    { id: 'c', projectId: 'p1', parentId: 'b' }
  ];
  assert.deepEqual(selectWbsAncestors(cycle, 'a').map((node) => node.id), ['b', 'c']);
});

test('selectWbsPath includes ancestors and the requested node', () => {
  assert.deepEqual(selectWbsPath(wbs, 'p1-2-a').map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a']);
});

test('selectWbsPath and formatWbsPath are empty for missing nodes', () => {
  assert.deepEqual(selectWbsPath(wbs, 'missing'), []);
  assert.equal(formatWbsPath(wbs, 'missing'), '');
});

test('formatWbsPath trims missing code or name parts safely', () => {
  const nodes = [
    { id: 'root', projectId: 'p1', parentId: null, code: '', name: 'Root' },
    { id: 'child', projectId: 'p1', parentId: 'root', code: '1', name: '' }
  ];
  assert.equal(formatWbsPath(nodes, 'child'), 'Root / 1');
});

test('buildWbsTree preserves orphan nodes as top-level roots', () => {
  const tree = buildWbsTree([{ id: 'orphan', projectId: 'p1', parentId: 'missing', code: '1' }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, 'orphan');
});

test('buildWbsTree ignores duplicate IDs after the first canonical node', () => {
  const tree = buildWbsTree([
    { id: 'same', projectId: 'p1', parentId: null, code: '1', name: 'First', sortOrder: 1 },
    { id: 'same', projectId: 'p1', parentId: null, code: '2', name: 'Second', sortOrder: 2 }
  ]);
  assert.equal(flattenWbsTree(tree).length, 1);
  assert.equal(flattenWbsTree(tree)[0].node.name, 'First');
});

test('buildWbsTree keeps cyclic components visible and finite', () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'b', code: '1' },
    { id: 'b', projectId: 'p1', parentId: 'a', code: '2' }
  ];
  const flattened = flattenWbsTree(buildWbsTree(cycle));
  assert.equal(flattened.length, 2);
  assert.deepEqual(new Set(flattened.map((row) => row.node.id)), new Set(['a', 'b']));
});

test('buildWbsTree does not mutate source nodes with children properties', () => {
  const input = wbs.map((node) => ({ ...node }));
  buildWbsTree(input);
  assert.equal(input.some((node) => Object.hasOwn(node, 'children')), false);
});

test('flattenWbsTree visits duplicate references only once', () => {
  const shared = { id: 'shared', children: [] };
  const tree = [
    { id: 'a', children: [shared] },
    { id: 'b', children: [shared] }
  ];
  assert.deepEqual(flattenWbsTree(tree).map((row) => row.node.id), ['a', 'shared', 'b']);
});

test('flattenWbsTree records depth for nested nodes', () => {
  const rows = flattenWbsTree(buildWbsTree(wbs));
  const leaf = rows.find((row) => row.node.id === 'p1-2-a');
  assert.equal(leaf.depth, 2);
});

test('selectTasksForWbs returns only direct tasks by default', () => {
  assert.deepEqual(selectTasksForWbs(tasks, wbs, 'p1-2').map((task) => task.id), ['t1']);
});

test('selectTasksForWbs optionally includes descendant assignments', () => {
  assert.deepEqual(selectTasksForWbs(tasks, wbs, 'p1-2', { includeDescendants: true }).map((task) => task.id), ['t1', 't2']);
});

test('WBS rollup clamps progress to zero through one hundred before weighting', () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'low', wbsId: 'p1-2', plannedDurationDays: 1, progress: -20 },
    { id: 'high', wbsId: 'p1-2-a', plannedDurationDays: 1, progress: 140 }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test('WBS rollup uses done status as one hundred percent when progress is absent', () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'done', wbsId: 'p1-2', plannedDurationDays: 1, status: 'done' },
    { id: 'todo', wbsId: 'p1-2-a', plannedDurationDays: 1, status: 'todo' }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test('WBS rollup gives missing and non-positive durations a minimum weight of one', () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'a', wbsId: 'p1-2', progress: 100 },
    { id: 'b', wbsId: 'p1-2-a', plannedDurationDays: -10, progress: 0 }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test('WBS rollup ignores unscheduled tasks when deriving date bounds', () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'unscheduled', wbsId: 'p1-2', plannedDurationDays: 1, progress: 10 },
    { id: 'scheduled', wbsId: 'p1-2-a', plannedStart: '2026-05-01', plannedFinish: '2026-05-05', plannedDurationDays: 3 }
  ], 'p1-2');
  assert.equal(rollup.plannedStart, '2026-05-01');
  assert.equal(rollup.plannedFinish, '2026-05-05');
});

test('WBS rollup counts only scheduled tasks marked critical in derived schedule data', () => {
  const rollup = selectWbsTaskRollup(wbs, tasks, 'p1-2', {
    t1: { isCritical: false },
    t2: { isCritical: true },
    t3: { isCritical: true }
  });
  assert.equal(rollup.criticalTaskCount, 1);
});

test('basic domain selectors return null for missing stable IDs', () => {
  assert.equal(selectTaskById(tasks, 'missing'), null);
  assert.equal(selectProjectById(projects, 'missing'), null);
  assert.equal(selectPersonById(people, 'missing'), null);
});

test('task collection selectors preserve source order', () => {
  assert.deepEqual(selectTasksByProject(tasks, 'p1').map((task) => task.id), ['t1', 't2']);
  assert.deepEqual(selectTasksByPerson(tasks, 'u1').map((task) => task.id), ['t1', 't2']);
});

test('selectTasksByPerson safely handles tasks without assigneeIds', () => {
  assert.deepEqual(selectTasksByPerson([{ id: 't0' }, ...tasks], 'u1').map((task) => task.id), ['t1', 't2']);
});

test('workspace normalization infers project mode from a valid selectedProjectId', () => {
  assert.deepEqual(normalizeWorkspaceSelection({ selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PROJECT,
    selectedProjectId: 'p1'
  });
});

test('workspace normalization respects explicit portfolio mode even with a project ID', () => {
  assert.deepEqual(normalizeWorkspaceSelection({ workspaceMode: 'portfolio', selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null
  });
});

test('workspace normalization falls back for unknown modes', () => {
  assert.deepEqual(normalizeWorkspaceSelection({ workspaceMode: 'unknown', selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null
  });
});

test('selectSelectedProject returns null outside project mode', () => {
  assert.equal(selectSelectedProject(state({ selectedProjectId: 'p1' })), null);
});

test('portfolio workspace selectors return copies of top-level arrays', () => {
  const value = state();
  assert.notStrictEqual(selectWorkspaceProjects(value), value.projects);
  assert.notStrictEqual(selectWorkspaceTasks(value), value.tasks);
  assert.notStrictEqual(selectWorkspaceWbs(value), value.wbs);
  assert.notStrictEqual(selectWorkspacePeople(value), value.people);
});

test('project workspace selectors scope projects, tasks, and WBS', () => {
  const value = state({ workspaceMode: 'project', selectedProjectId: 'p1' });
  assert.deepEqual(selectWorkspaceProjects(value).map((item) => item.id), ['p1']);
  assert.deepEqual(selectWorkspaceTasks(value).map((item) => item.id), ['t1', 't2']);
  assert.equal(selectWorkspaceWbs(value).every((node) => node.projectId === 'p1'), true);
});

test('project workspace people include task participants and the project lead', () => {
  const value = state({ workspaceMode: 'project', selectedProjectId: 'p1' });
  assert.deepEqual(selectWorkspacePeople(value).map((person) => person.id), ['u1', 'u2', 'u3']);
});

test('project workspace people include a lead even when the project has no tasks', () => {
  const value = state({
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    tasks: []
  });
  assert.deepEqual(selectWorkspacePeople(value).map((person) => person.id), ['u3']);
});

test('workspace context normalizes an invalid selected project before deriving data', () => {
  const context = selectWorkspaceContext(state({ workspaceMode: 'project', selectedProjectId: 'missing' }));
  assert.equal(context.mode, 'portfolio');
  assert.equal(context.selectedProjectId, null);
  assert.equal(context.selectedProject, null);
  assert.equal(context.projects.length, projects.length);
  assert.equal(context.tasks.length, tasks.length);
});

test('workspace context returns sorted project WBS data in project mode', () => {
  const context = selectWorkspaceContext(state({
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    wbs: [...wbs].reverse()
  }));
  assert.deepEqual(context.wbs.map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a', 'p1-10']);
});
