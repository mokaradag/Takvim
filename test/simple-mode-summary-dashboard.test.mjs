import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import {
  ADMIN_NAV_IDS,
  NAV_ITEMS,
  SIMPLE_LANDING_VIEW,
  SIMPLE_NAV_IDS,
  navigationItems
} from '../src/components/shell/navigation.js';
import {
  ADVANCED_ONLY_TASK_FIELDS,
  SIMPLE_TASK_COLUMNS
} from '../src/features/tasks/simpleTaskColumns.js';
import {
  STATUS_DISTRIBUTION_BUCKETS,
  selectStatusDistribution
} from '../src/features/dashboard/statusDistribution.js';
import { SIMPLE_QUALITY_CHECK_IDS, selectPlanHygiene } from '../src/features/dashboard/planHealth.js';
import { resolveDashboardVariant } from '../src/features/dashboard/dashboardVariant.js';
import { departmentKey, unitKey } from '../src/domain/organization/organizationHierarchy.js';

const { KpiTaskModal } = await import('../src/features/dashboard/KpiTaskModal.jsx');
const { DashboardView } = await import('../src/features/dashboard/DashboardView.jsx');
const { TaskDate } = await import('../src/features/tasks/TaskDate.jsx');
const { TaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');
const { TaskOrganizationFilterControls } = await import('../src/features/tasks/TaskOrganizationFilterControls.jsx');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const REFERENCE_DAY = new Date(2026, 8, 20);

const people = [
  { id: '100', name: 'Aynı Ad', employeeNo: '100', organization: { directorate: 'D1', department: 'M1', unit: 'B1' } },
  { id: '200', name: 'Aynı Ad', employeeNo: '200', organization: { directorate: 'D2', department: 'M2', unit: 'B2' } }
];

// Gizli planlama alanları bilerek AYRIŞTIRILIR: Temel yüzeyde görünürlerse
// tarihleri yılından tanınır.
const tasks = [
  {
    id: 'a', projectId: 'p1', proje: 'Proje 1', task: 'İlk görev', keyword: 'Teklif',
    sorumlu: ['Aynı Ad'], assigneeIds: ['100'], status: 'todo', priority: 'high',
    plannedStart: '2011-01-05', plannedFinish: '2012-02-06', actualStart: '2013-03-07',
    progress: 37, wbsId: 'w1', deps: ['b'], targetFinish: '2026-09-25'
  },
  {
    id: 'b', projectId: 'p2', proje: 'Proje 2', task: 'İkinci görev', keyword: 'Sözleşme',
    sorumlu: ['Aynı Ad'], assigneeIds: ['200'], status: 'done', priority: 'low',
    plannedStart: '2011-04-05', plannedFinish: '2012-05-06', actualFinish: '2014-06-08',
    progress: 41, wbsId: 'w2', targetFinish: '2026-09-15'
  }
];

const rows = (view) => findElement(view.output, (node) => node.type === 'tbody').props.children;
const column = (view, label) => findElement(view.output, (node) => node.props?.label === label && node.props?.onFilter);
const headerLabels = (view) => findElement(view.output, (node) => node.type === 'thead')
  .props.children.props.children.map((cell) => cell.props.label);

function withSimpleModal(run, props = {}) {
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  const view = mountComponent(KpiTaskModal, {
    title: 'Toplam görev', tasks, variant: 'simple',
    referenceDay: REFERENCE_DAY, onClose() {}, onOpenTask() {}, ...props
  });
  try { run(view); } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
}

/* ── 1. Gezinme ve açılış sayfası ───────────────────────────────── */

test('Temel Kip gezinmesi Özet ile başlar ve Kapsamlı gezinme değişmez', () => {
  assert.ok(SIMPLE_NAV_IDS.has('ozet'));
  assert.equal(SIMPLE_LANDING_VIEW, 'ozet');
  assert.deepEqual(
    navigationItems(true, false).map((item) => item.label),
    ['Özet', 'Görevler', 'Talepler', 'Takvim', 'Kullanım Rehberi', 'Ayarlar']
  );
  // Yönetici davranışı korunur: sayfa yalnızca sistem yöneticisine açılır.
  assert.equal(navigationItems(true, false).some((item) => ADMIN_NAV_IDS.has(item.id)), false);
  assert.ok(navigationItems(true, true).some((item) => item.id === 'sistem'));
  // Kapsamlı gezinme yönetici sayfası dışında bütün sayfaları taşımaya devam eder.
  assert.deepEqual(
    navigationItems(false, false).map((item) => item.id),
    NAV_ITEMS.filter((item) => !ADMIN_NAV_IDS.has(item.id)).map((item) => item.id)
  );
});

test('Temel Kip seçimi Özet sayfasına iner ve Özet kip profiliyle çizilir', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /if \(mode === 'simple'\) \{[\s\S]*?navigate\(SIMPLE_LANDING_VIEW\);/);
  assert.match(shell, /if \(!SIMPLE_NAV_IDS\.has\(view\) && !ADMIN_NAV_IDS\.has\(view\)\) navigate\(SIMPLE_LANDING_VIEW\);/);
  assert.match(shell, /case 'ozet': return <DashboardView variant=\{simpleMode \? 'simple' : 'advanced'\} onNavigate=\{navigate\} \/>;/);
  // Görev ayrıntısı Temel Kipte sade panelden açılır: pano ayrı bir bileşen
  // kurmaz, ortak `openTask` eylemini kullanır.
  assert.match(read('src/features/dashboard/DashboardView.jsx'), /const \{ openTask: onOpenTask \} = useTaskActions\(\);/);
  assert.match(shell, /<TaskDetailOverlay simple=\{simpleMode\} \/>/);
  assert.match(read('src/features/task-detail/TaskDetailOverlay.jsx'), /simple \? <SimpleTaskDrawer \{\.\.\.common\} \/>/);
});

/* ── 2. Durum sınıflandırması ────────────────────────────────────── */

test('Geciken kovası kanonik sınıflandırmayı kullanır ve kovalar birbirini dışlar', () => {
  const sample = [
    { id: 'dun', status: 'todo', targetFinish: '2026-09-19' },
    { id: 'bugun', status: 'todo', targetFinish: '2026-09-20' },
    { id: 'suren-dun', status: 'in_progress', targetFinish: '2026-09-19' },
    { id: 'biten-gecmis', status: 'done', targetFinish: '2026-01-01' },
    { id: 'terminsiz', status: 'todo' },
    { id: 'suren', status: 'in_progress', targetFinish: '2026-12-01' }
  ];
  const distribution = selectStatusDistribution(sample, REFERENCE_DAY);
  const bucketOf = (id) => distribution.segments
    .find((segment) => segment.items.some((task) => task.id === id))?.id;

  assert.equal(bucketOf('dun'), 'overdue');
  assert.notEqual(bucketOf('bugun'), 'overdue');
  assert.equal(bucketOf('bugun'), 'todo');
  assert.equal(bucketOf('suren-dun'), 'overdue');
  assert.equal(bucketOf('biten-gecmis'), 'done');
  assert.notEqual(bucketOf('terminsiz'), 'overdue');
  assert.equal(bucketOf('suren'), 'in_progress');

  // Bir görev tam olarak BİR kovaya girer ve kovaların toplamı toplam görevdir.
  const seen = distribution.segments.flatMap((segment) => segment.items.map((task) => task.id));
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(distribution.total, sample.length);
  assert.equal(distribution.segments.reduce((sum, segment) => sum + segment.value, 0), sample.length);
  assert.deepEqual(
    distribution.segments.map((segment) => segment.id).sort(),
    STATUS_DISTRIBUTION_BUCKETS.map((bucket) => bucket.id).sort()
  );
});

/* ── 3. Temel KPI penceresi ──────────────────────────────────────── */

test('Temel KPI sütunları Görevler sayfasının sözleşmesinden türer', () => {
  const simple = resolveDashboardVariant('simple');
  assert.deepEqual(simple.kpiColumns.map((col) => col.key), SIMPLE_TASK_COLUMNS.map((col) => col.field));
  assert.deepEqual(simple.kpiColumns.map((col) => col.label), SIMPLE_TASK_COLUMNS.map((col) => col.label));
  for (const field of ADVANCED_ONLY_TASK_FIELDS) {
    assert.equal(simple.kpiColumns.some((col) => col.key === field), false, `${field} Temel KPI penceresinde olmamalıdır`);
  }
  // Bilinmeyen değer Kapsamlı profile düşer; Temel sınırı kazayla açılmaz.
  assert.equal(resolveDashboardVariant('bilinmeyen').id, 'advanced');
  assert.equal(resolveDashboardVariant().id, 'advanced');
});

test('Temel KPI penceresi yalnızca Temel sütunlarını çizer', () => withSimpleModal((view) => {
  assert.deepEqual(headerLabels(view), ['Proje', 'Görev', 'Kısa açıklama', 'Sorumlular', 'Öncelik', 'Durum', 'Termin']);
  for (const label of ['Başlangıç', 'Bitiş', 'Hedef', 'İlerleme']) {
    assert.equal(column(view, label), null, `${label} sütunu Temel Kipte çizilmemelidir`);
  }
  // Hücreler de sade alan kümesidir: gizli planlama alanı DOM'a hiç girmez.
  const cellKeys = [...new Set(rows(view).flatMap((row) => row.props.children.map((cell) => cell.key)))];
  assert.deepEqual(cellKeys, SIMPLE_TASK_COLUMNS.map((col) => col.field));
  for (const field of ADVANCED_ONLY_TASK_FIELDS) assert.equal(cellKeys.includes(field), false, field);
  // Tek tarih hücresi Termin'dir.
  const dateFields = new Set();
  const collectDates = (node) => {
    if (Array.isArray(node)) { node.forEach(collectDates); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === TaskDate) dateFields.add(node.props.field);
    collectDates(node.props?.children);
  };
  collectDates(rows(view));
  assert.deepEqual([...dateFields], ['targetFinish']);
  // Planlanan/gerçekleşen tarih açıklaması Temel Kipte anlamsızdır.
  assert.equal(findElement(view.output, (node) => node.type === TaskTablePagination).props.showDateLegend, false);
}));

test('Temel KPI penceresi sütun süzgeçlerini, Sicil ayrımını ve sayfalamayı korur', () => withSimpleModal((view) => {
  // Varsayılan sıralama TERMİN alanına göre eskiden yeniye: 'b' (15 Eylül)
  // 'a'dan (25 Eylül) önce gelir.
  assert.deepEqual(rows(view).map((row) => row.key), ['b', 'a']);

  column(view, 'Kısa açıklama').props.onFilter(['Teklif']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  column(view, 'Kısa açıklama').props.onFilter([]);

  column(view, 'Öncelik').props.onFilter(['low']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Öncelik').props.onFilter([]);

  column(view, 'Termin').props.onFilter({ mode: 'before', to: '2026-09-20' }); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Termin').props.onFilter(null);

  column(view, 'Durum').props.onFilter(['done']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Durum').props.onFilter([]);

  column(view, 'Görev').props.onFilter('İLK'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  column(view, 'Görev').props.onFilter(''); view.render();

  // Aynı adı taşıyan iki kişi Sicil ile ayrılır; ad eşleşmesi kullanılmaz.
  assert.deepEqual(column(view, 'Sorumlular').props.filterOptions.map((option) => option.value), ['100', '200']);
  column(view, 'Sorumlular').props.onFilter(['200']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b']);
  column(view, 'Sorumlular').props.onFilter([]); view.render();

  column(view, 'Proje').props.onFilter(['p1']); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  // Çapraz fasetler korunur: süzülen projede yalnızca o projenin sorumlusu kalır.
  assert.deepEqual(column(view, 'Sorumlular').props.filterOptions.map((option) => option.value), ['100']);

  // Sıralama sade alanlarda da çalışır.
  column(view, 'Proje').props.onFilter([]); view.render();
  column(view, 'Öncelik').props.onSort('asc'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['a', 'b']);
  column(view, 'Öncelik').props.onSort('desc'); view.render();
  assert.deepEqual(rows(view).map((row) => row.key), ['b', 'a']);
}));

test('Temel KPI penceresi kurumsal süzgeci, temizlemeyi ve görev açmayı korur', () => {
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  let opened = null;
  const view = mountComponent(KpiTaskModal, {
    title: 'Toplam görev', tasks, variant: 'simple', referenceDay: REFERENCE_DAY,
    onClose() {}, onOpenTask: (task) => { opened = task; }
  });
  try {
    const organization = () => findElement(view.output, (node) => node.type === TaskOrganizationFilterControls).props.organization;
    organization().selectLevel('directorate', 'D1'); view.render();
    organization().selectLevel('department', departmentKey(people[0])); view.render();
    organization().selectLevel('unit', unitKey(people[0])); view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['a']);

    column(view, 'Görev').props.onFilter('eşleşmeyen'); view.render();
    assert.equal(rows(view).length, 0);
    findElement(view.output, (node) => node.type === 'button'
      && Array.isArray(node.props.children) && node.props.children.includes(' Filtreleri Temizle')).props.onClick();
    view.render();
    assert.equal(rows(view).length, 2);
    assert.equal(organization().selection.directorate, '');

    // Temizleme varsayılan sıralamaya döner: en yakın terminli görev başta.
    findElement(view.output, (node) => node.props?.className === 'detail-task-link').props.onClick();
    assert.equal(opened.id, 'b');
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});

test('Temel KPI penceresi yüzlük sayfalanır', () => {
  const many = Array.from({ length: 125 }, (_, id) => ({
    id: String(id), task: `Görev ${id}`, proje: 'Proje', projectId: 'p1',
    sorumlu: ['Aynı Ad'], assigneeIds: ['100'], status: 'todo', targetFinish: '2026-12-01'
  }));
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  const view = mountComponent(KpiTaskModal, {
    title: 'Toplam görev', tasks: many, variant: 'simple', referenceDay: REFERENCE_DAY, onClose() {}, onOpenTask() {}
  });
  try {
    const pagination = () => findElement(view.output, (node) => node.type === TaskTablePagination);
    assert.equal(pagination().props.pageCount, 2);
    assert.equal(rows(view).length, 100);
    pagination().props.setPage(1); view.render();
    assert.equal(rows(view).length, 25);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});

test('Kapsamlı KPI penceresi zengin sütunlarını ve etkin tarih açıklamasını korur', () => {
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  const view = mountComponent(KpiTaskModal, {
    title: 'Toplam görev', tasks, referenceDay: REFERENCE_DAY, onClose() {}, onOpenTask() {}
  });
  try {
    assert.deepEqual(headerLabels(view), ['Görev', 'Proje', 'Sorumlu', 'Durum', 'Öncelik', 'Başlangıç', 'Bitiş', 'Hedef']);
    assert.equal(findElement(view.output, (node) => node.type === TaskTablePagination).props.showDateLegend, true);
    // Gerçekleşen başlangıç planı ezer: etkin tarih davranışı sürer.
    column(view, 'Başlangıç').props.onFilter({ mode: 'range', from: '2013-03-07', to: '2013-03-07' }); view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['a']);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});

/* ── 4. Pano sınırı ──────────────────────────────────────────────── */

const NODE_PROPS = ['children', 'info', 'content', 'summary', 'tip', 'subtitle', 'right', 'title', 'label'];

function dashboardText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) dashboardText(item, out); return out; }
  if (typeof node !== 'object' || !node.props) return out;
  for (const key of NODE_PROPS) if (key in node.props) dashboardText(node.props[key], out);
  return out;
}

function withDashboard(variant, run) {
  globalThis[CLIENT_STATE] = {
    workspace: { tasks },
    people,
    actions: {}
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const view = mountComponent(DashboardView, { variant, onNavigate() {} });
  try { run(view, dashboardText(view.output).join(' ')); }
  finally { view.unmount(); delete globalThis[CLIENT_STATE]; delete globalThis.document; }
}

test('Temel Özet kapsamlı planlama kavramlarını göstermez', () => withDashboard('simple', (view, text) => {
  for (const forbidden of [
    'Plan bütünlüğü', 'Bağımlılık riski', 'bağımlılık', 'Portföy sağlığı', 'RAG', 'PMO',
    'İlerleme', 'planlanan', 'Planlanan', 'gerçekleşen bitiş', 'kritik yol', 'dağılım ağac', 'Raporlar', 'Hedef tarihi'
  ]) {
    assert.equal(text.includes(forbidden), false, `Temel Özet "${forbidden}" ifadesini içermemelidir`);
  }
  // Temel karşılıkları yerinde durur.
  for (const expected of [
    'Termin aralığı', 'Yeni Görev', 'Proje durumu', 'Tamamlanma', 'Görev kalitesi',
    'Termini geçmiş', 'tamamlandığı gün grafiğe eklenir', 'Gecikme yaşlandırması',
    'Tamamlanma eğilimi', 'Bu hafta tamamlanan', 'Ekip iş yükü', 'Yaklaşan teslimler', 'Durum dağılımı'
  ]) {
    assert.ok(text.includes(expected), `Temel Özet "${expected}" içermelidir`);
  }
}));

test('Temel Özet + Yeni Görev eylemi Hızlı Görev Tanımı sekmesine gider', () => {
  globalThis[CLIENT_STATE] = { workspace: { tasks }, people, actions: {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const visited = [];
  const view = mountComponent(DashboardView, { variant: 'simple', onNavigate: (...args) => visited.push(args) });
  try {
    findElement(view.output, (node) => node.props?.className === 'dashboard-actions')
      .props.children.props.onClick();
    assert.deepEqual(visited, [['takvim', 'entry']]);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; delete globalThis.document; }
});

test('Kapsamlı Özet mevcut ileri kartlarını korur', () => withDashboard('advanced', (view, text) => {
  for (const expected of [
    'Plan bütünlüğü', 'Portföy sağlığı', 'RAG', 'Tarih aralığı', 'İlerleme',
    'gerçekleşen bitiş tarihinde sayılır', 'Hedef tarihi', 'Raporlar'
  ]) {
    assert.ok(text.includes(expected), `Kapsamlı Özet "${expected}" içermelidir`);
  }
  assert.equal(findElement(view.output, (node) => node.props?.className === 'dashboard-actions'), null);
}));

/* ── 5. Görev kalitesi kartı ─────────────────────────────────────── */

test('Görev kalitesi yalnızca Temel Kipte görünen alanları denetler', () => {
  const open = [
    { id: 'x', status: 'todo', assigneeIds: ['100'], targetFinish: '2026-10-01', keyword: '' },
    { id: 'y', status: 'todo', assigneeIds: [], targetFinish: '2026-10-02' },
    { id: 'z', status: 'todo', assigneeIds: ['200'] }
  ];
  const quality = selectPlanHygiene(open, people, SIMPLE_QUALITY_CHECK_IDS);
  assert.deepEqual(quality.checks.map((check) => check.id), ['assignee', 'targetFinish']);
  assert.deepEqual(quality.checks.map((check) => check.value), [1, 1]);
  assert.equal(quality.openCount, 3);
  // Kısa açıklama isteğe bağlıdır: eksik sayılmaz.
  assert.equal(quality.cleanCount, 1);
  // Kapsamlı denetimler dokunulmadan durur.
  assert.deepEqual(
    selectPlanHygiene(open, people).checks.map((check) => check.id),
    ['assignee', 'targetFinish', 'schedule', 'wbs']
  );
});
