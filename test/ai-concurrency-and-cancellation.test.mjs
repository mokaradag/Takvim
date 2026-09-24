/**
 * Yapay zekâ · sınırlı eşzamanlılık, geri basınç, süre sınırı ve iptal.
 *
 * Kapasite her yolda (başarı, hata, süre aşımı, iptal) bırakılır; sıra
 * sınırlıdır; tek bir küresel kilit yoktur; iptal edilen ya da süresi dolan
 * isteğin geç gelen yanıtı uygulanmaz. Süre testleri duvar saatini beklemez:
 * zamanlayıcılar sahte saatle ilerletilir.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAiProvider } from './helpers/fakeAiProvider.mjs';
import { DEFAULT_KEY, PERSONAL_KEY_A } from './helpers/aiStack.mjs';

const { createAiAdmissionController } = await import('../src/server/ai/admissionController.js');
const { createAiDeadline, raceWithAbort, abortableDelay } = await import('../src/server/ai/aiDeadline.js');
const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
const { validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');

const MESSAGES = [{ role: 'user', content: 'Deneme isteği' }];
const REGISTRY = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry;

function limits(overrides = {}) {
  return { maxActive: 4, maxQueued: 4, maxActivePerUser: 2, maxQueuedPerUser: 2, ...overrides };
}

/** Sinyale eklenen ve kaldırılan dinleyicileri sayar. */
function countedSignal(controller = new AbortController()) {
  const { signal } = controller;
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { counts.added += 1; return add(...args); };
  signal.removeEventListener = (...args) => { counts.removed += 1; return remove(...args); };
  return { controller, signal, counts };
}

function gatewayFor(t, { provider, env = {}, sicils = null, credential = { source: 'personal', apiKey: PERSONAL_KEY_A }, random = () => 0 } = {}) {
  resetAiTelemetryForTests();
  t.after(() => resetAiTelemetryForTests());
  const config = parseAiConfig({
    MERGEN_ROTA_AI_ENABLED: 'true',
    MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
    MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
    ...env
  });
  assert.deepEqual(config.issues, []);
  const admission = createAiAdmissionController({ limits: config.limits });
  const queue = sicils ? [...sicils] : null;
  const gateway = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admission,
    loadConfig: () => config,
    loadRegistry: async () => REGISTRY,
    resolveCredential: async () => credential,
    currentSicil: async () => (queue ? queue.shift() : 900001),
    random
  });
  const chat = (options = {}) => gateway.completeChat({ profile: 'chat.fast', messages: MESSAGES, ...options });
  return { gateway, admission, chat, config };
}

/* ── Kapasite denetimi ────────────────────────────────────── */

test('küresel sınır içinde farklı kullanıcılar birlikte yürür; sıra FIFO ile ve dolunca AI_BUSY ile çalışır', async () => {
  const admission = createAiAdmissionController({ limits: limits({ maxActive: 2, maxQueued: 2 }) });
  const a = await admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 });
  const b = await admission.acquire({ userKey: 'b', modelKey: 'm', timeoutMs: 60000 });
  assert.equal(admission.status().active, 2);
  const order = [];
  const c = admission.acquire({ userKey: 'c', modelKey: 'm', timeoutMs: 60000 }).then((lease) => { order.push('c'); return lease; });
  const d = admission.acquire({ userKey: 'd', modelKey: 'm', timeoutMs: 60000 }).then((lease) => { order.push('d'); return lease; });
  assert.equal(admission.status().queued, 2);
  await assert.rejects(admission.acquire({ userKey: 'e', modelKey: 'm', timeoutMs: 60000 }), (error) => {
    assert.equal(error.code, 'AI_BUSY');
    assert.equal(error.status, 503);
    assert.equal(error.details.scope, 'global');
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  a.release();
  const leaseC = await c;
  b.release();
  const leaseD = await d;
  assert.deepEqual(order, ['c', 'd']);
  assert.ok(leaseC.queueWaitMs >= 0);
  leaseC.release();
  leaseD.release();
  leaseD.release();
  assert.deepEqual({ active: admission.status().active, queued: admission.status().queued }, { active: 0, queued: 0 });
  assert.equal(admission.status().counters.rejectedBusy, 1);
});

test('kullanıcı sınırına takılan bekleyen, başka kullanıcının isteğini engellemez; kullanıcı sırası da sınırlıdır', async () => {
  const admission = createAiAdmissionController({ limits: limits({ maxActivePerUser: 1, maxQueuedPerUser: 1 }) });
  const first = await admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 });
  const second = admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 });
  await assert.rejects(admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 }), (error) => error.code === 'AI_BUSY' && error.details.scope === 'user');
  const other = await admission.acquire({ userKey: 'b', modelKey: 'm', timeoutMs: 60000 });
  assert.equal(admission.status().active, 2, 'B, A’nın bekleyeninin arkasında kalmaz');
  first.release();
  const secondLease = await second;
  secondLease.release();
  other.release();
  assert.equal(admission.status().active, 0);
});

test('model başına sınır yalnızca o modeli sıraya alır', async () => {
  const admission = createAiAdmissionController({ limits: limits() });
  const heavy = await admission.acquire({ userKey: 'a', modelKey: 'agir', modelLimit: 1, timeoutMs: 60000 });
  const heavyWaiting = admission.acquire({ userKey: 'b', modelKey: 'agir', modelLimit: 1, timeoutMs: 60000 });
  const light = await admission.acquire({ userKey: 'b', modelKey: 'hafif', modelLimit: 1, timeoutMs: 60000 });
  assert.deepEqual({ active: admission.status().active, queued: admission.status().queued }, { active: 2, queued: 1 });
  heavy.release();
  (await heavyWaiting).release();
  light.release();
  assert.equal(admission.status().active, 0);
});

test('sırada süresi dolan istek AI_QUEUE_TIMEOUT alır ve sıradan çıkar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const admission = createAiAdmissionController({ limits: limits({ maxActive: 1 }) });
  const holder = await admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 });
  const waiting = admission.acquire({ userKey: 'b', modelKey: 'm', timeoutMs: 500 });
  t.mock.timers.tick(499);
  assert.equal(admission.status().queued, 1);
  t.mock.timers.tick(1);
  await assert.rejects(waiting, (error) => error.code === 'AI_QUEUE_TIMEOUT' && error.status === 503 && error.details.queueTimeoutMs === 500);
  assert.equal(admission.status().queued, 0);
  assert.equal(admission.status().counters.queueTimeouts, 1);
  holder.release();
  assert.equal(admission.status().active, 0);
});

test('sıradayken iptal edilen istek hemen çıkar ve dinleyici bırakılır; kabul edilen bekleyenin dinleyicisi de kaldırılır', async () => {
  const admission = createAiAdmissionController({ limits: limits({ maxActive: 1 }) });
  const holder = await admission.acquire({ userKey: 'a', modelKey: 'm', timeoutMs: 60000 });
  const cancelled = countedSignal();
  const waiting = admission.acquire({ userKey: 'b', modelKey: 'm', signal: cancelled.signal, timeoutMs: 60000 });
  cancelled.controller.abort();
  await assert.rejects(waiting, (error) => error.code === 'AI_CANCELLED' && error.status === 499);
  assert.equal(admission.status().queued, 0);
  assert.equal(cancelled.counts.removed, cancelled.counts.added);

  const admitted = countedSignal();
  const next = admission.acquire({ userKey: 'b', modelKey: 'm', signal: admitted.signal, timeoutMs: 60000 });
  holder.release();
  (await next).release();
  assert.equal(admitted.counts.removed, admitted.counts.added, 'kabul edilen bekleyenin dinleyicisi kalmaz');
  await assert.rejects(admission.acquire({ userKey: 'c', modelKey: 'm', signal: AbortSignal.abort(), timeoutMs: 60000 }), { code: 'AI_CANCELLED' });
  assert.equal(admission.status().active, 0);
});

/* ── Süre sınırı yardımcıları ─────────────────────────────── */

test('süre sınırı ile iptal ayrı kodlarla bildirilir; ilk neden korunur ve temizlik dinleyiciyi kaldırır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = createAiDeadline({ timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  assert.equal(timed.failure().code, 'AI_TIMEOUT');
  assert.equal(timed.signal.reason.code, 'AI_TIMEOUT');
  timed.dispose();

  const parent = countedSignal();
  const cancelled = createAiDeadline({ timeoutMs: 1000, parentSignal: parent.signal });
  parent.controller.abort();
  t.mock.timers.tick(1000);
  assert.equal(cancelled.failure().code, 'AI_CANCELLED', 'ilk neden iptaldir');
  cancelled.dispose();
  assert.equal(parent.counts.removed, parent.counts.added);

  const quiet = countedSignal();
  const disposed = createAiDeadline({ timeoutMs: 1000, parentSignal: quiet.signal });
  disposed.dispose();
  t.mock.timers.tick(5000);
  assert.equal(disposed.failure(), null, 'bırakılan süre sınırı sonradan tetiklenmez');
  assert.equal(quiet.counts.removed, quiet.counts.added);

  const raced = countedSignal();
  assert.equal(await raceWithAbort(() => 'tamam', raced.signal), 'tamam');
  assert.equal(raced.counts.removed, raced.counts.added);
  const delayed = new AbortController();
  const waiting = abortableDelay(10000, delayed.signal);
  delayed.abort(new Error('iptal'));
  await assert.rejects(waiting, /iptal/);
});

/* ── Ağ geçidi: kapasite her yolda bırakılır ──────────────── */

test('izin verilen istekler gerçekten eşzamanlı yürür; küresel serileştirme yoktur', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred' }, { type: 'deferred' }, { type: 'deferred' });
  const { admission, chat } = gatewayFor(t, { provider, sicils: [900001, 900002, 900003] });
  const results = [chat(), chat(), chat()];
  await provider.waitForActive(3);
  assert.equal(admission.status().active, 3);
  assert.equal(provider.peakActive, 3);
  provider.calls.forEach((call, index) => call.resolve(`yanıt ${index}`));
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map((result) => result.text), ['yanıt 0', 'yanıt 1', 'yanıt 2']);
  assert.equal(admission.status().active, 0);
});

test('kullanıcı sınırı ağ geçidinde de uygulanır; sınır aşımı AI_BUSY ile sağlayıcıya gitmeden reddedilir', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred' }, { type: 'deferred' });
  const { admission, chat } = gatewayFor(t, {
    provider,
    env: { MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0', MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS: '0' }
  });
  const first = chat();
  await provider.waitForActive(1);
  await assert.rejects(chat(), (error) => error.code === 'AI_BUSY' && error.details.scope === 'user');
  assert.equal(provider.calls.length, 1);
  provider.calls[0].resolve();
  await first;
  assert.equal(admission.status().active, 0);
});

test('kapasite başarıdan, sağlayıcı hatasından ve ağ hatasından sonra bırakılır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'reply' }, { type: 'status', status: 401 }, { type: 'network', code: 'ECONNRESET' }, { type: 'malformed' });
  const { admission, chat } = gatewayFor(t, { provider });
  assert.equal((await chat()).credentialSource, 'personal');
  assert.equal(admission.status().active, 0);
  await assert.rejects(chat(), { code: 'AI_KEY_INVALID' });
  assert.equal(admission.status().active, 0);
  await assert.rejects(chat(), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(admission.status().active, 0);
  await assert.rejects(chat(), { code: 'AI_PROVIDER_RESPONSE_INVALID' });
  assert.equal(admission.status().active, 0);
  assert.equal(provider.calls.length, 4, 'yalnızca bağlantı kurulamadığında yeniden denenir');
});

test('yavaş sağlayıcı süre sınırıyla kesilir: AI_TIMEOUT döner, sağlayıcı çağrısı iptal edilir, kapasite bırakılır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stall' });
  const { admission, chat } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '30000' } });
  const pending = chat();
  await provider.waitForActive(1);
  t.mock.timers.tick(29999);
  assert.equal(admission.status().active, 1);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error) => error.code === 'AI_TIMEOUT' && error.status === 504 && error.details.timeoutMs === 30000);
  assert.equal(provider.calls[0].aborted, true);
  assert.equal(provider.calls[0].signal.aborted, true);
  assert.equal(admission.status().active, 0);
});

test('istemci iptali sağlayıcı çağrısını keser ve kapasiteyi bırakır; zaman aşımından ayrı bildirilir', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stall' });
  const { admission, chat } = gatewayFor(t, { provider });
  const client = countedSignal();
  const pending = chat({ signal: client.signal });
  await provider.waitForActive(1);
  client.controller.abort();
  await assert.rejects(pending, (error) => error.code === 'AI_CANCELLED' && error.status === 499);
  assert.equal(provider.calls[0].aborted, true);
  assert.equal(admission.status().active, 0);
  assert.equal(client.counts.removed, client.counts.added, 'istemci sinyalinde dinleyici kalmaz');
});

test('sıradayken iptal edilen istek sağlayıcıya hiç gitmez', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred' });
  const { admission, chat } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '1', MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1' } });
  const holder = chat();
  await provider.waitForActive(1);
  const client = new AbortController();
  const queued = chat({ signal: client.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admission.status().queued, 1);
  client.abort();
  await assert.rejects(queued, { code: 'AI_CANCELLED' });
  assert.equal(provider.calls.length, 1);
  provider.calls[0].resolve();
  await holder;
  assert.equal(admission.status().active, 0);
});

test('iptalden sonra gelen geç yanıt uygulanmaz; kapasite sağlayıcıyı beklemeden bırakılır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred', ignoreAbort: true });
  const { admission, chat } = gatewayFor(t, { provider });
  const client = new AbortController();
  const pending = chat({ signal: client.signal });
  await provider.waitForActive(1);
  client.abort();
  await assert.rejects(pending, { code: 'AI_CANCELLED' });
  assert.equal(admission.status().active, 0, 'sinyale uymayan sağlayıcı kapasiteyi tutamaz');
  provider.calls[0].resolve('geç gelen yanıt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admission.status().active, 0);
});

test('süre dolduktan sonra gelen yanıt uygulanmaz', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred', ignoreAbort: true });
  const { admission, chat } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '2000' } });
  const pending = chat();
  await provider.waitForActive(1);
  t.mock.timers.tick(2000);
  await assert.rejects(pending, { code: 'AI_TIMEOUT' });
  provider.calls[0].resolve('çok geç');
  assert.equal(admission.status().active, 0);
});

/* ── Yeniden deneme politikası ────────────────────────────── */

test('yalnızca bağlantı kurulamadığında, bir kez ve titreşimli beklemeyle yeniden denenir', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'reply', text: 'ikinci denemede' });
  const { chat } = gatewayFor(t, { provider });
  const result = await chat();
  assert.equal(result.text, 'ikinci denemede');
  assert.equal(provider.calls.length, 2);

  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'network', code: 'ECONNREFUSED' }, { type: 'reply' });
  await assert.rejects(chat(), (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && error.details.networkCode === 'ECONNREFUSED');
  assert.equal(provider.calls.length, 4, 'ikinci başarısızlıktan sonra yeniden denenmez');
});

for (const [label, behavior] of [
  ['geçersiz anahtar', { type: 'status', status: 401 }],
  ['yetki', { type: 'status', status: 403 }],
  ['oran sınırı', { type: 'status', status: 429 }],
  ['sağlayıcı hatası', { type: 'status', status: 503 }],
  ['istek geçersiz', { type: 'status', status: 400 }],
  ['bağlantı sıfırlandı', { type: 'network', code: 'ECONNRESET' }]
]) {
  test(`${label} yeniden denenmez`, async (t) => {
    const provider = createFakeAiProvider();
    provider.enqueue(behavior, { type: 'reply' });
    const { chat } = gatewayFor(t, { provider });
    await assert.rejects(chat());
    assert.equal(provider.calls.length, 1);
  });
}

test('kalan süre yetmiyorsa bağlantı hatası da yeniden denenmez', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'reply' });
  const { chat } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000' } });
  await assert.rejects(chat(), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(provider.calls.length, 1);
});

test('geçersiz iletiler sağlayıcıya gitmeden AI_REQUEST_INVALID ile reddedilir', async (t) => {
  const provider = createFakeAiProvider();
  const { gateway } = gatewayFor(t, { provider });
  for (const messages of [[], [{ role: 'root', content: 'x' }], [{ role: 'user', content: 'x'.repeat(40000) }], 'metin']) {
    await assert.rejects(gateway.completeChat({ profile: 'chat.fast', messages }), { code: 'AI_REQUEST_INVALID' });
  }
  await assert.rejects(gateway.completeChat({ profile: 'embedding', messages: MESSAGES }), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'CAPABILITY_MISMATCH');
  assert.equal(provider.calls.length, 0);
});
