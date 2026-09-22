import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

/**
 * Zil bildirimleri ve dayanıklı posta kuyruğu.
 *
 * İki değişmez sınanır:
 *   · bildirim YALNIZCA yetkili sorumlu kümesi değiştiğinde üretilir,
 *   · görev yazması SMTP'yi beklemez ve SMTP hatası işlemi bozmaz.
 */

const PROJECT_ID = '55555555-5555-4555-8555-000000000001';
const ROOT_WBS_ID = '55555555-5555-4555-8555-000000000002';
const TASK_ID = '55555555-5555-4555-8555-000000000003';
const SECOND_TASK_ID = '55555555-5555-4555-8555-000000000004';

const OWNER = 960001;
const MEMBER = 960002;
const OTHER_MEMBER = 960003;

const ORG = { Directorate: 'Yazılım Direktörlüğü', Department: 'Gömülü Müdürlüğü', Unit: 'Doğrulama Birimi' };

function seed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Kurumsal Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: OWNER, DisplayName: 'Proje Sahibi', Username: 'u960001', ...ORG },
      { Sicil: MEMBER, DisplayName: 'Ekip Üyesi', Username: 'u960002', ...ORG },
      { Sicil: OTHER_MEMBER, DisplayName: 'İkinci Üye', Username: 'u960003', ...ORG }
    ],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'BILDIRIM',
      ProjectName: 'Bildirim Projesi',
      LeadSicil: OWNER,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    // Kurumsal posta kutuları YALNIZCA okunur; teslimat turu adresi her seferinde
    // buradan çözer, görev kaydına kopyalamaz.
    corporateUsers: [
      { Name: 'u960001', EmailAddress: 'sahibi@test.internal' },
      { Name: 'u960002', EmailAddress: 'uye@test.internal' },
      { Name: 'u960003', EmailAddress: 'ikinci@test.internal' }
    ],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 0 }],
    tasks: [
      {
        TaskId: TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Entegrasyon denemesi',
        Status: 'todo',
        Priority: 'high',
        TargetFinish: '2026-10-10',
        CreatedBySicil: OWNER
      },
      {
        TaskId: SECOND_TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'İkinci görev',
        Status: 'todo',
        Priority: 'normal',
        TargetFinish: '2026-10-20',
        CreatedBySicil: OWNER
      }
    ],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: OWNER }, { TaskId: SECOND_TASK_ID, Sicil: OWNER }],
    ...overrides
  };
}

function taskOf(stack, id) {
  return stack.state.tasks.find((entry) => entry.id === id);
}

test('yeni sorumlu okunmamış zil bildirimi alır; atayan kendine bildirim almaz', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }]
    });
    const notifications = stack.db.taskNotifications;
    assert.equal(notifications.length, 1);
    assert.equal(Number(notifications[0].RecipientSicil), MEMBER);
    assert.equal(notifications[0].Kind, 'TASK_ASSIGNED');
    assert.equal(notifications[0].ReadAt, null);
    assert.equal(notifications[0].TaskTitleSnapshot, 'Entegrasyon denemesi');
    assert.equal(notifications[0].ProjectCodeSnapshot, 'BILDIRIM');
    assert.equal(Number(notifications[0].ActorSicil), OWNER);
    assert.equal(notifications[0].PrioritySnapshot, 'high');
    assert.equal(String(notifications[0].TargetFinishSnapshot).slice(0, 10), '2026-10-10');
    // Kendini atayan kişiye bildirim üretilmez.
    assert.equal(notifications.some((row) => Number(row.RecipientSicil) === OWNER), false);
  } finally { await stack.dispose(); }
});

test('ilgisiz alan düzenlemesi atama bildirimini yeniden göndermez', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }]
    });
    assert.equal(stack.db.taskNotifications.length, 1);

    await stack.reload();
    await stack.repository.commitChanges({
      taskUpserts: [{
        ...taskOf(stack, TASK_ID),
        task: 'Entegrasyon denemesi · güncellendi',
        priority: 'low',
        assigneeMutation: false
      }]
    });
    // Sorumlu kümesi DEĞİŞMEDİĞİ için ikinci bir bildirim yazılmaz.
    assert.equal(stack.db.taskNotifications.length, 1);
  } finally { await stack.dispose(); }
});

test('sorumluluk kaldırıldığında ayrı bir bildirim üretilir', async () => {
  const stack = await createActualStack(seed({
    taskAssignees: [{ TaskId: TASK_ID, Sicil: OWNER }, { TaskId: TASK_ID, Sicil: MEMBER }, { TaskId: SECOND_TASK_ID, Sicil: OWNER }]
  }), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER)], assigneeMutation: true }]
    });
    const removal = stack.db.taskNotifications.filter((row) => row.Kind === 'TASK_UNASSIGNED');
    assert.equal(removal.length, 1);
    assert.equal(Number(removal[0].RecipientSicil), MEMBER);
  } finally { await stack.dispose(); }
});

test('toplu atamada kişi başına TEK bildirim üretilir ve tekrar yazma kopya oluşturmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [
        { ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true },
        { ...taskOf(stack, SECOND_TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }
      ]
    });
    const assigned = stack.db.taskNotifications.filter((row) => row.Kind === 'TASK_ASSIGNED');
    assert.equal(assigned.length, 1, 'iki görev tek bildirimde toplanmalıdır');
    assert.equal(assigned[0].TaskCount, 2);
    assert.equal(Number(assigned[0].RecipientSicil), MEMBER);
  } finally { await stack.dispose(); }
});

test('bildirim okundu/temizlendi işareti kişiye özeldir ve etkisizdir', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }]
    });
    const notification = stack.db.taskNotifications[0];

    const { markNotifications } = await import('../src/server/notifications/notificationInboxQueries.js');
    const previous = process.env.MERGEN_ROTA_DEV_SICIL;
    process.env.MERGEN_ROTA_DEV_SICIL = String(OTHER_MEMBER);
    try {
      // Başkasının bildirimi başka bir kullanıcının işlemiyle DEĞİŞMEZ.
      await markNotifications({
        action: 'read',
        notifications: [{ id: notification.NotificationId.toLowerCase(), source: 'TASK_EVENT' }]
      });
      assert.equal(stack.db.taskNotifications[0].ReadAt, null);

      process.env.MERGEN_ROTA_DEV_SICIL = String(MEMBER);
      await markNotifications({
        action: 'read',
        notifications: [{ id: notification.NotificationId.toLowerCase(), source: 'TASK_EVENT' }]
      });
      const readAt = stack.db.taskNotifications[0].ReadAt;
      assert.ok(readAt, 'bildirim okundu işaretlenmelidir');

      // İşaretleme tek yönlüdür: gecikmiş ikinci işlem damgayı geri almaz.
      await markNotifications({
        action: 'dismiss',
        notifications: [{ id: notification.NotificationId.toLowerCase(), source: 'TASK_EVENT' }]
      });
      assert.equal(stack.db.taskNotifications[0].ReadAt, readAt);
      assert.ok(stack.db.taskNotifications[0].DismissedAt);
    } finally { process.env.MERGEN_ROTA_DEV_SICIL = previous; }
  } finally { await stack.dispose(); }
});

test('bildirim işaretleme bilinmeyen veya yanlış uç kaynağını reddeder', async () => {
  const { markNotifications } = await import('../src/server/notifications/notificationInboxQueries.js');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const source of [undefined, 'BILINMEYEN', 'SCHEDULE_REQUEST']) {
    await assert.rejects(
      markNotifications({ action: 'read', notifications: [{ id, source }] }),
      (error) => error.code === 'MUTATION_FAILED' && error.status === 400
        && error.message === 'Bildirim kaynağı geçersiz.'
    );
  }
});

test('zil bildirimi görev erişimi VERMEZ; görev yalnızca yetkili yolla açılır', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }]
    });
  } finally { await stack.dispose(); }

  // Bildirimi olmayan üçüncü kişi görevi anlık görüntüde göremez.
  const outsider = await createActualStack(seed(), { sicil: OTHER_MEMBER, corporateWbsSource: false });
  try {
    assert.equal(outsider.state.tasks.some((task) => task.id === TASK_ID), false);
  } finally { await outsider.dispose(); }
});

/* ── Dayanıklı posta kuyruğu ─────────────────────────────────── */

test('e-posta seçeneği varsayılan KAPALIDIR ve niyet yazmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }]
    });
    assert.equal(stack.db.taskMailOutbox.length, 0);
  } finally { await stack.dispose(); }
});

test('seçenek açıkken tam olarak bir dayanıklı posta niyeti yazılır; kendine posta gitmez', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    assert.equal(stack.db.taskMailOutbox.length, 1);
    const intent = stack.db.taskMailOutbox[0];
    assert.equal(Number(intent.RecipientSicil), MEMBER);
    assert.equal(intent.Status, 'PENDING');
    assert.equal(intent.Kind, 'TASK_ASSIGNMENT');
    const payload = JSON.parse(intent.PayloadJson);
    assert.equal(payload.kind, 'TASK_ASSIGNED');
    assert.equal(payload.taskTitle, 'Entegrasyon denemesi');
    assert.equal(payload.projectCode, 'BILDIRIM');
    assert.equal(payload.priority, 'high');
    assert.equal(payload.targetFinish, '2026-10-10');
    assert.equal(payload.actorName, 'Proje Sahibi');
    // Atayan kişiye posta niyeti üretilmez.
    assert.equal(stack.db.taskMailOutbox.some((row) => Number(row.RecipientSicil) === OWNER), false);
  } finally { await stack.dispose(); }
});

test('görev yazması SMTP çağırmaz; tekilleştirme anahtarı kopya niyeti engeller', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    const statementStart = stack.db.statements.length;
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    // Kuyruğa yazma görev işlemiyle AYNI işlemdedir; teslimat yoktur.
    const statements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);
    assert.equal(statements.some((sql) => sql.includes('INSERT dbo.MR_TaskMailOutbox(')), true);
    assert.equal(stack.db.taskMailOutbox.length, 1);

    const { enqueueTaskAssignmentMail } = await import('../src/server/notifications/taskMailOutbox.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const pool = await getSqlPool();
    const key = stack.db.taskMailOutbox[0].DedupeKey;
    const correlationId = key.slice(0, key.indexOf(':'));
    const written = await enqueueTaskAssignmentMail(pool, {
      correlationId,
      entries: [{ taskId: TASK_ID, recipientSicil: MEMBER, payload: { kind: 'TASK_ASSIGNED' } }]
    });
    assert.equal(written, 0, 'aynı olay iki kez kuyruğa yazılmamalıdır');
    assert.equal(stack.db.taskMailOutbox.length, 1);
  } finally { await stack.dispose(); }
});

test('SMTP kullanılamazken görev kaydı tamamlanır ve niyet kuyrukta kalır', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  const previousHost = process.env.SMTP_HOST;
  const previousFrom = process.env.SMTP_FROM;
  try {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    const committed = await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    assert.equal(committed.taskUpserts.length, 1);
    assert.equal(stack.db.taskMailOutbox.length, 1);

    // SMTP yapılandırılmamışken tur kuyruğa DOKUNMAZ: niyet korunur.
    const { runTaskMailOutbox } = await import('../src/server/notifications/taskMailService.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const outcome = await runTaskMailOutbox(await getSqlPool());
    assert.deepEqual(outcome, { ok: true, enabled: false, sent: 0, failed: 0 });
    assert.equal(stack.db.taskMailOutbox[0].Status, 'PENDING');
  } finally {
    if (previousHost == null) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = previousHost;
    if (previousFrom == null) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = previousFrom;
    await stack.dispose();
  }
});

test('kuyruk künyesi yönetim konsoluna sayar; alıcı adresi ve gövde TAŞINMAZ', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    const { taskMailQueueStatus, TASK_MAIL_MAX_ATTEMPTS } = await import('../src/server/notifications/taskMailOutbox.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const status = await taskMailQueueStatus(await getSqlPool());
    assert.equal(status.pending, 1);
    assert.equal(status.failed, 0);
    assert.equal(status.sent, 0);
    assert.equal(status.maxAttempts, TASK_MAIL_MAX_ATTEMPTS);
    // Künye YALNIZCA sayılardan ve zaman damgalarından oluşur.
    assert.deepEqual(
      Object.keys(status).sort(),
      ['failed', 'lastSentAt', 'maxAttempts', 'nextAttemptAt', 'pending', 'sent']
    );
    const serialized = JSON.stringify(status);
    assert.equal(/@|Entegrasyon denemesi|u9600/.test(serialized), false);
  } finally { await stack.dispose(); }
});

test('posta içeriği kaçırılarak üretilir ve görev künyesini taşır', async () => {
  const { buildTaskAssignmentMail } = await import('../src/domain/notifications/taskAssignmentMail.js');
  const message = buildTaskAssignmentMail({
    kind: 'TASK_ASSIGNED',
    taskTitle: '<script>alert(1)</script> Kurulum',
    projectCode: 'P1',
    projectName: 'Proje',
    actorName: 'Atayan Kişi',
    priority: 'high',
    targetFinish: '2026-10-10',
    changeSummary: 'Göreve sorumlu olarak eklendiniz.',
    link: 'https://rota.example/rota/'
  });
  assert.match(message.subject, /Size görev atandı/);
  assert.equal(message.html.includes('<script>'), false);
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.html, /10\.10\.2026/);
  assert.match(message.html, /https:\/\/rota\.example\/rota\//);
  assert.match(message.text, /Atayan: Atayan Kişi/);

  // Güvenilmeyen bağlantı şeması hiç yazılmaz.
  const unsafe = buildTaskAssignmentMail({ kind: 'TASK_ASSIGNED', taskTitle: 'X', link: 'javascript:alert(1)' });
  assert.equal(unsafe.html.includes('javascript:'), false);
});

test('toplama kuralı kendine atamayı eler ve alıcı başına tek satır üretir', async () => {
  const { aggregateAssignmentNotifications, assigneeSetDelta } = await import('../src/server/notifications/taskNotificationStore.js');
  const delta = assigneeSetDelta([1, 2], [2, 3]);
  assert.deepEqual(delta, { added: [3], removed: [1] });

  const aggregated = aggregateAssignmentNotifications([
    { taskId: 't1', added: [10, 20], removed: [], task: { title: 'A' } },
    { taskId: 't2', added: [10], removed: [30], task: { title: 'B' } }
  ], 20);
  assert.deepEqual(aggregated.map((entry) => [entry.recipientSicil, entry.kind, entry.taskCount]), [
    [10, 'TASK_ASSIGNED', 2],
    [30, 'TASK_UNASSIGNED', 1]
  ]);
});

/* ── Teslimat turu · kira, sahiplik ve belirsiz teslimat ────────── */

/** Teslimat turu ancak SMTP yapılandırıldığında çalışır. */
function withSmtp(t) {
  const previous = { SMTP_HOST: process.env.SMTP_HOST, SMTP_FROM: process.env.SMTP_FROM };
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'rota@test.internal';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('yoklama aralığı tanımsız ya da boş değişkende belgelenen varsayılana düşer', async () => {
  const { taskMailPollIntervalMs } = await import('../src/server/notifications/taskMailWorker.js');
  const previous = process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS;
  try {
    // Boş metin `Number('')` ile 0'a düşüyor, alt sınır kuralı da aralığı
    // 5 saniyeye çekiyordu: belgelenen 30 saniye hiç uygulanmıyordu.
    for (const value of [undefined, '', '   ', 'otuz', '0', '-5']) {
      if (value === undefined) delete process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS;
      else process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS = value;
      assert.equal(taskMailPollIntervalMs(), 30000, String(value));
    }
    process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS = '45000';
    assert.equal(taskMailPollIntervalMs(), 45000);
    // Sınırlar korunur.
    process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS = '1000';
    assert.equal(taskMailPollIntervalMs(), 5000);
    process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS = '999999';
    assert.equal(taskMailPollIntervalMs(), 300000);
  } finally {
    if (previous == null) delete process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS;
    else process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS = previous;
  }
});

test('kira, partinin tamamı SMTP zaman aşımına takılsa bile geçerli kalır', async () => {
  const { taskMailBatchSize, taskMailLeaseSeconds } = await import('../src/server/notifications/taskMailOutbox.js');
  // Sabit 120 saniyelik kira, 20 satırlık partiyi 300 saniyelik zaman aşımıyla
  // taşıyamıyordu. Parti kiranın taşıyabileceği kadar daraltılır ve kira
  // partinin en kötü durumunu kapsar.
  for (const [limit, timeoutMs] of [[20, 300000], [20, 20000], [20, 60000], [1, 300000], [100, 20000]]) {
    const batch = taskMailBatchSize(limit, timeoutMs);
    assert.ok(batch >= 1 && batch <= limit, `parti boyu ${batch}`);
    assert.ok(
      taskMailLeaseSeconds(batch, timeoutMs) >= batch * Math.ceil(timeoutMs / 1000),
      `kira ${limit}/${timeoutMs} için partiyi kapsamalıdır`
    );
  }
  // Alt sınır korunur; üst sınır sınırsız büyümeyi engeller.
  assert.equal(taskMailLeaseSeconds(1, 1000), 120);
  assert.equal(taskMailLeaseSeconds(100, 300000), 3600);
});

test('teslimatı BELİRSİZ kalan satır yeniden gönderilmez ve kuyrukta kalır', async (t) => {
  withSmtp(t);
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    assert.equal(stack.db.taskMailOutbox.length, 1);

    const { runTaskMailOutbox } = await import('../src/server/notifications/taskMailService.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const pool = await getSqlPool();

    let attempts = 0;
    const outcome = await runTaskMailOutbox(pool, {
      send: async () => {
        attempts += 1;
        // Gövde aktarıldı, kabul yanıtı okunamadı: posta sunucusu iletiyi
        // KABUL ETMİŞ olabilir.
        return { ok: false, code: 'SMTP_TIMEOUT', deliveryMayHaveEscaped: true };
      }
    });
    assert.equal(attempts, 1);
    assert.equal(outcome.uncertain, 1);
    assert.equal(outcome.ok, false);

    const row = stack.db.taskMailOutbox[0];
    assert.equal(row.Status, 'FAILED', 'belirsiz teslimat yeniden deneme yoluna DÖNMEZ');
    assert.equal(row.LastFailureCode, 'MAIL_DELIVERY_UNCERTAIN');

    // Sonraki tur aynı iletiyi ikinci kez göndermez.
    const second = await runTaskMailOutbox(pool, { send: async () => { attempts += 1; return { ok: true }; } });
    assert.equal(attempts, 1);
    assert.equal(second.claimed, 0);
  } finally { await stack.dispose(); }
});

test('kesin başarısızlık geri çekilmeyle yeniden denenir', async (t) => {
  withSmtp(t);
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    const { runTaskMailOutbox } = await import('../src/server/notifications/taskMailService.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const outcome = await runTaskMailOutbox(await getSqlPool(), {
      send: async () => ({ ok: false, code: 'SMTP_SEND_FAILED', deliveryMayHaveEscaped: false })
    });
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.uncertain, 0);
    assert.equal(stack.db.taskMailOutbox[0].Status, 'PENDING');
    assert.equal(stack.db.taskMailOutbox[0].LastFailureCode, 'SMTP_SEND_FAILED');
  } finally { await stack.dispose(); }
});

test('kira SAHİPLİĞİ: devralınan satırın durumunu eski tur ezemez', async () => {
  const stack = await createActualStack(seed(), { sicil: OWNER, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges(
      { taskUpserts: [{ ...taskOf(stack, TASK_ID), assigneeIds: [String(OWNER), String(MEMBER)], assigneeMutation: true }] },
      { notifyAssignees: true }
    );
    const outbox = await import('../src/server/notifications/taskMailOutbox.js');
    const { getSqlPool } = await import('../src/server/db/pool.js');
    const pool = await getSqlPool();

    const [firstClaim] = await outbox.claimDueTaskMail(pool, 20);
    assert.ok(firstClaim.leaseToken, 'kiralama sahiplik belirteci taşımalıdır');

    // Kira dolar ve satırı başka bir uygulama örneği devralır.
    stack.db.taskMailOutbox[0].LeaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    const [secondClaim] = await outbox.claimDueTaskMail(pool, 20);
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);

    // Geciken ilk tur artık satıra DOKUNAMAZ.
    await outbox.markTaskMailSent(pool, firstClaim.mailId, firstClaim.leaseToken);
    assert.equal(stack.db.taskMailOutbox[0].Status, 'PENDING');

    // Kirayı elinde tutan tur yazabilir.
    await outbox.markTaskMailSent(pool, secondClaim.mailId, secondClaim.leaseToken);
    assert.equal(stack.db.taskMailOutbox[0].Status, 'SENT');
  } finally { await stack.dispose(); }
});
