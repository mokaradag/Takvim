import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtISO } from '../src/scheduling/dates/index.js';
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  countWorkingDays,
  diffWorkingDays,
  holidayFor,
  isWorkingDay,
  moveToWorkingDay,
  normalizeCalendar,
  resolveProjectCalendar,
  resolveTaskCalendar
} from '../src/scheduling/calendars/index.js';
import { applyDependencyLag } from '../src/scheduling/dependencies/index.js';

const operationsCalendar = normalizeCalendar({
  id: 'cal-operations',
  name: 'Operations',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: DEFAULT_CALENDAR.holidays
});

const calendars = [DEFAULT_CALENDAR, operationsCalendar];
const projects = [
  { id: 'p-standard', name: 'Standard', calendarId: DEFAULT_CALENDAR.id },
  { id: 'p-operations', name: 'Operations', calendarId: operationsCalendar.id }
];

test("tatil yinelenen ay gün yerine açık yıla özgü tarihtir", () => {
  assert.equal(holidayFor('2026-07-15', DEFAULT_CALENDAR)?.short, '15 Temmuz');
  // Sabit tarihli ulusal bayramlar 2028'e kadar YAZILIDIR; kapsam dışı bir yıl
  // kendiliğinden yinelenmez (kural değil, tarih listesi tutulur).
  assert.equal(holidayFor('2027-07-15', DEFAULT_CALENDAR)?.short, '15 Temmuz');
  assert.equal(holidayFor('2029-07-15', DEFAULT_CALENDAR), null);
});

test("hareketli dinî tatiller gelecek yıl için tahmin edilmez", () => {
  // Ramazan/Kurban resmî ilanla kesinleşir: yalnızca 2026 için yazılıdır,
  // sonraki yıllar kurulumun kendi takvim tanımından gelir.
  assert.equal(holidayFor('2026-03-20', DEFAULT_CALENDAR)?.short, 'Ramazan B.');
  assert.equal(holidayFor('2027-03-09', DEFAULT_CALENDAR), null);
});

test("standart ve projeye özel takvim farklı iş günleri tanımlayabilir", () => {
  assert.equal(isWorkingDay('2026-07-18', DEFAULT_CALENDAR), false);
  assert.equal(isWorkingDay('2026-07-18', operationsCalendar), true);
  assert.equal(isWorkingDay('2026-07-15', operationsCalendar), false);
});

test("iş günü ekleme iki yönde hafta sonunu ve açık tatili atlar", () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-14', 1, DEFAULT_CALENDAR)), '2026-07-16');
  assert.equal(fmtISO(addWorkingDays('2026-07-17', 1, DEFAULT_CALENDAR)), '2026-07-20');
  assert.equal(fmtISO(addWorkingDays('2026-07-17', 1, operationsCalendar)), '2026-07-18');
  assert.equal(fmtISO(addWorkingDays('2026-07-20', -3, DEFAULT_CALENDAR)), '2026-07-14');
});

test("iş günü farkı iş günü eklemenin tersidir", () => {
  for (const amount of [-5, -2, -1, 0, 1, 2, 5]) {
    const shifted = addWorkingDays('2026-07-14', amount, DEFAULT_CALENDAR);
    assert.equal(diffWorkingDays(shifted, '2026-07-14', DEFAULT_CALENDAR), amount);
  }
});

test("dahil iş günü sayımı seçili takvimi izler", () => {
  assert.equal(countWorkingDays('2026-07-13', '2026-07-17', DEFAULT_CALENDAR), 4);
  assert.equal(countWorkingDays('2026-07-13', '2026-07-18', operationsCalendar), 5);
  assert.equal(countWorkingDays('2026-07-17', '2026-07-13', DEFAULT_CALENDAR), -4);
});

test("iş dışı tarih iki yönde en yakın iş gününe hizalanabilir", () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-15', DEFAULT_CALENDAR, 1)), '2026-07-16');
  assert.equal(fmtISO(moveToWorkingDay('2026-07-15', DEFAULT_CALENDAR, -1)), '2026-07-14');
  assert.equal(fmtISO(moveToWorkingDay('2026-07-19', DEFAULT_CALENDAR, 1)), '2026-07-20');
});

test("görev takvimi çözümü görev proje ve dönüş takvimi sırasını izler", () => {
  assert.equal(
    resolveTaskCalendar({ projectId: 'p-operations' }, projects, calendars).id,
    operationsCalendar.id
  );
  assert.equal(
    resolveTaskCalendar({ projectId: 'p-operations', calendarId: DEFAULT_CALENDAR.id }, projects, calendars).id,
    DEFAULT_CALENDAR.id
  );
  assert.equal(
    resolveTaskCalendar({ projectId: 'missing' }, projects, calendars).id,
    DEFAULT_CALENDAR.id
  );
  assert.equal(resolveProjectCalendar(projects[0], calendars).id, DEFAULT_CALENDAR.id);
});

test("bağımlılık gecikmesi ve öne alma iş günü olarak uygulanır", () => {
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-14', { predecessorId: 'a', type: 'FS', lagDays: 1 }, DEFAULT_CALENDAR)),
    '2026-07-16'
  );
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-17', { predecessorId: 'a', type: 'FS', lagDays: 1 }, operationsCalendar)),
    '2026-07-18'
  );
  assert.equal(
    fmtISO(applyDependencyLag('2026-07-20', { predecessorId: 'a', type: 'FS', lagDays: -1 }, DEFAULT_CALENDAR)),
    '2026-07-17'
  );
});
