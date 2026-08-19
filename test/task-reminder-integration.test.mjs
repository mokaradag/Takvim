/**
 * Hatırlatma gönderiminin uçtan uca davranışı.
 *
 * Zincir gerçek kodla kurulur: hatırlatma hizmeti → kalıcı katman → bellek içi
 * SQL Server ikizi. Yalnızca SMTP taşıması enjekte edilir (gerçek bir posta
 * sunucusu gerektirmemek için); alıcı çözümü, şablon üretimi, aralık
 * sahiplenmesi ve gönderim geçmişi gerçek koddur.
 *
 * Sınanan davranışlar:
 *   - elle gönderim otomatik ayardan bağımsız çalışır,
 *   - alıcı çözülemediğinde "gönderildi" DENMEZ ve neden açıklanır,
 *   - zamanlayıcı defalarca çalışsa da aynı aralıkta ikinci ileti gitmez,
 *   - gönderim geçmişi KALICIDIR: uygulama yeniden başlasa bile kopya oluşmaz,
 *   - tek bir görevin hatası ötekileri engellemez,
 *   - tamamlanan/silinen görev ve termin sonrası gönderim durur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const ROOT_WBS_ID = 'B2B2B2B2-2222-4222-8222-222222222222';
const TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const SECOND_TASK_ID = 'D4D4D4D4-4444-4444-8444-444444444444';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';

function reminderSeed(overrides = {}) {
  return {
    calendars: [{ CalendarId: CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: 900001, DisplayName: 'Ayşe Yılmaz', Username: 'ayilmaz' },
      { Sicil: 900002, DisplayName: 'Mehmet Demir', Username: 'mdemir' },
      { Sicil: 900003, DisplayName: 'Adressiz Kişi', Username: 'adressiz' }
    ],
    corporateUsers: [
      { Name: 'ayilmaz', EmailAddress: 'ayse.yilmaz@example.internal' },
      { Name: 'mdemir', EmailAddress: 'mehmet.demir@example.internal' },
      // Kullanıcı kaydı var, adresi YOK.
      { Name: 'adressiz', EmailAddress: '' }
    ],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'CORPORATE',
      ProjectCode: 'P4417041',
      ProjectName: 'İHA Projesi',
      CalendarId: CALENDAR_ID,
      IsActive: 1
    }],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P4417041', Name: 'Kök' }],
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      WbsId: ROOT_WBS_ID,
      Title: 'Teklif dosyasının hazırlanması',
      Keyword: 'Teklif',
      Status: 'in-progress',
      Priority: 'high',
      TargetFinish: '2026-08-20'
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: 900001 }],
    reminderSettings: {
      AutomaticEnabled: 1,
      WindowValue: 7,
      WindowUnit: 'day',
      FrequencyValue: 2,
      FrequencyUnit: 'day',
      SubjectTemplate: 'Hatırlatma: {{task_name}} ({{remaining_duration}})',
      BodyTemplate: '<p>{{assignees}} · {{due_date}} · {{remaining_days}} gün</p>',
      UpdatedAt: '2026-08-01T00:00:00.000Z',
      UpdatedBySicil: 900001
    },
    ...overrides
  };
}

/** Gönderilen iletileri toplayan sahte posta taşıması. */
function recordingMailer({ failWith = null, failFor = null } = {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      if (failFor && failFor(message)) {
        return { ok: false, code: 'SMTP_SEND_FAILED', message: 'E-posta gönderilemedi.' };
      }
      if (failWith) return { ok: false, code: failWith, message: 'E-posta gönderilemedi.' };
      sent.push(message);
      return { ok: true, accepted: message.to, messageId: `id-${sent.length}` };
    }
  };
}

async function withReminderStack(seed, run, { sicil = 900001 } = {}) {
  registerServerOnlyShim();
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  // Kimlik: yerel geliştirme sağlayıcısı. Rota gövdeleri yetkiyi bu Sicil
  // üzerinden yeniden hesaplar.
  process.env.MERGEN_ROTA_AUTH_MODE = 'development';
  process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED = 'true';
  process.env.MERGEN_ROTA_DEV_SICIL = String(sicil);

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

function at(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0);
}

/* ── Elle gönderim ──────────────────────────────────────────────── */

test('elle gönderim sorumluların DC01_userr adreslerine ulaşır', async () => {
  await withReminderStack(reminderSeed({
    taskAssignees: [{ TaskId: TASK_ID, Sicil: 900001 }, { TaskId: TASK_ID, Sicil: 900002 }]
  }), async ({ db, pool }) => {
    const { sendManualReminder } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const result = await sendManualReminder(pool, {
      taskId: TASK_ID,
      actorSicil: 900001,
      now: at(2026, 8, 17),
      send: mailer.send
    });

    assert.equal(result.ok, true);
    assert.equal(result.recipientCount, 2);
    assert.deepEqual(mailer.sent[0].to, ['ayse.yilmaz@example.internal', 'mehmet.demir@example.internal']);
    assert.match(mailer.sent[0].subject, /Teklif dosyasının hazırlanması/);
    // Kalan süre gönderim anında hesaplanır.
    assert.match(mailer.sent[0].subject, /3 gün kaldı/);
    // Kalıcı kayıt yazılır ve alıcılar MASKELENİR.
    const log = db.taskReminderLog.at(-1);
    assert.equal(log.ReminderKind, 'MANUAL');
    assert.equal(log.Status, 'SENT');
    assert.equal(log.RecipientCount, 2);
    assert.equal(log.RecipientDigest.includes('ayse.yilmaz'), false);
    assert.match(log.RecipientDigest, /a\*\*\*@example\.internal/);
  });
});

test('elle gönderim otomatik hatırlatma KAPALIYKEN de çalışır', async () => {
  const seed = reminderSeed();
  seed.reminderSettings.AutomaticEnabled = 0;
  await withReminderStack(seed, async ({ pool }) => {
    const { sendManualReminder } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const result = await sendManualReminder(pool, { taskId: TASK_ID, actorSicil: 900001, send: mailer.send });
    assert.equal(result.ok, true);
    assert.equal(mailer.sent.length, 1);
  });
});

test('adresi çözülemeyen görevde gönderim YAPILMAZ ve neden açıklanır', async () => {
  await withReminderStack(reminderSeed({
    taskAssignees: [{ TaskId: TASK_ID, Sicil: 900003 }]
  }), async ({ db, pool }) => {
    const { sendManualReminder } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const result = await sendManualReminder(pool, { taskId: TASK_ID, actorSicil: 900001, send: mailer.send });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_RECIPIENTS');
    assert.match(result.message, /e-posta adresi yok/);
    assert.equal(mailer.sent.length, 0);
    assert.equal(db.taskReminderLog.at(-1).Status, 'FAILED');
    assert.equal(db.taskReminderLog.at(-1).FailureCode, 'NO_RECIPIENTS');
  });
});

test('SMTP hatası "gönderildi" olarak raporlanmaz', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { sendManualReminder } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer({ failWith: 'SMTP_AUTH_FAILED' });
    const result = await sendManualReminder(pool, { taskId: TASK_ID, actorSicil: 900001, send: mailer.send });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SMTP_AUTH_FAILED');
    assert.equal(db.taskReminderLog.at(-1).Status, 'FAILED');
    assert.equal(db.taskReminderLog.at(-1).FailureCode, 'SMTP_AUTH_FAILED');
  });
});

test('bulunamayan görev için gönderim denenmez', async () => {
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { sendManualReminder } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const result = await sendManualReminder(pool, {
      taskId: 'FFFFFFFF-0000-4000-8000-000000000000',
      actorSicil: 900001,
      send: mailer.send
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TASK_NOT_FOUND');
    assert.equal(mailer.sent.length, 0);
  });
});

/* ── Otomatik tur ───────────────────────────────────────────────── */

test('otomatik tur kapalıyken hiçbir ileti göndermez', async () => {
  const seed = reminderSeed();
  seed.reminderSettings.AutomaticEnabled = 0;
  await withReminderStack(seed, async ({ pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const summary = await runAutomaticReminders(pool, { now: at(2026, 8, 15), send: mailer.send });
    assert.equal(summary.enabled, false);
    assert.equal(summary.sent, 0);
    assert.equal(mailer.sent.length, 0);
  });
});

test('zamanlayıcı defalarca çalışsa da aynı aralıkta ikinci ileti gitmez', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();

    // Saatte bir çalışan zamanlayıcı: aynı gün içinde beş tur.
    for (const hour of [0, 4, 8, 13, 22]) {
      await runAutomaticReminders(pool, { now: at(2026, 8, 15, hour), send: mailer.send });
    }
    assert.equal(mailer.sent.length, 1, 'aynı aralık için tek ileti gönderilmelidir');

    // Bir sonraki aralık (2 günde bir) yeni bir ileti üretir.
    await runAutomaticReminders(pool, { now: at(2026, 8, 17, 9), send: mailer.send });
    assert.equal(mailer.sent.length, 2);

    // Kalıcı geçmiş iki SAHİPLENİLMİŞ aralık taşır.
    const automatic = db.taskReminderLog.filter((entry) => entry.ReminderKind === 'AUTOMATIC');
    assert.equal(automatic.length, 2);
    assert.equal(new Set(automatic.map((entry) => entry.SlotKey)).size, 2);
  });
});

test('uygulama yeniden başlasa da geçmiş korunur ve kopya gönderilmez', async () => {
  const seed = reminderSeed();
  await withReminderStack(seed, async ({ db, pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    await runAutomaticReminders(pool, { now: at(2026, 8, 15, 9), send: mailer.send });
    assert.equal(mailer.sent.length, 1);

    // Yeniden başlatma taklidi: yeni bir uygulama örneği, AYNI veritabanı.
    const persistedLog = db.taskReminderLog.map((entry) => ({ ...entry }));
    await withReminderStack({ ...seed, taskReminderLog: persistedLog }, async ({ pool: restartedPool }) => {
      const restartedMailer = recordingMailer();
      const summary = await runAutomaticReminders(restartedPool, { now: at(2026, 8, 15, 18), send: restartedMailer.send });
      assert.equal(restartedMailer.sent.length, 0, 'yeniden başlatma kopya ileti üretmemelidir');
      assert.equal(summary.skipped, 1);
      assert.equal(summary.results[0].reason, 'ALREADY_SENT');
    });
  });
});

test('pencere dışındaki görev turda atlanır, pencereye girince gönderilir', async () => {
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();

    // Termine 12 gün: aday sorgusu bile getirmez.
    const early = await runAutomaticReminders(pool, { now: at(2026, 8, 8), send: mailer.send });
    assert.equal(early.sent, 0);
    assert.equal(mailer.sent.length, 0);

    // Pencereye girdiği gün gönderilir.
    const inWindow = await runAutomaticReminders(pool, { now: at(2026, 8, 13, 0), send: mailer.send });
    assert.equal(inWindow.sent, 1);
  });
});

test('tamamlanan görev sonraki hatırlatmayı almaz', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    await runAutomaticReminders(pool, { now: at(2026, 8, 15, 9), send: mailer.send });
    assert.equal(mailer.sent.length, 1);

    // Görev tamamlandı: bir sonraki aralıkta ileti gitmez.
    db.tasks[0].Status = 'done';
    const summary = await runAutomaticReminders(pool, { now: at(2026, 8, 17, 9), send: mailer.send });
    assert.equal(summary.sent, 0);
    assert.equal(mailer.sent.length, 1);
  });
});

test('silinen görev turu düşürmez', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    db.tasks.length = 0;
    const summary = await runAutomaticReminders(pool, { now: at(2026, 8, 15), send: mailer.send });
    assert.equal(summary.ok, true);
    assert.equal(summary.evaluated, 0);
    assert.equal(mailer.sent.length, 0);
  });
});

test('termin gününden sonra otomatik hatırlatma durur', async () => {
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    const summary = await runAutomaticReminders(pool, { now: at(2026, 8, 22), send: mailer.send });
    assert.equal(summary.sent, 0);
    assert.equal(mailer.sent.length, 0);
  });
});

test('bir görevin gönderim hatası ötekileri engellemez', async () => {
  const seed = reminderSeed();
  seed.tasks.push({
    TaskId: SECOND_TASK_ID,
    ProjectId: PROJECT_ID,
    WbsId: ROOT_WBS_ID,
    Title: 'İkinci görev',
    Status: 'planned',
    Priority: 'medium',
    TargetFinish: '2026-08-19'
  });
  seed.taskAssignees.push({ TaskId: SECOND_TASK_ID, Sicil: 900002 });

  await withReminderStack(seed, async ({ pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    // İlk görevin alıcısı için gönderim başarısız olur.
    const mailer = recordingMailer({ failFor: (message) => message.to.includes('ayse.yilmaz@example.internal') });
    const summary = await runAutomaticReminders(pool, { now: at(2026, 8, 15, 9), send: mailer.send });

    assert.equal(summary.failed, 1);
    assert.equal(summary.sent, 1);
    assert.deepEqual(mailer.sent.map((message) => message.to), [['mehmet.demir@example.internal']]);
  });
});

test('yönetici sıklığı değiştirince yeni aralık dizisi başlar', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { runAutomaticReminders } = await import('../src/server/reminders/reminderService.js');
    const mailer = recordingMailer();
    await runAutomaticReminders(pool, { now: at(2026, 8, 15, 9), send: mailer.send });
    assert.equal(mailer.sent.length, 1);

    // Aynı an, DEĞİŞTİRİLMİŞ sıklık: yeni anahtar üretilir ve gönderim yapılır.
    db.reminderSettings.FrequencyValue = 1;
    await runAutomaticReminders(pool, { now: at(2026, 8, 15, 10), send: mailer.send });
    assert.equal(mailer.sent.length, 2);
  });
});

test('yapılandırma kaydedilirken şablon temizlenir', async () => {
  await withReminderStack(reminderSeed(), async ({ db, pool }) => {
    const { loadReminderSettings, saveReminderSettings } = await import('../src/server/reminders/reminderStore.js');
    await saveReminderSettings(pool, 900001, {
      automaticEnabled: true,
      windowValue: 5,
      windowUnit: 'day',
      frequencyValue: 1,
      frequencyUnit: 'day',
      subject: 'Konu\r\nBcc: kotu@example.internal',
      body: '<p onclick="x()">Gövde</p><script>evil()</script>'
    });

    const stored = await loadReminderSettings(pool);
    assert.equal(stored.windowValue, 5);
    // Konu satırına satır sonu enjekte edilemez.
    assert.equal(stored.subject.includes('\n'), false);
    // Gövdedeki betik ve olay işleyicisi kalıcı kayda GİRMEZ.
    assert.equal(db.reminderSettings.BodyTemplate.includes('script'), false);
    assert.equal(db.reminderSettings.BodyTemplate.includes('onclick'), false);
    assert.equal(stored.body, '<p>Gövde</p>');
  });
});

test('hatırlatma tabloları yokken uygulama varsayılanla sürer', async () => {
  await withReminderStack(reminderSeed({ reminderSchemaMissing: true }), async ({ pool }) => {
    const { loadReminderSettings, loadReminderHistory } = await import('../src/server/reminders/reminderStore.js');
    const settings = await loadReminderSettings(pool);
    assert.equal(settings.schemaReady, false);
    assert.equal(settings.automaticEnabled, false);
    assert.match(settings.subject, /Görev hatırlatması/);
    assert.deepEqual(await loadReminderHistory(pool), []);
  });
});

/* ── Uç yetkilendirmesi ─────────────────────────────────────────── */

test('göremediği görev için hatırlatma gönderilemez', async () => {
  // 900002 görevin sorumlusu değildir, projeye kurumsal erişimi de yoktur.
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { assertTaskReminderAccess } = await import('../src/server/reminders/reminderAccess.js');
    const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
    const actor = await loadAuthorizationContext(pool);
    await assert.rejects(
      assertTaskReminderAccess(pool, actor, TASK_ID),
      /hatırlatma gönderme yetkiniz yok/
    );
  }, { sicil: 900002 });
});

test('görevin sorumlusu kendi görevine hatırlatma gönderebilir', async () => {
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { assertTaskReminderAccess } = await import('../src/server/reminders/reminderAccess.js');
    const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
    const actor = await loadAuthorizationContext(pool);
    await assert.doesNotReject(assertTaskReminderAccess(pool, actor, TASK_ID));
  }, { sicil: 900001 });
});

test('yönetici, astına atanmış görev için hatırlatma gönderebilir', async () => {
  const seed = reminderSeed({ executiveScope: [{ ManagerSicil: 900002, EmployeeSicil: 900001, ScopeType: 'UNIT' }] });
  await withReminderStack(seed, async ({ pool }) => {
    const { assertTaskReminderAccess } = await import('../src/server/reminders/reminderAccess.js');
    const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
    const actor = await loadAuthorizationContext(pool);
    await assert.doesNotReject(assertTaskReminderAccess(pool, actor, TASK_ID));
  }, { sicil: 900002 });
});

test('yapılandırma ucu sistem yöneticisi olmayana kapalıdır', async () => {
  await withReminderStack(reminderSeed(), async ({ pool }) => {
    const { assertReminderAdmin } = await import('../src/server/reminders/reminderAccess.js');
    const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
    const actor = await loadAuthorizationContext(pool);
    assert.equal(actor.isSystemAdmin, false);
    assert.throws(() => assertReminderAdmin(actor), /yalnızca sistem yöneticileri/);
    // Sistem yöneticisi için geçer.
    assert.doesNotThrow(() => assertReminderAdmin({ ...actor, isSystemAdmin: true }));
  }, { sicil: 900001 });
});

test('zamanlayıcı anahtarı yapılandırılmadan kimliksiz erişim açılmaz', async () => {
  const { hasReminderSchedulerKey } = await import('../src/server/reminders/reminderAccess.js');
  const previous = process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
  try {
    delete process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
    assert.equal(hasReminderSchedulerKey({ headers: new Headers({ 'x-mergen-rota-reminder-key': 'x' }) }), false);

    process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = 'dogru-anahtar';
    assert.equal(hasReminderSchedulerKey({ headers: new Headers({ 'x-mergen-rota-reminder-key': 'yanlis' }) }), false);
    assert.equal(hasReminderSchedulerKey({ headers: new Headers({ 'x-mergen-rota-reminder-key': 'dogru-anahtar' }) }), true);
    // Başlık hiç gönderilmediğinde de kapalıdır.
    assert.equal(hasReminderSchedulerKey({ headers: new Headers() }), false);
  } finally {
    if (previous === undefined) delete process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
    else process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = previous;
  }
});
