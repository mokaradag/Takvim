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
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

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
  text = 'Merhaba, sahte ağ geçidi yanıt veriyor.'
} = {}) {
  const state = {
    scenario: null,
    requests: [],
    closedBeforeResponse: 0,
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
        if (!request.url.endsWith('/chat/completions') || request.method !== 'POST') {
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
      const deadline = Date.now() + limitMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (state.closedBeforeResponse >= count) return resolve();
          if (Date.now() >= deadline) {
            return reject(new Error(`Aşağı akış bağlantısı ${limitMs} ms içinde kapanmadı: kapanan ${state.closedBeforeResponse}, beklenen ${count}.`));
          }
          return setTimeout(check, 5);
        };
        check();
      });
    },
    /** En az `count` istek alınana kadar sınırlı bekler. */
    waitForRequests(count, { limitMs = CLOSED_REQUEST_WAIT_LIMIT_MS } = {}) {
      const deadline = Date.now() + limitMs;
      return new Promise((resolve, reject) => {
        const check = () => {
          if (state.requests.length >= count) return resolve();
          if (Date.now() >= deadline) {
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
