import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { taskTableMatches } from '../src/features/tasks/taskTableFacets.js';
import { simpleTaskMatches } from '../src/features/tasks/simpleTaskFacets.js';
import { effectiveTaskDate, taskSortValue } from '../src/features/tasks/taskDisplayValues.js';
import { selectStatusDistribution } from '../src/features/dashboard/statusDistribution.js';
import { navigationItems } from '../src/components/shell/navigation.js';
const { TaskDate } = await import('../src/features/tasks/TaskDate.jsx');
const { TaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');
const { KpiTaskModal, filterKpiTasks } = await import('../src/features/dashboard/KpiTaskModal.jsx');
const { Stat } = await import('../src/features/dashboard/DashboardView.jsx');
const { CommandPalette } = await import('../src/components/shell/CommandPalette.jsx');
const { ScheduleRequestCenter } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');
const { ScheduleRequestsView } = await import('../src/features/schedule-change/ScheduleRequestsView.jsx');

const day = new Date(2026, 8, 8);
const tasks = [
  { id: 'todo', status: 'todo', targetFinish: '2026-09-09' },
  { id: 'late-todo', status: 'todo', targetFinish: '2026-09-07' },
  { id: 'progress', status: 'in_progress', targetFinish: '2026-09-08' },
  { id: 'late-progress', status: 'in_progress', targetFinish: '2026-09-07' },
  { id: 'done', status: 'done', targetFinish: '2026-09-07' }
];

for (const matches of [taskTableMatches, simpleTaskMatches]) {
  test(`${matches.name}: durumlar birbirini dışlar, çoklu seçim birleşimdir ve Özetle aynıdır`, () => {
    const expected = { todo: ['todo'], in_progress: ['progress'], overdue: ['late-todo', 'late-progress'], done: ['done'] };
    const distribution = selectStatusDistribution(tasks, day);
    for (const [status, ids] of Object.entries(expected)) {
      const found = tasks.filter((task) => matches(task, { filters: { status: [status] } }, null, day));
      assert.deepEqual(found.map((task) => task.id), ids);
      assert.equal(found.length, distribution.segments.find((segment) => segment.id === status).value);
    }
    assert.deepEqual(tasks.filter((task) => matches(task, { filters: { status: ['todo', 'overdue'] } }, null, day)).map((task) => task.id), ['todo', 'late-todo', 'late-progress']);
  });
}

for (const [planned, actual, label] of [['plannedStart', 'actualStart', 'Gerçekleşen başlangıç'], ['plannedFinish', 'actualFinish', 'Gerçekleşen bitiş']]) {
  test(`${planned}: hücre, süzgeç ve sıralama aynı gerçekleşen tarihi kullanır`, () => {
    const task = { [planned]: '2026-09-01', [actual]: '2026-09-08' };
    assert.equal(effectiveTaskDate(task, planned), '2026-09-08');
    assert.equal(taskSortValue(task, planned, 'effective'), '2026-09-08');
    assert.equal(taskSortValue({ [planned]: '2026-09-01' }, planned, 'effective'), '2026-09-01');
    assert.equal(taskTableMatches(task, { filters: { [planned]: { mode: 'range', from: '2026-09-08', to: '2026-09-08' } }, dateMode: 'effective' }), true);
    assert.equal(taskTableMatches(task, { filters: { [planned]: { mode: 'before', to: '2026-09-07' } }, dateMode: 'effective' }), false);
    const rows = [task, { [planned]: '2026-09-05' }].sort((a, b) => taskSortValue(a, planned, 'effective').localeCompare(taskSortValue(b, planned, 'effective')));
    assert.equal(rows[1], task);
    const rendered = TaskDate({ task, field: planned });
    assert.ok(findElement(rendered, (node) => node.props?.title === label && node.props?.['aria-label'] === label));
    assert.equal(findElement(TaskDate({ task: { [planned]: '2026-09-01' }, field: planned }), (node) => node.props?.role === 'img'), null);
  });
}

test('tek alt satırdaki İlk/Önceki/Sonraki/Son ve uç sayfa kilitleri', () => {
  let page = 0;
  const setPage = (value) => { page = typeof value === 'function' ? value(page) : value; };
  const render = () => TaskTablePagination({ page, pageCount: 3, setPage, showDateLegend: true });
  const button = (name) => findElement(render(), (node) => node.type === 'button' && node.props['aria-label'] === name);
  assert.equal(button('İlk sayfa').props.disabled, true);
  assert.equal(button('Önceki görev sayfası').props.disabled, true);
  button('Son sayfa').props.onClick(); assert.equal(page, 2);
  assert.equal(button('Son sayfa').props.disabled, true);
  assert.equal(button('Sonraki görev sayfası').props.disabled, true);
  button('Önceki görev sayfası').props.onClick(); assert.equal(page, 1);
  button('Sonraki görev sayfası').props.onClick(); assert.equal(page, 2);
  button('İlk sayfa').props.onClick(); assert.equal(page, 0);
  assert.ok(findElement(render(), (node) => node.props?.className === 'task-date-legend'));
  const single = TaskTablePagination({ page: 0, pageCount: 1, setPage });
  for (const label of ['İlk sayfa', 'Önceki görev sayfası', 'Sonraki görev sayfası', 'Son sayfa']) {
    assert.equal(findElement(single, (node) => node.props?.['aria-label'] === label).props.disabled, true);
  }
});

test('Temel Kip komutları Gantt ve diğer kapsamlı sayfaları içermez; yönetici süzgeci korunur', () => {
  const simple = navigationItems(true, false).map((item) => item.id);
  assert.deepEqual(simple, ['veri', 'talepler', 'takvim', 'yardim', 'ayarlar']);
  assert.ok(navigationItems(false, false).some((item) => item.id === 'gantt'));
  assert.ok(navigationItems(true, true).some((item) => item.id === 'hatirlatma'));
  const listeners = new Map();
  globalThis.window = { addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener() {} };
  const view = mountComponent(CommandPalette, { navItems: navigationItems(true, false), tasks: [], onClose() {}, onNavigate() {}, onSetTheme() {} });
  try {
    const search = findElement(view.output, (node) => node.type === 'input');
    search.props.onChange({ target: { value: 'Gantt' } }); view.render();
    assert.equal(findElement(view.output, (node) => node.type === 'button'), null);
    search.props.onChange({ target: { value: 'Talepler' } }); view.render();
    assert.ok(findElement(view.output, (node) => node.type === 'button'));
  } finally { view.unmount(); delete globalThis.window; }
});

test('KPI zengin kartı korunur; detay eylemi aynı görev kümesini ve başlığı açar', () => {
  let opened = false;
  const stat = Stat({ label: 'Geciken', value: 2, items: tasks.slice(1, 3), onViewAll: () => { opened = true; } });
  assert.equal(stat.props.title, 'Geciken');
  assert.deepEqual(stat.props.items, tasks.slice(1, 3));
  assert.equal(typeof stat.props.renderItem, 'function');
  stat.props.onViewAll(); assert.equal(opened, true);
});

test('KPI detay listesi arama ve Sicil süzgeciyle daralır, yüzlük sayfalanır, görevi açar', async () => {
  const list = Array.from({ length: 125 }, (_, id) => ({ id: String(id), task: `Görev ${id}`, proje: 'Proje', projectId: 'p1', sorumlu: ['Aynı Ad'], assigneeIds: [id % 2 ? '100' : '200'], status: 'todo' }));
  assert.equal(filterKpiTasks(list, { assignee: '100' }).length, 62);
  assert.equal(filterKpiTasks(list, { search: 'GÖREV 124', project: 'p1', assignee: '200' }).length, 1);
  globalThis[CLIENT_STATE] = { selectedTask: null, people: [{ id: '100', name: 'Aynı Ad' }, { id: '200', name: 'Aynı Ad' }] };
  let opened;
  const view = mountComponent(KpiTaskModal, { title: 'Toplam görev', tasks: list, onClose() {}, onOpenTask: (task) => { opened = task; } });
  try {
    const pagination = findElement(view.output, (node) => node.type === TaskTablePagination);
    assert.equal(pagination.props.pageCount, 2);
    const body = findElement(view.output, (node) => node.type === 'tbody');
    assert.equal(body.props.children.length, 100);
    pagination.props.setPage(1); view.render();
    assert.equal(findElement(view.output, (node) => node.type === 'tbody').props.children.length, 25);
    await findElement(view.output, (node) => node.props?.className === 'detail-task-link').props.onClick();
    assert.equal(opened.id, '100');
    findElement(view.output, (node) => node.type === 'input').props.onChange({ target: { value: 'Görev 124' } }); view.render();
    assert.equal(findElement(view.output, (node) => node.type === 'tbody').props.children.length, 1);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});

test('zil en fazla sekiz kart gösterir, kalıcı geçmişe yönlendirir ve açık talebi ayırt eder', () => {
  const requests = Array.from({ length: 20 }, (_, id) => ({ id, status: 'PENDING', isDecisionOwner: true, taskTitle: `Görev ${id}`, unread: true }));
  globalThis[CLIENT_STATE] = { scheduleRequests: requests, scheduleRequestSummary: { unreadCount: 20, pendingCount: 20 }, actions: {} };
  let destination;
  const view = mountComponent(ScheduleRequestCenter, { onNavigate: (id) => { destination = id; } });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  try {
    findElement(view.output, (node) => node.props?.className === 'icon-btn schedule-request-toggle').props.onClick(); view.render();
    assert.equal(findElement(view.output, (node) => node.props?.className === 'schedule-request-list').props.children.length, 8);
    const actions = findElement(view.output, (node) => node.props?.className === 'schedule-inbox-actions');
    actions.props.children[2].props.onClick(); assert.equal(destination, 'talepler');
    assert.equal(requests.length, 20);
  } finally { view.unmount(); delete globalThis.document; delete globalThis[CLIENT_STATE]; }
});

test('Talepler tek sayfada üç erişilebilir sekme sunar ve ok tuşlarıyla gezinir', () => {
  globalThis[CLIENT_STATE] = { projects: [], actions: {}, session: { dataMode: 'demo' } };
  const view = mountComponent(ScheduleRequestsView, {});
  try {
    const tabs = findElement(view.output, (node) => node.props?.role === 'tablist').props.children;
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0].props['aria-selected'], true);
    tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); view.render();
    assert.equal(findElement(view.output, (node) => node.props?.id === 'requests-sent-tab').props['aria-selected'], true);
    assert.equal(findElement(view.output, (node) => node.props?.role === 'tabpanel').props['aria-labelledby'], 'requests-sent-tab');
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});
