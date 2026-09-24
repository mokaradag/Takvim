/**
 * Yapay zekâ · olağan Rota işleyişinden yalıtım, telemetri ve sağlık.
 *
 * Temel mimari kural: yavaş, takılı ya da aşırı yüklü bir yapay zekâ isteği
 * anlık görüntüyü, kaydı ve olağan SQL işlerini BEKLETMEZ. Yapay zekâ yolu
 * SQL bağlantısı ya da işlemi tutmaz, açık bir SQL işlemi içinde çalışmayı
 * reddeder ve telemetrisi hiçbir koşulda ne kendini ne de Rota'yı bozar.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { corporateSeed, createActualStack, CORPORATE_ROOT_WBS_ID } from './helpers/actualStack.mjs';
import { createFakeAiProvider } from './helpers/fakeAiProvider.mjs';
import {
  DEFAULT_KEY,
  MASTER_KEY,
  PERSONAL_KEY_A,
  SICIL_A,
  SICIL_B,
  aiRequest,
  captureConsole,
  createAiStack,
  probeRoute,
  readJson,
  runProbe,
  saveKey
} from './helpers/aiStack.mjs';
import { createNewTask } from '../src/state/appState.js';

const { aiRuntimeLoad, getAiGateway, resetAiRuntimeForTests, setAiProviderForTests } = await import('../src/server/ai/aiRuntime.js');
const { resetAiConfigCacheForTests } = await import('../src/server/ai/aiConfig.js');
const { resetAiModelRegistryForTests } = await import('../src/server/ai/modelRegistryLoader.js');
const { resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');
const { isWithinSqlTransaction, withSqlTransaction } = await import('../src/server/db/pool.js');
const { resetTelemetryRegistryForTests, snapshotOperations } = await import('../src/server/observability/telemetryRegistry.js');
const { summarizeApiWindow } = await import('../src/server/observability/systemHealthService.js');
const { resetIntegrationCacheForTests } = await import('../src/server/observability/integrationsService.js');
const { resetHealthProbeCacheForTests } = await import('../src/server/observability/healthProbes.js');
const { resetAdminActionLocksForTests } = await import('../src/server/observability/adminRequestContext.js');
const overviewRoute = await import('../src/app/api/mergen-rota/admin/system/overview/route.js');
const integrationsRoute = await import('../src/app/api/mergen-rota/admin/system/integrations/route.js');
const { COMPONENTS } = await import('../src/domain/observability/eventModel.js');
const { HEALTH_STATES } = await import('../src/domain/observability/healthModel.js');

const AI_ENV = {
  MERGEN_ROTA_AI_ENABLED: 'true',
  MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
  MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
  MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: MASTER_KEY
};

function resetAi() {
  resetAiRuntimeForTests();
  resetAiConfigCacheForTests();
  resetAiModelRegistryForTests();
  resetAiTelemetryForTests();
  resetTelemetryRegistryForTests();
}

/** Gerçek Sistem yığınının üstüne yapay zekâyı açar; sağlayıcı SQL işlem durumunu kaydeder. */
function enableAi(t, env = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, AI_ENV, env);
  resetAi();
  const provider = createFakeAiProvider();
  const chatCompletion = provider.chatCompletion.bind(provider);
  provider.insideSqlTransaction = [];
  provider.chatCompletion = (input) => {
    provider.insideSqlTransaction.push(isWithinSqlTransaction());
    return chatCompletion(input);
  };
  setAiProviderForTests(provider);
  t.after(() => {
    setAiProviderForTests(null);
    resetAi();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return provider;
}

async function until(predicate, rounds = 200) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

function probeInBackground(signal) {
  const state = { settled: false, response: null };
  state.promise = probeRoute.POST(aiRequest('/probe', { method: 'POST', signal })).then((response) => {
    state.settled = true;
    state.response = response;
    return response;
  });
  return state;
}

async function createTask(stack) {
  const project = stack.project('P4417041');
  const task = createNewTask({ ...stack.state, workspaceMode: 'project', selectedProjectId: project.id }, undefined,
    'task-4d5e6f70-8192-4a3b-9c4d-5e6f7a8b9c0d');
  return stack.persistence.mutate('task/create', { type: 'task/add', task });
}

/* ── Temel yalıtım ────────────────────────────────────────── */

test('takılı bir yapay zekâ isteği sürerken anlık görüntü ve görev kaydı bağımsız tamamlanır', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  const provider = enableAi(t);
  provider.enqueue({ type: 'stall' });

  const client = new AbortController();
  t.after(() => client.abort());
  const ai = probeInBackground(client.signal);
  await provider.waitForActive(1);

  const reloaded = await stack.reload({ refreshMode: 'manual' });
  assert.ok(reloaded.projects.some((project) => project.code === 'P4417041'));
  const created = await createTask(stack);
  assert.equal(created.ok, true, created.error?.message);
  assert.equal(stack.db.tasks.length, 1);
  assert.equal(stack.db.tasks[0].WbsId, CORPORATE_ROOT_WBS_ID);

  assert.equal(ai.settled, false, 'yapay zekâ isteği hâlâ sürüyor');
  assert.equal(provider.activeCount, 1);
  // Model yanıtı beklenirken yapay zekâ yolu SQL işlemi ya da bağlantısı tutmaz.
  assert.deepEqual(provider.insideSqlTransaction, [false]);
  assert.equal(stack.db.statements.filter((entry) => entry.sql.includes('MR_AiUserCredentials')).length, 1);
  assert.ok(stack.db.transactions.every((entry) => entry.commitStatementIndex != null || entry.rollbackStatementIndex != null),
    'açık kalan SQL işlemi yoktur');

  client.abort();
  const response = await ai.promise;
  assert.equal(response.status, 499);
  assert.equal(provider.calls[0].aborted, true);
  assert.equal(aiRuntimeLoad().active, 0);
});

test('yapay zekâ kapasitesi dolduğunda istek bekletilmeden AI_BUSY alır; olağan uçlar etkilenmez', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  const provider = enableAi(t, {
    MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '2',
    MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '2',
    MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS: '0',
    MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0'
  });
  provider.enqueue({ type: 'stall' }, { type: 'stall' });
  const clients = [new AbortController(), new AbortController()];
  t.after(() => clients.forEach((client) => client.abort()));
  const running = clients.map((client) => probeInBackground(client.signal));
  await provider.waitForActive(2);

  const busy = await readJson(await probeRoute.POST(aiRequest('/probe', { method: 'POST' })));
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error.code, 'AI_BUSY');
  assert.equal(busy.body.error.details.retryable, true);
  assert.equal(busy.headers.get('retry-after'), '2');
  assert.equal(provider.calls.length, 2, 'geri çevrilen istek sağlayıcıya gitmez');

  const reloaded = await stack.reload({ refreshMode: 'manual' });
  assert.ok(reloaded.projects.length > 0);
  assert.equal((await createTask(stack)).ok, true);

  for (const client of clients) client.abort();
  for (const entry of running) assert.equal((await entry.promise).status, 499);
  assert.deepEqual({ active: aiRuntimeLoad().active, queued: aiRuntimeLoad().queued }, { active: 0, queued: 0 });
  assert.equal(aiRuntimeLoad().counters.rejectedBusy, 1);
});

test('iki kullanıcının istekleri aynı anda yürür; tek kullanıcı herkesi serileştirmez', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  const provider = enableAi(t);
  provider.enqueue({ type: 'deferred' }, { type: 'deferred' });
  const first = probeInBackground();
  await provider.waitForActive(1);
  process.env.MERGEN_ROTA_DEV_SICIL = '900010';
  const second = probeInBackground();
  await provider.waitForActive(2);
  assert.equal(aiRuntimeLoad().activeUsers, 2);
  assert.equal(provider.peakActive, 2);
  provider.calls.forEach((call) => call.resolve());
  assert.equal((await first.promise).status, 200);
  assert.equal((await second.promise).status, 200);
  assert.equal(aiRuntimeLoad().active, 0);
});

test('ağ geçidi açık bir SQL işlemi içinde çalıştırılamaz', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  const provider = enableAi(t);
  await assert.rejects(
    withSqlTransaction(() => getAiGateway().completeChat({ profile: 'chat.fast', messages: [{ role: 'user', content: 'x' }] })),
    (error) => error.code === 'AI_INTERNAL_ERROR' && error.details.reason === 'SQL_TRANSACTION_ACTIVE'
  );
  assert.equal(provider.calls.length, 0);
});

/* ── Telemetri ────────────────────────────────────────────── */

test('yapay zekâ işlemleri kendi ad alanında ölçülür ve olağan API gecikme özetine karışmaz', async (t) => {
  const { provider } = createAiStack(t);
  const logs = captureConsole(t);
  await saveKey(PERSONAL_KEY_A);
  const apiBefore = summarizeApiWindow().count;
  assert.equal((await runProbe()).status, 200);
  provider.enqueue({ type: 'status', status: 503 });
  assert.equal((await runProbe()).status, 502);
  const operations = new Set(snapshotOperations().map((row) => row.operation));
  for (const name of ['ai.api.probe', 'ai.api.credential.save', 'ai.request', 'ai.provider.chat', 'ai.queue.wait']) {
    assert.ok(operations.has(name), `${name} ölçülmelidir`);
  }
  assert.equal([...operations].some((name) => name.startsWith('api.ai')), false);
  assert.equal(summarizeApiWindow().count, apiBefore, 'yavaş model yanıtları API P95 uyarısını kirletmez');
  const failed = snapshotOperations().find((row) => row.operation === 'ai.request');
  assert.equal(failed.errorCount, 1);
  assert.equal(failed.topFailureCode, 'AI_PROVIDER_UNAVAILABLE');
  const record = logs.map((line) => line.match(/\[mergen-rota\] (\{.*\})$/)?.[1]).filter(Boolean).map((json) => JSON.parse(json))
    .find((entry) => entry.component === 'AI' && entry.code === 'AI_PROVIDER_UNAVAILABLE');
  assert.ok(record, 'sağlayıcı hatası yapılandırılmış günlüğe yazılır');
  assert.deepEqual(
    { keySource: record.context.keySource, profile: record.context.profile, providerStatus: record.context.providerStatus },
    { keySource: 'personal', profile: 'chat.fast', providerStatus: 503 }
  );
});

test('telemetri ve günlük yazımı bozulsa da yapay zekâ isteği ve olağan uçlar çalışır', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  enableAi(t);
  const registryKey = Symbol.for('mergen-rota.telemetry-registry');
  const originalConsole = { error: console.error, warn: console.warn, info: console.info };
  globalThis[registryKey] = { buckets: null, recentEvents: null };
  for (const method of Object.keys(originalConsole)) {
    console[method] = () => { throw new Error('günlük hedefi kullanılamıyor'); };
  }
  t.after(() => {
    Object.assign(console, originalConsole);
    resetTelemetryRegistryForTests();
  });
  const probe = await readJson(await probeRoute.POST(aiRequest('/probe', { method: 'POST' })));
  assert.equal(probe.status, 200);
  assert.equal(probe.body.result.credentialSource, 'default');
  const reloaded = await stack.reload({ refreshMode: 'manual' });
  assert.ok(reloaded.projects.length > 0);
});

/* ── Sağlık ve Sistem Yönetimi ────────────────────────────── */

function adminReset(t) {
  const reset = () => {
    resetIntegrationCacheForTests();
    resetHealthProbeCacheForTests();
    resetAdminActionLocksForTests();
  };
  reset();
  t.after(reset);
}

async function overviewAi() {
  const response = await overviewRoute.GET(new Request('http://localhost/api/mergen-rota/admin/system/overview'));
  assert.equal(response.status, 200);
  const body = await response.json();
  return { body, ai: body.components.find((component) => component.key === COMPONENTS.AI) };
}

test('kapalı yapay zekâ genel sağlığı düşürmeyen “yapılandırılmamış” bileşendir', async (t) => {
  createAiStack(t, { env: { MERGEN_ROTA_AI_ENABLED: 'false' } });
  adminReset(t);
  const { ai } = await overviewAi();
  assert.equal(ai.state, HEALTH_STATES.NOT_CONFIGURED);
  assert.equal(ai.label, 'Yapay zekâ hizmeti');
  assert.equal(ai.tab, 'entegrasyonlar');
});

test('sağlık yoklaması sağlayıcıyı çağırmaz; durum son temaslardan ve kapasiteden türetilir, gizli değer taşımaz', async (t) => {
  const { provider } = createAiStack(t, {
    env: { MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS: '0', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0' }
  });
  adminReset(t);
  const initial = await overviewAi();
  assert.equal(initial.ai.state, HEALTH_STATES.UNKNOWN);
  assert.equal(provider.calls.length, 0);

  assert.equal((await runProbe()).status, 200);
  const healthy = await overviewAi();
  assert.equal(healthy.ai.state, HEALTH_STATES.HEALTHY);
  assert.match(healthy.ai.message, /Etkin 0\/8, sırada 0\/0/);
  assert.equal(healthy.ai.detail.telemetry.bySource.default, 1);
  assert.equal(healthy.ai.detail.registry.source, 'default');
  assert.equal(healthy.ai.detail.registry.profiles.find((entry) => entry.profile === 'chat.fast').available, true);
  assert.equal(provider.calls.length, 1, 'genel bakış sağlayıcıya istek göndermez');
  const text = JSON.stringify(healthy.body);
  for (const secret of [DEFAULT_KEY, MASTER_KEY, '127.0.0.1:9']) assert.equal(text.includes(secret), false, secret);

  provider.enqueue({ type: 'stall' });
  const client = new AbortController();
  t.after(() => client.abort());
  const running = probeInBackground(client.signal);
  await provider.waitForActive(1);
  const rejected = await runProbe();
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.details.scope, 'user');
  assert.equal(rejected.body.error.details.saturation, 'user');
  // Tek kullanıcının kendi sınırı hizmetin dolu olduğunu göstermez.
  const ownLimit = await overviewAi();
  assert.equal(ownLimit.ai.state, HEALTH_STATES.HEALTHY);
  assert.doesNotMatch(ownLimit.ai.message, /Kapasite doldu/);
  assert.match(ownLimit.ai.message, /Etkin 1\/8/);
  assert.ok(ownLimit.ai.detail.telemetry.lastUserLimitAt, 'kullanıcı sınırı yine de izlenir');
  client.abort();
  assert.equal((await running.promise).status, 499);
});

test('paylaşılan kapasite dolunca ya da sırada süre dolunca uyarı verilir; yalnız sıra baskısı ret iddia etmez', async (t) => {
  const { provider, useSicil } = createAiStack(t, {
    env: {
      MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '1',
      MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1',
      MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS: '1',
      MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '1',
      MERGEN_ROTA_AI_QUEUE_TIMEOUT_MS: '100'
    }
  });
  adminReset(t);
  assert.equal((await runProbe()).status, 200);
  provider.enqueue({ type: 'stall' });
  const client = new AbortController();
  t.after(() => client.abort());
  const running = probeInBackground(client.signal);
  await provider.waitForActive(1);

  // Sırada bekleyen tek istek: sıra baskısı var, geri çevrilen istek yok.
  useSicil(SICIL_B);
  const queuedClient = new AbortController();
  const queued = probeInBackground(queuedClient.signal);
  await until(() => aiRuntimeLoad()?.queued === 1);
  useSicil(SICIL_A);
  const pressure = await overviewAi();
  assert.equal(pressure.ai.state, HEALTH_STATES.WARNING);
  assert.match(pressure.ai.message, /Sıra dolmak üzere; henüz geri çevrilen istek yok/);
  assert.doesNotMatch(pressure.ai.message, /geri çevrildi/);

  // Sırada süresi dolan istek paylaşılan kapasite baskısıdır.
  const timedOut = await readJson(await queued.promise);
  assert.equal(timedOut.body.error.code, 'AI_QUEUE_TIMEOUT');
  const afterTimeout = await overviewAi();
  assert.equal(afterTimeout.ai.state, HEALTH_STATES.WARNING);
  assert.match(afterTimeout.ai.message, /sırada beklerken süre doldu/);

  // Paylaşılan sıra doluyken reddedilen istek: kapasite doldu.
  useSicil(SICIL_B);
  const waitingClient = new AbortController();
  const waiting = probeInBackground(waitingClient.signal);
  await until(() => aiRuntimeLoad()?.queued === 1);
  useSicil(SICIL_A);
  const rejected = await runProbe();
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, 'AI_BUSY');
  assert.equal(rejected.body.error.details.scope, 'global');
  const busy = await overviewAi();
  assert.match(busy.ai.message, /Kapasite doldu; bazı istekler geri çevrildi/);
  waitingClient.abort();
  await waiting.promise;
  queuedClient.abort();
  client.abort();
  assert.equal((await running.promise).status, 499);
});

test('hatalı yapılandırma uyarı olarak ve yalnızca ayar ADLARIYLA bildirilir', async (t) => {
  createAiStack(t, { env: { MERGEN_ROTA_AI_BASE_URL: 'http://ai.example.internal/v1', MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: 'çok' } });
  adminReset(t);
  const { ai } = await overviewAi();
  assert.equal(ai.state, HEALTH_STATES.WARNING);
  assert.deepEqual(ai.detail.configuration.issues.sort(), ['MERGEN_ROTA_AI_BASE_URL', 'MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS']);
  assert.equal(JSON.stringify(ai).includes('ai.example.internal'), false);
  assert.equal(JSON.stringify(ai).includes('çok'), false);
});

test('Entegrasyonlar kartı yapay zekâ sağlayıcısını listeler; bağlantı testi üretim yapmaz ve süre sınırlıdır', async (t) => {
  const { provider } = createAiStack(t);
  adminReset(t);
  const list = await (await integrationsRoute.GET(new Request('http://localhost/integrations'))).json();
  const card = list.integrations.find((integration) => integration.id === 'ai-provider');
  assert.deepEqual({ label: card.label, configured: card.configured, testable: card.testable }, {
    label: 'Yapay zekâ sağlayıcısı', configured: true, testable: true
  });
  assert.equal(JSON.stringify(list).includes(DEFAULT_KEY), false);

  const post = () => integrationsRoute.POST(new Request('http://localhost/integrations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId: 'ai-provider' })
  }));
  const ok = await (await post()).json();
  assert.equal(ok.result.ok, true);
  assert.deepEqual(provider.calls.map((call) => [call.kind, call.apiKey]), [['models', DEFAULT_KEY]]);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  provider.enqueue({ type: 'stall' });
  const pending = post();
  await provider.waitForActive(1);
  t.mock.timers.tick(6000);
  const timedOut = await (await pending).json();
  assert.equal(timedOut.result.ok, false);
  assert.equal(timedOut.result.code, 'PROBE_TIMEOUT');
  assert.equal(provider.calls[1].aborted, true);
});

/* ── Sağlık doğruluğu ve bağlantı testi ───────────────────── */

const { recordProviderCall } = await import('../src/server/ai/aiTelemetry.js');
const performanceRoute = await import('../src/app/api/mergen-rota/admin/system/performance/route.js');

function postIntegrationTest(integrationId) {
  return integrationsRoute.POST(new Request('http://localhost/integrations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId })
  })).then((response) => response.json());
}

async function aiCard() {
  const list = await (await integrationsRoute.GET(new Request('http://localhost/integrations'))).json();
  return list.integrations.find((integration) => integration.id === 'ai-provider');
}

test('yapılandırılmış dosya kaydı okunmadan bileşen sağlıklı görünmez; bağlantı testi kaydı da okur', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-ai-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai-models.json');
  await writeFile(file, JSON.stringify({
    version: 1,
    models: [{ id: 'hizli-model', capabilities: ['chat'] }],
    profiles: { 'chat.fast': { model: 'hizli-model' } }
  }), 'utf8');
  createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  adminReset(t);
  recordProviderCall({ operation: 'ai.provider.models', latencyMs: 5 });
  const idle = await overviewAi();
  assert.equal(idle.ai.state, HEALTH_STATES.UNKNOWN, 'taze temas, okunmamış kaydı sağlıklı göstermez');
  assert.match(idle.ai.message, /Model kaydı henüz yüklenmedi/);

  const tested = await postIntegrationTest('ai-provider');
  assert.equal(tested.result.ok, true);
  const ready = await overviewAi();
  assert.equal(ready.ai.state, HEALTH_STATES.HEALTHY);
  assert.equal(ready.ai.detail.registry.source, 'file');
});

test('geçersiz etkinleştirme değeri bilinçli kapatmadan ayrılır ve yapılandırma hatası olarak bildirilir', async (t) => {
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_ENABLED: 'tru' } });
  adminReset(t);
  const { ai } = await overviewAi();
  assert.equal(ai.state, HEALTH_STATES.WARNING);
  assert.deepEqual(ai.detail.configuration.issues, ['MERGEN_ROTA_AI_ENABLED']);
  const card = await aiCard();
  assert.equal(card.state, HEALTH_STATES.WARNING);
  assert.deepEqual(card.detail.missing, ['MERGEN_ROTA_AI_ENABLED']);
  const probe = await runProbe();
  assert.equal(probe.status, 503);
  assert.equal(probe.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(provider.calls.length, 0);
});

test('kurumsal anahtar yokken kişisel anahtar tablosu doğrulanmadan sağlıklı denmez; eksik tablo uyarıdır', async (t) => {
  const { db } = createAiStack(t, { env: { MERGEN_ROTA_AI_DEFAULT_API_KEY: null } });
  adminReset(t);
  db.aiCredentialSchemaMissing = true;
  recordProviderCall({ operation: 'ai.provider.models', latencyMs: 5 });
  const unverified = await overviewAi();
  assert.equal(unverified.ai.state, HEALTH_STATES.UNKNOWN);
  assert.match(unverified.ai.message, /Kişisel anahtar tablosu henüz doğrulanmadı/);

  const missing = await postIntegrationTest('ai-provider');
  assert.equal(missing.result.ok, false);
  assert.equal(missing.result.code, 'CREDENTIAL_SCHEMA_MISSING');
  const warned = await overviewAi();
  assert.equal(warned.ai.state, HEALTH_STATES.WARNING);
  assert.match(warned.ai.message, /Kişisel anahtar tablosu \(0016\) kurulmamış/);

  db.aiCredentialSchemaMissing = false;
  const fixed = await postIntegrationTest('ai-provider');
  assert.equal(fixed.result.ok, true);
  assert.equal(fixed.result.code, 'AUTHENTICATION_REQUIRED');
  assert.equal((await overviewAi()).ai.state, HEALTH_STATES.HEALTHY);
});

test('bağlantı testinde reddedilen kurumsal anahtar ve beklenmeyen yanıt önceki başarıya rağmen uyarıdır', async (t) => {
  const { provider } = createAiStack(t);
  adminReset(t);
  assert.equal((await postIntegrationTest('ai-provider')).result.ok, true);
  assert.equal((await aiCard()).state, HEALTH_STATES.HEALTHY);

  provider.enqueue({ type: 'status', status: 401 });
  const rejected = await postIntegrationTest('ai-provider');
  assert.equal(rejected.result.code, 'DEFAULT_KEY_REJECTED');
  const card = await aiCard();
  assert.equal(card.state, HEALTH_STATES.WARNING, 'reddedilen kurumsal anahtar sağlıklı görünmez');
  assert.match(card.message, /AI_KEY_INVALID/);

  assert.equal((await postIntegrationTest('ai-provider')).result.ok, true);
  provider.enqueue({ type: 'status', status: 404 });
  const notFound = await postIntegrationTest('ai-provider');
  assert.equal(notFound.result.code, 'HTTP_404');
  const { ai } = await overviewAi();
  assert.equal(ai.state, HEALTH_STATES.WARNING);
  assert.match(ai.message, /AI_CONFIGURATION_ERROR/);
});

test('olağan istekte reddedilen kurumsal anahtar uyarıdır; kişisel anahtarın oran sınırı paylaşılan sağlığı düşürmez', async (t) => {
  const { provider } = createAiStack(t);
  adminReset(t);
  assert.equal((await runProbe()).status, 200);
  provider.enqueue({ type: 'status', status: 403 });
  assert.equal((await runProbe()).body.error.code, 'AI_UNAUTHORIZED');
  assert.equal((await overviewAi()).ai.state, HEALTH_STATES.WARNING);

  assert.equal((await runProbe()).status, 200);
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'status', status: 429, retryAfter: '5' });
  assert.equal((await runProbe()).body.error.code, 'AI_RATE_LIMITED');
  assert.equal((await overviewAi()).ai.state, HEALTH_STATES.HEALTHY);
});

test('aynı milisaniyede önce başarı sonra hata kaydedilirse son sonuç hatadır', async (t) => {
  createAiStack(t);
  adminReset(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T10:00:00.000Z') });
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5 });
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5, code: 'AI_PROVIDER_UNAVAILABLE' });
  const { ai } = await overviewAi();
  assert.equal(ai.detail.telemetry.provider.lastContactAt, ai.detail.telemetry.provider.lastFailureAt, 'damgalar eşittir');
  assert.equal(ai.state, HEALTH_STATES.WARNING);
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5 });
  assert.equal((await overviewAi()).ai.state, HEALTH_STATES.HEALTHY);
});

test('yapay zekâ bağlantı testi sağlayıcı beklenirken SQL yönetim kilidi ve işlemi tutmaz', async (t) => {
  const { db } = createAiStack(t);
  adminReset(t);
  const before = db.transactions.length;
  assert.equal((await postIntegrationTest('ai-provider')).result.ok, true);
  assert.equal(db.transactions.length, before, 'yapay zekâ testi işlem açmaz');
  assert.equal(db.statements.some((entry) => entry.sql.includes('sp_getapplock') && entry.sql.includes('ai-provider')), false);
  await postIntegrationTest('database');
  assert.ok(db.transactions.length > before, 'veritabanı testi kilidini korur');
});

test('Performans ucu etkin ve sıradaki yapay zekâ isteği ölçümlerini döndürür', async (t) => {
  const { db } = createAiStack(t);
  adminReset(t);
  const bucket = new Date(Date.now() - 10 * 60 * 1000);
  bucket.setUTCSeconds(0, 0);
  db.telemetryGaugeSamples.push(
    { BucketStart: bucket, MetricKey: 'ai.active_requests', SampleCount: 2, ValueAvg: 3, ValueMin: 1, ValueMax: 5 },
    { BucketStart: bucket, MetricKey: 'ai.queued_requests', SampleCount: 2, ValueAvg: 1, ValueMin: 0, ValueMax: 2 }
  );
  const body = await (await performanceRoute.GET(new Request('http://localhost/performance?range=1h'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.gauges['ai.active_requests'].length, 1);
  assert.equal(body.gauges['ai.active_requests'][0].value, 3);
  assert.equal(body.gauges['ai.queued_requests'][0].max, 2);
});

test('araç istenmeyen deneme isteğine metinsiz yanıt geçersiz sağlayıcı yanıtıdır', async (t) => {
  const { provider } = createAiStack(t);
  adminReset(t);
  provider.enqueue({ type: 'empty' });
  const probe = await runProbe();
  assert.equal(probe.status, 502);
  assert.equal(probe.body.error.code, 'AI_PROVIDER_RESPONSE_INVALID');
  assert.equal(probe.body.error.details.reason, 'EMPTY_COMPLETION');
  const { ai } = await overviewAi();
  assert.equal(ai.state, HEALTH_STATES.WARNING, 'metinsiz yanıt sağlıklı temas sayılmaz');
});

test('bayat sağlayıcı hatası süreç ömrü boyunca uyarı olarak kalmaz', async (t) => {
  createAiStack(t);
  adminReset(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T10:00:00.000Z') });
  recordProviderCall({ operation: 'ai.provider.chat', latencyMs: 5, code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal((await overviewAi()).ai.state, HEALTH_STATES.WARNING);
  t.mock.timers.tick(16 * 60 * 1000);
  const stale = await overviewAi();
  assert.equal(stale.ai.state, HEALTH_STATES.UNKNOWN);
  assert.match(stale.ai.message, /yakın zamanda erişilmedi/);
});

test('geçersiz kurumsal anahtar "anahtar yok" sayılıp anahtarsız sınanmaz; bağlantı testi başarısız olur', async (t) => {
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_DEFAULT_API_KEY: 'kisa anahtar' } });
  adminReset(t);
  const card = await aiCard();
  assert.equal(card.testable, true);
  const result = await postIntegrationTest('ai-provider');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.code, 'DEFAULT_KEY_INVALID');
  assert.equal(provider.calls.length, 0, 'anahtarsız istek gönderilmez');
});
