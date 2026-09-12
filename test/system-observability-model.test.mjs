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
  evaluateAlertTransitions,
  parseAlertKey,
  resetAlertTrackerForTests
} = await import('../src/server/observability/alertRules.js');
const {
  TELEMETRY_LIMITS,
  drainClosedBuckets,
  recordFeedEntry,
  recordGauge,
  recordOperation,
  recentFeed,
  resetTelemetryRegistryForTests,
  snapshotGauges,
  snapshotOperations
} = await import('../src/server/observability/telemetryRegistry.js');
const { normalizeGauge, readResourceMetrics } = await import('../src/server/observability/resourceMetrics.js');
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
  const comparison = compareToBaseline(820, 610, { baselineSamples: 100 });
  assert.equal(comparison.direction, 'up');
  assert.ok(Math.abs(comparison.changeRatio - 0.344) < 0.01);
  assert.equal(compareToBaseline(600, 0, { baselineSamples: 100 }), null);
  assert.match(baselineNarrative(comparison, { unit: 'ms' }), /7 günlük baz/);
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
  assert.match(feed[0].summary, /olay-\d+/);
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
  // İlk okumada CPU oranı hesaplanamaz; tahmin üretilmez.
  assert.equal(metrics.hostMemory.usedRatio.available === true || metrics.hostMemory.usedRatio.value === null, true);
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
