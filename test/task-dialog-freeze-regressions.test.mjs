/**
 * "Yeni Görev" / görev güncelleme akışının DONMA gerilemeleri.
 *
 * Bildirilen hata: kullanıcı alanları doldurup "Tamam" düğmesine bastığında
 * uygulama tamamen donuyordu. Kök neden çalışma günü aramalarının koşulsuz
 * `while` döngüleri olmasıydı:
 *
 *   - Sunucu, `MR_CalendarWorkingDays` tablosunda satırı olmayan takvimi
 *     `workingDays: []` olarak yansıtır (bkz. sqlAppRepository). Boş liste
 *     `[] || DEFAULT_WORKING_DAYS` ifadesinde korunuyor, `isWorkingDay` her gün
 *     için `false` dönüyor ve `moveToWorkingDay` / `addWorkingDays` hiç
 *     bitmiyordu.
 *   - Saat taşıyan bir ISO metni (`2026-08-18T00:00:00.000Z`) Geçersiz Tarih
 *     üretiyor, `diffWorkingDays` içindeki eşitlik hiç sağlanmıyordu.
 *
 * Bu dosyadaki her sınama, çağrının BİTTİĞİNİ de doğrular: sonsuz döngüye
 * dönen bir gerileme, sınama koşucusunu askıda bırakmak yerine süre sınırında
 * yakalanır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addWorkingDays,
  countWorkingDays,
  diffWorkingDays,
  isWorkingDay,
  moveToWorkingDay,
  normalizeCalendar,
  DEFAULT_WORKING_DAYS
} from '../src/scheduling/calendars/index.js';
import { fmtISO, isValidDate, parseDate } from '../src/scheduling/dates/index.js';
import { calculateCpm } from '../src/scheduling/cpm/engine.js';
import { createNewTask } from '../src/state/appState.js';
import { createTaskUpdateTracker } from '../src/features/task-detail/taskDraft.js';

/** Sunucunun çalışma günü satırı olmayan takvim için ürettiği biçim. */
const emptyWorkingDayCalendar = {
  id: 'calendar-empty',
  name: 'Çalışma günü tanımsız',
  timezone: 'Europe/Istanbul',
  workingDays: [],
  holidays: []
};

/** Her günü tatil olan takvim: hiçbir arama karşılık bulamaz. */
const allHolidayCalendar = {
  id: 'calendar-holiday',
  name: 'Tümü tatil',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: Array.from({ length: 4000 }, (unused, index) => {
    const date = new Date(2026, 0, 1 + index);
    return { date: fmtISO(date), name: 'Tatil', short: 'Tatil' };
  })
};

function taskState(overrides = {}) {
  return {
    session: { dataMode: 'demo' },
    currentUser: null,
    workspaceMode: 'project',
    selectedProjectId: 'project-1',
    projects: [{ id: 'project-1', name: 'Proje', color: 'blue', calendarId: 'calendar-empty' }],
    calendars: [emptyWorkingDayCalendar],
    wbs: [{ id: 'wbs-root', projectId: 'project-1', parentId: null, code: '1', name: 'Proje', sortOrder: 1 }],
    people: [{ id: '100', employeeNo: '100', name: 'Sorumlu' }],
    tasks: [],
    ...overrides
  };
}

/* ── Boş çalışma günü listesi ───────────────────────────────────── */

test('boş çalışma günü listesi varsayılan haftaya düşer', () => {
  assert.equal(isWorkingDay('2026-08-24', emptyWorkingDayCalendar), true);
  assert.equal(isWorkingDay('2026-08-23', emptyWorkingDayCalendar), false);
  assert.deepEqual(
    normalizeCalendar(emptyWorkingDayCalendar).workingDays,
    [...DEFAULT_WORKING_DAYS]
  );
});

test('çalışma günü aramaları boş listeli takvimde BİTER', () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-08-22', emptyWorkingDayCalendar, 1)), '2026-08-24');
  assert.equal(fmtISO(addWorkingDays('2026-08-24', 5, emptyWorkingDayCalendar)), '2026-08-31');
  assert.equal(diffWorkingDays('2026-08-31', '2026-08-24', emptyWorkingDayCalendar), 5);
  assert.equal(countWorkingDays('2026-08-24', '2026-08-28', emptyWorkingDayCalendar), 5);
});

test('hiçbir günü çalışılmayan takvimde aramalar girişe düşer, döngüye girmez', () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-08-24', allHolidayCalendar, 1)), '2026-08-24');
  assert.equal(fmtISO(addWorkingDays('2026-08-24', 3, allHolidayCalendar)), '2026-08-24');
  assert.equal(countWorkingDays('2026-08-24', '2026-08-28', allHolidayCalendar), 0);
});

/* ── Geçersiz / saat taşıyan tarihler ───────────────────────────── */

test('parseDate saat taşıyan ISO metnini okur', () => {
  assert.equal(fmtISO(parseDate('2026-08-18T00:00:00.000Z')), '2026-08-18');
  assert.equal(fmtISO(parseDate('2026-08-18 09:30')), '2026-08-18');
  assert.equal(isValidDate(parseDate('18/08/2026')), false);
  assert.equal(isValidDate(parseDate('2026-08-18')), true);
});

test('çözülemeyen tarihte iş günü hesapları döngüye girmez', () => {
  assert.equal(diffWorkingDays('18/08/2026', '2026-08-24'), 0);
  assert.equal(diffWorkingDays('2026-08-24', 'çöp'), 0);
  assert.equal(countWorkingDays('çöp', '2026-08-24'), 0);
  assert.equal(isValidDate(moveToWorkingDay('çöp')), false);
  assert.equal(isValidDate(addWorkingDays('çöp', 3)), false);
});

/* ── Uçtan uca: görev oluşturma ve zamanlama ────────────────────── */

test('yeni görev, çalışma günü tanımsız takvimli projede oluşturulabilir', () => {
  const task = createNewTask(taskState(), '2026-08-22', 'yeni-1');

  assert.equal(task.projectId, 'project-1');
  assert.equal(task.plannedStart, '2026-08-24');
  assert.equal(task.plannedFinish, '2026-08-31');
  assert.equal(task.targetFinish, '2026-09-02');
});

test('CPM hesabı, saat taşıyan tarihler ve boş takvimle biter', () => {
  const tasks = [
    {
      id: 'A',
      projectId: 'project-1',
      plannedStart: '2026-08-24T00:00:00.000Z',
      plannedFinish: '2026-08-26T00:00:00.000Z',
      plannedDurationDays: 3,
      deps: []
    },
    {
      id: 'B',
      projectId: 'project-1',
      plannedStart: '2026-08-27T00:00:00.000Z',
      plannedFinish: '2026-08-28T00:00:00.000Z',
      plannedDurationDays: 2,
      deps: [{ predecessorId: 'A', type: 'FS', lagDays: 0 }]
    }
  ];

  const result = calculateCpm(tasks, {
    projects: [{ id: 'project-1', name: 'Proje', calendarId: 'calendar-empty' }],
    calendars: [emptyWorkingDayCalendar]
  });

  assert.equal(result.projectStart, '2026-08-24');
  assert.equal(result.tasks.A.earlyStart, '2026-08-24');
  assert.equal(result.criticalPathsTruncated, false);
});

test('kritik yol sayımı üst sınırda kesilir ve kritik görevler eksilmez', () => {
  // Art arda elmas desenleri yol sayısını üstel büyütür: 20 katman ≈ 1M yol.
  const layers = 20;
  const tasks = [{ id: 'start', projectId: 'p', plannedStart: '2026-08-24', plannedDurationDays: 1, deps: [] }];
  let previous = 'start';
  for (let layer = 0; layer < layers; layer += 1) {
    const left = `l${layer}`;
    const right = `r${layer}`;
    const join = `j${layer}`;
    tasks.push({ id: left, projectId: 'p', plannedDurationDays: 1, deps: [{ predecessorId: previous, type: 'FS', lagDays: 0 }] });
    tasks.push({ id: right, projectId: 'p', plannedDurationDays: 1, deps: [{ predecessorId: previous, type: 'FS', lagDays: 0 }] });
    tasks.push({
      id: join,
      projectId: 'p',
      plannedDurationDays: 1,
      deps: [
        { predecessorId: left, type: 'FS', lagDays: 0 },
        { predecessorId: right, type: 'FS', lagDays: 0 }
      ]
    });
    previous = join;
  }

  const started = Date.now();
  const result = calculateCpm(tasks, { projects: [{ id: 'p', name: 'P' }], calendars: [] });

  assert.equal(result.criticalPathsTruncated, true);
  assert.ok(result.criticalPaths.length <= 500, 'yol sayımı üst sınırı aşmamalıdır');
  assert.ok(result.criticalTaskIds.length >= layers, 'kritik görev kümesi eksilmemelidir');
  assert.ok(Date.now() - started < 10000, 'hesap makul sürede bitmelidir');
});

/* ── "Tamam" düğmesinin bekleme zinciri ─────────────────────────── */

test('bekleyen kayıt izleyicisi boşa düştüğünde "Tamam" serbest kalır', async () => {
  const tracker = createTaskUpdateTracker();
  let resolveSave;
  tracker.track(new Promise((resolve) => { resolveSave = resolve; }));

  let released = false;
  const idle = tracker.waitForIdle().then((result) => {
    released = true;
    return result;
  });

  assert.equal(released, false);
  resolveSave({ ok: true, value: null });
  assert.deepEqual(await idle, { ok: true, value: null });
  assert.equal(tracker.getPendingCount(), 0);
});

test('reddedilen kayıt paneli rehin almaz', async () => {
  const tracker = createTaskUpdateTracker();
  tracker.track(Promise.reject(new Error('sunucu reddetti')));
  const result = await tracker.waitForIdle();
  assert.equal(result.ok, false);
});
