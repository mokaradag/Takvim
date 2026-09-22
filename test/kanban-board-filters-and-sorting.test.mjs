import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import {
  KANBAN_BOARD_IDS,
  KANBAN_SORT_LABELS,
  createKanbanSortState,
  kanbanAssigneeOptions,
  matchesKanbanAssignee,
  sortKanbanTasks,
  taskAssigneeSicils,
  toggleKanbanSort
} from '../src/features/kanban/kanbanBoardPolicy.js';

const { KanbanView } = await import('../src/features/kanban/KanbanView.jsx');
const { TaskOrganizationFilterControls } = await import('../src/features/tasks/TaskOrganizationFilterControls.jsx');
const { TaskOrganizationFilterProvider } = await import('../src/features/tasks/TaskOrganizationFilterContext.jsx');
const { createEmptyOrgFilter } = await import('../src/domain/organization/organizationHierarchy.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const people = [
  { id: '100', name: 'Aynı Ad', employeeNo: '100', organization: { directorate: 'D1', department: 'M1', unit: 'B1' } },
  { id: '200', name: 'Aynı Ad', employeeNo: '200', organization: { directorate: 'D2', department: 'M2', unit: 'B2' } },
  { id: '300', name: 'Üçüncü Kişi', employeeNo: '300', organization: { directorate: 'D1', department: 'M1', unit: 'B1' } }
];

const tasks = [
  { id: 'a', task: 'Alfa', proje: 'Proje', projectId: 'p1', status: 'todo', priority: 'normal', targetFinish: '2026-10-20', sorumlu: ['Aynı Ad'], assigneeIds: ['100'] },
  { id: 'b', task: 'Beta', proje: 'Proje', projectId: 'p1', status: 'todo', priority: 'normal', targetFinish: '2026-10-05', sorumlu: ['Aynı Ad'], assigneeIds: ['200'] },
  { id: 'c', task: 'Gama', proje: 'Proje', projectId: 'p1', status: 'todo', priority: 'normal', sorumlu: ['Aynı Ad', 'Üçüncü Kişi'], assigneeIds: ['100', '300'] },
  { id: 'd', task: 'Delta', proje: 'Proje', projectId: 'p1', status: 'in_progress', priority: 'normal', targetFinish: '2026-09-30', sorumlu: ['Üçüncü Kişi'], assigneeIds: ['300'] },
  { id: 'e', task: 'Epsilon', proje: 'Proje', projectId: 'p1', status: 'done', priority: 'normal', targetFinish: '2026-08-01', sorumlu: ['Aynı Ad'], assigneeIds: ['100'] }
];

/**
 * Sığ çizim bağlamı: paylaşılan kurumsal süzgeç sağlayıcısı test tarafından
 * taklit edilmez, GERÇEK bağlam nesnesine değer yazılır.
 */
function mountKanban(actions = {}) {
  globalThis[CLIENT_STATE] = {
    workspace: { tasks, people },
    tasks,
    people,
    actions: { openTask() {}, updateTask() {}, ...actions }
  };
  const providerView = mountComponent(TaskOrganizationFilterProvider, {});
  const context = providerView.output.type._context;
  const previousContext = context._currentValue;
  let selection = createEmptyOrgFilter();
  const setSelection = (next) => {
    selection = typeof next === 'function' ? next(selection) : next;
    context._currentValue = { selection, setSelection };
  };
  context._currentValue = { selection, setSelection };
  const view = mountComponent(KanbanView, {});
  const unmount = view.unmount;
  view.unmount = () => {
    unmount();
    providerView.unmount();
    context._currentValue = previousContext;
    delete globalThis[CLIENT_STATE];
  };
  return view;
}

function boardItems(view, boardId) {
  const columns = findElement(view.output, (node) => node.props?.className === 'kanban').props.children;
  const index = KANBAN_BOARD_IDS.indexOf(boardId);
  const list = findElement(columns[index], (node) => String(node.props?.className || '').startsWith('kanban-list'));
  return (list.props.children[0] || []).map((entry) => entry.key);
}

function sortToggle(view, boardId) {
  const columns = findElement(view.output, (node) => node.props?.className === 'kanban').props.children;
  const index = KANBAN_BOARD_IDS.indexOf(boardId);
  return findElement(columns[index], (node) => node.props?.className === 'kanban-sort-toggle');
}

/* ── Saf kurallar ────────────────────────────────────────────── */

test('pano sıralaması hedefe göre eskiden yeniye varsayılanla başlar ve tarihsizi sona koyar', () => {
  const state = createKanbanSortState();
  assert.deepEqual(Object.keys(state).sort(), [...KANBAN_BOARD_IDS].sort());
  for (const boardId of KANBAN_BOARD_IDS) assert.equal(state[boardId], 'asc');

  const column = [
    { id: '1', task: 'Bir', targetFinish: '2026-10-20' },
    { id: '2', task: 'İki' },
    { id: '3', task: 'Üç', targetFinish: '2026-09-01' }
  ];
  assert.deepEqual(sortKanbanTasks(column, 'asc').map((task) => task.id), ['3', '1', '2']);
  // Ters yönde de tarihsiz görev EN ALTTA kalır.
  assert.deepEqual(sortKanbanTasks(column, 'desc').map((task) => task.id), ['1', '3', '2']);
  // Kaynak dizi DEĞİŞTİRİLMEZ.
  assert.deepEqual(column.map((task) => task.id), ['1', '2', '3']);
});

test('eşit hedefli görevlerde sıralama kararlı bir ayraçla belirlenir', () => {
  const column = [
    { id: '2', task: 'Beta', targetFinish: '2026-10-01' },
    { id: '1', task: 'Alfa', targetFinish: '2026-10-01' }
  ];
  assert.deepEqual(sortKanbanTasks(column, 'asc').map((task) => task.id), ['1', '2']);
  assert.deepEqual(sortKanbanTasks(column, 'desc').map((task) => task.id), ['1', '2']);
});

test('sıralama yönü pano BAŞINA değişir', () => {
  let state = createKanbanSortState();
  state = toggleKanbanSort(state, 'todo');
  assert.equal(state.todo, 'desc');
  assert.equal(state.in_progress, 'asc');
  assert.equal(state.done, 'asc');
  state = toggleKanbanSort(state, 'todo');
  assert.equal(state.todo, 'asc');
  assert.deepEqual(Object.keys(KANBAN_SORT_LABELS).sort(), ['asc', 'desc']);
});

test('sorumlu eşleşmesi Sicil ile yapılır ve çok sorumlu görevleri kapsar', () => {
  assert.deepEqual(taskAssigneeSicils(tasks[2]), ['100', '300']);
  assert.equal(matchesKanbanAssignee(tasks[2], '300'), true);
  assert.equal(matchesKanbanAssignee(tasks[2], '200'), false);
  // Süzgeç seçilmemişse bütün görevler geçer.
  assert.equal(matchesKanbanAssignee(tasks[0], ''), true);
  // Aynı adlı iki kişi ayrı seçenektir; ad eşleşmesi kullanılmaz.
  const options = kanbanAssigneeOptions(tasks, people);
  assert.deepEqual(options.map((option) => option.value), ['100', '200', '300']);
  assert.equal(options.filter((option) => option.label === 'Aynı Ad').length, 2);
});

test('seçenekler yalnızca süzülmüş görev kümesinden türetilir', () => {
  const narrowed = kanbanAssigneeOptions([tasks[3]], people);
  assert.deepEqual(narrowed.map((option) => option.value), ['300']);
});

/* ── Arayüz ──────────────────────────────────────────────────── */

test('Kanban araç çubuğu Sorumlu süzgecini kurumsal süzgeçlerle AYNI satırda çizer', () => {
  const view = mountKanban();
  try {
    const organization = findElement(view.output, (node) => node.type === TaskOrganizationFilterControls);
    assert.ok(organization, 'kurumsal süzgeç denetimi çizilmelidir');
    // Sorumlu seçimi aynı denetimin içine gömülür: araç çubuğuna ikinci satır eklenmez.
    const extra = organization.props.extraControls;
    assert.ok(extra, 'Sorumlu süzgeci kurumsal süzgeç satırında durmalıdır');
    assert.equal(extra.props.ariaLabel, 'Sorumlu filtresi');
    assert.equal(extra.props.className, 'task-org-select');
    assert.deepEqual(extra.props.options.map((option) => option.value), ['', '100', '200', '300']);
  } finally { view.unmount(); }
});

test('Sorumlu süzgeci Sicil ile daraltır, çok sorumluyu kapsar ve Filtreleri temizle sıfırlar', () => {
  const view = mountKanban();
  try {
    const select = () => findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.extraControls;
    assert.deepEqual(boardItems(view, 'todo'), ['b', 'a', 'c']);

    select().props.onChange('300'); view.render();
    // Çok sorumlu görev de eşleşir.
    assert.deepEqual(boardItems(view, 'todo'), ['c']);
    assert.deepEqual(boardItems(view, 'in_progress'), ['d']);
    assert.deepEqual(boardItems(view, 'done'), []);

    const clear = findElement(view.output, (node) => node.type === 'button'
      && Array.isArray(node.props.children) && node.props.children.includes(' Filtreleri temizle'));
    assert.ok(clear, 'süzgeç etkinken temizleme düğmesi görünmelidir');
    clear.props.onClick(); view.render();
    assert.deepEqual(boardItems(view, 'todo'), ['b', 'a', 'c']);
    assert.equal(select().props.value, '');
  } finally { view.unmount(); }
});

test('Sorumlu ve kurumsal süzgeçler birlikte çalışır; seçilemeyen sorumlu kendiliğinden düşer', () => {
  const view = mountKanban();
  try {
    const select = () => findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.extraControls;
    const organization = () => findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.organization;
    select().props.onChange('300'); view.render();
    assert.deepEqual(boardItems(view, 'in_progress'), ['d']);

    // Kurumsal süzgeç D2'ye daralınca 300 numaralı sicil kümede kalmaz.
    organization().selectLevel('directorate', 'D2'); view.render();
    assert.equal(select().props.value, '');
    assert.deepEqual(boardItems(view, 'todo'), ['b']);
  } finally { view.unmount(); }
});

test('her pano kendi hedef sıralamasını taşır ve yön düğmesi erişilebilirdir', () => {
  const view = mountKanban();
  try {
    assert.deepEqual(boardItems(view, 'todo'), ['b', 'a', 'c']);
    const toggle = sortToggle(view, 'todo');
    assert.equal(toggle.props['aria-label'], KANBAN_SORT_LABELS.asc);
    assert.equal(toggle.props.title, KANBAN_SORT_LABELS.asc);

    toggle.props.onClick(); view.render();
    assert.deepEqual(boardItems(view, 'todo'), ['a', 'b', 'c']);
    assert.equal(sortToggle(view, 'todo').props['aria-label'], KANBAN_SORT_LABELS.desc);
    // Öteki panolar etkilenmez.
    assert.equal(sortToggle(view, 'in_progress').props['aria-label'], KANBAN_SORT_LABELS.asc);
  } finally { view.unmount(); }
});

test('aynı sütuna bırakma yazma üretmez; sıralama sürükle-bırakı bozmaz', () => {
  const updates = [];
  const view = mountKanban({ updateTask: (id, patch) => updates.push([id, patch]) });
  try {
    const columns = () => findElement(view.output, (node) => node.props?.className === 'kanban').props.children;
    const list = (boardId) => {
      const index = KANBAN_BOARD_IDS.indexOf(boardId);
      return findElement(columns()[index], (node) => String(node.props?.className || '').startsWith('kanban-list'));
    };
    const card = findElement(list('todo'), (node) => node.props?.['data-task-id'] === 'a');
    card.props.onDragStart({ dataTransfer: { setData() {} } }); view.render();

    // Aynı sütuna bırakma DEĞİŞİKLİK değildir.
    list('todo').props.onDrop(); view.render();
    assert.deepEqual(updates, []);

    card.props.onDragStart({ dataTransfer: { setData() {} } }); view.render();
    list('done').props.onDrop(); view.render();
    assert.deepEqual(updates, [['a', { status: 'done' }]]);
  } finally { view.unmount(); }
});

test('sıralama denetimi pano başlığında durur ve GPU ağırlıklı efekt getirmez', () => {
  const source = read('src/features/kanban/KanbanView.jsx');
  // Düğme, pano BAŞLIK satırının içinde ve sayaçtan hemen sonra durur: panoya
  // ikinci bir satır ve fazladan dikey yükseklik eklenmez.
  const head = source.slice(source.indexOf('kanban-col-head'), source.indexOf('kanban-list'));
  const counter = head.indexOf('className="count tabular"');
  const toggle = head.indexOf('className="kanban-sort-toggle"');
  assert.ok(counter >= 0 && toggle > counter, 'sıralama düğmesi sayacın yanında olmalıdır');
  const css = read('src/app/styles/features.css');
  assert.match(css, /\.kanban-sort-toggle \{/);
  const block = css.slice(css.indexOf('.kanban-sort-toggle {'), css.indexOf('.kanban-sort-toggle:hover'));
  assert.equal(/will-change|filter:|backdrop-filter/.test(block), false);
  // Süzgeç ve sıralama sunucuya ek sorgu göndermez.
  assert.equal(/fetch\(|requestJson/.test(source), false);
});
