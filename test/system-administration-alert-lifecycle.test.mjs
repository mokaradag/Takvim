import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { COMPONENTS, EVENT_SEVERITIES, alertKey } = await import('../src/domain/observability/eventModel.js');
const { HEALTH_STATES, worseHealthState } = await import('../src/domain/observability/healthModel.js');
const {
  deriveAlertConditions,
  deriveUnmeasuredAlertKeys,
  evaluateAlertTransitions,
  resetAlertTrackerForTests
} = await import('../src/server/observability/alertRules.js');
const { applicationInstanceId } = await import('../src/server/observability/observabilityConfig.js');
const { supersededProcessAlertKeys } = await import('../src/server/observability/processAlertLifecycle.js');
const {
  buildAttentionItems,
  summarizeActionableAlertCounts,
  summarizeActionableAlerts
} = await import('../src/server/observability/systemHealthService.js');
const { healthNarrative } = await import('../src/features/system-admin/systemAdminPresentation.js');

const ENV = Object.freeze({ HOSTNAME: 'rota-vm' });

function memoryComponent(state = HEALTH_STATES.WARNING) {
  return { key: COMPONENTS.RESOURCES, state, message: state === HEALTH_STATES.WARNING ? 'Yığın kullanımı %94 düzeyinde.' : 'Kaynak kullanımı normal.' };
}

function alertFromCondition(condition, state = 'OPEN') {
  return {
    id: 1,
    alertKey: condition.key,
    severity: condition.severity,
    component: condition.component,
    code: condition.code,
    summary: condition.summary,
    state,
    occurrenceCount: 1,
    firstSeenAt: '2026-09-16T10:00:00.000Z',
    lastSeenAt: '2026-09-16T10:01:00.000Z'
  };
}

test('güncel süreçte bellek baskısı uyarı durumunu ve dikkat kaydını üretir', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const condition = deriveAlertConditions({ components: [memoryComponent()] })[0];
  const transitions = evaluateAlertTransitions([condition], { requiredObservations: 1 });
  assert.equal(transitions.open.length, 1);

  const alert = alertFromCondition(condition);
  const alertSummary = summarizeActionableAlerts([alert]);
  const state = worseHealthState(HEALTH_STATES.WARNING, alertSummary.state);
  const attention = buildAttentionItems({ alerts: [alert], components: [memoryComponent()] });
  const narrative = healthNarrative({
    state,
    counts: { healthy: 8, warning: 1, critical: 0, unknown: 0, alerts: alertSummary.counts },
    attentionCount: attention.length
  });
  assert.equal(state, HEALTH_STATES.WARNING);
  assert.equal(attention.length, 1);
  assert.match(attention[0].summary, /Yığın kullanımı/);
  assert.match(narrative, /1 bileşen dikkat istiyor/);
  assert.match(narrative, /1 açık uyarı/);
});

test('bellek baskısı temiz gözlem sayısı dolunca çözülür ve dikkat listesinden düşer', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const condition = deriveAlertConditions({ components: [memoryComponent()] })[0];
  evaluateAlertTransitions([condition], { requiredObservations: 2 });
  evaluateAlertTransitions([condition], { requiredObservations: 2 });
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 2 }).resolve, []);
  assert.deepEqual(evaluateAlertTransitions([], { requiredObservations: 2 }).resolve, [condition.key]);

  const resolved = alertFromCondition(condition, 'RESOLVED');
  assert.equal(buildAttentionItems({ alerts: [resolved], components: [memoryComponent(HEALTH_STATES.HEALTHY)] }).length, 0);
  assert.equal(summarizeActionableAlerts([resolved]).state, HEALTH_STATES.HEALTHY);
});

test('yeniden başlatmada artık yaşamayan yerel PID kapsamı üstlenilmiş sayılır', () => {
  const oldKey = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', applicationInstanceId({ env: ENV, pid: 4100 }));
  const currentKey = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', applicationInstanceId({ env: ENV, pid: 4200 }));
  const foreignKey = alertKey(COMPONENTS.API, 'API_LATENCY_HIGH', 'other-host-5100');
  const superseded = supersededProcessAlertKeys([oldKey, currentKey, foreignKey], {
    env: ENV,
    currentPid: 4200,
    isProcessAlive: (pid) => pid !== 4100
  });
  assert.deepEqual(superseded, [oldKey]);
});

test('Windows ortamında HOSTNAME yoksa COMPUTERNAME süreç kapsamını korur', () => {
  const env = { COMPUTERNAME: 'ROTA-WIN' };
  const oldKey = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', applicationInstanceId({ env, pid: 4100 }));
  const foreignKey = alertKey(COMPONENTS.API, 'API_LATENCY_HIGH', 'DIGER-WIN-4100');
  assert.equal(applicationInstanceId({ env, pid: 4200 }), 'ROTA-WIN-4200');
  assert.deepEqual(supersededProcessAlertKeys([oldKey, foreignKey], {
    env,
    currentPid: 4200,
    isProcessAlive: () => false
  }), [oldKey]);
});

test('açıkça verilen kararlı süreç kimliği yeniden başlatmada korunur', (t) => {
  resetAlertTrackerForTests();
  const previous = process.env.MERGEN_ROTA_INSTANCE_ID;
  process.env.MERGEN_ROTA_INSTANCE_ID = 'rota-prod-01';
  t.after(() => {
    resetAlertTrackerForTests();
    if (previous === undefined) delete process.env.MERGEN_ROTA_INSTANCE_ID;
    else process.env.MERGEN_ROTA_INSTANCE_ID = previous;
  });

  const env = { HOSTNAME: 'rota-vm', MERGEN_ROTA_INSTANCE_ID: 'rota-prod-01' };
  const stableKey = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', applicationInstanceId({ env, pid: 100 }));
  assert.equal(applicationInstanceId({ env, pid: 200 }), 'rota-prod-01');
  assert.deepEqual(supersededProcessAlertKeys([stableKey], {
    env,
    currentPid: 200,
    isProcessAlive: () => false
  }), []);

  const condition = {
    key: stableKey,
    component: COMPONENTS.RESOURCES,
    code: 'MEMORY_PRESSURE',
    severity: EVENT_SEVERITIES.WARNING,
    summary: 'Yığın kullanımı yüksek'
  };
  const continuing = evaluateAlertTransitions([condition], {
    requiredObservations: 2,
    activeKeys: [stableKey]
  });
  assert.equal(continuing.open.length, 1);
  assert.deepEqual(continuing.resolve, []);
});

test('aynı makinedeki canlı süreç ve başka makinenin kapsamı bastırılmaz', () => {
  const liveLocal = alertKey(COMPONENTS.API, 'API_ERROR_RATE_HIGH', applicationInstanceId({ env: ENV, pid: 4300 }));
  const foreign = alertKey(COMPONENTS.API, 'API_LATENCY_HIGH', 'rota-vm-b-4400');
  const unrelated = alertKey(COMPONENTS.DATABASE, 'DATABASE_SLOW');
  assert.deepEqual(supersededProcessAlertKeys([liveLocal, foreign, unrelated], {
    env: ENV,
    currentPid: 4200,
    isProcessAlive: (pid) => pid === 4300
  }), []);
});

test('bileşen uyarısı yokken etkin uyarı anlatıda ayrı bildirilir', () => {
  const alert = {
    id: 2,
    alertKey: alertKey(COMPONENTS.API, 'API_LATENCY_HIGH', 'rota-prod-01'),
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.API,
    code: 'API_LATENCY_HIGH',
    summary: 'P95 yanıt süresi yüksek',
    state: 'OPEN',
    occurrenceCount: 1
  };
  const summary = summarizeActionableAlerts([alert]);
  const narrative = healthNarrative({
    state: summary.state,
    counts: { healthy: 9, warning: 0, critical: 0, unknown: 0, alerts: summary.counts },
    attentionCount: 1
  });
  assert.equal(summary.state, HEALTH_STATES.WARNING);
  assert.doesNotMatch(narrative, /0 bileşen dikkat istiyor/);
  assert.match(narrative, /1 açık uyarı/);
});

test('aggregate uyarı özeti sınırlı listenin dışındaki kritik durumu korur', () => {
  const summary = summarizeActionableAlertCounts({
    total: 56,
    open: 55,
    acknowledged: 1,
    info: 0,
    warning: 55,
    error: 0,
    critical: 1
  });
  assert.equal(summary.state, HEALTH_STATES.CRITICAL);
  assert.equal(summary.counts.total, 56);
  assert.equal(summary.counts.acknowledged, 1);
  assert.equal(summary.counts.critical, 1);
});

test('tam sağlıklı durumda açık uyarı ve dikkat kaydı yoktur', () => {
  const summary = summarizeActionableAlerts([]);
  const counts = { healthy: 9, warning: 0, critical: 0, unknown: 0, alerts: summary.counts };
  assert.equal(summary.state, HEALTH_STATES.HEALTHY);
  assert.equal(buildAttentionItems({ alerts: [], components: [memoryComponent(HEALTH_STATES.HEALTHY)] }).length, 0);
  assert.match(healthNarrative({ state: HEALTH_STATES.HEALTHY, counts }), /9\/9 bileşen sağlıklı/);
});

test('onaylanan uyarı çözülmüş sayılmaz ama ölü süreç kapsamı yine üstlenilir', () => {
  const scope = applicationInstanceId({ env: ENV, pid: 4100 });
  const key = alertKey(COMPONENTS.RESOURCES, 'MEMORY_PRESSURE', scope);
  const alert = {
    id: 3,
    alertKey: key,
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.RESOURCES,
    code: 'MEMORY_PRESSURE',
    summary: 'Yığın kullanımı yüksek',
    state: 'ACKNOWLEDGED',
    occurrenceCount: 2
  };
  const summary = summarizeActionableAlerts([alert]);
  assert.equal(summary.counts.total, 1);
  assert.equal(summary.counts.acknowledged, 1);
  assert.equal(buildAttentionItems({ alerts: [alert], components: [] }).length, 1);
  assert.deepEqual(supersededProcessAlertKeys([key], {
    env: ENV,
    currentPid: 4200,
    isProcessAlive: () => false
  }), [key]);
});

test('ölçülemeyen API penceresi mevcut süreç uyarısını temiz gözlem saymaz', (t) => {
  resetAlertTrackerForTests();
  t.after(resetAlertTrackerForTests);
  const key = alertKey(COMPONENTS.API, 'API_LATENCY_HIGH', applicationInstanceId());
  const unmeasured = deriveUnmeasuredAlertKeys({ apiSummary: { count: 0 } });
  const result = evaluateAlertTransitions([], {
    requiredObservations: 1,
    activeKeys: [key],
    unmeasuredKeys: unmeasured
  });
  assert.deepEqual(result.resolve, []);
});
