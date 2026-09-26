/**
 * Yapay zekâ · ağ geçidinde AKIŞLI sohbet (`aiGateway.streamChat`).
 *
 * Akış, tam yanıtla aynı yoldan geçer (Sicil → rehber → yapılandırma → profil
 * → kapasite kirası → süre sınırı → anahtar → sağlayıcı). Kapasite kirası akış
 * boyunca tutulur ve tamamlanma, hata, süre aşımı ve iptal yollarının HER
 * birinde tam bir kez bırakılır. Yalnızca ilk metinden ÖNCEKİ bağlantı hatası
 * yinelenir; kişisel anahtarın hatası kurumsal anahtara düşmez. Süre testleri
 * duvar saatini beklemez: zamanlayıcılar sahte saatle ilerletilir.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAiProvider } from './helpers/fakeAiProvider.mjs';
import { DEFAULT_KEY, PERSONAL_KEY_A, SICIL_A, captureConsole, createAiStack } from './helpers/aiStack.mjs';

const { createAiAdmissionController } = await import('../src/server/ai/admissionController.js');
const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
const { resolveModelProfile, validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot, resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');
const { resetTelemetryRegistryForTests, snapshotOperations } = await import('../src/server/observability/telemetryRegistry.js');
const { getAiGateway } = await import('../src/server/ai/aiRuntime.js');
const { withSqlTransaction } = await import('../src/server/db/pool.js');

const PROMPT = 'Proje XYZ bütçesi nedir? (gizli soru metni)';
const ANSWER = 'Gizli yanıt metni: bütçe bilgisi burada.';
const MESSAGES = [{ role: 'system', content: 'Kısa yanıt ver.' }, { role: 'user', content: PROMPT }];
const REGISTRY = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry;
const route = (profile) => resolveModelProfile(REGISTRY, profile).route;

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

function gatewayFor(t, {
  provider = createFakeAiProvider(),
  env = {},
  credential = { source: 'personal', apiKey: PERSONAL_KEY_A },
  registry = REGISTRY,
  sicils = null,
  random = () => 0
} = {}) {
  resetAiTelemetryForTests();
  resetTelemetryRegistryForTests();
  t.after(() => {
    resetAiTelemetryForTests();
    resetTelemetryRegistryForTests();
  });
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
    loadRegistry: async () => registry,
    resolveCredential: async () => credential,
    currentSicil: async () => (queue ? queue.shift() : SICIL_A),
    verifySicil: async () => {},
    random
  });
  const received = [];
  const statuses = [];
  const stream = (options = {}) => gateway.streamChat({
    profile: 'chat.general',
    messages: MESSAGES,
    onText: (text) => { received.push(text); },
    onStatus: (status) => { statuses.push(status.phase); },
    ...options
  });
  return { gateway, admission, stream, received, statuses, provider };
}

async function until(predicate, rounds = 200) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

/* ── Profiller ─────────────────────────────────────────────── */

test('chat.general: profilin modeli ve çıktı sınırıyla akar; metin sırayla iletilir, sonuç tam metni taşır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stream', chunks: ['Mer', 'haba ', 'dünya.'], model: 'raporlanan-model' });
  const { stream, received, statuses, admission } = gatewayFor(t, { provider });
  const result = await stream();
  assert.deepEqual(received, ['Mer', 'haba ', 'dünya.']);
  assert.deepEqual(statuses, ['generating']);
  assert.equal(result.text, 'Merhaba dünya.');
  assert.equal(result.profile, 'chat.general');
  assert.equal(result.configuredModel, route('chat.general').model);
  assert.equal(result.model, 'raporlanan-model', 'yanıtı üreten model sağlayıcının bildirdiğidir');
  assert.equal(result.credentialSource, 'personal');
  assert.equal(result.finishReason, 'stop');
  assert.ok(Number.isFinite(result.firstTokenMs));
  const [call] = provider.calls;
  assert.equal(call.kind, 'stream');
  assert.equal(call.model, route('chat.general').model);
  assert.equal(call.maxOutputTokens, route('chat.general').maxOutputTokens);
  assert.deepEqual(call.messages, MESSAGES);
  assert.equal(admission.status().active, 0);
});

test('chat.reasoning: kendi modeli ve çıktı sınırı kullanılır; akıl yürütme yalnızca "düşünüyor" evresi olarak bildirilir', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stream', reasoning: 3, chunks: ['Derin ', 'yanıt'] });
  const { stream, received, statuses } = gatewayFor(t, { provider });
  const result = await stream({ profile: 'chat.reasoning' });
  assert.equal(result.text, 'Derin yanıt');
  assert.deepEqual(received, ['Derin ', 'yanıt']);
  assert.deepEqual(statuses, ['generating', 'thinking'], 'düşünme evresi bir kez bildirilir');
  assert.equal(provider.calls[0].model, route('chat.reasoning').model);
  assert.equal(provider.calls[0].maxOutputTokens, route('chat.reasoning').maxOutputTokens);
  assert.notEqual(route('chat.reasoning').model, route('chat.general').model);
});

test('bilinmeyen ya da kapalı profil sağlayıcıya gitmeden yapılandırma hatası olur', async (t) => {
  const disabled = validateModelRegistry({
    ...DEFAULT_AI_MODEL_REGISTRY,
    profiles: { ...DEFAULT_AI_MODEL_REGISTRY.profiles, 'chat.reasoning': { ...DEFAULT_AI_MODEL_REGISTRY.profiles['chat.reasoning'], enabled: false } }
  }).registry;
  const { stream, provider, admission } = gatewayFor(t, { registry: disabled });
  await assert.rejects(stream({ profile: 'chat.bilinmeyen' }), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'UNKNOWN_PROFILE');
  await assert.rejects(stream({ profile: 'chat.reasoning' }), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'PROFILE_DISABLED');
  await assert.rejects(stream({ profile: 'embedding' }), (error) => error.code === 'AI_CONFIGURATION_ERROR');
  assert.equal(provider.calls.length, 0);
  assert.equal(admission.status().active, 0);
});

/* ── Kapasite kirasının ömrü ───────────────────────────────── */

test('kapasite kirası akış BOYUNCA tutulur ve tamamlanınca bırakılır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream' });
  const { stream, admission, received } = gatewayFor(t, { provider });
  const pending = stream();
  await provider.waitForActive(1);
  assert.equal(admission.status().active, 1);
  provider.calls[0].emit('ilk parça');
  await until(() => received.length === 1);
  assert.equal(admission.status().active, 1, 'ilk metinden sonra da kira tutulur');
  provider.calls[0].emit(' ve devamı');
  await until(() => received.length === 2);
  assert.equal(admission.status().active, 1);
  provider.calls[0].complete();
  const result = await pending;
  assert.equal(result.text, 'ilk parça ve devamı');
  assert.equal(admission.status().active, 0);
  await until(() => provider.calls[0].streamClosed);
  assert.equal(provider.calls[0].streamClosed, true);
});

test('akış ortasındaki sağlayıcı hatasında kira bırakılır; hata kısmi yanıtı işaretler ve yinelenmez', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'interrupt', chunks: ['yarım '] }, { type: 'stream', text: 'ikinci çağrı olmamalı' });
  const { stream, admission, received } = gatewayFor(t, { provider });
  await assert.rejects(stream(), (error) => {
    assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
    assert.equal(error.details.partial, true);
    return true;
  });
  assert.deepEqual(received, ['yarım ']);
  assert.equal(provider.calls.length, 1, 'metin başladıktan sonra yeniden istenmez');
  assert.equal(admission.status().active, 0);
  assert.equal(aiTelemetrySnapshot().streams.interrupted, 1);
});

test('istemci iptali akışı sağlayıcıya kadar keser, kirayı bırakır ve dinleyici bırakmaz', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream' });
  const { stream, admission, received } = gatewayFor(t, { provider });
  const client = countedSignal();
  const pending = stream({ signal: client.signal });
  await provider.waitForActive(1);
  provider.calls[0].emit('başladı');
  await until(() => received.length === 1);
  client.controller.abort();
  await assert.rejects(pending, (error) => error.code === 'AI_CANCELLED' && error.status === 499 && error.details.partial === true);
  assert.equal(provider.calls[0].aborted, true);
  assert.equal(provider.calls[0].signal.aborted, true);
  assert.equal(admission.status().active, 0);
  assert.equal(client.counts.removed, client.counts.added, 'istemci sinyalinde dinleyici kalmaz');
  assert.equal(aiTelemetrySnapshot().streams.cancelled, 1);
});

test('iptalden sonra gelen parça uygulanmaz; sinyale uymayan sağlayıcı kirayı tutamaz', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream', ignoreAbort: true });
  const { stream, admission, received } = gatewayFor(t, { provider });
  const client = new AbortController();
  const pending = stream({ signal: client.signal });
  await provider.waitForActive(1);
  provider.calls[0].emit('önce');
  await until(() => received.length === 1);
  client.abort();
  await assert.rejects(pending, { code: 'AI_CANCELLED' });
  assert.equal(admission.status().active, 0);
  provider.calls[0].emit('geç gelen parça');
  provider.calls[0].complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ['önce'], 'geç parça hiçbir tüketiciye ulaşmaz');
  assert.equal(aiTelemetrySnapshot().succeeded, 0);
});

test('süre sınırı akışın ortasında da geçerlidir: AI_TIMEOUT, sağlayıcı çağrısı kesilir, kira bırakılır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream' });
  const { stream, admission, received } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '30000' } });
  const pending = stream();
  await provider.waitForActive(1);
  provider.calls[0].emit('yavaş model');
  await until(() => received.length === 1);
  t.mock.timers.tick(29999);
  assert.equal(admission.status().active, 1);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error) => error.code === 'AI_TIMEOUT' && error.details.partial === true);
  assert.equal(provider.calls[0].signal.aborted, true);
  assert.equal(admission.status().active, 0);
  assert.equal(aiTelemetrySnapshot().streams.timeout, 1);
});

test('profilin kendi süre sınırı (derin düşünme) genel süre sınırının yerine geçer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream' });
  const { stream, admission } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '30000' } });
  const pending = stream({ profile: 'chat.reasoning' });
  await provider.waitForActive(1);
  t.mock.timers.tick(30000);
  assert.equal(admission.status().active, 1, 'derin düşünme genel sınırla kesilmez');
  t.mock.timers.tick(route('chat.reasoning').timeoutMs - 30000);
  await assert.rejects(pending, { code: 'AI_TIMEOUT' });
  assert.equal(admission.status().active, 0);
});

test('yavaş tüketici (geri basınç) süre sınırını aşamaz; kira bırakılır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stream', chunks: ['bir', 'iki'] });
  const { stream, admission } = gatewayFor(t, { provider, env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '5000' } });
  const pending = stream({ onText: () => new Promise(() => {}) });
  await provider.waitForActive(1);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await assert.rejects(pending, { code: 'AI_TIMEOUT' });
  assert.equal(admission.status().active, 0);
});

test('sıra sınırı: kapasite doluyken bekleyen akış süre dolunca AI_QUEUE_TIMEOUT alır ve sağlayıcıya gitmez', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'deferred-stream' });
  const { stream, admission } = gatewayFor(t, {
    provider,
    env: { MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '1', MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_QUEUE_TIMEOUT_MS: '2000' }
  });
  const holder = stream();
  await provider.waitForActive(1);
  const queued = stream();
  await until(() => admission.status().queued === 1);
  t.mock.timers.tick(2000);
  await assert.rejects(queued, { code: 'AI_QUEUE_TIMEOUT' });
  assert.equal(provider.calls.length, 1);
  provider.calls[0].complete();
  await assert.rejects(holder, (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'EMPTY_COMPLETION');
  assert.equal(admission.status().active, 0);
});

/* ── Anahtar çözümü ────────────────────────────────────────── */

test('kişisel anahtar ve kurumsal anahtar ağ geçidinin çözdüğü kaynakla kullanılır', async (t) => {
  const personal = gatewayFor(t, { credential: { source: 'personal', apiKey: PERSONAL_KEY_A } });
  assert.equal((await personal.stream()).credentialSource, 'personal');
  assert.equal(personal.provider.calls[0].apiKey, PERSONAL_KEY_A);
  const corporate = gatewayFor(t, { credential: { source: 'default', apiKey: DEFAULT_KEY } });
  assert.equal((await corporate.stream()).credentialSource, 'default');
  assert.equal(corporate.provider.calls[0].apiKey, DEFAULT_KEY);
});

test('kişisel anahtar reddedilince kurumsal anahtara DÜŞÜLMEZ; hata kişisel kaynakla döner', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'status', status: 401 }, { type: 'stream' });
  const { stream, admission } = gatewayFor(t, { provider });
  await assert.rejects(stream(), (error) => error.code === 'AI_KEY_INVALID' && error.details.credentialSource === 'personal');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls.some((call) => call.apiKey === DEFAULT_KEY), false);
  assert.equal(admission.status().active, 0);
});

/* ── Yeniden deneme ───────────────────────────────────────── */

test('ilk metinden ÖNCE bağlantı kurulamazsa bir kez yinelenir; sayaç yinelemeyi sayar', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'stream', text: 'ikinci denemede' });
  const { stream, received } = gatewayFor(t, { provider });
  const result = await stream();
  assert.equal(result.text, 'ikinci denemede');
  assert.equal(received.join(''), 'ikinci denemede');
  assert.equal(provider.calls.length, 2);
  assert.equal(aiTelemetrySnapshot().retries, 1);
});

test('bağlantı dışındaki hatalar ve metin başladıktan sonraki kopma yinelenmez', async (t) => {
  const failing = createFakeAiProvider();
  failing.enqueue({ type: 'status', status: 500 }, { type: 'stream' });
  await assert.rejects(gatewayFor(t, { provider: failing }).stream(), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(failing.calls.length, 1);
  const interrupted = createFakeAiProvider();
  interrupted.enqueue({ type: 'interrupt', chunks: ['kısmi'] }, { type: 'stream' });
  await assert.rejects(gatewayFor(t, { provider: interrupted }).stream(), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(interrupted.calls.length, 1, 'yarıda kalan yanıt baştan ikinci kez üretilmez');
  assert.equal(aiTelemetrySnapshot().retries, 0);
});

/* ── Boş yanıt, gözlemci ve işlem sınırı ───────────────────── */

test('görünür metin üretmeyen akış boş yanıt hatasıdır; bitiş nedeni taşınır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stream', reasoning: 2, chunks: ['   '], finishReason: 'length' });
  const { stream, admission } = gatewayFor(t, { provider });
  await assert.rejects(stream(), (error) => {
    assert.equal(error.code, 'AI_PROVIDER_RESPONSE_INVALID');
    assert.equal(error.details.reason, 'EMPTY_COMPLETION');
    assert.equal(error.details.finishReason, 'length');
    return true;
  });
  assert.equal(admission.status().active, 0);
});

test('durum gözlemcisinin hatası üretimi bozmaz', async (t) => {
  const { stream } = gatewayFor(t);
  const result = await stream({ onStatus: () => { throw new Error('gözlemci hatası'); } });
  assert.equal(result.text, 'Merhaba, bağlantı çalışıyor.');
});

test('akış açık bir SQL işlemi içinde başlatılamaz (model üretimi süresince bağlantı tutulmaz)', async (t) => {
  const { provider } = createAiStack(t);
  await assert.rejects(
    withSqlTransaction(() => getAiGateway().streamChat({ profile: 'chat.general', messages: MESSAGES, onText: () => {} })),
    (error) => error.code === 'AI_INTERNAL_ERROR' && error.details.reason === 'SQL_TRANSACTION_ACTIVE'
  );
  assert.equal(provider.calls.length, 0);
});

/* ── Telemetri ────────────────────────────────────────────── */

test('ilk metin gecikmesi, toplam istek ve akış sonucu ölçülür; ölçümler içerik ya da anahtar taşımaz', async (t) => {
  const logs = captureConsole(t);
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'stream', chunks: [ANSWER.slice(0, 10), ANSWER.slice(10)] }, { type: 'status', status: 503 });
  const { stream } = gatewayFor(t, { provider });
  await stream();
  await assert.rejects(stream(), { code: 'AI_PROVIDER_UNAVAILABLE' });
  const snapshot = aiTelemetrySnapshot();
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.succeeded, 1);
  assert.equal(snapshot.latency.firstToken.count, 1);
  assert.equal(snapshot.latency.streamGeneration.count, 1);
  assert.deepEqual(snapshot.streams, { completed: 1, cancelled: 0, timeout: 0, interrupted: 0, failed: 1 });
  assert.equal(snapshot.byProfile['chat.general'] != null, true);
  const operations = new Map(snapshotOperations().map((row) => [row.operation, row]));
  for (const name of ['ai.request', 'ai.provider.stream', 'ai.stream.first_token', 'ai.stream.provider_start']) {
    assert.ok(operations.has(name), `${name} ölçülmelidir`);
  }
  assert.equal(operations.get('ai.provider.stream').errorCount, 1);
  const serialized = JSON.stringify({ snapshot, operations: [...operations.values()], logs });
  for (const secret of [PROMPT, ANSWER, ANSWER.slice(10), PERSONAL_KEY_A, DEFAULT_KEY, 'Kısa yanıt ver.']) {
    assert.equal(serialized.includes(secret), false, `telemetri/günlük içerik taşımamalı: ${secret.slice(0, 12)}…`);
  }
});

test('sağlayıcı done olayından sonra iptal biten yanıtı kaybettirmez', async (t) => {
  const controller = new AbortController();
  let reads = 0;
  const provider = { streamChatCompletion: async () => ({ events: {
    [Symbol.asyncIterator]() { return {
      async next() {
        reads += 1;
        if (reads === 1) return { value: { type: 'text', text: 'Tam yanıt' }, done: false };
        if (reads === 2) return { value: { type: 'done', finishReason: 'stop' }, done: false };
        controller.abort();
        return { done: true };
      },
      async return() { controller.abort(); return { done: true }; }
    }; }
  } }) };
  const { stream, admission } = gatewayFor(t, { provider });
  const result = await stream({ signal: controller.signal });
  assert.equal(result.text, 'Tam yanıt');
  assert.equal(reads, 2);
  assert.equal(admission.status().active, 0);
});
