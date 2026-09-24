/**
 * Yapay zekâ · OpenAI uyumlu sağlayıcı bağdaştırıcısı.
 *
 * Gerçek `fetch` bağdaştırıcısı gerçek soketler üzerinden yerel bir ağ geçidi
 * ikizine karşı sınanır: hata eşlemesi, bozuk ve aşırı büyük yanıt, yönlendirme,
 * iptalin bağlantıyı gerçekten kapatması ve sağlayıcının hata gövdesinin
 * (anahtarı yankılasa bile) hiçbir yere taşınmaması.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startFakeOpenAiCompatibleServer } from './helpers/fakeOpenAiCompatibleServer.mjs';
import { DEFAULT_KEY, PERSONAL_KEY_A, PERSONAL_KEY_B, captureConsole, createAiStack, runProbe, saveKey, validateKey } from './helpers/aiStack.mjs';

const {
  classifyProviderStatus,
  createOpenAiCompatibleProvider,
  isConnectFailure,
  parseChatCompletion
} = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const { setAiProviderForTests } = await import('../src/server/ai/aiRuntime.js');

const MESSAGES = [{ role: 'system', content: 'Kısa yanıt ver.' }, { role: 'user', content: 'Merhaba' }];

async function fakeServer(t, options = {}) {
  const server = await startFakeOpenAiCompatibleServer(options);
  t.after(() => server.close());
  return server;
}

function chat(provider, server, overrides = {}) {
  return provider.chatCompletion({
    baseUrl: server.baseUrl,
    apiKey: PERSONAL_KEY_A,
    model: 'hizli-model',
    messages: MESSAGES,
    maxOutputTokens: 64,
    signal: new AbortController().signal,
    ...overrides
  });
}

test('normal yanıt ayrıştırılır; istek modeli, iletileri, çıktı sınırını ve anahtarı taşır', async (t) => {
  const server = await fakeServer(t);
  const provider = createOpenAiCompatibleProvider();
  const result = await chat(provider, server);
  assert.equal(result.text, 'Merhaba, sahte ağ geçidi yanıt veriyor.');
  assert.equal(result.model, 'hizli-model');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 8, totalTokens: 28 });
  const [request] = server.state.requests;
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.bearer, PERSONAL_KEY_A);
  assert.deepEqual(request.body, { model: 'hizli-model', messages: MESSAGES, stream: false, max_tokens: 64 });
});

for (const [status, code, extra] of [
  [401, 'AI_KEY_INVALID'],
  [403, 'AI_UNAUTHORIZED'],
  [429, 'AI_RATE_LIMITED', { retryAfter: '7', retryAfterMs: 7000 }],
  [400, 'AI_REQUEST_INVALID'],
  [404, 'AI_CONFIGURATION_ERROR'],
  [408, 'AI_TIMEOUT'],
  [500, 'AI_PROVIDER_UNAVAILABLE'],
  [502, 'AI_PROVIDER_UNAVAILABLE'],
  [503, 'AI_PROVIDER_UNAVAILABLE'],
  [504, 'AI_TIMEOUT']
]) {
  test(`HTTP ${status} → ${code}; anahtarı yankılayan hata gövdesi taşınmaz`, async (t) => {
    const server = await fakeServer(t);
    server.setScenario({ status, retryAfter: extra?.retryAfter });
    await assert.rejects(chat(createOpenAiCompatibleProvider(), server), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.providerStatus, status);
      if (extra?.retryAfterMs) assert.equal(error.retryAfterMs, extra.retryAfterMs);
      const serialized = JSON.stringify({ message: error.message, details: error.details, cause: String(error.cause ?? '') });
      assert.equal(serialized.includes(PERSONAL_KEY_A), false);
      assert.equal(serialized.includes('Rejected'), false);
      return true;
    });
  });
}

test('bozuk JSON, eksik seçenek ve aşırı büyük gövde AI_PROVIDER_RESPONSE_INVALID olur', async (t) => {
  const server = await fakeServer(t);
  const provider = createOpenAiCompatibleProvider({ maxResponseBytes: 2048 });
  server.setScenario({ malformed: true });
  await assert.rejects(chat(provider, server), (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'MALFORMED_JSON');
  server.setScenario({ missingChoices: true });
  await assert.rejects(chat(provider, server), (error) => error.details.reason === 'MISSING_CHOICE');
  server.setScenario({ oversizedBytes: 10000 });
  await assert.rejects(chat(provider, server), (error) => error.details.reason === 'RESPONSE_TOO_LARGE');
});

test('yönlendirme izlenmez; anahtar başka adrese taşınmaz', async (t) => {
  const server = await fakeServer(t);
  server.setScenario({ redirect: true });
  await assert.rejects(chat(createOpenAiCompatibleProvider(), server), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.providerStatus === 302);
  assert.equal(server.state.requests.length, 1);
});

test('kapalı uç bağlantı hatası olarak sınıflandırılır ve yalnızca bu tür hata yinelenebilir sayılır', async (t) => {
  const server = await fakeServer(t);
  const baseUrl = server.baseUrl;
  await server.close();
  await assert.rejects(chat(createOpenAiCompatibleProvider(), { baseUrl }), (error) => {
    assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
    assert.equal(error.details.networkCode, 'ECONNREFUSED');
    assert.equal(isConnectFailure(error), true);
    assert.doesNotMatch(JSON.stringify(error.details), /127\.0\.0\.1/);
    return true;
  });
});

test('iptal süren isteği sağlayıcı tarafında da kapatır', async (t) => {
  const server = await fakeServer(t);
  server.setScenario({ stall: true });
  const controller = new AbortController();
  const pending = chat(createOpenAiCompatibleProvider(), server, { signal: controller.signal });
  while (server.state.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('istemci ayrıldı'));
  await assert.rejects(pending, /istemci ayrıldı/);
  await server.waitForClosedRequests(1);
  assert.equal(server.state.closedBeforeResponse, 1, 'aşağı akıştaki iş durdurulur');
});

test('model listesi HTTP durumunu ve Retry-After değerini döndürür; hata gövdesi okunmaz', async (t) => {
  const server = await fakeServer(t, { validKeys: [PERSONAL_KEY_A] });
  const provider = createOpenAiCompatibleProvider();
  const signal = new AbortController().signal;
  assert.deepEqual(await provider.listModels({ baseUrl: server.baseUrl, apiKey: PERSONAL_KEY_A, signal }), { status: 200, retryAfter: null });
  assert.deepEqual(await provider.listModels({ baseUrl: server.baseUrl, apiKey: DEFAULT_KEY, signal }), { status: 401, retryAfter: null });
  assert.deepEqual(await provider.listModels({ baseUrl: server.baseUrl, signal }), { status: 401, retryAfter: null });
  assert.equal(server.state.requests[2].bearer, '', 'anahtar yoksa Authorization gönderilmez');
  server.setScenario({ status: 429, retryAfter: 30 });
  const limited = await provider.listModels({ baseUrl: server.baseUrl, apiKey: PERSONAL_KEY_A, signal });
  assert.deepEqual(limited, { status: 429, retryAfter: '30' });
  assert.equal(classifyProviderStatus(limited.status, limited.retryAfter).retryAfterMs, 30000);
});

test('yanıt iletisi assistant rolünde değilse (isteği yankılayan vekil) geçerli model yanıtı sayılmaz', () => {
  for (const message of [{ role: 'user', content: 'Bağlantı sınaması: kısa bir selam yaz.' }, { content: 'rolsüz metin' }]) {
    assert.throws(() => parseChatCompletion({ choices: [{ message, finish_reason: 'stop' }] }),
      (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'INVALID_ROLE');
  }
  assert.equal(parseChatCompletion({ choices: [{ message: { role: 'assistant', content: 'Merhaba.' } }] }).text, 'Merhaba.');
});

test('200 dönen ama model listesi olmayan yanıt (yanlış uçtaki HTML sayfası) kabul edilmez', async (t) => {
  const server = await fakeServer(t, { validKeys: [PERSONAL_KEY_A] });
  server.setScenario({ modelsHtml: true });
  const provider = createOpenAiCompatibleProvider();
  await assert.rejects(
    provider.listModels({ baseUrl: server.baseUrl, apiKey: PERSONAL_KEY_A, signal: new AbortController().signal }),
    (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID'
  );
});

/* ── Uçtan uca: rota → ağ geçidi → gerçek bağdaştırıcı → yerel ağ geçidi ── */

test('uçtan uca sınama gerçek bağdaştırıcıyla yanıt alır; reddedilen kişisel anahtar kurumsala aktarılmaz ve yankılanmaz', async (t) => {
  const server = await fakeServer(t, { validKeys: [DEFAULT_KEY] });
  createAiStack(t, { env: { MERGEN_ROTA_AI_BASE_URL: server.baseUrl } });
  setAiProviderForTests(null);
  const logs = captureConsole(t);

  const withDefault = await runProbe();
  assert.equal(withDefault.status, 200);
  assert.equal(withDefault.body.result.credentialSource, 'default');
  assert.equal(withDefault.body.result.model, 'Qwen3-Next-80B-A3B-Instruct');
  assert.equal(server.state.requests[0].body.max_tokens, 64);

  await saveKey(PERSONAL_KEY_A);
  const rejected = await runProbe();
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.error.code, 'AI_KEY_INVALID');
  assert.equal(rejected.body.error.details.credentialSource, 'personal');
  const validation = await validateKey();
  assert.equal(validation.body.validation.status, 'REJECTED');
  assert.deepEqual(server.state.requests.map((request) => request.bearer), [DEFAULT_KEY, PERSONAL_KEY_A, PERSONAL_KEY_A]);
  for (const text of [rejected.text, validation.text, logs.join('\n')]) {
    assert.equal(text.includes(PERSONAL_KEY_A), false);
    assert.equal(text.includes(DEFAULT_KEY), false);
    assert.equal(text.includes('Invalid key'), false);
  }
});

test('uçtan uca doğrulama: anahtarı denetleyen uçta VALID; anahtarsız da yanıt veren ya da HTML dönen uçta sonuç kaydedilmez', async (t) => {
  const guarded = await fakeServer(t, { validKeys: [PERSONAL_KEY_A] });
  const { db, setEnv } = createAiStack(t, { env: { MERGEN_ROTA_AI_BASE_URL: guarded.baseUrl } });
  setAiProviderForTests(null);
  await saveKey(PERSONAL_KEY_A);
  const valid = await validateKey();
  assert.equal(valid.status, 200);
  assert.equal(valid.body.validation.status, 'VALID');
  assert.deepEqual(guarded.state.requests.map((request) => request.bearer), [PERSONAL_KEY_A, '']);

  const open = await fakeServer(t);
  setEnv({ MERGEN_ROTA_AI_BASE_URL: open.baseUrl });
  await saveKey(PERSONAL_KEY_B);
  const unauthenticated = await validateKey();
  assert.equal(unauthenticated.status, 503);
  assert.equal(unauthenticated.body.error.details.reason, 'MODELS_ENDPOINT_UNAUTHENTICATED');
  assert.equal(db.aiUserCredentials[0].LastValidationStatus, null);

  open.setScenario({ modelsHtml: true });
  const html = await validateKey();
  assert.equal(html.status, 502);
  assert.equal(html.body.error.code, 'AI_PROVIDER_RESPONSE_INVALID');
  assert.equal(db.aiUserCredentials[0].LastValidationStatus, null);
});

test('istemci bağlantıyı kesince uçtan uca istek sağlayıcıda da kapanır ve 499 AI_CANCELLED döner', async (t) => {
  const server = await fakeServer(t);
  server.setScenario({ stall: true });
  createAiStack(t, { env: { MERGEN_ROTA_AI_BASE_URL: server.baseUrl } });
  setAiProviderForTests(null);
  const client = new AbortController();
  const pending = runProbe({ signal: client.signal });
  while (server.state.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  client.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.body.error.code, 'AI_CANCELLED');
  await server.waitForClosedRequests(1);
});
