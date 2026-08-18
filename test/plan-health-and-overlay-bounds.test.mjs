/**
 * Plan sağlığı göstergeleri, üst katman yerleşimi ve yazı ölçeği sınırları.
 *
 * Kapsanan konular:
 *   1. Gecikme yaşlandırması ve plan bütünlüğü seçicileri
 *   2. Açılır panel / süzgeç kutusu yerleşimi görünüm alanının dışına taşamaz
 *   3. Yazı boyutu ölçeği: tam ekran kaplar `100vh` yerine ölçekli yükseklik
 *      kullanır, panel alt çubuğu ekranın dışına itilmez
 *   4. Ardıl görev düzenleme ilkeleri
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OVERDUE_AGING_BUCKETS,
  PLAN_HYGIENE_CHECKS,
  selectOverdueAging,
  selectPlanHygiene
} from '../src/features/dashboard/planHealth.js';
import {
  MAX_LIST_HEIGHT,
  MIN_LIST_HEIGHT,
  PANEL_CHROME_HEIGHT,
  VIEWPORT_MARGIN,
  computePopoverPlacement
} from '../src/components/searchableSelectPlacement.js';
import { clampOverlayToViewport } from '../src/components/overlayPlacement.js';
import {
  collectPredecessorClosure,
  planSuccessorLink,
  planSuccessorUnlink,
  planSuccessorUpdate,
  selectSuccessors
} from '../src/features/task-detail/taskSuccessorPolicy.js';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const TODAY = new Date(2026, 7, 18);

function lateTask(id, daysLate, overrides = {}) {
  const target = new Date(2026, 7, 18 - daysLate);
  const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  return {
    id,
    task: `Görev ${id}`,
    status: 'todo',
    targetFinish: iso,
    plannedStart: '2026-01-01',
    plannedFinish: '2026-01-05',
    wbsId: 'w1',
    assigneeIds: ['1'],
    sorumlu: ['Kişi'],
    ...overrides
  };
}

/* ── 1. Gecikme yaşlandırması ───────────────────────────────────── */

test('geciken görevler gecikme YAŞINA göre kovalara ayrılır', () => {
  const aging = selectOverdueAging([
    lateTask('a', 1),
    lateTask('b', 7),
    lateTask('c', 8),
    lateTask('d', 30),
    lateTask('e', 31),
    lateTask('f', 90),
    lateTask('g', 91),
    lateTask('h', 400)
  ], TODAY);

  assert.equal(aging.total, 8);
  assert.equal(aging.worstDays, 400);
  assert.deepEqual(
    aging.buckets.map((bucket) => [bucket.id, bucket.value]),
    [['fresh', 2], ['stale', 2], ['critical', 2], ['chronic', 2]]
  );
});

test('kovaların toplamı geciken görev sayısına eşittir: hiçbir görev iki kovaya düşemez', () => {
  const tasks = Array.from({ length: 40 }, (_, index) => lateTask(`t${index}`, index + 1));
  const aging = selectOverdueAging(tasks, TODAY);
  const sum = aging.buckets.reduce((total, bucket) => total + bucket.value, 0);
  assert.equal(sum, aging.total);
  assert.equal(sum, tasks.length);
});

test('tamamlanmış, terminsiz ve henüz gecikmemiş görevler yaşlandırmaya girmez', () => {
  const aging = selectOverdueAging([
    lateTask('done', 10, { status: 'done' }),
    lateTask('bugun', 0),
    { id: 'terminsiz', status: 'todo', targetFinish: null },
    { id: 'gelecek', status: 'todo', targetFinish: '2026-12-31' }
  ], TODAY);

  assert.equal(aging.total, 0);
  assert.equal(aging.worstDays, 0);
});

test('yaşlandırma kovaları aralık bakımından bitişik ve örtüşmesizdir', () => {
  for (let index = 1; index < OVERDUE_AGING_BUCKETS.length; index += 1) {
    assert.equal(OVERDUE_AGING_BUCKETS[index].min, OVERDUE_AGING_BUCKETS[index - 1].max + 1);
  }
  assert.equal(OVERDUE_AGING_BUCKETS[0].min, 1);
  assert.equal(OVERDUE_AGING_BUCKETS.at(-1).max, Number.POSITIVE_INFINITY);
});

test('kova içindeki görevler en eskiden yeniye sıralanır', () => {
  const aging = selectOverdueAging([lateTask('a', 2), lateTask('b', 6), lateTask('c', 4)], TODAY);
  assert.deepEqual(aging.buckets[0].items.map((task) => task.id), ['b', 'c', 'a']);
});

/* ── 2. Plan bütünlüğü ──────────────────────────────────────────── */

test('plan bütünlüğü YALNIZCA açık görevleri denetler', () => {
  const hygiene = selectPlanHygiene([
    { id: 'kapali', status: 'done', assigneeIds: [], sorumlu: [], targetFinish: null, wbsId: null },
    lateTask('acik', 3)
  ]);

  assert.equal(hygiene.openCount, 1);
  assert.equal(hygiene.cleanCount, 1);
  for (const check of hygiene.checks) assert.equal(check.value, 0);
});

test('eksik alan taşıyan açık görevler ilgili denetimde listelenir', () => {
  const hygiene = selectPlanHygiene([
    { id: 'sorumlusuz', status: 'todo', assigneeIds: [], sorumlu: [], targetFinish: '2026-09-01', plannedStart: '2026-08-01', plannedFinish: '2026-08-05', wbsId: 'w' },
    { id: 'terminsiz', status: 'todo', assigneeIds: ['1'], sorumlu: ['A'], targetFinish: null, plannedStart: '2026-08-01', plannedFinish: '2026-08-05', wbsId: 'w' },
    { id: 'tarihsiz', status: 'todo', assigneeIds: ['1'], sorumlu: ['A'], targetFinish: '2026-09-01', plannedStart: null, plannedFinish: null, wbsId: 'w' },
    { id: 'wbssiz', status: 'todo', assigneeIds: ['1'], sorumlu: ['A'], targetFinish: '2026-09-01', plannedStart: '2026-08-01', plannedFinish: '2026-08-05', wbsId: null }
  ]);

  const byId = new Map(hygiene.checks.map((check) => [check.id, check]));
  assert.deepEqual(byId.get('assignee').items.map((task) => task.id), ['sorumlusuz']);
  assert.deepEqual(byId.get('targetFinish').items.map((task) => task.id), ['terminsiz']);
  assert.deepEqual(byId.get('schedule').items.map((task) => task.id), ['tarihsiz']);
  assert.deepEqual(byId.get('wbs').items.map((task) => task.id), ['wbssiz']);
  assert.equal(hygiene.cleanCount, 0);
});

test('birden çok denetimde eksik çıkan görev TEK kez eksik sayılır', () => {
  // `cleanCount` görev sayar, bulgu değil: aksi hâlde iki alanı eksik olan bir
  // görev "eksiksiz" sayısını iki birim düşürür ve oran %100'ün altına düşerdi.
  const hygiene = selectPlanHygiene([
    { id: 'coklu', status: 'todo', assigneeIds: [], sorumlu: [], targetFinish: null, plannedStart: null, plannedFinish: null, wbsId: null },
    lateTask('temiz', 1)
  ]);
  assert.equal(hygiene.openCount, 2);
  assert.equal(hygiene.cleanCount, 1);
});

test('her plan bütünlüğü denetimi açıklama taşır', () => {
  for (const check of PLAN_HYGIENE_CHECKS) {
    assert.ok(check.label.length > 0);
    assert.ok(check.explain.length > 0);
    assert.equal(typeof check.isMissing, 'function');
  }
});

/* ── 3. Açılır panel yerleşimi ──────────────────────────────────── */

const VIEWPORT = { width: 1440, height: 900 };

test('açılır panel görünüm alanının altına taşmaz', () => {
  // Tetikleyici ekranın en altına yakın: panelin tamamı kalan boşluğa sığmalı.
  const placement = computePopoverPlacement({ top: 840, bottom: 872, left: 400, width: 300 }, VIEWPORT);
  const panelBottom = placement.openUp
    ? VIEWPORT.height - placement.bottom
    : placement.top + placement.panelMaxHeight;
  assert.ok(panelBottom <= VIEWPORT.height - VIEWPORT_MARGIN + 1, `panel alt kenarı ${panelBottom}`);
});

test('dar boşlukta panel yüksekliği boşluğu aşmaz', () => {
  const placement = computePopoverPlacement({ top: 700, bottom: 740, left: 100, width: 300 }, { width: 1440, height: 800 });
  const available = placement.openUp
    ? 700 - 6 - VIEWPORT_MARGIN
    : 800 - 740 - 6 - VIEWPORT_MARGIN;
  assert.ok(placement.panelMaxHeight <= available + 1);
});

test('yer varken panel aşağı açılır ve liste tavanı aşmaz', () => {
  const placement = computePopoverPlacement({ top: 120, bottom: 152, left: 200, width: 320 }, VIEWPORT);
  assert.equal(placement.openUp, false);
  assert.equal(placement.top, 158);
  assert.ok(placement.listMaxHeight <= MAX_LIST_HEIGHT);
  assert.ok(placement.listMaxHeight >= MIN_LIST_HEIGHT);
});

test('aşağı sığmayan panel, yukarısı daha genişse yukarı açılır', () => {
  const placement = computePopoverPlacement({ top: 760, bottom: 792, left: 200, width: 320 }, VIEWPORT);
  assert.equal(placement.openUp, true);
  assert.equal(placement.bottom, VIEWPORT.height - 760 + 6);
});

test('panel yatayda görünüm alanının dışına çıkamaz', () => {
  const placement = computePopoverPlacement({ top: 100, bottom: 132, left: 1400, width: 300 }, VIEWPORT);
  assert.ok(placement.left >= VIEWPORT_MARGIN);
  assert.ok(placement.left + placement.width <= VIEWPORT.width - VIEWPORT_MARGIN + 1);
});

test('panel yüksekliği liste ile çerçeve payının toplamını aşmaz', () => {
  const placement = computePopoverPlacement({ top: 100, bottom: 132, left: 200, width: 320 }, { width: 1440, height: 2000 });
  assert.equal(placement.panelMaxHeight, MAX_LIST_HEIGHT + PANEL_CHROME_HEIGHT);
});

/* ── Süzgeç kutusu yerleşimi ────────────────────────────────────── */

test('süzgeç kutusu ekranın altına taşarsa yukarı çevrilir', () => {
  const placed = clampOverlayToViewport(
    { left: 300, top: 820, bottom: 850, width: 120 },
    { width: 300, height: 340 },
    VIEWPORT
  );
  assert.equal(placed.flipped, true);
  assert.ok(placed.top >= 8);
  assert.ok(placed.top + placed.maxHeight <= 820);
});

test('hiçbir yöne sığmayan kutu, kalan boşluğa sıkıştırılır ve dışarı taşmaz', () => {
  const placed = clampOverlayToViewport(
    { left: 10, top: 300, bottom: 330, width: 120 },
    { width: 300, height: 5000 },
    { width: 500, height: 600 }
  );
  assert.ok(placed.top >= 8);
  assert.ok(placed.top + placed.maxHeight <= 600 - 8 + 1);
});

test('süzgeç kutusu yatayda kırpılmaz', () => {
  const placed = clampOverlayToViewport(
    { left: 1430, top: 100, bottom: 130, width: 60 },
    { width: 300, height: 200 },
    VIEWPORT
  );
  assert.ok(placed.left + 300 <= VIEWPORT.width - 8 + 1);
});

/* ── 4. Yazı boyutu ölçeği ──────────────────────────────────────── */

test('tam ekran kaplar yükseklikler ölçekli görünüm değişkenini kullanır', () => {
  // Yazı boyutu ölçeği gövdeye `zoom` uygular; `100vh` ölçekle birlikte
  // büyüdüğü için panel alt çubuğu ekranın dışına itiliyordu.
  for (const file of ['src/app/globals.css', 'src/app/styles/features.css', 'src/app/styles/shell.css', 'src/app/styles/experience.css']) {
    // Yalnızca `--app-viewport-h` yedeği olarak yazılan `100vh` kabul edilir;
    // ölçüm için önce bu yedekler metinden düşürülür.
    const css = read(file).replaceAll('var(--app-viewport-h, 100vh)', 'var(--app-viewport-h)');
    const bare = css.match(/\b(height|max-height|padding-top):[^;]*\d+vh/g) || [];
    assert.deepEqual(bare, [], `${file} doğrudan vh kullanmamalı: ${bare.join(', ')}`);
  }
});

test('görev paneli alt çubuğu küçülmez ve gövde taşmayı kendi içinde tutar', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /\.drawer-body\s*\{[^}]*min-height:\s*0;/s);
  assert.match(css, /\.drawer-foot\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*wrap;/s);
});

test('aranabilir seçim paneli ölçeğe göre konumlanır', () => {
  const select = read('src/components/SearchableSelect.jsx');
  assert.match(select, /const scale = appZoom\(\);/);
  assert.match(select, /rect\.top \/ scale/);
  assert.match(select, /window\.innerHeight \/ scale/);
  assert.match(select, /maxHeight: placement\.panelMaxHeight/);
});

/* ── 5. Ardıl görev ilkeleri ────────────────────────────────────── */

function relationFixture() {
  return [
    { id: 'a', projectId: 'p', task: 'A', deps: [] },
    { id: 'b', projectId: 'p', task: 'B', deps: [{ id: 'a', predecessorId: 'a', type: 'FS', lagValue: 0, lagUnit: 'day' }] },
    { id: 'c', projectId: 'p', task: 'C', deps: [{ id: 'b', predecessorId: 'b', type: 'FS', lagValue: 0, lagUnit: 'day' }] },
    { id: 'd', projectId: 'p', task: 'D', deps: [] }
  ];
}

test('ardıllar öncül listelerinin ters okunuşundan türetilir', () => {
  const tasks = relationFixture();
  assert.deepEqual(selectSuccessors('a', tasks).map((entry) => entry.task.id), ['b']);
  assert.deepEqual(selectSuccessors('b', tasks).map((entry) => entry.task.id), ['c']);
  assert.deepEqual(selectSuccessors('d', tasks), []);
});

test('ardıl eklemek ARDIL görevin öncül listesini yamalar', () => {
  const tasks = relationFixture();
  const plan = planSuccessorLink(tasks[0], 'd', tasks, { type: 'SS' });
  assert.equal(plan.ok, true);
  assert.equal(plan.successorId, 'd');
  assert.deepEqual(plan.patch.deps, [
    { id: 'a', predecessorId: 'a', type: 'SS', lagValue: 0, lagUnit: 'day', lagDays: 0 }
  ]);
});

test('döngü oluşturacak ardıl reddedilir', () => {
  const tasks = relationFixture();
  // C, A'nın dolaylı ardılıdır; A'yı C'nin ardılı yapmak döngü kurar.
  const plan = planSuccessorLink(tasks.find((task) => task.id === 'c'), 'a', tasks);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'SUCCESSOR_CREATES_CYCLE');
});

test('kendine ardıl, var olan ardıl ve bilinmeyen görev reddedilir', () => {
  const tasks = relationFixture();
  assert.equal(planSuccessorLink(tasks[0], 'a', tasks).code, 'SUCCESSOR_IS_SELF');
  assert.equal(planSuccessorLink(tasks[0], 'b', tasks).code, 'SUCCESSOR_ALREADY_LINKED');
  assert.equal(planSuccessorLink(tasks[0], 'yok', tasks).code, 'SUCCESSOR_NOT_FOUND');
  assert.equal(planSuccessorLink(tasks[0], '', tasks).code, 'SUCCESSOR_NOT_FOUND');
});

test('öncül kapanışı geçişlidir ve bozuk döngülü veride bile sonlanır', () => {
  const tasks = relationFixture();
  assert.deepEqual([...collectPredecessorClosure('c', tasks)].sort(), ['a', 'b']);

  const cyclic = [
    { id: 'x', deps: [{ predecessorId: 'y' }] },
    { id: 'y', deps: [{ predecessorId: 'x' }] }
  ];
  assert.deepEqual([...collectPredecessorClosure('x', cyclic)].sort(), ['x', 'y']);
});

test('ardıl ilişkisi kaldırıldığında yalnızca o kenar düşer', () => {
  const tasks = [
    ...relationFixture(),
    { id: 'e', projectId: 'p', task: 'E', deps: [{ predecessorId: 'a' }, { predecessorId: 'd' }] }
  ];
  const plan = planSuccessorUnlink({ id: 'a' }, 'e', tasks);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.patch.deps, [{ predecessorId: 'd' }]);
});

test('ardıl ilişkisinin gecikmesi güncellenince gün karşılığı yeniden hesaplanır', () => {
  const tasks = relationFixture();
  const plan = planSuccessorUpdate({ id: 'a' }, 'b', { lagValue: 2, lagUnit: 'week' }, tasks);
  assert.equal(plan.ok, true);
  const updated = plan.patch.deps[0];
  assert.equal(updated.lagValue, 2);
  assert.equal(updated.lagUnit, 'week');
  // Hafta iş günü cinsinden çevrilir: 2 hafta = 10 iş günü.
  assert.equal(updated.lagDays, 10);
});

test('ardıl düzenleyicisi ayrı bir alan tutmaz: kenar tek yerde saklanır', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  const policy = read('src/features/task-detail/taskSuccessorPolicy.js');
  assert.doesNotMatch(drawer, /successors:\s*\[/);
  assert.doesNotMatch(policy, /task\.successors/);
  assert.match(drawer, /planSuccessorLink\(task, successorId, tasks, \{ type: successorType \}\)/);
});
