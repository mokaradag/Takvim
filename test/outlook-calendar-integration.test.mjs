/**
 * Outlook takvim aboneliklerinin uçtan uca davranışı.
 *
 * Zincir GERÇEK kodla kurulur: takvim hizmeti → kalıcı katman → bellek içi SQL
 * Server ikizi. Yalnızca SMTP taşıması enjekte edilir (gerçek bir posta
 * sunucusu gerektirmemek için); yetki denetimi, sürüm ayırma, kuyruk
 * sahiplenmesi ve karma karşılaştırması gerçek koddur.
 *
 * Sınanan davranışlar:
 *   - abonelik KALICIDIR ve (görev, Sicil) ikilisinde benzersizdir,
 *   - yinelenen ekleme ikinci bir davet üretmez,
 *   - termin değişimi AYNI UID ile daha YÜKSEK sürüm gönderir,
 *   - ilgisiz düzenleme hiç posta üretmez,
 *   - kaldırma ve görev silme iptal daveti gönderir,
 *   - görünürlüğünü yitiren kullanıcıya görev ayrıntısı gönderilmez,
 *   - toplu ekleme her görevi ayrı ayrı yetkilendirir ve kısmi başarıyı taşır,
 *   - SMTP hatası görev kaydını düşürmez ve teslimat yeniden denenir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = 'A2A2A2A2-1111-4111-8111-111111111112';
const ROOT_WBS_ID = 'B2B2B2B2-2222-4222-8222-222222222222';
const TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const SECOND_TASK_ID = 'D4D4D4D4-4444-4444-8444-444444444444';
const HIDDEN_TASK_ID = 'E5E5E5E5-5555-4555-8555-555555555556';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';

const OWNER = 900001;
const OUTSIDER = 900002;

function outlookSeed(overrides = {}) {
  return {
    calendars: [{ CalendarId: CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: OWNER, DisplayName: 'Ayşe Yılmaz', Username: 'ayilmaz' },
      { Sicil: OUTSIDER, DisplayName: 'Mehmet Demir', Username: 'mdemir' },
      { Sicil: 900003, DisplayName: 'Adressiz Kişi', Username: 'adressiz' }
    ],
    corporateUsers: [
      { Name: 'ayilmaz', EmailAddress: 'ayse.yilmaz@example.internal' },
      { Name: 'mdemir', EmailAddress: 'mehmet.demir@example.internal' },
      { Name: 'adressiz', EmailAddress: '' }
    ],
    projects: [
      {
        ProjectId: PROJECT_ID,
        SourceType: 'CORPORATE',
        ProjectCode: 'P4417041',
        ProjectName: 'İHA Projesi',
        CalendarId: CALENDAR_ID,
        IsActive: 1
      },
      {
        ProjectId: OTHER_PROJECT_ID,
        SourceType: 'CORPORATE',
        ProjectCode: 'P4417099',
        ProjectName: 'Gizli Proje',
        CalendarId: CALENDAR_ID,
        IsActive: 1
      }
    ],
    corporateProjectAccess: [{ ProjectCode: 'P4417041', Sicil: OWNER, RoleCode: 'PROJECT_MANAGER' }],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P4417041', Name: 'Kök' }],
    tasks: [
      {
        TaskId: TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        Title: 'Teklif dosyasının hazırlanması',
        Status: 'in-progress',
        TargetFinish: '2026-09-15'
      },
      {
        TaskId: SECOND_TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        Title: 'Şartname gözden geçirme',
        Status: 'todo',
        TargetFinish: '2026-09-20'
      },
      {
        TaskId: HIDDEN_TASK_ID,
        ProjectId: OTHER_PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        Title: 'Görünmeyen görev',
        Status: 'todo',
        TargetFinish: '2026-09-25'
      }
    ],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: OWNER }],
    ...overrides
  };
}

/** Gönderilen iletileri toplayan sahte posta taşıması. */
function recordingMailer({ failWith = null } = {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      if (failWith) return { ok: false, code: failWith, deliveryMayHaveEscaped: false, message: 'E-posta gönderilemedi.' };
      sent.push(message);
      return { ok: true, accepted: message.to, rejected: [], messageId: `id-${sent.length}` };
    }
  };
}

async function withOutlookStack(seed, run, { sicil = OWNER } = {}) {
  registerServerOnlyShim();
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  process.env.MERGEN_ROTA_AUTH_MODE = 'development';
  process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED = 'true';
  process.env.MERGEN_ROTA_DEV_SICIL = String(sicil);
  // Davet gönderimi yapılandırılmış bir SMTP gerektirir; taşıyıcı enjekte
  // edilse de hizmet düzenleyici adresini yapılandırmadan okur.
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'mergen-rota@example.internal';
  process.env.SMTP_FROM_NAME = 'MERGEN Rota';

  const db = createFakeDatabase(seed);
  const { setSqlDriverForTests, resetSqlPoolForTests, getSqlPool } = await import('../src/server/db/pool.js');
  const { setCurrentUserProvider } = await import('../src/server/identity/currentUserProvider.js');
  setCurrentUserProvider(null);
  setSqlDriverForTests(createFakeSqlServerDriver(db));
  resetSqlPoolForTests();
  try {
    const pool = await getSqlPool();
    return await run({ db, pool });
  } finally {
    setSqlDriverForTests(null);
    resetSqlPoolForTests();
  }
}

const service = () => import('../src/server/outlook/outlookCalendarService.js');

/** Gönderilen iletideki iCalendar parçasının alanları. */
function calendarFields(message) {
  const content = message.calendar.content;
  const unfolded = content.replace(/\r\n /g, '');
  return {
    method: /\r\nMETHOD:([A-Z]+)\r\n/.exec(unfolded)?.[1],
    uid: /\r\nUID:(.+)\r\n/.exec(unfolded)?.[1],
    sequence: Number(/\r\nSEQUENCE:(\d+)\r\n/.exec(unfolded)?.[1]),
    start: /\r\nDTSTART;VALUE=DATE:(\d+)\r\n/.exec(unfolded)?.[1],
    end: /\r\nDTEND;VALUE=DATE:(\d+)\r\n/.exec(unfolded)?.[1],
    summary: /\r\nSUMMARY:(.+)\r\n/.exec(unfolded)?.[1],
    status: /\r\nSTATUS:([A-Z]+)\r\n/.exec(unfolded)?.[1],
    attendee: /\r\nATTENDEE[^\r\n]*:mailto:([^\r\n]+)\r\n/.exec(unfolded)?.[1]
  };
}

/* ── 1. Ekleme ve kalıcılık ─────────────────────────────────────── */

test('görev kullanıcının kendi adresine davet olarak gider ve abonelik kalıcılaşır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const result = await addTaskToOutlook(pool, {
      taskId: TASK_ID,
      sicil: OWNER,
      link: 'https://mergen.example.internal/rota/',
      send: mailer.send
    });

    assert.equal(result.status, 'ADDED');
    assert.equal(mailer.sent.length, 1);
    // Alıcı SUNUCUDA Sicil üzerinden çözülür; istemci adres göndermez.
    assert.deepEqual(mailer.sent[0].to, ['ayse.yilmaz@example.internal']);
    const fields = calendarFields(mailer.sent[0]);
    assert.equal(fields.method, 'REQUEST');
    assert.equal(fields.sequence, 1);
    assert.equal(fields.start, '20260915');
    // Tüm gün olayında bitiş DIŞLAYICIDIR.
    assert.equal(fields.end, '20260916');
    assert.equal(fields.attendee, 'ayse.yilmaz@example.internal');
    assert.match(fields.summary, /MERGEN Rota · Teklif dosyasının hazırlanması/);

    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.UserSicil, OWNER);
    assert.equal(row.IsActive, 1);
    assert.equal(row.Sequence, 1);
    assert.equal(row.DeliveredSequence, 1);
    assert.equal(row.PendingMethod, null);
    assert.equal(row.DeliveredSummary, 'MERGEN Rota · Teklif dosyasının hazırlanması');
    assert.equal(row.DeliveredDate, '2026-09-15');
    assert.match(row.CalendarUid, /^mergen-rota-task-c3c3c3c3-.+-user-900001@mergen-rota$/);
    assert.equal(row.CalendarAttendee, 'ayse.yilmaz@example.internal');
    const state = await (await service()).loadOutlookCalendarState(pool, { sicil: OWNER });
    assert.equal(JSON.stringify(state).includes('@example.internal'), false);
  });
});

test('yinelenen ekleme ikinci bir davet üretmez ve ikinci satır açmaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const input = { taskId: TASK_ID, sicil: OWNER, send: mailer.send };

    const first = await addTaskToOutlook(pool, input);
    const second = await addTaskToOutlook(pool, input);
    const third = await addTaskToOutlook(pool, input);

    assert.equal(first.status, 'ADDED');
    assert.equal(second.status, 'ALREADY_ADDED');
    assert.equal(third.status, 'ALREADY_ADDED');
    assert.equal(mailer.sent.length, 1);
    assert.equal(db.taskOutlookSubscriptions.length, 1);
    assert.equal(db.taskOutlookSubscriptions[0].Sequence, 1);
  });
});

test('eşzamanlı iki ekleme isteği tek abonelik ve tek davet üretir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const input = { taskId: TASK_ID, sicil: OWNER, send: mailer.send };

    const [left, right] = await Promise.all([addTaskToOutlook(pool, input), addTaskToOutlook(pool, input)]);

    // Benzersiz kısıt ikinci satırı engeller; süren teslimatın KİRASI da ikinci
    // daveti engeller.
    assert.equal(db.taskOutlookSubscriptions.length, 1);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, ['ADDED', 'IN_PROGRESS']);
    assert.equal(mailer.sent.length, 1);
  });
});

test('termini olmayan görev takvime eklenmez', async () => {
  const seed = outlookSeed();
  seed.tasks[0].TargetFinish = null;
  await withOutlookStack(seed, async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const result = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'NO_CALENDAR_DATE');
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions.length, 0);
  });
});

/* ── 2. Yetkilendirme ───────────────────────────────────────────── */

test('görünmeyen görev kendi takvimine EKLENEMEZ', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const result = await addTaskToOutlook(pool, { taskId: HIDDEN_TASK_ID, sicil: OWNER, send: mailer.send });

    assert.equal(result.status, 'FORBIDDEN');
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions.length, 0);
  }, { sicil: OWNER });
});

test('adresi çözülemeyen kullanıcıya davet gönderilmez', async () => {
  const seed = outlookSeed();
  seed.taskAssignees = [{ TaskId: TASK_ID, Sicil: 900003 }];
  await withOutlookStack(seed, async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const mailer = recordingMailer();
    const result = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: 900003, send: mailer.send });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'NO_RECIPIENT_ADDRESS');
    assert.equal(mailer.sent.length, 0);
    // Abonelik KALICIDIR: adres tanımlandığında kuyruk yeniden dener.
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
  }, { sicil: 900003 });
});

test('görünürlüğünü yitiren kullanıcıya görev ayrıntısı gönderilmez; randevu iptal edilir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    // Kurumsal proje yetkisi ve atama kaldırılır: kullanıcı görevi artık görmez.
    db.corporateProjectAccess = [];
    db.taskAssignees = [];
    db.taskOutlookSubscriptions[0].PendingMethod = 'REQUEST';
    db.taskOutlookSubscriptions[0].NextAttemptAt = null;

    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.cancelled, 1);
    assert.equal(mailer.sent.length, 2);
    const cancel = calendarFields(mailer.sent[1]);
    assert.equal(cancel.method, 'CANCEL');
    assert.equal(cancel.status, 'CANCELLED');
    // İptal AYNI UID ile ve daha YÜKSEK sürümle gider.
    assert.equal(cancel.uid, calendarFields(mailer.sent[0]).uid);
    assert.ok(cancel.sequence > calendarFields(mailer.sent[0]).sequence);
    // İptal iletisi görev ayrıntısı taşımaz.
    assert.equal(mailer.sent[1].calendar.content.includes('DESCRIPTION'), false);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
  });
});

/* ── 3. Otomatik güncelleme ─────────────────────────────────────── */

test('termin değişikliği AYNI UID ile daha YÜKSEK sürüm gönderir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const task = db.tasks.find((entry) => entry.TaskId === TASK_ID);
    task.TargetFinish = '2026-09-18';
    db.taskOutlookSubscriptions[0].PendingMethod = 'REQUEST';
    db.taskOutlookSubscriptions[0].QueueSeq += 1;
    db.taskOutlookSubscriptions[0].NextAttemptAt = null;

    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.sent, 1);
    assert.equal(mailer.sent.length, 2);
    const first = calendarFields(mailer.sent[0]);
    const second = calendarFields(mailer.sent[1]);
    assert.equal(second.uid, first.uid);
    assert.equal(second.method, 'REQUEST');
    assert.equal(second.sequence, first.sequence + 1);
    assert.equal(second.start, '20260918');
    assert.equal(second.end, '20260919');
  });
});

test('kanonik gösterim DEĞİŞMEDİYSE ikinci ileti gönderilmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    // Kuyruğa iş yazılır ama randevuda görünen hiçbir alan değişmemiştir.
    db.taskOutlookSubscriptions[0].PendingMethod = 'REQUEST';
    db.taskOutlookSubscriptions[0].QueueSeq += 1;
    db.taskOutlookSubscriptions[0].NextAttemptAt = null;

    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.unchanged, 1);
    assert.equal(summary.sent, 0);
    assert.equal(mailer.sent.length, 1);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);
    // Sürüm de ilerlemez: Outlook gereksiz bir revizyon görmez.
    assert.equal(db.taskOutlookSubscriptions[0].Sequence, 1);
  });
});

test('ilgisiz görev düzenlemesi kuyruğa hiç iş yazmaz; takvim alanı yazar', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const { enqueueOutlookTaskChange } = await import('../src/server/outlook/outlookCommitHooks.js');
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const before = { Title: 'Teklif', TargetFinish: '2026-09-15', PlannedFinish: null, ProjectId: PROJECT_ID };
    const irrelevant = { ...before, Progress: 40, Keyword: 'Teklif', Description: 'not' };
    assert.equal(await enqueueOutlookTaskChange(pool, TASK_ID, before, irrelevant), false);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);

    const relevant = { ...before, TargetFinish: '2026-09-18' };
    assert.equal(await enqueueOutlookTaskChange(pool, TASK_ID, before, relevant), true);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
  });
});

/* ── 4. Kaldırma ve yaşam döngüsü ───────────────────────────────── */

test('kaldırma iptal daveti gönderir ve aboneliği kapatır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, removeTaskFromOutlook } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const removed = await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    assert.equal(removed.status, 'REMOVED');
    const cancel = calendarFields(mailer.sent[1]);
    assert.equal(cancel.method, 'CANCEL');
    assert.equal(cancel.sequence, 2);
    assert.equal(cancel.uid, calendarFields(mailer.sent[0]).uid);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);

    // Kapalı abonelik ikinci kez kaldırılamaz.
    const again = await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(again.status, 'NOT_SUBSCRIBED');
    assert.equal(mailer.sent.length, 2);
  });
});

test('hiç teslim edilmemiş abonelik posta göndermeden kapatılır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, removeTaskFromOutlook } = await service();
    const failing = recordingMailer({ failWith: 'SMTP_CONNECTION_FAILED' });
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: failing.send });
    assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, null);

    const mailer = recordingMailer();
    const removed = await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    assert.equal(removed.status, 'REMOVED');
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
  });
});

test('kaldırılan görev yeniden eklenebilir ve sürüm geriye gitmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, removeTaskFromOutlook } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    const again = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    assert.equal(again.status, 'ADDED');
    assert.equal(db.taskOutlookSubscriptions.length, 1);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
    const revive = calendarFields(mailer.sent[2]);
    assert.equal(revive.method, 'REQUEST');
    assert.equal(revive.sequence, 3);
  });
});

test('görev silindiğinde iptal kuyruğa girer ve künye satırdan okunur', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const { enqueueOutlookTaskRemoval } = await import('../src/server/outlook/outlookCommitHooks.js');
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    await enqueueOutlookTaskRemoval(pool, TASK_ID);
    db.tasks = db.tasks.filter((entry) => entry.TaskId !== TASK_ID);
    db.taskOutlookSubscriptions[0].NextAttemptAt = null;

    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.cancelled, 1);
    const cancel = calendarFields(mailer.sent[1]);
    assert.equal(cancel.method, 'CANCEL');
    assert.equal(cancel.summary, 'MERGEN Rota takvim kaydı');
    assert.equal(cancel.start, undefined);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
  });
});

/* ── 5. Toplu ekleme ────────────────────────────────────────────── */

test('toplu ekleme her görevi ayrı davetle gönderir ve kısmi başarıyı taşır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    const outcome = await addTasksToOutlook(pool, {
      // Yinelenen kimlik, görünmeyen görev ve geçerli görevler bir arada.
      taskIds: [TASK_ID, TASK_ID.toLowerCase(), SECOND_TASK_ID, HIDDEN_TASK_ID],
      sicil: OWNER,
      send: mailer.send
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.summary, { added: 0, alreadyAdded: 0, queued: 2, failed: 1, total: 3 });
    assert.equal(mailer.sent.length, 0);
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    // Her görev KENDİ davetini alır; tek bir randevuda birleştirilmez.
    assert.equal(mailer.sent.length, 2);
    const uids = mailer.sent.map((message) => calendarFields(message).uid);
    assert.equal(new Set(uids).size, 2);
    assert.equal(db.taskOutlookSubscriptions.length, 2);
    // Görünmeyen görev sessizce reddedilir; ötekiler işlenmeye devam eder.
    const blocked = outcome.results.find((item) => item.taskId === HIDDEN_TASK_ID);
    assert.equal(blocked.status, 'FORBIDDEN');
  });
});

test('toplu ekleme zaten ekli görevleri atlar', async () => {
  await withOutlookStack(outlookSeed(), async ({ pool }) => {
    const { addTaskToOutlook, addTasksToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const outcome = await addTasksToOutlook(pool, {
      taskIds: [TASK_ID, SECOND_TASK_ID],
      sicil: OWNER,
      send: mailer.send
    });

    assert.deepEqual(outcome.summary, { added: 0, alreadyAdded: 1, queued: 1, failed: 0, total: 2 });
    assert.equal(mailer.sent.length, 1);
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 2);
  });
});

test('sunucu toplu sınırını aşan istek reddedilir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook } = await service();
    const mailer = recordingMailer();
    const outcome = await addTasksToOutlook(pool, {
      taskIds: [TASK_ID, SECOND_TASK_ID, HIDDEN_TASK_ID],
      sicil: OWNER,
      send: mailer.send,
      limit: 2
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'BULK_LIMIT_EXCEEDED');
    assert.equal(outcome.limit, 2);
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions.length, 0);
  });
});

/* ── 6. Dayanıklılık ve yeniden deneme ──────────────────────────── */

test('SMTP hatası aboneliği düşürmez; kuyrukta kalır ve sonraki tur gönderir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const failing = recordingMailer({ failWith: 'SMTP_CONNECTION_FAILED' });
    const result = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: failing.send });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'SMTP_CONNECTION_FAILED');
    assert.match(result.message, /yeniden deneyecek/);
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.PendingMethod, 'REQUEST');
    assert.equal(row.LastFailureCode, 'SMTP_CONNECTION_FAILED');
    // Geri çekilme uygulanır: satır hemen yeniden denenmez.
    assert.ok(new Date(row.NextAttemptAt).getTime() > Date.now());

    row.NextAttemptAt = null;
    const mailer = recordingMailer();
    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.sent, 1);
    assert.equal(mailer.sent.length, 1);
    assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, 1);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);
  });
});

test('SMTP başarılı olup kayıt güncellenemezse yeniden deneme AYNI sürümü kullanır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    // Kesilen kalıcılaştırma taklidi: gönderim başarılı, sonuç yazılamadı.
    // Ayrılmış sürüm ve içerik parmak izi satırda DURUYOR; teslim kaydı yok.
    const row = db.taskOutlookSubscriptions[0];
    row.PendingMethod = 'REQUEST';
    row.PendingSequence = row.DeliveredSequence;
    row.PendingPayloadHash = row.DeliveredPayloadHash;
    row.PendingDate = row.DeliveredDate;
    row.DeliveredSequence = null;
    row.DeliveredPayloadHash = null;
    row.NextAttemptAt = null;
    row.InFlightSince = null;

    const summary = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true });

    assert.equal(summary.sent, 1);
    // Aynı mantıksal revizyon: UID ve SEQUENCE değişmez, Outlook ikinci bir
    // randevu açmaz.
    const first = calendarFields(mailer.sent[0]);
    const retry = calendarFields(mailer.sent[1]);
    assert.equal(retry.uid, first.uid);
    assert.equal(retry.sequence, first.sequence);
    assert.equal(db.taskOutlookSubscriptions[0].Sequence, 1);
  });
});

test('deneme eşiği dolsa da vadesi gelen kayıt yeniden denenir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const failing = recordingMailer({ failWith: 'SMTP_CONNECTION_FAILED' });
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: failing.send });

    const row = db.taskOutlookSubscriptions[0];
    row.AttemptCount = 6;
    row.NextAttemptAt = null;

    const mailer = recordingMailer();
    const exhausted = await runOutlookCalendarOutbox(pool, { send: mailer.send, mailConfigured: true, maxAttempts: 6 });
    assert.equal(exhausted.claimed, 1);
    assert.equal(exhausted.ok, true);
    assert.equal(mailer.sent.length, 1);

    // Kullanıcının açık eylemi deneme sayacını sıfırlar.
    const retried = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(retried.status, 'ALREADY_ADDED');
    assert.equal(mailer.sent.length, 1);
  });
});

test('SMTP yapılandırılmamışken kuyruk sahiplenilmez ve deneme hakkı tüketilmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const failing = recordingMailer({ failWith: 'SMTP_NOT_CONFIGURED' });
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: failing.send });
    const attempts = db.taskOutlookSubscriptions[0].AttemptCount;

    const summary = await runOutlookCalendarOutbox(pool, { send: failing.send, mailConfigured: false });

    assert.equal(summary.ok, false);
    assert.equal(summary.reason, 'SMTP_NOT_CONFIGURED');
    assert.equal(summary.claimed, 0);
    assert.equal(db.taskOutlookSubscriptions[0].AttemptCount, attempts);
  });
});

test('bir teslimatın hatası turu durdurmaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, runOutlookCalendarOutbox } = await service();
    const failing = recordingMailer({ failWith: 'SMTP_CONNECTION_FAILED' });
    await addTasksToOutlook(pool, { taskIds: [TASK_ID, SECOND_TASK_ID], sicil: OWNER, send: failing.send });

    for (const row of db.taskOutlookSubscriptions) row.NextAttemptAt = null;
    // İlk görev artık görünmez: teslimatı iptale döner, ikincisi gönderilir.
    let calls = 0;
    const partial = {
      sent: [],
      async send(message) {
        calls += 1;
        if (calls === 1) return { ok: false, code: 'SMTP_SEND_FAILED', message: 'E-posta gönderilemedi.' };
        partial.sent.push(message);
        return { ok: true, accepted: message.to, rejected: [], messageId: 'id' };
      }
    };

    const summary = await runOutlookCalendarOutbox(pool, { send: partial.send, mailConfigured: true });

    assert.equal(summary.claimed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.sent, 1);
    assert.equal(partial.sent.length, 1);
  });
});

test('0010 göçü çalıştırılmamış kurulumda özellik sessizce kapalı davranır', async () => {
  await withOutlookStack(outlookSeed({ outlookSchemaMissing: true }), async ({ pool }) => {
    const { loadOutlookCalendarState, runOutlookCalendarOutbox, outlookSchemaProblem } = await service();
    const state = await loadOutlookCalendarState(pool, { sicil: OWNER });
    assert.equal(state.schemaReady, false);
    assert.deepEqual(state.tasks, []);

    const summary = await runOutlookCalendarOutbox(pool, { send: recordingMailer().send, mailConfigured: true });
    assert.equal(summary.schemaReady, false);
    assert.equal(summary.claimed, 0);

    const error = new Error("Invalid object name 'dbo.MR_TaskOutlookSubscriptions'.");
    error.number = 208;
    assert.equal(outlookSchemaProblem(error).code, 'OUTLOOK_SCHEMA_MISSING');
    assert.equal(outlookSchemaProblem(new Error('başka hata')), null);
  });
});

/* ── 7. Arayüz durumu ───────────────────────────────────────────── */

test('kullanıcının etkin abonelikleri arayüze taşınır; başkasınınki taşınmaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ pool }) => {
    const { addTaskToOutlook, loadOutlookCalendarState } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const mine = await loadOutlookCalendarState(pool, { sicil: OWNER });
    assert.equal(mine.tasks.length, 1);
    assert.equal(mine.tasks[0].delivered, true);

    const theirs = await loadOutlookCalendarState(pool, { sicil: OUTSIDER });
    assert.deepEqual(theirs.tasks, []);
  });
});

test('yeniden gönderim aynı sürümü korur; içerik değiştiyse sürüm ilerler', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, resendTaskInvitation } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });

    const resent = await resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(resent.status, 'RESENT');
    assert.equal(calendarFields(mailer.sent[1]).sequence, 1);

    db.tasks.find((entry) => entry.TaskId === TASK_ID).Title = 'Teklif dosyası (revize)';
    const updated = await resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(updated.status, 'RESENT');
    assert.equal(calendarFields(mailer.sent[2]).sequence, 2);
    assert.match(calendarFields(mailer.sent[2]).summary, /revize/);
  });
});

function interceptQuery(pool, predicate, before) {
  let intercepted = false;
  return {
    request() {
      const request = pool.request();
      const query = request.query.bind(request);
      request.query = async (text) => {
        if (!intercepted && predicate(text)) {
          intercepted = true;
          await before();
        }
        return query(text);
      };
      return request;
    }
  };
}

test('eski iptal teslimatı sürerken yeniden ekleme kaybolmaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, removeTaskFromOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: async (message) => {
      const added = await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      assert.equal(added.status, 'IN_PROGRESS');
      return mailer.send(message);
    } });
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.deepEqual(mailer.sent.map((item) => calendarFields(item).method), ['REQUEST', 'CANCEL', 'REQUEST']);
    assert.deepEqual(mailer.sent.map((item) => calendarFields(item).sequence), [1, 2, 3]);
  });
});

test('eski başarısızlık yeni iptali geri çekilmeyle geciktirmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const { queueOutlookCancellation } = await import('../src/server/outlook/outlookStore.js');
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: async () => {
      await queueOutlookCancellation(pool, TASK_ID, OWNER);
      return { ok: false, code: 'SMTP_TIMEOUT' };
    } });
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.PendingMethod, 'CANCEL');
    assert.equal(row.NextAttemptAt, null);
    assert.equal(row.LastFailureCode, null);
    assert.equal(row.LeaseToken, null);
  });
});

test('eski içerik için sürüm ayıran çalışan yeni iptal neslini sahiplenemez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const { queueOutlookCancellation } = await import('../src/server/outlook/outlookStore.js');
    const wrapped = interceptQuery(pool, (sql) => sql.includes('AS AllocatedSequence'),
      () => queueOutlookCancellation(pool, TASK_ID, OWNER));
    const mailer = recordingMailer();
    const outcome = await addTaskToOutlook(wrapped, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(outcome.status, 'IN_PROGRESS');
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'CANCEL');
    assert.equal(db.taskOutlookSubscriptions[0].PendingSequence, null);
  });
});

test('posta göndermeden kapatan eski çalışan yeni aboneliği silemez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, addTaskToOutlook, removeTaskFromOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    const wrapped = interceptQuery(pool, (sql) => sql.includes('SET IsActive = 0'), async () => {
      await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    });
    const result = await removeTaskFromOutlook(wrapped, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(result.status, 'IN_PROGRESS');
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 1);
  });
});

test('hiç teslim edilmemiş iptal SMTP ve alıcı dizinine bağlı değildir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, removeTaskFromOutlook } = await service();
    await addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      const wrapped = interceptQuery(pool, (sql) => sql.includes('EmailAddress'), () => { throw new Error('dizin kapalı'); });
      const removed = await removeTaskFromOutlook(wrapped, { taskId: TASK_ID, sicil: OWNER, send: () => assert.fail('posta gönderilmemeli') });
      assert.equal(removed.status, 'REMOVED');
      assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
    } finally { process.env.SMTP_HOST = host; }
  });
});

test('alıcı dizini hatası ilk aboneliği kalıcı ve yeniden denenebilir bırakır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const wrapped = interceptQuery(pool, (sql) => sql.includes('EmailAddress'), () => { throw new Error('dizin kapalı'); });
    const mailer = recordingMailer();
    const result = await addTaskToOutlook(wrapped, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(result.status, 'FAILED');
    assert.equal(db.taskOutlookSubscriptions.length, 1);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    db.taskOutlookSubscriptions[0].NextAttemptAt = null;
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 1);
  });
});

test('alıcı ve düzenleyici adresleri değişse de aynı takvim kimlikleri korunur', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, resendTaskInvitation, removeTaskFromOutlook } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    const original = process.env.SMTP_FROM;
    process.env.SMTP_FROM = 'yeni@example.internal';
    db.corporateUsers[0].EmailAddress = 'yeni-kutu@example.internal';
    try {
      db.tasks[0].Title = 'Yeni başlık';
      await resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      await removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      for (const message of mailer.sent) {
        assert.deepEqual(message.to, ['ayse.yilmaz@example.internal']);
        assert.ok(message.calendar.content.includes(`mailto:${original}`));
        assert.ok(!message.calendar.content.includes('yeni@example.internal'));
      }
    } finally { process.env.SMTP_FROM = original; }
  });
});

test('teslimat kapalıyken değişiklik ve silme kuyrukta korunur', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook } = await service();
    const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: recordingMailer().send });
    const previous = process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED;
    process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED = 'false';
    try {
      const before = { ...db.tasks[0], assigneeIds: [OWNER] };
      assert.equal(await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, { ...before, assigneeIds: [] }), true);
      assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
      await hooks.enqueueOutlookTaskRemoval(pool, TASK_ID);
      assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'CANCEL');
    } finally {
      if (previous == null) delete process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED;
      else process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED = previous;
    }
  });
});

test('proje lideri değişikliği eski liderin randevusunu iptal ettirir', async () => {
  const data = outlookSeed({ corporateProjectAccess: [], taskAssignees: [] });
  data.projects[0].SourceType = 'MANUAL';
  data.projects[0].LeadSicil = OWNER;
  await withOutlookStack(data, async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const { enqueueOutlookProjectChange } = await import('../src/server/outlook/outlookCommitHooks.js');
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    const before = { ...db.projects[0] };
    db.projects[0].LeadSicil = OUTSIDER;
    await enqueueOutlookProjectChange(pool, PROJECT_ID, before, db.projects[0]);
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(calendarFields(mailer.sent[1]).method, 'CANCEL');
  });
});

test('kullanıcı iptali görev güncellemesiyle yeniden etkinleşmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const { queueOutlookCancellation, enqueueOutlookTaskUpdate } = await import('../src/server/outlook/outlookStore.js');
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await queueOutlookCancellation(pool, TASK_ID, OWNER);
    await enqueueOutlookTaskUpdate(pool, TASK_ID);
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
    assert.equal(calendarFields(mailer.sent[1]).method, 'CANCEL');
  });
});

test('zamanlayıcı sonraki satırı teslimat başlamadan sahiplenmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, runOutlookCalendarOutbox } = await service();
    await addTasksToOutlook(pool, { taskIds: [TASK_ID, SECOND_TASK_ID], sicil: OWNER });
    let calls = 0;
    await runOutlookCalendarOutbox(pool, { send: async () => {
      calls += 1;
      if (calls === 1) assert.equal(db.taskOutlookSubscriptions[1].LeaseToken ?? null, null);
      return { ok: true };
    } });
    assert.equal(calls, 2);
  });
});

test('kısa kira çökme sonrası devralınabilir ve eski sahip yazamaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook } = await service();
    const store = await import('../src/server/outlook/outlookStore.js');
    await addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    assert.equal(store.INTERACTIVE_LEASE_SECONDS, 60);
    const first = await store.claimOutlookSubscription(pool, 1);
    db.taskOutlookSubscriptions[0].InFlightSince = new Date(Date.now() - 310000).toISOString();
    assert.equal(await store.claimOutlookSubscription(pool, 1), null);
    db.taskOutlookSubscriptions[0].LeaseExpiresAt = new Date(0).toISOString();
    const second = await store.claimOutlookSubscription(pool, 1);
    assert.notEqual(second.leaseToken, first.leaseToken);
    await store.failOutlookDelivery(pool, { ...first, failureCode: 'STALE', retrySeconds: 3600 });
    await store.settleOutlookDelivery(pool, first);
    await store.deactivateOutlookSubscription(pool, first);
    await store.completeOutlookDelivery(pool, { ...first, method: 'CANCEL', sequence: 9, payloadHash: 'x', summary: 'x', calendarDate: '2026-09-15' });
    assert.equal(db.taskOutlookSubscriptions[0].LeaseToken, second.leaseToken);
    assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, null);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
  });
});

test('kuyruk eski vadesi gelen satırı önce işler', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const { addTasksToOutlook, runOutlookCalendarOutbox } = await service();
    await addTasksToOutlook(pool, { taskIds: [TASK_ID, SECOND_TASK_ID], sicil: OWNER });
    db.taskOutlookSubscriptions[0].NextAttemptAt = new Date(Date.now() - 1000).toISOString();
    db.taskOutlookSubscriptions[1].NextAttemptAt = new Date(Date.now() - 5000).toISOString();
    const mailer = recordingMailer();
    await runOutlookCalendarOutbox(pool, { send: mailer.send, limit: 1 });
    assert.match(calendarFields(mailer.sent[0]).summary, /Şartname/);
    assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, null);
  });
});

test('toplu uç eksik Outlook şemasını 503 olarak bildirir ve başka SQL nesnelerini karıştırmaz', async () => {
  await withOutlookStack(outlookSeed({ outlookSchemaMissing: true }), async ({ pool }) => {
    const { POST } = await import('../src/app/api/mergen-rota/outlook/tasks/route.js');
    const response = await POST(new Request('http://localhost/outlook/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskIds: [TASK_ID] })
    }));
    assert.equal(response.status, 503);
    const { isMissingOutlookSchema } = await import('../src/server/outlook/outlookStore.js');
    assert.equal(isMissingOutlookSchema(Object.assign(new Error("Invalid object name 'DC01_userr'."), { number: 208 })), false);
    await assert.rejects((await service()).addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER }), isMissingOutlookSchema);
  });
});

test('eksik Outlook şeması yerelleştirilmiş SQL numaralarıyla tanınır', async () => {
  registerServerOnlyShim();
  const { isMissingOutlookSchema } = await import('../src/server/outlook/outlookStore.js');
  const column = { number: 207, message: "Geçersiz sütun adı 'CompletionDate'." };
  const table = { number: 208, message: "Geçersiz nesne adı 'dbo.MR_TaskOutlookSubscriptions'." };
  for (const error of [column, table, { originalError: column }, { originalError: { info: table } },
    { cause: column }, { precedingErrors: [table] }]) {
    assert.equal(isMissingOutlookSchema(error), true);
  }
  for (const error of [
    { number: 207, message: "Geçersiz sütun adı 'UnrelatedColumn'." },
    { number: 208, message: "Geçersiz nesne adı 'dbo.MR_Tasks'." },
    { number: 1205, message: 'CompletionDate kilitlenmesi' },
    { message: 'MR_TaskOutlookSubscriptions bağlantısı kesildi' }
  ]) assert.equal(isMissingOutlookSchema(error), false);
});

test('toplu istek gövdesi başlıksız akışta da bayt sınırında durdurulur', async () => {
  const { readOutlookRequestBody, OUTLOOK_BODY_LIMIT } = await import('../src/server/outlook/outlookRequestBody.js');
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(OUTLOOK_BODY_LIMIT + 1)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(readOutlookRequestBody({ body: stream, headers: new Headers() }), (error) => error.status === 413);
  assert.equal(cancelled, true);
  await assert.rejects(readOutlookRequestBody(new Request('http://localhost', { method: 'POST', body: '{' })), (error) => error.status === 400);
  const valid = await readOutlookRequestBody(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ taskIds: [TASK_ID] }) }));
  assert.deepEqual(valid.taskIds, [TASK_ID]);
});

test('zamanlanmış Outlook bağlantısı iç zamanlayıcı kökenini kullanmaz', async () => {
  const { outlookApplicationLink } = await import('../src/server/outlook/outlookConfig.js');
  const previous = process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
  delete process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
  try {
    assert.equal(outlookApplicationLink(), null);
    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'https://rota.example.internal';
    assert.ok(outlookApplicationLink().startsWith('https://rota.example.internal/'));
  } finally {
    if (previous == null) delete process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
    else process.env.MERGEN_ROTA_PUBLIC_ORIGIN = previous;
  }
});

test('SQL sahiplik, nesil ve yarışan ilk ekleme korumalarını içerir', async () => {
  const queries = await import('../src/server/outlook/outlookQueries.js');
  for (const key of ['OUTLOOK_ALLOCATE_SQL', 'OUTLOOK_DEACTIVATE_SQL']) {
    assert.match(queries[key], /WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken AND QueueSeq = @queueSeq/);
  }
  for (const key of ['OUTLOOK_COMPLETE_SQL', 'OUTLOOK_FAIL_SQL', 'OUTLOOK_SETTLE_SQL']) {
    assert.match(queries[key], /WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken/);
  }
  assert.match(queries.OUTLOOK_SUBSCRIPTION_UPSERT_SQL, /IF NOT EXISTS \(SELECT 1 FROM @rows\)\s+INSERT @rows SELECT/);
  assert.match(queries.OUTLOOK_CLAIM_SQL, /ORDER BY NextAttemptAt, SubscriptionId/);
});

test('kurumsal proje eşitlemesi yeniden adlandırmayı ve devre dışı bırakmayı kuyruğa yazar', async () => {
  const { createActualStack } = await import('./helpers/actualStack.mjs');
  const data = outlookSeed();
  data.corporateProjects = data.projects.map((row) => ({ ProjectCode: row.ProjectCode, ProjectName: row.ProjectName }));
  const stack = await createActualStack(data, { sicil: OWNER, corporateWbsSource: false });
  try {
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const pool = await getSqlPool();
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    stack.db.corporateProjects[0].ProjectName = 'Yeni proje adı';
    await stack.reload();
    assert.equal(stack.db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.match(mailer.sent[1].calendar.content, /Yeni proje adı/);
    stack.db.corporateProjects = stack.db.corporateProjects.filter((row) => row.ProjectCode !== 'P4417041');
    await stack.reload();
    assert.equal(stack.db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(calendarFields(mailer.sent[2]).method, 'CANCEL');
  } finally { await stack.dispose(); }
});

test('gerçek görev kaydı sorumlu kaldırılınca eski sorumlunun davetini iptal eder', async () => {
  const { createActualStack } = await import('./helpers/actualStack.mjs');
  const data = outlookSeed({ corporateProjectAccess: [], taskAssignees: [{ TaskId: TASK_ID, Sicil: OUTSIDER }] });
  data.projects[0].SourceType = 'MANUAL';
  data.projects[0].LeadSicil = OWNER;
  data.projectAccess = [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'FULL' }];
  const stack = await createActualStack(data, { sicil: OWNER, corporateWbsSource: false });
  try {
    const pool = await (await import('../src/server/db/pool.js')).getSqlPool();
    const { addTaskToOutlook, runOutlookCalendarOutbox } = await service();
    const mailer = recordingMailer();
    await addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OUTSIDER, send: mailer.send });
    const task = stack.state.tasks.find((row) => row.id.toLowerCase() === TASK_ID.toLowerCase());
    assert.ok(task);
    await stack.repository.commitChanges({ taskUpserts: [{ ...task, assigneeIds: [], assigneeMutation: true }] });
    assert.equal(stack.db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    await runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(calendarFields(mailer.sent[1]).method, 'CANCEL');
  } finally { await stack.dispose(); }
});

for (const [source, value] of [
  ['corporateProjectAccess', [{ ProjectCode: 'P4417041', Sicil: OWNER, RoleCode: 'READER' }]],
  ['projectAccess', [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'READ', IsActive: 1 }]],
  ['executiveScope', [{ ManagerSicil: OWNER, EmployeeSicil: OUTSIDER }]],
  ['systemAdminSicils', [OWNER]]
]) {
  test(`göreve dokunulmadan ${source} kaldırılınca düzenli tarama iptal üretir`, async () => {
    const seed = outlookSeed({ corporateProjectAccess: [], taskAssignees: [{ TaskId: TASK_ID, Sicil: OUTSIDER }], [source]: value });
    await withOutlookStack(seed, async ({ db, pool }) => {
      const api = await service();
      const mailer = recordingMailer();
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      db[source] = [];
      db.taskOutlookSubscriptions[0].LastValidatedAt = new Date(0).toISOString();
      const result = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
      assert.equal(result.cancelled, 1);
      const cancel = mailer.sent[1];
      assert.equal(calendarFields(cancel).uid, calendarFields(mailer.sent[0]).uid);
      assert.doesNotMatch(JSON.stringify(cancel), /Teklif|hazırlanması|İHA|P4417041|20260915|2026-09-15|15\.09\.2026/);
      assert.doesNotMatch(cancel.calendar.content, /DESCRIPTION|DTSTART|DTEND|URL:/);
      assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
    });
  });
}

test('iptal deneme eşiği sağlık hatası olarak kalır ve görünmeyen görev otomatik kurtarılır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
    db.tasks = [];
    const row = db.taskOutlookSubscriptions[0];
    row.AttemptCount = 6;
    row.LastFailureCode = 'SMTP_TIMEOUT';
    row.NextAttemptAt = new Date(Date.now() + 60000).toISOString();
    for (let index = 0; index < 2; index += 1) {
      const result = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
      assert.equal(result.ok, false);
      assert.equal(result.exhausted, 1);
      assert.equal(result.reason, 'OUTLOOK_RETRY_EXHAUSTED');
      assert.equal(result.claimed, 0);
    }
    row.NextAttemptAt = null;
    const recovered = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.cancelled, 1);
    assert.equal(row.IsActive, 0);
  });
});

test('SMTP kabulü belirsiz ilk davet kaydı aynı UID ile iptal edilir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    let first;
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: async (message) => {
      first = message;
      return { ok: false, code: 'SMTP_CONNECTION_FAILED', deliveryMayHaveEscaped: true };
    } });
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.DeliveredSequence, null);
    assert.equal(row.DeliveryMayHaveEscaped, 1);
    db.tasks = [];
    await (await import('../src/server/outlook/outlookStore.js')).enqueueOutlookTaskCancellation(pool, TASK_ID);
    const mailer = recordingMailer();
    const result = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(result.cancelled, 1);
    assert.equal(calendarFields(mailer.sent[0]).uid, calendarFields(first).uid);
    assert.ok(calendarFields(mailer.sent[0]).sequence > calendarFields(first).sequence);
  });
});

test('yeniden gönderim sahiplenmeden önce kalıcıdır ve çökmeden sonra aynı sürümle kurtarılır', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const store = await import('../src/server/outlook/outlookStore.js');
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await api.resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.PendingMethod, 'REQUEST');
    assert.equal(row.ForceResend, 1);
    assert.equal(row.LeaseToken, null);
    const sequence = row.QueueSeq;
    await api.resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
    assert.equal(row.QueueSeq, sequence);
    await store.claimOutlookSubscription(pool, row.SubscriptionId);
    row.LeaseExpiresAt = new Date(0).toISOString();
    row.NextAttemptAt = null;
    const result = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(result.sent, 1);
    assert.equal(calendarFields(mailer.sent[1]).sequence, calendarFields(mailer.sent[0]).sequence);
    assert.equal(row.ForceResend, 0);
  });
});

for (const failedCancel of [false, true]) {
  test(`otomatik iptal ${failedCancel ? 'başarısız olduktan' : 'sürerken'} sonra geri gelen görev yeniden doğrulanır`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const store = await import('../src/server/outlook/outlookStore.js');
      const mailer = recordingMailer();
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      db.tasks[0].TargetFinish = null;
      await store.enqueueOutlookTaskUpdate(pool, TASK_ID);
      await api.runOutlookCalendarOutbox(pool, { limit: 1, send: async (message) => {
        if (!failedCancel) {
          db.tasks[0].TargetFinish = '2026-09-15';
          await store.enqueueOutlookTaskUpdate(pool, TASK_ID);
        }
        if (failedCancel) return { ok: false, code: 'SMTP_TIMEOUT', deliveryMayHaveEscaped: true };
        return mailer.send(message);
      } });
      if (failedCancel) db.tasks[0].TargetFinish = '2026-09-15';
      db.taskOutlookSubscriptions[0].NextAttemptAt = null;
      const result = await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
      assert.equal(result.sent, 1);
      assert.equal(calendarFields(mailer.sent.at(-1)).method, 'REQUEST');
      assert.ok(calendarFields(mailer.sent.at(-1)).sequence > 2);
      assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
    });
  });
}

test('tamamlanan iptal sonrası yeniden ekleme güncel takvim adreslerini dondurur', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    const previous = process.env.SMTP_FROM;
    process.env.SMTP_FROM = 'new-organizer@example.internal';
    db.corporateUsers[0].EmailAddress = 'new-mailbox@example.internal';
    try {
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      assert.deepEqual(mailer.sent[2].to, ['new-mailbox@example.internal']);
      assert.match(mailer.sent[2].calendar.content, /mailto:new-organizer@example.internal/);
      assert.equal(calendarFields(mailer.sent[2]).uid, calendarFields(mailer.sent[0]).uid);
      assert.equal(calendarFields(mailer.sent[2]).sequence, 3);
    } finally { process.env.SMTP_FROM = previous; }
  });
});

test('eşzamanlı ve yinelenen kaldırmalar yalnızca bir iptal üretir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: async (message) => {
      const sequence = db.taskOutlookSubscriptions[0].QueueSeq;
      const second = await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      assert.equal(second.status, 'IN_PROGRESS');
      assert.equal(db.taskOutlookSubscriptions[0].QueueSeq, sequence);
      return mailer.send(message);
    } });
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 2);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
  });
});

for (const code of ['TASK_NOT_FOUND', 'FORBIDDEN', 'NO_CALENDAR_DATE']) {
  test(`ekleme sırasında değişen görev ${code} nedenini korur`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const wrapped = interceptQuery(pool, (sql) => sql.includes('SET AttemptCount = 1'), () => {
        if (code === 'TASK_NOT_FOUND') db.tasks = [];
        if (code === 'FORBIDDEN') { db.taskAssignees = []; db.corporateProjectAccess = []; }
        if (code === 'NO_CALENDAR_DATE') db.tasks[0].TargetFinish = null;
      });
      const result = await api.addTaskToOutlook(wrapped, { taskId: TASK_ID, sicil: OWNER, send: () => assert.fail('posta gönderilmemeli') });
      assert.equal(result.code, code);
    });
  });
}

test('kesin ilk alıcı reddinden sonra dizindeki düzeltilen adres yeniden çözülür', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: async () => ({
      ok: false, code: 'SMTP_NO_RECIPIENTS', deliveryMayHaveEscaped: false
    }) });
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.CalendarAttendee, null);
    assert.equal(row.DeliveryMayHaveEscaped, 0);
    db.corporateUsers[0].EmailAddress = 'corrected@example.internal';
    row.NextAttemptAt = null;
    const mailer = recordingMailer();
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.deepEqual(mailer.sent[0].to, ['corrected@example.internal']);
  });
});

test('tek görev HTTP eylemleri SMTP beklemeden kuyruk durumunu döndürür', async () => {
  await withOutlookStack(outlookSeed(), async ({ db }) => {
    const route = await import('../src/app/api/mergen-rota/tasks/[taskId]/outlook/route.js');
    for (const action of ['POST', 'PUT', 'DELETE']) {
      const response = await route[action](new Request('http://localhost/outlook', { method: action }), { params: { taskId: TASK_ID } });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.status, 'QUEUED');
      assert.equal(body.pending, true);
      assert.equal(body.delivered, false);
      assert.equal(db.taskOutlookSubscriptions[0].LeaseToken ?? null, null);
    }
  });
});

for (const kind of ['TaskUpdate', 'TaskCancellation', 'ProjectUpdate']) {
  test(`yeni ${kind} nesli önceki teslimat hatasını temizler`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      await api.addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
      db.taskOutlookSubscriptions[0].LastFailureCode = 'SMTP_TIMEOUT';
      const store = await import('../src/server/outlook/outlookStore.js');
      await store[`enqueueOutlook${kind}`](pool, kind === 'ProjectUpdate' ? PROJECT_ID : TASK_ID);
      const state = await api.loadOutlookCalendarState(pool, { sicil: OWNER });
      assert.equal(state.tasks[0].failureCode, null);
      assert.equal(state.tasks[0].pending, true);
    });
  });
}

test('geçersiz açık Outlook bayrağı kapalı kabul edilir', async () => {
  const { isOutlookCalendarEnabled } = await import('../src/server/outlook/outlookConfig.js');
  const previous = process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED;
  try {
    process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED = 'flase';
    assert.equal(isOutlookCalendarEnabled(), false);
    delete process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED;
    assert.equal(isOutlookCalendarEnabled(), true);
  } finally {
    if (previous == null) delete process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED;
    else process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED = previous;
  }
});

test('bozuk SMTP ayarı hizmet ve zamanlayıcıda aynı tanıyı korur', async () => {
  await withOutlookStack(outlookSeed(), async ({ pool }) => {
    const api = await service();
    const previous = process.env.SMTP_PORT;
    process.env.SMTP_PORT = 'invalid';
    try {
      const result = await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER });
      assert.equal(result.code, 'SMTP_CONFIG_INVALID');
      const run = await api.runOutlookCalendarOutbox(pool);
      assert.equal(run.reason, 'SMTP_CONFIG_INVALID');
      assert.equal(run.claimed, 0);
    } finally {
      if (previous == null) delete process.env.SMTP_PORT;
      else process.env.SMTP_PORT = previous;
    }
  });
});

test('yavaş SMTP tur bütçesinde kesilir ve sonraki görev sahiplenilmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    await api.addTasksToOutlook(pool, { taskIds: [TASK_ID, SECOND_TASK_ID], sicil: OWNER });
    let signal;
    const started = Date.now();
    const result = await api.runOutlookCalendarOutbox(pool, { budgetMs: 40, send: (message) => {
      signal = message.signal;
      return new Promise(() => {});
    } });
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OUTLOOK_RUN_TIMEOUT');
    assert.equal(signal.aborted, true);
    assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
    assert.equal(db.taskOutlookSubscriptions[0].LeaseToken, null);
    assert.equal(db.taskOutlookSubscriptions[1].AttemptCount, 0);
  });
});

test('toplu HTTP sınırı normalleştirilmiş benzersiz görevleri sayar', async () => {
  await withOutlookStack(outlookSeed(), async ({ db }) => {
    const { POST } = await import('../src/app/api/mergen-rota/outlook/tasks/route.js');
    const taskIds = Array.from({ length: 26 }, (_, index) => index % 2 ? TASK_ID : `actual-${TASK_ID.toLowerCase()}`);
    const response = await POST(new Request('http://localhost/outlook/tasks', {
      method: 'POST', body: JSON.stringify({ taskIds })
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results.length, 1);
    assert.equal(db.taskOutlookSubscriptions.length, 1);
  });
});

test('kira yenileme etkin gönderimi korur ve sahiplik kaybında gönderimi durdurur', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const store = await import('../src/server/outlook/outlookStore.js');
    const { keepOutlookLease, outlookDeadline } = await import('../src/server/outlook/outlookExecution.js');
    await api.addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    const claimed = await store.claimOutlookSubscription(pool, 1);
    const row = db.taskOutlookSubscriptions[0];
    row.LeaseExpiresAt = new Date(Date.now() + 500).toISOString();
    let renewed;
    const renewal = new Promise((resolve) => { renewed = resolve; });
    const wrapped = interceptQuery(pool, (sql) => sql.includes('SET LeaseExpiresAt = DATEADD'), renewed);
    const execution = outlookDeadline(1000);
    const stop = keepOutlookLease(wrapped, claimed, execution, 5);
    try {
      await renewal;
      await stop();
      assert.ok(new Date(row.LeaseExpiresAt).getTime() > Date.now() + 50000);
      assert.equal(await store.claimOutlookSubscription(pool, 1), null);
      row.LeaseToken = '11111111-1111-4111-8111-111111111111';
      const stopLost = keepOutlookLease(pool, claimed, execution, 5);
      try {
        await new Promise((resolve) => execution.signal.addEventListener('abort', resolve, { once: true }));
        assert.equal(execution.signal.reason.message, 'OUTLOOK_LEASE_LOST');
      } finally { await stopLost(); }
    } finally { await stop(); execution.close(); }
  });
});

test('hatırlatma sorgusu hata verse de Outlook kuyruğu çalışır ve uç 503 döner', async () => {
  await withOutlookStack(outlookSeed(), async ({ pool, db }) => {
    const api = await service();
    await api.addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
    const { REMINDER_SETTINGS_SQL } = await import('../src/server/reminders/reminderQueries.js');
    const originalRequest = pool.request;
    const previous = process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
    process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = 'test-scheduler-secret';
    pool.request = function () {
      const request = originalRequest.call(this);
      const query = request.query.bind(request);
      request.query = (sql) => sql === REMINDER_SETTINGS_SQL ? Promise.reject(new Error('reminder settings unavailable')) : query(sql);
      return request;
    };
    try {
      const { POST } = await import('../src/app/api/mergen-rota/reminders/run/route.js');
      const response = await POST(new Request('http://localhost/reminders/run', {
        method: 'POST', headers: { 'x-mergen-rota-reminder-key': 'test-scheduler-secret' }
      }));
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.outlook.ok, true);
      assert.equal(body.outlook.cancelled, 1);
      assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
    } finally {
      pool.request = originalRequest;
      if (previous == null) delete process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
      else process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = previous;
    }
  });
});

test('etkin Outlook şeması eksikse zamanlayıcı sağlıklı görünmez', async () => {
  await withOutlookStack(outlookSeed({ outlookSchemaMissing: true, systemAdminSicils: [OWNER] }), async () => {
    const { POST } = await import('../src/app/api/mergen-rota/reminders/run/route.js');
    const response = await POST(new Request('http://localhost/reminders/run', { method: 'POST' }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.outlook.ok, false);
    assert.equal(body.outlook.schemaReady, false);
    assert.equal(body.outlook.reason, 'OUTLOOK_SCHEMA_MISSING');
  });
});

test('belirsiz iptalden sonra açık yeniden gönderim eski sürüme dönmez', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const store = await import('../src/server/outlook/outlookStore.js');
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    db.tasks[0].TargetFinish = null;
    await store.enqueueOutlookTaskUpdate(pool, TASK_ID);
    await api.runOutlookCalendarOutbox(pool, { send: async () => ({ ok: false, code: 'SMTP_TIMEOUT', deliveryMayHaveEscaped: true }) });
    db.tasks[0].TargetFinish = '2026-09-15';
    await api.resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    assert.equal(calendarFields(mailer.sent.at(-1)).sequence, 3);
    assert.equal(calendarFields(mailer.sent.at(-1)).method, 'REQUEST');
  });
});

test('kira yenileme sorgusu takılırsa SMTP kiradan önce durdurulur', async () => {
  await withOutlookStack(outlookSeed(), async ({ pool }) => {
    const api = await service();
    const store = await import('../src/server/outlook/outlookStore.js');
    const { keepOutlookLease, outlookDeadline } = await import('../src/server/outlook/outlookExecution.js');
    await api.addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: OWNER });
    const claimed = await store.claimOutlookSubscription(pool, 1);
    const execution = outlookDeadline(1000);
    const stalled = { request: () => ({ input() {}, query: () => new Promise(() => {}) }) };
    const stop = keepOutlookLease(stalled, claimed, execution, 5);
    try {
      await new Promise((resolve) => execution.signal.addEventListener('abort', resolve, { once: true }));
      assert.equal(execution.signal.reason.message, 'OUTLOOK_LEASE_LOST');
    } finally { await stop(); execution.close(); }
  });
});

for (const [deadline, shouldCancel] of [['2026-09-15', true], ['2026-09-10', true], ['2026-09-09', false]]) {
  test(`tamamlanma ve yeniden açılma aynı UID kullanır: ${deadline}`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
      const mailer = recordingMailer();
      const now = new Date('2026-09-10T12:00:00Z');
      db.tasks[0].TargetFinish = deadline;
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send, now });
      const row = db.taskOutlookSubscriptions[0];
      const uid = row.CalendarUid;
      const before = { ...db.tasks[0] };
      db.tasks[0].Status = 'done';
      assert.equal(await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, db.tasks[0], { now }), true);
      assert.equal(row.CompletionSuspended, 1);
      const completed = await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      assert.equal(completed.ok, true);
      assert.equal(completed.cancelled, shouldCancel ? 1 : 0);
      assert.equal(mailer.sent.length, shouldCancel ? 2 : 1);
      assert.equal(row.IsActive, 1);
      assert.equal(row.CompletionSuspended, 1);
      assert.equal(row.LastCancellationReason, 'TASK_COMPLETED');
      const done = { ...db.tasks[0] };
      assert.equal(await hooks.enqueueOutlookTaskChange(pool, TASK_ID, done, db.tasks[0]), false);
      row.LastValidatedAt = new Date(0).toISOString();
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      assert.equal(mailer.sent.length, shouldCancel ? 2 : 1);
      db.tasks[0].Status = 'todo';
      await hooks.enqueueOutlookTaskChange(pool, TASK_ID, done, db.tasks[0]);
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      assert.equal(row.CompletionSuspended, 0);
      assert.equal(row.IsActive, 1);
      assert.equal(row.DeliveredMethod, 'REQUEST');
      assert.equal(row.CompletionDate, null);
      assert.equal(row.LastCancellationReason, null);
      assert.equal(calendarFields(mailer.sent.at(-1)).method, 'REQUEST');
      assert.equal(row.DeliveredSequence, shouldCancel ? 3 : 2);
      assert.equal(calendarFields(mailer.sent.at(-1)).uid, uid);
      assert.equal(calendarFields(mailer.sent.at(-1)).start, deadline.replaceAll('-', ''));
      assert.equal(new Set(mailer.sent.map((item) => calendarFields(item).uid)).size, 1);
      const count = mailer.sent.length;
      assert.equal(await hooks.enqueueOutlookTaskChange(pool, TASK_ID, db.tasks[0], db.tasks[0]), false);
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      assert.equal(mailer.sent.length, count);
    });
  });
}

test('teslim edilmeden tamamlanan görev sessiz bekletilir; yeniden açılınca ilk davet gönderilir', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
    const before = { ...db.tasks[0] };
    db.tasks[0].Status = 'done';
    await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, db.tasks[0]);
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 1);
    const done = { ...db.tasks[0] };
    db.tasks[0].Status = 'todo';
    await hooks.enqueueOutlookTaskChange(pool, TASK_ID, done, db.tasks[0]);
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 1);
    assert.equal(calendarFields(mailer.sent[0]).sequence, 1);
    assert.equal(calendarFields(mailer.sent[0]).method, 'REQUEST');
    assert.equal(db.taskOutlookSubscriptions[0].CompletionDate, null);
    assert.equal(db.taskOutlookSubscriptions[0].LastCancellationReason, null);
  });
});

test('çalışan araya girmese de tamamlanma ve açılma niyeti kalıcıdır', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T12:00:00Z') });
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    const active = { ...db.tasks[0] };
    db.tasks[0].Status = 'done';
    await hooks.enqueueOutlookTaskChange(pool, TASK_ID, active, db.tasks[0]);
    const done = { ...db.tasks[0] };
    db.tasks[0].Status = 'todo';
    await hooks.enqueueOutlookTaskChange(pool, TASK_ID, done, db.tasks[0]);
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 2);
    assert.equal(calendarFields(mailer.sent[1]).sequence, 2);
    assert.equal(calendarFields(mailer.sent[1]).method, 'REQUEST');
    assert.equal(db.taskOutlookSubscriptions[0].CompletionSuspended, 0);
    assert.equal(db.taskOutlookSubscriptions[0].CompletionDate, null);
    assert.equal(db.taskOutlookSubscriptions[0].LastCancellationReason, null);
  });
});

for (const inFlight of ['REQUEST', 'CANCEL']) {
  test(`${inFlight} sürerken tamamlanma/açılma yeni kuyruk neslini kaybetmez`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
      const mailer = recordingMailer();
      const now = new Date('2026-09-10T12:00:00Z');
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      const changeStatus = async (status) => {
        const before = { ...db.tasks[0] }; db.tasks[0].Status = status;
        await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, db.tasks[0], { now });
      };
      if (inFlight === 'CANCEL') await changeStatus('done');
      else {
        db.tasks[0].Title = 'Yeni başlık';
        await (await import('../src/server/outlook/outlookStore.js')).enqueueOutlookTaskUpdate(pool, TASK_ID);
      }
      await api.runOutlookCalendarOutbox(pool, { now, limit: 1, send: async (message) => {
        await mailer.send(message);
        await changeStatus(inFlight === 'CANCEL' ? 'todo' : 'done');
        return { ok: true };
      } });
      const row = db.taskOutlookSubscriptions[0];
      assert.ok(row.PendingMethod);
      await api.runOutlookCalendarOutbox(pool, { now, send: mailer.send });
      assert.equal(row.PendingMethod, null);
      assert.equal(row.IsActive, 1);
      assert.equal(row.CompletionSuspended, inFlight === 'CANCEL' ? 0 : 1);
      assert.deepEqual(mailer.sent.map((item) => calendarFields(item).sequence), [1, 2, 3]);
      assert.deepEqual(mailer.sent.map((item) => calendarFields(item).method), inFlight === 'CANCEL' ? ['REQUEST', 'CANCEL', 'REQUEST'] : ['REQUEST', 'REQUEST', 'CANCEL']);
      assert.equal(new Set(mailer.sent.map((item) => calendarFields(item).uid)).size, 1);
    });
  });
}

for (const action of ['remove', 'delete', 'access']) {
  test(`tamamlanmada bekletilen abonelik ${action} sonrasında otomatik açılmaz`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
      const mailer = recordingMailer();
      const now = new Date('2026-09-10T12:00:00Z');
      await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
      const before = { ...db.tasks[0] }; db.tasks[0].Status = 'done';
      await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, db.tasks[0], { now });
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      if (action === 'remove') await api.removeTaskFromOutlook(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
      if (action === 'delete') { db.tasks.splice(0, 1); await hooks.enqueueOutlookTaskRemoval(pool, TASK_ID); }
      if (action === 'access') { db.corporateProjectAccess = []; db.taskAssignees = []; db.taskOutlookSubscriptions[0].LastValidatedAt = new Date(0).toISOString(); }
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      const row = db.taskOutlookSubscriptions[0];
      assert.equal(row.IsActive, 0);
      assert.equal(row.LastCancellationReason, { remove: 'USER_REMOVED', delete: 'TASK_NOT_FOUND', access: 'FORBIDDEN' }[action]);
      const count = mailer.sent.length;
      if (action !== 'delete') {
        const done = { ...db.tasks[0] }; db.tasks[0].Status = 'todo';
        await hooks.enqueueOutlookTaskChange(pool, TASK_ID, done, db.tasks[0]);
      }
      await api.runOutlookCalendarOutbox(pool, { send: mailer.send, now });
      assert.equal(mailer.sent.length, count);
    });
  });
}

test('tamamlanan görev yeni abonelik veya yeniden davet başlatmaz', async () => {
  await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
    const api = await service();
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    db.tasks[0].Status = 'done';
    assert.equal((await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send })).code, 'TASK_COMPLETED');
    assert.equal((await api.resendTaskInvitation(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send })).code, 'TASK_COMPLETED');
    assert.equal(mailer.sent.length, 1);
  });
});

test('tekrar serisinin gerçek görev kayıtları bağımsız UID ve tüm gün termin üretir', async () => {
  const seed = outlookSeed();
  for (const task of seed.tasks) { task.RecurrenceParentTaskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; task.RecurrenceOccurrenceDate = task.TargetFinish; task.RecurrenceRule = null; task.PlannedStart = '2026-01-01'; }
  await withOutlookStack(seed, async ({ db, pool }) => {
    const api = await service();
    const mailer = recordingMailer();
    await api.addTasksToOutlook(pool, { taskIds: [TASK_ID, SECOND_TASK_ID], sicil: OWNER });
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(mailer.sent.length, 2);
    assert.equal(new Set(mailer.sent.map((item) => calendarFields(item).uid)).size, 2);
    assert.equal(db.taskOutlookSubscriptions.length, 2);
    for (const message of mailer.sent) {
      assert.match(message.calendar.content, /TRANSP:TRANSPARENT/);
      assert.match(message.calendar.content, /X-MICROSOFT-CDO-BUSYSTATUS:FREE/);
      assert.match(message.calendar.content, /DTSTART;VALUE=DATE:202609/);
      assert.doesNotMatch(message.calendar.content, /RRULE|RECURRENCE-ID|VALARM|DTSTART.*T[0-9]/);
    }
  });
});

test('gerçek görev işlemi SMTP yokken tamamlanma ve yeniden açılmayı kalıcı kuyruğa yazar', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T12:00:00Z') });
  const { createActualStack } = await import('./helpers/actualStack.mjs');
  const data = outlookSeed();
  data.projects[0].SourceType = 'MANUAL';
  data.projects[0].LeadSicil = OWNER;
  data.projectAccess = [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'FULL' }];
  const stack = await createActualStack(data, { sicil: OWNER, corporateWbsSource: false });
  const smtpHost = process.env.SMTP_HOST;
  try {
    const pool = await (await import('../src/server/db/pool.js')).getSqlPool();
    const api = await service();
    const mailer = recordingMailer();
    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
    delete process.env.SMTP_HOST;
    const task = stack.state.tasks.find((row) => row.id.toLowerCase() === TASK_ID.toLowerCase());
    await stack.repository.commitChanges({ taskUpserts: [{ ...task, status: 'done' }] });
    const row = stack.db.taskOutlookSubscriptions[0];
    const stored = stack.db.tasks.find((value) => value.TaskId === TASK_ID);
    assert.equal(stored.Status, 'done');
    assert.equal(stored.Progress, 100);
    assert.equal(stored.ActualFinish, '2026-09-10');
    assert.ok(stored.ActualStart <= stored.ActualFinish);
    assert.equal(row.CompletionSuspended, 1);
    assert.equal(row.CompletionDate, '2026-09-10');
    assert.equal(mailer.sent.length, 1);
    process.env.SMTP_HOST = smtpHost;
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.equal(row.DeliveredMethod, 'CANCEL');
    await stack.reload();
    const done = stack.state.tasks.find((value) => value.id.toLowerCase() === TASK_ID.toLowerCase());
    await stack.repository.commitChanges({ taskUpserts: [{ ...done, status: 'in_progress' }] });
    const reopened = stack.db.tasks.find((value) => value.TaskId === TASK_ID);
    assert.equal(reopened.Status, 'in-progress');
    assert.equal(reopened.ActualStart, done.actualStart);
    assert.equal(reopened.ActualFinish, null);
    assert.equal(reopened.Progress, 100);
    await api.runOutlookCalendarOutbox(pool, { send: mailer.send });
    assert.deepEqual(mailer.sent.map((message) => calendarFields(message).sequence), [1, 2, 3]);
    assert.equal(new Set(mailer.sent.map((message) => calendarFields(message).uid)).size, 1);
    assert.equal(row.CompletionSuspended, 0);
  } finally {
    if (smtpHost == null) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = smtpHost;
    await stack.dispose();
  }
});

for (const method of ['REQUEST', 'CANCEL']) {
  test(`${method} sürerken yeni tamamlanma niyeti teslim edilen eski sürümle karışmaz`, async () => {
    await withOutlookStack(outlookSeed(), async ({ db, pool }) => {
      const api = await service();
      const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
      const mailer = recordingMailer();
      const now = new Date('2026-09-10T12:00:00Z');
      const change = async (patch) => {
        const before = { ...db.tasks[0] };
        Object.assign(db.tasks[0], patch);
        await hooks.enqueueOutlookTaskChange(pool, TASK_ID, before, db.tasks[0], { now });
      };
      if (method === 'CANCEL') {
        await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send: mailer.send });
        await change({ Status: 'done' });
      } else await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, queueOnly: true });
      await api.runOutlookCalendarOutbox(pool, { now, limit: 1, send: async (message) => {
        await mailer.send(message);
        if (method === 'REQUEST') {
          await change({ Status: 'done' });
          await change({ Status: 'todo' });
        } else await change({ Title: 'Düzeltilen başlık' });
        return { ok: true };
      } });
      await api.runOutlookCalendarOutbox(pool, { now, send: mailer.send });
      assert.deepEqual(mailer.sent.map((item) => calendarFields(item).sequence), [1, 2]);
      assert.deepEqual(mailer.sent.map((item) => calendarFields(item).method), ['REQUEST', method]);
      assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);
      assert.equal(db.taskOutlookSubscriptions[0].CompletionSuspended, method === 'CANCEL' ? 1 : 0);
      assert.equal(new Set(mailer.sent.map((item) => calendarFields(item).uid)).size, 1);
    });
  });
}

test('0011 alanları eksikse Outlook şema tanısı verir ve görev kancası kaydı engellemez', async () => {
  const { outlookSchemaProblem } = await service();
  const { enqueueOutlookTaskChange } = await import('../src/server/outlook/outlookCommitHooks.js');
  for (const column of ['CompletionSuspended', 'CompletionDate', 'LastCancellationReason', 'DeliveredMethod', 'PendingDate']) {
    const error = Object.assign(new Error(`Invalid column name '${column}'.`), { number: 207 });
    assert.equal(outlookSchemaProblem(error).code, 'OUTLOOK_SCHEMA_MISSING');
    const executor = { request: () => ({ input() {}, query() { throw error; } }) };
    assert.equal(await enqueueOutlookTaskChange(executor, TASK_ID, { Status: 'todo' }, { Status: 'done' }), true);
  }
  assert.equal(outlookSchemaProblem(new Error("Invalid column name 'UnrelatedColumn'.")), null);
});
