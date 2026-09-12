import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setImmediate as immediate } from 'node:timers/promises';
import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { requestJson } from '../src/features/shared/jsonRequest.js';
import { deliveryRunMessage } from '../src/features/reminders/deliveryRunPresentation.js';

registerServerOnlyShim();
const { ReminderSettingsView } = await import('../src/features/reminders/ReminderSettingsView.jsx');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { DEFAULT_REMINDER_SETTINGS } = await import('../src/domain/reminders/reminderPolicy.js');
const { POST, GET } = await import('../src/app/api/mergen-rota/reminders/run/route.js');
const { addTaskToOutlook } = await import('../src/server/outlook/outlookCalendarService.js');
const poolApi = await import('../src/server/db/pool.js');
const TASK = 'C3C3C3C3-3333-4333-8333-333333333333';
const PROJECT = 'A1A1A1A1-1111-4111-8111-111111111111';
const SICIL = 900001;

async function stack(t, admin = true) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    MERGEN_ROTA_DB_SERVER: 'sql.test.internal', MERGEN_ROTA_DB_DATABASE: 'MERGEN_Rota',
    MERGEN_ROTA_AUTH_MODE: 'development', MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true',
    MERGEN_ROTA_DEV_SICIL: String(SICIL), MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED: 'true',
    MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS: '6',
    SMTP_HOST: '127.0.0.1', SMTP_FROM: 'rota@example.internal', SMTP_USE_STARTTLS: 'false',
    SMTP_USERNAME: '', SMTP_PASSWORD: '', SMTP_TLS_REJECT_UNAUTHORIZED: 'true'
  });
  const db = createFakeDatabase({
    systemAdminSicils: admin ? [SICIL] : [],
    people: [{ Sicil: SICIL, DisplayName: 'Test Kullanıcı', Username: 'tester' }],
    corporateUsers: [{ Name: 'tester', EmailAddress: 'tester@example.internal' }],
    projects: [{ ProjectId: PROJECT, SourceType: 'CORPORATE', ProjectCode: 'P100', ProjectName: 'Proje', IsActive: 1 }],
    corporateProjectAccess: [{ ProjectCode: 'P100', Sicil: SICIL, RoleCode: 'PROJECT_MANAGER' }],
    tasks: [{ TaskId: TASK, ProjectId: PROJECT, Title: 'Görev', Status: 'todo', TargetFinish: '2026-09-15' }]
  });
  poolApi.setSqlDriverForTests(createFakeSqlServerDriver(db));
  poolApi.resetSqlPoolForTests();
  const pool = await poolApi.getSqlPool();
  t.after(() => {
    poolApi.setSqlDriverForTests(null);
    poolApi.resetSqlPoolForTests();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return { db, pool };
}

async function smtpServer(t, reject = false) {
  const sockets = new Set();
  const messages = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 test SMTP\r\n');
    let buffer = '';
    let message = null;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message) {
          if (line === '.') {
            messages.push(message.join('\r\n'));
            message = null;
            socket.write(reject ? '451 temporary failure\r\n' : '250 accepted\r\n');
          } else message.push(line);
        } else if (line.startsWith('EHLO')) socket.write('250 test\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { message = []; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_PORT = String(server.address().port);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return messages;
}

for (const reject of [false, true]) {
  test(`yönetici turu gerçek SMTP sonucunu hatırlatma kapalıyken ayrı bildirir (ret: ${reject})`, async (t) => {
    const { pool, db } = await stack(t);
    const messages = await smtpServer(t, reject);
    await addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
    const response = await POST(new Request('http://localhost/reminders/run', { method: 'POST' }));
    const body = await response.json();
    assert.equal(response.status, reject ? 503 : 200);
    assert.equal(body.reminders.enabled, false);
    assert.equal(body.reminders.sent, 0);
    assert.equal(body.outlook.claimed, 1);
    assert.equal(body.outlook.sent, reject ? 0 : 1);
    assert.equal(body.outlook.failed, reject ? 1 : 0);
    assert.equal(messages.length, 1);
    const message = deliveryRunMessage(body);
    assert.match(message.text, /Otomatik hatırlatma: kapalı/);
    assert.doesNotMatch(message.text, /hiçbir ileti|İşlem tamamlanamadı/);
    if (reject) {
      assert.equal(body.error.code, 'SMTP_SEND_FAILED');
      assert.match(message.text, /SMTP_SEND_FAILED/);
      assert.equal(db.taskOutlookSubscriptions[0].LastFailureCode, 'SMTP_SEND_FAILED');
    } else assert.match(message.text, /Outlook: 1 iş alındı, 1 gönderildi/);
  });
}

test('yalnız Outlook başarısızsa HTTP istemcisi başarıyı ve iki özeti kaybetmez', async (t) => {
  const old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  const body = {
    ok: false, reminders: { ok: true, enabled: true, sent: 3, skipped: 2, failed: 0 },
    outlook: { ok: false, enabled: true, claimed: 2, sent: 1, unchanged: 0, failed: 1, reason: 'SMTP_SEND_FAILED', failureCodes: { SMTP_SEND_FAILED: 1 } },
    error: { code: 'SMTP_SEND_FAILED', message: 'SMTP_SEND_FAILED: E-posta gönderilemedi.' }
  };
  globalThis.fetch = async () => Response.json(body, { status: 503 });
  const result = await requestJson('/test', { method: 'POST' });
  assert.equal(result.code, 'SMTP_SEND_FAILED');
  const message = deliveryRunMessage(result);
  assert.equal(message.type, 'error');
  assert.match(message.text, /Hatırlatmalar: 3 gönderildi, 2 atlandı/);
  assert.match(message.text, /Outlook: 2 iş alındı, 1 gönderildi/);
  assert.match(message.text, /SMTP_SEND_FAILED/);
});

test('başarılı HTTP turunda başarısız hatırlatma hata olarak gösterilir', () => {
  const reminders = { ok: true, enabled: true, sent: 2, skipped: 0, failed: 1 };
  for (const response of [reminders, { ok: true, reminders, outlook: { ok: true, enabled: false } }]) {
    const message = deliveryRunMessage(response);
    assert.equal(message.type, 'error');
    assert.match(message.text, /2 gönderildi, 0 atlandı, 1 başarısız/);
  }
  assert.equal(deliveryRunMessage({ ...reminders, failed: 0 }).type, 'success');
});

test('hatırlatma hata kodları korunur ve Outlook kodlarına karışmaz', () => {
  for (const reason of ['TASK_NOT_FOUND', 'PROJECT_INACTIVE', 'NO_RECIPIENTS', 'SMTP_SEND_FAILED']) {
    const message = deliveryRunMessage({
      ok: true,
      reminders: { ok: true, enabled: true, failed: 1, results: [{ status: 'FAILED', reason }] },
      outlook: { ok: true, enabled: true, sent: 1 }
    });
    assert.equal(message.type, 'error');
    assert.ok(message.text.includes(`${reason}:`));
    assert.doesNotMatch(message.text, /UNEXPECTED_ERROR/);
    assert.match(message.text, /Outlook: 0 iş alındı, 1 gönderildi/);
  }
  const unknown = deliveryRunMessage({ reminders: {
    ok: false, enabled: true, reason: 'password=secret; SELECT *',
    results: [{ status: 'FAILED', code: 'toString' }]
  } });
  assert.match(unknown.text, /UNEXPECTED_ERROR/);
  assert.doesNotMatch(unknown.text, /password|secret|SELECT|toString/);
  assert.match(deliveryRunMessage({ outlook: { ok: false, reason: 'TASK_NOT_FOUND' } }).text, /UNEXPECTED_ERROR/);
});

test('eski 503 özetindeki güvenli neden korunur; bilinmeyen hata metni sızmaz', async (t) => {
  const old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async () => Response.json({ outlook: { ok: false, reason: 'SMTP_CONFIG_INVALID' } }, { status: 503 });
  const safe = await requestJson('/test', { method: 'POST' });
  assert.equal(safe.code, 'SMTP_CONFIG_INVALID');
  assert.match(safe.message, /SMTP_CONFIG_INVALID/);
  assert.doesNotMatch(deliveryRunMessage({ outlook: { ok: false, reason: 'password=secret; SELECT *' } }).text, /password|secret|SELECT/);
});

test('istemci süre aşımı başarısız teslimat diye bildirilmez', async (t) => {
  const old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const result = await requestJson('/test', { method: 'POST' }, { timeoutMs: 10 });
  assert.equal(result.code, 'REQUEST_TIMEOUT');
  assert.match(result.message, /henüz doğrulanmadı/);
});

test('yönetici görünümü başarısız turda ayrı özetleri ve güvenli nedeni ekrana getirir', async (t) => {
  const oldFetch = globalThis.fetch;
  const oldContext = DataModeContext._currentValue;
  t.after(() => { globalThis.fetch = oldFetch; DataModeContext._currentValue = oldContext; });
  DataModeContext._currentValue = { dataMode: 'actual' };
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/admin/reminder-settings')) return Response.json({ settings: { ...DEFAULT_REMINDER_SETTINGS, subject: 'Konu', body: 'Metin' }, smtpConfigured: true });
    if (options.method === 'GET') return Response.json({ outlook: { enabled: true, automatic: true, intervalMs: 5000, queue: { pending: 1, due: 0, inFlight: 0, failed: 1, exhausted: 0 } } });
    return Response.json({ ok: false, reminders: { ok: true, enabled: false }, outlook: { ok: false, enabled: true, claimed: 2, sent: 1, failed: 1, reason: 'OUTLOOK_LEASE_LOST' }, error: { code: 'OUTLOOK_LEASE_LOST', message: 'Sahiplik kaybedildi.' } }, { status: 503 });
  };
  const view = mountComponent(ReminderSettingsView, {});
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const button = findElement(view.output, (node) => node.type === 'button' && JSON.stringify(node.props.children).includes('Turu şimdi çalıştır'));
  assert.ok(button);
  await button.props.onClick();
  view.render();
  const status = findElement(view.output, (node) => node.props?.role === 'status');
  assert.match(status.props.children, /Otomatik hatırlatma: kapalı/);
  assert.match(status.props.children, /1 gönderildi/);
  assert.match(status.props.children, /OUTLOOK_LEASE_LOST/);
  assert.match(JSON.stringify(view.output), /Otomatik Outlook işleme: açık/);
});

test('kuyruk durumu kalıcı ortak sayıları döndürür ve sır içermez', async (t) => {
  const { pool, db } = await stack(t);
  await addTaskToOutlook(pool, { taskId: TASK, sicil: SICIL, queueOnly: true });
  db.taskOutlookSubscriptions[0].AttemptCount = 7;
  db.taskOutlookSubscriptions[0].LastFailureCode = 'SMTP_SEND_FAILED';
  const response = await GET();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.outlook.queue, { pending: 1, failed: 1, exhausted: 1, inFlight: 0, due: 0 });
  assert.equal(result.outlook.automatic, false);
  assert.doesNotMatch(JSON.stringify(result), /@example|password|CalendarUid|SELECT/);
});

test('normal kullanıcı tanı turunu ve kuyruk durumunu çalıştıramaz', async (t) => {
  await stack(t, false);
  const response = await POST(new Request('http://localhost/reminders/run', { method: 'POST' }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
  assert.equal((await GET()).status, 403);
});

test('kuyruk sorgusu hatası hatırlatma ayarlarını düşürmeden güvenli tanı verir', async (t) => {
  const { pool } = await stack(t);
  const request = pool.request.bind(pool);
  pool.request = () => {
    const value = request();
    const query = value.query.bind(value);
    value.query = (sql) => sql.includes('COUNT_BIG(*) AS Pending')
      ? Promise.reject(Object.assign(new Error('SELECT secret password'), { code: 'EREQUEST' })) : query(sql);
    return value;
  };
  const body = await (await GET()).json();
  assert.equal(body.outlook.reason, 'DATABASE_QUERY_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /SELECT|secret|password/);
});

for (const summary of [
  { ok: true, failed: 2 },
  { ok: true, results: [{ status: 'FAILED', reason: 'PROJECT_INACTIVE' }] },
  { ok: true, failed: 0, results: [{ status: 'FAILED', reason: 'SMTP_SEND_FAILED' }] },
  { ok: false, failed: 0, reason: 'SMTP_NOT_CONFIGURED' }
]) {
  test(`hatırlatma başarısızlığının tüm gösterimleri tutarlı sonuç üretir: ${JSON.stringify(summary)}`, async () => {
    const { reminderRunOutcome } = await import('../src/domain/reminders/reminderRunOutcome.js');
    const result = reminderRunOutcome(summary);
    assert.equal(result.ok, false);
    assert.equal(result.failed, Math.max(summary.failed || 0, summary.results?.length || 0));
    const message = deliveryRunMessage({ ok: true, reminders: { ...summary, enabled: true }, outlook: { ok: true, sent: 1 } });
    assert.equal(message.type, 'error');
    assert.match(message.text, /Outlook: 0 iş alındı, 1 gönderildi/);
    if (result.failed) assert.ok(message.text.includes(`${result.failed} başarısız`));
  });
}

test('gerçek hatırlatma SMTP reddi Outlook başarılıyken servis, HTTP ve arayüzde başarısızdır', async (t) => {
  const { db } = await stack(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T12:00:00Z') });
  await smtpServer(t, true);
  const now = new Date();
  db.tasks[0].TargetFinish = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  db.reminderSettings = { AutomaticEnabled: 1, WindowValue: 7, WindowUnit: 'day', FrequencyValue: 1, FrequencyUnit: 'day' };
  db.taskAssignees = [{ TaskId: TASK, Sicil: SICIL }];
  const response = await POST(new Request('http://localhost/reminders/run', { method: 'POST' }));
  const body = await response.json();
  assert.equal(body.reminders.failed, 1);
  assert.equal(body.reminders.results[0].status, 'FAILED');
  assert.equal(body.reminders.ok, false);
  assert.equal(body.outlook.ok, true);
  assert.equal(body.ok, false);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'SMTP_SEND_FAILED');
  assert.equal(deliveryRunMessage(body).type, 'error');
});
