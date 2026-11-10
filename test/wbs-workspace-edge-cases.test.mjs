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

test("compareWbsNodes açık sortOrder değerini önce kullanır", () => {
  assert.equal(compareWbsNodes({ sortOrder: 1, code: '9' }, { sortOrder: 2, code: '1' }) < 0, true);
});

test("compareWbsNodes sortOrder yoksa sayısal kod sırasını kullanır", () => {
  assert.equal(compareWbsNodes({ code: '1.2' }, { code: '1.10' }) < 0, true);
});

test("compareWbsNodes eşitlikte önce ad sonra kimliği kullanır", () => {
  assert.equal(compareWbsNodes({ code: '1', name: 'Alpha', id: 'z' }, { code: '1', name: 'Beta', id: 'a' }) < 0, true);
  assert.equal(compareWbsNodes({ code: '1', name: 'Same', id: 'a' }, { code: '1', name: 'Same', id: 'b' }) < 0, true);
});

test("selectProjectWbs proje kimliği yoksa boş liste döndürür", () => {
  assert.deepEqual(selectProjectWbs(wbs, null), []);
});

test("selectProjectWbs kaynak diziyi değiştirmeden üstü önce ve kardeş sırasını korur", () => {
  const reversed = [...wbs].reverse();
  const before = reversed.map((node) => node.id);
  const result = selectProjectWbs(reversed, 'p1');
  assert.deepEqual(result.map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a', 'p1-10']);
  assert.deepEqual(reversed.map((node) => node.id), before);
});

test("selectWbsRoots boş üstlü düğümü kök sayar", () => {
  assert.deepEqual(selectWbsRoots(wbs).map((node) => node.id), ['p1-root', 'p2-root']);
});

test("selectWbsRoots sahipsiz düğümü gizlemek yerine sunar", () => {
  const nodes = [{ id: 'orphan', projectId: 'p1', parentId: 'missing', code: '1.1', name: 'Orphan' }];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['orphan']);
});

test("selectWbsRoots başka projeli üst bağını kök olarak sunar", () => {
  const nodes = [
    { id: 'a', projectId: 'p1', parentId: null },
    { id: 'b', projectId: 'p2', parentId: 'a' }
  ];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['a', 'b']);
});

test("selectWbsRoots kendini üst yapan düğümü kök sayar", () => {
  const nodes = [{ id: 'a', projectId: 'p1', parentId: 'a' }];
  assert.deepEqual(selectWbsRoots(nodes).map((node) => node.id), ['a']);
});

test("selectDefaultProjectWbs tek doğal kökü döndürür", () => {
  assert.equal(selectDefaultProjectWbs(wbs, 'p1')?.id, 'p1-root');
});

test("selectDefaultProjectWbs çok doğal kökte boş değer döndürür", () => {
  const nodes = [...wbs, { id: 'p1-root-2', projectId: 'p1', parentId: null, code: '9', name: 'Second' }];
  assert.equal(selectDefaultProjectWbs(nodes, 'p1'), null);
});

test("selectWbsChildren yalnızca sıralı doğrudan çocukları döndürür", () => {
  assert.deepEqual(selectWbsChildren([...wbs].reverse(), 'p1-root').map((node) => node.id), ['p1-2', 'p1-10']);
});

test("selectWbsDescendantIds belirlenimci kardeş sırasında derinlik önce gezer", () => {
  assert.deepEqual(selectWbsDescendantIds(wbs, 'p1-root'), ['p1-2', 'p1-2-a', 'p1-10']);
});

test("selectWbsDescendantIds döngüye dayanır ve başlangıç düğümünü döndürmez", () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'c', sortOrder: 1 },
    { id: 'b', projectId: 'p1', parentId: 'a', sortOrder: 1 },
    { id: 'c', projectId: 'p1', parentId: 'b', sortOrder: 1 }
  ];
  assert.deepEqual(selectWbsDescendantIds(cycle, 'a'), ['b', 'c']);
});

test("selectWbsDescendantIds bilinmeyen düğümde boş döner", () => {
  assert.deepEqual(selectWbsDescendantIds(wbs, 'missing'), []);
});

test("selectWbsAncestors kökten üste sırayı döndürür", () => {
  assert.deepEqual(selectWbsAncestors(wbs, 'p1-2-a').map((node) => node.id), ['p1-root', 'p1-2']);
});

test("selectWbsAncestors başka proje üst sınırında durur", () => {
  const nodes = [
    { id: 'foreign', projectId: 'p2', parentId: null },
    { id: 'child', projectId: 'p1', parentId: 'foreign' }
  ];
  assert.deepEqual(selectWbsAncestors(nodes, 'child'), []);
});

test("selectWbsAncestors üstleri yinelemeden döngüyü bitirir", () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'c' },
    { id: 'b', projectId: 'p1', parentId: 'a' },
    { id: 'c', projectId: 'p1', parentId: 'b' }
  ];
  assert.deepEqual(selectWbsAncestors(cycle, 'a').map((node) => node.id), ['b', 'c']);
});

test("selectWbsPath üstleri ve istenen düğümü içerir", () => {
  assert.deepEqual(selectWbsPath(wbs, 'p1-2-a').map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a']);
});

test("selectWbsPath ve formatWbsPath eksik düğümde boştur", () => {
  assert.deepEqual(selectWbsPath(wbs, 'missing'), []);
  assert.equal(formatWbsPath(wbs, 'missing'), '');
});

test("formatWbsPath eksik kod veya ad parçasını güvenle kırpar", () => {
  const nodes = [
    { id: 'root', projectId: 'p1', parentId: null, code: '', name: 'Root' },
    { id: 'child', projectId: 'p1', parentId: 'root', code: '1', name: '' }
  ];
  assert.equal(formatWbsPath(nodes, 'child'), 'Root / 1');
});

test("buildWbsTree sahipsiz düğümü üst düzey kök tutar", () => {
  const tree = buildWbsTree([{ id: 'orphan', projectId: 'p1', parentId: 'missing', code: '1' }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, 'orphan');
});

test("buildWbsTree ilk kanonik düğümden sonraki yinelenen kimliği yok sayar", () => {
  const tree = buildWbsTree([
    { id: 'same', projectId: 'p1', parentId: null, code: '1', name: 'First', sortOrder: 1 },
    { id: 'same', projectId: 'p1', parentId: null, code: '2', name: 'Second', sortOrder: 2 }
  ]);
  assert.equal(flattenWbsTree(tree).length, 1);
  assert.equal(flattenWbsTree(tree)[0].node.name, 'First');
});

test("buildWbsTree döngülü bileşeni görünür ve sonlu tutar", () => {
  const cycle = [
    { id: 'a', projectId: 'p1', parentId: 'b', code: '1' },
    { id: 'b', projectId: 'p1', parentId: 'a', code: '2' }
  ];
  const flattened = flattenWbsTree(buildWbsTree(cycle));
  assert.equal(flattened.length, 2);
  assert.deepEqual(new Set(flattened.map((row) => row.node.id)), new Set(['a', 'b']));
});

test("buildWbsTree kaynak düğüme çocuk özelliği ekleyerek değiştirmez", () => {
  const input = wbs.map((node) => ({ ...node }));
  buildWbsTree(input);
  assert.equal(input.some((node) => Object.hasOwn(node, 'children')), false);
});

test("flattenWbsTree yinelenen başvuruyu bir kez gezer", () => {
  const shared = { id: 'shared', children: [] };
  const tree = [
    { id: 'a', children: [shared] },
    { id: 'b', children: [shared] }
  ];
  assert.deepEqual(flattenWbsTree(tree).map((row) => row.node.id), ['a', 'shared', 'b']);
});

test("flattenWbsTree iç düğümün derinliğini kaydeder", () => {
  const rows = flattenWbsTree(buildWbsTree(wbs));
  const leaf = rows.find((row) => row.node.id === 'p1-2-a');
  assert.equal(leaf.depth, 2);
});

test("selectTasksForWbs varsayılan yalnızca doğrudan görevleri döndürür", () => {
  assert.deepEqual(selectTasksForWbs(tasks, wbs, 'p1-2').map((task) => task.id), ['t1']);
});

test("selectTasksForWbs isteğe bağlı alt atamaları içerir", () => {
  assert.deepEqual(selectTasksForWbs(tasks, wbs, 'p1-2', { includeDescendants: true }).map((task) => task.id), ['t1', 't2']);
});

test("WBS toplamı ağırlıktan önce ilerlemeyi sıfır ve yüz arasında sınırlar", () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'low', wbsId: 'p1-2', plannedDurationDays: 1, progress: -20 },
    { id: 'high', wbsId: 'p1-2-a', plannedDurationDays: 1, progress: 140 }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test("WBS toplamı ilerleme yoksa tamamlanmış durumu yüzde yüz sayar", () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'done', wbsId: 'p1-2', plannedDurationDays: 1, status: 'done' },
    { id: 'todo', wbsId: 'p1-2-a', plannedDurationDays: 1, status: 'todo' }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test("WBS toplamı eksik ve pozitif olmayan süreye en az bir ağırlık verir", () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'a', wbsId: 'p1-2', progress: 100 },
    { id: 'b', wbsId: 'p1-2-a', plannedDurationDays: -10, progress: 0 }
  ], 'p1-2');
  assert.equal(rollup.progress, 50);
});

test("WBS toplamı tarih sınırı türetirken plansız görevi yok sayar", () => {
  const rollup = selectWbsTaskRollup(wbs, [
    { id: 'unscheduled', wbsId: 'p1-2', plannedDurationDays: 1, progress: 10 },
    { id: 'scheduled', wbsId: 'p1-2-a', plannedStart: '2026-05-01', plannedFinish: '2026-05-05', plannedDurationDays: 3 }
  ], 'p1-2');
  assert.equal(rollup.plannedStart, '2026-05-01');
  assert.equal(rollup.plannedFinish, '2026-05-05');
});

test("WBS toplamı yalnızca türetilmiş çizelgede kritik işaretli planlı görevi sayar", () => {
  const rollup = selectWbsTaskRollup(wbs, tasks, 'p1-2', {
    t1: { isCritical: false },
    t2: { isCritical: true },
    t3: { isCritical: true }
  });
  assert.equal(rollup.criticalTaskCount, 1);
});

test("temel alan seçicisi eksik kararlı kimlikte boş değer döndürür", () => {
  assert.equal(selectTaskById(tasks, 'missing'), null);
  assert.equal(selectProjectById(projects, 'missing'), null);
  assert.equal(selectPersonById(people, 'missing'), null);
});

test("görev koleksiyon seçicisi kaynak sırasını korur", () => {
  assert.deepEqual(selectTasksByProject(tasks, 'p1').map((task) => task.id), ['t1', 't2']);
  assert.deepEqual(selectTasksByPerson(tasks, 'u1').map((task) => task.id), ['t1', 't2']);
});

test("selectTasksByPerson sorumlu kimliği olmayan görevi güvenle işler", () => {
  assert.deepEqual(selectTasksByPerson([{ id: 't0' }, ...tasks], 'u1').map((task) => task.id), ['t1', 't2']);
});

test("alan normalleştirmesi geçerli seçili kimlikten proje kipini çıkarır", () => {
  assert.deepEqual(normalizeWorkspaceSelection({ selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PROJECT,
    selectedProjectId: 'p1'
  });
});

test("çalışma alanı normalleştirmesi proje kimliği olsa da açık portföy kipini korur", () => {
  assert.deepEqual(normalizeWorkspaceSelection({ workspaceMode: 'portfolio', selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null
  });
});

test("çalışma alanı normalleştirmesi bilinmeyen kipte varsayılana döner", () => {
  assert.deepEqual(normalizeWorkspaceSelection({ workspaceMode: 'unknown', selectedProjectId: 'p1' }, projects), {
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null
  });
});

test("selectSelectedProject proje kipi dışında boş değer döndürür", () => {
  assert.equal(selectSelectedProject(state({ selectedProjectId: 'p1' })), null);
});

test("portföy alanı seçicisi üst düzey dizilerin kopyasını döndürür", () => {
  const value = state();
  assert.notStrictEqual(selectWorkspaceProjects(value), value.projects);
  assert.notStrictEqual(selectWorkspaceTasks(value), value.tasks);
  assert.notStrictEqual(selectWorkspaceWbs(value), value.wbs);
  assert.notStrictEqual(selectWorkspacePeople(value), value.people);
});

test("proje alanı seçicisi proje görev ve WBS kapsamını sınırlar", () => {
  const value = state({ workspaceMode: 'project', selectedProjectId: 'p1' });
  assert.deepEqual(selectWorkspaceProjects(value).map((item) => item.id), ['p1']);
  assert.deepEqual(selectWorkspaceTasks(value).map((item) => item.id), ['t1', 't2']);
  assert.equal(selectWorkspaceWbs(value).every((node) => node.projectId === 'p1'), true);
});

test("proje alanı kişileri görev katılımcısını ve proje liderini içerir", () => {
  const value = state({ workspaceMode: 'project', selectedProjectId: 'p1' });
  assert.deepEqual(selectWorkspacePeople(value).map((person) => person.id), ['u1', 'u2', 'u3']);
});

test("proje görevsiz olsa da alan kişileri lideri içerir", () => {
  const value = state({
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    tasks: []
  });
  assert.deepEqual(selectWorkspacePeople(value).map((person) => person.id), ['u3']);
});

test("alan bağlamı veriyi türetmeden geçersiz seçili projeyi normalleştirir", () => {
  const context = selectWorkspaceContext(state({ workspaceMode: 'project', selectedProjectId: 'missing' }));
  assert.equal(context.mode, 'portfolio');
  assert.equal(context.selectedProjectId, null);
  assert.equal(context.selectedProject, null);
  assert.equal(context.projects.length, projects.length);
  assert.equal(context.tasks.length, tasks.length);
});

test("alan bağlamı proje kipinde sıralı WBS verisini döndürür", () => {
  const context = selectWorkspaceContext(state({
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    wbs: [...wbs].reverse()
  }));
  assert.deepEqual(context.wbs.map((node) => node.id), ['p1-root', 'p1-2', 'p1-2-a', 'p1-10']);
});

test('Proje çalışma alanı katılımcıları Sicil ve çalışan numarasıyla da bulunur', () => {
  const value = {
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    projects: [{ id: 'p1', leadId: 'lider' }],
    tasks: [
      { id: 't1', projectId: 'p1', assigneeIds: ['9000'] },
      { id: 't2', projectId: 'p1', assigneeIds: ['8000'] }
    ],
    people: [
      { id: 'ic-a', employeeNo: '9000', name: 'Ayşe' },
      { id: 'ic-b', sicil: '8000', name: 'Bora' },
      { id: 'lider', name: 'Lider' },
      { id: 'ilgisiz', employeeNo: '7000', name: 'Diğer' }
    ]
  };
  assert.deepEqual(selectWorkspacePeople(value).map((person) => person.id), ['ic-a', 'ic-b', 'lider']);
});
