/**
 * Rota AI · HTTP uçları ve akış protokolü sözleşmesi.
 *
 * Kimlik, aynı kaynak koruması (ters vekil başlıkları dâhil), girdi
 * doğrulaması, kip → profil eşlemesi, akış başlıkları, olay sırası ve
 * biçimi, sonlandırıcı hata, istemci iptali, canlı tutma ve hiçbir yanıtta
 * anahtar, adres, model adı, sistem yönergesi ya da akıl yürütme metni
 * bulunmaması sınanır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_KEY,
  MASTER_KEY,
  PERSONAL_KEY_A,
  aiRequest,
  assistantReadiness,
  captureConsole,
  conversationRoute,
  createAiStack,
  deleteAssistantConversation,
  listAssistantConversations,
  loadAssistantConversation,
  parseSseText,
  readJson,
  saveKey,
  sendTurn,
  turnRequest,
  turnsRoute
} from './helpers/aiStack.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { resolveModelProfile, validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { aiRuntimeLoad } = await import('../src/server/ai/aiRuntime.js');
const { activeAssistantGenerationCountForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');
const { assistantStreamResponse, assistantStreamErrorPayload } = await import('../src/server/ai/assistant/assistantStreamResponse.js');
const { ASSISTANT_PROTOCOL_HEADER, ASSISTANT_PROTOCOL_VERSION } = await import('../src/domain/ai/assistantContract.js');

const REGISTRY = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry;
const MODEL_NAMES = [...REGISTRY.models.keys()];
const CROSS_SITE = [
  { origin: 'https://kardes.example.internal' },
  { 'sec-fetch-site': 'same-site' },
  { 'sec-fetch-site': 'cross-site', origin: 'https://baska.example' }
];

function assertNoLeak(text, extra = []) {
  for (const secret of [DEFAULT_KEY, PERSONAL_KEY_A, MASTER_KEY, '127.0.0.1:9', 'Authorization', 'Bearer', 'ÖNEMLİ SINIR', ...MODEL_NAMES, ...extra]) {
    assert.equal(text.includes(secret), false, `yanıt sızdırmamalı: ${secret}`);
  }
}

async function tempRegistry(t, document) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-ai-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai-models.json');
  await writeFile(file, JSON.stringify(document), 'utf8');
  return file;
}

async function until(predicate, rounds = 400) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

function rawTurn(body, headers = {}) {
  return turnsRoute.POST(new Request('http://localhost/api/mergen-rota/ai/assistant/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })).then(readJson);
}

/* ── Kimlik ve aynı kaynak ────────────────────────────────── */

test('oturumu olmayan çağıran hiçbir Rota AI ucuna erişemez; yapay zekâ kapalıyken de yanıt aynıdır', async (t) => {
  const { db, provider, setEnv } = createAiStack(t, { env: { MERGEN_ROTA_DEV_SICIL: null } });
  const conversationId = randomUUID();
  const calls = () => [
    assistantReadiness(),
    listAssistantConversations(),
    loadAssistantConversation(conversationId),
    deleteAssistantConversation(conversationId),
    sendTurn({ turnId: randomUUID(), message: 'Merhaba' })
  ];
  for (const response of await Promise.all(calls())) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assertNoLeak(response.text);
  }
  setEnv({ MERGEN_ROTA_AI_ENABLED: 'false' });
  for (const response of await Promise.all(calls())) assert.equal(response.status, 401);
  assert.equal(provider.calls.length, 0);
  assert.equal(db.aiConversations.length, 0);
});

test('tur ve silme yalnızca aynı kaynaktan kabul edilir; ters vekilin iletilen başlıklarıyla aynı kaynak geçerlidir', async (t) => {
  const { db, provider } = createAiStack(t);
  const { body } = await sendTurn({ turnId: randomUUID(), message: 'Kalıcı konuşma' }).then((result) => ({ body: result }));
  const conversationId = body.events[0].data.conversation.id;
  for (const headers of CROSS_SITE) {
    const turn = await sendTurn({ turnId: randomUUID(), message: 'Başka siteden' }, { headers });
    const removed = await deleteAssistantConversation(conversationId, { headers });
    for (const response of [turn, removed]) {
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }
  }
  assert.equal(provider.calls.length, 1);
  assert.equal(db.aiConversations.length, 1);

  // /bilge gibi ön ekli yayında Nginx özgün ana makineyi ve şemayı iletir; koruma gevşetilmeden aynı kaynak tanınır.
  const proxied = {
    origin: 'https://rota.example.internal',
    'sec-fetch-site': 'same-origin',
    'x-forwarded-host': 'rota.example.internal',
    'x-forwarded-proto': 'https'
  };
  const accepted = await sendTurn({ turnId: randomUUID(), message: 'Vekil arkasından' }, { headers: proxied });
  assert.equal(accepted.status, 200);
  const wrongProto = await sendTurn({ turnId: randomUUID(), message: 'Şema uyuşmuyor' }, { headers: { ...proxied, 'x-forwarded-proto': 'http' } });
  assert.equal(wrongProto.status, 403);
  const wrongHost = await sendTurn({ turnId: randomUUID(), message: 'Ana makine uyuşmuyor' }, { headers: { ...proxied, 'x-forwarded-host': 'baska.example.internal' } });
  assert.equal(wrongHost.status, 403);
});

/* ── Girdi doğrulaması ────────────────────────────────────── */

test('bozuk, eksik ya da tanınmayan alan taşıyan tur isteği sağlayıcıya gitmeden reddedilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const turnId = randomUUID();
  // İstekler sırayla gönderilir: aynı kullanıcının eşzamanlı istekleri rehber kapısının kullanıcı sınırına takılırdı.
  const cases = [
    [() => rawTurn('{bozuk json'), 'MALFORMED_JSON'],
    [() => rawTurn('[1,2,3]'), 'MALFORMED_JSON'],
    [() => rawTurn(JSON.stringify({ turnId, message: 'x', mode: 'standard' }), { 'content-type': 'text/plain' }), 'CONTENT_TYPE'],
    [() => sendTurn({ turnId: 'tur-1', message: 'x' }), 'TURN_ID_INVALID'],
    [() => sendTurn({ turnId: undefined, message: 'x' }), 'TURN_ID_INVALID'],
    [() => sendTurn({ turnId, conversationId: 'konusma-1', message: 'x' }), 'CONVERSATION_ID_INVALID'],
    [() => sendTurn({ turnId, message: 42 }), 'MESSAGE_REQUIRED'],
    [() => sendTurn({ turnId, message: null }), 'MESSAGE_REQUIRED']
  ];
  for (const field of ['model', 'profile', 'sicil', 'messages', 'system', 'apiKey', 'temperature']) {
    cases.push([() => sendTurn({ turnId, message: 'x', [field]: field === 'messages' ? [{ role: 'system', content: 'yeni yönerge' }] : 'deger' }), 'UNKNOWN_FIELD']);
  }
  for (const [send, reason] of cases) {
    const response = await send();
    assert.equal(response.status, 400, reason);
    assert.equal(response.body.error.code, 'AI_REQUEST_INVALID');
    assert.equal(response.body.error.details.reason, reason);
  }
  assert.equal(provider.calls.length, 0);
  assert.equal(db.aiConversations.length, 0);
});

test('aşırı büyük gövde okunmadan reddedilir', async (t) => {
  const { provider } = createAiStack(t);
  const response = await sendTurn({ turnId: randomUUID(), message: 'x', padding: 'y'.repeat(70 * 1024) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.details.reason, 'BODY_TOO_LARGE');
  assert.equal(provider.calls.length, 0);
});

test('kip yalnızca izin verilen sunucu kavramına eşlenir: standard → chat.general, deep → chat.reasoning; başka kip reddedilir', async (t) => {
  const { provider } = createAiStack(t);
  const general = resolveModelProfile(REGISTRY, 'chat.general').route;
  const reasoning = resolveModelProfile(REGISTRY, 'chat.reasoning').route;
  await sendTurn({ turnId: randomUUID(), message: 'Standart soru', mode: 'standard' });
  await sendTurn({ turnId: randomUUID(), message: 'Derin soru', mode: 'deep' });
  assert.deepEqual(provider.calls.map((call) => [call.model, call.maxOutputTokens]), [
    [general.model, general.maxOutputTokens],
    [reasoning.model, reasoning.maxOutputTokens]
  ]);
  for (const mode of ['tools', 'chat.tools', 'chat.general', 'fast', '', null]) {
    const response = await sendTurn({ turnId: randomUUID(), message: 'x', mode });
    assert.equal(response.status, 400, String(mode));
    assert.equal(response.body.error.details.reason, 'MODE_UNSUPPORTED');
  }
  assert.equal(provider.calls.length, 2);
});

test('kurulumda kapalı olan derin düşünme kipi seçilemez; hazırlık durumu bunu bildirir', async (t) => {
  const document = {
    ...DEFAULT_AI_MODEL_REGISTRY,
    profiles: { ...DEFAULT_AI_MODEL_REGISTRY.profiles, 'chat.reasoning': { ...DEFAULT_AI_MODEL_REGISTRY.profiles['chat.reasoning'], enabled: false } }
  };
  const file = await tempRegistry(t, document);
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  const readiness = await assistantReadiness();
  assert.equal(readiness.body.assistant.available, true);
  assert.deepEqual(readiness.body.assistant.modes.map((mode) => [mode.id, mode.available]), [['standard', true], ['deep', false]]);
  const deep = await sendTurn({ turnId: randomUUID(), message: 'Derin', mode: 'deep' });
  assert.equal(deep.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(deep.body.error.details.reason, 'MODE_UNAVAILABLE');
  assert.equal(provider.calls.length, 0);
});

/* ── Hazırlık durumu ─────────────────────────────────────── */

test('hazırlık durumu kullanılabilirliği ve kipleri bildirir; yapılandırma değeri, adres, anahtar ya da model adı taşımaz', async (t) => {
  const { setEnv } = createAiStack(t);
  const ready = await assistantReadiness();
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.deepEqual(ready.body.assistant, {
    available: true,
    reason: null,
    credentialSource: 'default',
    modes: [{ id: 'standard', label: 'Standart', available: true }, { id: 'deep', label: 'Derin düşünme', available: true }],
    limits: { maxMessageChars: 8000, maxConversationMessages: 100 }
  });
  assertNoLeak(ready.text);
  await saveKey(PERSONAL_KEY_A);
  assert.equal((await assistantReadiness()).body.assistant.credentialSource, 'personal');

  setEnv({ MERGEN_ROTA_AI_DEFAULT_API_KEY: null });
  const { removeKey } = await import('./helpers/aiStack.mjs');
  await removeKey();
  const missing = await assistantReadiness();
  assert.deepEqual([missing.body.assistant.available, missing.body.assistant.reason], [false, 'AI_KEY_MISSING']);
  setEnv({ MERGEN_ROTA_AI_ENABLED: 'false' });
  const disabled = await assistantReadiness();
  assert.deepEqual([disabled.body.assistant.available, disabled.body.assistant.reason], [false, 'AI_DISABLED']);
  assertNoLeak(disabled.text);
});

/* ── Akış protokolü ───────────────────────────────────────── */

test('akış başlıkları önbelleğe alınmayı ve ara bellekte bekletilmeyi engeller; protokol sürümü bildirilir', async (t) => {
  createAiStack(t);
  const result = await sendTurn({ turnId: randomUUID(), message: 'Başlıklar' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.match(result.headers.get('cache-control'), /no-cache/);
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.match(result.headers.get('cache-control'), /no-transform/);
  assert.equal(result.headers.get('x-accel-buffering'), 'no');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get(ASSISTANT_PROTOCOL_HEADER), String(ASSISTANT_PROTOCOL_VERSION));
});

test('olay sırası ve biçimi: accepted → status → delta… → done; sonlandırıcı tektir ve yanıt metni done içinde yinelenmez', async (t) => {
  const { provider } = createAiStack(t);
  provider.enqueue({ type: 'stream', chunks: ['Bir', 'iki', 'üç'] });
  const turnId = randomUUID();
  const result = await sendTurn({ turnId, message: 'Olaylar' });
  assert.deepEqual(result.events.map((event) => event.event), ['accepted', 'status', 'delta', 'delta', 'delta', 'done']);
  const [acceptedEvent, status] = result.events;
  assert.deepEqual(Object.keys(acceptedEvent.data).sort(), ['context', 'conversation', 'mode', 'replay', 'userMessage', 'v']);
  assert.equal(acceptedEvent.data.v, ASSISTANT_PROTOCOL_VERSION);
  assert.equal(acceptedEvent.data.mode, 'standard');
  assert.equal(acceptedEvent.data.replay, false);
  assert.deepEqual(Object.keys(acceptedEvent.data.conversation).sort(), ['createdAt', 'id', 'messageCount', 'title', 'updatedAt']);
  assert.equal(acceptedEvent.data.userMessage.content, 'Olaylar');
  assert.equal(acceptedEvent.data.userMessage.turnId, turnId);
  assert.deepEqual(status.data, { phase: 'generating' });
  assert.deepEqual(result.events.filter((event) => event.event === 'delta').map((event) => event.data), [{ text: 'Bir' }, { text: 'iki' }, { text: 'üç' }]);
  const done = result.events.at(-1).data;
  assert.equal(done.replayed, false);
  assert.equal('content' in done.assistantMessage, false);
  assert.equal(done.assistantMessage.length, 'Birikiüç'.length);
  assert.equal(done.assistantMessage.role, 'assistant');
  assert.equal(done.conversation.messageCount, 2);
});

test('derin düşünme evresi bildirilir ama akıl yürütme metni hiçbir olaya girmez', async (t) => {
  const { provider } = createAiStack(t);
  provider.enqueue({ type: 'stream', reasoning: 2, chunks: ['Sonuç'] });
  const result = await sendTurn({ turnId: randomUUID(), message: 'Derin soru', mode: 'deep' });
  assert.deepEqual(result.events.filter((event) => event.event === 'status').map((event) => event.data.phase), ['generating', 'thinking']);
  assert.equal(result.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''), 'Sonuç');
});

test('akış ortasında kesilen yanıt tek bir sonlandırıcı hata olayıyla biter ve kısmi olduğu bildirilir; yanıt yazılmaz', async (t) => {
  const { db, provider } = createAiStack(t);
  provider.enqueue({ type: 'interrupt', chunks: ['yarım '] });
  const result = await sendTurn({ turnId: randomUUID(), message: 'Kesilecek' });
  assert.deepEqual(result.events.map((event) => event.event), ['accepted', 'status', 'delta', 'error']);
  assert.deepEqual(result.events.at(-1).data, {
    code: 'AI_PROVIDER_UNAVAILABLE',
    message: 'Yapay zekâ yanıtı tamamlanmadan bağlantı kesildi.',
    reason: 'STREAM_INTERRUPTED',
    retryable: true,
    retryAfterMs: null,
    // Anahtar kaynağı yalnızca anahtarla ilgili hatalarda taşınır (Phase 1 sözleşmesi).
    credentialSource: null,
    partial: true
  });
  assert.deepEqual(db.aiConversationMessages.map((row) => row.Role), ['user']);
});

test('başlamadan başarısız olan üretim hata olayıyla biter: oran sınırı bekleme süresini, reddedilen kişisel anahtar kaynağını taşır', async (t) => {
  const { provider } = createAiStack(t);
  provider.enqueue({ type: 'status', status: 429, retryAfter: '12' });
  const limited = await sendTurn({ turnId: randomUUID(), message: 'Sınır' });
  const limitedError = limited.events.at(-1);
  assert.equal(limitedError.event, 'error');
  assert.equal(limitedError.data.code, 'AI_RATE_LIMITED');
  assert.equal(limitedError.data.retryAfterMs, 12000);
  assert.equal(limitedError.data.partial, false);

  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'status', status: 401 }, { type: 'stream' });
  const rejected = await sendTurn({ turnId: randomUUID(), message: 'Kişisel anahtar' });
  assert.equal(rejected.events.at(-1).data.code, 'AI_KEY_INVALID');
  assert.equal(rejected.events.at(-1).data.credentialSource, 'personal');
  // Birinci çağrı kurumsal anahtarla (oran sınırı), ikincisi kişisel anahtarla; kurumsal anahtara geri düşen üçüncü çağrı yoktur.
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY, PERSONAL_KEY_A]);
});

test('istemci bağlantıyı kesince üretim sağlayıcıya kadar iptal edilir, kapasite ve üretim hakkı bırakılır, yanıt yazılmaz', async (t) => {
  const { db, provider } = createAiStack(t);
  provider.enqueue({ type: 'deferred-stream' });
  const controller = new AbortController();
  const response = await turnsRoute.POST(turnRequest({ turnId: randomUUID(), message: 'İptal', mode: 'standard', conversationId: null }, { signal: controller.signal }));
  const reader = response.body.getReader();
  await reader.read();
  await provider.waitForActive(1);
  provider.calls[0].emit('başladı');
  assert.equal(aiRuntimeLoad().active, 1);
  controller.abort();
  await reader.cancel();
  await until(() => aiRuntimeLoad().active === 0 && activeAssistantGenerationCountForTests() === 0);
  assert.equal(provider.calls[0].aborted, true);
  assert.deepEqual(db.aiConversationMessages.map((row) => row.Role), ['user']);
});

test('hiçbir akış olayı anahtar, sağlayıcı adresi, model adı, sistem yönergesi ya da akıl yürütme metni taşımaz', async (t) => {
  const { provider } = createAiStack(t);
  provider.enqueue({ type: 'stream', reasoning: 1, chunks: ['Güvenli yanıt'] }, { type: 'status', status: 401 });
  await saveKey(PERSONAL_KEY_A);
  const ok = await sendTurn({ turnId: randomUUID(), message: 'Güvenlik', mode: 'deep' });
  const failed = await sendTurn({ turnId: randomUUID(), message: 'Hata' });
  const list = await listAssistantConversations();
  const loaded = await loadAssistantConversation(ok.events[0].data.conversation.id);
  for (const text of [ok.text, failed.text, list.text, loaded.text]) assertNoLeak(text);
});

/* ── Akış yanıtının iç işleyişi ───────────────────────────── */

function fakeTurn(overrides = {}) {
  let released = 0;
  const claim = { signal: new AbortController().signal, release: () => { released += 1; } };
  return {
    turn: {
      claim,
      mode: 'standard',
      conversation: { id: randomUUID(), title: 'Deneme', createdAt: 'x', updatedAt: 'x', messageCount: 1 },
      userMessage: { id: randomUUID(), sequence: 1, role: 'user', content: 'Soru', turnId: randomUUID(), replyToId: null, mode: null, finishReason: null, createdAt: 'x' },
      replay: null,
      context: { trimmed: false, omittedMessages: 0 },
      ...overrides
    },
    released: () => released
  };
}

test('ilk metni bekleyen yavaş modelde bağlantı canlı tutulur; canlı tutma veri değil yorumdur ve akış bitince durur', async (t) => {
  // Canlı tutma zamanlayıcısı süreci ayakta tutmaz (unref); gerçek sunucuda HTTP soketi tutar, testte bu zamanlayıcı.
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));
  const { turn, released } = fakeTurn();
  let finish;
  const response = assistantStreamResponse(turn, {
    keepaliveMs: 5,
    generate: async (_turn, { onText }) => {
      await new Promise((resolve) => { finish = resolve; });
      await onText('Geç gelen yanıt');
      return { conversation: turn.conversation, answer: { id: randomUUID(), sequence: 2, role: 'assistant', content: 'Geç gelen yanıt', turnId: null, replyToId: turn.userMessage.id, mode: 'standard', finishReason: 'stop', createdAt: 'x' } };
    }
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while ((text.match(/: keepalive/g) || []).length < 2) text += decoder.decode((await reader.read()).value, { stream: true });
  finish();
  for (let step = await reader.read(); !step.done; step = await reader.read()) text += decoder.decode(step.value, { stream: true });
  const parsed = parseSseText(text);
  assert.ok(parsed.comments >= 2);
  assert.deepEqual(parsed.events.map((event) => event.event), ['accepted', 'delta', 'done']);
  assert.equal(released(), 1, 'üretim hakkı tam bir kez bırakılır');
  const settled = text.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(text.length, settled);
});

test('beklenmeyen iç hata genel iletiyle bildirilir; hata ayrıntısı akışa taşınmaz', async (t) => {
  const logs = captureConsole(t);
  const { turn, released } = fakeTurn();
  const response = assistantStreamResponse(turn, {
    generate: async () => { throw new Error('SELECT gizli FROM iç_tablo — beklenmeyen'); }
  });
  const parsed = parseSseText(await response.text());
  const error = parsed.events.at(-1);
  assert.equal(error.event, 'error');
  assert.equal(error.data.code, 'AI_INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(parsed.events), /SELECT|iç_tablo/);
  assert.equal(released(), 1);
  assert.ok(logs.some((line) => line.includes('ai.assistant.turn')), 'beklenmeyen hata işletim günlüğüne yazılır');
  assert.equal(assistantStreamErrorPayload(new Error('x')).retryable, false);
});

test('kayıtlı yanıtın yeniden oynatılması modele gitmez ve tek parça metin olarak gelir', async () => {
  const answer = { id: randomUUID(), sequence: 2, role: 'assistant', content: 'Kayıtlı yanıt', turnId: null, replyToId: randomUUID(), mode: 'standard', finishReason: 'stop', createdAt: 'x' };
  const { turn } = fakeTurn({ replay: answer });
  let generated = false;
  const response = assistantStreamResponse(turn, { generate: async () => { generated = true; } });
  const parsed = parseSseText(await response.text());
  assert.deepEqual(parsed.events.map((event) => event.event), ['accepted', 'delta', 'done']);
  assert.equal(parsed.events[0].data.replay, true);
  assert.deepEqual(parsed.events[1].data, { text: 'Kayıtlı yanıt' });
  assert.equal(parsed.events[2].data.replayed, true);
  assert.equal(generated, false);
});

test('okunmayan akış (yavaş istemci) sunucuda sınırsız biriktirilmez: kuyruk dolunca üretim beklemeye alınır', async () => {
  const { turn } = fakeTurn();
  let produced = 0;
  let resumed = null;
  const response = assistantStreamResponse(turn, {
    generate: async (_turn, { onText }) => {
      for (let index = 0; index < 200; index += 1) {
        await onText(`parça ${index} `);
        produced += 1;
      }
      resumed = produced;
      return { conversation: turn.conversation, answer: { id: randomUUID(), sequence: 2, role: 'assistant', content: 'x', turnId: null, replyToId: turn.userMessage.id, mode: 'standard', finishReason: 'stop', createdAt: 'x' } };
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(produced < 200, `okunmayan akışta üretim beklemeli (üretilen ${produced})`);
  const parsed = parseSseText(await response.text());
  assert.equal(resumed, 200);
  assert.equal(parsed.events.filter((event) => event.event === 'delta').length, 200);
  assert.equal(parsed.events.at(-1).event, 'done');
});

test('konuşma okuma ve silme uçları kimlik biçimini doğrular', async (t) => {
  createAiStack(t);
  for (const response of [
    await readJson(await conversationRoute.GET(aiRequest('/assistant/conversations/../../etc'), { params: { conversationId: '../../etc' } })),
    await deleteAssistantConversation('not-a-guid')
  ]) {
    assert.equal(response.status, 400);
    assert.equal(response.body.error.details.reason, 'CONVERSATION_ID_INVALID');
  }
});

test('0017 eksikken hazırlık açık görünmez ve model çağrılmaz', async (t) => {
  const { provider } = createAiStack(t, { seed: { aiConversationSchemaMissing: true } });
  const result = await assistantReadiness();
  assert.equal(result.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(result.body.error.details.reason, 'CONVERSATION_SCHEMA_MISSING');
  assert.equal(provider.calls.length, 0);
});

test('Standart kapalıyken kullanılabilir derin kip genel hazırlığı açar', async (t) => {
  const file = await tempRegistry(t, { ...DEFAULT_AI_MODEL_REGISTRY, profiles: {
    ...DEFAULT_AI_MODEL_REGISTRY.profiles,
    'chat.general': { ...DEFAULT_AI_MODEL_REGISTRY.profiles['chat.general'], enabled: false }
  } });
  createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  const result = await assistantReadiness();
  assert.equal(result.body.assistant.available, true);
  assert.deepEqual(result.body.assistant.modes.map((mode) => mode.available), [false, true]);
});
