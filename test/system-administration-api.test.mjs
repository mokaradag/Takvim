/**
 * Sistem Yönetimi · sunucu uçları ve telemetri turu.
 *
 * Zincir GERÇEK kodla çalışır: rota gövdesi → yetkilendirme → sağlık servisi →
 * depo → bellek içi SQL Server ikizi. Yetki, gizlilik, kuyruk güvenliği ve
 * saklama davranışı burada sınanır.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const overviewRoute = await import('../src/app/api/mergen-rota/admin/system/overview/route.js');
const performanceRoute = await import('../src/app/api/mergen-rota/admin/system/performance/route.js');
const queuesRoute = await import('../src/app/api/mergen-rota/admin/system/queues/route.js');
const eventsRoute = await import('../src/app/api/mergen-rota/admin/system/events/route.js');
const integrationsRoute = await import('../src/app/api/mergen-rota/admin/system/integrations/route.js');
const poolApi = await import('../src/server/db/pool.js');
const { runTelemetryCycle } = await import('../src/server/observability/telemetryWorker.js');
const { resetAlertTrackerForTests } = await import('../src/server/observability/alertRules.js');
const { resetHealthProbeCacheForTests } = await import('../src/server/observability/healthProbes.js');
const { resetIntegrationCacheForTests } = await import('../src/server/observability/integrationsService.js');
const { resetAdminActionLocksForTests, withAdminActionLock } = await import('../src/server/observability/adminRequestContext.js');
const {
  drainOperationalEvents,
  queueOperationalEvent,
  resetOperationalEventBufferForTests
} = await import('../src/server/observability/operationalEventsRepository.js');
const {
  recordOperation,
  resetTelemetryRegistryForTests
} = await import('../src/server/observability/telemetryRegistry.js');
const { COMPONENTS, EVENT_SEVERITIES } = await import('../src/domain/observability/eventModel.js');
const { HEALTH_STATES } = await import('../src/domain/observability/healthModel.js');
const { verifySmtpConnection } = await import('../src/server/mail/smtpClient.js');

const SICIL = 900001;
const PROJECT = 'A1A1A1A1-1111-4111-8111-111111111111';
const TASK = 'C3C3C3C3-3333-4333-8333-333333333333';

function seedDatabase({ admin = true, outlookRows = [], reminderLog = [], syncState = [] } = {}) {
  return createFakeDatabase({
    systemAdminSicils: admin ? [SICIL] : [],
    people: [{ Sicil: SICIL, DisplayName: 'Yönetici', Username: 'yonetici' }],
    corporateUsers: [{ Name: 'yonetici', EmailAddress: 'yonetici@kurum.local' }],
    projects: [{ ProjectId: PROJECT, SourceType: 'CORPORATE', ProjectCode: 'P100', ProjectName: 'Proje', IsActive: 1 }],
    corporateProjectAccess: [{ ProjectCode: 'P100', Sicil: SICIL, RoleCode: 'PROJECT_MANAGER' }],
    tasks: [{ TaskId: TASK, ProjectId: PROJECT, Title: 'Görev', Status: 'todo', TargetFinish: '2026-09-15' }],
    taskOutlookSubscriptions: outlookRows,
    taskReminderLog: reminderLog,
    corporateWbsSyncState: syncState
  });
}

function stack(t, options = {}) {
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    MERGEN_ROTA_DB_SERVER: 'sql.test.internal',
    MERGEN_ROTA_DB_DATABASE: 'MERGEN_Rota',
    MERGEN_ROTA_AUTH_MODE: 'development',
    MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true',
    MERGEN_ROTA_DEV_SICIL: String(SICIL),
    MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED: options.outlookEnabled ? 'true' : 'false',
    MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS: '6',
    MERGEN_ROTA_TELEMETRY_ENABLED: 'true',
    SMTP_HOST: options.smtpHost ?? '',
    SMTP_FROM: options.smtpHost ? 'rota@kurum.local' : '',
    SMTP_PORT: options.smtpPort ? String(options.smtpPort) : '',
    SMTP_USERNAME: '',
    SMTP_PASSWORD: options.smtpPassword ?? '',
    SMTP_USE_STARTTLS: 'false'
  });
  delete process.env.MERGEN_ROTA_WBS_DB_SERVER;
  delete process.env.MERGEN_ROTA_WBS_DB_DATABASE;

  const db = seedDatabase(options);
  poolApi.setSqlDriverForTests(createFakeSqlServerDriver(db));
  poolApi.resetSqlPoolForTests();
  resetAlertTrackerForTests();
  resetHealthProbeCacheForTests();
  resetIntegrationCacheForTests();
  resetAdminActionLocksForTests();
  resetTelemetryRegistryForTests();
  resetOperationalEventBufferForTests();

  t.after(() => {
    poolApi.setSqlDriverForTests(null);
    poolApi.resetSqlPoolForTests();
    resetAlertTrackerForTests();
    resetHealthProbeCacheForTests();
    resetIntegrationCacheForTests();
    resetAdminActionLocksForTests();
    resetTelemetryRegistryForTests();
    resetOperationalEventBufferForTests();
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });
  return db;
}

function request(url = 'http://localhost/api/mergen-rota/admin/system/overview', init = {}) {
  return new Request(url, init);
}

function postRequest(url, body) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

/* ── Yetkilendirme ────────────────────────────────────────── */

test('sistem yönetimi uçları yetkisiz kullanıcıya kapalıdır', async (t) => {
  stack(t, { admin: false });
  const responses = await Promise.all([
    overviewRoute.GET(request()),
    performanceRoute.GET(request('http://localhost/performance?range=24h')),
    queuesRoute.GET(request('http://localhost/queues')),
    eventsRoute.GET(request('http://localhost/events')),
    integrationsRoute.GET(request('http://localhost/integrations')),
    queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-run' })),
    eventsRoute.POST(postRequest('http://localhost/events', { action: 'acknowledge', alertId: 1 })),
    integrationsRoute.POST(postRequest('http://localhost/integrations', { integrationId: 'database' }))
  ]);
  for (const response of responses) {
    assert.equal(response.status, 403, 'yetkisiz erişim FORBIDDEN olmalıdır');
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  }
});

test('sistem yöneticisi bütün yönetim uçlarını okuyabilir', async (t) => {
  stack(t);
  for (const response of [
    await overviewRoute.GET(request()),
    await performanceRoute.GET(request('http://localhost/performance?range=1h')),
    await queuesRoute.GET(request('http://localhost/queues')),
    await eventsRoute.GET(request('http://localhost/events')),
    await integrationsRoute.GET(request('http://localhost/integrations'))
  ]) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
});

/* ── Genel durum ──────────────────────────────────────────── */

test('genel durum bileşen sağlıklarını ve yapılandırmayı taşır', async (t) => {
  stack(t);
  const body = await (await overviewRoute.GET(request())).json();
  const keys = body.components.map((component) => component.key);
  for (const key of [
    COMPONENTS.APPLICATION, COMPONENTS.DATABASE, COMPONENTS.DIRECTORY, COMPONENTS.CORPORATE_WBS,
    COMPONENTS.AUTHENTICATION, COMPONENTS.SMTP, COMPONENTS.OUTLOOK, COMPONENTS.REMINDER, COMPONENTS.RESOURCES
  ]) {
    assert.ok(keys.includes(key), `${key} bileşeni bildirilmelidir`);
  }
  assert.equal(body.components.find((component) => component.key === COMPONENTS.DATABASE).state, HEALTH_STATES.HEALTHY);
  assert.ok(Number.isFinite(body.configuration.refreshIntervalMs));
  assert.ok(body.configuration.retentionDays >= 1);
  assert.ok(Array.isArray(body.attention));
  assert.ok(Array.isArray(body.feed));
});

test('ölçülemeyen veritabanı SAĞLIKLI değil KRİTİK bildirilir', async (t) => {
  const db = stack(t);
  db.databaseProbeFails = true;
  const body = await (await overviewRoute.GET(request())).json();
  const database = body.components.find((component) => component.key === COMPONENTS.DATABASE);
  assert.equal(database.state, HEALTH_STATES.CRITICAL);
  assert.equal(body.state, HEALTH_STATES.CRITICAL);
  assert.match(database.message, /ulaşılamadı/);
});

test('yapılandırılmamış bağımlılık uyarı üretmez ama sağlıklı da sayılmaz', async (t) => {
  stack(t);
  const body = await (await overviewRoute.GET(request())).json();
  const wbs = body.components.find((component) => component.key === COMPONENTS.CORPORATE_WBS);
  const smtp = body.components.find((component) => component.key === COMPONENTS.SMTP);
  assert.equal(wbs.state, HEALTH_STATES.NOT_CONFIGURED);
  assert.equal(smtp.state, HEALTH_STATES.NOT_CONFIGURED);
  assert.equal(body.counts.notConfigured >= 2, true);
});

/* ── Başarım ──────────────────────────────────────────────── */

test('başarım ucu aralığı sunucuda sınırlar ve geçmişi kalıcı toplamdan okur', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  const bucketAt = Date.now() - 20 * 60 * 1000;
  for (let index = 1; index <= 40; index += 1) {
    recordOperation({ operation: 'api.commit', durationMs: index * 10, ok: index % 8 !== 0, at: bucketAt });
  }
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  const body = await (await performanceRoute.GET(request('http://localhost/performance?range=1000y'))).json();
  // Tanınmayan aralık serbest pencere açmaz.
  assert.equal(body.range.id, '24h');
  assert.equal(body.schemaReady, true);
  assert.equal(body.summary.count, 40);
  assert.equal(body.summary.errorCount, 5);
  assert.ok(body.summary.p95Ms > 0);
  const commit = body.operations.find((row) => row.operation === 'api.commit');
  assert.equal(commit.count, 40);
  assert.ok(body.series.length >= 1);
  assert.equal(typeof body.resources.platform, 'string');
});

test('telemetri şeması yokken başarım ucu çökmez ve durumu açıkça bildirir', async (t) => {
  const db = stack(t);
  db.observabilitySchemaMissing = true;
  const response = await performanceRoute.GET(request('http://localhost/performance?range=24h'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaReady, false);
  assert.deepEqual(body.series, []);
  assert.deepEqual(body.operations, []);
});

/* ── Kuyruklar ve eylemler ────────────────────────────────── */

function pendingSubscription(overrides = {}) {
  return {
    TaskId: TASK,
    ProjectId: PROJECT,
    UserSicil: SICIL,
    CalendarUid: 'uid-1',
    PendingMethod: 'REQUEST',
    PendingSequence: 3,
    Sequence: 3,
    QueueSeq: 7,
    AttemptCount: 4,
    LastFailureCode: 'SMTP_SEND_FAILED',
    UpdatedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    ...overrides
  };
}

test('kuyruk ucu Outlook, hatırlatma ve CN43N bölümlerini güvenli künyeyle döndürür', async (t) => {
  stack(t, {
    outlookEnabled: true,
    outlookRows: [pendingSubscription()],
    reminderLog: [{ TaskId: TASK, ProjectId: PROJECT, SlotKey: 'slot-1', Status: 'SENT', RecipientCount: 2 }]
  });
  const body = await (await queuesRoute.GET(request('http://localhost/queues'))).json();
  assert.equal(body.outlook.enabled, true);
  assert.equal(body.outlook.queue.pending, 1);
  assert.equal(body.outlook.queue.failed, 1);
  assert.equal(body.outlook.items.length, 1);
  assert.equal(body.outlook.items[0].failureCode, 'SMTP_SEND_FAILED');
  assert.equal(body.reminders.history.length, 1);
  assert.equal(body.corporateWbs.configured, false);
  // Alıcı adresi, takvim kimliği ve ileti içeriği ASLA taşınmaz.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /CalendarUid|uid-1|@kurum\.local|BEGIN:VCALENDAR/);
});

test('başarısızları yeniden deneme kuyruk kuşağını ve takvim sürümünü korur', async (t) => {
  const db = stack(t, { outlookEnabled: true, outlookRows: [pendingSubscription()] });
  const before = { ...db.taskOutlookSubscriptions[0] };
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.retried, 1);

  const after = db.taskOutlookSubscriptions[0];
  assert.equal(after.AttemptCount, 0);
  assert.equal(after.NextAttemptAt, null);
  // Outlook kimlik bütünlüğü DEĞİŞMEZ: eski kuşak yeni niyeti ezemez.
  assert.equal(after.QueueSeq, before.QueueSeq);
  assert.equal(after.Sequence, before.Sequence);
  assert.equal(after.PendingSequence, before.PendingSequence);
  assert.equal(after.PendingMethod, before.PendingMethod);
});

test('sahiplenilmiş (kiralı) teslimat yeniden denemeyle kesilmez', async (t) => {
  const db = stack(t, {
    outlookEnabled: true,
    outlookRows: [pendingSubscription({ LeaseExpiresAt: new Date(Date.now() + 60000).toISOString() })]
  });
  const body = await (await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }))).json();
  assert.equal(body.result.retried, 0);
  assert.equal(db.taskOutlookSubscriptions[0].AttemptCount, 4);
});

test('tanınmayan yönetim eylemi reddedilir', async (t) => {
  stack(t, { outlookEnabled: true });
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'kuyrugu-temizle' }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MUTATION_FAILED');
});

test('kapalı Outlook tümleştirmesinde tur eylemi çalıştırılamaz', async (t) => {
  stack(t);
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-run' }));
  assert.equal(response.status, 403);
});

test('aynı yönetim eylemi eşzamanlı iki kez çalıştırılamaz', async (t) => {
  stack(t, { outlookEnabled: true });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const running = withAdminActionLock('outlook-retry', () => held);
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'CONFLICT');
  release();
  await running;
  // Kilit bırakıldıktan sonra eylem yeniden çalışabilir.
  assert.equal((await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }))).status, 200);
});

/* ── Olaylar ve uyarılar ──────────────────────────────────── */

test('özdeş olaylar tek satırda toplanır ve süzgeçlerle sayfalanır', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  for (let index = 0; index < 25; index += 1) {
    queueOperationalEvent({
      severity: EVENT_SEVERITIES.ERROR,
      component: COMPONENTS.SMTP,
      code: 'SMTP_DELIVERY_FAILED',
      detail: 'Aynı hata yineleniyor.'
    });
  }
  queueOperationalEvent({ severity: EVENT_SEVERITIES.INFO, component: COMPONENTS.APPLICATION, code: 'APP_STARTED' });
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  const body = await (await eventsRoute.GET(request('http://localhost/events?range=24h'))).json();
  assert.equal(body.total, 2, '25 özdeş olay tek satıra toplanmalıdır');
  const smtp = body.events.find((event) => event.code === 'SMTP_DELIVERY_FAILED');
  assert.equal(smtp.occurrenceCount, 25);
  assert.ok(smtp.action, 'olay kodu önerilen eylemi taşımalıdır');

  const filtered = await (await eventsRoute.GET(request('http://localhost/events?severity=INFO'))).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.events[0].code, 'APP_STARTED');

  const searched = await (await eventsRoute.GET(request('http://localhost/events?search=SMTP'))).json();
  assert.equal(searched.total, 1);

  const paged = await (await eventsRoute.GET(request('http://localhost/events?limit=1&offset=1'))).json();
  assert.equal(paged.events.length, 1);
  assert.equal(paged.total, 2);
});

test('olay kuyruğu boşaltılırken yinelenenler sayaçla birleşir', () => {
  resetOperationalEventBufferForTests();
  for (let index = 0; index < 5; index += 1) {
    queueOperationalEvent({ component: COMPONENTS.SMTP, code: 'SMTP_DELIVERY_FAILED', severity: EVENT_SEVERITIES.ERROR });
  }
  queueOperationalEvent({ component: COMPONENTS.OUTLOOK, code: 'OUTLOOK_QUEUE_AGING', severity: EVENT_SEVERITIES.WARNING });
  const drained = drainOperationalEvents();
  assert.equal(drained.events.length, 2);
  assert.equal(drained.events.find((event) => event.code === 'SMTP_DELIVERY_FAILED').occurrenceCount, 5);
  assert.equal(drainOperationalEvents().events.length, 0);
  resetOperationalEventBufferForTests();
});

test('koşul uyarı açar, yinelenince sayaç artar, düzelince çözülür', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  db.databaseProbeFails = true;

  // Çırpınma koruması: ilk tur uyarı AÇMAZ.
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(db.operationalAlerts.length, 0);

  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(db.operationalAlerts.length, 1);
  const alert = db.operationalAlerts[0];
  assert.equal(alert.EventCode, 'DATABASE_UNAVAILABLE');
  assert.equal(alert.Severity, 'CRITICAL');
  assert.equal(alert.State, 'OPEN');

  // Yineleme YENİ satır açmaz; sayaç ilerler.
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(db.operationalAlerts.length, 1);
  assert.ok(db.operationalAlerts[0].OccurrenceCount >= 2);

  // Koşul düzelince iki temiz turdan sonra uyarı çözülür.
  db.databaseProbeFails = false;
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(db.operationalAlerts[0].State, 'OPEN', 'tek temiz tur uyarıyı kapatmaz');
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(db.operationalAlerts[0].State, 'RESOLVED');
  assert.ok(db.operationalAlerts[0].ResolvedAt);
});

test('uyarı onaylanabilir; onay koşulu çözmez', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  db.databaseProbeFails = true;
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  const alertId = db.operationalAlerts[0].OperationalAlertId;

  const response = await eventsRoute.POST(postRequest('http://localhost/events', { action: 'acknowledge', alertId }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.acknowledged, true);
  assert.equal(db.operationalAlerts[0].State, 'ACKNOWLEDGED');
  assert.equal(db.operationalAlerts[0].AcknowledgedBySicil, SICIL);
  assert.equal(db.operationalAlerts[0].ResolvedAt, null);

  // İkinci onay yeniden uygulanmaz.
  assert.equal((await (await eventsRoute.POST(postRequest('http://localhost/events', { action: 'acknowledge', alertId }))).json()).acknowledged, false);
  // Geçersiz gövde reddedilir.
  assert.equal((await eventsRoute.POST(postRequest('http://localhost/events', { action: 'acknowledge', alertId: 0 }))).status, 400);
  assert.equal((await eventsRoute.POST(postRequest('http://localhost/events', { action: 'sil' }))).status, 400);
});

test('olay ve uyarı şeması yokken uçlar çalışmaya devam eder', async (t) => {
  const db = stack(t);
  db.observabilitySchemaMissing = true;
  const events = await eventsRoute.GET(request('http://localhost/events'));
  assert.equal(events.status, 200);
  const body = await events.json();
  assert.equal(body.schemaReady, false);
  assert.deepEqual(body.events, []);

  const overview = await (await overviewRoute.GET(request())).json();
  assert.equal(overview.alertsSchemaReady, false);
  assert.ok(overview.components.length > 0, 'sağlık tablosu yine gösterilir');
});

/* ── Saklama ──────────────────────────────────────────────── */

test('saklama sınırı eski toplamları ve olayları temizler', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  db.telemetryOperationSamples.push({
    BucketStart: old, Operation: 'api.eski', SampleCount: 5, ErrorCount: 0,
    DurationSumMs: 100, DurationMaxMs: 40, P50Ms: 20, P95Ms: 35, P99Ms: 40, TopFailureCode: null
  });
  db.telemetryGaugeSamples.push({ BucketStart: old, MetricKey: 'process.rss', SampleCount: 1, ValueAvg: 10, ValueMin: 10, ValueMax: 10 });
  db.operationalEvents.push({
    OperationalEventId: 99, OccurredAt: old, Severity: 'INFO', Component: 'APPLICATION',
    EventCode: 'APP_STARTED', Summary: 'eski', Detail: null, CorrelationId: null, OccurrenceCount: 1, ContextJson: null
  });

  const summary = await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: 0 });
  assert.equal(summary.retentionRan, true);
  assert.equal(db.telemetryOperationSamples.some((row) => row.Operation === 'api.eski'), false);
  assert.equal(db.telemetryGaugeSamples.length, db.telemetryGaugeSamples.filter((row) => row.BucketStart !== old).length);
  assert.equal(db.operationalEvents.some((event) => event.Summary === 'eski'), false);
});

test('telemetri turu veritabanı erişilemezken uygulamayı düşürmez', async (t) => {
  stack(t);
  poolApi.setSqlDriverForTests({
    ConnectionPool: class { async connect() { throw new Error('bağlanılamadı'); } on() {} async close() {} },
    Transaction: class {}
  });
  poolApi.resetSqlPoolForTests();
  const summary = await runTelemetryCycle({ now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'DATABASE_UNAVAILABLE');
});

/* ── Entegrasyonlar ───────────────────────────────────────── */

test('entegrasyon kartları gizli değer taşımaz ve Outlook SMTP + iCalendar olarak anlatılır', async (t) => {
  stack(t, { smtpHost: '127.0.0.1', smtpPort: 2525, smtpPassword: 'cok-gizli-parola' });
  const body = await (await integrationsRoute.GET(request('http://localhost/integrations'))).json();
  const ids = body.integrations.map((integration) => integration.id);
  for (const id of ['database', 'corporate-wbs', 'directory', 'corporate-projects', 'project-responsibility', 'authentication', 'smtp', 'outlook']) {
    assert.ok(ids.includes(id), `${id} kartı bulunmalıdır`);
  }
  const outlook = body.integrations.find((integration) => integration.id === 'outlook');
  assert.equal(outlook.kind, 'SMTP + iCalendar');
  assert.doesNotMatch(JSON.stringify(body), /Graph|EWS/);
  // Parola, sunucu adresi ve bağlantı dizesi hiçbir kartta yer almaz.
  assert.doesNotMatch(JSON.stringify(body), /cok-gizli-parola|127\.0\.0\.1|Password=|Server=/);
  const smtp = body.integrations.find((integration) => integration.id === 'smtp');
  assert.equal(smtp.configured, true);
});

test('veritabanı bağlantı testi çalışır; tanınmayan entegrasyon reddedilir', async (t) => {
  stack(t);
  const response = await integrationsRoute.POST(postRequest('http://localhost/integrations', { integrationId: 'database' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.ok, true);
  assert.ok(body.result.durationMs >= 0);

  const unknown = await integrationsRoute.POST(postRequest('http://localhost/integrations', { integrationId: 'kurumsal-sey' }));
  assert.equal(unknown.status, 400);
});

test('SMTP bağlantı testi el sıkışmayla sınırlıdır ve ileti göndermez', async () => {
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buffer = '';
    setImmediate(() => socket.write('220 test SMTP\r\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let split;
      while ((split = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await verifySmtpConnection({
      host: '127.0.0.1', port: server.address().port, timeoutMs: 5000,
      from: 'rota@kurum.local', fromName: 'MERGEN', useStartTls: false,
      rejectUnauthorized: false, username: 'kullanici', password: 'parola'
    });
    assert.equal(result.greetingCode, 220);
    assert.equal(result.authAnnounced, true);
    assert.ok(result.durationMs >= 0);
    // İleti gönderim adımlarının HİÇBİRİ çalıştırılmaz; kimlik doğrulama da
    // denenmez (art arda başarısız denemeler hesabı kilitleyebilir).
    assert.deepEqual(commands, ['EHLO mergen-rota', 'QUIT']);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ── Gizlilik ─────────────────────────────────────────────── */

test('yönetim yanıtları hiçbir gizli değeri sızdırmaz', async (t) => {
  const db = stack(t, {
    outlookEnabled: true,
    smtpHost: '127.0.0.1',
    smtpPort: 2525,
    smtpPassword: 'cok-gizli-parola',
    outlookRows: [pendingSubscription()],
    reminderLog: [{ TaskId: TASK, ProjectId: PROJECT, SlotKey: 'slot-1', Status: 'SENT', RecipientCount: 1, RecipientDigest: 'y***@kurum.local' }]
  });
  const pool = await poolApi.getSqlPool();
  queueOperationalEvent({
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.SMTP,
    code: 'SMTP_DELIVERY_FAILED',
    detail: 'SMTP_PASSWORD=cok-gizli-parola kullanılarak gönderildi',
    context: { smtpPassword: 'cok-gizli-parola', recipient: 'kisi@kurum.local', cookie: 'session=1' }
  });
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  const payloads = await Promise.all([
    (await overviewRoute.GET(request())).json(),
    (await performanceRoute.GET(request('http://localhost/performance?range=1h'))).json(),
    (await queuesRoute.GET(request('http://localhost/queues'))).json(),
    (await eventsRoute.GET(request('http://localhost/events'))).json(),
    (await integrationsRoute.GET(request('http://localhost/integrations'))).json()
  ]);
  const serialized = JSON.stringify(payloads);
  for (const secret of ['cok-gizli-parola', 'SMTP_PASSWORD=', 'session=1', 'kisi@kurum.local', 'BEGIN:VCALENDAR', 'Password=', 'Server=sql.test.internal']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${secret} sızdırılmamalıdır`);
  }
  // Kalıcı olay kaydının kendisi de temizlenmiş olmalıdır.
  assert.doesNotMatch(JSON.stringify(db.operationalEvents), /cok-gizli-parola|session=1/);
});
