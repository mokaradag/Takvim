/**
 * OpenAI uyumlu yapay zekâ ağ geçidinin yerel HTTP ikizi.
 *
 * Gerçek `fetch` bağdaştırıcısını gerçek soketlerle sınar: normal yanıt,
 * HTTP hata durumları, oran sınırı, bozuk ve aşırı büyük gövde, model listesi
 * yerine HTML sayfası, yönlendirme, gecikme ve hiç yanıt vermeme. Hata gövdeleri bilerek `Authorization`
 * başlığını yankılar; bağdaştırıcının gövdeyi hiçbir yere taşımadığı böylece
 * doğrulanır. İstemcinin kestiği bağlantılar sayılır.
 *
 * Gerçek ağ geçitleri gibi anahtarsız istek varsayılan olarak 401 alır; boş
 * olmayan her anahtar kabul edilir (`validKeys` verilirse yalnızca onlar).
 * Model listesini herkese açan ağ geçidi `publicModels` ile taklit edilir.
 *
 * Elle kabul ve yük denemeleri için tek başına da çalışır (`--serve` zorunludur;
 * test koşucusu bu dosyayı da yüklediğinde sunucu açılmaz):
 *   node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --delay-ms 20000
 *   node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --valid-key <ANAHTAR>
 * Ardından MERGEN_ROTA_AI_BASE_URL=http://127.0.0.1:8099/v1 kullanılır.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Gömme ve yeniden sıralama uçlarının varsayılan ikizi anlam çıkarmaz: değer
 * metnin özetinden (SHA-256) türetilir, belirlenimcidir ve hiçbir zaman sıfır
 * vektör değildir. Sınama anlamlı eşleme isterse `semantic` ile kendisi verir.
 */
export function hashedVector(text, dimensions = 8) {
  const digest = createHash('sha256').update(String(text)).digest();
  return Array.from({ length: dimensions }, (_, index) => (digest[index % digest.length] - 127.5) / 127.5);
}

export function hashedScore(query, document) {
  return createHash('sha256').update(`${query}\n${document}`).digest()[0] / 255;
}

const DEFAULT_SEMANTIC = Object.freeze({ embed: (text) => hashedVector(text), rerank: hashedScore });

function semanticPayload(kind, body, semantic) {
  if (kind === 'embeddings') {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    return { object: 'list', model: body?.model, data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: semantic.embed(text, body?.model, body?.embeddingTokens?.[index]) })) };
  }
  const documents = Array.isArray(body?.documents) ? body.documents : [];
  const results = documents.map((text, index) => ({ index, document: { text }, relevance_score: semantic.rerank(body?.query, text, body?.model) }))
    .sort((left, right) => right.relevance_score - left.relevance_score);
  return { id: 'rerank-fake', model: body?.model, results };
}

/**
 * vLLM 0.31.0 gömme penceresi kuralının ikizi (pooling çalıştırıcısı). Belirteç
 * sayısı yalnızca İKİZDE boşlukla bölünmüş sözcük + iki özel belirteçtir.
 * Kesme istenmemişse pencereyi aşan girdi reddedilir (`null` → 400);
 * `truncate_prompt_tokens` pencereden büyükse istek reddedilir. Varsayılan
 * belirteçleyici sağdan keserken özel belirteçleri korur; açık yön ise vLLM
 * gibi özel belirteçler eklendikten sonra diziyi keser.
 */
function applyEmbeddingWindow(body, window) {
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
  const limit = body?.truncate_prompt_tokens ?? null;
  if (limit != null && limit > window) return null;
  const kept = [];
  const embeddingTokens = [];
  for (const text of inputs) {
    const words = String(text).split(' ');
    let tokens = ['<s>', ...words, '</s>'];
    if (limit != null && tokens.length > limit) {
      tokens = body.truncation_side == null
        ? ['<s>', ...words.slice(0, limit - 2), '</s>']
        : body.truncation_side === 'left' ? tokens.slice(-limit) : tokens.slice(0, limit);
    } else if (tokens.length > window) return null;
    embeddingTokens.push(tokens);
    kept.push(tokens.filter((token) => token !== '<s>' && token !== '</s>').join(' '));
  }
  return { ...body, input: kept, embeddingTokens };
}

function json(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

function completion(model, text) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
  };
}

const CLOSED_REQUEST_WAIT_LIMIT_MS = 10000;

/** Olağan akışlı yanıt: rol, iki metin parçası, bitiş nedeni, kullanım ve `[DONE]`. */
export function sseChunksFor(model, text) {
  const half = Math.ceil(text.length / 2);
  const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  return [
    event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text.slice(0, half) } }] }),
    event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text.slice(half) } }] }),
    event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }),
    'data: [DONE]\n\n'
  ];
}

/**
 * Akışlı yanıt (`stream: true`). Parçalar ayrı yazılır; `gapMs` parçalar arası
 * beklemedir. `destroyAfter` verilen sayıda parçadan sonra soketi keser
 * (yanıt ortasında kopan bağlantı), `hangAfter` bağlantıyı açık bırakır.
 * `chunks` istek gövdesini alan bir işlev de olabilir (isteğe göre senaryo).
 */
function streamResponse(response, scenario, model, text, state, body) {
  const stream = scenario.stream || {};
  const chunks = (typeof stream.chunks === 'function' ? stream.chunks(body) : stream.chunks) ?? sseChunksFor(model, scenario.text || text);
  response.writeHead(200, {
    'content-type': stream.contentType ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache'
  });
  let index = 0;
  let timer = null;
  let serverDestroyed = false;
  const finished = () => {
    state.streamsCompleted += 1;
  };
  response.on('close', () => {
    clearTimeout(timer);
    if (!serverDestroyed && !response.writableFinished) state.streamsClosedByClient += 1;
  });
  const next = () => {
    if (response.destroyed) return;
    if (stream.destroyAfter != null && index >= stream.destroyAfter) {
      serverDestroyed = true;
      response.socket?.destroy();
      return;
    }
    if (stream.hangAfter != null && index >= stream.hangAfter) return;
    if (index >= chunks.length) {
      response.end(finished);
      return;
    }
    response.write(chunks[index]);
    index += 1;
    timer = setTimeout(next, stream.gapMs ?? 1);
  };
  next();
}

/**
 * Model listesi, depodaki kurum içi katalogun model kimliklerini de taşır:
 * bağlantı testi `chat.fast` modelinin uçta bulunduğunu doğrular ve elle kabul
 * bu sahte uçla da geçmelidir.
 */
function catalogModelIds() {
  try {
    const document = JSON.parse(readFileSync(new URL('../../config/ai-model-registry.onprem.json', import.meta.url), 'utf8'));
    return document.models.map((model) => model?.id).filter((id) => typeof id === 'string' && id);
  } catch {
    return [];
  }
}

const DEFAULT_MODELS = Object.freeze(['fake-model', ...catalogModelIds()]);

export async function startFakeOpenAiCompatibleServer({
  port = 0,
  host = '127.0.0.1',
  delayMs = 0,
  validKeys = null,
  publicModels = false,
  models = DEFAULT_MODELS,
  text = 'Merhaba, sahte ağ geçidi yanıt veriyor.',
  semantic = DEFAULT_SEMANTIC
} = {}) {
  const state = {
    scenario: null,
    requests: [],
    closedBeforeResponse: 0,
    streamsCompleted: 0,
    streamsClosedByClient: 0,
    delayMs,
    validKeys: validKeys ? new Set(validKeys) : null,
    publicModels
  };
  const sockets = new Set();

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const authorization = String(request.headers.authorization || '');
      const bearer = authorization.replace(/^Bearer\s+/i, '');
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      const entry = { method: request.method, path: request.url, bearer, body };
      state.requests.push(entry);
      const scenario = state.scenario || {};
      let answered = false;
      response.on('close', () => {
        if (!answered && !response.writableFinished) state.closedBeforeResponse += 1;
      });
      const respond = () => {
        answered = true;
        const publicList = state.publicModels && request.url.endsWith('/models');
        const accepted = publicList || (state.validKeys ? state.validKeys.has(bearer) : bearer.length > 0);
        if (!accepted) {
          json(response, 401, { error: { message: `Invalid key ${authorization}`, type: 'invalid_request_error' } });
          return;
        }
        if (scenario.status) {
          const headers = scenario.retryAfter ? { 'retry-after': String(scenario.retryAfter) } : {};
          // Gövde anahtarı bilerek yankılar.
          json(response, scenario.status, { error: { message: `Rejected ${authorization}`, code: 'fake_error' } }, headers);
          return;
        }
        if (scenario.redirect) {
          response.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
          response.end();
          return;
        }
        if (request.url.endsWith('/models')) {
          if (scenario.modelsHtml) {
            // Yanlış adrese yönelmiş ters vekilin 200 dönen varsayılan sayfası.
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<!doctype html><title>Hoş geldiniz</title>');
            return;
          }
          json(response, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
          return;
        }
        // Gömme ve Cohere/Jina uyumlu yeniden sıralama uçları; `semanticPayload` bozuk yanıt senaryosudur.
        const semanticKind = request.method !== 'POST' ? null
          : request.url.endsWith('/embeddings') ? 'embeddings' : request.url.endsWith('/rerank') ? 'rerank' : null;
        if (semanticKind && !scenario.malformed && !scenario.oversizedBytes) {
          const windowed = semanticKind === 'embeddings' && scenario.embeddingWindow ? applyEmbeddingWindow(body, scenario.embeddingWindow) : body;
          if (!windowed) {
            json(response, 400, { error: { message: `maximum context length exceeded ${authorization}`, type: 'BadRequestError' } });
            return;
          }
          json(response, 200, scenario.semanticPayload ? scenario.semanticPayload(windowed, semanticKind) : semanticPayload(semanticKind, windowed, { ...DEFAULT_SEMANTIC, ...semantic }));
          return;
        }
        if (!semanticKind && (!request.url.endsWith('/chat/completions') || request.method !== 'POST')) {
          json(response, 404, { error: { message: 'not found' } });
          return;
        }
        if (scenario.malformed) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"choices": [ bozuk');
          return;
        }
        if (scenario.missingChoices) {
          json(response, 200, { object: 'chat.completion' });
          return;
        }
        if (scenario.oversizedBytes) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(`{"padding":"${'x'.repeat(scenario.oversizedBytes)}"}`);
          return;
        }
        if (body?.stream === true && !scenario.jsonForStream) {
          streamResponse(response, scenario, body?.model || 'fake-model', text, state, body);
          return;
        }
        json(response, 200, completion(body?.model || 'fake-model', scenario.text || text));
      };
      if (scenario.stall) return;
      const wait = scenario.delayMs ?? state.delayMs;
      if (wait > 0) {
        const timer = setTimeout(respond, wait);
        response.on('close', () => clearTimeout(timer));
      } else {
        respond();
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();

  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    state,
    setScenario(scenario) {
      state.scenario = scenario || null;
    },
    /**
     * İstemci bağlantıyı kesene kadar bekler (takılı senaryo). Bekleme
     * sınırlıdır: iptal aşağı akışa ulaşmazsa test askıda kalmaz, gözlenen ve
     * beklenen sayılarla düşer.
     */
    waitForClosedRequests(count, { limitMs = CLOSED_REQUEST_WAIT_LIMIT_MS } = {}) {
      const deadline = performance.now() + limitMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (state.closedBeforeResponse >= count) return resolve();
          if (performance.now() >= deadline) {
            return reject(new Error(`Aşağı akış bağlantısı ${limitMs} ms içinde kapanmadı: kapanan ${state.closedBeforeResponse}, beklenen ${count}.`));
          }
          return setTimeout(check, 5);
        };
        check();
      });
    },
    /** İstemcinin yarıda bıraktığı akış sayısı `count`'a ulaşana kadar sınırlı bekler. */
    waitForClosedStreams(count, { limitMs = CLOSED_REQUEST_WAIT_LIMIT_MS } = {}) {
      const deadline = performance.now() + limitMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (state.streamsClosedByClient >= count) return resolve();
          if (performance.now() >= deadline) {
            return reject(new Error(`Akış ${limitMs} ms içinde istemci tarafından kapatılmadı: kapanan ${state.streamsClosedByClient}, beklenen ${count}.`));
          }
          return setTimeout(check, 5);
        };
        check();
      });
    },
    /** En az `count` istek alınana kadar sınırlı bekler. */
    waitForRequests(count, { limitMs = CLOSED_REQUEST_WAIT_LIMIT_MS } = {}) {
      const deadline = performance.now() + limitMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (state.requests.length >= count) return resolve();
          if (performance.now() >= deadline) {
            return reject(new Error(`Sahte ağ geçidi ${limitMs} ms içinde istek almadı: alınan ${state.requests.length}, beklenen ${count}.`));
          }
          return setTimeout(check, 5);
        };
        check();
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function cliOptions(argv) {
  const options = { serve: false, port: 8099, delayMs: 0, validKeys: [], publicModels: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--serve') options.serve = true;
    if (flag === '--public-models') options.publicModels = true;
    if (flag === '--port') options.port = Number(value);
    if (flag === '--delay-ms') options.delayMs = Number(value);
    if (flag === '--valid-key') options.validKeys.push(value);
  }
  return options;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && cliOptions(process.argv.slice(2)).serve) {
  const options = cliOptions(process.argv.slice(2));
  const fake = await startFakeOpenAiCompatibleServer({
    port: options.port,
    delayMs: options.delayMs,
    validKeys: options.validKeys.length ? options.validKeys : null,
    publicModels: options.publicModels
  });
  console.log(`Sahte yapay zekâ ağ geçidi: ${fake.baseUrl} (gecikme ${options.delayMs} ms)`);
}
