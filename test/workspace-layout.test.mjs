import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';

const { NAV_ITEMS } = await import('../src/components/shell/navigation.js');
const { DashboardView } = await import('../src/features/dashboard/DashboardView.jsx');
const { ReportsView, PerformanceReportsView } = await import('../src/features/reports/ReportsView.jsx');
const { TaskActivitiesView } = await import('../src/features/reports/TaskActivitiesView.jsx');
const { ScheduleRequestsView } = await import('../src/features/schedule-change/ScheduleRequestsView.jsx');
const { DateRangeFilter } = await import('../src/components/DateRangeFilter.jsx');
const { TaskOrganizationFilterProvider } = await import('../src/features/tasks/TaskOrganizationFilterContext.jsx');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = postcss.parse(read('src/app/styles/features.css'));
function declaration(selector, property) {
  let value;
  css.walkRules(selector, (rule) => rule.walkDecls(property, (decl) => { value = decl.value; }));
  return value;
}
function state(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  globalThis[CLIENT_STATE] = { workspace: { tasks: [], projects: [], wbs: [] }, tasks: [], projects: [], wbs: [], people: [], calendars: [], session: { dataMode: 'demo' }, currentUser: {}, scheduleRequests: [] };
  t.after(() => { delete globalThis[CLIENT_STATE]; });
}

test('Özet başlık alanını kaldırır; Özet ve Performans filtreleri yapışkandır', (t) => {
  state(t);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = new EventTarget();
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  for (const Component of [DashboardView, PerformanceReportsView]) {
    const view = mountComponent(Component, {});
    assert.equal(findElement(view.output, (node) => node.type === DateRangeFilter).props.sticky, true);
    assert.equal(findElement(view.output, (node) => node.props?.title === 'Genel bakış'), null);
    view.unmount();
  }
  const provider = mountComponent(TaskOrganizationFilterProvider, {});
  const context = provider.output.type._context;
  const previous = context._currentValue;
  context._currentValue = provider.output.props.value;
  const filter = mountComponent(DateRangeFilter, { sticky: true, value: { preset: 'all' }, onChange() {} });
  t.after(() => { filter.unmount(); provider.unmount(); context._currentValue = previous; });
  assert.ok(filter.output.props.className.split(' ').includes('workspace-sticky'));
  assert.equal(declaration('.workspace-sticky', 'position'), 'sticky');
  assert.equal(declaration('.workspace-sticky', 'top'), '0');
  assert.equal(declaration('.stagger > .workspace-sticky', 'animation'), 'none');
});

test('Proje Yapısı sekmeleri ortak çalışma alanı sınırına yapışır', () => {
  const source = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(source, /project-workspace-tabs workspace-sticky/);
  assert.equal(declaration('.workspace-sticky', 'position'), 'sticky');
  assert.equal(declaration('.project-workspace-page', 'overflow'), undefined);
});

test('Görev Hareketleri yalnız etkin paneli esnetir ve tek tablo kaydırma alanı kullanır', (t) => {
  state(t);
  const reports = mountComponent(ReportsView, {});
  t.after(() => reports.unmount());
  findElement(reports.output, (node) => node.props?.id === 'report-tab-activities').props.onClick();
  reports.render();
  assert.equal(reports.output.props['data-report-tab'], 'activities');
  assert.equal(findElement(reports.output, (node) => node.props?.id === 'report-panel-performance').props.hidden, true);
  assert.equal(findElement(reports.output, (node) => node.props?.id === 'report-panel-activities').props.hidden, false);
  const view = mountComponent(TaskActivitiesView, {});
  t.after(() => view.unmount());
  const region = findElement(view.output, (node) => node.props?.role === 'region');
  assert.equal(region.props.tabIndex, 0);
  assert.ok(region.props.className.split(' ').includes('activity-scroll'));
  const header = findElement(region, (node) => node.type === 'thead');
  const body = findElement(region, (node) => node.type === 'tbody');
  assert.ok(header && body);
  assert.equal(declaration('.activity-scroll', 'overflow'), 'auto');
  assert.equal(declaration('.activity-scroll', 'min-height'), '0');
  // Kabuk içerik sınıfını gezinme KİMLİĞİNDEN üretir (`content-${view}`);
  // rapor sayfasının kimliği `rapor`'dur. Seçici bu kimliğe bağlanmazsa kural
  // hiçbir öğeyle eşleşmez ve tablo boş alan bırakır.
  assert.ok(NAV_ITEMS.some((item) => item.id === 'rapor'));
  assert.equal(declaration('.content-rapor:has([data-report-tab="activities"])', 'overflow'), 'hidden');
  assert.equal(declaration('.content-rapor:has([data-report-tab="activities"])', 'min-height'), '0');
  assert.equal(declaration('.activity-table thead th', 'position'), 'sticky');
  assert.equal(declaration('.activity-table', 'border-collapse'), 'separate');
  assert.equal(declaration('.reports-module > [hidden]', 'display'), 'none');
});

test('Talepler bütün sekmelerinde Görev Hareketleri ile aynı tema tablosunu korur', (t) => {
  state(t);
  const requests = mountComponent(ScheduleRequestsView, {});
  const activities = mountComponent(TaskActivitiesView, {});
  t.after(() => { requests.unmount(); activities.unmount(); });
  const tabs = findElement(requests.output, (node) => node.props?.role === 'tablist').props.children;
  for (const tab of tabs) {
    tab.props.onClick(); requests.render();
    const table = findElement(requests.output, (node) => node.type === 'table');
    assert.ok(table.props.className.split(' ').includes('enterprise-table'));
  }
  assert.ok(findElement(activities.output, (node) => node.type === 'table').props.className.split(' ').includes('enterprise-table'));
  assert.equal(declaration('.enterprise-table thead th', 'background'), 'var(--enterprise-header)');
  assert.equal(declaration('.request-tabs button[aria-selected="true"]', 'background'), 'var(--enterprise-selected)');
  assert.equal(declaration('.enterprise-table tbody tr:hover, .enterprise-table tbody tr:focus-within', 'background'), 'var(--enterprise-hover)');
  assert.match(declaration('.requests-view, .reports-module', '--enterprise-header'), /var\(--accent\).*var\(--bg-elev\)/);
});
