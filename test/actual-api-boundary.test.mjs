import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fromPersistenceStatus,
  toActualUuid,
  toPersistenceStatus
} from '../src/data/api/createApiRepository.js';

test('Actual mode strips local creation prefixes and keeps valid UUIDs', () => {
  const value = 'task-2d9f0b82-bf72-4b9d-b44e-21506f486697';
  assert.equal(toActualUuid(value), '2d9f0b82-bf72-4b9d-b44e-21506f486697');
  assert.equal(toActualUuid('2d9f0b82-bf72-4b9d-b44e-21506f486697'), '2d9f0b82-bf72-4b9d-b44e-21506f486697');
  assert.equal(toActualUuid(null), null);
});

test('current Task status vocabulary round-trips through SQL boundary', () => {
  assert.equal(toPersistenceStatus('todo'), 'planned');
  assert.equal(toPersistenceStatus('in_progress'), 'in-progress');
  assert.equal(toPersistenceStatus('done'), 'done');
  assert.equal(fromPersistenceStatus('planned'), 'todo');
  assert.equal(fromPersistenceStatus('in-progress'), 'in_progress');
  assert.equal(fromPersistenceStatus('done'), 'done');
});

/* ── Çerezli durum değiştiren uçlar: tarayıcı niyeti rota sınırında ── */

const ORIGIN = 'https://rota.example.internal';
const ROUTE_TASK_ID = '2d9f0b82-bf72-4b9d-b44e-21506f486697';
const MUTATING_ROUTES = [
  ['commit', 'commit/route.js', 'POST', true, null, [200]],
  ['tarih talebi', 'schedule-changes/route.js', 'POST', true, null, [400, 'MUTATION_FAILED']],
  ['tarih talebi bildirimi', 'schedule-changes/route.js', 'PATCH', true, null, [400, 'MUTATION_FAILED']],
  ['tarih talebi kararı', 'schedule-changes/[requestId]/route.js', 'PATCH', true, { requestId: ROUTE_TASK_ID }, [400, 'MUTATION_FAILED']],
  ['atama talebi', 'assignment-coordination/route.js', 'POST', true, null, [400, 'MUTATION_FAILED']],
  ['atama kararı', 'assignment-coordination/[coordinationId]/route.js', 'PATCH', true, { coordinationId: ROUTE_TASK_ID }, [400, 'MUTATION_FAILED']],
  ['zil bildirimi', 'notifications/route.js', 'PATCH', true, null, [400, 'MUTATION_FAILED']],
  ['hatırlatma ayarı', 'admin/reminder-settings/route.js', 'PUT', true, null, [200]],
  ['yönetici kuyruk eylemi', 'admin/system/queues/route.js', 'POST', true, null, [400, 'MUTATION_FAILED']],
  ['uyarı onayı', 'admin/system/events/route.js', 'POST', true, null, [200]],
  ['toplu Outlook', 'outlook/tasks/route.js', 'POST', true, null, [400, 'MUTATION_FAILED']],
  ['elle hatırlatma', 'tasks/[taskId]/reminder/route.js', 'POST', false, { taskId: ROUTE_TASK_ID }, [403, 'FORBIDDEN']],
  ['Outlook ekleme', 'tasks/[taskId]/outlook/route.js', 'POST', false, { taskId: ROUTE_TASK_ID }, [404, 'TASK_NOT_FOUND']],
  ['Outlook yeniden davet', 'tasks/[taskId]/outlook/route.js', 'PUT', false, { taskId: ROUTE_TASK_ID }, [404, 'NOT_SUBSCRIBED']],
  ['Outlook kaldırma', 'tasks/[taskId]/outlook/route.js', 'DELETE', false, { taskId: ROUTE_TASK_ID }, [404, 'NOT_SUBSCRIBED']],
  ['yönetici hatırlatma turu', 'reminders/run/route.js', 'POST', false, null, [503, 'SMTP_NOT_CONFIGURED']],
  ['nabız', 'presence/heartbeat/route.js', 'POST', false, null, [200]]
];

async function callRoute([, file, method, json, params], headers) {
  const route = await import(`../src/app/api/mergen-rota/${file}`);
  const body = json ? JSON.stringify({ action: 'acknowledge', alertId: 1, changes: {} }) : undefined;
  const response = await route[method](new Request(`${ORIGIN}/api/mergen-rota/${file}`, { method, headers, body }), { params: params || {} });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, code: payload?.error?.code, message: payload?.error?.message, payload };
}

test('çerezli durum değiştiren uçlar başka kaynaktan ve text/plain JSON ile hiçbir SQL yan etkisi olmadan reddedilir', async () => {
  const { corporateSeed, createActualStack } = await import('./helpers/actualStack.mjs');
  const stack = await createActualStack(corporateSeed());
  try {
    const hostile = [
      { origin: 'https://kardes.example.internal' },
      { origin: 'https://rota.example.internal.evil.example' },
      { origin: 'http://rota.example.internal' },
      { origin: 'null' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
    ];
    for (const route of MUTATING_ROUTES) {
      const before = stack.db.statements.length;
      for (const headers of hostile) {
        const outcome = await callRoute(route, { 'content-type': 'application/json', ...headers });
        assert.equal(outcome.status, 403, `${route[0]} ${JSON.stringify(headers)}`);
        assert.equal(outcome.message, 'İstek aynı kaynaktan gelmelidir.');
      }
      if (route[3]) {
        for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-seq']) {
          const outcome = await callRoute(route, { origin: ORIGIN, 'content-type': contentType });
          assert.equal(outcome.status, 415, `${route[0]} ${contentType}`);
        }
      }
      assert.equal(stack.db.statements.length, before, `${route[0]}: niyet kanıtlanmadan veritabanına dokunulmaz`);
    }
  } finally {
    await stack.dispose();
  }
});

test('aynı kaynaktan gelen tarayıcı isteği ve zamanlayıcı anahtarlı tur niyet denetiminden geçer', async () => {
  const { corporateSeed, createActualStack } = await import('./helpers/actualStack.mjs');
  const previousSecret = process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
  const previousSmtpHost = process.env.SMTP_HOST;
  const previousSmtpFrom = process.env.SMTP_FROM;
  process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = 'zamanlayici-gizli-anahtari';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  let stack;
  try {
    stack = await createActualStack(corporateSeed());
    // Kabul, rotanın niyet denetiminden SONRAKİ kendi sonucuyla kanıtlanır: beklenmeyen bir hata 500
    // üretir ve bu tabloyla eşleşmez; aynı FORBIDDEN kodunu taşıyan rota yanıtı niyet iletisinden ayrılır.
    for (const route of MUTATING_ROUTES) {
      const [label, , , json, , [status, code]] = route;
      for (const headers of [{ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, {}]) {
        const outcome = await callRoute(route, { ...(json ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers });
        assert.deepEqual([outcome.status, outcome.code], [status, code], `${label} ${JSON.stringify(headers)}: ${outcome.message}`);
        assert.notEqual(outcome.message, 'İstek aynı kaynaktan gelmelidir.', `${label} ${JSON.stringify(headers)}`);
      }
    }
    // Zamanlayıcı çerez kullanmaz: anahtarlı tur kendi sözleşmesiyle doğrulanır ve tur özetine ulaşır.
    const run = MUTATING_ROUTES.find(([label]) => label === 'yönetici hatırlatma turu');
    const scheduled = await callRoute(run, { 'x-mergen-rota-reminder-key': 'zamanlayici-gizli-anahtari', origin: 'https://zamanlayici.example.internal' });
    assert.equal(scheduled.status, 503);
    assert.equal(scheduled.payload.enabled, false, 'yapılandırılmamış SMTP ile tur çalışır ve devre dışı özetini döndürür');
    assert.ok(scheduled.payload.reminders, 'hatırlatma turu sonucu döner');
    const wrongKey = await callRoute(run, { 'x-mergen-rota-reminder-key': 'yanlis-anahtar', origin: 'https://zamanlayici.example.internal' });
    assert.deepEqual([wrongKey.status, wrongKey.message], [403, 'İstek aynı kaynaktan gelmelidir.'], 'yanlış anahtar çerez yoluna düşer');
  } finally {
    if (previousSecret == null) delete process.env.MERGEN_ROTA_REMINDER_CRON_SECRET;
    else process.env.MERGEN_ROTA_REMINDER_CRON_SECRET = previousSecret;
    if (previousSmtpHost == null) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = previousSmtpHost;
    if (previousSmtpFrom == null) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = previousSmtpFrom;
    await stack?.dispose();
  }
});
