import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useState } from 'react';
import { button, click, enter, key, mountDom } from './helpers/clientDomHarness.mjs';
import { dateMatchesFilter } from '../src/components/dateMatchesFilter.js';
import { calendarMonthLabel, todayIso } from '../src/components/datePickerCalendar.js';
import { addDays, fmtISO, setAppDateDisplayFormat } from '../src/scheduling/dates/index.js';
import { filterState, tasks } from './helpers/columnFilterFixtures.mjs';
const { parseDisplayDate } = await import('../src/components/dateInputFormat.js');
const { DateFilterableTH } = await import('../src/components/DateFilterableTH.jsx');
const { FilterableTH } = await import('../src/components/ui-extras.jsx');

function FilterTable({ generic = false }) {
  const [filter, setFilter] = useState(null);
  const Header = generic ? FilterableTH : DateFilterableTH;
  return React.createElement(
    'table',
    null,
    React.createElement(
      'thead',
      null,
      React.createElement(
        'tr',
        null,
        React.createElement(Header, {
          label: 'Tarih',
          filterType: 'date',
          filter,
          onFilter: setFilter
        })
      )
    ),
    React.createElement(
      'tbody',
      null,
      ['2026-09-10', '2026-09-20']
        .filter((date) => dateMatchesFilter(date, filter))
        .map((date) =>
          React.createElement('tr', { key: date }, React.createElement('td', null, date))
        )
    )
  );
}

function selectDay(iso, inputIndex = 0) {
  const shell = document.querySelectorAll('.col-filter-pop .date-input-shell')[inputIndex];
  click(button('Takvimden tarih seç', shell));
  const panel = document.querySelector('.date-picker-panel');
  assert.ok(panel, 'Takvim açılmalıdır');
  const month = `${iso.slice(0, 7)}-01`;
  const targetLabel = calendarMonthLabel(month);
  for (let count = 0; panel.querySelector('strong').textContent !== targetLabel; count++) {
    assert.ok(count < 120, 'Hedef aya ulaşılmalıdır');
    const current = parseDisplayDate(`1 ${panel.querySelector('strong').textContent}`);
    click(button(current < month ? 'Sonraki ay' : 'Önceki ay', panel));
    assert.ok(panel.isConnected, 'Ay gezinmesi üst süzgeci kapatmamalıdır');
  }
  const dayLabel = `${Number(iso.slice(8))} ${targetLabel}`;
  click(button(dayLabel, panel));
  assert.ok(document.querySelector('.col-filter-pop'), 'Gün seçimi üst süzgeci kapatmamalıdır');
  assert.equal(
    document.querySelector('.date-picker-panel'),
    null,
    'Seçimden sonra yalnızca takvim kapanmalıdır'
  );
  assert.equal(parseDisplayDate(shell.querySelector('input').value), iso);
  assert.equal(document.activeElement, shell.querySelector('input'));
}

for (const generic of [false, true])
  test(`${generic ? 'Genel' : 'Tarih'} sütun süzgeci takvim seçimini Uygula işlemine kadar korur`, () => {
    const view = mountDom(FilterTable, { generic });
    try {
      click(button('Tarih'));
      click(button('Önce'));
      selectDay(todayIso());
      assert.equal(document.querySelectorAll('tbody tr').length, 2);
      click(button('Uygula'));
      assert.equal(
        document.querySelector('tbody').textContent,
        ['2026-09-10', '2026-09-20'].filter((day) => day <= todayIso()).join('')
      );
    } finally {
      view.unmount();
    }
  });

for (const generic of [false, true]) {
  for (const [mode, from, to, expected] of [
    ['Önce', '2026-09-15', null, '2026-09-10'],
    ['Sonra', '2026-09-15', null, '2026-09-20'],
    ['Arası', '2026-09-10', '2026-09-20', '2026-09-102026-09-20'],
    ['Arası', '2026-09-20', '2026-09-20', '2026-09-20']
  ])
    test(`${generic ? 'Genel' : 'Tarih'} süzgecinde ${mode} tarihleri ve kapsanan uçlar uygulanır, Temizle geri alır (${from})`, () => {
      const view = mountDom(FilterTable, { generic });
      try {
        click(button('Tarih'));
        click(button(mode));
        selectDay(from);
        if (to) selectDay(to, 1);
        click(button('Uygula'));
        assert.equal(document.querySelector('tbody').textContent, expected);
        const anchor = button('Tarih');
        assert.equal(document.activeElement, anchor);
        assert.ok(anchor.classList.contains('has-filter'));
        click(anchor);
        click(button('Temizle'));
        assert.equal(document.querySelectorAll('tbody tr').length, 2);
        assert.ok(!button('Tarih').classList.contains('has-filter'));
      } finally {
        view.unmount();
      }
    });

  test(`${generic ? 'Genel' : 'Tarih'} süzgeci iç içe Escape, odak ve dış tıklamayı korur`, () => {
    const view = mountDom(FilterTable, { generic });
    try {
      const anchor = button('Tarih');
      click(anchor);
      click(button('Önce'));
      click(button('Takvimden tarih seç'));
      assert.equal(document.activeElement, document.querySelector('.date-picker-panel'));
      assert.equal(key('Escape').defaultPrevented, true);
      assert.ok(document.querySelector('.col-filter-pop'));
      assert.equal(document.querySelector('.date-picker-panel'), null);
      assert.equal(document.activeElement, document.querySelector('.date-input-shell input'));
      key('Escape');
      assert.equal(document.querySelector('.col-filter-pop'), null);
      assert.equal(document.activeElement, anchor);
      click(anchor);
      click(button('Önce'));
      click(button('Takvimden tarih seç'));
      click(document.body);
      assert.equal(document.querySelector('.col-filter-pop'), null);
      assert.equal(document.querySelector('.date-picker-panel'), null);
    } finally {
      view.unmount();
    }
  });

  test(`${generic ? 'Genel' : 'Tarih'} süzgeci elle tarihi okur, geçersiz taslağı reddeder ve hızlı ayarı uygular`, () => {
    const view = mountDom(FilterTable, { generic });
    try {
      setAppDateDisplayFormat('dd/mm/yyyy');
      click(button('Tarih'));
      click(button('Önce'));
      const input = document.querySelector('.date-input-shell input');
      enter(input, '31/02/2026');
      key('Enter');
      assert.equal(input.getAttribute('aria-invalid'), 'true');
      enter(input, '15/09/2026');
      // Uygula tıklamasındaki bulanıklık, taslağı uygulamadan önce işler.
      click(button('Uygula'));
      assert.equal(document.querySelector('tbody').textContent, '2026-09-10');
      click(button('Tarih'));
      click(button('Hızlı'));
      click(button('Bugün'));
      click(button('Uygula'));
      assert.equal(
        document.querySelectorAll('tbody tr').length,
        ['2026-09-10', '2026-09-20'].filter((day) => day === todayIso()).length
      );
      click(button('Tarih'));
      click(button('Temizle'));
      assert.equal(document.querySelectorAll('tbody tr').length, 2);
    } finally {
      view.unmount();
      setAppDateDisplayFormat('pattern');
    }
  });
}

const { TasksView } = await import('../src/features/tasks/TasksView.jsx');
const { SimpleTasksView } = await import('../src/features/tasks/SimpleTasksView.jsx');
const { KpiTaskModal } = await import('../src/features/dashboard/KpiTaskModal.jsx');
const { TaskOrganizationFilterProvider } = await import(
  '../src/features/tasks/TaskOrganizationFilterContext.jsx'
);
const { DateInput } = await import('../src/components/DateInput.jsx');

function TasksScreen({ simple }) {
  return React.createElement(
    TaskOrganizationFilterProvider,
    null,
    React.createElement(simple ? SimpleTasksView : TasksView)
  );
}

for (const simple of [false, true])
  for (const label of simple ? ['Termin'] : ['Başlangıç', 'Bitiş', 'Hedef']) {
    test(`Görevler ${simple ? 'Temel' : 'Kapsamlı'} Kip ${label} takvim süzgeci gerçek satırları daraltır`, () => {
      const view = mountDom(TasksScreen, { simple }, filterState());
      try {
        click(button(label));
        click(button('Arası'));
        selectDay('2026-09-10');
        selectDay('2026-09-20', 1);
        click(button('Uygula'));
        const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent);
        const expected =
          label === 'Başlangıç'
            ? ['Çizelgesiz görev', 'Sıfır süreli görev']
            : label === 'Bitiş'
              ? ['Çizelgesiz görev', 'Gama görevi', 'Sıfır süreli görev']
              : ['Alfa görevi', 'Çizelgesiz görev', 'Beta görevi', 'Sıfır süreli görev'];
        assert.equal(rows.length, expected.length);
        for (const name of expected)
          assert.ok(
            rows.some((row) => row.includes(name)),
            name
          );
        click(button(label));
        click(button('Temizle'));
        assert.equal(document.querySelectorAll('tbody tr').length, tasks.length);
      } finally {
        view.unmount();
      }
    });
  }

for (const variant of ['advanced', 'simple'])
  for (const category of ['Toplam Görev']) {
    test(`${category} KPI penceresi ${variant === 'simple' ? 'Temel' : 'Kapsamlı'} Kip tarihleri, odak tuzağı ve Escape sırasını korur`, () => {
      let closed = 0;
      const data = tasks.filter(
        (task) =>
          category === 'Toplam Görev' ||
          (category === 'Tamamlanan'
            ? task.status === 'done'
            : category === 'Devam eden'
              ? task.status === 'in_progress'
              : task.status === 'todo')
      );
      const view = mountDom(
        KpiTaskModal,
        {
          title: category,
          tasks: data,
          variant,
          onClose() {
            closed++;
          },
          onOpenTask() {}
        },
        filterState()
      );
      try {
        for (const label of variant === 'simple' ? ['Termin'] : ['Başlangıç', 'Bitiş', 'Hedef']) {
          click(button(label));
          click(button('Arası'));
          selectDay('2026-09-10');
          selectDay('2026-09-20', 1);
          click(button('Uygula'));
          const field =
            label === 'Başlangıç'
              ? 'plannedStart'
              : label === 'Bitiş'
                ? 'plannedFinish'
                : 'targetFinish';
          const expected = data.filter(
            (task) => task[field] >= '2026-09-10' && task[field] <= '2026-09-20'
          );
          assert.equal(document.querySelectorAll('tbody tr').length, expected.length);
          for (const task of expected)
            assert.ok(document.querySelector('tbody').textContent.includes(task.task));
          click(button(label));
          click(button('Temizle'));
          assert.equal(document.querySelectorAll('tbody tr').length, data.length);
        }
        const label = variant === 'simple' ? 'Termin' : 'Başlangıç';
        const anchor = button(label);
        click(anchor);
        click(button('Önce'));
        click(button('Takvimden tarih seç'));
        const panel = document.querySelector('.date-picker-panel');
        assert.equal(
          panel.getAttribute('data-modal-owner'),
          document.querySelector('.kpi-task-modal').getAttribute('data-focus-scope')
        );
        const last = [...panel.querySelectorAll('button')].at(-1);
        last.focus();
        key('Tab');
        assert.equal(document.activeElement, panel.querySelector('button'));
        key('Tab', document.activeElement, { shiftKey: true });
        assert.equal(document.activeElement, last);
        key('Escape');
        assert.equal(closed, 0);
        assert.ok(document.querySelector('.col-filter-pop'));
        key('Escape');
        assert.equal(closed, 0);
        assert.equal(document.activeElement, anchor);
        key('Escape');
        assert.equal(closed, 1);
      } finally {
        view.unmount();
      }
    });
  }

function SeparatePickers() {
  const [value, setValue] = useState('2026-09-10');
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(FilterTable),
    React.createElement(DateInput, { value, onChange: setValue, ariaLabel: 'Bağımsız tarih' })
  );
}

test('Başka tarih girdisinin portalı üst süzgecin içi sayılmaz; bağımsız alan klavyeyle çalışır', () => {
  const view = mountDom(SeparatePickers);
  try {
    click(button('Tarih'));
    click(button('Önce'));
    const separate = document.querySelector('[aria-label="Bağımsız tarih"]');
    click(button('Takvimden tarih seç', separate.parentElement));
    assert.equal(document.querySelector('.col-filter-pop'), null);
    assert.ok(document.querySelector('.date-picker-panel'));
    key('Escape');
    assert.equal(document.activeElement, separate);
    key('ArrowDown', separate, { altKey: true });
    const panel = document.querySelector('.date-picker-panel');
    const day = button('15 Eylül 2026', panel);
    click(day);
    assert.equal(parseDisplayDate(separate.value), '2026-09-15');
  } finally {
    view.unmount();
  }
});

test('Süzgeç ve takvim açılıp kapanınca yerel dinleyiciler temizlenir', () => {
  const registrations = new Map();
  const restores = [];
  for (const target of [document, window]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    const active = new Set();
    registrations.set(target, active);
    target.addEventListener = function (type, listener, options) {
      if (['mousedown', 'keydown', 'scroll', 'resize'].includes(type)) active.add(listener);
      return add.call(this, type, listener, options);
    };
    target.removeEventListener = function (type, listener, options) {
      active.delete(listener);
      return remove.call(this, type, listener, options);
    };
    restores.push(() => {
      target.addEventListener = add;
      target.removeEventListener = remove;
    });
  }
  const view = mountDom(FilterTable);
  try {
    for (let i = 0; i < 3; i++) {
      click(button('Tarih'));
      click(button('Önce'));
      click(button('Takvimden tarih seç'));
      key('Escape');
      key('Escape');
    }
  } finally {
    view.unmount();
    restores.forEach((restore) => restore());
  }
  for (const active of registrations.values()) assert.equal(active.size, 0);
});

const { DashboardView } = await import('../src/features/dashboard/DashboardView.jsx');
function DashboardScreen(props) {
  return React.createElement(
    TaskOrganizationFilterProvider,
    null,
    React.createElement(DashboardView, props)
  );
}

for (const variant of ['advanced', 'simple'])
  for (const [category, initial, filtered] of [
    ['Toplam Görev', 5, 2],
    ['Tamamlanan', 2, 1],
    ['Devam eden', 1, 0],
    ['Yapılacak', 1, 0],
    ['Geciken', 1, 1]
  ])
    test(`Özet ${category} kartından Tüm görevleri gör akışı ${variant === 'simple' ? 'Temel' : 'Kapsamlı'} Kipte tarih süzgecini kullanır`, () => {
      const today = todayIso();
      const data = ['done', 'done', 'in_progress', 'todo', 'todo'].map((status, index) => ({
        ...tasks[0],
        id: String(index),
        task: `Özet görevi ${index}`,
        status,
        plannedStart: today,
        plannedFinish: today,
        targetFinish: fmtISO(addDays(today, [0, 3, 1, 2, -1][index])),
        actualFinish: status === 'done' ? today : null
      }));
      const view = mountDom(DashboardScreen, { variant }, filterState(data));
      try {
        const label = [...document.querySelectorAll('.stat .label')].find(
          (node) =>
            node.textContent.trim() === (category === 'Toplam Görev' ? 'Toplam görev' : category)
        );
        assert.ok(label, `${category} kartı bulunmalıdır`);
        click(label.closest('[role="button"]'));
        click(button('Tüm görevleri gör'));
        assert.equal(
          document.querySelector('.kpi-task-modal h2').textContent,
          category === 'Toplam Görev' ? 'Toplam görev' : category
        );
        assert.equal(document.querySelectorAll('.kpi-task-modal tbody tr').length, initial);
        const dateLabel = variant === 'simple' ? 'Termin' : 'Hedef';
        click(button(dateLabel));
        click(button('Önce'));
        selectDay(today);
        click(button('Uygula'));
        assert.equal(document.querySelectorAll('.kpi-task-modal tbody tr').length, filtered);
        click(button(dateLabel));
        click(button('Temizle'));
        assert.equal(document.querySelectorAll('.kpi-task-modal tbody tr').length, initial);
      } finally {
        view.unmount();
      }
    });

for (const simple of [false, true])
  for (const modal of [false, true])
    test(`${modal ? 'KPI' : 'Görevler'} ${simple ? 'Temel' : 'Kapsamlı'} Kip tarih süzgeci sayfayı sıfırlar ve Temizle tüm sayfaları geri getirir`, () => {
      const data = Array.from({ length: 105 }, (_, index) => ({
        ...tasks[0],
        id: String(index),
        task: `Sayfalı görev ${index}`,
        targetFinish: index < 100 ? '2026-09-10' : '2026-09-20'
      }));
      const Component = modal ? KpiTaskModal : TasksScreen;
      const props = modal
        ? {
            title: 'Sayfalı görevler',
            tasks: data,
            variant: simple ? 'simple' : 'advanced',
            onClose() {},
            onOpenTask() {}
          }
        : { simple };
      const view = mountDom(Component, props, filterState(data));
      try {
        click(button('Sonraki görev sayfası'));
        assert.equal(document.querySelectorAll('tbody tr').length, 5);
        click(button(simple ? 'Termin' : 'Hedef'));
        click(button('Önce'));
        selectDay('2026-09-15');
        click(button('Uygula'));
        assert.equal(document.querySelectorAll('tbody tr').length, 100);
        assert.ok(
          document.querySelector('.task-table-pagination').textContent.includes('Sayfa 1 / 1')
        );
        click(button(simple ? 'Termin' : 'Hedef'));
        click(button('Temizle'));
        assert.ok(
          document.querySelector('.task-table-pagination').textContent.includes('Sayfa 1 / 2')
        );
        click(button('Sonraki görev sayfası'));
        assert.equal(document.querySelectorAll('tbody tr').length, 5);
      } finally {
        view.unmount();
      }
    });

for (const generic of [false, true])
  test(`${generic ? 'Genel' : 'Tarih'} aralık süzgeci ters bitişi ve geçersiz günü reddeder`, () => {
    const view = mountDom(FilterTable, { generic });
    try {
      click(button('Tarih'));
      click(button('Arası'));
      selectDay('2026-09-20');
      const to = document.querySelectorAll('.date-input-shell input')[1];
      enter(to, '10/09/2026');
      key('Enter');
      assert.equal(to.getAttribute('aria-invalid'), 'true');
      enter(to, '31/02/2026');
      key('Enter');
      assert.equal(to.getAttribute('aria-invalid'), 'true');
      selectDay('2026-09-20', 1);
      click(button('Uygula'));
      assert.equal(document.querySelector('tbody').textContent, '2026-09-20');
    } finally {
      view.unmount();
    }
  });
