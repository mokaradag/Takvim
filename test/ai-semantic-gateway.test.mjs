/**
 * Yapay zekâ · anlamsal model sınırı: sağlayıcı bağdaştırıcısı ve ağ geçidi.
 *
 * Gömme (`/embeddings`) ve yeniden sıralama (`/rerank`) çağrıları sohbetle aynı
 * ağ geçidi kurallarından geçer: güvenilir Sicil, yapılandırma, profil ve
 * yetenek, kapasite kirası (model sınırı dâhil), süre sınırı, iptal, kimlik
 * bilgisi, dar yineleme ve telemetri. Ön işleme önekleri yalnızca ağ geçidinde
 * eklenir. Sağlayıcı yanıtı yalnızca zarf düzeyinde ayrıştırılır; değerler
 * anlamsal sözleşmede doğrulanır. Gerçek model yoktur: yerel HTTP ikizi ve
 * süreç içi sağlayıcı ikizi kullanılır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startFakeOpenAiCompatibleServer } from './helpers/fakeOpenAiCompatibleServer.mjs';
import { DEFAULT_KEY, PERSONAL_KEY_A, captureConsole, createAiStack } from './helpers/aiStack.mjs';
import { DEFAULT_REGISTRY as REGISTRY, assertIdle as idle, registryWith, semanticGatewayFor as gatewayFor } from './helpers/semanticGateway.mjs';

const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
const admissionModule = await import('../src/server/ai/admissionController.js');
const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
const { AI_PROFILES, resolveModelProfile, validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { snapshotOperations } = await import('../src/server/observability/telemetryRegistry.js');
const { createOpenAiCompatibleProvider, embeddingResponseBudget } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const { SEMANTIC_LIMITS } = await import('../src/domain/ai/semanticContract.js');
const { getAiGateway } = await import('../src/server/ai/aiRuntime.js');
const { withSqlTransaction } = await import('../src/server/db/pool.js');

const EMBEDDING = resolveModelProfile(REGISTRY, AI_PROFILES.EMBEDDING).route;
const RERANK = resolveModelProfile(REGISTRY, AI_PROFILES.RERANK).route;

const embedQuery = (gateway, options = {}) => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['Gecikmiş işlerim'], purpose: 'query', ...options });
const embedDocuments = (gateway, options = {}) => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['Belge A', 'Belge B'], purpose: 'document', ...options });
const rerank = (gateway, options = {}) => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: 'Soru', documents: ['Belge A', 'Belge B'], ...options });

/* ── Sağlayıcı bağdaştırıcısı (gerçek fetch, yerel HTTP ikizi) ── */

test('bağdaştırıcı gömme ve yeniden sıralamayı OpenAI ve Cohere/Jina tel biçimiyle ister; yanıt dizin adresli biçime çevrilir, sıralanmaz', async (t) => {
  const server = await startFakeOpenAiCompatibleServer({ semantic: { embed: (text) => [text.length, 1, 0], rerank: (query, document) => document.length } });
  t.after(() => server.close());
  const provider = createOpenAiCompatibleProvider();
  const { signal } = new AbortController();
  const embedded = await provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'anahtar', model: 'gomme', input: ['ab', 'abc'], signal });
  assert.deepEqual(embedded, { model: 'gomme', embeddings: [{ index: 0, vector: [2, 1, 0] }, { index: 1, vector: [3, 1, 0] }] });
  const request = server.state.requests.at(-1);
  assert.deepEqual({ method: request.method, path: request.path, bearer: request.bearer }, { method: 'POST', path: '/v1/embeddings', bearer: 'anahtar' });
  assert.deepEqual(request.body, { model: 'gomme', input: ['ab', 'abc'], encoding_format: 'float' });

  // Sunucu sonuçları skora göre dizer; bağdaştırıcı yanıt sırasını ve dizinleri olduğu gibi taşır, her aday için skor ister.
  const scored = await provider.rerank({ baseUrl: server.baseUrl, apiKey: 'anahtar', model: 'sirala', query: 'soru', documents: ['a', 'bbb', 'cc'], signal });
  assert.deepEqual(scored, { model: 'sirala', scores: [{ index: 1, score: 3 }, { index: 2, score: 2 }, { index: 0, score: 1 }] });
  assert.deepEqual(server.state.requests.at(-1).body, { model: 'sirala', query: 'soru', documents: ['a', 'bbb', 'cc'], top_n: 3 });
  assert.equal(server.state.requests.at(-1).path, '/v1/rerank');

  // Zarf dışındaki değerler doğrulanmaz ya da düzeltilmez: nesne olmayan giriş aynen, nesne giriş yalnızca iki alanla geçer.
  server.setScenario({ semanticPayload: () => ({ data: [null, { index: '0', embedding: ['1', NaN], extra: 'yok sayılır' }] }) });
  assert.deepEqual((await provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', input: ['x', 'y'], signal })).embeddings,
    [null, { index: '0', vector: ['1', null] }]);
});

test('bağdaştırıcı bozuk zarfı, sayısal olmayan model kimliğini ve HTTP hatalarını kararlı koda indirger; hata gövdesini taşımaz', async (t) => {
  const server = await startFakeOpenAiCompatibleServer();
  t.after(() => server.close());
  const provider = createOpenAiCompatibleProvider();
  const { signal } = new AbortController();
  const embed = () => provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'gizli-anahtar-123', model: 'm', input: ['x'], signal });
  const score = () => provider.rerank({ baseUrl: server.baseUrl, apiKey: 'gizli-anahtar-123', model: 'm', query: 'q', documents: ['x'], signal });
  const cases = [
    [{ semanticPayload: () => ({ data: 'liste değil' }) }, embed, 'AI_PROVIDER_RESPONSE_INVALID', 'EMBEDDING_RESPONSE_INVALID'],
    [{ semanticPayload: () => [] }, embed, 'AI_PROVIDER_RESPONSE_INVALID', 'EMBEDDING_RESPONSE_INVALID'],
    [{ semanticPayload: () => ({ model: 7, data: [] }) }, embed, 'AI_PROVIDER_RESPONSE_INVALID', 'EMBEDDING_RESPONSE_INVALID'],
    [{ semanticPayload: () => ({ results: { 0: 1 } }) }, score, 'AI_PROVIDER_RESPONSE_INVALID', 'RERANK_RESPONSE_INVALID'],
    [{ semanticPayload: () => ({ model: ['m'], results: [] }) }, score, 'AI_PROVIDER_RESPONSE_INVALID', 'RERANK_RESPONSE_INVALID'],
    [{ malformed: true }, embed, 'AI_PROVIDER_RESPONSE_INVALID', 'MALFORMED_JSON'],
    [{ malformed: true }, score, 'AI_PROVIDER_RESPONSE_INVALID', 'MALFORMED_JSON'],
    [{ status: 400 }, embed, 'AI_REQUEST_INVALID', undefined],
    [{ status: 404 }, score, 'AI_CONFIGURATION_ERROR', undefined],
    [{ status: 401 }, embed, 'AI_KEY_INVALID', undefined],
    [{ status: 503 }, score, 'AI_PROVIDER_UNAVAILABLE', undefined],
    [{ status: 504 }, embed, 'AI_TIMEOUT', undefined],
    [{ redirect: true }, embed, 'AI_CONFIGURATION_ERROR', undefined]
  ];
  for (const [scenario, call, code, reason] of cases) {
    server.setScenario(scenario);
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, code, JSON.stringify(scenario));
      assert.equal(error.details.reason, reason, JSON.stringify(scenario));
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes('gizli-anahtar-123'), false);
      return true;
    });
  }
});

test('gömme yanıtının okuma sınırı girdi sayısıyla ölçeklenir: 4096 boyutlu katalog kabul edilir, sınırı aşan yanıt reddedilir', async (t) => {
  const server = await startFakeOpenAiCompatibleServer();
  t.after(() => server.close());
  const provider = createOpenAiCompatibleProvider();
  const { signal } = new AbortController();
  const input = Array.from({ length: 19 }, (_, i) => `Araç ${i}`);
  // Sabit 1 MiB sınırını aşan gerçekçi yanıt: 19 belge × 4096 boyut, uzun ondalıklar.
  server.setScenario({ semanticPayload: (body) => ({ model: body.model, data: body.input.map((_, index) => ({
    index, embedding: Array.from({ length: 4096 }, (__, j) => Math.sin(index * 4096 + j + 0.123456789))
  })) }) });
  const large = await provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', input, signal });
  assert.equal(large.embeddings.length, 19);
  assert.equal(large.embeddings[18].vector.length, 4096);
  // Tek girdinin bütçesi 1 MiB + 256 KiB'dir; fazlası okunmadan reddedilir.
  server.setScenario({ oversizedBytes: 1024 * 1024 + 8192 * 32 + 64 });
  await assert.rejects(provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', input: ['x'], signal }),
    (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'RESPONSE_TOO_LARGE');
  // Yeniden sıralamanın sınırı sabittir (en çok 20 kısa aday).
  server.setScenario({ oversizedBytes: 1024 * 1024 + 64 });
  await assert.rejects(provider.rerank({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', query: 'q', documents: ['x'], signal }),
    (error) => error.details.reason === 'RESPONSE_TOO_LARGE');
});

test('ağ geçidinden geçen gerçek HTTP çağrısı önekli metni gönderir; iptal sağlayıcı bağlantısını keser ve kira bırakılır', async (t) => {
  const server = await startFakeOpenAiCompatibleServer();
  t.after(() => server.close());
  const { gateway, admission } = gatewayFor(t, { provider: createOpenAiCompatibleProvider(), env: { MERGEN_ROTA_AI_BASE_URL: server.baseUrl } });
  const result = await embedDocuments(gateway);
  assert.deepEqual(server.state.requests.at(-1).body.input, ['passage: Belge A', 'passage: Belge B']);
  assert.equal(server.state.requests.at(-1).bearer, DEFAULT_KEY);
  assert.equal(result.embeddings.length, 2);
  server.setScenario({ stall: true });
  const controller = new AbortController();
  const pending = rerank(gateway, { signal: controller.signal });
  await server.waitForRequests(server.state.requests.length + 1);
  controller.abort();
  await assert.rejects(pending, { code: 'AI_CANCELLED' });
  await server.waitForClosedRequests(1);
  idle(admission);
});

/* ── Ağ geçidi ───────────────────────────────────────────── */

test('ön işleme önekleri kayıttan ve yalnızca ağ geçidinde eklenir; yeniden sıralama metni değişmeden gider; rota uzayı adlandırır', async (t) => {
  const { gateway, admission, provider } = gatewayFor(t);
  const query = await embedQuery(gateway);
  assert.deepEqual(provider.calls[0].input, ['query: Gecikmiş işlerim']);
  assert.equal(provider.calls[0].model, EMBEDDING.model);
  assert.equal(provider.calls[0].apiKey, DEFAULT_KEY);
  assert.deepEqual(query.route, {
    profile: AI_PROFILES.EMBEDDING, model: EMBEDDING.model, provider: EMBEDDING.provider, capabilities: EMBEDDING.capabilities,
    preprocessing: { id: 'e5-query-passage', queryPrefix: 'query: ', documentPrefix: 'passage: ', truncateTokens: 512 }
  });
  assert.equal(provider.calls[0].truncateTokens, 512, 'pencere kuralı ön işlemeyle birlikte gider');
  assert.equal(Object.isFrozen(query.route), true);
  assert.deepEqual(Object.keys(query.embeddings[0]), ['index', 'vector']);
  await embedDocuments(gateway);
  assert.deepEqual(provider.calls[1].input, ['passage: Belge A', 'passage: Belge B']);
  const scored = await rerank(gateway);
  assert.deepEqual({ query: provider.calls[2].query, documents: provider.calls[2].documents, model: provider.calls[2].model },
    { query: 'Soru', documents: ['Belge A', 'Belge B'], model: RERANK.model });
  assert.equal(scored.route.model, RERANK.model);
  assert.deepEqual(scored.scores.map((entry) => entry.index), [0, 1]);
  idle(admission);
  // Ön işlemesiz kayıtta önek eklenmez.
  const plain = gatewayFor(t, { registry: registryWith({ models: (model) => ({ ...model, preprocessing: undefined }) }) });
  await embedQuery(plain.gateway);
  assert.deepEqual(plain.provider.calls[0].input, ['Gecikmiş işlerim']);
  assert.equal(plain.provider.calls[0].truncateTokens, null);
  // Telemetri profili ve işlemi içeriksiz sayar.
  const snapshot = aiTelemetrySnapshot();
  assert.equal(snapshot.byProfile.embedding, 1);
  const operations = new Set(snapshotOperations().map((row) => row.operation));
  assert.ok(operations.has('ai.provider.embeddings') && operations.has('ai.request'));
});

test('geçersiz girdi sağlayıcıya ve kapasiteye ulaşmadan AI_REQUEST_INVALID olur', async (t) => {
  const { gateway, admission, provider } = gatewayFor(t);
  const sparse = ['a', , 'b']; // eslint-disable-line no-sparse-arrays
  const cases = [
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [], purpose: 'query' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: 'metin', purpose: 'query' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [''], purpose: 'query' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [7], purpose: 'query' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: sparse, purpose: 'document' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['ş'.repeat(4001)], purpose: 'document' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: Array.from({ length: 257 }, () => 'x'), purpose: 'document' }),
    () => gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['x'], purpose: 'passage' }),
    () => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: '', documents: ['x'] }),
    () => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: 'ş'.repeat(2001), documents: ['x'] }),
    () => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: 'q', documents: [] }),
    () => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: 'q', documents: Array.from({ length: 21 }, () => 'x') }),
    () => gateway.rerankTexts({ profile: AI_PROFILES.RERANK, query: 'q', documents: [null] })
  ];
  for (const [index, call] of cases.entries()) {
    await assert.rejects(call(), (error) => error.code === 'AI_REQUEST_INVALID' && /INPUT_INVALID$/.test(error.details.reason), String(index));
  }
  assert.equal(provider.calls.length, 0);
  assert.equal(admission.status().counters.admitted, 0);
});

test('profil ve yetenek kayıttan çözülür: yanlış yetenek, kapalı ya da tanımsız profil sağlayıcıya ulaşmaz', async (t) => {
  const { gateway, provider } = gatewayFor(t, { registry: registryWith({ profiles: { rerank: { model: RERANK.model, enabled: false } } }) });
  await assert.rejects(gateway.embedTexts({ profile: AI_PROFILES.CHAT_FAST, texts: ['x'], purpose: 'query' }),
    (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'CAPABILITY_MISMATCH');
  await assert.rejects(gateway.rerankTexts({ profile: AI_PROFILES.EMBEDDING, query: 'q', documents: ['x'] }),
    (error) => error.details.reason === 'CAPABILITY_MISMATCH');
  await assert.rejects(rerank(gateway), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'PROFILE_DISABLED');
  const { profiles, ...rest } = DEFAULT_AI_MODEL_REGISTRY;
  const { embedding, ...withoutEmbedding } = profiles; // eslint-disable-line no-unused-vars
  const missing = gatewayFor(t, { registry: validateModelRegistry({ ...rest, profiles: withoutEmbedding }).registry });
  await assert.rejects(embedQuery(missing.gateway), (error) => error.details.reason === 'PROFILE_NOT_CONFIGURED');
  assert.equal(provider.calls.length + missing.provider.calls.length, 0);
});

test('başka modelin yanıtı bu uzaya ait değildir: bildirilen model farklıysa yanıt reddedilir, bildirilmezse kabul edilir', async (t) => {
  const { gateway, admission, provider } = gatewayFor(t);
  provider.enqueue({ type: 'reply', model: 'baska-gomme-modeli' }, { type: 'reply', model: null }, { type: 'reply', model: 'baska-siralayici' });
  await assert.rejects(embedQuery(gateway), (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'MODEL_MISMATCH');
  assert.equal((await embedQuery(gateway)).embeddings.length, 1);
  await assert.rejects(rerank(gateway), (error) => error.details.reason === 'MODEL_MISMATCH');
  // Sağlayıcı çağrısı da başarısız ölçülür; uyuşmazlık yinelenmez.
  assert.equal(provider.calls.length, 3);
  assert.equal(aiTelemetrySnapshot().provider.lastFailureCode, 'AI_PROVIDER_RESPONSE_INVALID');
  idle(admission);
});

test('kayıtta bildirilen uç adı kabul edilir; başka bir modelin adı yine MODEL_MISMATCH olur', async (t) => {
  const aliased = registryWith({ models: (model) => (model.id === EMBEDDING.model ? { ...model, reportedModels: ['e5-large'] }
    : model.id === RERANK.model ? { ...model, reportedModels: ['reranker'] } : model) });
  const { gateway, provider, admission } = gatewayFor(t, { registry: aliased });
  provider.enqueue({ type: 'reply', model: 'e5-large' }, { type: 'reply', model: 'reranker' },
    { type: 'reply', model: 'reranker' }, { type: 'reply', model: 'Qwen3-Embedding-8B' }, { type: 'reply', model: 'e5-large-v2' });
  const embedded = await embedQuery(gateway);
  // Köken yapılandırılan modeldir: takma ad uzayı değiştirmez.
  assert.equal(embedded.route.model, EMBEDDING.model);
  assert.equal((await rerank(gateway)).scores.length, 2);
  // Takma ad yalnızca kendi modelini adlandırır: gömme rotasında yeniden sıralayıcının adı da gerçekten farklı bir modeldir.
  for (const label of ['başka modelin takma adı', 'kayıttaki başka model', 'benzer ama farklı ad']) {
    await assert.rejects(embedQuery(gateway), (error) => error.details.reason === 'MODEL_MISMATCH', label);
  }
  idle(admission);
});

test('katalog belgesi sunucuya aittir: kurumsal anahtar ve sunucu kapasite anahtarıyla gider; kullanıcının anahtarı ve payı onu belirlemez', async (t) => {
  const { provider, config } = gatewayFor(t, { env: { MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0' } });
  assert.equal(config.limits.maxActivePerUser, 1);
  const users = [];
  const gateway = createAiGateway({
    getProvider: () => provider,
    getAdmission: (() => {
      const { createAiAdmissionController } = admissionModule;
      const admission = createAiAdmissionController({ limits: config.limits });
      const wrapped = { acquire: (options) => { users.push(options.userKey); return admission.acquire(options); }, status: () => admission.status() };
      return () => wrapped;
    })(),
    loadConfig: () => config,
    loadRegistry: async () => REGISTRY,
    // Kullanıcının kişisel anahtarı: sorgusu bununla gider.
    resolveCredential: async () => ({ source: 'personal', apiKey: PERSONAL_KEY_A }),
    currentSicil: async () => 900001,
    verifySicil: async () => {}
  });
  provider.enqueue({ type: 'deferred' });
  const building = embedDocuments(gateway);
  await provider.waitForActive(1);
  // Kurulum sürerken aynı kullanıcının (etkin payı 1) sorgusu kurulum yüzünden AI_BUSY almaz.
  await embedQuery(gateway);
  provider.calls[0].resolve();
  await building;
  assert.deepEqual(provider.calls.map((call) => [call.input.length, call.apiKey]), [[2, DEFAULT_KEY], [1, PERSONAL_KEY_A]]);
  assert.equal(users[0], '\u0000server');
  assert.equal(String(users[1]), '900001');
  // Kurumsal anahtar yoksa sunucu işi kişisel anahtara geçmez: yapılandırma hatasıdır ve sağlayıcıya ulaşmaz.
  const personalOnly = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admissionModule.createAiAdmissionController({ limits: config.limits }),
    loadConfig: () => ({ ...config, defaultApiKey: null, defaultKeyConfigured: false }),
    loadRegistry: async () => REGISTRY,
    resolveCredential: async () => ({ source: 'personal', apiKey: PERSONAL_KEY_A }),
    currentSicil: async () => 900001,
    verifySicil: async () => {}
  });
  const before = provider.calls.length;
  await assert.rejects(embedDocuments(personalOnly), (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'DEFAULT_KEY_REQUIRED');
  assert.equal((await embedQuery(personalOnly)).embeddings.length, 1, 'kullanıcı sorgusu kendi anahtarıyla sürer');
  assert.equal(provider.calls.length - before, 1);
});

test('belirteç penceresi kayıttan açık kuraldır: kesme yoksa uç aşan girdiyi reddeder, varsa önek dâhil ilk N belirteç gömülür', async (t) => {
  const embedded = [];
  const server = await startFakeOpenAiCompatibleServer({ semantic: { embed: (text) => { embedded.push(text); return [1, 0, 0]; } } });
  t.after(() => server.close());
  // İkizin penceresi 8 belirteçtir (6 sözcük + 2 özel belirteç).
  server.setScenario({ embeddingWindow: 8 });
  const env = { MERGEN_ROTA_AI_BASE_URL: server.baseUrl };
  const withTruncation = (truncateTokens) => registryWith({ models: (model) => (model.id === EMBEDDING.model
    ? { ...model, contextTokens: 8, preprocessing: { id: 'e5-query-passage', queryPrefix: 'query: ', documentPrefix: 'passage: ', ...(truncateTokens ? { truncateTokens } : {}) } } : model) });
  const fits = 'bir iki üç dört beş'; // önekle 6 sözcük: tam pencere
  const over = 'bir iki üç dört beş altı yedi';
  const strict = gatewayFor(t, { provider: createOpenAiCompatibleProvider(), env, registry: withTruncation(null) });
  await strict.gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [fits], purpose: 'query' });
  const strictBody = server.state.requests.at(-1).body;
  assert.equal(Object.hasOwn(strictBody, 'truncate_prompt_tokens') || Object.hasOwn(strictBody, 'truncation_side'), false);
  assert.deepEqual(embedded.at(-1), `query: ${fits}`);
  // Kesme bildirilmemişse pencereyi aşan sorgu kullanıcı isteği hatasıdır; katalog belgesi yapılandırma hatasıdır.
  await assert.rejects(strict.gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [over], purpose: 'query' }),
    (error) => error.code === 'AI_REQUEST_INVALID' && error.details.providerStatus === 400);
  await assert.rejects(strict.gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [fits, over], purpose: 'document' }),
    (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'PROVIDER_REJECTED_FIXED_REQUEST');
  idle(strict.admission);

  const truncating = gatewayFor(t, { provider: createOpenAiCompatibleProvider(), env, registry: withTruncation(8) });
  const result = await truncating.gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [fits, over], purpose: 'document' });
  assert.equal(result.embeddings.length, 2);
  const body = server.state.requests.at(-1).body;
  assert.deepEqual({ truncate: body.truncate_prompt_tokens, side: body.truncation_side, input: body.input },
    { truncate: 8, side: 'right', input: [`passage: ${fits}`, `passage: ${over}`] });
  // Sağdan kesme öneki korur: ikiz önekli ilk altı sözcüğü gömdü.
  assert.deepEqual(embedded.slice(-2), [`passage: ${fits}`, 'passage: bir iki üç dört beş']);
  assert.equal(result.route.preprocessing.truncateTokens, 8);
  // Sözleşmenin karakter sınırındaki girdi ağ geçidinden geçer; pencere kuralı uçta uygulanır.
  server.setScenario({});
  const longest = 'ş'.repeat(SEMANTIC_LIMITS.maxItemTextChars);
  await truncating.gateway.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: [longest], purpose: 'document' });
  assert.deepEqual(server.state.requests.at(-1).body.input, [`passage: ${longest}`]);
  idle(truncating.admission);
});

test('gömme yanıt bütçesi sözleşmenin en büyük isteğiyle sınırlıdır: en kötü biçimli geçerli yanıt kabul edilir, bütçeyi aşan bozuk yanıt ayrıştırılmaz', async (t) => {
  // Bütçe girdi sayısıyla ölçeklenir ama sözleşmenin en büyük kataloğunu aşmaz.
  assert.equal(embeddingResponseBudget(1), 1024 * 1024 + SEMANTIC_LIMITS.maxDimensions * 32);
  assert.equal(embeddingResponseBudget(10000), embeddingResponseBudget(SEMANTIC_LIMITS.maxCatalogueItems));
  assert.equal(embeddingResponseBudget(SEMANTIC_LIMITS.maxCatalogueItems), 1024 * 1024 + 256 * 8192 * 32);
  const server = await startFakeOpenAiCompatibleServer();
  t.after(() => server.close());
  const provider = createOpenAiCompatibleProvider();
  const { signal } = new AbortController();
  // En uzun kayan nokta yazımı (24 karakter) ve geniş ayraçla en büyük boyutta vektörler: geçerli yanıt bütçeye sığar.
  const worst = '-1.2345678901234567e-308';
  const inputs = ['a', 'b', 'c'];
  server.setScenario({ semanticPayload: (body) => JSON.parse(JSON.stringify({ model: body.model, data: body.input.map((_, index) => ({
    object: 'embedding', index, embedding: Array.from({ length: SEMANTIC_LIMITS.maxDimensions }, () => Number(worst))
  })) })) });
  const valid = await provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', input: inputs, signal });
  assert.equal(valid.embeddings.length, 3);
  assert.equal(valid.embeddings[2].vector.length, SEMANTIC_LIMITS.maxDimensions);
  // Bütçeyi aşan bozuk yanıt okunurken kesilir; JSON ayrıştırılmaz.
  server.setScenario({ oversizedBytes: embeddingResponseBudget(inputs.length) });
  await assert.rejects(provider.embeddings({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', input: inputs, signal }),
    (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'RESPONSE_TOO_LARGE');
});

test('sunucuya ait katalog belgesinin reddi yapılandırma hatasıdır; kullanıcı sorgusunun reddi istek hatasıdır', async (t) => {
  const { gateway, provider } = gatewayFor(t);
  provider.enqueue({ type: 'status', status: 400 }, { type: 'status', status: 422 }, { type: 'status', status: 413 });
  await assert.rejects(embedDocuments(gateway),
    (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'PROVIDER_REJECTED_FIXED_REQUEST' && error.details.providerStatus === 400);
  await assert.rejects(embedQuery(gateway), { code: 'AI_REQUEST_INVALID' });
  await assert.rejects(rerank(gateway), { code: 'AI_REQUEST_INVALID' });
});

test('yalnızca sağlayıcıya ulaşmamış bağlantı hatası bir kez yinelenir; 5xx, belirsiz ağ hatası ve bozuk yanıt yinelenmez', async (t) => {
  const { gateway, provider, admission } = gatewayFor(t);
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' });
  assert.equal((await embedQuery(gateway)).embeddings.length, 1);
  assert.equal(provider.calls.length, 2);
  assert.equal(aiTelemetrySnapshot().retries, 1);
  for (const behavior of [{ type: 'network', code: 'ECONNRESET' }, { type: 'status', status: 503 }, { type: 'malformed' }]) {
    const before = provider.calls.length;
    provider.enqueue(behavior);
    await assert.rejects(rerank(gateway));
    assert.equal(provider.calls.length - before, 1, JSON.stringify(behavior));
  }
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'network', code: 'ECONNREFUSED' });
  await assert.rejects(embedDocuments(gateway), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(aiTelemetrySnapshot().retries, 2, 'ikinci bağlantı hatasından sonra üçüncü deneme yoktur');
  idle(admission);
});

test('modelin eşzamanlılık sınırı gömme çağrılarına da uygulanır; sıradaki çağrı iptal edilince sağlayıcıya ulaşmaz', async (t) => {
  const limited = registryWith({ models: (model) => (model.id === EMBEDDING.model ? { ...model, maxConcurrency: 1 } : model) });
  const { gateway, provider, admission } = gatewayFor(t, { registry: limited });
  provider.enqueue({ type: 'deferred' });
  const first = embedDocuments(gateway);
  await provider.waitForActive(1);
  const second = embedQuery(gateway);
  const controller = new AbortController();
  const third = embedQuery(gateway, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ active: admission.status().active, queued: admission.status().queued }, { active: 1, queued: 2 });
  controller.abort();
  await assert.rejects(third, { code: 'AI_CANCELLED' });
  assert.equal(admission.status().queued, 1);
  provider.calls[0].resolve();
  await first;
  await second;
  assert.equal(provider.peakActive, 1);
  assert.equal(provider.calls.length, 2, 'iptal edilen sıradaki çağrı sağlayıcıya ulaşmadı');
  // Başka modelin (yeniden sıralayıcı) çağrısı bu sınırı paylaşmaz.
  assert.equal((await rerank(gateway)).scores.length, 2);
  idle(admission);
});

test('süre aşımı ve iptal sağlayıcı çağrısını keser, kirayı bırakır; geç gelen yanıt uygulanmaz', async (t) => {
  const { gateway, provider, admission } = gatewayFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  provider.enqueue({ type: 'stall' });
  const timed = embedQuery(gateway);
  await provider.waitForActive(1);
  t.mock.timers.tick(90000);
  await assert.rejects(timed, (error) => error.code === 'AI_TIMEOUT' && error.details.timeoutMs === 90000);
  assert.equal(provider.calls[0].aborted, true);
  idle(admission);

  provider.enqueue({ type: 'deferred', ignoreAbort: true });
  const controller = new AbortController();
  const cancelled = rerank(gateway, { signal: controller.signal });
  await provider.waitForActive(1);
  controller.abort();
  await assert.rejects(cancelled, { code: 'AI_CANCELLED' });
  idle(admission);
  // Sinyale uymayan sağlayıcının geç yanıtı iptal edilmiş çağrıyı değiştirmez.
  provider.calls[1].resolve();
  await assert.rejects(cancelled, { code: 'AI_CANCELLED' });

  await assert.rejects(embedQuery(gateway, { signal: AbortSignal.abort() }), { code: 'AI_CANCELLED' });
  assert.equal(provider.calls.length, 2, 'başlamadan iptal edilen çağrı sağlayıcıya ulaşmaz');
  assert.equal(aiTelemetrySnapshot().outcomes.AI_TIMEOUT, 1);
});

test('kapasite dolu, anahtar eksik ya da sağlayıcı reddederken kira her yolda bırakılır; hizmet hatası günlüğe içeriksiz yazılır', async (t) => {
  const logs = captureConsole(t);
  const { gateway, provider, admission } = gatewayFor(t, { env: { MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '1', MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS: '0', MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0' } });
  provider.enqueue({ type: 'deferred' });
  const holder = embedDocuments(gateway);
  await provider.waitForActive(1);
  await assert.rejects(embedQuery(gateway), { code: 'AI_BUSY' });
  provider.calls[0].resolve();
  await holder;
  provider.enqueue({ type: 'status', status: 500 });
  await assert.rejects(embedQuery(gateway), { code: 'AI_PROVIDER_UNAVAILABLE' });
  idle(admission);
  const keyless = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admission,
    loadConfig: () => parseAiConfig({ MERGEN_ROTA_AI_ENABLED: 'true', MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1', MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY }),
    loadRegistry: async () => REGISTRY,
    resolveCredential: async () => { throw Object.assign(new Error('anahtar yok'), { code: 'AI_KEY_MISSING' }); },
    currentSicil: async () => 900001,
    verifySicil: async () => {}
  });
  await assert.rejects(keyless.embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['Gecikmiş işlerim'], purpose: 'query' }));
  idle(admission);
  const text = logs.join('\n');
  assert.match(text, /AI_PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(text, /Gecikmiş işlerim|Belge A|query: |passage: /);
  assert.equal(text.includes(DEFAULT_KEY), false);
});

test('anlamsal çağrı açık bir SQL işlemi içinde başlatılamaz', async (t) => {
  const { provider } = createAiStack(t);
  await assert.rejects(
    withSqlTransaction(() => getAiGateway().embedTexts({ profile: AI_PROFILES.EMBEDDING, texts: ['x'], purpose: 'query' })),
    (error) => error.code === 'AI_INTERNAL_ERROR' && error.details.reason === 'SQL_TRANSACTION_ACTIVE'
  );
  await assert.rejects(
    withSqlTransaction(() => getAiGateway().rerankTexts({ profile: AI_PROFILES.RERANK, query: 'q', documents: ['x'] })),
    (error) => error.details.reason === 'SQL_TRANSACTION_ACTIVE'
  );
  assert.equal(provider.calls.length, 0);
});
