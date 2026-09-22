import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { resolveDashboardVariant } from '../src/features/dashboard/dashboardVariant.js';
import { TASK_PRIORITY_FILTER_OPTIONS } from '../src/domain/constants/index.js';

const { KpiTaskModal, KPI_DEFAULT_SORT_KEY } = await import('../src/features/dashboard/KpiTaskModal.jsx');

/**
 * Özet · "Tüm Görevleri Gör" penceresi.
 *
 * Varsayılan sıralama kanonik hedef bitiş alanına göre ESKİDEN YENİYE'dir;
 * alan iki kipte de aynıdır, yalnızca adı değişir (Kapsamlı "Hedef", Temel
 * "Termin"). Tarihi olmayan görev her iki yönde de en altta kalır.
 */

const REFERENCE_DAY = new Date(2026, 8, 20);

const people = [
  { id: '100', name: 'Birinci Kişi', employeeNo: '100', organization: { directorate: 'D1', department: 'M1', unit: 'B1' } },
  { id: '200', name: 'İkinci Kişi', employeeNo: '200', organization: { directorate: 'D2', department: 'M2', unit: 'B2' } }
];

const tasks = [
  { id: 'gec', projectId: 'p1', proje: 'Proje', task: 'Geç görev', keyword: 'K', status: 'todo', priority: 'low', sorumlu: ['Birinci Kişi'], assigneeIds: ['100'], targetFinish: '2026-12-01' },
  { id: 'erken', projectId: 'p1', proje: 'Proje', task: 'Erken görev', keyword: 'K', status: 'todo', priority: 'critical', sorumlu: ['İkinci Kişi'], assigneeIds: ['200'], targetFinish: '2026-09-25' },
  { id: 'orta', projectId: 'p1', proje: 'Proje', task: 'Orta görev', keyword: 'K', status: 'in_progress', priority: 'high', sorumlu: ['Birinci Kişi'], assigneeIds: ['100'], targetFinish: '2026-10-15' },
  { id: 'tarihsiz', projectId: 'p1', proje: 'Proje', task: 'Tarihsiz görev', keyword: 'K', status: 'todo', priority: 'normal', sorumlu: ['Birinci Kişi'], assigneeIds: ['100'] }
];

const rows = (view) => findElement(view.output, (node) => node.type === 'tbody').props.children;
const headerLabels = (view) => findElement(view.output, (node) => node.type === 'thead')
  .props.children.props.children.map((column) => column.props.label);
const column = (view, label) => findElement(view.output, (node) => node.props?.label === label);

function withModal(variant, run) {
  globalThis[CLIENT_STATE] = { selectedTask: null, people };
  const view = mountComponent(KpiTaskModal, {
    title: 'Toplam görev', tasks, variant, referenceDay: REFERENCE_DAY, onClose() {}, onOpenTask() {}
  });
  try { run(view); } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
}

test('varsayılan sıralama anahtarı iki kipte de kanonik hedef bitiş alanıdır', () => {
  assert.equal(KPI_DEFAULT_SORT_KEY, 'targetFinish');
  assert.equal(resolveDashboardVariant('advanced').kpiDefaultSortKey, 'targetFinish');
  assert.equal(resolveDashboardVariant('simple').kpiDefaultSortKey, 'targetFinish');
  // Sütun ADI kipe göre değişir; alan aynıdır.
  assert.equal(resolveDashboardVariant('advanced').kpiColumns.find((col) => col.key === 'targetFinish').label, 'Hedef');
  assert.equal(resolveDashboardVariant('simple').kpiColumns.find((col) => col.key === 'targetFinish').label, 'Termin');
});

test('Kapsamlı pencere Hedefe göre eskiden yeniye açılır ve tarihsiz görev en altta kalır', () => {
  withModal('advanced', (view) => {
    assert.deepEqual(rows(view).map((row) => row.key), ['erken', 'orta', 'gec', 'tarihsiz']);
    // Kullanıcı sıralamayı değiştirebilir; tarihsiz görev yine en altta kalır.
    column(view, 'Hedef').props.onSort('desc'); view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['gec', 'orta', 'erken', 'tarihsiz']);
  });
});

test('Temel pencere Termine göre eskiden yeniye açılır', () => {
  withModal('simple', (view) => {
    assert.deepEqual(rows(view).map((row) => row.key), ['erken', 'orta', 'gec', 'tarihsiz']);
    column(view, 'Termin').props.onSort('desc'); view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['gec', 'orta', 'erken', 'tarihsiz']);
  });
});

test('Öncelik sütunu iki kipte de görünür ve kanonik öncelik modelini kullanır', () => {
  withModal('advanced', (view) => {
    assert.deepEqual(headerLabels(view), ['Görev', 'Proje', 'Sorumlu', 'Durum', 'Öncelik', 'Başlangıç', 'Bitiş', 'Hedef']);
    const priority = column(view, 'Öncelik');
    assert.equal(priority.props.filterType, 'multi');
    // Seçenekler kanonik öncelik kataloğundan türetilir; ikinci bir model yoktur.
    const allowed = new Set(TASK_PRIORITY_FILTER_OPTIONS.map((option) => option.id));
    for (const option of priority.props.filterOptions) assert.equal(allowed.has(option.value), true);
  });
  withModal('simple', (view) => {
    assert.equal(headerLabels(view).includes('Öncelik'), true);
  });
});

test('Öncelik süzgeci ve sıralaması çalışır', () => {
  withModal('advanced', (view) => {
    column(view, 'Öncelik').props.onFilter(['critical']); view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['erken']);
    column(view, 'Öncelik').props.onFilter([]); view.render();

    column(view, 'Öncelik').props.onSort('asc'); view.render();
    // Kanonik öncelik sırası: kritik en üstte.
    assert.deepEqual(rows(view).map((row) => row.key)[0], 'erken');
    column(view, 'Öncelik').props.onSort('desc'); view.render();
    assert.deepEqual(rows(view).map((row) => row.key)[0], 'gec');
  });
});

test('Filtreleri Temizle varsayılan sıralamayı geri getirir', () => {
  withModal('advanced', (view) => {
    column(view, 'Hedef').props.onSort('desc'); view.render();
    assert.deepEqual(rows(view).map((row) => row.key)[0], 'gec');
    findElement(view.output, (node) => node.type === 'button'
      && Array.isArray(node.props.children) && node.props.children.includes(' Filtreleri Temizle')).props.onClick();
    view.render();
    assert.deepEqual(rows(view).map((row) => row.key), ['erken', 'orta', 'gec', 'tarihsiz']);
  });
});

test('Temel Kip sınırları korunur: plan tarihi sütunları açılmaz', () => {
  withModal('simple', (view) => {
    for (const label of ['Başlangıç', 'Bitiş', 'Hedef', 'İlerleme']) {
      assert.equal(column(view, label), null, `${label} sütunu Temel Kipte çizilmemelidir`);
    }
  });
});
