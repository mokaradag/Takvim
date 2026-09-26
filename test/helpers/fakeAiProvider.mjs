/**
 * Belirlenimci yapay zekâ sağlayıcısı ikizi (süreç içi).
 *
 * Gerçek bir dil modeli olmadan ağ geçidinin bütün yollarını sınamak için
 * sağlayıcı sözleşmesini (`chatCompletion`, `listModels`) uygular. Davranış
 * çağrı başına sıraya konur: normal yanıt, gecikmeli yanıt, takılı kalma,
 * HTTP durumu, ağ hatası, bozuk yanıt, metinsiz yanıt ya da testin elle
 * çözdüğü ertelenmiş yanıt. Takılı ve gecikmeli davranışlar sinyale uyar;
 * `ignoreAbort` ile sinyali yok sayan (kötü davranan) bir sağlayıcı da
 * taklit edilir. Sırada davranış yoksa anahtarsız ya da denetim anahtarıyla
 * (hiçbir hesaba ait olmayan rastgele anahtar) istenen model listesi 401 döner.
 * Başarılı model listesi, gerçek bağdaştırıcı gibi model kimliklerini taşır
 * (varsayılan olarak depo içindeki varsayılan kaydın modelleri).
 *
 * Akışlı sohbet (`streamChatCompletion`) aynı sırayı kullanır: parça parça
 * yanıt (`stream`), akıl yürütme evresi, ilk parçadan sonra kopan akış
 * (`interrupt`) ya da testin parçaları elle ilettiği ve bitirdiği akış
 * (`deferred-stream`). Akış tüketici bırakana ya da iptal edilene kadar
 * çağrı etkin sayılır.
 *
 * Duvar saati beklenmez: testler `waitForActive()` ile çağrının gerçekten
 * sağlayıcıya ulaştığını bekler. Bekleme yine de SINIRLIDIR: istek sağlayıcıya
 * hiç ulaşmazsa (tam da iptal testlerinin yakalaması gereken gerileme) test
 * askıda kalmaz, açıklayıcı bir hatayla düşer. Sınır, sahte saatten etkilenmeyen
 * gerçek zamanlayıcıyla ölçülür.
 */
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

registerServerOnlyShim();

const {
  AI_CONTROL_KEY_PREFIX,
  classifyNetworkFailure,
  classifyProviderStatus,
  parseChatCompletion,
  streamInterrupted
} = await import('../../src/server/ai/providers/openAiCompatibleProvider.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../../src/server/ai/defaultModelRegistry.js');

// Testler `t.mock.timers` ile setTimeout'u değiştirse de bekleme sınırı işler.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const WAIT_LIMIT_MS = 10000;
const DEFAULT_MODELS = Object.freeze(DEFAULT_AI_MODEL_REGISTRY.models.map((model) => model.id));

function chatResult(text, model) {
  return parseChatCompletion({
    model,
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  });
}

export function createFakeAiProvider({ defaultText = 'Merhaba, bağlantı çalışıyor.', models = DEFAULT_MODELS } = {}) {
  const calls = [];
  const queue = [];
  const active = new Set();
  const listeners = new Set();
  let peakActive = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function waitFor(predicate, description) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = realSetTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Sahte sağlayıcı ${WAIT_LIMIT_MS} ms içinde beklenen duruma ulaşmadı: ${description} (çağrı ${calls.length}, etkin ${active.size}).`));
      }, WAIT_LIMIT_MS);
      timer.unref?.();
      const listener = () => {
        if (!predicate()) return;
        listeners.delete(listener);
        realClearTimeout(timer);
        resolve();
      };
      listeners.add(listener);
    });
  }

  const modelList = (behavior = {}) => ({ status: 200, retryAfter: null, models: [...(behavior.models ?? models)] });

  function abortable(signal, call, work) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        call.aborted = true;
        work.cancel?.();
        reject(signal.reason);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      work.start((value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function run(behavior, call, input) {
    const { signal, model } = input;
    switch (behavior.type) {
      case 'reply':
        return Promise.resolve(call.kind === 'models' ? modelList(behavior) : chatResult(behavior.text ?? defaultText, model));
      case 'empty':
        // Araç istenmemiş sohbette metin taşımayan (`content: null`) yanıt.
        return Promise.resolve(parseChatCompletion({ model, choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }));
      case 'status':
        if (call.kind === 'models') return Promise.resolve({ status: behavior.status, retryAfter: behavior.retryAfter ?? null });
        return Promise.reject(classifyProviderStatus(behavior.status, behavior.retryAfter ?? null));
      case 'network':
        return Promise.reject(classifyNetworkFailure({ cause: { code: behavior.code } }));
      case 'malformed':
        return Promise.resolve().then(() => parseChatCompletion({ choices: [] }));
      case 'delay': {
        let timer;
        return abortable(signal, call, {
          // Gecikmeli model listesi de model listesi sonucu döner (sohbet sonucu değil).
          start: (resolve) => {
            timer = setTimeout(() => resolve(call.kind === 'models' ? modelList(behavior) : chatResult(behavior.text ?? defaultText, model)), behavior.ms);
          },
          cancel: () => clearTimeout(timer)
        });
      }
      case 'stall':
        return abortable(signal, call, { start: () => {} });
      case 'deferred':
        return new Promise((resolve, reject) => {
          call.resolve = (text = defaultText) => resolve(call.kind === 'models' ? modelList(behavior) : chatResult(text, model));
          call.reject = reject;
          if (!behavior.ignoreAbort) {
            signal?.addEventListener('abort', () => {
              call.aborted = true;
              reject(signal.reason);
            }, { once: true });
          }
        });
      default:
        return Promise.reject(new Error(`Tanınmayan sahte davranış: ${behavior.type}`));
    }
  }

  async function execute(kind, input) {
    // Gerçek ağ geçitleri gibi anahtarsız ya da geçersiz anahtarlı model listesi
    // varsayılan olarak 401 döner.
    const rejectedKey = !input.apiKey || String(input.apiKey).startsWith(AI_CONTROL_KEY_PREFIX);
    const fallback = kind === 'models' && rejectedKey ? { type: 'status', status: 401 } : { type: 'reply' };
    const behavior = queue.shift() || fallback;
    const call = {
      kind,
      model: input.model ?? null,
      apiKey: input.apiKey ?? null,
      // Doğrulamanın denetim isteği (rastgele, geçersiz anahtar).
      control: String(input.apiKey ?? '').startsWith(AI_CONTROL_KEY_PREFIX),
      baseUrl: input.baseUrl,
      messages: input.messages ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      signal: input.signal ?? null,
      aborted: false,
      settled: false
    };
    calls.push(call);
    active.add(call);
    peakActive = Math.max(peakActive, active.size);
    notify();
    try {
      return await run(behavior, call, input);
    } finally {
      call.settled = true;
      active.delete(call);
      notify();
    }
  }

  /**
   * Akış olay kuyruğu. Sinyal kesilince bekleyen okuma `signal.reason` ile
   * reddedilir (gerçek bağdaştırıcı gibi); `ignoreAbort` verilirse sinyale uymayan
   * bir sağlayıcı taklit edilir. Akış bitince (tamamlanma, hata, iptal ya da
   * tüketicinin bırakması) çağrı etkin sayılmaz.
   */
  function createFeed(signal, call, { ignoreAbort = false } = {}) {
    const items = [];
    let wake = null;
    const push = (item) => {
      items.push(item);
      const resume = wake;
      wake = null;
      resume?.();
    };
    const onAbort = () => {
      call.aborted = true;
      if (!ignoreAbort) push({ error: signal.reason });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    async function* iterate() {
      try {
        for (;;) {
          while (!items.length) await new Promise((resolve) => { wake = resolve; });
          const item = items.shift();
          if (item.error) throw item.error;
          if (item.end) return;
          call.emitted.push(item.event);
          yield item.event;
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        call.streamClosed = true;
      }
    }
    return {
      push,
      text: (text) => push({ event: { type: 'text', text } }),
      reasoning: () => push({ event: { type: 'reasoning' } }),
      done: ({ finishReason = 'stop', model = call.model, usage = null } = {}) => {
        push({ event: { type: 'done', finishReason, model, usage } });
        push({ end: true });
      },
      fail: (error) => push({ error }),
      iterate
    };
  }

  function openStream(behavior, call, input) {
    const { signal } = input;
    switch (behavior.type) {
      case 'status':
        return Promise.reject(classifyProviderStatus(behavior.status, behavior.retryAfter ?? null));
      case 'network':
        return Promise.reject(classifyNetworkFailure({ cause: { code: behavior.code } }));
      case 'stall':
        return abortable(signal, call, { start: () => {} });
      default:
        break;
    }
    const feed = createFeed(signal, call, { ignoreAbort: behavior.ignoreAbort });
    if (behavior.type === 'deferred-stream') {
      call.emit = feed.text;
      call.think = feed.reasoning;
      call.complete = feed.done;
      call.fail = feed.fail;
    } else if (behavior.type === 'reply' || behavior.type === 'stream' || behavior.type === 'interrupt') {
      const text = behavior.text ?? defaultText;
      const chunks = behavior.chunks ?? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
      for (let index = 0; index < (behavior.reasoning ?? 0); index += 1) feed.reasoning();
      for (const chunk of chunks) feed.text(chunk);
      if (behavior.type === 'interrupt') feed.fail(streamInterrupted());
      else feed.done({ finishReason: behavior.finishReason ?? 'stop', model: behavior.model === undefined ? input.model : behavior.model });
    } else {
      return Promise.reject(new Error(`Tanınmayan sahte akış davranışı: ${behavior.type}`));
    }
    return Promise.resolve({ events: feed.iterate() });
  }

  async function executeStream(input) {
    const behavior = queue.shift() || { type: 'reply' };
    const call = {
      kind: 'stream',
      model: input.model ?? null,
      apiKey: input.apiKey ?? null,
      control: false,
      baseUrl: input.baseUrl,
      messages: input.messages ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      signal: input.signal ?? null,
      aborted: false,
      settled: false,
      streamClosed: false,
      emitted: []
    };
    calls.push(call);
    active.add(call);
    peakActive = Math.max(peakActive, active.size);
    notify();
    const settle = () => {
      if (call.settled) return;
      call.settled = true;
      active.delete(call);
      notify();
    };
    try {
      const opened = await openStream(behavior, call, input);
      return {
        events: (async function* tracked() {
          try {
            yield* opened.events;
          } finally {
            settle();
          }
        })()
      };
    } catch (error) {
      settle();
      throw error;
    }
  }

  return {
    calls,
    get activeCount() { return active.size; },
    get peakActive() { return peakActive; },
    /** Sonraki çağrıların davranışını sıraya koyar. */
    enqueue(...behaviors) {
      queue.push(...behaviors);
      return this;
    },
    waitForActive(count) {
      return waitFor(() => active.size >= count, `${count} etkin çağrı`);
    },
    waitForCalls(count) {
      return waitFor(() => calls.length >= count, `${count} çağrı`);
    },
    chatCompletion(input) {
      return execute('chat', input);
    },
    streamChatCompletion(input) {
      return executeStream(input);
    },
    listModels(input) {
      return execute('models', input);
    }
  };
}
