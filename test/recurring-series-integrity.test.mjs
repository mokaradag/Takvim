// MERGEN Rota · Tekrarlayan görev serilerinin bütünlüğü.
//
// Kural metni RFC 5545 `RRULE` olarak saklanır ve dışa aktarılır; bu yüzden
// açılımın anlamı standartla aynı kalmak zorundadır. Seri şablonu ile üretilen
// yinelemeler arasındaki bağ da kalıcı katmanda korunur: aynı gün ikinci kez
// üretilemez, şablon başka projeye taşınamaz ve şablon silindiğinde
// yinelemeler kaybolmaz.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

import {
  DEFAULT_CALENDAR_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';
import {
  MAX_RECURRENCE_OCCURRENCES,
  createOccurrenceFinishCalculator,
  expandRecurrence,
  findRecurrenceRuleIssue,
  occurrenceFinishes,
  planRecurringOccurrences
} from '../src/scheduling/recurrence/index.js';
import { CalendarScanBudgetExceededError, MAX_WORKING_DAY_SPAN, addWorkingDays, meterCalendarScans } from '../src/scheduling/calendars/index.js';
import { calculatePlannedDurationDays } from '../src/scheduling/plans/index.js';
import { addDays, fmtISO } from '../src/scheduling/dates/index.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';

const WORK_WEEK = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
const TASK_ID = 'task-1aaaaaaa-1111-4111-8111-111111111111';
const CHILD_ID = 'task-2bbbbbbb-2222-4222-8222-222222222222';
const SECOND_CHILD_ID = 'task-3ccccccc-3333-4333-8333-333333333333';
const PROJECT_ID = 'project-4ddddddd-4444-4444-8444-444444444444';
const ROOT_WBS_ID = 'wbs-5eeeeeee-5555-4555-8555-555555555555';
const OTHER_PROJECT_ID = 'project-6fffffff-6666-4666-8666-666666666666';
const OTHER_ROOT_WBS_ID = 'wbs-7aaaaaaa-7777-4777-8777-777777777777';

// Temel deponun GERÇEK sayacını gözle: hesapları değiştirmeden harcanan işi
// ve işlem boyunca aynı sayaç nesnesinin kullanıldığını ölçer.
const calendarModule = new URL('../src/scheduling/calendars/index.js', import.meta.url).href;
const repositoryModule = new URL('../src/server/repository/sqlAppRepository.js', import.meta.url).href;
const countedCalendarModule = `data:text/javascript,${encodeURIComponent(`
  export * from '${calendarModule}';
  import { meterCalendarScans as original } from '${calendarModule}';
  export const measurements = [];
  export function meterCalendarScans(meter, work) {
    const before = meter.remainingDays;
    try { return original(meter, work); }
    finally { measurements.push({ meter, before, scans: before - meter.remainingDays }); }
  }
`)}`;
const { measurements } = await import(countedCalendarModule);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === repositoryModule && specifier === '../../scheduling/calendars/index.js') {
      return { url: countedCalendarModule, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

const scansUsed = () => measurements.reduce((sum, entry) => sum + entry.scans, 0);
const transactionalTables = (db) => JSON.stringify(Object.fromEntries(Object.entries(db)
  .filter(([key, value]) => Array.isArray(value) && !['statements', 'transactions'].includes(key))));

/* ── 1 · RRULE kesin olarak doğrulanır ───────────────────────── */

test('kalıcılaştırma sınırı RRULE bileşenlerini katı biçimde doğrular', () => {
  // `normalizeRecurrenceRule` bilinçli olarak hoşgörülüdür (eski kayıtlar
  // ekranda açılabilmelidir). Yazma yolunda hoşgörü, gönderilen kuralın
  // saklanandan başka anlama gelmesi demektir.
  assert.equal(findRecurrenceRuleIssue('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10'), null);
  assert.match(findRecurrenceRuleIssue('FREQ=DAILY;COUNT=0'), /COUNT en az 1/);
  assert.match(findRecurrenceRuleIssue('FREQ=MONTHLY;BYMONTHDAY=45'), /BYMONTHDAY/);
  assert.match(findRecurrenceRuleIssue('FREQ=WEEKLY;BYDAY=XX'), /BYDAY/);
  assert.match(findRecurrenceRuleIssue('FREQ=DAILY;BYDAY=MO'), /yalnızca haftalık/);
  assert.match(findRecurrenceRuleIssue('FREQ=DAILY;WKST=MO'), /Desteklenmeyen tekrar bileşeni/);
  assert.match(findRecurrenceRuleIssue('FREQ=DAILY;COUNT=3;UNTIL=20261231'), /birlikte verilemez/);
  // Açılım güvenlik tavanında durur: tavanı aşan COUNT hiçbir zaman tamamlanamaz.
  assert.match(findRecurrenceRuleIssue(`FREQ=DAILY;COUNT=${MAX_RECURRENCE_OCCURRENCES + 1}`), /en fazla/);
  assert.equal(findRecurrenceRuleIssue(`FREQ=DAILY;COUNT=${MAX_RECURRENCE_OCCURRENCES}`), null);
});

test('görev yazması geçersiz kuralı ve imkânsız seriyi reddeder', () => {
  const base = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    projectId: 'a1b2c3d4-0000-4000-8000-000000000002',
    task: 'Haftalık durum toplantısı',
    plannedStart: '2026-08-17'
  };

  assert.equal(findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=WEEKLY;BYDAY=MO' }] }), null);
  const invalid = findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=DAILY;COUNT=0' }] });
  assert.equal(invalid?.code, 'TASK_RECURRENCE_INVALID');
  assert.match(invalid.details.reason, /COUNT/);

  // Başlangıçtan önce biten kural sözdizimsel olarak geçerlidir ama hiçbir
  // yineleme üretemez; imkânsız seri kalıcılaştırılmaz.
  assert.equal(
    findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=DAILY;UNTIL=20260816' }] })?.code,
    'TASK_RECURRENCE_RANGE_INVALID'
  );
  assert.equal(findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=DAILY;UNTIL=20260818' }] }), null);
});

test('yineleme günü yalnızca şablona bağlı görevde bulunabilir', () => {
  const base = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    projectId: 'a1b2c3d4-0000-4000-8000-000000000002',
    task: 'Yineleme'
  };
  assert.equal(
    findCommitScalarIssue({ taskUpserts: [{ ...base, recurrenceOccurrenceDate: '2026-08-18' }] })?.code,
    'TASK_RECURRENCE_OCCURRENCE_ORPHAN'
  );
  assert.equal(
    findCommitScalarIssue({
      taskUpserts: [{
        ...base,
        recurrenceParentId: 'a1b2c3d4-0000-4000-8000-000000000003',
        recurrenceOccurrenceDate: '2026-08-18'
      }]
    }),
    null
  );
});

/* ── 2 · Açılım ve planlama ──────────────────────────────────── */

test('haftalık kural gün seçilmeden günlüğe dönüşmez', () => {
  // 2026-08-18 Salı: `BYDAY` yokken RFC 5545 DTSTART gününü varsayar.
  assert.deepEqual(
    expandRecurrence({ freq: 'WEEKLY', count: 3 }, { start: '2026-08-18' }),
    ['2026-08-18', '2026-08-25', '2026-09-01']
  );
  // `INTERVAL=2` de haftayı atlar, günleri değil.
  assert.deepEqual(
    expandRecurrence({ freq: 'WEEKLY', interval: 2, count: 3 }, { start: '2026-08-18' }),
    ['2026-08-18', '2026-09-01', '2026-09-15']
  );
});

test('büyük INTERVAL değerlerinde açılım istenen sayıyı tamamlar', () => {
  // Gün gün tarayan eski açılım, sabit bir tarama bütçesiyle yaklaşık iki
  // düzine yinelemeden sonra sessizce duruyordu.
  const dates = expandRecurrence(
    { freq: 'WEEKLY', interval: 99, byWeekday: ['MO'], count: 60 },
    { start: '2026-08-17' }
  );
  assert.equal(dates.length, 60);
  assert.equal(dates[0], '2026-08-17');
});

test('süre DAHİL iş günü olarak korunur ve iş takvimine göre uygulanır', () => {
  const template = {
    plannedStart: '2026-08-17',        // Pazartesi
    plannedFinish: '2026-08-21',       // Cuma
    plannedDurationDays: 5,            // beş iş günü (dahil)
    targetFinish: '2026-08-24'
  };
  const plan = planRecurringOccurrences(template, { freq: 'WEEKLY', byWeekday: ['MO'], count: 2 }, {
    calendar: WORK_WEEK
  });
  assert.deepEqual(plan.map((item) => item.plannedStart), ['2026-08-17', '2026-08-24']);
  // Bitiş beşinci İŞ günüdür: hafta sonuna taşmaz.
  assert.deepEqual(plan.map((item) => item.plannedFinish), ['2026-08-21', '2026-08-28']);
  // Termin ofseti de iş günü ölçüsüyle korunur (Pzt → izleyen Pzt).
  assert.deepEqual(plan.map((item) => item.targetFinish), ['2026-08-24', '2026-08-31']);
});

test('COUNT ham yineleme sırasına, kaydırma ve tekilleştirmeden ÖNCE uygulanır', () => {
  // Cuma başlayan günlük seri: Cmt ve Paz Pazartesi'ye kayar ve biri elenir.
  // COUNT kuralın KENDİ yineleme sayısıdır (RFC 5545): üç yineleme Cum/Cmt/Paz
  // günleridir ve iki farklı iş gününe düşer. Kural sonrasına taşınmaz.
  // Önceki davranış kopyayı elediğinde döngüyü sürdürüyor, RRULE'da hiç
  // bulunmayan dördüncü yinelemeyi (Salı) kalıcılaştırıyordu.
  const plan = planRecurringOccurrences(
    { plannedStart: '2026-08-21', plannedDurationDays: 1 },
    { freq: 'DAILY', count: 3 },
    { calendar: WORK_WEEK }
  );
  assert.deepEqual(plan.map((item) => item.plannedStart), ['2026-08-21', '2026-08-24']);
  assert.deepEqual(plan.map((item) => item.occurrenceDate), ['2026-08-21', '2026-08-22']);
});

test('kaydırılan şablon günü serinin birinci yinelemesi olmayı sürdürür', () => {
  // Cumartesi başlayan `COUNT=3` günlük seri Pzt–Cum takviminde Pzt/Sal/Çar
  // planlanır. Şablonun kendi günü (Cmt) kaydığı için eski davranışta hiçbir
  // yinelemeyle eşleşmiyor, üç yinelemenin tamamı ŞABLONA EK olarak üretiliyor
  // ve seri üç yerine dört kayda çıkıyordu.
  const template = { plannedStart: '2026-08-22', plannedDurationDays: 1 };
  const plan = planRecurringOccurrences(
    template,
    { freq: 'WEEKLY', byWeekday: ['SA'], count: 3 },
    { calendar: WORK_WEEK }
  );
  // Planlanan başlangıçlar Pazartesi'ye kayar; ham yineleme günleri Cumartesi kalır.
  assert.deepEqual(plan.map((item) => item.plannedStart), ['2026-08-24', '2026-08-31', '2026-09-07']);
  assert.deepEqual(plan.map((item) => item.occurrenceDate), ['2026-08-22', '2026-08-29', '2026-09-05']);
  // Şablonun ham günü plandadır: üretim onu ikinci kez oluşturmaz.
  assert.ok(plan.some((item) => item.occurrenceDate === template.plannedStart));

  const materialized = new Set([template.plannedStart]);
  const generated = plan.filter((item) => !materialized.has(item.occurrenceDate));
  assert.equal(generated.length, 2, 'şablon dışında yalnızca iki yeni görev üretilir');

  // Günlük seride üç ham yineleme (Cmt/Paz/Pzt) tek iş gününe düşer: şablonun
  // günü zaten üretilmiş sayıldığı için hiç yeni görev oluşmaz.
  const dailyPlan = planRecurringOccurrences(template, { freq: 'DAILY', count: 3 }, { calendar: WORK_WEEK });
  assert.deepEqual(dailyPlan.map((item) => item.occurrenceDate), ['2026-08-22']);
  assert.equal(dailyPlan.filter((item) => !materialized.has(item.occurrenceDate)).length, 0);
});

test('seri istenen sayıda eksik yinelemeyi üretecek kadar ilerler', () => {
  // Sağlayıcı, üretilmiş yinelemeleri eledikten sonra hâlâ istenen sayıda yeni
  // gün kalmasını bekler; bu yüzden açılım sınırı `üretilmiş + istenen`dir.
  const template = { plannedStart: '2026-08-17', plannedDurationDays: 1 };
  const rule = { freq: 'DAILY' };
  const firstRound = planRecurringOccurrences(template, rule, { calendar: WORK_WEEK, limit: 5 });
  const materialized = new Set(firstRound.map((item) => item.plannedStart));

  const nextRound = planRecurringOccurrences(template, rule, {
    calendar: WORK_WEEK,
    limit: materialized.size + 5
  }).filter((item) => !materialized.has(item.plannedStart));

  assert.equal(nextRound.length, 5, 'ikinci tur yeni günler üretmelidir');
  assert.ok(nextRound[0].plannedStart > firstRound.at(-1).plannedStart);
});

test('yineleme üyeliği bitiş aritmetiği yapmadan belirlenir; tek yinelemenin bitişi yalnızca kendi süresi kadar tarar', () => {
  // Her gün sorgusu takvimin çalışma günlerini bir kez okur: okuma sayısı taranan
  // gün sayısıdır ve iş zamana bakılmadan belirlenimci olarak ölçülür.
  let reads = 0;
  const counting = { get workingDays() { reads += 1; return [1, 2, 3, 4, 5]; }, holidays: [] };
  const template = { plannedStart: '2026-08-17', plannedDurationDays: MAX_WORKING_DAY_SPAN, targetFinish: '2026-08-21' };
  const rule = { freq: 'WEEKLY', byWeekday: ['MO'], count: MAX_RECURRENCE_OCCURRENCES };

  const dates = planRecurringOccurrences(template, rule, { calendar: counting, finishes: false });
  assert.equal(dates.length, MAX_RECURRENCE_OCCURRENCES);
  assert.ok(dates.every((item) => !Object.hasOwn(item, 'plannedFinish') && !Object.hasOwn(item, 'targetFinish')));
  assert.ok(reads <= 2 * MAX_RECURRENCE_OCCURRENCES, `üyelik için gün başına sabit iş (${reads})`);

  reads = 0;
  const single = occurrenceFinishes(template, dates[3].plannedStart, { calendar: counting });
  const finishChecks = 7 * Math.ceil((MAX_WORKING_DAY_SPAN - 1) / WORK_WEEK.workingDays.length);
  assert.ok(reads <= finishChecks + 2 * 7, `tek bitiş ve beş günlük termin taraması (${reads})`);
  const full = planRecurringOccurrences(template, { ...rule, count: 4 }, { calendar: WORK_WEEK })[3];
  assert.deepEqual(single, { plannedFinish: full.plannedFinish, targetFinish: full.targetFinish }, 'bitişler tam planla aynıdır');
});

test('takvim tarama sayacı yapılan işi sayar: tatil, seyrek desen ve sonraki süre doğrulaması bütçeyi aşamaz', () => {
  // Her gün değerlendirmesi takvimin çalışma günlerini bir kez okur; okuma sayısı taranan gündür.
  let reads = 0;
  const counted = (workingDays, holidays = []) => ({ id: 'sayilan', get workingDays() { reads += 1; return workingDays; }, holidays });
  const holidayHeavy = counted([1, 2, 3, 4, 5], Array.from({ length: 400 }, (_, index) => ({ date: fmtISO(addDays('2026-08-18', index)), name: 'Tatil' })));
  const template = { plannedStart: '2026-08-17', plannedDurationDays: 5, targetFinish: null };
  const validate = (calendar) => {
    const finishes = occurrenceFinishes(template, '2026-08-17', { calendar });
    return calculatePlannedDurationDays({ plannedStart: '2026-08-17', ...finishes, calendarId: calendar.id }, { calendars: [calendar], projects: [] });
  };

  for (const [calendar, label] of [[counted([1, 2, 3, 4, 5]), 'beş günlük'], [counted([1]), 'haftada tek günlük'], [holidayHeavy, 'tatil yoğun']]) {
    reads = 0;
    const unmetered = validate(calendar);
    const work = reads;
    // Sayaç tam yapılan işi düşer; bitiş taraması ile süre doğrulamasının ikinci taraması birlikte sayılır.
    const meter = { remainingDays: work };
    reads = 0;
    assert.equal(meterCalendarScans(meter, () => validate(calendar)), unmetered, label);
    assert.deepEqual([reads, meter.remainingDays], [work, 0], `${label}: ${work} gün`);
    // Bir gün eksik bütçe taramayı bütçede keser; sınırın ötesine tek gün bile taranmaz.
    reads = 0;
    assert.throws(() => meterCalendarScans({ remainingDays: work - 1 }, () => validate(calendar)), CalendarScanBudgetExceededError);
    assert.equal(reads, work - 1, `${label}: kesinti bütçede`);
  }
  // Tatil bloğu taramaya yansır: beş iş günü 400 günlük tatili aşmak zorundadır.
  reads = 0;
  validate(holidayHeavy);
  assert.ok(reads > 2 * 400, `tatil günleri sayılır (${reads})`);
  // Sayaç yalnızca çağrı süresince etkindir ve eşzamansız iş kabul edilmez.
  assert.equal(addWorkingDays('2026-08-17', 5, counted([1])) != null, true);
  assert.throws(() => meterCalendarScans({ remainingDays: 10 }, async () => {}), TypeError);
});

test('kardeş oluşumlar şablon sürelerini bir kez ölçer; eşit bitişleri tek taramayla hesaplar', () => {
  let reads = 0;
  const calendar = { get workingDays() { reads += 1; return [1]; }, holidays: [] };
  const template = { plannedStart: '2026-08-17', plannedFinish: '2026-09-07', targetFinish: '2026-09-07' };
  const finishForStart = createOccurrenceFinishCalculator(template, { calendar });
  const templateReads = reads;
  assert.equal(templateReads, 2 * 22, 'bildirilmemiş süre ve termin yalnızca şablondan ölçülür');
  for (let index = 1; index <= 8; index += 1) {
    reads = 0;
    const date = fmtISO(addDays(template.plannedStart, 7 * index));
    const actual = finishForStart(date);
    assert.equal(reads, 21, 'kardeş şablonu yeniden saymaz; eşit iki bitişi bir kez hesaplar');
    assert.deepEqual(actual, { plannedFinish: fmtISO(addDays(date, 21)), targetFinish: fmtISO(addDays(date, 21)) });
  }
  // Farklı, önceki veya olmayan termin aynı takvim semantiğini korur.
  for (const targetFinish of [null, '2026-08-10', '2026-08-17', '2026-08-24']) {
    const shape = { ...template, targetFinish };
    const date = '2026-09-14';
    const full = planRecurringOccurrences(shape, { freq: 'WEEKLY', byWeekday: ['MO'], count: 5 }, { calendar }).at(-1);
    assert.deepEqual(createOccurrenceFinishCalculator(shape, { calendar })(date), {
      plannedFinish: full.plannedFinish, targetFinish: full.targetFinish
    });
  }
});

/* ── 3 · Kalıcı katmanda seri bütünlüğü ──────────────────────── */

function manualProjectChanges() {
  return {
    projectUpserts: [{
      id: PROJECT_ID,
      code: 'SERI-1',
      name: 'Seri projesi',
      source: 'manual',
      color: 'blue',
      leadId: '900001',
      calendarId: DEFAULT_CALENDAR_ID,
      dataDate: '2026-07-25',
      tags: ['Bakım']
    }],
    wbsUpserts: [{ id: ROOT_WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Seri projesi', sortOrder: 1 }]
  };
}

function seriesTask(overrides = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    wbsId: ROOT_WBS_ID,
    task: 'Haftalık bakım',
    keyword: 'Bakım',
    status: 'todo',
    priority: 'medium',
    progress: 0,
    plannedDurationDays: 1,
    plannedStart: '2026-08-17',
    plannedFinish: '2026-08-17',
    targetFinish: '2026-08-17',
    assigneeIds: ['900001'],
    sorumlu: ['Test Kullanıcı'],
    deps: [],
    ...overrides
  };
}

test('aynı seri günü için ikinci bir yineleme kalıcılaştırılamaz', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    const template = await stack.persistence.commitChanges('task/create', {
      taskUpserts: [seriesTask({ recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' })]
    });
    assert.equal(template.ok, true, template.error?.message);

    // Arayüz durumu (`todo`) depo sınırında kanonik kalıcı duruma çevrilir;
    // seri üretimi de sıradan görev oluşturmayla aynı yoldan geçer.
    assert.equal(stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('1aaaaaaa')).Status, 'planned');

    const first = await stack.persistence.commitChanges('task/series', {
      taskUpserts: [seriesTask({
        id: CHILD_ID,
        recurrence: null,
        recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24',
        plannedStart: '2026-08-24',
        plannedFinish: '2026-08-24',
        targetFinish: '2026-08-24'
      })]
    });
    assert.equal(first.ok, true, first.error?.message);

    // Eşzamanlı ikinci bir yazıcı aynı günü "eksik" görüp farklı bir TaskId ile
    // ekleyebilir; tekillik bu yüzden kalıcı katmanda uygulanır.
    const duplicate = await stack.persistence.commitChanges('task/series', {
      taskUpserts: [seriesTask({
        id: SECOND_CHILD_ID,
        recurrence: null,
        recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24',
        plannedStart: '2026-08-24',
        plannedFinish: '2026-08-24',
        targetFinish: '2026-08-24'
      })]
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error.message, /zaten bir yineleme/);
  } finally {
    await stack.dispose();
  }
});

test('geçerli tekrar gününe farklı plan veya süre yazılamaz; toplu işlem geri alınır', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    await stack.repository.commitChanges({ taskUpserts: [seriesTask({
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      plannedFinish: '2026-08-18', targetFinish: '2026-08-19', plannedDurationDays: 2
    })] });
    const child = seriesTask({
      id: CHILD_ID, recurrence: null, recurrenceParentId: TASK_ID,
      recurrenceOccurrenceDate: '2026-08-24',
      plannedStart: '2026-08-24', plannedFinish: '2026-08-25',
      targetFinish: '2026-08-26', plannedDurationDays: 2
    });
    const expectedError = {
      code: 'MUTATION_FAILED',
      message: 'Yineleme planı ve süresi şablonun ürettiği tekrar günüyle uyumlu olmalıdır.'
    };
    for (const patch of [
      { plannedStart: '2026-08-23' },
      { plannedFinish: '2026-08-26' },
      { targetFinish: '2026-08-27' },
      { plannedDurationDays: 3 },
      { plannedDurationDays: null }
    ]) {
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...child, ...patch }] }), expectedError);
      assert.equal(stack.db.tasks.length, 1);
    }
    const second = {
      ...child, id: SECOND_CHILD_ID, recurrenceOccurrenceDate: '2026-08-31',
      plannedStart: '2026-08-31', plannedFinish: '2026-09-01', targetFinish: '2026-09-02'
    };
    await assert.rejects(stack.repository.commitChanges({
      taskUpserts: [child, { ...second, plannedDurationDays: 3 }]
    }), expectedError);
    assert.equal(stack.db.tasks.length, 1, 'önceki geçerli yineleme de geri alınır');
    await stack.repository.commitChanges({ taskUpserts: [child, second] });
    assert.equal(stack.db.tasks.length, 3);
    const stored = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('2bbbbbbb'));
    assert.equal(stored.PlannedStart, child.plannedStart);
    assert.equal(stored.PlannedFinish, child.plannedFinish);
    assert.equal(stored.TargetFinish, child.targetFinish);
    assert.equal(stored.PlannedDurationDays, 2);
  } finally {
    await stack.dispose();
  }
});

test('uzun şablonlu büyük seride yineleme doğrulaması kardeş bitişlerini hesaplamaz ve işlem bütçesiyle sınırlıdır', { timeout: 60000 }, async () => {
  // Saldırgan biçimli seri: COUNT tavanda, süre ve termin temsil edilebilen en
  // uzun aralıkta. Eski doğrulama her yineleme için 400 bitiş hesaplıyordu.
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    const finish = fmtISO(addWorkingDays('2026-08-17', MAX_WORKING_DAY_SPAN - 1, WORK_WEEK));
    const shape = { plannedStart: '2026-08-17', plannedFinish: finish, targetFinish: finish, plannedDurationDays: MAX_WORKING_DAY_SPAN };
    await stack.repository.commitChanges({ taskUpserts: [seriesTask({
      recurrence: `FREQ=WEEKLY;BYDAY=MO;COUNT=${MAX_RECURRENCE_OCCURRENCES}`, ...shape
    })] });
    const child = (index, date) => seriesTask({
      id: `task-9${index.toString(16).padStart(7, '0')}-9999-4999-8999-999999999999`,
      recurrence: null, recurrenceParentId: TASK_ID, recurrenceOccurrenceDate: date,
      plannedStart: date, plannedDurationDays: MAX_WORKING_DAY_SPAN,
      ...occurrenceFinishes(shape, date, { calendar: WORK_WEEK })
    });

    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [child(1, '2026-08-25')] }), {
      code: 'MUTATION_FAILED', message: 'Tekrar günü şablonun kuralı ve çalışma takvimiyle uyumlu olmalıdır.'
    });
    // Tek meşru yineleme kabul edilir ve şablonun ürettiği planla yazılır.
    const legitimate = child(2, '2026-08-24');
    await stack.repository.commitChanges({ taskUpserts: [legitimate] });
    const stored = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('90000002'));
    assert.equal(stored.PlannedFinish, legitimate.plannedFinish);
    assert.equal(stored.TargetFinish, legitimate.targetFinish);

    const batch = Array.from({ length: 80 }, (_, index) => child(index + 3, fmtISO(addDays('2026-08-31', index * 7))));
    measurements.length = 0;
    await stack.repository.commitChanges({ taskUpserts: batch });
    assert.equal(stack.db.tasks.length, 82, 'desteklenen seri tek işlemde kabul edilir');
    // 400 üyelik + şablonun bir termin sayımı + çocuk başına bir bitiş ve
    // süre doğrulaması. Şablon sayımı/aynı bitiş tekrar edilse sınır aşılır.
    assert.ok(scansUsed() < 4_600_000, `80 kardeşin gerçek işi: ${scansUsed()}`);
    assert.equal(new Set(measurements.map(entry => entry.meter)).size, 1);
  } finally {
    await stack.dispose();
  }
});

test('normal çoklu yineleme işlem bütçesinde süre doğrulamasıyla birlikte kabul edilir', { timeout: 60000 }, async () => {
  // Terminsiz oluşum başına bitiş ve süre doğrulaması ayrı ayrı sayılır;
  // işlem bütçesi desteklenen serinin bütün çocuklarına yeter.
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    const finish = fmtISO(addWorkingDays('2026-08-17', MAX_WORKING_DAY_SPAN - 1, WORK_WEEK));
    const shape = { plannedStart: '2026-08-17', plannedFinish: finish, targetFinish: null, plannedDurationDays: MAX_WORKING_DAY_SPAN };
    await stack.repository.commitChanges({ taskUpserts: [seriesTask({
      recurrence: `FREQ=WEEKLY;BYDAY=MO;COUNT=${MAX_RECURRENCE_OCCURRENCES}`, ...shape
    })] });
    const child = (index, date) => seriesTask({
      id: `task-9${index.toString(16).padStart(7, '0')}-9999-4999-8999-999999999999`,
      recurrence: null, recurrenceParentId: TASK_ID, recurrenceOccurrenceDate: date,
      plannedStart: date, plannedDurationDays: MAX_WORKING_DAY_SPAN,
      ...occurrenceFinishes(shape, date, { calendar: WORK_WEEK })
    });
    const dates = Array.from({ length: 80 }, (_, index) => fmtISO(addDays('2026-08-24', index * 7)));
    await stack.repository.commitChanges({ taskUpserts: dates.map((date, index) => child(index + 1, date)) });
    assert.equal(stack.db.tasks.length, 81);
  } finally {
    await stack.dispose();
  }
});

test('yineleme şablonuyla aynı projede olmak zorundadır', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    assert.equal((await stack.persistence.commitChanges('project/create', {
      projectUpserts: [{
        id: OTHER_PROJECT_ID,
        code: 'SERI-2',
        name: 'Diğer proje',
        source: 'manual',
        color: 'rose',
        leadId: '900001',
        calendarId: DEFAULT_CALENDAR_ID,
        dataDate: '2026-07-25',
        tags: []
      }],
      wbsUpserts: [{ id: OTHER_ROOT_WBS_ID, projectId: OTHER_PROJECT_ID, parentId: null, code: '1', name: 'Diğer proje', sortOrder: 1 }]
    })).ok, true);

    assert.equal((await stack.persistence.commitChanges('task/create', {
      taskUpserts: [seriesTask({ recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' })]
    })).ok, true);

    const crossProject = await stack.persistence.commitChanges('task/series', {
      taskUpserts: [seriesTask({
        id: CHILD_ID,
        projectId: OTHER_PROJECT_ID,
        wbsId: OTHER_ROOT_WBS_ID,
        keyword: null,
        recurrence: null,
        recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24'
      })]
    });
    assert.equal(crossProject.ok, false);
    assert.match(crossProject.error.message, /aynı projede/);
  } finally {
    await stack.dispose();
  }
});

test('yinelemeleri olan şablon başka projeye taşınamaz', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    assert.equal((await stack.persistence.commitChanges('project/create', {
      projectUpserts: [{
        id: OTHER_PROJECT_ID,
        code: 'SERI-2',
        name: 'Diğer proje',
        source: 'manual',
        color: 'rose',
        leadId: '900001',
        calendarId: DEFAULT_CALENDAR_ID,
        dataDate: '2026-07-25',
        tags: []
      }],
      wbsUpserts: [{ id: OTHER_ROOT_WBS_ID, projectId: OTHER_PROJECT_ID, parentId: null, code: '1', name: 'Diğer proje', sortOrder: 1 }]
    })).ok, true);
    assert.equal((await stack.persistence.commitChanges('task/create', {
      taskUpserts: [seriesTask({ recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' })]
    })).ok, true);
    assert.equal((await stack.persistence.commitChanges('task/series', {
      taskUpserts: [seriesTask({
        id: CHILD_ID,
        recurrence: null,
        recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24',
        plannedStart: '2026-08-24',
        plannedFinish: '2026-08-24',
        targetFinish: '2026-08-24'
      })]
    })).ok, true);

    const stored = stack.state.tasks.find((task) => task.id === TASK_ID);
    const moved = await stack.persistence.commitChanges('task/update', {
      taskUpserts: [{
        ...stored,
        projectId: OTHER_PROJECT_ID,
        wbsId: OTHER_ROOT_WBS_ID,
        keyword: null
      }]
    });
    assert.equal(moved.ok, false);
    assert.match(moved.error.message, /başka projeye taşınamaz/);
  } finally {
    await stack.dispose();
  }
});

test('şablon silindiğinde yinelemeler ayrılır, silinmez', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    assert.equal((await stack.persistence.commitChanges('task/create', {
      taskUpserts: [seriesTask({ recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' })]
    })).ok, true);
    assert.equal((await stack.persistence.commitChanges('task/series', {
      taskUpserts: [seriesTask({
        id: CHILD_ID,
        recurrence: null,
        recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24',
        plannedStart: '2026-08-24',
        plannedFinish: '2026-08-24',
        targetFinish: '2026-08-24'
      })]
    })).ok, true);

    const template = stack.state.tasks.find((task) => task.id === TASK_ID);
    const deleted = await stack.persistence.commitChanges('task/delete', {
      taskDeletes: [{ id: TASK_ID, version: template.version }]
    });
    assert.equal(deleted.ok, true, deleted.error?.message);
    const authoritativeChild = deleted.value.taskUpserts.find((task) => task.id === CHILD_ID);
    assert.ok(authoritativeChild, 'silmenin değiştirdiği yineleme yetkili yanıtta yeniden yüklenir');
    assert.equal(authoritativeChild.recurrenceParentId, null);
    assert.equal(authoritativeChild.recurrenceOccurrenceDate, null);
    const reconciledChild = stack.state.tasks.find((task) => task.id === CHILD_ID);
    assert.equal(reconciledChild.recurrenceParentId, null);
    assert.equal(reconciledChild.recurrenceOccurrenceDate, null);

    // Her yineleme gerçek bir görevdir ve kendi ilerlemesini taşır: şablonun
    // silinmesi onları da silmemeli, yalnızca seriden ayırmalıdır.
    const remaining = stack.db.tasks.filter((row) => String(row.TaskId).toLowerCase().includes('2bbbbbbb'));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].RecurrenceParentTaskId, null);
    assert.equal(remaining[0].RecurrenceOccurrenceDate, null);
  } finally {
    await stack.dispose();
  }
});

test('görev sıralaması tam belirlenimlidir', () => {
  const repository = readSource('src/server/repository/sqlAppRepository.js');
  // Aynı seriden üretilen yinelemeler başlıkta ve sıra anahtarında eşitlenir;
  // kararlı bir ek anahtar olmadan Kanban her yüklemede farklı sıra gösterirdi.
  assert.match(repository, /ORDER BY t\.ProjectId, t\.SortOrder, t\.Title, t\.PlannedStart, t\.TaskId;/);
});

test('yükseltme göçü mevcut veritabanına yeni sütunları ekler', () => {
  // Temiz kurulum betiği herhangi bir MR_* nesnesi varsa durur; mevcut kalıcı
  // veritabanı yeni sütunları ondan ALAMAZ.
  const upgrade = readSource('database/MR_Upgrade_0004_Tag_Appearance_And_Recurrence.sql');
  assert.match(upgrade, /IF COL_LENGTH\(N'dbo\.MR_ProjectTags', N'ColorToken'\) IS NULL/);
  assert.match(upgrade, /IF COL_LENGTH\(N'dbo\.MR_Tasks', N'RecurrenceRule'\) IS NULL/);
  assert.match(upgrade, /IF COL_LENGTH\(N'dbo\.MR_Tasks', N'RecurrenceOccurrenceDate'\) IS NULL/);
  assert.match(upgrade, /CREATE UNIQUE INDEX UX_MR_Tasks_RecurrenceOccurrence/);
  assert.match(upgrade, /MigrationId = N'0004_tag_appearance_and_recurrence'/);

  const schema = readSource('database/MR_Create_Durable_Persistence.sql');
  assert.match(schema, /RecurrenceOccurrenceDate date NULL,/);
  assert.match(schema, /CREATE UNIQUE INDEX UX_MR_Tasks_RecurrenceOccurrence/);
  assert.match(schema, /CONSTRAINT CK_MR_Tasks_RecurrenceSelf/);
});

function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}


test('en uzun tek yineleme seyrek ve tatil yoğun takvimde terminli veya terminsiz kabul edilir', { timeout: 60000 }, async () => {
  for (const withTarget of [false, true]) {
    const calendar = { workingDays: [1], holidays: Array.from({ length: 52 }, (_, index) => ({ date: fmtISO(addDays('2027-01-04', index * 7)) })) };
    const seed = corporateSeed();
    seed.calendars[0].WorkingDays = calendar.workingDays;
    seed.calendars[0].Holidays = calendar.holidays;
    const stack = await createActualStack(seed);
    try {
      assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
      const finish = fmtISO(addWorkingDays('2026-08-17', MAX_WORKING_DAY_SPAN - 1, calendar));
      const shape = { plannedStart: '2026-08-17', plannedFinish: finish,
        targetFinish: withTarget ? finish : null, plannedDurationDays: MAX_WORKING_DAY_SPAN };
      await stack.repository.commitChanges({ taskUpserts: [seriesTask({ recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=8', ...shape })] });
      const child = seriesTask({ id: CHILD_ID, recurrence: null, recurrenceParentId: TASK_ID,
        recurrenceOccurrenceDate: '2026-08-24', plannedStart: '2026-08-24', plannedDurationDays: MAX_WORKING_DAY_SPAN,
        ...occurrenceFinishes(shape, '2026-08-24', { calendar }) });
      const children = [child, ...Array.from({ length: 6 }, (_, index) => {
        const date = fmtISO(addDays('2026-08-31', index * 7));
        return { ...child, id: `task-9000000${index}-9999-4999-8999-999999999999`,
          recurrenceOccurrenceDate: date, plannedStart: date, ...occurrenceFinishes(shape, date, { calendar }) };
      })];
      await stack.repository.commitChanges({ taskUpserts: [child] });
      assert.equal(stack.db.tasks.length, 2, 'tek azami oluşum da bağımsız kabul edilir');
      await stack.repository.commitChanges({ taskUpserts: children.slice(1) });
      assert.equal(stack.db.tasks.length, 8);
      const stored = stack.db.tasks.find(row => String(row.TaskId).toLowerCase().includes('2bbbbbbb'));
      assert.equal(stored.PlannedFinish, child.plannedFinish);
      assert.equal(stored.TargetFinish, child.targetFinish);
      assert.equal(stored.PlannedDurationDays, MAX_WORKING_DAY_SPAN);
    } finally { await stack.dispose(); }
  }
});

test('399 çocuklu seyrek seri sabit iş tavanında durur ve bütün işlem tabloları geri alınır', { timeout: 60000 }, async () => {
  const seed = corporateSeed();
  seed.calendars[0].WorkingDays = [1];
  seed.calendars[0].Holidays = [];
  const stack = await createActualStack(seed);
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    const start = '2026-08-17';
    const end = (date) => fmtISO(addDays(date, (MAX_WORKING_DAY_SPAN - 1) * 7));
    const parent = seriesTask({ recurrence: `FREQ=WEEKLY;BYDAY=MO;COUNT=${MAX_RECURRENCE_OCCURRENCES}`,
      plannedStart: start, plannedFinish: end(start), targetFinish: end(start), plannedDurationDays: MAX_WORKING_DAY_SPAN });
    await stack.repository.commitChanges({ taskUpserts: [parent] });
    const children = Array.from({ length: MAX_RECURRENCE_OCCURRENCES - 1 }, (_, index) => {
      const date = fmtISO(addDays(start, (index + 1) * 7));
      return { ...parent, id: `task-b${index.toString(16).padStart(7, '0')}-9999-4999-8999-999999999999`,
        recurrence: null, recurrenceParentId: parent.id, recurrenceOccurrenceDate: date,
        plannedStart: date, plannedFinish: end(date), targetFinish: end(date) };
    });
    const before = transactionalTables(stack.db);
    const queryStart = stack.db.statements.length;
    measurements.length = 0;
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: children }), error => (
      error.code === 'MUTATION_FAILED' && /işlem sınırını aşıyor/.test(error.message)
    ));
    assert.equal(scansUsed(), 5_000_000, 'tavanın ötesine tek gün bile taranmaz');
    assert.equal(new Set(measurements.map(entry => entry.meter)).size, 1, '399 çocuk tek sayaç paylaşır');
    assert.equal(measurements.at(-1).meter.remainingDays, 0);
    const writes = stack.db.statements.slice(queryStart).filter(entry => entry.sql.includes('INSERT dbo.MR_Tasks'));
    assert.ok(writes.length > 0 && writes.length < children.length, 'sınır kısmi yazmadan sonra tükenir');
    assert.equal(transactionalTables(stack.db), before, 'görev, sorumlu, bağımlılık, geçmiş, bildirim ve kuyruklar geri alınır');
    assert.ok(stack.db.transactions.at(-1).rollbackStatementIndex != null);
  } finally { await stack.dispose(); }
});

test('birden çok pahalı seri işlem tavanını paylaşır ve kısmi yazmaların tamamı geri alınır', { timeout: 60000 }, async () => {
  const calendar = { workingDays: [1], holidays: [] };
  const seed = corporateSeed();
  seed.calendars[0].WorkingDays = calendar.workingDays;
  seed.calendars[0].Holidays = [];
  const stack = await createActualStack(seed);
  try {
    assert.equal((await stack.persistence.commitChanges('project/create', manualProjectChanges())).ok, true);
    // Haftada bir iş günü: kapalı biçimli beklenen tarihler testte pahalı bir ikinci tarama gerektirmez.
    const start = '2026-08-17';
    const finish = fmtISO(addDays(start, (MAX_WORKING_DAY_SPAN - 1) * 7));
    const parents = Array.from({ length: 3 }, (_, index) => seriesTask({
      id: `task-a000000${index}-9999-4999-8999-999999999999`,
      recurrence: `FREQ=WEEKLY;BYDAY=MO;COUNT=${MAX_RECURRENCE_OCCURRENCES}`,
      plannedStart: start, plannedFinish: finish, targetFinish: finish, plannedDurationDays: MAX_WORKING_DAY_SPAN
    }));
    await stack.repository.commitChanges({ taskUpserts: parents });
    const before = transactionalTables(stack.db);
    const children = parents.flatMap((parent, series) => Array.from({ length: 8 }, (_, index) => {
      const date = fmtISO(addDays(start, (index + 1) * 7));
      const end = fmtISO(addDays(date, (MAX_WORKING_DAY_SPAN - 1) * 7));
      return { ...parent, id: `task-b${(series * 8 + index).toString(16).padStart(7, '0')}-9999-4999-8999-999999999999`,
        recurrence: null, recurrenceParentId: parent.id, recurrenceOccurrenceDate: date,
        plannedStart: date, plannedFinish: end, targetFinish: end };
    }));
    // Her şablonun sekiz çocuğu tek başına kabul edilir; toplamları aynı işlem
    // sayacını tüketir. Şablon başına sayaç kurulsa bu test yanlışlıkla geçerdi.
    for (const parent of parents) {
      const ownChildren = children.filter(child => child.recurrenceParentId === parent.id);
      let reachedCommit = false;
      stack.db.commitHook = () => { reachedCommit = true; throw new Error('tek-seri-ölçümü'); };
      measurements.length = 0;
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: ownChildren }));
      assert.equal(reachedCommit, true, 'sekiz çocuk iş tavanını aşmadan commit aşamasına ulaşır');
      assert.ok(scansUsed() > 0 && scansUsed() < 5_000_000);
      assert.equal(transactionalTables(stack.db), before);
    }
    stack.db.commitHook = null;
    const queryStart = stack.db.statements.length;
    measurements.length = 0;
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: children }), error => (
      error.code === 'MUTATION_FAILED' && /işlem sınırını aşıyor/.test(error.message)
    ));
    assert.ok(stack.db.statements.slice(queryStart).some(entry => entry.sql.includes('INSERT dbo.MR_Tasks')),
      'ortak sayaç ilk çocukları kabul ettikten sonra tükenir; çocuk başına sıfırlansa bu küme geçerdi');
    assert.equal(scansUsed(), 5_000_000);
    assert.equal(new Set(measurements.map(entry => entry.meter)).size, 1, 'şablonlar arasında sayaç sıfırlanmaz');
    assert.equal(transactionalTables(stack.db), before, 'bütün işlem tabloları birlikte geri alınır');
  } finally { await stack.dispose(); }
});

test('ordinary self-assigned creations share the transaction calendar meter and roll back on aggregate exhaustion', { timeout: 60000 }, async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  const seed = corporateSeed({ systemAdminSicils: [], tasks: [{ TaskId: 'ab000000-0000-4000-8000-000000000001', ProjectId: CORPORATE_PROJECT_ID, WbsId: CORPORATE_ROOT_WBS_ID, Title: 'Scope anchor', CreatedBySicil: 900010 }], taskAssignees: [{ TaskId: 'ab000000-0000-4000-8000-000000000001', Sicil: 900001 }] });
  seed.calendars[0].WorkingDays = [1]; seed.calendars[0].Holidays = [];
  const stack = await createActualStack(seed);
  try {
    const task = (index) => ({ id: `ac000000-0000-4000-8000-${String(index).padStart(12, '0')}`, projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID, calendarId: null, task: 'Ordinary task', status: 'planned', priority: 'medium', milestone: false, plannedStart: '2026-08-17', plannedFinish: fmtISO(addDays('2026-08-17', (MAX_WORKING_DAY_SPAN - 1) * 7)), assigneeIds: ['900001'], deps: [], description: null, keyword: null });
    measurements.length = 0; await stack.repository.commitChanges({ taskUpserts: [task(1)] }); assert.ok(scansUsed() > 100000);
    const before = transactionalTables(stack.db); measurements.length = 0;
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: Array.from({ length: 50 }, (_, index) => task(index + 2)) }), error => error.code === 'MUTATION_FAILED' && /işlem sınırını aşıyor/.test(error.message));
    assert.equal(scansUsed(), 5_000_000); assert.equal(new Set(measurements.map(entry => entry.meter)).size, 1); assert.equal(transactionalTables(stack.db), before);
  } finally { await stack.dispose(); }
});

test('recurrence parent absence and hidden existence return the same response before parent-specific checks', async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  const hiddenProject = 'bd000000-0000-4000-8000-000000000001', hiddenParent = 'bd000000-0000-4000-8000-000000000002';
  const seed = corporateSeed({ systemAdminSicils: [], corporateProjectAccess: [{ ProjectCode: 'P4417041', Sicil: 900001, RoleCode: 'PROJECT_MANAGER' }] });
  seed.projects.push({ ProjectId: hiddenProject, SourceType: 'MANUAL', ProjectName: 'hidden', LeadSicil: 900010, CalendarId: DEFAULT_CALENDAR_ID });
  seed.tasks = [{ TaskId: hiddenParent, ProjectId: hiddenProject, Title: 'protected template', CreatedBySicil: 900010, RecurrenceRule: 'FREQ=WEEKLY;COUNT=400', PlannedStart: '2026-08-17', PlannedFinish: '2026-08-17', PlannedDurationDays: 1 }];
  const stack = await createActualStack(seed);
  try {
    const child = { ...seriesTask(), status: 'planned', id: CHILD_ID.slice(5), projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID, recurrence: null, recurrenceParentId: hiddenParent, recurrenceOccurrenceDate: '2026-08-24' };
    const attempt = async () => { const response = await fetch('/api/mergen-rota/commit', { method: 'POST', body: JSON.stringify({ changes: { taskUpserts: [child] } }) }); return [response.status, await response.text()]; };
    const hidden = await attempt(); stack.db.tasks = []; assert.deepEqual(await attempt(), hidden); assert.equal(hidden[0], 400); assert.match(hidden[1], /Tekrar şablonu bulunamadı/); assert.doesNotMatch(hidden[1], /protected template|FREQ|aynı projede/);
  } finally { await stack.dispose(); }
});

test('ordinary recurrence-child edits keep an unchanged invisible parent but cannot establish a hidden link', async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  const parent = 'be000000-0000-4000-8000-000000000001', child = 'be000000-0000-4000-8000-000000000002';
  const stack = await createActualStack(corporateSeed({ systemAdminSicils: [],
    tasks: [
      { TaskId: parent, ProjectId: CORPORATE_PROJECT_ID, WbsId: CORPORATE_ROOT_WBS_ID, Title: 'hidden template', CreatedBySicil: 900010, RecurrenceRule: 'FREQ=WEEKLY;COUNT=3' },
      { TaskId: child, ProjectId: CORPORATE_PROJECT_ID, WbsId: CORPORATE_ROOT_WBS_ID, Title: 'visible child', CreatedBySicil: 900010,
        RecurrenceParentTaskId: parent, RecurrenceOccurrenceDate: '2026-08-24', PlannedStart: '2026-08-24', PlannedFinish: '2026-08-24', PlannedDurationDays: 1 }
    ], taskAssignees: [{ TaskId: child, Sicil: 900001 }] }));
  try {
    assert.equal(stack.state.tasks.some((task) => task.id === parent), false);
    assert.equal((await stack.persistence.updateTask(child, { description: 'ordinary edit' })).ok, true);
    assert.equal((await stack.persistence.flush()).ok, true);
    const saved = stack.db.tasks.find((task) => task.TaskId.toLowerCase() === child);
    assert.equal(saved.Description, 'ordinary edit'); assert.equal(saved.RecurrenceParentTaskId.toLowerCase(), parent);
    const response = await fetch('/api/mergen-rota/commit', { method: 'POST', body: JSON.stringify({ changes: { taskUpserts: [{
      ...stack.state.tasks.find((task) => task.id === child), status: 'planned', recurrenceParentId: 'be000000-0000-4000-8000-000000000003'
    }] } }) });
    assert.equal(response.status, 403, await response.text());
    assert.equal(stack.db.tasks.find((task) => task.TaskId.toLowerCase() === child).RecurrenceParentTaskId.toLowerCase(), parent);
  } finally { await stack.dispose(); }
});
