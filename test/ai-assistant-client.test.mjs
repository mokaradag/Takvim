/**
 * Rota AI · tarayıcı istemcisi: akış protokolü çözücüsü ve istek sarmalayıcısı.
 *
 * Çözücü ağdan bağımsız sınanır (parça sınırları, birden çok olay, eksik son
 * parça, bilinmeyen olay, sonlandırıcılar, bozuk protokol, sınırlar). İstek
 * sarmalayıcısı sahte `fetch` ile sınanır: gövde yalnızca konuşma kimliği, tur
 * kimliği, ileti ve kip taşır; iptal, durgun bağlantı, ağ hatası, HTTP hatası
 * ve beklenmeyen yanıt kararlı sonuç biçimine çevrilir.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ASSISTANT_INVALID_RESPONSE,
  createAssistantStreamDecoder,
  deleteAssistantConversationRequest,
  listAssistantConversationsRequest,
  loadAssistantConversationRequest,
  loadAssistantReadinessRequest,
  streamAssistantTurnRequest
} = await import('../src/features/ai/assistant/assistantClient.js');

const CONVERSATION_ID = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const TURN_ID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9fa0b1c2d3';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ANSWER_ID = '99999999-8888-4777-8666-555555555555';
const encoder = new TextEncoder();

const conversation = { id: CONVERSATION_ID, title: 'Deneme', createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', messageCount: 1 };
const userMessage = { id: USER_ID, sequence: 1, role: 'user', content: 'Soru', turnId: TURN_ID, replyToId: null, mode: null, finishReason: null, createdAt: 'x', length: 4 };
const assistantMessage = { id: ANSWER_ID, sequence: 2, role: 'assistant', turnId: null, replyToId: USER_ID, mode: 'standard', finishReason: 'stop', createdAt: 'x', length: 7 };

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ACCEPTED = frame('accepted', { v: 1, conversation, userMessage, mode: 'standard', replay: false, context: { trimmed: false, omittedMessages: 0 } });
const DONE = frame('done', { conversation: { ...conversation, messageCount: 2 }, assistantMessage, replayed: false });

function types(events) {
  return events.map((event) => event.type);
}

/* ── Çözücü ───────────────────────────────────────────────── */

test('çözücü: olaylar parça sınırlarından bağımsız çözülür; bir parça birden çok olay taşıyabilir', () => {
  const raw = ACCEPTED + frame('status', { phase: 'generating' }) + frame('delta', { text: 'Merhaba ' }) + frame('delta', { text: 'dünya' }) + DONE;
  for (const size of [1, 2, 5, 17, raw.length]) {
    const decoder = createAssistantStreamDecoder();
    const events = [];
    for (let index = 0; index < raw.length; index += size) events.push(...decoder.push(raw.slice(index, index + size)));
    assert.deepEqual(types(events), ['accepted', 'status', 'delta', 'delta', 'done'], `parça boyu ${size}`);
    assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.data.text).join(''), 'Merhaba dünya');
    assert.equal(decoder.terminal.type, 'done');
  }
});

test('çözücü: tanınmayan olay ve tanınmayan evre yok sayılır; yorum satırı olay değildir', () => {
  const decoder = createAssistantStreamDecoder();
  const events = decoder.push(ACCEPTED + ': keepalive\n\n' + frame('gelecekteki-olay', { x: 1 }) + frame('status', { phase: 'yeni-evre' }) + frame('delta', { text: 'a' }));
  assert.deepEqual(types(events), ['accepted', 'delta']);
});

test('çözücü: sonlandırıcıdan sonra gelen her şey yok sayılır; hata olayı sonlandırıcıdır', () => {
  const decoder = createAssistantStreamDecoder();
  const events = decoder.push(ACCEPTED + frame('error', { code: 'AI_TIMEOUT', message: 'Süre doldu.', partial: false }) + frame('delta', { text: 'geç' }) + DONE);
  assert.deepEqual(types(events), ['accepted', 'error']);
  assert.equal(decoder.terminal.data.code, 'AI_TIMEOUT');
  // Akış başlamadan (accepted olmadan) gelen hata da geçerli sonlandırıcıdır.
  const early = createAssistantStreamDecoder();
  assert.deepEqual(types(early.push(frame('error', { code: 'AI_BUSY', message: 'Yoğun.' }))), ['error']);
});

test('çözücü: sonlandırıcı gelmeden biten akış yarıda kalmıştır; eksik son olay yayımlanmaz', () => {
  const decoder = createAssistantStreamDecoder();
  decoder.push(ACCEPTED + frame('delta', { text: 'yarım' }) + 'event: done\ndata: {"conversation"');
  assert.equal(decoder.end(), null);
});

test('çözücü: protokol ihlalleri AssistantProtocolError fırlatır', () => {
  const cases = [
    [frame('delta', { text: 'accepted olmadan' }), 'UNEXPECTED_EVENT'],
    [ACCEPTED + ACCEPTED, 'UNEXPECTED_EVENT'],
    [frame('accepted', { v: 2, conversation, userMessage }), 'PROTOCOL_VERSION'],
    ['event: accepted\ndata: {bozuk\n\n', 'MALFORMED_EVENT'],
    [frame('accepted', { v: 1, conversation: { id: 'kimlik-değil', title: 'x' }, userMessage }), 'MALFORMED_EVENT'],
    [ACCEPTED + frame('delta', { text: 42 }), 'MALFORMED_EVENT'],
    [ACCEPTED + frame('done', { conversation }), 'MALFORMED_EVENT'],
    [ACCEPTED + frame('error', { code: 7 }), 'MALFORMED_EVENT'],
    [ACCEPTED + frame('status', { phase: 3 }), 'MALFORMED_EVENT']
  ];
  for (const [raw, reason] of cases) {
    assert.throws(() => createAssistantStreamDecoder().push(raw), (error) => error.name === 'AssistantProtocolError' && error.reason === reason, reason);
  }
});

test('çözücü: yanıt metni ve tek olay büyüklüğü sınırlıdır', () => {
  const small = createAssistantStreamDecoder({ maxAnswerChars: 10 });
  small.push(ACCEPTED + frame('delta', { text: '12345' }));
  assert.throws(() => small.push(frame('delta', { text: '678901' })), (error) => error.reason === 'ANSWER_TOO_LARGE');
  const narrow = createAssistantStreamDecoder({ maxEventChars: 64 });
  assert.throws(() => narrow.push(`data: ${'x'.repeat(100)}`), (error) => error.reason === 'EVENT_TOO_LARGE');
});

/* ── Akış isteği ──────────────────────────────────────────── */

/** Parçaları sırayla (ya da test elle ilerletince) veren sahte akış yanıtı. */
function streamResponse(chunks, { status = 200, headers = { 'content-type': 'text/event-stream; charset=utf-8' }, manual = false } = {}) {
  const queue = [...chunks];
  let push = null;
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      push = (chunk) => (chunk == null ? controller.close() : controller.enqueue(encoder.encode(chunk)));
      if (!manual) {
        for (const chunk of queue) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    }
  });
  const response = new Response(body, { status, headers });
  return { response, push: (chunk) => push(chunk), get cancelled() { return cancelled; } };
}

function stubFetch(t, handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

test('tur isteği yalnızca konuşma kimliği, tur kimliği, ileti ve kip taşır; olaylar sırayla bildirilir', async (t) => {
  const calls = stubFetch(t, () => streamResponse([ACCEPTED, frame('status', { phase: 'generating' }), frame('delta', { text: 'Yanıt ' }), frame('delta', { text: 'metni' }), DONE]).response);
  const seen = [];
  const result = await streamAssistantTurnRequest({ conversationId: CONVERSATION_ID, turnId: TURN_ID, message: 'Soru', mode: 'deep', onEvent: (event) => seen.push(event.type) });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.done.assistantMessage.id, ANSWER_ID);
  assert.deepEqual(seen, ['accepted', 'status', 'delta', 'delta', 'done']);
  const [call] = calls;
  assert.match(call.url, /\/api\/mergen-rota\/ai\/assistant\/turns$/);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.accept, 'text/event-stream');
  assert.deepEqual(Object.keys(call.body).sort(), ['conversationId', 'message', 'mode', 'turnId']);
  assert.deepEqual(call.body, { conversationId: CONVERSATION_ID, turnId: TURN_ID, message: 'Soru', mode: 'deep' });
  assert.doesNotMatch(call.init.body, /model|profile|apiKey|sicil|authorization/i);
  assert.doesNotMatch(call.url, /\?/);
});

test('kullanıcı durdurunca istek kesilir ve sonuç iptal olarak döner; gelmiş metin kısmi sayılır', async (t) => {
  const stream = streamResponse([], { manual: true });
  stubFetch(t, (call) => {
    call.init.signal.addEventListener('abort', () => stream.push(null));
    return stream.response;
  });
  const controller = new AbortController();
  const pending = streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard', signal: controller.signal, onEvent: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  stream.push(ACCEPTED);
  stream.push(frame('delta', { text: 'kısmi' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const result = await pending;
  assert.deepEqual([result.ok, result.code, result.cancelled, result.partial], [false, 'REQUEST_CANCELLED', true, true]);
});

test('sunucudan uzun süre hiç bayt gelmezse bağlantı durgun sayılır', async (t) => {
  const stream = streamResponse([], { manual: true });
  stubFetch(t, (call) => {
    call.init.signal.addEventListener('abort', () => stream.push(null));
    return stream.response;
  });
  const pending = streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard', inactivityMs: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  stream.push(ACCEPTED);
  const result = await pending;
  assert.deepEqual([result.ok, result.code, result.retryable, result.cancelled], [false, 'STREAM_STALLED', true, false]);
});

test('ağ hatası, HTTP hatası, beklenmeyen içerik ve yarıda kalan akış kararlı sonuçlara çevrilir', async (t) => {
  const responses = [
    () => { throw new TypeError('fetch failed'); },
    () => Response.json({ error: { code: 'CONFLICT', message: 'Üretim sürüyor.', details: { reason: 'GENERATION_IN_PROGRESS' } } }, { status: 409 }),
    () => Response.json({ error: { code: 'AI_BUSY', message: 'Yoğun.', details: { retryable: true, retryAfterMs: 2000 } } }, { status: 503 }),
    () => new Response('<html>vekil hata sayfası</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => streamResponse([ACCEPTED, frame('delta', { text: 'yarım' })]).response,
    () => streamResponse([ACCEPTED, frame('error', { code: 'AI_PROVIDER_UNAVAILABLE', message: 'Kesildi.', reason: 'STREAM_INTERRUPTED', retryable: true, partial: true })]).response,
    () => streamResponse([ACCEPTED, frame('error', { code: 'AI_CANCELLED', message: 'İptal.', partial: false })]).response,
    () => streamResponse([frame('delta', { text: 'accepted yok' })]).response
  ];
  stubFetch(t, () => responses.shift()());
  const send = () => streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard' });

  const network = await send();
  assert.deepEqual([network.code, network.retryable], ['NETWORK', true]);
  const conflict = await send();
  assert.deepEqual([conflict.code, conflict.reason, conflict.status, conflict.phase], ['CONFLICT', 'GENERATION_IN_PROGRESS', 409, 'request']);
  const busy = await send();
  assert.deepEqual([busy.code, busy.retryable, busy.retryAfterMs], ['AI_BUSY', true, 2000]);
  const html = await send();
  assert.equal(html.code, ASSISTANT_INVALID_RESPONSE);
  const truncated = await send();
  assert.deepEqual([truncated.code, truncated.partial, truncated.retryable], ['STREAM_INTERRUPTED', true, true]);
  const interrupted = await send();
  assert.deepEqual([interrupted.code, interrupted.reason, interrupted.partial, interrupted.phase], ['AI_PROVIDER_UNAVAILABLE', 'STREAM_INTERRUPTED', true, 'stream']);
  const cancelled = await send();
  assert.equal(cancelled.cancelled, true);
  const protocol = await send();
  assert.deepEqual([protocol.code, protocol.reason], ['PROTOCOL_ERROR', 'UNEXPECTED_EVENT']);
});

test('protokol hatasında okuma bırakılır ve istek kesilir', async (t) => {
  const stream = streamResponse([], { manual: true });
  let aborted = false;
  stubFetch(t, (call) => {
    call.init.signal.addEventListener('abort', () => { aborted = true; });
    return stream.response;
  });
  const pending = streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard' });
  await new Promise((resolve) => setImmediate(resolve));
  stream.push('event: accepted\ndata: {bozuk\n\n');
  const result = await pending;
  assert.equal(result.code, 'PROTOCOL_ERROR');
  assert.equal(aborted, true);
  assert.equal(stream.cancelled, true);
});

/* ── JSON uçları ──────────────────────────────────────────── */

test('JSON uçları beklenen biçimi doğrular; biçimsiz başarılı yanıt başarı sayılmaz', async (t) => {
  const replies = [
    { assistant: { available: true, modes: [{ id: 'standard', available: true }], limits: { maxMessageChars: 8000 } } },
    { assistant: { available: 'evet' } },
    { conversations: [conversation], nextCursor: 'abc' },
    { conversations: [{ id: 'kimlik-değil', title: 'x' }] },
    { conversation, messages: [userMessage] },
    { conversation: { ...conversation, id: '22222222-2222-4222-8222-222222222222' }, messages: [] },
    { deleted: true },
    { ok: true }
  ];
  const calls = stubFetch(t, () => Response.json(replies.shift()));
  assert.equal((await loadAssistantReadinessRequest()).ok, true);
  assert.equal((await loadAssistantReadinessRequest()).code, ASSISTANT_INVALID_RESPONSE);
  assert.equal((await listAssistantConversationsRequest({ cursor: 'a/b c' })).ok, true);
  assert.match(calls.at(-1).url, /\/conversations\/before\/a%2Fb%20c$/);
  assert.equal((await listAssistantConversationsRequest()).code, ASSISTANT_INVALID_RESPONSE);
  assert.equal((await loadAssistantConversationRequest(CONVERSATION_ID)).ok, true);
  assert.equal((await loadAssistantConversationRequest(CONVERSATION_ID)).code, ASSISTANT_INVALID_RESPONSE, 'istenenden başka bir konuşma kabul edilmez');
  assert.equal((await deleteAssistantConversationRequest(CONVERSATION_ID)).ok, true);
  assert.equal(calls.at(-1).init.method, 'DELETE');
  assert.equal((await deleteAssistantConversationRequest(CONVERSATION_ID)).code, ASSISTANT_INVALID_RESPONSE);
  for (const call of calls) assert.doesNotMatch(call.url, /\?/);
});

test('JSON olmayan geçici HTTP hataları yeniden denenebilir', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const status of [429, 500, 502, 503, 504, 403]) {
    globalThis.fetch = async () => new Response('<html>Proxy</html>', { status });
    const result = await streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard' });
    assert.equal(result.retryable, status !== 403, String(status));
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'REQUEST_FAILED', details: { retryable: false } } }), { status: 503 });
  assert.equal((await streamAssistantTurnRequest({ turnId: TURN_ID, message: 'Soru', mode: 'standard' })).retryable, false);
});

test('olay sözleşmesi kullanıcı ve yanıt rollerini karıştırmaz', () => {
  assert.throws(() => createAssistantStreamDecoder().push(frame('accepted', {
    v: 1, conversation, userMessage: { ...userMessage, role: 'assistant' }
  })), /MALFORMED_EVENT/);
  const decoder = createAssistantStreamDecoder();
  decoder.push(ACCEPTED);
  assert.throws(() => decoder.push(frame('done', {
    conversation, assistantMessage: { ...assistantMessage, role: 'user' }
  })), /MALFORMED_EVENT/);
});
