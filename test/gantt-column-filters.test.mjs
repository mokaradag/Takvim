import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { button, click, enter, key, mountDom } from './helpers/clientDomHarness.mjs';
import { filterState, tasks, people } from './helpers/columnFilterFixtures.mjs';
import { calendarMonthLabel } from '../src/components/datePickerCalendar.js';
import { parseDisplayDate } from '../src/components/dateInputFormat.js';
import {
  GANTT_CPM_DATE_KEYS,
  GANTT_NUMERIC_KEYS,
  createGanttColumnFilters,
  ganttColumnValue,
  ganttMatchesDerivedFilters
} from '../src/features/gantt/ganttColumnFilters.js';
const { GanttView } = await import('../src/features/gantt/GanttView.jsx');
const { PeopleDirectoryProvider } = await import('../src/components/PeopleDirectoryContext.jsx');

function GanttScreen() {
  return React.createElement(PeopleDirectoryProvider, { people }, React.createElement(GanttView));
}
const rowNames = () =>
  [...document.querySelectorAll('.gantt-task-row .tr-name > span')]
    .map((node) => node.textContent)
    .filter(Boolean);
const expectedNames = (ids) => ids.map((id) => tasks.find((task) => task.id === id).task);
function assertRows(ids) {
  assert.deepEqual(rowNames(), expectedNames(ids));
  assert.equal(document.querySelectorAll('.gantt-bar').length, ids.length);
  assert.ok(document.body.textContent.includes(`${ids.length} / ${tasks.length} görev`));
}
function showColumn(label) {
  if (
    [...document.querySelectorAll('.gantt-left-head button')].some(
      (node) => node.textContent.trim() === label
    )
  )
    return;
  click(document.querySelector('[title="Sütunları yönet"]'));
  const option = [...document.querySelectorAll('.gantt-cols-pop label')].find(
    (node) => node.textContent.trim() === label
  );
  assert.ok(option, `${label} sütunu bulunmalıdır`);
  click(option.querySelector('input'));
  click(document.body);
}
function openColumn(label, mode) {
  showColumn(label);
  click(button(label, document.querySelector('.gantt-left-head')));
  if (mode) click(button(mode, document.querySelector('.col-filter-pop')));
}
function pick(iso, index = 0) {
  const shell = document.querySelectorAll('.col-filter-pop .date-input-shell')[index];
  click(button('Takvimden tarih seç', shell));
  const panel = document.querySelector('.date-picker-panel');
  const target = calendarMonthLabel(`${iso.slice(0, 7)}-01`);
  for (let i = 0; panel.querySelector('strong').textContent !== target; i++) {
    assert.ok(i < 120, 'Hedef ay bulunmalıdır');
    const current = parseDisplayDate(`1 ${panel.querySelector('strong').textContent}`);
    click(button(current < iso ? 'Sonraki ay' : 'Önceki ay', panel));
  }
  click(button(`${Number(iso.slice(8))} ${target}`, panel));
  assert.ok(document.querySelector('.col-filter-pop'), 'Takvim üst süzgeci açık bırakmalıdır');
  assert.equal(document.querySelector('.date-picker-panel'), null);
  assert.equal(parseDisplayDate(shell.querySelector('input').value), iso);
}
function clearColumn(label) {
  openColumn(label);
  click(button('Temizle'));
  assertRows(['a', 'b', 'c', 'd', 'e']);
}

const dateCases = [
  [
    'Erken Başlangıç',
    ['2026-09-01', ['a', 'c', 'd']],
    ['2026-09-03', ['b']],
    ['2026-09-01', '2026-09-03', ['a', 'b', 'c', 'd']]
  ],
  [
    'Erken Bitiş',
    ['2026-09-02', ['a', 'd']],
    ['2026-09-08', ['b', 'c']],
    ['2026-09-02', '2026-09-08', ['a', 'b']]
  ],
  [
    'Geç Başlangıç',
    ['2026-09-07', ['a', 'c']],
    ['2026-09-09', ['b', 'd']],
    ['2026-09-07', '2026-09-09', ['a', 'b']]
  ],
  [
    'Geç Bitiş',
    ['2026-09-08', ['a']],
    ['2026-09-14', ['b', 'c', 'd']],
    ['2026-09-08', '2026-09-14', ['a', 'b', 'c', 'd']]
  ]
];
for (const [label, before, after, range] of dateCases) {
  for (const [mode, from, to, ids] of [
    ['Önce', before[0], null, before[1]],
    ['Sonra', after[0], null, after[1]],
    ['Arası', range[0], range[1], range[2]]
  ])
    test(`Gantt ${label} ${mode} takvim süzgeci görevleri, çubukları ve sayacı değiştirir; Temizle geri alır`, () => {
      const view = mountDom(GanttScreen, {}, filterState());
      try {
        openColumn(label, mode);
        pick(from);
        if (to) pick(to, 1);
        assertRows(['a', 'b', 'c', 'd', 'e']);
        click(button('Uygula'));
        assertRows(ids);
        assert.ok(
          button(label, document.querySelector('.gantt-left-head')).classList.contains('has-filter')
        );
        clearColumn(label);
        assert.ok(
          !button(label, document.querySelector('.gantt-left-head')).classList.contains(
            'has-filter'
          )
        );
      } finally {
        view.unmount();
      }
    });
}

const numberCases = [
  ['Toplam Bolluk', 1, ['c'], 4, ['d'], [0, 4], ['a', 'b', 'c'], ['c']],
  ['Serbest Bolluk', 1, ['a', 'c'], 4, ['d'], [0, 4], ['a', 'b', 'c'], ['a', 'c']],
  ['Süre', 2, ['d'], 2, ['b', 'c'], [0, 4], ['a', 'b', 'd'], ['d']]
];
for (const [label, before, beforeIds, after, afterIds, range, rangeIds, zeroIds] of numberCases) {
  for (const [mode, values, ids] of [
    ['Az', [before], beforeIds],
    ['Çok', [after], afterIds],
    ['Arası', range, rangeIds],
    ['Eşit', [0], zeroIds]
  ]) {
    test(`Gantt ${label} ${mode} sayısal değerlerle çalışır, sıfırı korur ve temizlenir`, () => {
      const view = mountDom(GanttScreen, {}, filterState());
      try {
        openColumn(label, mode);
        assert.equal(
          document.querySelector('.dff-hint'),
          null,
          'Bolluk ve süre yüzde sınırı taşımamalıdır'
        );
        const inputs = document.querySelectorAll('.col-filter-pop input[type="number"]');
        values.forEach((value, i) => enter(inputs[i], String(value)));
        click(button('Uygula'));
        assertRows(ids);
        clearColumn(label);
      } finally {
        view.unmount();
      }
    });
  }
}

for (const keyName of [...GANTT_CPM_DATE_KEYS, ...GANTT_NUMERIC_KEYS])
  test(`Gantt ${{ earlyStart: 'Erken Başlangıç', earlyFinish: 'Erken Bitiş', lateStart: 'Geç Başlangıç', lateFinish: 'Geç Bitiş', totalFloat: 'Toplam Bolluk', freeFloat: 'Serbest Bolluk', duration: 'Süre' }[keyName]} eksik veriyi üretmez; eşit uçlar ve boş ölçüt belirlenimlidir`, () => {
    const date = GANTT_CPM_DATE_KEYS.includes(keyName);
    const schedule = {
      earlyStart: '2026-09-10',
      earlyFinish: '2026-09-10',
      lateStart: '2026-09-10',
      lateFinish: '2026-09-10',
      totalFloatDays: 0,
      freeFloatDays: 0
    };
    const filter = date
      ? { mode: 'range', from: '2026-09-10', to: '2026-09-10' }
      : { mode: 'equals', eq: 0 };
    assert.equal(
      ganttMatchesDerivedFilters({ plannedDurationDays: 0 }, { [keyName]: filter }, schedule),
      true
    );
    assert.equal(ganttMatchesDerivedFilters({}, { [keyName]: filter }, null), false);
    assert.equal(ganttMatchesDerivedFilters({}, { [keyName]: null }, null), true);
    if (date) {
      assert.equal(
        ganttMatchesDerivedFilters(
          {},
          { [keyName]: { mode: 'range', from: '2026-09-11', to: '2026-09-09' } },
          schedule
        ),
        false
      );
      assert.equal(
        ganttMatchesDerivedFilters({}, { [keyName]: filter }, { [keyName]: 'geçersiz' }),
        false
      );
    } else {
      for (const missing of [undefined, null, '', NaN, Infinity, -Infinity]) {
        const task = keyName === 'duration' ? { plannedDurationDays: missing } : {};
        const invalid = { [`${keyName}Days`]: missing };
        assert.equal(ganttColumnValue(task, keyName, invalid), null);
        assert.equal(
          ganttMatchesDerivedFilters(
            task,
            { [keyName]: { mode: 'between', from: -100, to: 100 } },
            invalid
          ),
          false
        );
      }
    }
  });

for (const [label, field] of [
  ['Toplam Bolluk', 'totalFloatDays'],
  ['Serbest Bolluk', 'freeFloatDays']
])
  test(`Gantt ${label} negatif bolluğu biçimlenmiş metne veya sıfıra dönüştürmez`, () => {
    const state = filterState();
    state.schedule.tasks.a[field] = -3;
    const view = mountDom(GanttScreen, {}, state);
    try {
      openColumn(label, 'Arası');
      const inputs = document.querySelectorAll('input[type="number"]');
      enter(inputs[0], '-3');
      enter(inputs[1], '-1');
      click(button('Uygula'));
      assertRows(['a']);
      assert.ok(document.querySelector('.gantt-task-row').textContent.includes('-3g'));
    } finally {
      view.unmount();
    }
  });

test('Gantt türetilmiş süzgeçler fasetler, arama, öncelik, sorumlu, durum, ilerleme ve kritik kapsamıyla birleşir', () => {
  const view = mountDom(GanttScreen, {}, filterState());
  try {
    openColumn('Toplam Bolluk', 'Eşit');
    enter(document.querySelector('input[type="number"]'), '0');
    click(button('Uygula'));
    assertRows(['c']);
    for (const [label, expected] of [
      ['Sorumlu', 'Ayşe Ak'],
      ['Öncelik', 'Yüksek'],
      ['Durum', 'Tamamlandı']
    ]) {
      openColumn(label);
      const options = document.querySelectorAll('.col-filter-opt');
      assert.equal(options.length, 1);
      assert.ok(options[0].textContent.includes(expected));
      click(options[0].querySelector('input'));
      click(button('Uygula'));
      assertRows(['c']);
    }
    openColumn('%', 'Eşit');
    enter(document.querySelector('input[type="number"]'), '100');
    click(button('Uygula'));
    assertRows(['c']);
    openColumn('Geç Bitiş', 'Arası');
    pick('2026-09-14');
    pick('2026-09-14', 1);
    click(button('Uygula'));
    assertRows(['c']);
    openColumn('Süre', 'Eşit');
    enter(document.querySelector('input[type="number"]'), '10');
    click(button('Uygula'));
    assertRows(['c']);
    enter(document.querySelector('.topbar-search input'), 'GAMA');
    assertRows(['c']);
    click(button('Kritik'));
    assertRows(['c']);
    assert.equal(document.querySelectorAll('[title="Kritik CPM görevi"]').length, 1);
    assert.ok(document.querySelector('.gantt-bar').style.boxShadow);
    click(button('Sorumluya göre'));
    assertRows(['c']);
    assert.equal(document.querySelectorAll('.gantt-group-header').length, 1);
    click(document.querySelector('.gantt-group-header'));
    assert.equal(document.querySelectorAll('.gantt-task-row').length, 0);
    assert.equal(document.querySelectorAll('.gantt-bar').length, 0);
    click(document.querySelector('.gantt-group-header'));
    assertRows(['c']);
    click(button('Filtreleri temizle'));
    assert.equal(rowNames().length, tasks.length);
    assert.equal(document.querySelectorAll('.col-th-btn.has-filter').length, 0);
    assert.equal(
      [...document.querySelectorAll('button')].some(
        (node) => node.textContent.trim() === 'Filtreleri temizle'
      ),
      false
    );
    assert.equal(document.querySelector('.topbar-search input').value, '');
  } finally {
    view.unmount();
  }
});

test('Gantt süre ve CPM sıralaması gerçek değerleri kullanır; eksik süre sıfır gösterilmez', () => {
  const view = mountDom(GanttScreen, {}, filterState());
  try {
    showColumn('Süre');
    assert.ok(
      [...document.querySelectorAll('.gantt-task-row')]
        .find((row) => row.textContent.includes('Çizelgesiz görev'))
        .textContent.includes('—')
    );
    openColumn('Süre', 'Arası');
    enter(document.querySelectorAll('input[type="number"]')[0], '0');
    click(button('Uygula'));
    openColumn('Süre');
    click(button('Küçükten büyüğe'));
    assertRows(['d', 'a', 'b', 'c']);
    openColumn('Süre');
    click(button('Büyükten küçüğe'));
    assertRows(['c', 'b', 'a', 'd']);
    openColumn('Erken Bitiş');
    click(button('Eskiden yeniye'));
    assertRows(['d', 'a', 'b', 'c']);
    assert.equal(document.querySelectorAll('.dep-arrow').length, 1);
    openColumn('Başlangıç', 'Sonra');
    pick('2026-09-03');
    click(button('Uygula'));
    assertRows(['d', 'b', 'c']);
    assert.equal(document.querySelectorAll('.dep-arrow').length, 0);
  } finally {
    view.unmount();
  }
});

test('Gantt aralık girdisi ters veya geçersiz tarihi işleme almaz; Escape içteki takvimi kapatır', () => {
  const view = mountDom(GanttScreen, {}, filterState());
  try {
    openColumn('Erken Başlangıç', 'Arası');
    pick('2026-09-03');
    const to = document.querySelectorAll('.date-input-shell input')[1];
    enter(to, '01/09/2026');
    key('Enter');
    assert.equal(to.getAttribute('aria-invalid'), 'true');
    enter(to, '31/02/2026');
    key('Enter');
    assert.equal(to.getAttribute('aria-invalid'), 'true');
    pick('2026-09-03', 1);
    click(button('Uygula'));
    assertRows(['b']);
    openColumn('Erken Başlangıç');
    click(button('Takvimden tarih seç'));
    key('Escape');
    assert.ok(document.querySelector('.col-filter-pop'));
    key('Escape');
    assert.equal(document.querySelector('.col-filter-pop'), null);
  } finally {
    view.unmount();
  }
});

test('Gantt sıfırlama her yeni alanı boşaltır ve bağımsız durum nesneleri üretir', () => {
  const first = createGanttColumnFilters();
  const second = createGanttColumnFilters();
  for (const field of [...GANTT_CPM_DATE_KEYS, ...GANTT_NUMERIC_KEYS])
    assert.equal(first[field], null);
  first.sorumlu.push('100001');
  assert.deepEqual(second.sorumlu, []);
});

test('Gantt çizelge güncellenince türetilmiş süzgeci yeniler ve çalışma alanının dışına görev eklemez', () => {
  const state = filterState();
  const view = mountDom(GanttScreen, {}, state);
  try {
    openColumn('Toplam Bolluk', 'Eşit');
    enter(document.querySelector('input[type="number"]'), '0');
    click(button('Uygula'));
    assertRows(['c']);
    state.schedule = {
      ...state.schedule,
      tasks: {
        ...state.schedule.tasks,
        a: { ...state.schedule.tasks.a, totalFloatDays: 0 },
        c: { ...state.schedule.tasks.c, totalFloatDays: 10 }
      }
    };
    view.render();
    assertRows(['a']);
    state.workspace = { ...state.workspace, tasks: [tasks[4]] };
    view.render();
    assert.deepEqual(rowNames(), []);
    click(button('Filtreleri temizle'));
    assert.deepEqual(rowNames(), ['Çizelgesiz görev']);
    assert.ok(document.body.textContent.includes('1 / 1 görev'));
  } finally {
    view.unmount();
  }
});
