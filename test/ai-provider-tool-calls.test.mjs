/**
 * Yapay zekâ · araç çağrısı (OpenAI uyumlu `tools` / `tool_calls`).
 *
 * Bağdaştırıcı: sunucunun sabit kataloğu ve sağlayıcıdan bağımsız iletiler tel
 * biçimine doğru çevrilir; akışta parçalara bölünmüş çağrılar birleştirilir,
 * yalnızca akış TAMAMLANINCA verilir ve sınırlarla korunur. Ağ geçidi: araçlı
 * tur tek kapasite kirasıyla yürür, döküm doğrulanır, araç yeteneği olmayan
 * profil reddedilir ve açık SQL işlemi içinde model beklenmez.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAiProvider } from './helpers/fakeAiProvider.mjs';
import { DEFAULT_KEY, PERSONAL_KEY_A, SICIL_A, createAiStack } from './helpers/aiStack.mjs';

const { createOpenAiCompatibleProvider } = await import('../src/server/ai/providers/openAiCompatibleProvider.js');
const { readChatCompletionStream } = await import('../src/server/ai/providers/openAiCompatibleStream.js');
const { createAiAdmissionController } = await import('../src/server/ai/admissionController.js');
const { createAiGateway } = await import('../src/server/ai/aiGateway.js');
const { parseAiConfig } = await import('../src/server/ai/aiConfig.js');
const { validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');
const { resetTelemetryRegistryForTests } = await import('../src/server/observability/telemetryRegistry.js');
const { getAiGateway } = await import('../src/server/ai/aiRuntime.js');
const { withSqlTransaction } = await import('../src/server/db/pool.js');

const encoder = new TextEncoder();
const TOOLS = Object.freeze([{
  name: 'rota_task_search',
  description: 'Yetkili görevleri arar.',
  parameters: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } } }
}]);
const TRANSCRIPT = Object.freeze([
  { role: 'system', content: 'Yönerge' },
  { role: 'user', content: 'Radar görevleri?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'rota_task_search', arguments: '{"projectId":"p1"}' }] },
  { role: 'tool', toolCallId: 'call_a', content: '{"ok":true,"evidenceId":"R1"}' }
]);

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta, extra = {}) {
  return sse({ id: 'c1', object: 'chat.completion.chunk', model: 'arac-modeli', choices: [{ index: 0, delta, ...extra }] });
}

function sseResponse(parts) {
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function providerWith(respond) {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return respond();
    }
  });
  return { provider, requests };
}

function toolStream(provider, overrides = {}) {
  return provider.streamToolCompletion({
    baseUrl: 'http://ag-gecidi.test/v1',
    apiKey: PERSONAL_KEY_A,
    model: 'arac-modeli',
    messages: TRANSCRIPT,
    tools: TOOLS,
    toolChoice: 'auto',
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides
  });
}

async function collect(opened) {
  const events = [];
  for await (const event of opened.events) events.push(event);
  return events;
}

async function rejectsWithReason(pending, reason) {
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'AI_PROVIDER_RESPONSE_INVALID');
    assert.equal(error.details?.reason, reason);
    return true;
  });
}

/* ── Bağdaştırıcı ─────────────────────────────────────────── */

test('istek: katalog "function" aracı, seçim kipi ve araçlı döküm OpenAI tel biçimindedir', async () => {
  const { provider, requests } = providerWith(() => sseResponse([chunk({ content: 'Tamam' }), chunk({}, { finish_reason: 'stop' }), 'data: [DONE]\n\n']));
  await collect(await toolStream(provider));
  await collect(await toolStream(provider, { toolChoice: 'none' }));
  const [auto, none] = requests;
  assert.equal(auto.url, 'http://ag-gecidi.test/v1/chat/completions');
  assert.equal(auto.body.stream, true);
  assert.equal(auto.body.max_tokens, 512);
  assert.deepEqual(auto.body.tools, [{ type: 'function', function: { name: 'rota_task_search', description: 'Yetkili görevleri arar.', parameters: TOOLS[0].parameters } }]);
  assert.equal(auto.body.tool_choice, 'auto');
  assert.equal(none.body.tool_choice, 'none');
  assert.deepEqual(auto.body.messages, [
    { role: 'system', content: 'Yönerge' },
    { role: 'user', content: 'Radar görevleri?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'rota_task_search', arguments: '{"projectId":"p1"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true,"evidenceId":"R1"}' }
  ]);
  const plain = providerWith(() => sseResponse([chunk({ content: 'x' }, { finish_reason: 'stop' })]));
  await collect(await toolStream(plain.provider, { tools: [] }));
  assert.equal(Object.hasOwn(plain.requests[0].body, 'tools'), false, 'katalog yoksa araç alanı gönderilmez');
  assert.equal(Object.hasOwn(plain.requests[0].body, 'tool_choice'), false);
});

test('akış: parçalara bölünmüş ad ve bağımsız değişkenler birleştirilir; çağrılar yalnızca sonda ve dizin sırasıyla verilir', async () => {
  const { provider } = providerWith(() => sseResponse([
    chunk({ content: 'Bakıyorum. ' }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'rota_port', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'rota_task_', arguments: '{"proj' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: 'search', arguments: 'ectId":"p1"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { name: 'folio_summary', arguments: '{}' } }] }),
    chunk({}, { finish_reason: 'tool_calls' }),
    'data: [DONE]\n\n'
  ]));
  const events = await collect(await toolStream(provider));
  assert.deepEqual(events.map((event) => event.type), ['text', 'tool_call_started', 'tool_call_started', 'done']);
  const done = events.at(-1);
  assert.equal(done.finishReason, 'tool_calls');
  assert.deepEqual(done.toolCalls, [
    { id: 'call_a', name: 'rota_task_search', arguments: '{"projectId":"p1"}', oversize: false },
    { id: 'call_b', name: 'rota_portfolio_summary', arguments: '{}', oversize: false }
  ]);
});

test('akış: kimliksiz ya da dizinsiz çağrılara kararlı kimlik verilir; yinelenen kimlik ayrıştırılır', async () => {
  const { provider } = providerWith(() => sseResponse([
    chunk({ tool_calls: [{ function: { name: 'rota_a', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ id: 'x', function: { name: 'rota_b', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 7, id: 'x', function: { name: 'rota_c', arguments: '{}' } }] }),
    chunk({}, { finish_reason: 'tool_calls' })
  ]));
  const done = (await collect(await toolStream(provider))).at(-1);
  assert.deepEqual(done.toolCalls.map((call) => [call.id, call.name]), [['call_1', 'rota_a'], ['x', 'rota_b'], ['x_3', 'rota_c']]);
});

test('akış: sınırı aşan bağımsız değişken saklanmaz, çağrı "aşırı büyük" işaretlenir; fazla çağrı yanıtı geçersiz kılar', async () => {
  const huge = 'x'.repeat(40 * 1024);
  const { provider } = providerWith(() => sseResponse([
    chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'rota_task_search', arguments: `{"text":"${huge}` } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }),
    chunk({}, { finish_reason: 'tool_calls' })
  ]));
  const [call] = (await collect(await toolStream(provider))).at(-1).toolCalls;
  assert.equal(call.oversize, true);
  assert.equal(call.arguments, '');

  const many = Array.from({ length: 17 }, (_, index) => chunk({ tool_calls: [{ index, id: `c${index}`, function: { name: 'rota_a', arguments: '{}' } }] }));
  const flood = providerWith(() => sseResponse([...many, chunk({}, { finish_reason: 'tool_calls' })]));
  await rejectsWithReason(collect(await toolStream(flood.provider)), 'STREAM_TOOL_CALLS_TOO_MANY');
});

test('akış: bozuk çağrı parçası, bitişten sonra gelen çağrı ve yarıda kalan akış reddedilir; yarım çağrı dışarı verilmez', async () => {
  const cases = [
    [chunk({ tool_calls: [{ index: 0, type: 'code_interpreter', function: { name: 'rota_a' } }] })],
    [chunk({ tool_calls: [{ index: 0, function: { name: 42 } }] })],
    [chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'rota_a' } }] }), chunk({ tool_calls: [{ index: 0, id: 'b' }] })],
    [chunk({ tool_calls: [{ index: 0, id: 'a b', function: { name: 'rota_a' } }] })],
    [chunk({ tool_calls: [{ index: 0, function: { name: 'r'.repeat(65) } }] })],
    [chunk({ tool_calls: [{ index: -1, function: { name: 'rota_a' } }] })]
  ];
  for (const parts of cases) {
    const { provider } = providerWith(() => sseResponse([...parts, chunk({}, { finish_reason: 'tool_calls' })]));
    await rejectsWithReason(collect(await toolStream(provider)), 'STREAM_TOOL_CALL_MALFORMED');
  }
  const late = providerWith(() => sseResponse([
    chunk({}, { finish_reason: 'stop' }),
    chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'rota_a', arguments: '{}' } }] })
  ]));
  await rejectsWithReason(collect(await toolStream(late.provider)), 'CONTENT_AFTER_FINISH');

  const truncated = providerWith(() => sseResponse([chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'rota_a', arguments: '{"x"' } }] })]));
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of (await toolStream(truncated.provider)).events) seen.push(event);
  }, (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && error.details?.reason === 'STREAM_TRUNCATED');
  assert.equal(seen.some((event) => event.type === 'done'), false, 'kesilen akışın çağrısı yürütülmez');
});

test('akışı yok sayan ağ geçidinin tek JSON yanıtındaki çağrılar aynı biçim ve sınırlardan geçer', async () => {
  const payload = {
    id: 'x',
    model: 'arac-modeli',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'rota_task_search', arguments: '{"projectId":"p1"}' } },
          { type: 'function', function: { name: 'rota_portfolio_summary', arguments: {} } }
        ]
      }
    }]
  };
  const { provider } = providerWith(() => Response.json(payload));
  const events = await collect(await toolStream(provider));
  assert.deepEqual(events.map((event) => event.type), ['tool_call_started', 'tool_call_started', 'done']);
  assert.deepEqual(events.at(-1).toolCalls, [
    { id: 'call_a', name: 'rota_task_search', arguments: '{"projectId":"p1"}', oversize: false },
    { id: 'call_2', name: 'rota_portfolio_summary', arguments: '{}', oversize: false }
  ]);
  const tooMany = providerWith(() => Response.json({ ...payload, choices: [{ ...payload.choices[0], message: { ...payload.choices[0].message, tool_calls: Array.from({ length: 17 }, () => payload.choices[0].message.tool_calls[0]) } }] }));
  await rejectsWithReason(toolStream(tooMany.provider), 'STREAM_TOOL_CALLS_TOO_MANY');
});

test('araç istenmeyen akışlı sohbet (Aşama 2) çağrı parçalarını yok sayar; done çağrı taşımaz', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunk({ content: 'Merhaba', tool_calls: [{ index: 0, id: 'a', function: { name: 'rota_a', arguments: '{}' } }] })));
      controller.enqueue(encoder.encode(chunk({}, { finish_reason: 'stop' })));
      controller.close();
    }
  });
  const events = [];
  for await (const event of readChatCompletionStream(body)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['text', 'done']);
  assert.equal(Object.hasOwn(events.at(-1), 'toolCalls'), false);
});

/* ── Ağ geçidi: araç oturumu ──────────────────────────────── */

function gatewayFor(t, { provider = createFakeAiProvider(), registry = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry } = {}) {
  resetAiTelemetryForTests();
  resetTelemetryRegistryForTests();
  t.after(() => {
    resetAiTelemetryForTests();
    resetTelemetryRegistryForTests();
  });
  const config = parseAiConfig({
    MERGEN_ROTA_AI_ENABLED: 'true',
    MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
    MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY
  });
  const admission = createAiAdmissionController({ limits: config.limits });
  const gateway = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admission,
    loadConfig: () => config,
    loadRegistry: async () => registry,
    resolveCredential: async () => ({ source: 'personal', apiKey: PERSONAL_KEY_A }),
    currentSicil: async () => SICIL_A,
    verifySicil: async () => {},
    random: () => 0
  });
  return { gateway, admission, provider };
}

test('araç oturumu tüm model turları boyunca TEK kapasite kirası tutar; iş bitince ya da hata verince kira bırakılır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue(
    { type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: {} }] },
    { type: 'answer', text: 'Yanıt 【R1】' }
  );
  const { gateway, admission } = gatewayFor(t, { provider });
  const peaks = [];
  const result = await gateway.runToolSession({
    profile: 'chat.tools',
    run: async (session) => {
      assert.equal(session.sicil, SICIL_A);
      const first = await session.round({ messages: TRANSCRIPT.slice(0, 2), tools: TOOLS });
      peaks.push(admission.status().active);
      assert.deepEqual(first.toolCalls.map((call) => call.name), ['rota_task_search']);
      const second = await session.round({
        messages: [...TRANSCRIPT.slice(0, 2), { role: 'assistant', content: '', toolCalls: first.toolCalls }, { role: 'tool', toolCallId: first.toolCalls[0].id, content: '{}' }],
        tools: TOOLS,
        toolChoice: 'none'
      });
      peaks.push(admission.status().active);
      return second.text;
    }
  });
  assert.equal(result, 'Yanıt 【R1】');
  assert.deepEqual(peaks, [1, 1]);
  assert.equal(admission.status().active, 0);
  assert.deepEqual(provider.calls.map((call) => [call.kind, call.toolChoice]), [['tools', 'auto'], ['tools', 'none']]);

  await assert.rejects(gateway.runToolSession({ profile: 'chat.tools', run: async () => { throw new Error('tur hatası'); } }));
  assert.equal(admission.status().active, 0, 'hata yolunda da kira bırakılır');
});

test('araç yeteneği olmayan profil ve geçersiz döküm sağlayıcıya gitmeden reddedilir', async (t) => {
  const { gateway, provider, admission } = gatewayFor(t);
  await assert.rejects(
    gateway.runToolSession({ profile: 'vision', run: async () => 'x' }),
    (error) => error.code === 'AI_CONFIGURATION_ERROR' && error.details.reason === 'CAPABILITY_MISMATCH'
  );
  const invalidTranscripts = [
    [{ role: 'user', content: 'x' }, { role: 'tool', toolCallId: 'boşluklu kimlik', content: '{}' }],
    [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'rota_a', arguments: {} }] }],
    [{ role: 'developer', content: 'x' }],
    Array.from({ length: 97 }, () => ({ role: 'user', content: 'x' })),
    []
  ];
  for (const messages of invalidTranscripts) {
    await assert.rejects(
      gateway.runToolSession({ profile: 'chat.tools', run: (session) => session.round({ messages, tools: TOOLS }) }),
      (error) => error.code === 'AI_REQUEST_INVALID' && error.details.reason === 'MESSAGES_INVALID'
    );
  }
  assert.equal(provider.calls.length, 0);
  assert.equal(admission.status().active, 0);
});

test('metin de çağrı da taşımayan model turu geçersiz yanıttır', async (t) => {
  const provider = createFakeAiProvider();
  provider.enqueue({ type: 'answer', text: '', chunks: [] });
  const { gateway } = gatewayFor(t, { provider });
  await assert.rejects(
    gateway.runToolSession({ profile: 'chat.tools', run: (session) => session.round({ messages: TRANSCRIPT.slice(0, 2), tools: TOOLS }) }),
    (error) => error.code === 'AI_PROVIDER_RESPONSE_INVALID' && error.details.reason === 'EMPTY_COMPLETION'
  );
});

test('araç oturumu açık bir SQL işlemi içinde başlatılamaz', async (t) => {
  const { provider } = createAiStack(t);
  await assert.rejects(
    withSqlTransaction(() => getAiGateway().runToolSession({ profile: 'chat.tools', run: async () => 'x' })),
    (error) => error.code === 'AI_INTERNAL_ERROR' && error.details.reason === 'SQL_TRANSACTION_ACTIVE'
  );
  assert.equal(provider.calls.length, 0);
});
