/**
 * Yapay zekâ · sağlayıcı akışı (OpenAI uyumlu Server-Sent Events).
 *
 * Çözücü yapay gövdelerle bayt düzeyinde sınanır (parça sınırları, UTF-8
 * bölünmesi, `[DONE]`, bozuk olay, erken bitiş, sınırlar); bağdaştırıcı ise
 * gerçek soketler üzerinden yerel ağ geçidi ikizine karşı sınanır (akış
 * isteği, hata durumları, yarıda kopan bağlantı, iptalin sağlayıcıya ulaşması).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sseChunksFor, startFakeOpenAiCompatibleServer } from './helpers/fakeOpenAiCompatibleServer.mjs';
import { PERSONAL_KEY_A, captureConsole } from './helpers/aiStack.mjs';

const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const {
  AI_STREAM_LIMITS,
  createLeadingThinkFilter,
  readChatCompletionStream
} = await import('../src/server/ai/providers/openAiCompatibleStream.js');
const { createEventStreamParser } = await import('../src/domain/ai/eventStreamParser.js');

const MESSAGES = [{ role: 'system', content: 'Kısa yanıt ver.' }, { role: 'user', content: 'Merhaba' }];
const encoder = new TextEncoder();

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content, extra = {}) {
  return sse({ id: 'c1', object: 'chat.completion.chunk', model: 'akis-modeli', choices: [{ index: 0, delta: { content }, ...extra }] });
}

function finish(reason = 'stop') {
  return sse({ id: 'c1', model: 'akis-modeli', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

/** Parçaları sırayla veren yapay yanıt gövdesi; iptal edilip edilmediği izlenir. */
function bodyFrom(chunks) {
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
  const state = { cancelled: false, reads: 0 };
  state.stream = new ReadableStream({
    pull(controller) {
      state.reads += 1;
      if (queue.length) controller.enqueue(queue.shift());
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return state;
}

/** Metni verilen bayt boyutunda parçalara böler (çok baytlı karakterler de bölünür). */
function byteChunks(text, size) {
  const bytes = encoder.encode(text);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += size) chunks.push(bytes.slice(index, index + size));
  return chunks;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function textOf(events) {
  return events.filter((event) => event.type === 'text').map((event) => event.text).join('');
}

async function rejectsWithReason(pending, code, reason) {
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details?.reason, reason);
    return true;
  });
}

async function fakeServer(t, options = {}) {
  const server = await startFakeOpenAiCompatibleServer(options);
  t.after(() => server.close());
  return server;
}

function stream(provider, server, overrides = {}) {
  return provider.streamChatCompletion({
    baseUrl: server.baseUrl,
    apiKey: PERSONAL_KEY_A,
    model: 'akis-modeli',
    messages: MESSAGES,
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...overrides
  });
}

/* ── Olay akışı çözücüsü (sunucu ve tarayıcının ortak saf modülü) ── */

test('olay çözücü CRLF, CR ve LF satır sonlarını parçalar arasında da tek satır sonu sayar', () => {
  const parser = createEventStreamParser({ maxEventChars: 1024, tooLarge: () => new Error('büyük') });
  const events = [
    ...parser.push('data: bir\r'),
    ...parser.push('\n\r\ndata: iki\r\r'),
    ...parser.push('event: özel\ndata: üç\ndata: dört\n\n')
  ];
  assert.deepEqual(events, [
    { event: 'message', data: 'bir' },
    { event: 'message', data: 'iki' },
    { event: 'özel', data: 'üç\ndört' }
  ]);
});

test('olay çözücü yorumları (canlı tutma) veri saymaz; boş satırla yayımlanmamış olay sonda yayımlanmaz', () => {
  const comments = [];
  const parser = createEventStreamParser({ maxEventChars: 1024, tooLarge: () => new Error('büyük'), onComment: (text) => comments.push(text) });
  assert.deepEqual(parser.push(': keepalive\n\n:\n\ndata: yarım'), []);
  assert.deepEqual(comments, ['keepalive', '']);
  assert.equal(parser.end(), 'yarım');
});

test('olay çözücü tamamlanmamış satırı ve tek olayı sınırlar; sınır aşılınca üretilen hata fırlar', () => {
  const tooLarge = () => new Error('OLAY_ÇOK_BÜYÜK');
  const pending = createEventStreamParser({ maxEventChars: 16, tooLarge });
  assert.throws(() => pending.push(`data: ${'x'.repeat(20)}`), /OLAY_ÇOK_BÜYÜK/);
  const joined = createEventStreamParser({ maxEventChars: 16, tooLarge });
  assert.throws(() => joined.push('data: 12345678\ndata: 12345678\n'), /OLAY_ÇOK_BÜYÜK/);
});

/* ── Sağlayıcı akışının çözümü ─────────────────────────────── */

test('geçerli akış: metin parçaları, bitiş nedeni, model ve kullanım; [DONE] sonrası okunmaz', async () => {
  const body = bodyFrom([...sseChunksFor('akis-modeli', 'Merhaba dünya, akış çalışıyor.'), delta('DONE sonrası görünmemeli')]);
  const events = await collect(readChatCompletionStream(body.stream));
  assert.equal(textOf(events), 'Merhaba dünya, akış çalışıyor.');
  const done = events.at(-1);
  assert.deepEqual(done, {
    type: 'done',
    finishReason: 'stop',
    model: 'akis-modeli',
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 }
  });
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(body.cancelled, true, '[DONE] gelince sağlayıcı bağlantısı bırakılır');
});

test('parça sınırları: her bayt ayrı gelse de, bütün olaylar tek parçada gelse de sonuç aynıdır', async () => {
  const text = 'Çok baytlı karakterler: ğüşiöç İĞÜŞ — ve bir emoji 🚀 ile Türkçe metin.';
  const raw = sseChunksFor('akis-modeli', text).join('');
  for (const chunks of [byteChunks(raw, 1), byteChunks(raw, 3), byteChunks(raw, 7), [raw]]) {
    const events = await collect(readChatCompletionStream(bodyFrom(chunks).stream));
    assert.equal(textOf(events), text);
    assert.equal(events.at(-1).finishReason, 'stop');
  }
});

test('UTF-8 karakteri iki ağ parçasına bölünse de bozulmaz', async () => {
  const raw = delta('ş🙂ğ') + finish() + 'data: [DONE]\n\n';
  const bytes = encoder.encode(raw);
  const split = raw.indexOf('ş');
  const cut = encoder.encode(raw.slice(0, split)).length + 1;
  const events = await collect(readChatCompletionStream(bodyFrom([bytes.slice(0, cut), bytes.slice(cut, cut + 2), bytes.slice(cut + 2)]).stream));
  assert.equal(textOf(events), 'ş🙂ğ');
});

test('boş parçalar, bilinmeyen alanlar, yorumlar ve rol olayı metin üretmez', async () => {
  const events = await collect(readChatCompletionStream(bodyFrom([
    ': keepalive\n\n',
    sse({ choices: [{ index: 0, delta: { role: 'assistant' } }], system_fingerprint: 'x', yeniAlan: { a: 1 } }),
    delta(''),
    sse({ choices: [] }),
    delta('Yanıt'),
    sse({ choices: [{ index: 0, delta: { content: null, tool_calls: null } }] }),
    finish('length'),
    'data: [DONE]\n\n'
  ]).stream));
  assert.equal(textOf(events), 'Yanıt');
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
  assert.equal(events.at(-1).finishReason, 'length');
});

test('akıl yürütme alanları ve baştaki <think> bloğu görünür metne girmez; yalnızca evre bildirilir', async () => {
  const events = await collect(readChatCompletionStream(bodyFrom([
    sse({ choices: [{ index: 0, delta: { reasoning_content: 'gizli düşünce 1' } }] }),
    sse({ choices: [{ index: 0, delta: { reasoning: 'gizli düşünce 2' } }] }),
    delta('<thi'),
    delta('nk>iç ses </th'),
    delta('ink>\n\nGörünür yanıt.'),
    finish(),
    'data: [DONE]\n\n'
  ]).stream));
  assert.equal(textOf(events), 'Görünür yanıt.');
  assert.ok(events.some((event) => event.type === 'reasoning'));
  assert.doesNotMatch(JSON.stringify(events), /gizli düşünce|iç ses/);
});

test('<think> süzgeci: yanıtın ORTASINDAKİ etiket metindir; kapanmayan blok görünür metin üretmez', () => {
  const middle = createLeadingThinkFilter();
  assert.equal(middle.push('Önce yanıt ') + middle.push('<think>bu görünür</think>'), 'Önce yanıt <think>bu görünür</think>');
  const open = createLeadingThinkFilter();
  assert.equal(open.push('<think>sonsuz düşünce'), '');
  assert.equal(open.thinking, true);
  assert.equal(open.end(), '');
  const prefix = createLeadingThinkFilter();
  assert.equal(prefix.push('<th'), '');
  assert.equal(prefix.end(), '<th', 'etikete benzeyen ama tamamlanmayan baş metin kaybolmaz');
});

test('bozuk olaylar AI_PROVIDER_RESPONSE_INVALID olur; beklenmeyen rol kabul edilmez', async () => {
  const cases = [
    ['data: {bozuk json\n\n', 'STREAM_EVENT_MALFORMED'],
    ['data: [1,2]\n\n', 'STREAM_EVENT_MALFORMED'],
    [sse({ choices: 'dizi değil' }), 'STREAM_EVENT_MALFORMED'],
    [sse({ choices: [{ index: 0, delta: { content: 42 } }] }), 'STREAM_EVENT_MALFORMED'],
    [sse({ choices: [{ index: 0, delta: 'metin' }] }), 'STREAM_EVENT_MALFORMED'],
    [sse({ usage: 'yok' }), 'STREAM_EVENT_MALFORMED'],
    [sse({ choices: [{ index: 0, delta: { role: 'user', content: 'isteğin yankısı' } }] }), 'INVALID_ROLE']
  ];
  for (const [chunk, reason] of cases) {
    const body = bodyFrom([delta('önce'), chunk, 'data: [DONE]\n\n']);
    await rejectsWithReason(collect(readChatCompletionStream(body.stream)), 'AI_PROVIDER_RESPONSE_INVALID', reason);
    assert.equal(body.cancelled, true, `${reason}: bağlantı bırakılır`);
  }
  // Yanıtlayan model ilk bildirildiği olaydan alınır; aşırı uzun kimlik kabul edilmez.
  await rejectsWithReason(
    collect(readChatCompletionStream(bodyFrom([sse({ model: 'm'.repeat(513), choices: [] }), 'data: [DONE]\n\n']).stream)),
    'AI_PROVIDER_RESPONSE_INVALID', 'MODEL_ID_TOO_LONG'
  );
});

test('akış ortasındaki hata olayı yanıtı yarıda keser (sağlayıcı gövdesi taşınmaz)', async () => {
  for (const chunk of [sse({ error: { message: `Bearer ${PERSONAL_KEY_A} reddedildi` } }), `event: error\ndata: ${JSON.stringify({ message: 'x' })}\n\n`]) {
    await assert.rejects(collect(readChatCompletionStream(bodyFrom([delta('kısmi'), chunk]).stream)), (error) => {
      assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
      assert.equal(error.details.reason, 'STREAM_ERROR_EVENT');
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(PERSONAL_KEY_A), false);
      return true;
    });
  }
});

test('[DONE] ya da bitiş nedeni olmadan kapanan akış kesilmiştir; bitiş nedeni varsa tamamlanmış sayılır', async () => {
  await rejectsWithReason(collect(readChatCompletionStream(bodyFrom([delta('yarım yanıt')]).stream)), 'AI_PROVIDER_UNAVAILABLE', 'STREAM_TRUNCATED');
  await rejectsWithReason(collect(readChatCompletionStream(bodyFrom([]).stream)), 'AI_PROVIDER_UNAVAILABLE', 'STREAM_TRUNCATED');
  const finished = await collect(readChatCompletionStream(bodyFrom([delta('tam yanıt'), finish()]).stream));
  assert.equal(textOf(finished), 'tam yanıt');
  // Son boş satırı gönderilmeden kapanan `[DONE]` de sonlandırıcıdır.
  const unterminated = await collect(readChatCompletionStream(bodyFrom([delta('son'), 'data: [DONE]']).stream));
  assert.equal(textOf(unterminated), 'son');
});

test('sınırlar: ham akış, biriken metin ve tek olay büyüklüğü aşılınca akış kesilir', async () => {
  const limits = { ...AI_STREAM_LIMITS, maxStreamBytes: 512 };
  await rejectsWithReason(
    collect(readChatCompletionStream(bodyFrom(Array.from({ length: 20 }, () => delta('x'.repeat(40)))).stream, { limits })),
    'AI_PROVIDER_RESPONSE_INVALID', 'STREAM_TOO_LARGE'
  );
  await rejectsWithReason(
    collect(readChatCompletionStream(bodyFrom([delta('a'.repeat(30)), delta('b'.repeat(30))]).stream, { limits: { ...AI_STREAM_LIMITS, maxTextChars: 50 } })),
    'AI_PROVIDER_RESPONSE_INVALID', 'STREAM_TEXT_TOO_LARGE'
  );
  const endless = bodyFrom(Array.from({ length: 50 }, () => 'data: ' + 'y'.repeat(100)));
  await rejectsWithReason(
    collect(readChatCompletionStream(endless.stream, { limits: { ...AI_STREAM_LIMITS, maxEventChars: 1024 } })),
    'AI_PROVIDER_RESPONSE_INVALID', 'STREAM_EVENT_TOO_LARGE'
  );
  assert.equal(endless.cancelled, true);
  assert.ok(endless.reads < 50, 'sınır aşılınca geri kalan akış okunmaz');
});

test('okuma hatası yarıda kalmış yanıttır; iptal edilmişse iptal nedeni korunur', async () => {
  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(delta('ilk')));
    },
    pull(controller) {
      controller.error(new Error('soket kapandı'));
    }
  });
  const iterator = readChatCompletionStream(failing);
  assert.deepEqual((await iterator.next()).value, { type: 'text', text: 'ilk' });
  await rejectsWithReason(iterator.next(), 'AI_PROVIDER_UNAVAILABLE', 'STREAM_INTERRUPTED');

  const controller = new AbortController();
  const reason = new Error('kullanıcı durdurdu');
  const aborted = new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode(delta('ilk')));
    },
    pull(streamController) {
      controller.abort(reason);
      streamController.error(new DOMException('aborted', 'AbortError'));
    }
  });
  await assert.rejects(collect(readChatCompletionStream(aborted, { signal: controller.signal })), (error) => error === reason);
});

/* ── Gerçek bağdaştırıcı, gerçek soket ─────────────────────── */

test('akış isteği stream:true, model, iletiler, çıktı sınırı ve anahtarla gider; metin parça parça gelir', async (t) => {
  const server = await fakeServer(t);
  const provider = createOpenAiCompatibleProvider();
  const { events } = await stream(provider, server);
  const received = await collect(events);
  assert.equal(textOf(received), 'Merhaba, sahte ağ geçidi yanıt veriyor.');
  assert.ok(received.filter((event) => event.type === 'text').length >= 2, 'metin tek parça beklenmez');
  assert.deepEqual(received.at(-1), { type: 'done', finishReason: 'stop', model: 'akis-modeli', usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 } });
  const [request] = server.state.requests;
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.bearer, PERSONAL_KEY_A);
  assert.deepEqual(request.body, { model: 'akis-modeli', messages: MESSAGES, stream: true, max_tokens: 256 });
});

for (const [status, code] of [[401, 'AI_KEY_INVALID'], [403, 'AI_UNAUTHORIZED'], [429, 'AI_RATE_LIMITED'], [500, 'AI_PROVIDER_UNAVAILABLE'], [504, 'AI_TIMEOUT']]) {
  test(`akış başlamadan HTTP ${status} → ${code}; anahtarı yankılayan hata gövdesi okunmaz ve günlüğe yazılmaz`, async (t) => {
    const server = await fakeServer(t);
    server.setScenario({ status, retryAfter: status === 429 ? 5 : undefined });
    const output = captureConsole(t);
    await assert.rejects(stream(createOpenAiCompatibleProvider(), server), (error) => {
      assert.equal(error.code, code);
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(serialized.includes(PERSONAL_KEY_A), false);
      assert.equal(serialized.includes('Rejected'), false);
      return true;
    });
    assert.equal(output.join('\n').includes(PERSONAL_KEY_A), false);
  });
}

test('SSE olmayan yanıt reddedilir; akışı yok sayıp JSON dönen uyumlu ağ geçidi tek parça metin olarak okunur', async (t) => {
  const server = await fakeServer(t);
  const provider = createOpenAiCompatibleProvider();
  server.setScenario({ stream: { contentType: 'text/html', chunks: ['<html>vekil sayfası</html>'] } });
  await rejectsWithReason(stream(provider, server), 'AI_PROVIDER_RESPONSE_INVALID', 'STREAM_CONTENT_TYPE');
  server.setScenario({ jsonForStream: true, text: '<think>gizli</think>JSON yanıtı' });
  const received = await collect((await stream(provider, server)).events);
  assert.deepEqual(received.map((event) => event.type), ['text', 'done']);
  assert.equal(textOf(received), 'JSON yanıtı');
});

test('ilk parçadan sonra kopan bağlantı: ilk metin iletilmiş olur, ardından yarıda kesilme hatası gelir', async (t) => {
  const server = await fakeServer(t);
  server.setScenario({ stream: { destroyAfter: 2, gapMs: 5 } });
  const received = [];
  await assert.rejects(async () => {
    for await (const event of (await stream(createOpenAiCompatibleProvider(), server)).events) received.push(event);
  }, (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && ['STREAM_INTERRUPTED', 'STREAM_TRUNCATED'].includes(error.details.reason));
  // İki parça yazıldı: rol olayı ve metnin ilk yarısı.
  const text = 'Merhaba, sahte ağ geçidi yanıt veriyor.';
  assert.equal(textOf(received), text.slice(0, Math.ceil(text.length / 2)));
});

test('iptal süren akışı sağlayıcı tarafında da kapatır; okuma iptal nedeniyle biter', async (t) => {
  const server = await fakeServer(t);
  server.setScenario({ stream: { hangAfter: 2 } });
  const controller = new AbortController();
  const { events } = await stream(createOpenAiCompatibleProvider(), server, { signal: controller.signal });
  const iterator = events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'text');
  const reason = new Error('Durdur');
  const pending = iterator.next();
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await server.waitForClosedStreams(1);
  assert.equal(server.state.streamsCompleted, 0);
});
