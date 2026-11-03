import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import { buildDependencyGraph, calculateCpm } from '../src/scheduling/cpm/index.js';

const standardCalendar = normalizeCalendar({
  id: 'cal-standard',
  name: 'Standard',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});

const sixDayCalendar = normalizeCalendar({
  id: 'cal-six-day',
  name: 'Six Day',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: []
});

const holidayCalendar = normalizeCalendar({
  id: 'cal-holiday',
  name: 'Holiday',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: [{ date: '2026-06-03', name: 'Test Holiday', short: 'Holiday' }]
});

const projects = [{ id: 'p1', name: 'Project', calendarId: standardCalendar.id }];
const calendars = [standardCalendar, sixDayCalendar, holidayCalendar];

function activity(id, plannedDurationDays, deps = [], extra = {}) {
  return {
    id,
    projectId: 'p1',
    task: id,
    plannedDurationDays,
    deps,
    ...extra
  };
}

function dep(predecessorId, type = 'FS', lagDays = 0) {
  return { predecessorId, type, lagDays };
}

function run(tasks, options = {}) {
  return calculateCpm(tasks, {
    projects,
    calendars,
    projectStart: '2026-06-01',
    ...options
  });
}

test("ardışık FS faaliyetleri sıfır bolluklu kritik zincir üretir", () => {
  const result = run([
    activity('A', 3),
    activity('B', 2, [dep('A')])
  ]);

  assert.equal(result.projectStart, '2026-06-01');
  assert.equal(result.projectFinish, '2026-06-05');
  assert.deepEqual(result.criticalTaskIds, ['A', 'B']);
  assert.deepEqual(result.criticalPaths, [['A', 'B']]);
  assert.deepEqual(result.tasks.A, {
    id: 'A',
    calendarId: standardCalendar.id,
    durationDays: 3,
    earlyStart: '2026-06-01',
    earlyFinish: '2026-06-03',
    lateStart: '2026-06-01',
    lateFinish: '2026-06-03',
    totalFloatDays: 0,
    freeFloatDays: 0,
    isCritical: true
  });
  assert.equal(result.tasks.B.earlyStart, '2026-06-04');
  assert.equal(result.tasks.B.earlyFinish, '2026-06-05');
});

test("paralel yollar toplam ve serbest bolluğu hesaplayıp uzun kritik yolu bulur", () => {
  const result = run([
    activity('A', 2),
    activity('B', 3, [dep('A')]),
    activity('C', 1, [dep('A')]),
    activity('D', 1, [dep('B'), dep('C')])
  ]);

  assert.equal(result.projectFinish, '2026-06-08');
  assert.deepEqual(result.criticalTaskIds, ['A', 'B', 'D']);
  assert.deepEqual(result.criticalPaths, [['A', 'B', 'D']]);
  assert.equal(result.tasks.C.earlyStart, '2026-06-03');
  assert.equal(result.tasks.C.lateStart, '2026-06-05');
  assert.equal(result.tasks.C.totalFloatDays, 2);
  assert.equal(result.tasks.C.freeFloatDays, 2);
  assert.equal(result.tasks.C.isCritical, false);
});

test("eşit paralel yolların ikisi de kritik yol olarak döner", () => {
  const result = run([
    activity('A', 1),
    activity('B', 2, [dep('A')]),
    activity('C', 2, [dep('A')]),
    activity('D', 1, [dep('B'), dep('C')])
  ]);

  assert.deepEqual(result.criticalTaskIds, ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.criticalPaths, [
    ['A', 'B', 'D'],
    ['A', 'C', 'D']
  ]);
});

test("ileri geçiş SS FF ve SF ilişkisini destekler", () => {
  const result = run([
    activity('A', 3),
    activity('B', 2, [dep('A', 'SS', 1)]),
    activity('C', 2, [dep('A', 'FF')]),
    activity('D', 2, [dep('A', 'SF', 2)])
  ]);

  assert.equal(result.tasks.A.earlyStart, '2026-06-01');
  assert.equal(result.tasks.A.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.B.earlyStart, '2026-06-02');
  assert.equal(result.tasks.B.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.C.earlyStart, '2026-06-02');
  assert.equal(result.tasks.C.earlyFinish, '2026-06-03');
  assert.equal(result.tasks.D.earlyStart, '2026-06-02');
  assert.equal(result.tasks.D.earlyFinish, '2026-06-03');
});

test("FS gecikme ve öne alma iş günüyle ölçülür", () => {
  const result = run([
    activity('A', 2),
    activity('Lagged', 1, [dep('A', 'FS', 1)]),
    activity('Led', 1, [dep('A', 'FS', -1)])
  ]);

  assert.equal(result.tasks.A.earlyFinish, '2026-06-02');
  assert.equal(result.tasks.Lagged.earlyStart, '2026-06-04');
  assert.equal(result.tasks.Led.earlyStart, '2026-06-02');
});

test("CPM tarih hesabı proje tatilini atlar", () => {
  const result = calculateCpm([
    activity('A', 2, [], { calendarId: holidayCalendar.id }),
    activity('B', 1, [dep('A')], { calendarId: holidayCalendar.id })
  ], {
    projects,
    calendars,
    projectStart: '2026-06-01'
  });

  assert.equal(result.tasks.A.earlyFinish, '2026-06-02');
  assert.equal(result.tasks.B.earlyStart, '2026-06-04');
});

test("görev takvimi değişimi ardıl çizelgesini etkiler", () => {
  const result = run([
    activity('A', 5),
    activity('B', 1, [dep('A')], { calendarId: sixDayCalendar.id })
  ]);

  assert.equal(result.tasks.A.earlyFinish, '2026-06-05');
  assert.equal(result.tasks.B.calendarId, sixDayCalendar.id);
  assert.equal(result.tasks.B.earlyStart, '2026-06-06');
  assert.equal(result.projectFinish, '2026-06-06');
});

test("süre güncel plan iş gününden türetilir; kilometre taşı sıfır süre kalır", () => {
  const result = calculateCpm([
    {
      id: 'A', projectId: 'p1', task: 'A', deps: [],
      plannedStart: '2026-06-01', plannedFinish: '2026-06-05'
    },
    {
      id: 'M', projectId: 'p1', task: 'M', milestone: true,
      deps: [dep('A')], plannedStart: '2026-06-08', plannedFinish: '2026-06-08'
    }
  ], {
    projects,
    calendars,
    projectStart: '2026-06-01'
  });

  assert.equal(result.tasks.A.durationDays, 5);
  assert.equal(result.tasks.M.durationDays, 0);
  assert.equal(result.tasks.M.earlyStart, '2026-06-08');
  assert.equal(result.tasks.M.earlyFinish, '2026-06-08');
});

test("ağ doğrulaması eksik öncül öz bağımlılık yinelenen kimlik ve döngüyü reddeder", () => {
  assert.throws(
    () => buildDependencyGraph([activity('A', 1, [dep('missing')])]),
    (error) => error.code === 'MISSING_PREDECESSOR'
  );
  assert.throws(
    () => buildDependencyGraph([activity('A', 1, [dep('A')])]),
    (error) => error.code === 'SELF_DEPENDENCY'
  );
  assert.throws(
    () => buildDependencyGraph([activity('A', 1), activity('A', 2)]),
    (error) => error.code === 'DUPLICATE_TASK_ID'
  );
  assert.throws(
    () => buildDependencyGraph([
      activity('A', 1, [dep('B')]),
      activity('B', 1, [dep('A')])
    ]),
    (error) => error.code === 'DEPENDENCY_CYCLE'
  );
});

test("plannedDurationDays yoksa geçersiz güncel plan tarihi reddedilir", () => {
  assert.throws(
    () => calculateCpm([{
      id: 'A', projectId: 'p1', task: 'A', deps: [],
      plannedStart: '2026-06-05', plannedFinish: '2026-06-01'
    }], {
      projects,
      calendars,
      projectStart: '2026-06-01'
    }),
    (error) => error.code === 'INVALID_TASK_DATES'
  );
});
