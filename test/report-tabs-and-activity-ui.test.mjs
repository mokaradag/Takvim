import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
const { ReportsView, PerformanceReportsView } = await import('../src/features/reports/ReportsView.jsx');
const { TaskActivitiesView } = await import('../src/features/reports/TaskActivitiesView.jsx');
const { DateRangeFilter } = await import('../src/components/DateRangeFilter.jsx');
const { TaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');
const { SearchableSelect } = await import('../src/components/SearchableSelect.jsx');
const delay = () => new Promise((resolve) => setTimeout(resolve, 230));

test('Raporlar iki klavye erişimli iç sekme sunar ve Performans görünümü bağlı kalır', () => {
  const view = mountComponent(ReportsView, {});
  try {
    const tab = (id) => findElement(view.output, (node) => node.props?.id === `report-tab-${id}`);
    assert.equal(tab('performance').props.children, 'Performans');
    assert.equal(tab('activities').props.children, 'Görev Hareketleri');
    assert.equal(tab('performance').props['aria-selected'], true);
    assert.ok(findElement(view.output, (node) => node.type === PerformanceReportsView));
    tab('performance').props.onKeyDown({ key: 'End', preventDefault() {} }); view.render();
    assert.equal(tab('activities').props['aria-selected'], true);
    assert.equal(findElement(view.output, (node) => node.props?.id === 'report-panel-performance').props.hidden, true);
    assert.ok(findElement(view.output, (node) => node.type === PerformanceReportsView));
    assert.equal(findElement(view.output, (node) => node.type === TaskActivitiesView).props.active, true);
    tab('activities').props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }); view.render();
    assert.equal(findElement(view.output, (node) => node.type === TaskActivitiesView).props.active, false);
  } finally { view.unmount(); }
});

test('Performans mevcut görev aralığı filtresini ve hesaplama içeriğini korur', () => {
  globalThis[CLIENT_STATE] = { workspace: { tasks: [] } };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const view = mountComponent(PerformanceReportsView, {});
  try {
    const filter = () => findElement(view.output, (node) => node.type === DateRangeFilter);
    assert.ok(filter());
    filter().props.onChange({ preset: 'all', start: '', end: '' }); view.render();
    assert.equal(filter().props.value.preset, 'all');
    assert.ok(findElement(view.output, (node) => node.props?.className?.includes('card')));
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; delete globalThis.document; }
});

test('hareket görünümü sunucu alt kümesini, silinmiş kaydı ve hata durumunu gösterir; filtreler ve sayfa APIye gider', async () => {
  const requests = [], opened = [];
  const originalFetch = globalThis.fetch;
  globalThis[CLIENT_STATE] = { session: { dataMode: 'actual' }, actions: { openTask: async (id) => { opened.push(id); return { ok: true }; } } };
  const row = { id: '1', occurredAt: '2026-09-08T10:00:00Z', actorName: 'Ayşe', projectCode: 'PRJ-123', taskId: 'task', taskTitle: 'Radar', taskAvailable: true,
    changes: ['Durum: Yapılacak → Devam ediyor', 'İlerleme: %20 → %50', 'Termin: 10 Eyl → 12 Eyl'] };
  const data = { items: [row, { ...row, id: '2', taskId: 'deleted', taskTitle: 'Silinen görev', taskAvailable: false }], total: 26, page: 0, pageSize: 25,
    summary: { tasks: 2, people: 1, completed: 0 }, scope: 'team', canViewTeam: true, range: { from: '2026-09-08', to: '2026-09-08' },
    filters: { people: [{ id: '123', name: 'Ayşe', organization: { directorate: 'D' } }], projects: [{ id: 'project', name: 'Radar', code: 'PRJ-123' }] } };
  let fail = false;
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json(fail ? { error: { message: 'İşlem tamamlanamadı.' } } : data, { status: fail ? 500 : 200 }); };
  const view = mountComponent(TaskActivitiesView, { active: true });
  try {
    assert.ok(findElement(view.output, (node) => node.props?.role === 'status'));
    await delay(); view.render();
    assert.match(requests[0], /period=today/);
    const link = findElement(view.output, (node) => node.props?.className === 'detail-task-link');
    await link.props.onClick(); assert.deepEqual(opened, ['task']);
    assert.ok(findElement(view.output, (node) => node.type === 'details'));
    assert.equal(findElement(view.output, (node) => node.type === 'button' && node.props.children === 'Silinen görev'), null);
    const person = findElement(view.output, (node) => node.type === SearchableSelect && node.props.ariaLabel === 'Güncelleyen kişi');
    person.props.onChange('123'); view.render(); await delay(); view.render();
    assert.match(requests.at(-1), /person=123/);
    findElement(view.output, (node) => node.type === TaskTablePagination).props.setPage(1); view.render(); await delay(); view.render();
    assert.match(requests.at(-1), /page=1/);
    fail = true;
    findElement(view.output, (node) => node.type === 'button' && node.props.children === 'Yenile').props.onClick(); view.render(); await delay(); view.render();
    assert.equal(findElement(view.output, (node) => node.props?.role === 'alert').props.children, 'İşlem tamamlanamadı.');
  } finally { view.unmount(); globalThis.fetch = originalFetch; delete globalThis[CLIENT_STATE]; }
});

test('iç içe pencerelerde Escape yalnızca üst pencereyi kapatır; portal tarih seçicide Tab içeride kalır', async () => {
  const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
  const listeners = new Set(), closed = [];
  const element = () => ({ attributes: {}, isConnected: true, offsetParent: {},
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name]; }, focus() { document.activeElement = this; },
    querySelectorAll() { return []; }, contains(active) { return active === this; } });
  const opener = element();
  globalThis.document = { activeElement: opener, addEventListener(type, fn) { listeners.add(fn); }, removeEventListener(type, fn) { listeners.delete(fn); } };
  function Trap(props) { useModalFocusTrap(props); return null; }
  const parentElement = element(), childElement = element();
  const parent = mountComponent(Trap, { containerRef: { current: parentElement }, initialFocusRef: { current: parentElement }, onClose: () => closed.push('parent') });
  const child = mountComponent(Trap, { containerRef: { current: childElement }, initialFocusRef: { current: childElement }, onClose: () => closed.push('child') });
  const press = (key) => { const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const handler of listeners) handler(event); return event; };
  try {
    press('Escape'); assert.deepEqual(closed, ['child']);
    child.unmount();
    assert.equal(document.activeElement, parentElement);
    const portal = element(), first = element(), last = element();
    portal.setAttribute('data-modal-owner', parentElement.getAttribute('data-focus-scope'));
    portal.querySelectorAll = () => [first, last]; portal.contains = () => true;
    last.closest = () => portal; document.activeElement = last;
    assert.equal(press('Tab').defaultPrevented, true); assert.equal(document.activeElement, first);
    press('Escape'); assert.deepEqual(closed, ['child', 'parent']);
  } finally { parent.unmount(); delete globalThis.document; }
});
