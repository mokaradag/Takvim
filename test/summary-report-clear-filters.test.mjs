import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { createEmptyOrgFilter, departmentKey, unitKey } from '../src/domain/organization/organizationHierarchy.js';
import { filterTasksByDateRange, resolveDateRangeSelection } from '../src/features/shared/dateRangeFilter.js';
const { DateRangeFilter } = await import('../src/components/DateRangeFilter.jsx');
const { TaskOrganizationFilterProvider } = await import('../src/features/tasks/TaskOrganizationFilterContext.jsx');
const { TaskOrganizationFilterControls } = await import('../src/features/tasks/TaskOrganizationFilterControls.jsx');
const { TaskActivitiesView } = await import('../src/features/reports/TaskActivitiesView.jsx');
const { SearchableSelect } = await import('../src/components/SearchableSelect.jsx');
const { DateInput } = await import('../src/components/DateInput.jsx');
const { TaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');

const clearButton = (tree) => findElement(tree, (node) => node.type === 'button' && JSON.stringify(node.props.children).includes('Filtreleri Temizle'));
const person = { id: '101', name: 'Ayşe', organization: { directorate: 'D', department: 'M', unit: 'B' } };
const org = { directorate: 'D', department: departmentKey(person), unit: unitKey(person) };

for (const [selection, range, visible] of [
  [createEmptyOrgFilter(), { preset: 'all', start: '', end: '' }, false],
  [createEmptyOrgFilter(), { preset: 'last30', start: '', end: '' }, true],
  [org, { preset: 'all', start: '', end: '' }, true],
  [org, { preset: 'custom', start: '2026-09-01', end: '2026-09-30' }, true],
  [createEmptyOrgFilter(), { preset: 'all', start: '2026-09-01', end: '' }, true]
]) {
  test(`Özet/Raporlar ortak filtre temizleme: ${JSON.stringify([selection, range])}`, (t) => {
    const tasks = [{ id: 'visible', assigneeIds: ['101'], targetFinish: '2026-09-15' }, { id: 'other', assigneeIds: ['102'], targetFinish: '2026-01-01' }];
    const session = { sicil: '101', projectAccess: [{ projectId: 'allowed', accessLevel: 'READ' }] };
    globalThis[CLIENT_STATE] = { workspace: { tasks }, tasks: [...tasks, { id: 'unauthorized', assigneeIds: ['101'] }], people: [person, { id: '102', organization: { directorate: 'E' } }], session };
    const provider = mountComponent(TaskOrganizationFilterProvider, { initialSelection: selection });
    const context = provider.output.type._context;
    const previous = context._currentValue;
    const syncContext = () => { provider.render(); context._currentValue = provider.output.props.value; };
    syncContext();
    let value = { ...range };
    const onChange = (next) => { value = next; };
    const view = mountComponent(DateRangeFilter, { value, onChange });
    const render = () => { syncContext(); view.render({ value, onChange }); };
    t.after(() => { view.unmount(); provider.unmount(); context._currentValue = previous; delete globalThis[CLIENT_STATE]; });
    render();
    assert.equal(Boolean(clearButton(view.output)), visible);
    if (!visible) return;
    const button = clearButton(view.output);
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.className, 'btn ghost sm');
    assert.notEqual(button.props.tabIndex, -1);
    button.props.onClick(); render(); render();
    assert.deepEqual(value, { preset: 'all', start: '', end: '' });
    assert.deepEqual(context._currentValue.selection, createEmptyOrgFilter());
    assert.equal(clearButton(view.output), null);
    assert.equal(Object.hasOwn(value, 'organizationTaskIds'), false);
    assert.deepEqual(filterTasksByDateRange(tasks, resolveDateRangeSelection(value, '2026-09-10')), tasks);
    assert.equal(globalThis[CLIENT_STATE].session, session);
    assert.equal(globalThis[CLIENT_STATE].workspace.tasks, tasks);
    assert.equal(tasks.some((task) => task.id === 'unauthorized'), false);
  });
}

test('Raporlar hareket filtresi temizleme bütün bağımlı seçimleri ve sayfayı sıfırlar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previousFetch = globalThis.fetch;
  const requests = [];
  const session = { dataMode: 'actual', sicil: '101', roles: [] };
  globalThis[CLIENT_STATE] = { session, actions: { openTask() {} } };
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url), 'http://localhost'));
    return Response.json({ items: [], total: 50, page: 0, pageSize: 25, scope: 'mine', canViewTeam: false,
      range: { from: '2026-09-10', to: '2026-09-10' }, summary: { tasks: 0, people: 0, completed: 0 }, filters: { people: [person], projects: [] } });
  };
  const view = mountComponent(TaskActivitiesView, { active: true });
  t.after(() => { view.unmount(); globalThis.fetch = previousFetch; delete globalThis[CLIENT_STATE]; });
  const load = async () => { t.mock.timers.tick(250); await immediate(); view.render(); };
  await load();
  assert.equal(clearButton(view.output), null);
  findElement(view.output, (node) => node.type === SearchableSelect && node.props.ariaLabel === 'Güncelleyen kişi').props.onChange('101'); view.render();
  assert.ok(clearButton(view.output));
  findElement(view.output, (node) => node.type === SearchableSelect && node.props.ariaLabel === 'Hareket projesi').props.onChange('allowed'); view.render();
  findElement(view.output, (node) => node.type === 'select' && node.props.value === 'today').props.onChange({ target: { value: 'custom' } }); view.render();
  findElement(view.output, (node) => node.type === DateInput && node.props.ariaLabel === 'Hareket başlangıç tarihi').props.onChange('2026-09-01'); view.render();
  findElement(view.output, (node) => node.type === DateInput && node.props.ariaLabel === 'Hareket bitiş tarihi').props.onChange('2026-09-30'); view.render();
  findElement(view.output, (node) => node.type === 'select' && node.props.value === 'mine').props.onChange({ target: { value: 'visible' } }); view.render();
  findElement(view.output, (node) => node.type === 'select' && node.props.value === '').props.onChange({ target: { value: 'completed' } }); view.render();
  findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.organization.selectLevel('directorate', 'D'); view.render();
  findElement(view.output, (node) => node.type === TaskTablePagination).props.setPage(1); view.render();
  assert.ok(clearButton(view.output));
  clearButton(view.output).props.onClick(); view.render(); await load();
  assert.equal(clearButton(view.output), null);
  const query = requests.at(-1).searchParams;
  assert.equal(query.get('period'), 'today');
  assert.equal(query.get('page'), '0');
  for (const key of ['person', 'projectId', 'scope', 'from', 'to', 'kind', 'directorate', 'department', 'unit']) assert.ok(!query.get(key), key);
  assert.equal(globalThis[CLIENT_STATE].session, session);
  assert.deepEqual(session.roles, []);
});
