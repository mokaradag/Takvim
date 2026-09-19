import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { departmentKey, unitKey } from '../src/domain/organization/organizationHierarchy.js';
const { KpiTaskModal } = await import('../src/features/dashboard/KpiTaskModal.jsx');
const { useTaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');
const { TaskOrganizationFilterControls } = await import('../src/features/tasks/TaskOrganizationFilterControls.jsx');

const people = [
  { id: '100', name: 'Aynı Ad', organization: { directorate: 'D1', department: 'M1', unit: 'B1' } },
  { id: '200', name: 'Aynı Ad', organization: { directorate: 'D2', department: 'M2', unit: 'B2' } }
];
const tasks = [
  { id: 'a', projectId: 'p1', proje: 'Proje 1', task: 'İlk görev', sorumlu: ['Aynı Ad'], assigneeIds: ['100'], status: 'todo', plannedStart: '2026-09-01', actualStart: '2026-09-10', plannedFinish: '2026-09-11', targetFinish: '2026-09-12' },
  { id: 'b', projectId: 'p2', proje: 'Proje 2', task: 'İkinci görev', sorumlu: ['Aynı Ad'], assigneeIds: ['200'], status: 'done', plannedStart: '2026-09-02', plannedFinish: '2026-09-05', actualFinish: '2026-09-15', targetFinish: '2026-09-14' }
];
const rows = (view) => findElement(view.output, (node) => node.type === 'tbody').props.children;
const column = (view, label) => findElement(view.output, (node) => node.props?.label === label && node.props?.onFilter);

function withModal(run) {
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  const view = mountComponent(KpiTaskModal, { title: 'Toplam görev', tasks, referenceDay: new Date(2026, 8, 19), onClose() {}, onOpenTask() {} });
  try { run(view); } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
}

test('KPI sütunları çapraz süzülür; aynı adlar Sicil ile ayrılır ve görünen tarihler kullanılır', () => withModal((view) => {
  assert.equal(rows(view).length, 2);
  assert.deepEqual(column(view, 'Sorumlu').props.filterOptions.map((option) => option.value), ['100', '200']);
  column(view, 'Proje').props.onFilter(['p1']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  assert.deepEqual(column(view, 'Sorumlu').props.filterOptions.map((option) => option.value), ['100']);
  assert.equal(column(view, 'Proje').props.filterOptions.length, 2);
  column(view, 'Proje').props.onFilter([]);
  column(view, 'Sorumlu').props.onFilter(['200']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Sorumlu').props.onFilter([]);
  column(view, 'Başlangıç').props.onFilter({ mode: 'range', from: '2026-09-10', to: '2026-09-10' }); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  column(view, 'Başlangıç').props.onFilter(null);
  column(view, 'Bitiş').props.onFilter({ mode: 'after', from: '2026-09-14' }); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Bitiş').props.onFilter(null);
  column(view, 'Hedef').props.onFilter({ mode: 'before', to: '2026-09-13' }); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  column(view, 'Hedef').props.onFilter(null);
  column(view, 'Durum').props.onFilter(['overdue']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  column(view, 'Durum').props.onFilter([]);
  column(view, 'Görev').props.onFilter('İKİNCİ'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
}));

test('KPI kurumsal zinciri ve temizleme yalnızca modalın mevcut görev kümesini daraltır', () => withModal((view) => {
  const organization = () => findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.organization;
  organization().selectLevel('directorate', 'D1'); view.render();
  organization().selectLevel('department', departmentKey(people[0])); view.render();
  organization().selectLevel('unit', unitKey(people[0])); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  organization().selectLevel('directorate', 'D2'); view.render();
  assert.equal(organization().selection.department, '');
  assert.equal(organization().selection.unit, '');
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Görev').props.onFilter('eşleşmeyen'); view.render();
  assert.equal(rows(view).length, 0);
  findElement(view.output, (node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(' Filtreleri Temizle')).props.onClick(); view.render();
  assert.equal(rows(view).length, 2);
  assert.equal(organization().selection.directorate, '');
}));

test('KPI tarih sıralaması gerçekleşen tarihi esas alır', () => withModal((view) => {
  column(view, 'Başlangıç').props.onSort('asc'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b', 'a']);
  column(view, 'Bitiş').props.onSort('desc'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b', 'a']);
}));

for (const pageSize of [5, 6]) test(`${pageSize} satırlık kart sayfası küçülmede sınırlandırılır ve kapsam değişince sıfırlanır`, () => {
  const data = Array.from({ length: 24 }, (_, id) => ({ id }));
  const component = (props) => useTaskTablePagination(props.rows, props.scope, pageSize);
  const view = mountComponent(component, { rows: data, scope: 'all' });
  try {
    assert.equal(view.output.rows.length, pageSize);
    view.output.setPage(3); view.render();
    assert.equal(view.output.start, pageSize * 3);
    view.render({ rows: data.slice(0, 7), scope: 'all' });
    assert.equal(view.output.page, 1);
    assert.equal(view.output.rows.length, 7 - pageSize);
    view.render({ rows: data, scope: 'filtered' });
    assert.equal(view.output.page, 0);
    view.render({ rows: [], scope: 'filtered' });
    assert.equal(view.output.pageCount, 1);
    assert.equal(view.output.rows.length, 0);
  } finally { view.unmount(); }
});

const { DashboardView } = await import('../src/features/dashboard/DashboardView.jsx');
const { DashboardPagination, DashboardResultLimit } = await import('../src/features/dashboard/DashboardListControls.jsx');
const { PeopleMetricTable } = await import('../src/components/PeopleMetricTable.jsx');

test('Özet kartları ayrı sayfalanır ve sonuç sınırları birbirinden bağımsız değişir', () => {
  const data = Array.from({ length: 24 }, (_, id) => ({
    ...tasks[0], id: String(id), projectId: `p${id}`, proje: `Proje ${id}`, task: `Görev ${id}`,
    targetFinish: '2099-12-31', sorumlu: [`Kişi ${id}`], assigneeIds: [String(id)]
  }));
  globalThis[CLIENT_STATE] = { workspace: { tasks: data }, people: data.map((task) => ({ id: task.id, name: task.sorumlu[0] })), actions: {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const view = mountComponent(DashboardView, { onNavigate() {} });
  const pager = (label) => findElement(view.output, (node) => node.type === DashboardPagination && node.props.label === label);
  const limit = (label) => findElement(view.output, (node) => node.props?.right?.type === DashboardResultLimit && node.props.right.props.label === label).props.right;
  const workload = () => findElement(view.output, (node) => node.type === PeopleMetricTable).props.rows;
  try {
    assert.equal(pager('Projeler').props.rows.length, 5);
    assert.equal(pager('Portföy sağlığı').props.rows.length, 6);
    pager('Projeler').props.setPage(1); view.render();
    assert.equal(pager('Projeler').props.page, 1);
    assert.equal(pager('Portföy sağlığı').props.page, 0);
    assert.equal(workload().length, 5);
    limit('Ekip iş yükü').props.onChange(20); view.render();
    assert.equal(workload().length, 20);
    assert.equal(limit('Yaklaşan teslimler').props.value, 5);
    limit('Yaklaşan teslimler').props.onChange(10); view.render();
    assert.equal(limit('Yaklaşan teslimler').props.value, 10);
    assert.equal(workload().length, 20);
    assert.equal(data.length, 24);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; delete globalThis.document; }
});
