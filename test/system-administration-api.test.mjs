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

/* ── İnceleme bulgularının gerilemeleri ───────────────────── */

test('ölçülmemiş hatırlatma turu SAĞLIKLI değil BİLİNMİYOR bildirilir', async (t) => {
  const db = stack(t, {
    reminderLog: [{
      TaskReminderLogId: 1, TaskId: TASK, ProjectId: PROJECT, ReminderKind: 'AUTOMATIC',
      SlotKey: 's1', Status: 'PENDING', CreatedAt: new Date().toISOString(), CompletedAt: null, FailureCode: null
    }]
  });
  db.reminderSettings = { AutomaticEnabled: 1 };
  const body = await (await overviewRoute.GET(request())).json();
  const reminder = body.components.find((component) => component.key === COMPONENTS.REMINDER);
  // Otomatik hatırlatma kapalıysa durum YAPILANDIRILMAMIŞ; açıksa sonlanmamış
  // tur SAĞLIKLI sayılamaz.
  assert.ok([HEALTH_STATES.NOT_CONFIGURED, HEALTH_STATES.UNKNOWN].includes(reminder.state));
  assert.notEqual(reminder.state, HEALTH_STATES.HEALTHY);
});

test('kurumsal proje kaynağı satır döndürmediğinde dizin sağlıklı sayılmaz', async (t) => {
  const db = stack(t);
  db.corporateProjects = [];
  const body = await (await overviewRoute.GET(request())).json();
  const directory = body.components.find((component) => component.key === COMPONENTS.DIRECTORY);
  assert.equal(directory.state, HEALTH_STATES.WARNING);
  assert.match(directory.message, /proje görünümü satır döndürmedi/);
});

test('şema yokken uyarı onayı yanlışlıkla başarılı bildirilmez', async (t) => {
  const db = stack(t);
  db.observabilitySchemaMissing = true;
  const response = await eventsRoute.POST(postRequest('http://localhost/events', { action: 'acknowledge', alertId: 7 }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
});

test('tur sınırında bölünen aynı olay tek satırda toplanır', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const now = Date.now();
  queueOperationalEvent({ severity: EVENT_SEVERITIES.ERROR, component: COMPONENTS.SMTP, code: 'SMTP_DELIVERY_FAILED' });
  await runTelemetryCycle({ pool, now, retentionDueAt: Number.MAX_SAFE_INTEGER });
  queueOperationalEvent({ severity: EVENT_SEVERITIES.ERROR, component: COMPONENTS.SMTP, code: 'SMTP_DELIVERY_FAILED' });
  await runTelemetryCycle({ pool, now: now + 60000, retentionDueAt: Number.MAX_SAFE_INTEGER });

  const rows = db.operationalEvents.filter((event) => event.EventCode === 'SMTP_DELIVERY_FAILED');
  assert.equal(rows.length, 1, 'iki tur tek satırda toplanmalıdır');
  assert.equal(rows[0].OccurrenceCount, 2);
});

test('sapma eşleşen satır sayısını aşınca toplam korunur', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  queueOperationalEvent({ severity: EVENT_SEVERITIES.INFO, component: COMPONENTS.APPLICATION, code: 'APP_STARTED' });
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  const body = await (await eventsRoute.GET(request('http://localhost/events?offset=50&limit=25'))).json();
  assert.deepEqual(body.events, []);
  // Boş sayfa "hiç kayıt yok" DEMEZ: sapmanın gerisinde eşleşen olay vardır.
  assert.equal(body.total, 1);
});

test('yeniden denenen Outlook kaydı başarısız durumundan çıkar', async (t) => {
  const db = stack(t, { outlookEnabled: true, outlookRows: [pendingSubscription()] });
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }));
  assert.equal(response.status, 200);
  const row = db.taskOutlookSubscriptions[0];
  assert.equal(row.AttemptCount, 0);
  // Hata kodu TEMİZLENİR: kalırsa kuyruk durumu kaydı hâlâ başarısız sayar ve
  // bir sonraki yeniden deneme aynı satırı tekrar seçerdi.
  assert.equal(row.LastFailureCode, null);
  const status = await (await queuesRoute.GET(request('http://localhost/queues'))).json();
  assert.equal(status.outlook.queue.failed, 0);
});

test('aynı boşaltma iki kez uygulandığında sayılar çift toplanmaz', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const { persistTelemetryBuckets } = await import('../src/server/observability/telemetryRepository.js');
  const bucket = Date.parse('2026-01-01T10:00:00.000Z');
  const row = {
    bucketStart: bucket, operation: 'api.snapshot', flushId: 'flush-1',
    count: 4, errorCount: 0, avgMs: 100, maxMs: 120, p50Ms: 90, p95Ms: 110, p99Ms: 120, topFailureCode: null
  };
  await persistTelemetryBuckets(pool, { operations: [{ ...row }], gauges: [] });
  await persistTelemetryBuckets(pool, { operations: [{ ...row }], gauges: [] });
  const stored = db.telemetryOperationSamples.filter((entry) => entry.Operation === 'api.snapshot');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].SampleCount, 4, 'belirsiz hata sonrası yeniden gönderim çift saymamalıdır');
  assert.ok(stored[0].InstanceId, 'satır süreç kimliği taşımalıdır');

  // Farklı boşaltma kimliği gerçek yeni örneklerdir ve toplanır.
  await persistTelemetryBuckets(pool, { operations: [{ ...row, flushId: 'flush-2' }], gauges: [] });
  assert.equal(db.telemetryOperationSamples.find((entry) => entry.Operation === 'api.snapshot').SampleCount, 8);
});

test('yazılamayan telemetri satırları yeniden deneme kuyruğunda kalır', async (t) => {
  stack(t);
  const { persistTelemetryBuckets } = await import('../src/server/observability/telemetryRepository.js');
  const failing = {
    request: () => ({
      input() { return this; },
      query: async () => { throw new Error('yazılamadı'); }
    })
  };
  const outcome = await persistTelemetryBuckets(failing, {
    operations: [{ bucketStart: Date.now(), operation: 'api.snapshot', flushId: 'f1', count: 1, avgMs: 10, maxMs: 10 }],
    gauges: []
  });
  assert.equal(outcome.written, 0);
  assert.equal(outcome.pending.operations.length, 1, 'yazılamayan satır bildirilmelidir');
  assert.ok(outcome.error, 'hata çağırana taşınmalıdır');
});

test('entegrasyon testi fırlatırsa uç iç hata değil başarısız sonuç döndürür', async (t) => {
  stack(t);
  const { testIntegration } = await import('../src/server/observability/integrationsService.js');
  const throwing = { request: () => { throw new Error('havuz kurulamadı'); } };
  const outcome = await testIntegration(throwing, 'database');
  assert.equal(outcome.ok, false);
  assert.ok(outcome.code, 'sınırlı bir hata kodu bildirilmelidir');
});

test('yapılandırılmış ama hiç yoklanmamış bağımlılık sağlıklı bildirilmez', async (t) => {
  stack(t, { smtpHost: '127.0.0.1', smtpPort: 2525 });
  const body = await (await integrationsRoute.GET(request('http://localhost/integrations'))).json();
  const smtp = body.integrations.find((integration) => integration.id === 'smtp');
  assert.equal(smtp.configured, true);
  // Yapılandırmanın eksiksizliği ERİŞİLEBİLİRLİK değildir.
  assert.equal(smtp.state, HEALTH_STATES.UNKNOWN);
  assert.match(smtp.message, /henüz denenmedi/);
});

test('ilişkilendirme kimliği sunucuda üretilir; istemci başlığı dayatamaz', async (t) => {
  stack(t);
  const response = await overviewRoute.GET(new Request('http://localhost/api/mergen-rota/admin/system/overview', {
    headers: { 'x-mergen-rota-correlation-id': 'istemci-dayatti-1234' }
  }));
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('x-mergen-rota-correlation-id'), 'istemci-dayatti-1234');
});

test('olay gezgini uyarılara ağırlık, kod ve metin süzgeçlerini sınırdan önce uygular', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  const { upsertOperationalAlert } = await import('../src/server/observability/operationalEventsRepository.js');
  for (const [code, severity, summary, detail, correlationId] of [
    ['SMTP_DELIVERY_FAILED', 'ERROR', 'Aranan kayıt', 'teslimat', 'match-trace'],
    ['SMTP_DELIVERY_FAILED', 'WARNING', 'başka kayıt', 'ayrıntı', 'other-trace'],
    ['OUTLOOK_WORKER_STALE', 'CRITICAL', 'çalışan durdu', 'ayrıntı', null]
  ]) {
    await upsertOperationalAlert(pool, { component: COMPONENTS.SMTP, code, severity, summary, detail, correlationId, scope: severity });
  }
  for (const query of ['severity=ERROR', 'code=SMTP_DELIVERY_FAILED&severity=ERROR', 'search=Aranan', 'search=teslimat', 'search=match-trace']) {
    const body = await (await eventsRoute.GET(request(`http://localhost/events?${query}`))).json();
    assert.equal(body.alerts.length, 1, query);
    assert.equal(body.alerts[0].summary, 'Aranan kayıt');
  }
  const empty = await (await eventsRoute.GET(request('http://localhost/events?search=bulunamayan'))).json();
  assert.deepEqual(empty.alerts, []);
});

test('gecikmiş olay gelecekteki eşleşmenin sayacını ve tanı alanlarını değiştirmez', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const { persistOperationalEvents } = await import('../src/server/observability/operationalEventsRepository.js');
  const event = { component: COMPONENTS.SMTP, code: 'SMTP_DELIVERY_FAILED', severity: 'ERROR', summary: 'Posta hatası', occurrenceCount: 1 };
  for (const [occurredAt, detail] of [['2026-09-12T12:00:00Z', 'yeni'], ['2026-09-12T10:00:00Z', 'gecikmiş'], ['2026-09-12T12:05:00Z', 'son']]) {
    const result = await persistOperationalEvents(pool, [{ ...event, occurredAt, detail }]);
    assert.equal(result.written, 1);
  }
  assert.equal(db.operationalEvents.length, 2);
  assert.equal(db.operationalEvents[0].OccurrenceCount, 2);
  assert.equal(db.operationalEvents[0].Detail, 'son');
  assert.equal(db.operationalEvents[1].OccurrenceCount, 1);
  assert.equal(db.operationalEvents[1].Detail, 'gecikmiş');
});

test('JWKS yoklaması başarılı HTTP yanıtında geçerli ve boş olmayan anahtar kümesi ister', async (t) => {
  stack(t);
  process.env.MERGEN_ROTA_AUTH_MODE = 'keycloak';
  process.env.MERGEN_ROTA_KEYCLOAK_JWKS_URL = 'https://identity.test/jwks';
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const { testIntegration } = await import('../src/server/observability/integrationsService.js');
  for (const [body, ok] of [['<html>login</html>', false], ['{}', false], ['{"keys":[]}', false], ['{"keys":[{"kty":"RSA","kid":"test"}]}', true]]) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    const outcome = await testIntegration(null, 'authentication');
    assert.equal(outcome.ok, ok, body);
    if (!ok) assert.equal(outcome.code, 'INVALID_JWKS');
  }
  globalThis.fetch = async () => new Response('', { status: 503 });
  assert.equal((await testIntegration(null, 'authentication')).code, 'HTTP_503');
});

test('SMTP ve Outlook yoklamaları geciken SMTP aşamalarında ortak süre sınırıyla kapanır', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    setTimeout(() => { if (!socket.destroyed) socket.write('220 test SMTP\r\n'); }, 30);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  stack(t, { outlookEnabled: true, smtpHost: '127.0.0.1', smtpPort: server.address().port });
  process.env.SMTP_TIMEOUT_MS = '1000';
  const nativeTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 6000) deadlines.push(ms);
    return nativeTimeout(callback, ms === 6000 ? 70 : ms, ...args);
  };
  t.after(() => { globalThis.setTimeout = nativeTimeout; });
  const { testIntegration } = await import('../src/server/observability/integrationsService.js');
  for (const id of ['smtp', 'outlook']) {
    const outcome = await testIntegration(null, id);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'PROBE_TIMEOUT');
    assert.ok(outcome.durationMs < 900);
  }
  assert.equal(deadlines.length, 2);
});

test('saklama birden fazla yığını temizler ve açık uyarıları korur', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  db.operationalEvents.push(...Array.from({ length: 12001 }, (_, id) => ({ OperationalEventId: id + 1, OccurredAt: old })));
  db.operationalAlerts.push({ OperationalAlertId: 1, AlertKey: 'APPLICATION:test', State: 'OPEN', LastSeenAt: old });
  const result = await runTelemetryCycle({ pool, retentionDueAt: 0 });
  assert.equal(result.retentionComplete, true);
  assert.ok(result.retentionDeleted >= 12001);
  assert.equal(db.operationalEvents.some((row) => row.OccurredAt === old), false);
  assert.equal(db.operationalAlerts[0].State, 'OPEN');
});

test('saklama yığın sınırına ulaştığında kalan işi sonraki tura bırakır', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  const request = pool.request.bind(pool);
  let deletes = 0;
  pool.request = () => {
    const req = request();
    const query = req.query.bind(req);
    req.query = async (text) => {
      if (text.includes('DELETE TOP (@batchSize)')) {
        deletes += 1;
        return { rowsAffected: [5000] };
      }
      return query(text);
    };
    return req;
  };
  const result = await runTelemetryCycle({ pool, retentionDueAt: 0 });
  assert.equal(result.retentionRan, true);
  assert.equal(result.retentionComplete, false);
  assert.equal(deletes, 80);
});

test('eksik gözlemlenebilirlik şeması başlangıç verisinden korunur', async (t) => {
  stack(t);
  const db = createFakeDatabase({ observabilitySchemaMissing: true });
  poolApi.setSqlDriverForTests(createFakeSqlServerDriver(db));
  poolApi.resetSqlPoolForTests();
  const pool = await poolApi.getSqlPool();
  const { OPERATIONAL_EVENT_PAGE_SQL } = await import('../src/server/observability/telemetryQueries.js');
  await assert.rejects(pool.request().query(OPERATIONAL_EVENT_PAGE_SQL), (error) => error.number === 208);
  const { loadOperationalEvents } = await import('../src/server/observability/operationalEventsRepository.js');
  assert.equal((await loadOperationalEvents(pool)).schemaReady, false);
});

test('kuyruk yanıtı etkin yaş eşiğini taşır ve başarısız eylem hata olayı üretir', async (t) => {
  stack(t, { outlookEnabled: true });
  process.env.MERGEN_ROTA_ALERT_QUEUE_AGE_MINUTES = '42';
  const body = await (await queuesRoute.GET(request())).json();
  assert.equal(body.configuration.thresholds.queueAgeMinutes, 42);
  const action = await (await queuesRoute.POST(postRequest('http://localhost/api/mergen-rota/admin/system/queues', { action: 'outlook-run' }))).json();
  assert.equal(action.result.ok, false);
  assert.equal(action.ok, false);
  const events = drainOperationalEvents().events;
  assert.ok(events.some((event) => event.code === 'ADMIN_ACTION_FAILED' && event.severity === 'ERROR'));
  assert.equal(events.some((event) => event.code === 'ADMIN_ACTION_EXECUTED'), false);
});

test('olay birleştirme kilitleri okuma ve yazma boyunca aynı işlemde tutulur', async () => {
  const { OPERATIONAL_EVENT_INSERT_SQL: text } = await import('../src/server/observability/telemetryQueries.js');
  assert.match(text, /SET XACT_ABORT ON/);
  assert.ok(text.indexOf('BEGIN TRANSACTION') < text.indexOf('SELECT TOP (1)'));
  assert.ok(text.indexOf('COMMIT TRANSACTION') > text.indexOf('INSERT dbo.MR_OperationalEvents'));
  assert.match(text, /BEGIN CATCH\s+IF XACT_STATE\(\) <> 0 ROLLBACK TRANSACTION;\s+THROW;/);
});

test('zamanlanmış kaynak örneği olay döngüsü penceresini sıfırlar', async (t) => {
  stack(t);
  const key = Symbol.for('mergen-rota.resource-sample');
  const previous = globalThis[key];
  let resets = 0;
  globalThis[key] = { loopMonitor: { mean: 12000000, reset() { resets += 1; this.mean = NaN; } } };
  t.after(() => { globalThis[key] = previous; });
  const { readResourceMetrics } = await import('../src/server/observability/resourceMetrics.js');
  assert.equal(readResourceMetrics().eventLoopDelayMs.value, 12);
  assert.equal(resets, 0);
  await runTelemetryCycle({ pool: await poolApi.getSqlPool(), retentionDueAt: Number.MAX_SAFE_INTEGER });
  assert.equal(resets, 1);
  const { snapshotGauges } = await import('../src/server/observability/telemetryRegistry.js');
  const { GAUGE_KEYS } = await import('../src/domain/observability/metrics.js');
  assert.equal(snapshotGauges().find((row) => row.metricKey === GAUGE_KEYS.EVENT_LOOP_DELAY).avg, 12);
  assert.equal(readResourceMetrics().eventLoopDelayMs.available, false);
});

test('SMTP bağlantı devri sırasında kaçan iptal hemen uygulanır', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const controller = new AbortController();
  let registrations = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) {
      registrations += 1;
      if (registrations === 2) controller.abort();
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) { controller.signal.removeEventListener(...args); }
  };
  await assert.rejects(verifySmtpConnection({ host: '127.0.0.1', port: server.address().port, timeoutMs: 1000, useStartTls: false }, { signal }), (error) => error.code === 'SMTP_CONNECTION_FAILED');
  assert.equal(registrations, 2);
});

/* ── İnceleme bulgularının gerilemesi ─────────────────────── */

test('başarısız yönetici eylemi HTTP 200 değil 503 döndürür', async (t) => {
  stack(t, { outlookEnabled: true });
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-run' }));
  // SMTP yapılandırılmadığı için tur sorun bildirir. Yanıt HTTP 200 olursa
  // istemci isteği başarılı sayar ve rota ölçümü de sağlıklı görünürdü.
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.result.ok, false);
  // Gövde DEĞİŞMEZ: yönetici nedeni yine okur.
  assert.match(body.message, /sorun bildirildi/);
});

test('başarılı yönetici eylemi 200 döndürmeyi sürdürür', async (t) => {
  stack(t, { outlookEnabled: true, outlookRows: [pendingSubscription()] });
  const response = await queuesRoute.POST(postRequest('http://localhost/queues', { action: 'outlook-retry' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('alt çizgili olay kodu araması harfi harfine eşleşir', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  queueOperationalEvent({
    severity: EVENT_SEVERITIES.WARNING, component: COMPONENTS.APPLICATION,
    code: 'TELEMETRY_DATA_DROPPED', detail: 'sınır aşıldı'
  });
  queueOperationalEvent({ severity: EVENT_SEVERITIES.INFO, component: COMPONENTS.APPLICATION, code: 'APP_STARTED' });
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  // `_` boşlukla değiştirilirse arama başka bir dizgeye dönüşür ve eşleşen
  // kayıt HİÇ bulunamazdı.
  const found = await (await eventsRoute.GET(request('http://localhost/events?search=TELEMETRY_DATA_DROPPED'))).json();
  assert.equal(found.total, 1);
  assert.equal(found.events[0].code, 'TELEMETRY_DATA_DROPPED');
});

test('arama metakarakteri joker değil harf olarak aranır', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  const { upsertOperationalAlert } = await import('../src/server/observability/operationalEventsRepository.js');
  for (const [scope, summary] of [['A', 'HTTP_500 yanıtı'], ['B', 'HTTPX500 yanıtı'], ['C', 'yüzde 100 tamamlandı']]) {
    await upsertOperationalAlert(pool, {
      component: COMPONENTS.API, code: 'API_ERROR_RATE_HIGH', scope,
      severity: EVENT_SEVERITIES.ERROR, summary
    });
  }
  // `_` tek karakter jokeri olsaydı `HTTPX500` de eşleşirdi.
  const underscore = await (await eventsRoute.GET(request('http://localhost/events?search=HTTP_500'))).json();
  assert.deepEqual(underscore.alerts.map((alert) => alert.summary), ['HTTP_500 yanıtı']);
  // `%` her şeyi eşleştiren joker olsaydı üç uyarı da dönerdi.
  const percent = await (await eventsRoute.GET(request('http://localhost/events?search=%25'))).json();
  assert.deepEqual(percent.alerts, []);

  // Kalıp, metakarakteri ATMADAN kaçırır; sorgular `ESCAPE '\'` ile okur.
  const { likeSearchPattern } = await import('../src/server/observability/operationalEventsRepository.js');
  assert.equal(likeSearchPattern('HTTP_500'), '%HTTP\\_500%');
  assert.equal(likeSearchPattern('50%'), '%50\\%%');
  assert.equal(likeSearchPattern('   '), null);
  const { OPERATIONAL_ALERT_LIST_SQL, OPERATIONAL_EVENT_PAGE_SQL } = await import('../src/server/observability/telemetryQueries.js');
  for (const statement of [OPERATIONAL_ALERT_LIST_SQL, OPERATIONAL_EVENT_PAGE_SQL]) {
    for (const predicate of statement.match(/LIKE @search[^\n]*/g) || []) {
      assert.match(predicate, /LIKE @search ESCAPE '\\'/);
    }
  }
});

test('Yavaş İşlemler toplam süreye değil ortalama gecikmeye göre sıralanır', async (t) => {
  stack(t);
  const pool = await poolApi.getSqlPool();
  const bucketAt = Date.now() - 20 * 60 * 1000;
  // Hızlı ama YOĞUN uç: toplam süresi daha büyük.
  for (let index = 0; index < 200; index += 1) {
    recordOperation({ operation: 'api.snapshot', durationMs: 10, at: bucketAt });
  }
  // Düşük hacimli ama ÇOK YAVAŞ uç: toplam süre sıralamasında listeden düşerdi.
  for (let index = 0; index < 2; index += 1) {
    recordOperation({ operation: 'api.commit', durationMs: 900, at: bucketAt });
  }
  await runTelemetryCycle({ pool, now: Date.now(), retentionDueAt: Number.MAX_SAFE_INTEGER });

  const { loadOperationBreakdown } = await import('../src/server/observability/telemetryRepository.js');
  const breakdown = await loadOperationBreakdown(pool, {
    since: new Date(bucketAt - 3600000), until: new Date(), limit: 1
  });
  assert.deepEqual(breakdown.operations.map((row) => row.operation), ['api.commit']);
});

test('eksik telemetri SÜTUNU da eksik şema sayılır', async (t) => {
  stack(t);
  const { isMissingTelemetrySchema, persistTelemetryBuckets } = await import('../src/server/observability/telemetryRepository.js');
  const columnError = Object.assign(new Error("Invalid column name 'InstanceId'."), { number: 207 });
  assert.equal(isMissingTelemetrySchema(columnError), true);
  // Başka bir tablonun sütunu telemetri şeması sayılmaz.
  assert.equal(isMissingTelemetrySchema(Object.assign(new Error("Invalid column name 'Sicil'."), { number: 207 })), false);

  // Yarım uygulanmış göçte yazma FIRLATMAZ, durumu bildirir.
  const failing = { request: () => ({ input() {}, query: () => { throw columnError; } }) };
  const outcome = await persistTelemetryBuckets(failing, {
    operations: [{ bucketStart: Date.now(), operation: 'api.snapshot', flushId: 'f1', count: 1, avgMs: 10, maxMs: 10 }],
    gauges: []
  });
  assert.equal(outcome.schemaReady, false);
  assert.equal(outcome.error, null);
});

test('bekleyen teslimat listesi eşit denemede en eski kaydı önce verir', async (t) => {
  const older = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const newer = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  stack(t, {
    outlookEnabled: true,
    outlookRows: [
      pendingSubscription({ SubscriptionId: 11, CalendarUid: 'uid-yeni', AttemptCount: 2, UpdatedAt: newer }),
      pendingSubscription({ SubscriptionId: 12, CalendarUid: 'uid-eski', AttemptCount: 2, UpdatedAt: older })
    ]
  });
  const body = await (await queuesRoute.GET(request('http://localhost/queues'))).json();
  // Üretim `AttemptCount DESC, UpdatedAt ASC` sıralar; eşit denemede ekleme
  // sırası değil YAŞ belirleyicidir.
  assert.deepEqual(body.outlook.items.map((item) => item.lastChangedAt), [older, newer]);
});

test('kapanmış kovadaki hatalar API uyarısını açar', async (t) => {
  const db = stack(t);
  const pool = await poolApi.getSqlPool();
  const bucket = Math.floor(Date.now() / 300000) * 300000;
  // Kova KAPANMIŞTIR (geçerli kovadan önce) ama 15 dakikalık pencerenin
  // içindedir: boşaltmadan sonra okunan özet bu hataları hiç görmezdi.
  for (const [now, at] of [[bucket + 60000, bucket - 300000], [bucket + 120000, bucket - 300000]]) {
    for (let index = 0; index < 40; index += 1) {
      recordOperation({ operation: 'api.commit', durationMs: 20, ok: index % 4 !== 0, at });
    }
    await runTelemetryCycle({ pool, now, retentionDueAt: Number.MAX_SAFE_INTEGER });
  }
  assert.ok(db.operationalAlerts.some((alert) => alert.EventCode === 'API_ERROR_RATE_HIGH'),
    'kapanmış kovadaki hata oranı uyarıyı açmalıdır');
});

test('ilk turu takılı kalan Outlook çalışanı bilinmiyor değil kritik bildirilir', async (t) => {
  stack(t, { outlookEnabled: true });
  const key = Symbol.for('mergen-rota.outlook-worker');
  const previous = globalThis[key];
  t.after(() => { globalThis[key] = previous; });
  const workerStatus = (runStartedAt) => ({
    status: () => ({ started: true, running: true, intervalMs: 5000, runStartedAt, lastFinishedAt: null, lastResult: null })
  });
  const { probeOutlook } = await import('../src/server/observability/healthProbes.js');
  const pool = await poolApi.getSqlPool();

  // Nabız sınırı içindeki ilk tur BEKLENİR: durum bilinmiyordur.
  globalThis[key] = workerStatus(new Date(Date.now() - 10000).toISOString());
  const grace = await probeOutlook(pool);
  assert.equal(grace.state, HEALTH_STATES.UNKNOWN);
  assert.equal(grace.detail.worker.heartbeatStale, false);

  // Sınırı aşan ilk tur artık bayat nabızdır.
  globalThis[key] = workerStatus(new Date(Date.now() - 5 * 60 * 1000).toISOString());
  const stale = await probeOutlook(pool);
  assert.equal(stale.state, HEALTH_STATES.CRITICAL);
  assert.equal(stale.detail.worker.heartbeatStale, true);
});

test('SQL yoklamasının süre aşımı PROBE_TIMEOUT olarak bildirilir', async (t) => {
  stack(t);
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => nativeTimeout(callback, ms === 5000 ? 40 : ms, ...args);
  // Yoklamanın süre sayacı `unref` edilir; askıda bekleyen sorgu da olay
  // döngüsünü ayakta tutmaz. Sayaç ateşlenene kadar döngü açık kalmalıdır.
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => { globalThis.setTimeout = nativeTimeout; clearInterval(keepAlive); });
  const { testIntegration } = await import('../src/server/observability/integrationsService.js');
  const hanging = { request: () => ({ query: () => new Promise(() => {}), cancel() {} }) };
  const outcome = await testIntegration(hanging, 'database');
  clearInterval(keepAlive);
  assert.equal(outcome.ok, false);
  // İptal `Error('PROBE_TIMEOUT')` ile reddedilir; hata ADINA bakan bir kod
  // kartta ve son hata kodunda `Error` gösterirdi.
  assert.equal(outcome.code, 'PROBE_TIMEOUT');
});

test('Outlook çalışanı süren turun başlangıç anını bildirir', async (t) => {
  const { createOutlookWorker } = await import('../src/server/outlook/outlookWorker.js');
  let finish;
  const worker = createOutlookWorker({
    run: () => new Promise((resolve) => { finish = resolve; }),
    enabled: () => true,
    intervalMs: 60000
  });
  t.after(() => worker.stop());
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(worker.status().running, true);
  assert.ok(worker.status().runStartedAt, 'süren turun başlangıcı bildirilmelidir');
  finish({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(worker.status().runStartedAt, null, 'tamamlanan tur başlangıç anını bırakır');
  assert.ok(worker.status().lastFinishedAt);
});
