// MERGEN Rota · Tekrarlayan görev serilerinin bütünlüğü.
//
// Kural metni RFC 5545 `RRULE` olarak saklanır ve dışa aktarılır; bu yüzden
// açılımın anlamı standartla aynı kalmak zorundadır. Seri şablonu ile üretilen
// yinelemeler arasındaki bağ da kalıcı katmanda korunur: aynı gün ikinci kez
// üretilemez, şablon başka projeye taşınamaz ve şablon silindiğinde
// yinelemeler kaybolmaz.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_CALENDAR_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';
import {
  MAX_RECURRENCE_OCCURRENCES,
  expandRecurrence,
  findRecurrenceRuleIssue,
  planRecurringOccurrences
} from '../src/scheduling/recurrence/index.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';

const WORK_WEEK = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
const TASK_ID = 'task-1aaaaaaa-1111-4111-8111-111111111111';
const CHILD_ID = 'task-2bbbbbbb-2222-4222-8222-222222222222';
const SECOND_CHILD_ID = 'task-3ccccccc-3333-4333-8333-333333333333';
const PROJECT_ID = 'project-4ddddddd-4444-4444-8444-444444444444';
const ROOT_WBS_ID = 'wbs-5eeeeeee-5555-4555-8555-555555555555';
const OTHER_PROJECT_ID = 'project-6fffffff-6666-4666-8666-666666666666';
const OTHER_ROOT_WBS_ID = 'wbs-7aaaaaaa-7777-4777-8777-777777777777';

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
        plannedStart: '2026-09-07',
        plannedFinish: '2026-09-07',
        targetFinish: '2026-09-07'
      })]
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error.message, /zaten bir yineleme/);
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
        recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
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
