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

function FilterTable({ generic = false, initialFilter = null, dates = ['2026-09-10', '2026-09-20'] }) {
  const [filter, setFilter] = useState(initialFilter);
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
      dates
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
  for (const category of ['Toplam Görev', 'Tamamlanan', 'Devam eden', 'Yapılacak', 'Geciken']) {
    test(`${category} KPI penceresi ${variant === 'simple' ? 'Temel' : 'Kapsamlı'} Kip tarihleri, odak tuzağı ve Escape sırasını korur`, (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 12) });
      let closed = 0;
      const data = tasks.filter(
        (task) =>
          category === 'Toplam Görev' ||
          (category === 'Tamamlanan'
            ? task.status === 'done'
            : category === 'Devam eden'
              ? task.status === 'in_progress'
              : category === 'Geciken'
                ? task.status !== 'done' && task.targetFinish < todayIso()
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

for (const generic of [false, true]) {
  for (const [mode, field, draft] of [
    ['Önce', 0, '31/02/2026'],
    ['Sonra', 0, '15/09'],
    ['Arası', 0, '21/09/2026'],
    ['Arası', 1, '09/09/2026'],
    ['Arası', 1, '31/02/2026']
  ])
    test(`${generic ? 'Genel' : 'Tarih'} ${mode} süzgeci ${field + 1}. geçersiz taslağı eski değerle uygulamaz (${draft})`, () => {
      const view = mountDom(FilterTable, {
        generic,
        initialFilter: { mode: 'range', from: '2026-09-10', to: '2026-09-20' }
      });
      try {
        click(button('Tarih'));
        click(button(mode));
        const input = document.querySelectorAll('.date-input-shell input')[field];
        enter(input, draft);
        click(button('Uygula'));
        assert.ok(document.querySelector('.col-filter-pop'), 'Geçersiz taslakta süzgeç açık kalmalıdır');
        assert.equal(document.querySelectorAll('tbody tr').length, 2);
        assert.equal(input.getAttribute('aria-invalid'), 'true');
        assert.equal(document.activeElement, input);
        enter(input, '15/09/2026');
        key('Enter');
        assert.equal(document.querySelectorAll('tbody tr').length, 2);
        click(button('Uygula'));
        assert.equal(document.querySelector('.col-filter-pop'), null);
        assert.equal(document.querySelectorAll('tbody tr').length, 1);
      } finally {
        view.unmount();
      }
    });

  test(`${generic ? 'Genel' : 'Tarih'} süzgeci kiplerden taşınan ters aralığı reddeder ve Temizle çalışır`, () => {
    const view = mountDom(FilterTable, { generic });
    try {
      click(button('Tarih'));
      click(button('Sonra'));
      enter(document.querySelector('.date-input-shell input'), '20/09/2026');
      click(button('Önce'));
      enter(document.querySelector('.date-input-shell input'), '10/09/2026');
      click(button('Arası'));
      click(button('Uygula'));
      assert.ok(document.querySelector('.col-filter-pop'));
      assert.equal(document.querySelectorAll('tbody tr').length, 2);
      click(button('Temizle'));
      assert.equal(document.querySelector('.col-filter-pop'), null);
      assert.equal(document.querySelectorAll('tbody tr').length, 2);
    } finally {
      view.unmount();
    }
  });
}

const { calendarTasks } = await import('./helpers/columnFilterFixtures.mjs');
const { getStatus } = await import('../src/scheduling/metrics/index.js');
for (const simple of [false, true])
  for (const category of [null, 'Toplam Görev', 'Tamamlanan', 'Devam eden', 'Yapılacak', 'Geciken'])
    test(`${category || 'Görevler'} ${simple ? 'Temel' : 'Kapsamlı'} Kipte geçen takvim dönemlerini tüm tarih sütunlarında uygular`, (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 12) });
      const status = { Tamamlanan: 'done', 'Devam eden': 'in_progress', Yapılacak: 'todo', Geciken: 'overdue' }[category];
      const data = status ? calendarTasks.filter((task) => getStatus(task).id === status) : calendarTasks;
      assert.ok(data.length, 'KPI başlangıç kümesi boş olmamalıdır');
      const view = mountDom(category ? KpiTaskModal : TasksScreen, category ? {
        title: category, tasks: data, variant: simple ? 'simple' : 'advanced', onClose() {}, onOpenTask() {}
      } : { simple }, filterState(data));
      try {
        for (const [label, field] of simple ? [['Termin', 'targetFinish']] : [
          ['Başlangıç', 'plannedStart'], ['Bitiş', 'plannedFinish'], ['Hedef', 'targetFinish']
        ])
          for (const [text, from, to] of [
            ['Geçen hafta', '2026-10-26', '2026-11-01'],
            ['Geçen ay', '2026-10-01', '2026-10-31']
          ]) {
            click(button(label));
            click(button('Hızlı'));
            click(button(text));
            assert.ok(button(text).classList.contains('active'));
            assert.equal(document.querySelectorAll('tbody tr').length, data.length, 'Uygula öncesi satırlar değişmemelidir');
            click(button('Uygula'));
            const expected = data.filter((task) => task[field] >= from && task[field] <= to);
            assert.equal(document.querySelectorAll('tbody tr').length, expected.length);
            for (const task of expected) assert.ok(document.querySelector('tbody').textContent.includes(task.task));
            click(button(label));
            assert.ok(button(text).classList.contains('active'), 'Seçili dönem yeniden açılınca korunmalıdır');
            click(button('Temizle'));
            assert.equal(document.querySelectorAll('tbody tr').length, data.length);
          }
      } finally {
        view.unmount();
      }
    });

const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
function VisibilityTrap() {
  const containerRef = React.useRef(null);
  const initialFocusRef = React.useRef(null);
  useModalFocusTrap({ containerRef, initialFocusRef, onClose() {} });
  return React.createElement('div', { ref: containerRef },
    React.createElement('style', null, '.sinama-gizli { display: none; }'),
    React.createElement('div', { hidden: true }, React.createElement('button', null, 'Gizli ata')),
    React.createElement('button', { ref: initialFocusRef }, 'İlk görünür'),
    React.createElement('button', { hidden: true }, 'Gizli öge'),
    React.createElement('button', null, 'Son görünür'),
    React.createElement('div', { className: 'sinama-gizli' }, React.createElement('button', null, 'Sınıfla gizli')),
    React.createElement('div', { style: { display: 'none' } }, React.createElement('button', null, 'Biçemle gizli'))
  );
}

test('Odak tuzağı gizli ögeleri ve gizli ataların altındaki düğmeleri sekme sınırına almaz', () => {
  const view = mountDom(VisibilityTrap);
  try {
    click(button('Son görünür'));
    key('Tab');
    assert.equal(document.activeElement?.textContent, 'İlk görünür');
    key('Tab', document.activeElement, { shiftKey: true });
    assert.equal(document.activeElement?.textContent, 'Son görünür');
    for (const text of ['Gizli ata', 'Gizli öge', 'Sınıfla gizli', 'Biçemle gizli'])
      assert.equal(button(text).offsetParent, null, text);
  } finally {
    view.unmount();
  }
});

for (const generic of [false, true])
  for (const [from, to, expected] of [['10/09/2026', '', 2], ['', '10/09/2026', 1], ['', '', 2]])
    test(`${generic ? 'Genel' : 'Tarih'} süzgeci boş aralık uçlarının mevcut anlamını korur (${from}, ${to})`, () => {
      const view = mountDom(FilterTable, { generic });
      try {
        click(button('Tarih'));
        click(button('Arası'));
        const inputs = document.querySelectorAll('.date-input-shell input');
        enter(inputs[0], from);
        enter(inputs[1], to);
        click(button('Uygula'));
        assert.equal(document.querySelector('.col-filter-pop'), null);
        assert.equal(document.querySelectorAll('tbody tr').length, expected);
      } finally {
        view.unmount();
      }
    });

for (const simple of [false, true])
  for (const dashboard of [false, true])
    for (const [now, preset, before, after] of [
      ['2026-11-08', 'Geçen hafta', 2, 3],
      ['2026-11-30', 'Geçen ay', 1, 4]
    ])
      test(`${dashboard ? 'Özet KPI' : 'Görevler'} ${simple ? 'Temel' : 'Kapsamlı'} Kip ${preset} süzgeci açıkken dönem sınırını yeniler`, (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(`${now}T23:59:59`) });
        const view = mountDom(dashboard ? DashboardScreen : TasksScreen, dashboard ? { variant: simple ? 'simple' : 'advanced' } : { simple }, filterState(calendarTasks));
        try {
          if (dashboard) {
            const card = [...document.querySelectorAll('.stat .label')].find((node) => node.textContent.trim() === 'Toplam görev');
            click(card.closest('[role="button"]'));
            click(button('Tüm görevleri gör'));
          }
          click(button(simple ? 'Termin' : 'Hedef'));
          click(button(preset));
          click(button('Uygula'));
          assert.equal(document.querySelectorAll('tbody tr').length, before);
          React.act(() => t.mock.timers.tick(2000));
          assert.equal(document.querySelectorAll('tbody tr').length, after);
        } finally {
          view.unmount();
        }
      });

const { CalendarView } = await import('../src/features/calendar/CalendarView.jsx');
function CalendarScreen() {
  return React.createElement(TaskOrganizationFilterProvider, null, React.createElement(CalendarView, { t: {}, setTweak() {} }));
}

test('Tarihe git penceresi kendi takvim seçimini ve Escape sırasını korur', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 12) });
  const view = mountDom(CalendarScreen, {}, filterState());
  try {
    click(button('Tarihe git'));
    click(button('Takvimden tarih seç'));
    click(button('Sonraki ay', document.querySelector('.date-picker-panel')));
    assert.ok(document.querySelector('.col-filter-pop'), 'Ay gezinmesi atlama penceresini kapatmamalıdır');
    click(button('10 Aralık 2026', document.querySelector('.date-picker-panel')));
    assert.ok(document.querySelector('.col-filter-pop'));
    click(button('Takvimden tarih seç'));
    key('Escape');
    assert.ok(document.querySelector('.col-filter-pop'));
    assert.equal(document.querySelector('.date-picker-panel'), null);
    click(button('Git'));
    assert.equal(document.querySelector('[aria-label="Ay"]').value, '11');
    assert.equal(document.querySelector('.col-filter-pop'), null);
    click(button('Tarihe git'));
    click(document.body);
    assert.equal(document.querySelector('.col-filter-pop'), null);
  } finally {
    view.unmount();
  }
});
