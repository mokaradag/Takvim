/**
 * Sistem Yönetimi · gözlemlenebilirlik modeli.
 *
 * Sağlık toplaması, ölçüm matematiği, temizleme kuralları, uyarı kuralları ve
 * bellek içi toplayıcı VERİTABANI OLMADAN sınanır: kurallar saf işlevlerdir ve
 * davranışları platformdan bağımsız olmalıdır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const {
  HEALTH_STATES,
  aggregateHealthState,
  describeComponent,
  healthLabel,
  isStale,
  summarizeHealth,
  worseHealthState
} = await import('../src/domain/observability/healthModel.js');
const {
  ALERT_STATES,
  COMPONENTS,
  EVENT_CODES,
  EVENT_SEVERITIES,
  alertKey,
  componentTab,
  eventAction,
  normalizeSeverity,
  severityToHealthState
} = await import('../src/domain/observability/eventModel.js');
const {
  BASELINE_MIN_SAMPLES,
  bucketStart,
  compareToBaseline,
  formatBytes,
  formatDuration,
  formatPercent,
  formatUptime,
  mergeBucketSummaries,
  percentile,
  summarizeDurations,
  timeRange
} = await import('../src/domain/observability/metrics.js');
const {
  REDACTED,
  maskEmailAddresses,
  sanitizeContext,
  sanitizeError,
  sanitizeText
} = await import('../src/domain/observability/redaction.js');
const {
  deriveAlertConditions,
  deriveUnmeasuredAlertKeys,
  evaluateAlertTransitions,
  parseAlertKey,
  resetAlertTrackerForTests
} = await import('../src/server/observability/alertRules.js');
const {
  TELEMETRY_LIMITS,
  consumeTelemetryLossCounters,
  drainClosedBuckets,
  recordFeedEntry,
  recordGauge,
  recordOperation,
  recentFeed,
  resetTelemetryRegistryForTests,
  snapshotGauges,
  snapshotOperations,
  spoolUnpersistedBuckets,
  spooledBucketCount
} = await import('../src/server/observability/telemetryRegistry.js');
const { observePhase, recordPhaseDuration } = await import('../src/server/observability/observeOperation.js');
const { buildAttentionItems } = await import('../src/server/observability/systemHealthService.js');
const { boundedExecutor } = await import('../src/server/observability/boundedExecution.js');
const { normalizeGauge, readResourceMetrics } = await import('../src/server/observability/resourceMetrics.js');
const { applicationInstanceId } = await import('../src/server/observability/observabilityConfig.js');
const { buildLogRecord } = await import('../src/server/observability/structuredLogger.js');
const {
  isDataStale,
  mergeResourceState,
  shouldPoll,
  shouldRefreshOnReturn,
  staleAfterMs
} = await import('../src/features/system-admin/adminPolling.js');
const {
  DEFAULT_SYSTEM_ADMIN_TAB,
  SYSTEM_ADMIN_TABS,
  isSystemAdminTab,
  nextSystemAdminTab,
  readStoredSystemAdminTab,
  writeStoredSystemAdminTab
} = await import('../src/features/system-admin/systemAdminTabs.js');
const {
  baselineNarrative,
  formatMetricValue,
  healthNarrative,
  stalenessNotice
} = await import('../src/features/system-admin/systemAdminPresentation.js');

/* ── Sağlık toplaması ─────────────────────────────────────── */

test('bütün bileşenler sağlıklıyken genel durum sağlıklıdır', () => {
  const components = [
    { key: 'A', state: HEALTH_STATES.HEALTHY },
    { key: 'B', state: HEALTH_STATES.HEALTHY }
  ];
  assert.equal(aggregateHealthState(components), HEALTH_STATES.HEALTHY);
  assert.equal(summarizeHealth(components).counts.healthy, 2);
});

test('ağırlık önceliği kritik > uyarı > bilinmiyor > sağlıklı sırasını korur', () => {
  const base = { key: 'A', state: HEALTH_STATES.HEALTHY };
  assert.equal(aggregateHealthState([base, { key: 'B', state: HEALTH_STATES.UNKNOWN }]), HEALTH_STATES.UNKNOWN);
  assert.equal(aggregateHealthState([base, { key: 'B', state: HEALTH_STATES.UNKNOWN }, { key: 'C', state: HEALTH_STATES.WARNING }]), HEALTH_STATES.WARNING);
  assert.equal(aggregateHealthState([
    base,
    { key: 'B', state: HEALTH_STATES.WARNING },
    { key: 'C', state: HEALTH_STATES.CRITICAL }
  ]), HEALTH_STATES.CRITICAL);
  assert.equal(worseHealthState(HEALTH_STATES.WARNING, HEALTH_STATES.UNKNOWN), HEALTH_STATES.WARNING);
});

test('veri alınamaması sağlık sayılmaz: boş küme ve tanınmayan durum bilinmiyordur', () => {
  assert.equal(aggregateHealthState([]), HEALTH_STATES.UNKNOWN);
  assert.equal(aggregateHealthState([{ key: 'A', state: 'SOMETHING_ELSE' }]), HEALTH_STATES.UNKNOWN);
  // Yapılandırılmamış bileşen toplam sağlığı DÜŞÜRMEZ ama tek başına da
  // "sağlıklı" üretmez.
  assert.equal(aggregateHealthState([{ key: 'A', state: HEALTH_STATES.NOT_CONFIGURED }]), HEALTH_STATES.UNKNOWN);
  assert.equal(aggregateHealthState([
    { key: 'A', state: HEALTH_STATES.NOT_CONFIGURED },
    { key: 'B', state: HEALTH_STATES.HEALTHY }
  ]), HEALTH_STATES.HEALTHY);
});

test('bayatlık ölçülebildiğinde bildirilir, ölçülemediğinde "bilinmiyor" kalır', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(isStale('2026-01-01T11:00:00.000Z', now, 90000), true);
  assert.equal(isStale('2026-01-01T11:59:59.000Z', now, 90000), false);
  assert.equal(isStale(null, now, 90000), null);

  const stale = describeComponent({ key: 'db', label: 'SQL', state: HEALTH_STATES.HEALTHY, lastCheckedAt: '2026-01-01T11:00:00.000Z' }, { now });
  assert.equal(stale.stale, true);
  // Bayat bilgi durumu düşürmez; son bilinen değer ile güncel sağlık AYRI
  // bilgilerdir.
  assert.equal(stale.state, HEALTH_STATES.HEALTHY);
  assert.equal(stale.stateLabel, 'Sağlıklı');
  assert.equal(healthLabel(HEALTH_STATES.UNKNOWN), 'Bilinmiyor');
  assert.equal(describeComponent({ key: 'x' }).state, HEALTH_STATES.UNKNOWN);
});

/* ── Ölçüm matematiği ─────────────────────────────────────── */

test('yüzdelikler en yakın sıra yöntemiyle hesaplanır', () => {
  const samples = Array.from({ length: 100 }, (unused, index) => index + 1);
  assert.equal(percentile(samples, 0.5), 50);
  assert.equal(percentile(samples, 0.95), 95);
  assert.equal(percentile(samples, 0.99), 99);
  const summary = summarizeDurations([10, 20, 30, 40]);
  assert.equal(summary.count, 4);
  assert.equal(summary.p50Ms, 20);
  assert.equal(summary.maxMs, 40);
  assert.equal(summary.avgMs, 25);
});

test('alt faz ölçümü kararlı bir işlem adıyla toplam rota ölçümünden ayrı tutulur', async (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);

  const value = await observePhase('phase.snapshot.main-query', async () => 42);
  assert.equal(value, 42);

  const row = snapshotOperations().find((entry) => entry.operation === 'phase.snapshot.main-query');
  assert.equal(row?.count, 1);
  assert.equal(row?.errorCount, 0);
  assert.equal(row?.operation.startsWith('api.'), false);
});

test('sunucuda ölçülmüş alt faz süresi aynı toplayıcıya yazılır', async (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);

  // SQL toplu işinin kendi ölçtüğü aşama süreleri: ölçüm ZATEN yapılmıştır,
  // kayıt yolu yine `observePhase` ile aynı toplayıcıdır.
  recordPhaseDuration('phase.snapshot.main-query.sql.scope', 12);
  recordPhaseDuration('phase.snapshot.main-query.sql.scope', 8);
  // Geçersiz ve eksi değerler ölçümü bozmaz.
  recordPhaseDuration('phase.snapshot.main-query.sql.scope', null);
  recordPhaseDuration('phase.snapshot.main-query.sql.directory', -5);

  const scope = snapshotOperations().find((entry) => entry.operation === 'phase.snapshot.main-query.sql.scope');
  assert.equal(scope?.count, 2);
  assert.equal(scope?.errorCount, 0);
  assert.equal(scope?.maxMs, 12);
  const directory = snapshotOperations().find((entry) => entry.operation === 'phase.snapshot.main-query.sql.directory');
  assert.equal(directory?.count, 1);
  assert.equal(directory?.maxMs, 0);
  // Adlar `api.` ile başlamaz: API yüzdeliklerini ve hata oranını şişirmezler.
  for (const entry of snapshotOperations()) assert.equal(entry.operation.startsWith('api.'), false);
});

test('boş örnek kümesi sıfır değil "ölçüm yok" üretir', () => {
  const summary = summarizeDurations([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.p95Ms, null);
  assert.equal(summary.avgMs, null);
  assert.equal(percentile([], 0.5), null);
  // Geçersiz örnekler elenir, kalanlar hesaplanır.
  assert.equal(summarizeDurations([NaN, -5, 'x', 12]).count, 1);
});

test('kova özetleri ağırlıklı olarak birleşir ve hata oranı türetilir', () => {
  const merged = mergeBucketSummaries([
    { count: 10, errorCount: 1, avgMs: 100, maxMs: 200, p50Ms: 90, p95Ms: 180, p99Ms: 195 },
    { count: 30, errorCount: 3, avgMs: 200, maxMs: 400, p50Ms: 190, p95Ms: 380, p99Ms: 395 }
  ]);
  assert.equal(merged.count, 40);
  assert.equal(merged.errorCount, 4);
  assert.equal(merged.errorRate, 0.1);
  assert.equal(merged.maxMs, 400);
  assert.equal(merged.p95Ms, (180 * 10 + 380 * 30) / 40);
  assert.equal(mergeBucketSummaries([]).count, 0);
  assert.equal(mergeBucketSummaries([]).errorRate, null);
});

test('zaman aralıkları sınırlıdır ve kovalar hizalanır', () => {
  assert.equal(timeRange('7d').id, '7d');
  // Tanınmayan aralık serbest bir pencere AÇMAZ; varsayılana düşer.
  assert.equal(timeRange('999y').id, '24h');
  assert.equal(timeRange(undefined).id, '24h');
  const aligned = bucketStart(Date.parse('2026-01-01T12:07:31.000Z'), 5 * 60 * 1000);
  assert.equal(new Date(aligned).toISOString(), '2026-01-01T12:05:00.000Z');
  assert.equal(bucketStart('abc'), null);
});

test('temel karşılaştırması yetersiz örnekte yapılmaz', () => {
  assert.equal(compareToBaseline(800, 600, { baselineSamples: BASELINE_MIN_SAMPLES - 1 }), null);
  // Eşik GÜNCEL pencere için de geçerlidir: az örnekli bir pencereden çıkarılan
  // yüzde, kutucukta gerçek bir değişim gibi görünürdü.
  assert.equal(
    compareToBaseline(800, 600, { baselineSamples: 100, currentSamples: BASELINE_MIN_SAMPLES - 1 }),
    null
  );
  const comparison = compareToBaseline(820, 610, { baselineSamples: 100, currentSamples: 100 });
  assert.equal(comparison.direction, 'up');
  assert.ok(Math.abs(comparison.changeRatio - 0.344) < 0.01);
  // Ölçülemeyen güncel değer karşılaştırılmaz; `Number(null)` sıfır olup
  // "-%100" gibi uydurma bir kötüleşme üretirdi.
  assert.equal(compareToBaseline(null, 610, { baselineSamples: 100 }), null);
  // Sıfır taban: oran tanımsızdır ama "hata yoktu, şimdi var" gizlenmez.
  const fromZero = compareToBaseline(600, 0, { baselineSamples: 100 });
  assert.equal(fromZero.direction, 'up');
  assert.equal(fromZero.changeRatio, null);
  assert.equal(compareToBaseline(0, 0, { baselineSamples: 100 }).direction, 'flat');
  assert.match(baselineNarrative(comparison, { unit: 'ms' }), /7 günlük baz/);
  assert.match(baselineNarrative(fromZero, { unit: 'ratio' }), /yeni oluştu/);
  assert.equal(baselineNarrative(null), '');
});

test('biçimlendiriciler ölçülemeyen değeri sıfır gibi göstermez', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(950), '950 ms');
  assert.match(formatDuration(65000), /1 dk 05 sn/);
  assert.equal(formatBytes(null), '—');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatUptime(null), '—');
  assert.equal(formatMetricValue(null, 'ms'), '—');
  assert.equal(formatMetricValue('3 dk önce', 'raw'), '3 dk önce');
});

/* ── Temizleme ────────────────────────────────────────────── */

test('duyarlı alan adları değerine bakılmadan maskelenir', () => {
  const context = sanitizeContext({
    smtpPassword: 'sirlar',
    SMTP_PASSWORD: 'sirlar',
    authorization: 'Bearer abc',
    cookie: 'session=1',
    connectionString: 'Server=x;Password=y;',
    token: 'abc',
    safeValue: 12
  });
  for (const key of ['smtpPassword', 'SMTP_PASSWORD', 'authorization', 'cookie', 'connectionString', 'token']) {
    assert.equal(context[key], REDACTED, key);
  }
  assert.equal(context.safeValue, 12);
  assert.doesNotMatch(JSON.stringify(context), /sirlar|session=1|Server=x/);
});

test('duyarlı desen taşıyan metin anahtarı masum olsa da gizlenir', () => {
  assert.equal(sanitizeText('password=hunter2'), REDACTED);
  assert.equal(sanitizeText('Server=sql01;Database=X;User ID=sa;'), REDACTED);
  assert.equal(sanitizeText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh'), REDACTED);
  assert.equal(maskEmailAddresses('kisi@kurum.local'), 'k***@kurum.local');
  assert.equal(sanitizeText('Alıcı: kisi@kurum.local'), 'Alıcı: k***@kurum.local');
});

test('hata özeti yığın izi taşımaz', () => {
  const error = new Error('SMTP_HOST=mail.local password=gizli');
  error.code = 'SMTP_SEND_FAILED';
  const safe = sanitizeError(error);
  assert.equal(safe.code, 'SMTP_SEND_FAILED');
  assert.equal(safe.message, REDACTED);
  assert.equal('stack' in safe, false);
  assert.equal(sanitizeError(null), null);
});

test('yapılandırılmış günlük satırı beklenen alanları taşır ve gizli veri sızdırmaz', () => {
  const record = buildLogRecord({
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.SMTP,
    operation: 'background.reminders.run',
    code: 'SMTP_SEND_FAILED',
    message: 'Gönderim başarısız',
    correlationId: 'abcd-1234-efgh',
    durationMs: 1234.6,
    context: { recipient: 'kisi@kurum.local', smtpPassword: 'gizli' },
    now: new Date('2026-01-01T00:00:00.000Z')
  });
  assert.deepEqual(Object.keys(record).sort(), [
    'code', 'component', 'context', 'correlationId', 'durationMs', 'level', 'message', 'operation', 'timestamp'
  ]);
  assert.equal(record.durationMs, 1235);
  assert.equal(record.context.smtpPassword, REDACTED);
  assert.equal(record.context.recipient, 'k***@kurum.local');
  assert.doesNotMatch(JSON.stringify(record), /gizli|kisi@kurum/);
});

/* ── Olay modeli ──────────────────────────────────────────── */

test('olay kodları kararlıdır ve bileşen sekmesiyle eşlenir', () => {
  assert.equal(EVENT_CODES.DATABASE_UNAVAILABLE.severity, EVENT_SEVERITIES.CRITICAL);
  assert.equal(normalizeSeverity('SOMETHING'), EVENT_SEVERITIES.INFO);
  assert.equal(severityToHealthState(EVENT_SEVERITIES.CRITICAL), HEALTH_STATES.CRITICAL);
  assert.equal(severityToHealthState(EVENT_SEVERITIES.ERROR), HEALTH_STATES.WARNING);
  assert.equal(severityToHealthState(EVENT_SEVERITIES.INFO), HEALTH_STATES.HEALTHY);
  assert.equal(componentTab(COMPONENTS.OUTLOOK), 'kuyruklar');
  assert.ok(eventAction('OUTLOOK_QUEUE_AGING'));
  assert.equal(ALERT_STATES.OPEN, 'OPEN');
});

test('uyarı anahtarı aynı koşul için kararlıdır ve kapsamla ayrışır', () => {
  assert.equal(alertKey(COMPONENTS.SMTP, 'SMTP_DELIVERY_FAILED'), 'SMTP:SMTP_DELIVERY_FAILED');
  assert.equal(alertKey(COMPONENTS.SMTP, 'SMTP_DELIVERY_FAILED', 'host-a'), 'SMTP:SMTP_DELIVERY_FAILED:host-a');
  assert.deepEqual(parseAlertKey('SMTP:SMTP_DELIVERY_FAILED:host-a'), {
    component: 'SMTP', code: 'SMTP_DELIVERY_FAILED', scope: 'host-a'
  });
});

/* ── Uyarı kuralları ──────────────────────────────────────── */

function componentsWith(overrides = {}) {
  return [
    { key: COMPONENTS.DATABASE, state: HEALTH_STATES.HEALTHY, message: 'ok', durationMs: 10 },
    { key: COMPONENTS.OUTLOOK, state: HEALTH_STATES.HEALTHY, message: 'ok', detail: { queue: {}, worker: { started: true } } },
    ...Object.entries(overrides).map(([key, value]) => ({ key, ...value }))
  ].filter((component, index, all) => all.findIndex((entry) => entry.key === component.key) === index);
}

test('eşik aşıldığında uyarı koşulu üretilir, altında üretilmez', () => {
  const thresholds = { errorRate: 0.05, latencyP95Ms: 1500 };
  const high = deriveAlertConditions({
    components: componentsWith(),
    apiSummary: { count: 100, errorCount: 20, errorRate: 0.2, p95Ms: 2500 },
    thresholds
  });
  assert.deepEqual(high.map((item) => item.code).sort(), ['API_ERROR_RATE_HIGH', 'API_LATENCY_HIGH']);

  const calm = deriveAlertConditions({
    components: componentsWith(),
    apiSummary: { count: 100, errorCount: 1, errorRate: 0.01, p95Ms: 300 },
    thresholds
  });
  assert.deepEqual(calm, []);
});

test('birkaç isteklik pencere eşik uyarısı üretmez', () => {
  const conditions = deriveAlertConditions({
    components: componentsWith(),
    apiSummary: { count: 3, errorCount: 3, errorRate: 1, p95Ms: 9000 },
    thresholds: { errorRate: 0.05, latencyP95Ms: 1500 }
  });
  assert.deepEqual(conditions, []);
});

test('kritik veritabanı ve eksik kimlik yapılandırması kritik uyarı üretir', () => {
  const conditions = deriveAlertConditions({
    components: [
      { key: COMPONENTS.DATABASE, state: HEALTH_STATES.CRITICAL, message: 'ulaşılamadı' },
      { key: COMPONENTS.AUTHENTICATION, state: HEALTH_STATES.CRITICAL, message: 'eksik', detail: { missing: ['X'] } }
    ]
  });
  assert.deepEqual(conditions.map((item) => item.code), ['DATABASE_UNAVAILABLE', 'AUTHENTICATION_MISCONFIGURED']);
  assert.ok(conditions.every((item) => item.severity === EVENT_SEVERITIES.CRITICAL));
});

test('çırpınma koruması: koşul açılmadan önce üst üste gözlenmelidir', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const condition = [{ key: 'DATABASE:DATABASE_UNAVAILABLE', component: COMPONENTS.DATABASE, code: 'DATABASE_UNAVAILABLE', severity: EVENT_SEVERITIES.CRITICAL, summary: 'x' }];

  const first = evaluateAlertTransitions(condition, { requiredObservations: 2 });
  assert.deepEqual(first.open, []);
  assert.equal(first.pending.length, 1);

  const second = evaluateAlertTransitions(condition, { requiredObservations: 2 });
  assert.equal(second.open.length, 1);

  // Tek temiz gözlem uyarıyı KAPATMAZ.
  const recovering = evaluateAlertTransitions([], { requiredObservations: 2 });
  assert.deepEqual(recovering.resolve, []);

  const recovered = evaluateAlertTransitions([], { requiredObservations: 2 });
  assert.deepEqual(recovered.resolve, ['DATABASE:DATABASE_UNAVAILABLE']);

  // Çözülmüş koşul yeniden görülürse sayaç sıfırdan başlar.
  assert.deepEqual(evaluateAlertTransitions(condition, { requiredObservations: 2 }).open, []);
});

test('yinelenen koşul aynı anahtar altında toplanır, yeni uyarı açmaz', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const condition = [{ key: 'SMTP:SMTP_DELIVERY_FAILED', component: COMPONENTS.SMTP, code: 'SMTP_DELIVERY_FAILED', severity: EVENT_SEVERITIES.ERROR, summary: 'x' }];
  evaluateAlertTransitions(condition, { requiredObservations: 1 });
  const repeated = evaluateAlertTransitions(condition, { requiredObservations: 1 });
  assert.equal(repeated.open.length, 1);
  assert.equal(new Set(repeated.open.map((item) => item.key)).size, 1);
});

/* ── Bellek içi toplayıcı ─────────────────────────────────── */

test('işlem gözlemleri kovalara toplanır ve yüzdelikler hesaplanır', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const at = Date.parse('2026-01-01T10:02:00.000Z');
  for (let index = 1; index <= 100; index += 1) {
    recordOperation({ operation: 'api.commit', durationMs: index, ok: index % 10 !== 0, code: 'HTTP_500', at });
  }
  const rows = snapshotOperations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 100);
  assert.equal(rows[0].errorCount, 10);
  assert.equal(rows[0].errorRate, 0.1);
  assert.equal(rows[0].p50Ms, 50);
  assert.equal(rows[0].topFailureCode, 'HTTP_500');
});

test('toplayıcı sınırlıdır: işlem adı ve örnek sayısı sınırı aşılmaz', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const at = Date.parse('2026-01-01T10:02:00.000Z');
  for (let index = 0; index < TELEMETRY_LIMITS.MAX_OPERATIONS_PER_BUCKET + 40; index += 1) {
    recordOperation({ operation: `api.op-${index}`, durationMs: 5, at });
  }
  assert.equal(snapshotOperations().length, TELEMETRY_LIMITS.MAX_OPERATIONS_PER_BUCKET);

  for (let index = 0; index < TELEMETRY_LIMITS.MAX_SAMPLES_PER_OPERATION * 3; index += 1) {
    recordOperation({ operation: 'api.op-0', durationMs: index, at });
  }
  const row = snapshotOperations().find((entry) => entry.operation === 'api.op-0');
  assert.equal(row.sampleCount, TELEMETRY_LIMITS.MAX_SAMPLES_PER_OPERATION);
  // Sayaçlar örnek sınırından ETKİLENMEZ: yalnızca ayrıntı seyrelir.
  assert.equal(row.count, TELEMETRY_LIMITS.MAX_SAMPLES_PER_OPERATION * 3 + 1);
});

test('yalnızca KAPANMIŞ kovalar devredilir; güncel kova bellekte kalır', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const now = Date.parse('2026-01-01T10:07:00.000Z');
  recordOperation({ operation: 'api.snapshot', durationMs: 40, at: Date.parse('2026-01-01T10:01:00.000Z') });
  recordOperation({ operation: 'api.snapshot', durationMs: 60, at: now });
  recordGauge('process.rss', 1024, now);

  const drained = drainClosedBuckets(now);
  assert.equal(drained.operations.length, 1);
  assert.equal(drained.operations[0].count, 1);
  assert.equal(snapshotOperations().length, 1);
  assert.equal(snapshotGauges().length, 1);
});

test('akış halkası sınırlıdır ve en yeni satırı başta tutar', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  for (let index = 0; index < TELEMETRY_LIMITS.MAX_RECENT_EVENTS + 20; index += 1) {
    recordFeedEntry({ severity: 'INFO', component: 'APPLICATION', code: 'APP_STARTED', summary: `olay-${index}` });
  }
  const feed = recentFeed(TELEMETRY_LIMITS.MAX_RECENT_EVENTS + 50);
  assert.equal(feed.length, TELEMETRY_LIMITS.MAX_RECENT_EVENTS);
  // EN YENİ satır başta olmalıdır; "olay-\d+" kalıbı her satıra uyduğu için
  // halka ters sırada dönse bile geçerdi.
  const last = TELEMETRY_LIMITS.MAX_RECENT_EVENTS + 20 - 1;
  assert.equal(feed[0].summary, `olay-${last}`);
  assert.equal(feed.at(-1).summary, `olay-${last - TELEMETRY_LIMITS.MAX_RECENT_EVENTS + 1}`);
});

/* ── Kaynak ölçümleri ─────────────────────────────────────── */

test('ölçülemeyen kaynak değeri uydurulmaz', () => {
  assert.deepEqual(normalizeGauge(null, { unit: 'ms' }), { available: false, value: null, unit: 'ms' });
  assert.deepEqual(normalizeGauge(Number.NaN, { unit: '%' }), { available: false, value: null, unit: '%' });
  assert.deepEqual(normalizeGauge(12, { unit: 'bytes' }), { available: true, value: 12, unit: 'bytes' });
  assert.deepEqual(normalizeGauge(12, { unit: 'bytes', available: false }), { available: false, value: null, unit: 'bytes' });
});

test('kaynak anlık görüntüsü platformdan bağımsız bir sözleşme döndürür', () => {
  const metrics = readResourceMetrics();
  for (const key of ['uptimeSeconds', 'rss', 'heapUsed', 'heapTotal', 'cpuPercent', 'eventLoopDelayMs', 'hostLoadAverage']) {
    assert.equal(typeof metrics[key].available, 'boolean', key);
    assert.ok(metrics[key].available ? Number.isFinite(metrics[key].value) : metrics[key].value === null, key);
  }
  assert.equal(typeof metrics.platform, 'string');
  // İlk okumada CPU oranı HESAPLANAMAZ: tek bir `cpuUsage()` okuması süreç ömrü
  // boyunca toplam CPU'yu verir, anlık kullanım değil. Sunucu belleği oranına
  // bakan eski sav, uydurulmuş bir CPU yüzdesini yakalamazdı.
  assert.equal(metrics.cpuPercent.available, false);
  assert.equal(metrics.cpuPercent.value, null);
});

/* ── Yoklama kuralları ────────────────────────────────────── */

test('gizli sekmede yoklama durur, süren istek ikinciyi engeller', () => {
  assert.equal(shouldPoll({ hidden: false, enabled: true, inFlight: false }), true);
  assert.equal(shouldPoll({ hidden: true, enabled: true, inFlight: false }), false);
  assert.equal(shouldPoll({ hidden: false, enabled: true, inFlight: true }), false);
  assert.equal(shouldPoll({ hidden: false, enabled: false, inFlight: false }), false);
});

test('sekmeye dönüldüğünde yalnızca bayat veri hemen tazelenir', () => {
  const now = Date.parse('2026-01-01T10:00:00.000Z');
  const fresh = now - 5000;
  const old = now - staleAfterMs(10000) - 1000;
  assert.equal(shouldRefreshOnReturn({ hidden: false, lastUpdatedAt: fresh, now, intervalMs: 10000 }), false);
  assert.equal(shouldRefreshOnReturn({ hidden: false, lastUpdatedAt: old, now, intervalMs: 10000 }), true);
  assert.equal(shouldRefreshOnReturn({ hidden: true, lastUpdatedAt: old, now, intervalMs: 10000 }), false);
  assert.equal(shouldRefreshOnReturn({ hidden: false, lastUpdatedAt: null, now, intervalMs: 10000 }), true);
  assert.equal(isDataStale({ lastUpdatedAt: null, now, intervalMs: 10000 }), false);
});

test('geçici hata son geçerli durumu silmez ve tazelik damgasını ilerletmez', () => {
  const now = 1000;
  const success = mergeResourceState({}, { ok: true, state: 'HEALTHY' }, { now });
  assert.equal(success.data.state, 'HEALTHY');
  assert.equal(success.lastUpdatedAt, now);

  const failure = mergeResourceState(success, { ok: false, code: 'NETWORK', message: 'yok' }, { now: 5000 });
  assert.equal(failure.data.state, 'HEALTHY');
  assert.equal(failure.lastUpdatedAt, now);
  assert.equal(failure.error.code, 'NETWORK');
  assert.equal(failure.failureCount, 1);

  const recovered = mergeResourceState(failure, { ok: true, state: 'WARNING' }, { now: 9000 });
  assert.equal(recovered.error, null);
  assert.equal(recovered.failureCount, 0);
  assert.equal(recovered.lastUpdatedAt, 9000);
});

/* ── Sekme davranışı ──────────────────────────────────────── */

test('sekme kimlikleri benzersizdir ve klavye gezinmesi uçlarda sarar', () => {
  const ids = SYSTEM_ADMIN_TABS.map((tab) => tab.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 6);
  assert.equal(nextSystemAdminTab(ids[0], 'ArrowLeft'), ids[ids.length - 1]);
  assert.equal(nextSystemAdminTab(ids[ids.length - 1], 'ArrowRight'), ids[0]);
  assert.equal(nextSystemAdminTab(ids[2], 'Home'), ids[0]);
  assert.equal(nextSystemAdminTab(ids[2], 'End'), ids[ids.length - 1]);
  assert.equal(nextSystemAdminTab(ids[0], 'Enter'), null);
  assert.equal(isSystemAdminTab('bilinmeyen'), false);
});

test('etkin sekme yenilemeler arasında korunur; bozuk değer varsayılana düşer', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, value)
  };
  assert.equal(readStoredSystemAdminTab(storage), DEFAULT_SYSTEM_ADMIN_TAB);
  writeStoredSystemAdminTab(storage, 'kuyruklar');
  assert.equal(readStoredSystemAdminTab(storage), 'kuyruklar');
  writeStoredSystemAdminTab(storage, 'hatali-deger');
  assert.equal(readStoredSystemAdminTab(storage), 'kuyruklar');
  // Saklama alanı yoksa akış çökmez.
  assert.equal(readStoredSystemAdminTab(null), DEFAULT_SYSTEM_ADMIN_TAB);
});

/* ── Sunum ────────────────────────────────────────────────── */

test('durum anlatısı ölçülemeyen bileşeni sağlıklı saymaz', () => {
  assert.match(healthNarrative({ state: HEALTH_STATES.UNKNOWN, counts: { unknown: 2 } }), /ölçülemedi/);
  assert.match(healthNarrative({ state: HEALTH_STATES.CRITICAL, counts: { critical: 1 }, attentionCount: 3 }), /kritik/);
  assert.match(healthNarrative({ state: HEALTH_STATES.HEALTHY, counts: { healthy: 5 } }), /5\/5/);
});

test('bayat ve hatalı yenileme ayrı iletiler üretir', () => {
  const now = Date.parse('2026-01-01T10:00:00.000Z');
  assert.equal(stalenessNotice({ stale: false, lastUpdatedAt: now, error: null, now }), '');
  assert.match(stalenessNotice({ stale: true, lastUpdatedAt: now - 600000, error: null, now }), /bayatladı/);
  assert.match(stalenessNotice({ stale: false, lastUpdatedAt: now - 60000, error: { code: 'NETWORK' }, now }), /son geçerli bilgi/);
  assert.match(stalenessNotice({ stale: false, lastUpdatedAt: null, error: { code: 'NETWORK' }, now }), /bilinmiyor/);
});

/* ── İnceleme bulgularının gerilemeleri ───────────────────── */

test('süre biçimlendirmesi yuvarlamayı dakikaya taşır', () => {
  // Saniye ÖNCE yuvarlanır; aksi halde var olmayan değerler yazılırdı.
  assert.equal(formatDuration(59_999), '1 dk 00 sn');
  assert.equal(formatDuration(119_999), '2 dk 00 sn');
  assert.equal(formatDuration(90_000), '1 dk 30 sn');
});

test('ölçülemeyen kova değeri sıfır gibi birleştirilmez', () => {
  const merged = mergeBucketSummaries([
    { count: 10, errorCount: 0, avgMs: 100, maxMs: 100, p50Ms: 100, p95Ms: 100, p99Ms: 100 },
    { count: 10, errorCount: 0, avgMs: null, maxMs: null, p50Ms: null, p95Ms: null, p99Ms: null }
  ]);
  // Ölçümsüz kova paya da paydaya da girmez: ortalama 50 ms'ye düşmemelidir.
  assert.equal(merged.p95Ms, 100);
  assert.equal(merged.avgMs, 100);
  assert.equal(merged.maxMs, 100);
  // Birden çok kovadan türeyen yüzdelik YAKLAŞIKTIR ve öyle işaretlenir.
  assert.equal(merged.percentilesApproximate, true);
  assert.equal(mergeBucketSummaries([{ count: 4, errorCount: 0, p95Ms: 12 }]).percentilesApproximate, false);
});

test('ölçülemeyen örnek süre özetine karışmaz', () => {
  const summary = summarizeDurations([100, null, '', 300]);
  assert.equal(summary.count, 2);
  assert.equal(summary.minMs, 100);
  assert.equal(summary.avgMs, 200);
});

test('temizleyici Basic yetkilendirmeyi ve serileştirilmiş kimlik alanını maskeler', () => {
  assert.equal(sanitizeText('Authorization: Basic dXNlcjpwYXNz'), REDACTED);
  assert.equal(sanitizeText('{"authToken":"gizli"}'), REDACTED);
  assert.equal(sanitizeText('authorization=Negotiate abc'), REDACTED);
  // Düz İngilizce sözcük base64 sanılmaz; masum metin gereksiz maskelenmez.
  assert.equal(sanitizeText('Basic authentication yapılandırıldı.'), 'Basic authentication yapılandırıldı.');
  assert.equal(sanitizeText('Bağlantı zaman aşımına uğradı.'), 'Bağlantı zaman aşımına uğradı.');
});

test('temizleyici büyük tam sayıyı ve fırlatan getter\'ı güvenle taşır', () => {
  // `Number(bigint)` güvenli tam sayı sınırını aşan değeri bozar.
  assert.equal(sanitizeContext({ id: 9007199254740993n }).id, '9007199254740993');
  // Fırlatan getter, gözlenen işlemi DÜŞÜRMEZ; yalnızca o dal boş kalır.
  const hostile = { get boom() { throw new Error('patladı'); } };
  assert.equal(sanitizeContext({ safe: 'değer', hostile }).hostile, null);
  assert.equal(sanitizeContext({ safe: 'değer', hostile }).safe, 'değer');
});

test('CN43N durumu ölçülemediğinde eşitleme başarısız bildirilmez', () => {
  const unknown = deriveAlertConditions({
    components: [{ key: COMPONENTS.CORPORATE_WBS, state: HEALTH_STATES.UNKNOWN, message: 'okunamadı' }]
  });
  const codes = unknown.map((item) => item.code);
  assert.ok(codes.includes('CORPORATE_WBS_STATUS_UNAVAILABLE'));
  assert.equal(codes.includes('CORPORATE_WBS_SYNC_FAILED'), false);
});

test('ölçülemeyen kural temiz gözlem sayılmaz', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const condition = [{
    key: alertKey(COMPONENTS.API, 'API_ERROR_RATE_HIGH', applicationInstanceId()),
    component: COMPONENTS.API,
    code: 'API_ERROR_RATE_HIGH',
    severity: EVENT_SEVERITIES.ERROR,
    summary: 'hata oranı yüksek'
  }];
  evaluateAlertTransitions(condition, { requiredObservations: 1 });

  // Örneği yetersiz iki pencere, uyarıyı "düzeldi" diye kapatmamalıdır.
  const unmeasured = deriveUnmeasuredAlertKeys({ apiSummary: { count: 3 } });
  assert.ok(unmeasured.has(alertKey(COMPONENTS.API, 'API_ERROR_RATE_HIGH', applicationInstanceId())));
  for (let round = 0; round < 4; round += 1) {
    assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 1, unmeasuredKeys: unmeasured }).resolve, []);
  }

  // Gerçek ölçüm iyileşmeyi kanıtladığında uyarı çözülür.
  const measured = deriveUnmeasuredAlertKeys({ apiSummary: { count: 500, p95Ms: 120 } });
  assert.deepEqual(
    evaluateAlertTransitions([], { requiredObservations: 1, unmeasuredKeys: measured }).resolve,
    [alertKey(COMPONENTS.API, 'API_ERROR_RATE_HIGH', applicationInstanceId())]
  );
});

test('süreç yeniden başladığında kalıcı açık uyarı çözülebilir', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  // İzleyici BOŞTUR (yeni süreç); koşul da görülmüyor. Kalıcı açık küme
  // tohumlanmazsa çözüm anahtarı hiç üretilmez ve uyarı sonsuza dek açık kalır.
  const key = alertKey(COMPONENTS.SMTP, 'SMTP_CONFIG_INVALID');
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 1, activeKeys: [key] }).resolve, [key]);
});

test('dikkat listesi daha ağır bileşen durumunu ilgisiz uyarıyla gizlemez', () => {
  const items = buildAttentionItems({
    alerts: [{
      id: 7, severity: 'WARNING', component: COMPONENTS.OUTLOOK, code: 'OUTLOOK_QUEUE_AGING',
      summary: 'kuyruk yaşlanıyor', state: 'OPEN', occurrenceCount: 1,
      firstSeenAt: '2026-01-01T10:00:00.000Z', lastSeenAt: '2026-01-01T10:00:00.000Z'
    }],
    components: [{
      key: COMPONENTS.OUTLOOK, label: 'Outlook', state: HEALTH_STATES.CRITICAL,
      message: 'çalışan durdu', lastCheckedAt: '2026-01-01T10:01:00.000Z', tab: 'kuyruklar'
    }]
  });
  assert.equal(items.length, 2, 'kritik bileşen satırı da listelenmelidir');
  assert.equal(items[0].severity, 'CRITICAL');
});

test('kalıcılaştırılamayan kovalar yeniden deneme kuyruğunda kalır', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const now = Date.parse('2026-01-01T10:07:00.000Z');
  recordOperation({ operation: 'api.snapshot', durationMs: 40, at: Date.parse('2026-01-01T10:01:00.000Z') });
  const drained = drainClosedBuckets(now);
  assert.equal(drained.operations.length, 1);
  // Her satır kararlı bir boşaltma kimliği taşır: yeniden deneme çift saymaz.
  assert.equal(typeof drained.operations[0].flushId, 'string');

  spoolUnpersistedBuckets(drained);
  assert.equal(spooledBucketCount().operations, 1);
  const retried = drainClosedBuckets(now);
  assert.equal(retried.operations.length, 1);
  assert.equal(retried.operations[0].flushId, drained.operations[0].flushId);
  assert.equal(spooledBucketCount().operations, 0);
});

test('sınır aşımından yitirilen telemetri sayılır ve bir kez bildirilir', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let index = 0; index <= TELEMETRY_LIMITS.MAX_BUCKETS_IN_MEMORY; index += 1) {
    recordGauge('process.rss', 1, base + index * 300000);
  }
  const counters = consumeTelemetryLossCounters();
  assert.ok(counters.droppedBuckets > 0, 'düşürülen kova sayılmalıdır');
  // Sayaç okunduğunda sıfırlanır: aynı kayıp her turda yeniden bildirilmez.
  assert.equal(consumeTelemetryLossCounters().droppedBuckets, 0);
});

test('iptal geri çağrısının hatası süreci düşürmez', async () => {
  const controller = new AbortController();
  const executor = boundedExecutor({
    request: () => ({
      // Hiç yerleşmeyen sorgu: sonucu yalnızca iptal belirler.
      query: () => new Promise(() => {}),
      cancel: () => { throw new Error('iptal edilemedi'); }
    })
  }, controller.signal);
  const pending = executor.request().query('SELECT 1');
  // `cancel()` olay dinleyicisinin içinde fırlar. Yutulmazsa Node bunu
  // YAKALANMAMIŞ istisna sayar ve süreci düşürürdü; sonuç yine süre aşımıdır.
  controller.abort(new Error('PROBE_TIMEOUT'));
  await assert.rejects(pending, /PROBE_TIMEOUT/);
});

test('hata temizleyici fırlatan erişimcilerde güvenli ve sabit sonuç döndürür', () => {
  for (const property of ['name', 'code', 'message']) {
    const error = { name: 'Error', code: 'FAILURE', message: 'hata' };
    Object.defineProperty(error, property, { get() { throw new Error('gizli'); } });
    assert.deepEqual(sanitizeError(error), { name: 'Error', code: null, message: '' });
  }
  assert.deepEqual(sanitizeError(new Proxy({}, { get() { throw new Error('gizli'); } })),
    { name: 'Error', code: null, message: '' });
});

test('uzun makine adında üretilen süreç kimliği PID son ekini korur', async (t) => {
  const { applicationInstanceId } = await import('../src/server/observability/observabilityConfig.js');
  const previous = { hostname: process.env.HOSTNAME, instance: process.env.MERGEN_ROTA_INSTANCE_ID };
  t.after(() => {
    for (const [key, value] of [['HOSTNAME', previous.hostname], ['MERGEN_ROTA_INSTANCE_ID', previous.instance]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  delete process.env.MERGEN_ROTA_INSTANCE_ID;
  process.env.HOSTNAME = 'a'.repeat(100);
  assert.equal(applicationInstanceId().length, 64);
  assert.ok(applicationInstanceId().endsWith(`-${process.pid}`));
});

test('çalışmayan Outlook çalışanı ve tükenmiş teslimatlar ayrı uyarılar açar', () => {
  const conditions = deriveAlertConditions({ components: [{
    key: COMPONENTS.OUTLOOK, state: HEALTH_STATES.CRITICAL, message: 'Teslimat hatası',
    detail: { worker: { started: false }, queue: { exhausted: 3 } }
  }] });
  assert.deepEqual(conditions.map((item) => item.code).sort(), ['OUTLOOK_DELIVERY_FAILED', 'OUTLOOK_WORKER_STALE']);
  assert.deepEqual(conditions.find((item) => item.code === 'OUTLOOK_DELIVERY_FAILED').context, { exhausted: 3 });
});

test('bellek uyarısı başka süreç tarafından çözülmez ve ölçülemeyen turda korunur', async (t) => {
  const { applicationInstanceId } = await import('../src/server/observability/observabilityConfig.js');
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const local = deriveAlertConditions({ components: [{ key: COMPONENTS.RESOURCES, state: HEALTH_STATES.WARNING, message: 'Bellek dolu' }] })[0];
  assert.equal(local.scope, applicationInstanceId());
  const foreign = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', 'another-instance');
  evaluateAlertTransitions([local], { requiredObservations: 1, activeKeys: [foreign] });
  const unmeasuredKeys = deriveUnmeasuredAlertKeys({ components: [] });
  assert.ok(unmeasuredKeys.has(local.key));
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 1, activeKeys: [foreign, local.key], unmeasuredKeys }).resolve, []);
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 1, activeKeys: [foreign, local.key] }).resolve, [local.key]);
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 1, activeKeys: [foreign] }).resolve, []);
});

test('0012 mevcut tabloların bütün sütun ve kısıtlarını başarı kaydından önce doğrular', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../database/MR_Upgrade_0012_System_Observability.sql', import.meta.url), 'utf8');
  const validationStart = migration.indexOf('DECLARE @RequiredColumns');
  const migrationRecord = migration.indexOf("IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0012_system_observability')");
  assert.ok(validationStart > 0 && migrationRecord > validationStart);
  const validation = migration.slice(validationStart, migrationRecord);
  const tables = [...migration.matchAll(/CREATE TABLE dbo\.(\w+) \(([\s\S]*?)\n        \);/g)];
  assert.equal(tables.length, 4);
  for (const [, table, definition] of tables) {
    for (const [, column] of definition.matchAll(/^\s+(\w+) (?:datetime2|nvarchar|varchar|int|bigint|float)\b/gm)) {
      assert.ok(validation.includes(`N'${table}', N'${column}'`), `${table}.${column}`);
    }
    for (const [, constraint] of definition.matchAll(/CONSTRAINT ((?:PK|CK)_\w+)/g)) {
      assert.ok(validation.includes(`N'${table}', N'${constraint}'`), constraint);
    }
  }
  for (const [, index] of migration.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)) {
    assert.ok(validation.includes(`N'${index}'`), index);
  }
  for (const property of ['is_nullable', 'is_identity', 'is_computed', 'is_disabled', 'is_not_trusted', 'is_unique', 'is_primary_key', 'filter_definition', 'key_ordinal', 'default_object_id']) {
    assert.ok(validation.includes(property), property);
  }
  assert.match(validation, /THROW 51012/);
  assert.match(migration.slice(migrationRecord), /COMMIT TRANSACTION;[\s\S]*ROLLBACK TRANSACTION;/);
});

test('bilinmeyen katalog anahtarları nesne prototipine erişmez', async () => {
  const { componentLabel, eventDefinition } = await import('../src/domain/observability/eventModel.js');
  for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(componentLabel(key), key);
    assert.equal(componentTab(key), 'genel');
    assert.equal(eventDefinition(key), EVENT_CODES.OPERATION_FAILED);
  }
});

test('günlük ölçülmemiş süreyi sıfır yapmaz', () => {
  for (const durationMs of [null, undefined, '', '  ', NaN, Infinity]) {
    assert.equal(buildLogRecord({ durationMs }).durationMs, null);
  }
  assert.equal(buildLogRecord({ durationMs: 0 }).durationMs, 0);
  assert.equal(buildLogRecord({ durationMs: '12.6' }).durationMs, 13);
});

test('uzun tanı metni ve sınırda kesilebilecek kimlik bilgisi güvenle maskelenir', () => {
  for (const text of ['x'.repeat(1000000), 'x'.repeat(480) + ' "authToken":"' + 'a'.repeat(1000), 'a'.repeat(495) + '@kurum.local']) {
    assert.equal(sanitizeText(text), REDACTED);
  }
  assert.equal(sanitizeText('a'.repeat(500)), 'a'.repeat(500));
});

test('ölçüm aralığının başlangıcıyla kesişen kova korunur', (t) => {
  resetTelemetryRegistryForTests();
  t.after(resetTelemetryRegistryForTests);
  const start = Date.parse('2026-09-12T09:00:00Z');
  for (const at of [start - 60000, start + 180000, start + 360000]) {
    recordOperation({ operation: 'api.snapshot', durationMs: 10, at });
    recordGauge('process.rss', 100, at);
  }
  for (const snapshot of [snapshotOperations, snapshotGauges]) {
    assert.deepEqual(snapshot({ sinceMs: start + 120000 }).map((row) => row.bucketStart), [start, start + 300000]);
    assert.deepEqual(snapshot({ sinceMs: start + 300000 }).map((row) => row.bucketStart), [start + 300000]);
  }
});

test('tanı bağlamının ALAN ADI da temizlenir', () => {
  const context = sanitizeContext({
    'kisi@kurum.local': 'gönderildi',
    'Authorization: Basic QWxhZGRpbjpvcGVu': 'başlık',
    normal: 'değer'
  });
  const keys = Object.keys(context);
  // E-posta adresi taşıyan alan ADI günlüğe ve kalıcı olay bağlamına olduğu
  // gibi geçerdi.
  assert.ok(keys.includes('k***@kurum.local'), JSON.stringify(keys));
  assert.equal(keys.includes('kisi@kurum.local'), false);
  assert.doesNotMatch(JSON.stringify(context), /kisi@kurum\.local|QWxhZGRpbjpvcGVu/);
  assert.equal(context.normal, 'değer');
});

test('kalıtılan zaman aralığı adı işlev döndürmez', () => {
  // `TIME_RANGES['constructor']` kalıtılan bir işlevdir: uç, aralık yerine onu
  // kullanıp HTTP 500 ile düşerdi.
  for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(timeRange(hostile).id, '24h', hostile);
  }
  assert.equal(timeRange('1h').id, '1h');
});

test('sayısal yapılandırma sıfır ve negatif değeri varsayılana düşürür', async (t) => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const { errorRateAlertThreshold, queueAgeAlertMinutes, telemetryRetentionDays } = await import('../src/server/observability/observabilityConfig.js');
  for (const value of ['-1', '0', '-30']) {
    process.env.MERGEN_ROTA_TELEMETRY_RETENTION_DAYS = value;
    // Alt sınıra çekmek `-1` girişini `1`e çevirir ve saklama turu bir sonraki
    // çalışmada 30 günlük geçmişi silerdi.
    assert.equal(telemetryRetentionDays(), 30, value);
  }
  process.env.MERGEN_ROTA_ALERT_QUEUE_AGE_MINUTES = '-5';
  assert.equal(queueAgeAlertMinutes(), 15);
  process.env.MERGEN_ROTA_ALERT_ERROR_RATE = '0';
  assert.equal(errorRateAlertThreshold(), 0.05);
  // Geçerli değer sınırlar içinde kalmayı sürdürür.
  process.env.MERGEN_ROTA_TELEMETRY_RETENTION_DAYS = '9999';
  assert.equal(telemetryRetentionDays(), 365);
  process.env.MERGEN_ROTA_TELEMETRY_RETENTION_DAYS = '7';
  assert.equal(telemetryRetentionDays(), 7);
});

test('bayat nabızlı çalışan tükenmiş teslimat varken de kendi uyarısını açar', () => {
  const conditions = deriveAlertConditions({
    components: [{
      key: COMPONENTS.OUTLOOK,
      state: HEALTH_STATES.CRITICAL,
      message: 'Outlook çalışanı beklenen aralıkta tur tamamlamadı.',
      detail: { worker: { started: true, heartbeatStale: true }, queue: { exhausted: 3 } }
    }]
  });
  // Çalışan uyarısı kuyruk sayımına bağlanırsa yönetici, özeti çalışanı
  // anlatan bir TESLİMAT uyarısı okur ve çalışan uyarısını hiç görmezdi.
  assert.deepEqual(conditions.map((item) => item.code).sort(), ['OUTLOOK_DELIVERY_FAILED', 'OUTLOOK_WORKER_STALE']);
  const worker = conditions.find((item) => item.code === 'OUTLOOK_WORKER_STALE');
  const delivery = conditions.find((item) => item.code === 'OUTLOOK_DELIVERY_FAILED');
  assert.match(worker.summary, /tur tamamlamadı/);
  assert.match(delivery.summary, /deneme eşiğini aştı/);
});

test('nabzı taze çalışanın tükenmiş teslimatı yalnızca teslimat uyarısı açar', () => {
  const conditions = deriveAlertConditions({
    components: [{
      key: COMPONENTS.OUTLOOK,
      state: HEALTH_STATES.CRITICAL,
      message: '3 teslimat deneme eşiğini aştı ve elle inceleme bekliyor.',
      detail: { worker: { started: true, heartbeatStale: false }, queue: { exhausted: 3 } }
    }]
  });
  assert.deepEqual(conditions.map((item) => item.code), ['OUTLOOK_DELIVERY_FAILED']);
});

test('dakika ölçüsü kesirli değeri yuvarlayıp birimini yitirmez', async () => {
  const { formatMinutes } = await import('../src/domain/observability/metrics.js');
  assert.equal(formatMinutes(0.5), '0.50 dk');
  assert.equal(formatMinutes(3.25), '3.3 dk');
  assert.equal(formatMinutes(42), '42 dk');
  assert.equal(formatMinutes(0), '0 dk');
  assert.equal(formatMinutes(null), '—');
  // Sayım biçimi yarım dakikayı "1" gösterir ve birimi hiç yazmazdı.
  assert.equal(formatMetricValue(0.5, 'minutes'), '0.50 dk');
  assert.equal(formatMetricValue(0.5, 'count'), '1');
  assert.equal(formatMetricValue(null, 'minutes'), '—');
});


test('API uyarılarını yalnız ölçümü üreten süreç çözebilir', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const conditions = deriveAlertConditions({ apiSummary: { count: 100, errorRate: 0.2, p95Ms: 5000 } });
  assert.equal(conditions.length, 2);
  for (const item of conditions) {
    assert.equal(item.scope, applicationInstanceId());
    const foreign = alertKey(item.component, item.code, 'other-instance');
    const unmeasured = deriveUnmeasuredAlertKeys();
    assert.ok(unmeasured.has(item.key));
    assert.deepEqual(evaluateAlertTransitions([], { activeKeys: [foreign, item.key], requiredObservations: 1, unmeasuredKeys: unmeasured }).resolve, []);
    assert.deepEqual(evaluateAlertTransitions([], { activeKeys: [foreign, item.key], requiredObservations: 1 }).resolve, [item.key]);
  }
});

test('WBS yoklaması yokken durum uyarısı açık kalır', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const key = alertKey(COMPONENTS.CORPORATE_WBS, 'CORPORATE_WBS_STATUS_UNAVAILABLE');
  const unmeasuredKeys = deriveUnmeasuredAlertKeys();
  assert.ok(unmeasuredKeys.has(key));
  assert.deepEqual(evaluateAlertTransitions([], { activeKeys: [key], unmeasuredKeys, requiredObservations: 1 }).resolve, []);
  const measured = deriveUnmeasuredAlertKeys({ components: [{ key: COMPONENTS.CORPORATE_WBS, state: HEALTH_STATES.HEALTHY }] });
  assert.deepEqual(evaluateAlertTransitions([], { activeKeys: [key], unmeasuredKeys: measured, requiredObservations: 1 }).resolve, [key]);
});

test('temizlenen bağlam çakışan adları ve prototip alanını kaybetmez', () => {
  const input = JSON.parse('{"alice@example.com":1,"adam@example.com":2,"__proto__":{"safe":3}}');
  const context = sanitizeContext(input);
  assert.equal(Object.getPrototypeOf(context), null);
  assert.equal(context['a***@example.com'], 1);
  assert.equal(context['a***@example.com_2'], 2);
  assert.equal(JSON.parse(JSON.stringify(context)).__proto__.safe, 3);
  const long = sanitizeContext({ ['a'.repeat(120) + 'x']: 1, ['a'.repeat(120) + 'y']: 2 });
  assert.equal(Object.keys(long).length, 2);
  assert.ok(Object.keys(long).every((key) => key.length <= 120));
});

test('üst düzey günlük hata kodu kesilmeden önce temizlenir', () => {
  for (const code of ['Authorization: Basic dXNlcjpwYXNz', '{"authToken":"secret"}', 'x'.repeat(60) + ' password=secret']) {
    assert.equal(buildLogRecord({ code }).code, REDACTED);
  }
  assert.equal(buildLogRecord({ code: 'ETIMEDOUT' }).code, 'ETIMEDOUT');
});
