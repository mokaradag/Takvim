import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { transformSync } from 'next/dist/build/swc/index.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  applyOrgSelection,
  createEmptyOrgFilter,
  departmentKey,
  directorateKey,
  orgLevelOptions,
  pruneOrgSelectionForPeople,
  sameOrgSelection,
  unitKey
} from '../src/domain/organization/organizationHierarchy.js';
import {
  createTaskAssigneeOrganizationIndex,
  filterTasksByOrganization,
  organizationPeopleForTasks,
  taskAssigneeOrganizationPeople,
  taskMatchesOrganization
} from '../src/domain/organization/taskOrganizationFilter.js';
import { simpleTaskMatches } from '../src/features/tasks/simpleTaskFacets.js';
import { paginateTaskRows } from '../src/features/tasks/taskTablePagination.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const TEST_APP_STATE_KEY = '__MERGEN_ROTA_TASK_ORGANIZATION_TEST_STATE__';
const APP_STATE_STUB_URL = `data:text/javascript,${encodeURIComponent(`
export function useAppState() {
  const state = globalThis.${TEST_APP_STATE_KEY};
  if (!state) throw new Error('Görev görünümü test durumu bulunamadı.');
  return state;
}
export function useDataLifecycleState() { return {}; }
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)AppStateProvider(?:\.jsx)?$/.test(specifier)) {
      return { url: APP_STATE_STUB_URL, shortCircuit: true };
    }
    if (specifier.startsWith('.') && extname(specifier) === '' && context.parentURL?.startsWith('file:')) {
      const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
      const candidate = [
        `${base}.js`,
        `${base}.jsx`,
        resolve(base, 'index.js'),
        resolve(base, 'index.jsx')
      ].find((path) => existsSync(path));
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const source = transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: {
        parser: { syntax: 'ecmascript', jsx: true },
        transform: { react: { runtime: 'automatic' } },
        target: 'es2022'
      },
      module: { type: 'es6' }
    }).code;
    return { format: 'module', source, shortCircuit: true };
  }
});

function declarationBlock(source, marker) {
  const markerStart = source.indexOf(marker);
  assert.notEqual(markerStart, -1, `${marker} seçicisi bulunmalıdır`);
  const blockStart = source.indexOf('{', markerStart);
  assert.notEqual(blockStart, -1, `${marker} bildirim bloğu bulunmalıdır`);
  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(blockStart + 1, index);
  }
  assert.fail(`${marker} bildirim bloğu kapanmalıdır`);
}

function person(id, name, directorate, department, unit) {
  return { id, name, employeeNo: id, organization: { directorate, department, unit } };
}

const PEOPLE = [
  person('a', 'Ayşe Ak', 'Direktörlük A', 'Ortak Müdürlük', 'Ortak Birim'),
  person('b', 'Bora Bir', 'Direktörlük A', 'Başka Müdürlük', 'İkinci Birim'),
  person('c', 'Cem Can', 'Direktörlük B', 'Ortak Müdürlük', 'Ortak Birim'),
  person('d', 'Deniz Demir', 'Direktörlük B', 'Yönetim Müdürlüğü', 'Üçüncü Birim'),
  person('legacy', 'Eski Sorumlu', 'Direktörlük A', 'Başka Müdürlük', 'Eski Birim'),
  person('dup-1', 'Aynı Ad', 'Direktörlük A', 'Başka Müdürlük', 'İkinci Birim'),
  person('dup-2', 'Aynı Ad', 'Direktörlük B', 'Yönetim Müdürlüğü', 'Üçüncü Birim'),
  person('unused', 'Görevsiz Kişi', 'Direktörlük C', 'Kapsam Dışı Müdürlük', 'Kapsam Dışı Birim')
];

const TASKS = [
  { id: 't-a', projectId: 'p1', task: 'Alfa araması', assigneeIds: ['a'], sorumlu: ['Ayşe Ak'], status: 'todo', priority: 'high' },
  { id: 't-c', projectId: 'p1', task: 'Beta araması', assigneeIds: ['c'], sorumlu: ['Cem Can'], status: 'done', priority: 'low' },
  { id: 't-multi', projectId: 'p1', task: 'Ortak görev', assigneeIds: ['a', 'c'], sorumlu: ['Ayşe Ak', 'Cem Can'], status: 'in_progress', priority: 'medium' },
  { id: 't-d', projectId: 'p1', task: 'Yönetim görevi', assigneeIds: ['d'], sorumlu: ['Deniz Demir'], status: 'todo', priority: 'high' },
  { id: 't-p2', projectId: 'p2', task: 'İkinci proje', assigneeIds: ['b'], sorumlu: ['Bora Bir'], status: 'todo', priority: 'medium' },
  { id: 't-legacy', projectId: 'p1', task: 'Eski görev', assigneeIds: [], sorumlu: ['Eski Sorumlu'], status: 'todo', priority: 'low' },
  { id: 't-ambiguous', projectId: 'p1', task: 'Belirsiz eski görev', assigneeIds: [], sorumlu: ['Aynı Ad'], status: 'todo', priority: 'low' },
  { id: 't-hidden', projectId: 'p1', task: 'Projeksiyon dışı', assigneeIds: ['hidden'], sorumlu: ['Gizli Kişi'], status: 'todo', priority: 'high' }
];

const PROJECTS = [
  { id: 'p1', code: 'P1', name: 'Birinci Proje', accessLevel: 'FULL' },
  { id: 'p2', code: 'P2', name: 'İkinci Proje', accessLevel: 'FULL' }
];

const INDEX = createTaskAssigneeOrganizationIndex(PEOPLE);
const directorateA = applyOrgSelection(createEmptyOrgFilter(), 'directorate', directorateKey(PEOPLE[0]));
const directorateB = applyOrgSelection(createEmptyOrgFilter(), 'directorate', directorateKey(PEOPLE[2]));
const departmentA = applyOrgSelection(createEmptyOrgFilter(), 'department', departmentKey(PEOPLE[0]));
const departmentB = applyOrgSelection(createEmptyOrgFilter(), 'department', departmentKey(PEOPLE[2]));
const unitA = applyOrgSelection(createEmptyOrgFilter(), 'unit', unitKey(PEOPLE[0]));
const unitB = applyOrgSelection(createEmptyOrgFilter(), 'unit', unitKey(PEOPLE[2]));

test('direktörlük, müdürlük ve birim görevleri sorumlu kurumsal yoluyla süzer', () => {
  assert.deepEqual(filterTasksByOrganization(TASKS, directorateA, INDEX).map((task) => task.id), ['t-a', 't-multi', 't-p2', 't-legacy']);
  assert.deepEqual(filterTasksByOrganization(TASKS, departmentA, INDEX).map((task) => task.id), ['t-a', 't-multi']);
  assert.deepEqual(filterTasksByOrganization(TASKS, unitA, INDEX).map((task) => task.id), ['t-a', 't-multi']);
});

test('aynı adlı müdürlük ve birimler farklı üst yollarda çakışmaz', () => {
  assert.notEqual(departmentA.department, departmentB.department);
  assert.notEqual(unitA.unit, unitB.unit);
  assert.deepEqual(filterTasksByOrganization(TASKS, departmentB, INDEX).map((task) => task.id), ['t-c', 't-multi']);
  assert.deepEqual(filterTasksByOrganization(TASKS, unitB, INDEX).map((task) => task.id), ['t-c', 't-multi']);
});

test('çok sorumlulu görevde tek bir eşleşen sorumlu yeterlidir', () => {
  const task = TASKS.find((item) => item.id === 't-multi');
  assert.equal(taskMatchesOrganization(task, directorateA, INDEX), true);
  assert.equal(taskMatchesOrganization(task, directorateB, INDEX), true);
});

test('hiçbir sorumlusu seçili dalda olmayan görev eşleşmez', () => {
  const task = TASKS.find((item) => item.id === 't-d');
  assert.equal(taskMatchesOrganization(task, directorateA, INDEX), false);
});

test('kararlı sorumlu kimliği varken çelişkili görünen ada dönülmez', () => {
  const task = { assigneeIds: ['a'], sorumlu: ['Cem Can'] };
  assert.deepEqual(taskAssigneeOrganizationPeople(task, INDEX).map((item) => item.id), ['a']);
  assert.equal(taskMatchesOrganization(task, directorateA, INDEX), true);
  assert.equal(taskMatchesOrganization(task, directorateB, INDEX), false);
});

test('eski görev adı yalnızca benzersizse güvenli biçimde çözülür', () => {
  const legacy = TASKS.find((item) => item.id === 't-legacy');
  const ambiguous = TASKS.find((item) => item.id === 't-ambiguous');
  assert.deepEqual(taskAssigneeOrganizationPeople(legacy, INDEX).map((item) => item.id), ['legacy']);
  assert.deepEqual(taskAssigneeOrganizationPeople(ambiguous, INDEX), []);
});

test('proje çalışma alanı önce uygulanır ve kurumsal süzgeç yeni görev eklemez', () => {
  const projectOne = TASKS.filter((task) => task.projectId === 'p1');
  const result = filterTasksByOrganization(projectOne, directorateA, INDEX);
  assert.deepEqual(result.map((task) => task.id), ['t-a', 't-multi', 't-legacy']);
  assert.equal(result.some((task) => task.projectId !== 'p1'), false);
});

test('kurumsal kapsam arama ve sorumlu süzgeciyle birlikte çalışır', () => {
  const scoped = filterTasksByOrganization(TASKS, directorateA, INDEX);
  assert.deepEqual(scoped.filter((task) => simpleTaskMatches(task, { search: 'alfa' })).map((task) => task.id), ['t-a']);
  assert.deepEqual(scoped.filter((task) => simpleTaskMatches(task, { filters: { sorumlu: ['c'] } })).map((task) => task.id), ['t-multi']);
});

test('kurumsal kapsam durum ve öncelik süzgeçleriyle birlikte çalışır', () => {
  const scoped = filterTasksByOrganization(TASKS, directorateA, INDEX);
  const result = scoped.filter((task) => simpleTaskMatches(task, { filters: { status: ['todo'], priority: ['high'] } }));
  assert.deepEqual(result.map((task) => task.id), ['t-a']);
});

test('kurumsal süzgeç sayfalamadan önce uygulanır', () => {
  const many = Array.from({ length: 205 }, (_, index) => ({
    id: `many-${index}`,
    assigneeIds: [index % 2 === 0 ? 'a' : 'c']
  }));
  const scoped = filterTasksByOrganization(many, directorateA, INDEX);
  const page = paginateTaskRows(scoped, 1, 50);
  assert.equal(scoped.length, 103);
  assert.equal(page.rows.length, 50);
  assert.equal(page.rows.every((task) => task.assigneeIds[0] === 'a'), true);
});

test('seçenekler yalnızca yetkili çalışma alanı görevlerinin projekte edilmiş sorumlularından gelir', () => {
  const projectOne = TASKS.filter((task) => task.projectId === 'p1');
  const optionPeople = organizationPeopleForTasks(projectOne, INDEX);
  assert.deepEqual(optionPeople.map((item) => item.id), ['a', 'c', 'd', 'legacy']);
  assert.equal(optionPeople.some((item) => item.id === 'unused'), false);
  assert.equal(optionPeople.some((item) => item.id === 'hidden'), false);
  assert.deepEqual(orgLevelOptions(optionPeople, 'directorate').map((option) => option.label), ['Direktörlük A', 'Direktörlük B']);
});

test('yenileme geçerli seçimi korur, kaybolan alt yolu en yakın geçerli üste indirger', () => {
  assert.equal(sameOrgSelection(pruneOrgSelectionForPeople(unitA, PEOPLE), unitA), true);
  const withoutUnit = PEOPLE.filter((item) => item.id !== 'a');
  assert.deepEqual(pruneOrgSelectionForPeople(unitA, withoutUnit), {
    directorate: 'Direktörlük A',
    department: '',
    unit: ''
  });

  const departmentWithTwoUnits = applyOrgSelection(createEmptyOrgFilter(), 'unit', unitKey(PEOPLE[1]));
  const sameDepartmentPerson = person('b2', 'Bora İki', 'Direktörlük A', 'Başka Müdürlük', 'Yeni Birim');
  assert.deepEqual(pruneOrgSelectionForPeople(departmentWithTwoUnits, [sameDepartmentPerson]), {
    directorate: 'Direktörlük A',
    department: departmentKey(sameDepartmentPerson),
    unit: ''
  });
});

test('üst seçim değişikliği geçersiz alt seçimleri temizler', () => {
  const switched = applyOrgSelection(unitA, 'directorate', 'Direktörlük B');
  assert.deepEqual(switched, { directorate: 'Direktörlük B', department: '', unit: '' });
  assert.deepEqual(applyOrgSelection(unitA, 'department', ''), { directorate: 'Direktörlük A', department: '', unit: '' });
});

test('Basit ve Gelişmiş görünüm sağlayıcının aynı kurumsal kapsamını davranışsal olarak uygular', async () => {
  const [contextModule, advancedModule, simpleModule] = await Promise.all([
    import('../src/features/tasks/TaskOrganizationFilterContext.jsx'),
    import('../src/features/tasks/TasksView.jsx'),
    import('../src/features/tasks/SimpleTasksView.jsx')
  ]);
  const { TaskOrganizationFilterProvider } = contextModule;
  const { TasksView } = advancedModule;
  const { SimpleTasksView } = simpleModule;
  globalThis[TEST_APP_STATE_KEY] = {
    tasks: TASKS,
    projects: PROJECTS,
    people: PEOPLE,
    assignableProjects: [],
    assignmentScopeSicils: [],
    currentUser: PEOPLE[0],
    session: { dataMode: 'demo' },
    workspaceMode: 'portfolio',
    selectedProjectId: null,
    workspace: { tasks: TASKS, projects: PROJECTS, people: PEOPLE, wbs: [] },
    actions: {
      addTask() {},
      deleteTask() {},
      flushTaskEdits: async () => ({ ok: true }),
      openTask() {}
    }
  };

  const renderViews = (initialSelection) => renderToStaticMarkup(
    createElement(
      TaskOrganizationFilterProvider,
      { initialSelection },
      createElement('section', { 'data-mode': 'advanced' }, createElement(TasksView)),
      createElement('section', { 'data-mode': 'simple' }, createElement(SimpleTasksView, { onNewTask() {} }))
    )
  );
  const section = (markup, mode) => {
    const match = markup.match(new RegExp(`<section data-mode="${mode}">([\\s\\S]*?)<\\/section>`));
    assert.ok(match, `${mode} görev görünümü render edilmelidir`);
    return match[1];
  };
  const taskIds = (markup) => [...markup.matchAll(/data-task-id="([^"]+)"/g)].map((match) => match[1]);
  const originalConsoleError = console.error;
  console.error = (message, ...args) => {
    if (String(message).startsWith('Warning: useLayoutEffect does nothing on the server')) return;
    originalConsoleError(message, ...args);
  };

  try {
    assert.throws(
      () => renderToStaticMarkup(createElement(TasksView)),
      /Görev kurumsal süzgeç sağlayıcısı bulunamadı/
    );
    const unfilteredMarkup = renderViews(createEmptyOrgFilter());
    const filteredMarkup = renderViews(directorateA);
    const expectedIds = ['t-a', 't-multi', 't-p2', 't-legacy'];
    for (const mode of ['advanced', 'simple']) {
      const unfiltered = section(unfilteredMarkup, mode);
      const filtered = section(filteredMarkup, mode);
      assert.equal(taskIds(unfiltered).length, TASKS.length, mode);
      assert.deepEqual(taskIds(filtered), expectedIds, mode);
      assert.match(filtered, />4 \/ 8 görev</, mode);
    }
  } finally {
    console.error = originalConsoleError;
    delete globalThis[TEST_APP_STATE_KEY];
  }
});

test('filtreleri temizleme iki görünümde kurumsal seçimi de sıfırlar', () => {
  for (const path of ['src/features/tasks/TasksView.jsx', 'src/features/tasks/SimpleTasksView.jsx']) {
    const source = read(path);
    assert.match(source, /onOrganizationFilterChange\(createEmptyOrgFilter\(\)\)/, path);
    assert.match(source, /Filtreleri temizle/, path);
  }
});

test('masaüstü araç çubuğu tek satırdır, dar genişlikte kurumsal açılır panel kullanır', () => {
  const controls = read('src/features/tasks/TaskOrganizationFilterControls.jsx');
  const styles = read('src/app/styles/components.css');
  assert.match(controls, /Direktörlük filtresi/);
  assert.match(controls, /Müdürlük filtresi/);
  assert.match(controls, /Birim filtresi/);
  assert.match(controls, /task-org-overflow/);
  assert.match(controls, /useSyncExternalStore/);
  assert.match(controls, /if \(compactLayout\)/);
  assert.doesNotMatch(
    controls,
    /return\s*\([\s\S]*?\{controls\('direct'\)\}[\s\S]*?\{controls\('compact'\)\}[\s\S]*?\);/
  );
  assert.doesNotMatch(
    controls,
    /return\s*\([\s\S]*?\{controls\('compact'\)\}[\s\S]*?\{controls\('direct'\)\}[\s\S]*?\);/
  );
  assert.match(
    controls,
    /if \(compactLayout\) \{[\s\S]*?\{controls\('compact'\)\}[\s\S]*?\);\s*\}\s*return controls\('direct'\);/
  );

  const toolbarBlock = declarationBlock(styles, '.tasks-toolbar,');
  assert.match(toolbarBlock, /flex-wrap:\s*nowrap;/);
  const compactMediaBlock = declarationBlock(styles, '@media (max-width: 1280px)');
  const directFiltersBlock = declarationBlock(compactMediaBlock, '.task-org-filters-direct');
  assert.match(directFiltersBlock, /display:\s*none;/);
});

test('Ekip ve Görevler aynı ortak kurumsal hiyerarşi modülünü tüketir', () => {
  const team = read('src/features/team/TeamView.jsx');
  const taskHook = read('src/features/tasks/useTaskOrganizationFilter.js');
  assert.match(team, /domain\/organization\/organizationHierarchy\.js/);
  assert.match(taskHook, /domain\/organization\/organizationHierarchy\.js/);
});

test('kurumsal alanlar görev tablolarına kalıcı sütun olarak eklenmez', () => {
  for (const path of ['src/features/tasks/TasksView.jsx', 'src/features/tasks/SimpleTasksView.jsx']) {
    const source = read(path);
    const tableStart = source.indexOf('<table');
    assert.notEqual(tableStart, -1, `${path} tablo oluşturmalıdır`);
    const table = source.slice(tableStart);
    assert.doesNotMatch(table, /FilterableTH label="Direktörlük"/);
    assert.doesNotMatch(table, /FilterableTH label="Müdürlük"/);
    assert.doesNotMatch(table, /FilterableTH label="Birim"/);
  }
});
