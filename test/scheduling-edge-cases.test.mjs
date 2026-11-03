import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TR_DAYS,
  TR_MONTHS,
  TR_MONTHS_LONG,
  addDays,
  diffDays,
  eachDay,
  endOfMonth,
  endOfWeek,
  fmt,
  fmtISO,
  isSameDay,
  isWeekend,
  parseDate,
  startOfMonth,
  startOfWeek,
  today
} from '../src/scheduling/dates/index.js';
import {
  DEFAULT_CALENDAR,
  DEFAULT_WORKING_DAYS,
  TURKEY_HOLIDAYS_2026,
  addWorkingDays,
  calendarById,
  countWorkingDays,
  diffWorkingDays,
  holidayFor,
  isWorkingDay,
  moveToWorkingDay,
  normalizeCalendar,
  resolveProjectCalendar,
  resolveTaskCalendar
} from '../src/scheduling/calendars/index.js';
import {
  REL_TYPES,
  applyDependencyLag,
  depId,
  normalizeDependency,
  relTypeOf
} from '../src/scheduling/dependencies/index.js';
import {
  getGroupScheduleSummaries,
  getStatus,
  getTaskDateRange,
  selectTaskStats,
  taskPlannedDurationDays
} from '../src/scheduling/metrics/index.js';
import {
  calculatePlannedDurationDays,
  normalizeTaskPlan
} from '../src/scheduling/plans/index.js';

const weekdayCalendar = normalizeCalendar({
  id: 'weekday',
  name: 'Weekday',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});
const sixDayCalendar = normalizeCalendar({
  id: 'six-day',
  name: 'Six Day',
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: []
});
const noWorkCalendar = normalizeCalendar({
  id: 'none',
  name: 'None',
  workingDays: [],
  holidays: []
});
const projects = [
  { id: 'p1', name: 'Project One', calendarId: weekdayCalendar.id },
  { id: 'p2', name: 'Project Two', calendarId: sixDayCalendar.id }
];
const calendars = [weekdayCalendar, sixDayCalendar];

test("tarih etiket sabitleri tam Türkçe ay ve gün kümesini sunar", () => {
  assert.equal(TR_MONTHS.length, 12);
  assert.equal(TR_MONTHS_LONG.length, 12);
  assert.equal(TR_DAYS.length, 7);
  assert.equal(TR_MONTHS[0], 'Oca');
  assert.equal(TR_MONTHS_LONG[7], 'Ağustos');
  assert.equal(TR_DAYS[6], 'Paz');
});

test("parseDate mevcut Date örneğini değiştirmeden döndürür", () => {
  const date = new Date(2026, 6, 22);
  assert.strictEqual(parseDate(date), date);
});

test("parseDate değer verilmezse geçerli güncel Date döndürür", () => {
  const before = Date.now();
  const result = parseDate();
  const after = Date.now();
  assert.equal(result instanceof Date, true);
  assert.equal(result.getTime() >= before && result.getTime() <= after, true);
});

test("fmtISO tek haneli ay ve günü sıfırla tamamlar", () => {
  assert.equal(fmtISO(new Date(2026, 0, 5)), '2026-01-05');
});

test("fmt her açık proje tarih biçimini destekler", () => {
  assert.equal(fmt('2026-08-03'), '03 Ağu');
  assert.equal(fmt('2026-08-03', 'dd MMM yyyy'), '03 Ağu 2026');
  assert.equal(fmt('2026-08-03', 'MMM yyyy'), 'Ağustos 2026');
  assert.equal(fmt('2026-08-03', 'd'), '3');
  assert.equal(fmt('2026-08-03', 'EEE d'), 'Pzt 3');
});

test("addDays ay yıl ve artık gün sınırını geçer", () => {
  assert.equal(fmtISO(addDays('2026-12-31', 1)), '2027-01-01');
  assert.equal(fmtISO(addDays('2028-02-28', 1)), '2028-02-29');
  assert.equal(fmtISO(addDays('2028-03-01', -1)), '2028-02-29');
});

test("diffDays yönü korur", () => {
  assert.equal(diffDays('2026-07-20', '2026-07-22'), -2);
  assert.equal(diffDays('2026-07-22', '2026-07-20'), 2);
  assert.equal(diffDays('2026-07-22', '2026-07-22'), 0);
});

test("ay sınırları şubat ayını doğru işler", () => {
  assert.equal(fmtISO(startOfMonth('2028-02-15')), '2028-02-01');
  assert.equal(fmtISO(endOfMonth('2028-02-15')), '2028-02-29');
  assert.equal(fmtISO(endOfMonth('2026-02-15')), '2026-02-28');
});

test("hafta sınırları pazartesi ve pazardır", () => {
  assert.equal(fmtISO(startOfWeek('2026-07-26')), '2026-07-20');
  assert.equal(fmtISO(endOfWeek('2026-07-20')), '2026-07-26');
});

test("isSameDay metin ve Date değerlerinde takvim alanını karşılaştırır", () => {
  assert.equal(isSameDay('2026-07-22', new Date(2026, 6, 22)), true);
  assert.equal(isSameDay('2026-07-22', '2026-07-23'), false);
});

test("isWeekend cuma cumartesi ve pazarı ayırır", () => {
  assert.equal(isWeekend('2026-07-24'), false);
  assert.equal(isWeekend('2026-07-25'), true);
  assert.equal(isWeekend('2026-07-26'), true);
});

test("today yerel gece yarısını döndürür", () => {
  const result = today();
  assert.equal(result.getHours(), 0);
  assert.equal(result.getMinutes(), 0);
  assert.equal(result.getSeconds(), 0);
  assert.equal(result.getMilliseconds(), 0);
});

test("eachDay iki ucu dahil eder ve ay sınırını geçer", () => {
  assert.deepEqual(eachDay('2026-07-31', '2026-08-02').map(fmtISO), [
    '2026-07-31',
    '2026-08-01',
    '2026-08-02'
  ]);
});

test("eachDay başlangıç sondan sonraysa boş aralık döndürür", () => {
  assert.deepEqual(eachDay('2026-08-02', '2026-07-31'), []);
});

test("varsayılan takvim sabitleri donmuştur ve beş iş günü sunar", () => {
  assert.equal(Object.isFrozen(DEFAULT_WORKING_DAYS), true);
  assert.equal(Object.isFrozen(TURKEY_HOLIDAYS_2026), true);
  assert.equal(Object.isFrozen(DEFAULT_CALENDAR), true);
  assert.deepEqual(DEFAULT_WORKING_DAYS, [1, 2, 3, 4, 5]);
});

test("normalizeCalendar eksik kimlik alanına varsayılanı doldurur", () => {
  const result = normalizeCalendar({ workingDays: [1], holidays: [] });
  assert.equal(result.id, DEFAULT_CALENDAR.id);
  assert.equal(result.name, DEFAULT_CALENDAR.name);
  assert.equal(result.timezone, DEFAULT_CALENDAR.timezone);
  assert.deepEqual(result.workingDays, [1]);
});

test("normalizeCalendar değişebilir dizileri ve tatil nesnelerini kopyalar", () => {
  const input = {
    id: 'clone-test',
    workingDays: [1, 2],
    holidays: [{ date: '2026-01-02', name: 'Holiday', short: 'H' }]
  };
  const result = normalizeCalendar(input);
  assert.notStrictEqual(result.workingDays, input.workingDays);
  assert.notStrictEqual(result.holidays, input.holidays);
  assert.notStrictEqual(result.holidays[0], input.holidays[0]);
  result.workingDays.push(3);
  result.holidays[0].name = 'Changed';
  assert.deepEqual(input.workingDays, [1, 2]);
  assert.equal(input.holidays[0].name, 'Holiday');
});

test("calendarById eksik koleksiyon ve kimliği güvenle işler", () => {
  assert.equal(calendarById(undefined, 'missing'), null);
  assert.equal(calendarById(calendars, 'missing'), null);
  assert.strictEqual(calendarById(calendars, 'six-day'), sixDayCalendar);
});

test("resolveProjectCalendar bilinmeyen takvimde verilen dönüşü kullanır", () => {
  const fallback = { id: 'fallback' };
  assert.strictEqual(resolveProjectCalendar({ calendarId: 'missing' }, calendars, fallback), fallback);
});

test("resolveTaskCalendar proje kimliği yoksa eski görünüm adıyla eşleştirir", () => {
  assert.equal(resolveTaskCalendar({ proje: 'Project Two' }, projects, calendars).id, 'six-day');
});

test("resolveTaskCalendar görev takvimini proje seçiminden önce kullanır", () => {
  assert.equal(resolveTaskCalendar({ projectId: 'p1', calendarId: 'six-day' }, projects, calendars).id, 'six-day');
});

test("holidayFor Date örneğini kabul eder; olağan günde boş değer döndürür", () => {
  assert.equal(holidayFor(new Date(2026, 6, 15))?.short, '15 Temmuz');
  assert.equal(holidayFor('2026-07-16'), null);
});

test("boş iş günü listesi varsayılan iş haftasına döner", () => {
  // Boş liste GEÇERLİ bir yapılandırma değildir: sunucu, çalışma günü satırı
  // olmayan takvimi `workingDays: []` olarak yansıtıyor ve her arama
  // karşılıksız kalıyordu. Varsayılan haftaya düşmek tek tutarlı davranıştır.
  assert.deepEqual(noWorkCalendar.workingDays, [...DEFAULT_WORKING_DAYS]);
  assert.equal(isWorkingDay('2026-07-22', noWorkCalendar), true);
  assert.equal(isWorkingDay('2026-07-22', { id: 'raw', workingDays: [] }), true);
  assert.equal(isWorkingDay('2026-07-25', { id: 'raw', workingDays: [] }), false);
});

test("moveToWorkingDay sıfır yönü ileri sayar", () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-25', weekdayCalendar, 0)), '2026-07-27');
});

test("moveToWorkingDay mevcut iş gününü değiştirmez", () => {
  assert.equal(fmtISO(moveToWorkingDay('2026-07-22', weekdayCalendar, -1)), '2026-07-22');
});

test("addWorkingDays ilerlemeden önce kesirli miktarı keser", () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-20', 2.9, weekdayCalendar)), '2026-07-22');
  assert.equal(fmtISO(addWorkingDays('2026-07-20', -2.9, weekdayCalendar)), '2026-07-16');
});

test("addWorkingDays sonlu olmayanı sıfır sayar ve otomatik hizalamaz", () => {
  assert.equal(fmtISO(addWorkingDays('2026-07-25', Number.NaN, weekdayCalendar)), '2026-07-25');
  assert.equal(fmtISO(addWorkingDays('2026-07-25', Infinity, weekdayCalendar)), '2026-07-25');
});

test("diffWorkingDays yalnızca başlangıçtan sonra ulaşılan iş gününü sayar", () => {
  assert.equal(diffWorkingDays('2026-07-27', '2026-07-24', weekdayCalendar), 1);
  assert.equal(diffWorkingDays('2026-07-24', '2026-07-27', weekdayCalendar), -1);
});

test("countWorkingDays aynı iş gününü dahil sayar", () => {
  assert.equal(countWorkingDays('2026-07-22', '2026-07-22', weekdayCalendar), 1);
  assert.equal(countWorkingDays('2026-07-25', '2026-07-25', weekdayCalendar), 0);
});

test("countWorkingDays ters aralıkta işaretli dahil sayı döndürür", () => {
  assert.equal(countWorkingDays('2026-07-20', '2026-07-24', weekdayCalendar), 5);
  assert.equal(countWorkingDays('2026-07-24', '2026-07-20', weekdayCalendar), -5);
});

test("bağımlılık ilişki üstverisi dört desteklenen türü içerir", () => {
  assert.deepEqual(Object.keys(REL_TYPES), ['FS', 'SS', 'FF', 'SF']);
  assert.equal(REL_TYPES.SF.code, 'SF');
});

test("depId boş ve eski bağımlılık kaydını işler", () => {
  assert.equal(depId(null), null);
  assert.equal(depId(undefined), null);
  assert.equal(depId({ id: 'legacy' }), 'legacy');
  assert.equal(depId({ predecessorId: 'canonical', id: 'legacy' }), 'canonical');
});

test("relTypeOf metin boş kayıt ve bilinmeyen türü FS varsayar", () => {
  assert.equal(relTypeOf('task-1'), 'FS');
  assert.equal(relTypeOf(null), 'FS');
  assert.equal(relTypeOf({ type: 'XX' }), 'FS');
  assert.equal(relTypeOf({ type: 'SS' }), 'SS');
});

test("normalizeDependency sonlu kesirli ve negatif gecikmeyi korur", () => {
  assert.deepEqual(normalizeDependency({ predecessorId: 'a', type: 'FF', lagDays: -1.5 }), {
    id: 'a', predecessorId: 'a', type: 'FF', lagDays: -1.5
  });
});

test("normalizeDependency sonlu olmayan gecikmeyi sıfır yapar", () => {
  assert.equal(normalizeDependency({ id: 'a', lagDays: Infinity }).lagDays, 0);
  assert.equal(normalizeDependency({ id: 'a', lagDays: Number.NaN }).lagDays, 0);
});

test("applyDependencyLag normal sıfır gecikmede iş dışı günü hizalamaz", () => {
  assert.equal(fmtISO(applyDependencyLag('2026-07-25', { predecessorId: 'a' }, weekdayCalendar)), '2026-07-25');
});

test("taskPlannedDurationDays negatifi sınırlar ve sonlu olmayanı reddeder", () => {
  assert.equal(taskPlannedDurationDays({ plannedDurationDays: -3 }), 0);
  assert.equal(taskPlannedDurationDays({ plannedDurationDays: Infinity }), 0);
  assert.equal(taskPlannedDurationDays({}), 0);
});

test("getTaskDateRange sıfır payı destekler", () => {
  const range = getTaskDateRange([{ plannedStart: '2026-07-10', plannedFinish: '2026-07-12' }], { paddingDays: 0 });
  assert.equal(fmtISO(range.start), '2026-07-10');
  assert.equal(fmtISO(range.end), '2026-07-12');
});

test("getTaskDateRange boş veride verilen Date dönüş nesnesini başlangıç yapar", () => {
  const fallbackStart = new Date(2026, 0, 10);
  const range = getTaskDateRange([], { fallbackStart, fallbackDays: 2 });
  assert.strictEqual(range.start, fallbackStart);
  assert.equal(fmtISO(range.end), '2026-01-12');
});

test("grup özeti tamamlanmış durumda bile açık ilerlemeyi kullanır", () => {
  const summary = getGroupScheduleSummaries([['g', [{
    plannedStart: '2026-07-01', plannedFinish: '2026-07-02', plannedDurationDays: 2, progress: 25, status: 'done'
  }]]]).g;
  assert.equal(summary.progress, 25);
  assert.equal(summary.done, 1);
});

test("grup özeti bütün süreler sıfırsa ağırlıksız ortalamaya döner", () => {
  // Ağırlıklı ortalamanın paydası 0 olduğunda sabit 0 yazmak, hepsi
  // tamamlanmış bir grubu %0 gösteriyordu.
  const summary = getGroupScheduleSummaries([['g', [{
    plannedStart: '2026-07-01', plannedFinish: '2026-07-01', plannedDurationDays: 0, progress: 100
  }]]]).g;
  assert.equal(summary.progress, 100);

  const mixed = getGroupScheduleSummaries([['g', [
    { plannedStart: '2026-07-01', plannedFinish: '2026-07-01', plannedDurationDays: 0, progress: 100 },
    { plannedStart: '2026-07-01', plannedFinish: '2026-07-01', plannedDurationDays: 0, progress: 0 }
  ]]]).g;
  assert.equal(mixed.progress, 50);
});

test("tamamlanmış durum gecikmiş hedeften önce gelir", () => {
  assert.equal(getStatus({ status: 'done', targetFinish: '2026-01-01' }, parseDate('2026-07-22')).id, 'done');
});

test("referans tarihine eşit hedef bitiş gecikmiş değildir", () => {
  assert.equal(getStatus({ status: 'todo', targetFinish: '2026-07-22' }, parseDate('2026-07-22')).id, 'todo');
});

test("bilinmeyen görev durumu yapılacak görünümüne döner", () => {
  assert.equal(getStatus({ status: 'blocked' }, parseDate('2026-07-22')).id, 'todo');
});

test("selectTaskStats boş listede sıfır güvenli toplam döndürür", () => {
  assert.deepEqual(selectTaskStats([], parseDate('2026-07-22')), {
    total: 0, active: 0, inProgress: 0, todo: 0, done: 0, overdue: 0, compRate: 0
  });
});

test("selectTaskStats tamamlanma oranını en yakın tam sayıya yuvarlar", () => {
  const stats = selectTaskStats([
    { status: 'done' },
    { status: 'done' },
    { status: 'todo' }
  ], parseDate('2026-07-22'));
  assert.equal(stats.compRate, 67);
});

test("selectTaskStats eksik durumu yapılacak sayar ve bitmiş gecikmeyi dışlar", () => {
  const stats = selectTaskStats([
    { targetFinish: '2026-07-20' },
    { status: 'done', targetFinish: '2026-07-01' }
  ], parseDate('2026-07-22'));
  assert.equal(stats.todo, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.active, 1);
});

test("calculatePlannedDurationDays kilometre taşında tarih doğrulamadan sıfır döndürür", () => {
  assert.equal(calculatePlannedDurationDays({ milestone: true, plannedStart: 'bad', plannedFinish: 'bad' }), 0);
});

test("calculatePlannedDurationDays bozuk ve olanaksız tarihi reddeder", () => {
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026/07/20', plannedFinish: '2026-07-21' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-02-30', plannedFinish: '2026-03-01' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-22', plannedFinish: '2026-07-21' }), null);
});

test("calculatePlannedDurationDays geçerli normal aralıkta sıfır raporlamaz", () => {
  // Hafta sonuna denk gelen tek günlük görev, 0 süreyle Gantt özetlerinde
  // kilometre taşı gibi çiziliyor ve ilerleme ağırlığını kaybediyordu.
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-25', plannedFinish: '2026-07-26' }, {
    projects, calendars
  }), 1);
  // Kilometre taşı yine sıfırdır.
  assert.equal(calculatePlannedDurationDays({ milestone: true, plannedStart: '2026-07-25', plannedFinish: '2026-07-26' }, {
    projects, calendars
  }), 0);
});

test("calculatePlannedDurationDays proje takvimini çözer", () => {
  assert.equal(calculatePlannedDurationDays({ projectId: 'p2', plannedStart: '2026-07-18', plannedFinish: '2026-07-18' }, {
    projects, calendars
  }), 1);
});

test("calculatePlannedDurationDays görev takvimini proje takviminden önce çözer", () => {
  assert.equal(calculatePlannedDurationDays({
    projectId: 'p1', calendarId: 'six-day', plannedStart: '2026-07-18', plannedFinish: '2026-07-18'
  }, { projects, calendars }), 1);
});

test("calculatePlannedDurationDays çizelge tarihi eksikse boş değer döndürür", () => {
  assert.equal(calculatePlannedDurationDays({ plannedStart: '2026-07-20' }), null);
  assert.equal(calculatePlannedDurationDays({ plannedFinish: '2026-07-20' }), null);
});

test("normalizeTaskPlan görev alanını koruyup süreyi hesaplanmış değerle değiştirir", () => {
  const original = { id: 't1', custom: 'value', plannedStart: '2026-07-20', plannedFinish: '2026-07-24' };
  const normalized = normalizeTaskPlan(original, { projects, calendars });
  assert.equal(normalized.id, 't1');
  assert.equal(normalized.custom, 'value');
  assert.equal(normalized.plannedDurationDays, 5);
  assert.notStrictEqual(normalized, original);
});
