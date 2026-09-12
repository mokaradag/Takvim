import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const { createOutlookWorker, startOutlookWorker } = await import('../src/server/outlook/outlookWorker.js');
const service = await import('../src/server/outlook/outlookCalendarService.js');
const store = await import('../src/server/outlook/outlookStore.js');
const poolApi = await import('../src/server/db/pool.js');
const { outlookFailureCode } = await import('../src/server/outlook/outlookFailure.js');
const { outlookPollIntervalMs } = await import('../src/server/outlook/outlookConfig.js');

const PROJECT = 'A1A1A1A1-1111-4111-8111-111111111111';
const TASK = 'C3C3C3C3-3333-4333-8333-333333333333';
const SECOND = 'D4D4D4D4-4444-4444-8444-444444444444';
const SICIL = 900001;

async function stack(t) {
  const env = { ...process.env };
  Object.assign(process.env, {
    MERGEN_ROTA_DB_SERVER: 'sql.test.internal', MERGEN_ROTA_DB_DATABASE: 'MERGEN_Rota',
    MERGEN_ROTA_AUTH_MODE: 'development', MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true',
    MERGEN_ROTA_DEV_SICIL: String(SICIL), SMTP_HOST: 'mail.test.internal',
    SMTP_FROM: 'rota@example.internal', MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED: 'true'
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-09-09T12:00:00Z') });
  const db = createFakeDatabase({
    people: [{ Sicil: SICIL, DisplayName: 'Test Kullanıcı', Username: 'tester' }],
    corporateUsers: [{ Name: 'tester', EmailAddress: 'tester@example.internal' }],
    projects: [{ ProjectId: PROJECT, SourceType: 'CORPORATE', ProjectCode: 'P100', ProjectName: 'Proje', IsActive: 1 }],
    corporateProjectAccess: [{ ProjectCode: 'P100', Sicil: SICIL, RoleCode: 'PROJECT_MANAGER' }],
    tasks: [TASK, SECOND].map((TaskId) => ({ TaskId, ProjectId: PROJECT, Title: 'Görev', Status: 'todo', TargetFinish: '2026-09-15' }))
  });
  poolApi.setSqlDriverForTests(createFakeSqlServerDriver(db));
  poolApi.resetSqlPoolForTests();
  const pool = await poolApi.getSqlPool();
  const workers = [];
  const sent = [];
  let available = true;
  let escaped = false;
  const send = async (message) => {
    sent.push(message);
    return available ? { ok: true } : { ok: false, code: 'SMTP_SEND_FAILED', deliveryMayHaveEscaped: escaped };
  };
  const worker = (options = {}) => {
    const value = createOutlookWorker({ run: () => service.runOutlookCalendarOutbox(pool, { send }), log() {}, ...options });
    workers.push(value);
    value.start();
    return value;
  };
  const advance = async (ms = 0) => {
    t.mock.timers.tick(ms);
    for (let index = 0; index < 100; index += 1) {
      await immediate();
      if (workers.every((value) => !value.status().running)) return;
    }
    assert.fail('Otomatik tur tamamlanmadı.');
  };
  t.after(async () => {
    await Promise.all(workers.map((value) => value.stop()));
    poolApi.setSqlDriverForTests(null);
    poolApi.resetSqlPoolForTests();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  return { db, pool, worker, sent, advance, fail(mayEscape = false) { available = false; escaped = mayEscape; }, recover() { available = true; } };
}

function fields(message) {
  const text = message.calendar.content.replace(/\r\n /g, '');
  return { uid: /\r\nUID:(.+)\r\n/.exec(text)?.[1], sequence: Number(/\r\nSEQUENCE:(\d+)\r\n/.exec(text)?.[1]), method: message.calendar.method };
}

test('hatırlatma kapalıyken yeni HTTP isteği yönetici olmadan otomatik teslim edilir', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  const reminders = await import('../src/server/reminders/reminderService.js');
  assert.equal((await reminders.runAutomaticReminders(pool)).enabled, false);
  worker();
  await advance();
  const { POST } = await import('../src/app/api/mergen-rota/tasks/[taskId]/outlook/route.js');
  const response = await POST(new Request('http://localhost/outlook', { method: 'POST' }), { params: { taskId: TASK } });
  assert.equal((await response.json()).status, 'QUEUED');
  const row = db.taskOutlookSubscriptions[0];
  assert.equal(row.AttemptCount, 0);
  assert.equal(row.PendingMethod, 'REQUEST');
  await advance(5000);
  assert.equal(sent.length, 1);
  assert.equal(row.PendingMethod, null);
  assert.equal(row.DeliveredSequence, 1);
  assert.ok(row.DeliveredPayloadHash);
  assert.equal(row.DeliveredDate, '2026-09-15');
  assert.equal(row.CalendarAttendee, 'tester@example.internal');
  assert.equal(row.CalendarOrganizer, 'rota@example.internal');
  assert.equal(row.LastFailureCode, null);
  const state = await service.loadOutlookCalendarState(pool, { sicil: SICIL });
  assert.equal(state.tasks[0].pending, false);
  assert.equal(state.tasks[0].delivered, true);
});

for (const escaped of [false, true]) {
  test(`SMTP hatası otomatik iyileşir; UID ve sürüm korunur (belirsiz teslimat: ${escaped})`, async (t) => {
    const { db, pool, worker, sent, advance, fail, recover } = await stack(t);
    await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
    fail(escaped);
    const first = worker();
    await advance();
    const row = db.taskOutlookSubscriptions[0];
    const uid = row.CalendarUid;
    assert.equal(row.PendingMethod, 'REQUEST');
    assert.equal(row.LastFailureCode, 'SMTP_SEND_FAILED');
    assert.equal(row.AttemptCount, 1);
    assert.equal(new Date(row.NextAttemptAt).getTime(), Date.now() + 60000);
    assert.equal(first.status().lastResult.failureCodes.SMTP_SEND_FAILED, 1);
    await advance(59000);
    assert.equal(sent.length, 1);
    await first.stop();
    recover();
    worker();
    await advance();
    assert.equal(sent.length, 1);
    await advance(5000);
    assert.equal(sent.length, 2);
    assert.equal(row.PendingMethod, null);
    assert.equal(row.LastFailureCode, null);
    assert.equal(row.NextAttemptAt, null);
    assert.equal(row.AttemptCount, 0);
    assert.equal(row.CalendarUid, uid);
    assert.deepEqual(fields(sent[0]), fields(sent[1]));
    assert.equal(row.DeliveredSequence, 1);
    assert.equal(new Set(sent.map((message) => fields(message).uid)).size, 1);
    await advance(300000);
    assert.equal(sent.length, 2);
  });
}

test('iki uygulama çalışanı ve tanı turu aynı toplu kuyruğu çift göndermeden işler', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  await service.addTasksToOutlook(pool, { taskIds: [TASK, SECOND, TASK], sicil: SICIL });
  const first = worker();
  first.start();
  worker();
  const manual = service.runOutlookCalendarOutbox(pool, { send: async (message) => { sent.push(message); return { ok: true }; } });
  await advance();
  await manual;
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent.map((message) => fields(message).uid)).size, 2);
  assert.ok(db.taskOutlookSubscriptions.every((row) => row.DeliveredSequence === 1 && row.PendingMethod === null));
  await advance(300000);
  assert.equal(sent.length, 2);
});

test('yeniden gönderim, görev güncellemesi ve kaldırma otomatik işlenir', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  worker();
  await advance();
  await service.resendTaskInvitation(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  await advance(5000);
  assert.deepEqual(fields(sent[0]), fields(sent[1]));
  db.tasks[0].TargetFinish = '2026-09-20';
  db.tasks[0].Title = 'Yeni başlık';
  await store.enqueueOutlookTaskUpdate(pool, TASK);
  await advance(5000);
  assert.equal(fields(sent[2]).sequence, 2);
  await service.removeTaskFromOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  await advance(5000);
  assert.equal(fields(sent[3]).method, 'CANCEL');
  assert.equal(fields(sent[3]).sequence, 3);
  assert.equal(new Set(sent.map((message) => fields(message).uid)).size, 1);
  assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);
  assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
});

for (const change of ['visibility', 'deletion']) {
  test(`${change} değişikliği yönetici olmadan aynı Outlook kaydını iptal eder`, async (t) => {
    const { db, pool, worker, sent, advance } = await stack(t);
    await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
    worker();
    await advance();
    if (change === 'visibility') db.corporateProjectAccess = [];
    else { db.tasks = []; await store.enqueueOutlookTaskCancellation(pool, TASK); }
    await advance(300000);
    assert.equal(sent.length, 2);
    assert.equal(fields(sent[1]).method, 'CANCEL');
    assert.equal(fields(sent[1]).uid, fields(sent[0]).uid);
    assert.equal(fields(sent[1]).sequence, 2);
    assert.equal(db.taskOutlookSubscriptions[0].IsActive, 0);
  });
}

test('başarısız veritabanı turu döngüyü durdurmaz; sonraki tur otomatik iyileşir', async (t) => {
  const { pool, worker, sent, advance } = await stack(t);
  await service.addTasksToOutlook(pool, { taskIds: [TASK], sicil: SICIL });
  let fail = true;
  const value = worker({ run: async () => {
    if (fail) throw Object.assign(new Error('secret connection string'), { code: 'DATABASE_UNAVAILABLE' });
    return service.runOutlookCalendarOutbox(pool, { send: async (message) => { sent.push(message); return { ok: true }; } });
  } });
  await advance();
  assert.equal(value.status().lastResult.reason, 'DATABASE_UNAVAILABLE');
  assert.equal(JSON.stringify(value.status()).includes('secret'), false);
  fail = false;
  await advance(5000);
  assert.equal(sent.length, 1);
  assert.equal(value.status().lastResult.ok, true);
});

test('uygulama çalışanı eşzamanlı tur açmaz ve durdurulduğunda yeni tur başlatmaz', async (t) => {
  const { worker, advance } = await stack(t);
  let resolve;
  let runs = 0;
  const value = worker({ run: () => { runs += 1; return new Promise((done) => { resolve = done; }); } });
  t.mock.timers.tick(0);
  await immediate();
  t.mock.timers.tick(60000);
  await immediate();
  assert.equal(runs, 1);
  resolve({ ok: true });
  await advance();
  await value.stop();
  await advance(60000);
  assert.equal(runs, 1);
});

test('Next.js başlangıç kancası süreçte bir çalışan açar; derleme ve Edge gönderim başlatmaz', async (t) => {
  await stack(t);
  const { register } = await import('../src/instrumentation.js');
  const key = Symbol.for('mergen-rota.outlook-worker');
  delete globalThis[key];
  process.env.NEXT_RUNTIME = 'nodejs';
  process.env.NEXT_PHASE = 'phase-production-build';
  await register();
  assert.equal(globalThis[key], undefined);
  process.env.NEXT_PHASE = 'phase-production-server';
  process.env.NEXT_RUNTIME = 'edge';
  await register();
  assert.equal(globalThis[key], undefined);
  process.env.NEXT_RUNTIME = 'nodejs';
  await register();
  const first = globalThis[key];
  await register();
  assert.equal(startOutlookWorker(), first);
  assert.equal(first.status().started, true);
  await first.stop();
  delete globalThis[key];
});

test('SQL ve SMTP tanıları güvenli kodlara indirgenir', () => {
  assert.equal(outlookFailureCode({ number: 1205, message: 'secret SQL' }), 'DATABASE_DEADLOCK');
  assert.equal(outlookFailureCode({ code: 'ETIMEOUT', message: 'secret SQL' }), 'DATABASE_TIMEOUT');
  assert.equal(outlookFailureCode({ code: 'EREQUEST', message: 'secret SQL' }), 'DATABASE_QUERY_FAILED');
  for (const nested of [
    { cause: { code: 'ECONNRESET' } },
    { originalError: { code: 'ESOCKET' } },
    { originalError: { info: { code: 'ECONNREFUSED' } } },
    { precedingErrors: [{ code: 'ECONNCLOSED' }] }
  ]) {
    assert.equal(outlookFailureCode({ code: 'EREQUEST', ...nested }), 'DATABASE_UNAVAILABLE');
  }
  assert.equal(outlookFailureCode({ code: 'ECANCEL' }), 'DATABASE_QUERY_FAILED');
  assert.equal(outlookFailureCode({ code: 'SMTP_AUTH_FAILED', message: 'password' }), 'SMTP_AUTH_FAILED');
  assert.equal(outlookFailureCode({ code: 'password', message: 'connection string' }), 'UNEXPECTED_ERROR');
});

test('otomatik tur aralığı geçerli ve sınırlı varsayılan kullanır', (t) => {
  const previous = process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS;
  t.after(() => { if (previous == null) delete process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS; else process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS = previous; });
  for (const input of ['', 'invalid']) {
    process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS = input;
    assert.equal(outlookPollIntervalMs(), 5000);
  }
  process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS = '0';
  assert.equal(outlookPollIntervalMs(), 1000);
  process.env.MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS = '999999999';
  assert.equal(outlookPollIntervalMs(), 60000);
});

test('SMTP kabulünden sonra kaybedilen kira teslim edilmiş diye bildirilmez ve otomatik kurtarılır', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  let loseLease = true;
  const value = worker({ run: () => service.runOutlookCalendarOutbox(pool, { send: async (message) => {
    sent.push(message);
    if (loseLease) {
      db.taskOutlookSubscriptions[0].LeaseToken = '11111111-1111-4111-8111-111111111111';
      loseLease = false;
    }
    return { ok: true };
  } }) });
  await advance();
  assert.equal(value.status().lastResult.reason, 'OUTLOOK_LEASE_LOST');
  assert.equal(value.status().lastResult.sent, 0);
  assert.equal(value.status().lastResult.failed, 1);
  assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, null);
  assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, 'REQUEST');
  await advance(60000);
  assert.equal(sent.length, 2);
  assert.deepEqual(fields(sent[0]), fields(sent[1]));
  assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, 1);
});

test('deneme eşiği aşılmış kuyruk otomatik denenmeye devam eder', async (t) => {
  const { db, pool, worker, sent, advance, fail, recover } = await stack(t);
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  db.taskOutlookSubscriptions[0].AttemptCount = 6;
  fail(true);
  const value = worker();
  await advance();
  assert.equal(value.status().lastResult.exhausted, 1);
  assert.equal(value.status().lastResult.reason, 'OUTLOOK_RETRY_EXHAUSTED');
  assert.equal(new Date(db.taskOutlookSubscriptions[0].NextAttemptAt).getTime(), Date.now() + 3600000);
  recover();
  await advance(3600000);
  assert.equal(sent.length, 2);
  assert.equal(value.status().lastResult.exhausted, 0);
  assert.equal(value.status().lastResult.ok, true);
  assert.equal(db.taskOutlookSubscriptions[0].LastFailureCode, null);
});

test('SMTP kabulünden sonra SQL sonuç yazımı kesilirse aynı revizyon otomatik tamamlanır', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  const original = pool.request.bind(pool);
  let fail = true;
  pool.request = () => {
    const request = original();
    const query = request.query.bind(request);
    request.query = (sql) => {
      if (sql.includes('SET DeliveredSequence = @sequence') && fail) {
        fail = false;
        throw Object.assign(new Error('sensitive SQL'), { code: 'EREQUEST' });
      }
      return query(sql);
    };
    return request;
  };
  const value = worker();
  await advance();
  assert.equal(value.status().lastResult.reason, 'DATABASE_QUERY_FAILED');
  assert.equal(db.taskOutlookSubscriptions[0].LastFailureCode, 'DATABASE_QUERY_FAILED');
  assert.equal(db.taskOutlookSubscriptions[0].PendingSequence, 1);
  await advance(60000);
  assert.equal(sent.length, 2);
  assert.deepEqual(fields(sent[0]), fields(sent[1]));
  assert.equal(db.taskOutlookSubscriptions[0].PendingMethod, null);
  assert.equal(db.taskOutlookSubscriptions[0].LastFailureCode, null);
});

test('alıcı dizini düzeldiğinde kuyruk yönetici eylemi olmadan teslim edilir', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  db.corporateUsers[0].EmailAddress = '';
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  const value = worker();
  await advance();
  assert.equal(value.status().lastResult.reason, 'NO_RECIPIENT_ADDRESS');
  assert.equal(db.taskOutlookSubscriptions[0].LastFailureCode, 'NO_RECIPIENT_ADDRESS');
  assert.equal(sent.length, 0);
  db.corporateUsers[0].EmailAddress = 'restored@example.internal';
  await advance(60000);
  assert.equal(sent.length, 1);
  assert.equal(db.taskOutlookSubscriptions[0].CalendarAttendee, 'restored@example.internal');
  assert.equal(db.taskOutlookSubscriptions[0].DeliveredSequence, 1);
});

test('sonuç yazımı zaman aşımında hata kaydı yeni süre sınırıyla yazılır ve aynı revizyon yeniden denenir', async (t) => {
  const { db, pool, worker, sent, advance } = await stack(t);
  await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  const original = pool.request.bind(pool);
  let stalled = false;
  let cancelled = 0;
  pool.request = () => {
    const request = original();
    const query = request.query.bind(request);
    request.query = (sql) => {
      if (sql.includes('SET DeliveredSequence = @sequence') && !stalled) {
        stalled = true;
        return new Promise(() => {});
      }
      return query(sql);
    };
    request.cancel = () => { cancelled += 1; };
    return request;
  };
  const value = worker();
  t.mock.timers.tick(0);
  for (let index = 0; index < 100 && !stalled; index += 1) await immediate();
  assert.equal(stalled, true);
  await advance(5000);
  const row = db.taskOutlookSubscriptions[0];
  assert.equal(cancelled, 1);
  assert.equal(value.status().lastResult.reason, 'OUTLOOK_RUN_TIMEOUT');
  assert.equal(value.status().lastResult.failed, 1);
  assert.equal(value.status().lastResult.sent, 0);
  assert.equal(row.LastFailureCode, 'OUTLOOK_RUN_TIMEOUT');
  assert.equal(new Date(row.NextAttemptAt).getTime(), Date.now() + 60000);
  assert.equal(row.LeaseToken, null);
  assert.equal(row.PendingSequence, 1);
  await advance(60000);
  assert.equal(sent.length, 2);
  assert.deepEqual(fields(sent[0]), fields(sent[1]));
  assert.equal(row.DeliveredSequence, 1);
  assert.equal(row.PendingMethod, null);
  assert.equal(row.LastFailureCode, null);
});

for (const outage of ['configuration', 'delivery']) {
  test(`bugünkü tamamlanma ${outage} kesintisi ve yeniden başlatma sonrasında iptal edilir`, async (t) => {
    const { db, pool, worker, sent, advance, fail, recover } = await stack(t);
    const hooks = await import('../src/server/outlook/outlookCommitHooks.js');
    db.tasks[0].TargetFinish = '2026-09-09';
    await service.addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
    const first = worker();
    await advance();
    const before = { ...db.tasks[0] };
    db.tasks[0].Status = 'done';
    await hooks.enqueueOutlookTaskChange(pool, TASK, before, db.tasks[0]);
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.CompletionDate, '2026-09-09');
    if (outage === 'configuration') delete process.env.SMTP_HOST;
    else fail(true);
    await advance(5000);
    assert.equal(first.status().lastResult.ok, false);
    await first.stop();
    await advance(86400000);
    const done = { ...db.tasks[0] };
    db.tasks[0].Title = 'Tamamlanan görevin düzeltilmiş başlığı';
    await hooks.enqueueOutlookTaskChange(pool, TASK, done, db.tasks[0]);
    assert.equal(row.CompletionDate, '2026-09-09');
    process.env.SMTP_HOST = 'mail.test.internal';
    recover();
    const restarted = worker();
    await advance();
    assert.equal(restarted.status().lastResult.cancelled, 1);
    assert.equal(row.DeliveredMethod, 'CANCEL');
    assert.equal(row.DeliveredSequence, 2);
    assert.equal(row.IsActive, 1);
    assert.equal(row.CompletionSuspended, 1);
    assert.equal(new Set(sent.map((message) => fields(message).uid)).size, 1);
    assert.ok(sent.slice(1).every((message) => fields(message).method === 'CANCEL' && fields(message).sequence === 2));
    const completed = { ...db.tasks[0] };
    db.tasks[0].Status = 'todo';
    await hooks.enqueueOutlookTaskChange(pool, TASK, completed, db.tasks[0]);
    await advance(5000);
    assert.equal(row.DeliveredMethod, 'REQUEST');
    assert.equal(row.DeliveredSequence, 3);
    assert.equal(row.CompletionDate, null);
  });
}
