import { nativeDeclaration } from './evidenceScenario.mjs';
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
import { hashedScore, hashedVector } from './fakeOpenAiCompatibleServer.mjs';
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

registerServerOnlyShim();

const {
  AI_CONTROL_KEY_PREFIX,
  classifyNetworkFailure,
  classifyProviderStatus,
  parseChatCompletion,
  parseEmbeddingResponse,
  parseRerankResponse,
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

/**
 * Gömme (`embeddings`) ve yeniden sıralama (`rerank`) çağrıları da aynı sırayı
 * kullanır. Yanıt gerçek bağdaştırıcının ayrıştırıcısından geçer: `reply`
 * `embed(metin, model)` / `rerank(sorgu, belge, model)` eşlemesinden tel biçimi
 * kurar, `{ type: 'reply', payload }` ham (bozuk olabilir) yanıtı ayrıştırır,
 * `model` sağlayıcının bildirdiği modeli değiştirir. Varsayılan eşleme anlam
 * çıkarmaz (metnin özetinden türetilir).
 */
export function createFakeAiProvider({
  defaultText = 'Merhaba, bağlantı çalışıyor.',
  models = DEFAULT_MODELS,
  embed = (text) => hashedVector(text),
  rerank = hashedScore,
  // Sırada davranış yoksa çağrıya göre davranış seçer (ör. yalnızca katalog gömmesini bekletmek); `null` olağan yanıttır.
  respond = null,
  // Gömme ve yeniden sıralama çağrıları ortak sırayı tüketir mi? Kapalıyken (kanıta dayalı tur yığını) yalnızca
  // `kind: 'embeddings' | 'rerank'` ile işaretlenmiş davranışları alır; Aşama 4C'nin planlama öncesi keşfi sohbet
  // turu için sıraya konmuş davranışları tüketmez.
  semanticQueue = true
} = {}) {
  const calls = [];
  const semanticCalls = [];
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
  const reportedModel = (behavior, input) => (behavior.model === undefined ? input.model : behavior.model);

  function resultOf(kind, behavior, input, text = behavior.text ?? defaultText) {
    if (kind === 'models') return modelList(behavior);
    if (kind === 'embeddings') {
      return parseEmbeddingResponse(behavior.payload ?? {
        model: reportedModel(behavior, input),
        data: input.input.map((value, index) => ({ index, embedding: embed(value, input.model) }))
      });
    }
    if (kind === 'rerank') {
      return parseRerankResponse(behavior.payload ?? {
        model: reportedModel(behavior, input),
        results: input.documents.map((document, index) => ({ index, relevance_score: rerank(input.query, document, input.model) }))
      });
    }
    return chatResult(text, input.model);
  }

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
        return Promise.resolve().then(() => resultOf(call.kind, behavior, input));
      case 'empty':
        // Araç istenmemiş sohbette metin taşımayan (`content: null`) yanıt.
        return Promise.resolve(parseChatCompletion({ model, choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }));
      case 'status':
        if (call.kind === 'models') return Promise.resolve({ status: behavior.status, retryAfter: behavior.retryAfter ?? null });
        return Promise.reject(classifyProviderStatus(behavior.status, behavior.retryAfter ?? null));
      case 'network':
        return Promise.reject(classifyNetworkFailure({ cause: { code: behavior.code } }));
      case 'malformed':
        return Promise.resolve().then(() => (call.kind === 'embeddings' || call.kind === 'rerank'
          ? resultOf(call.kind, { payload: {} }, input) : parseChatCompletion({ choices: [] })));
      case 'delay': {
        let timer;
        return abortable(signal, call, {
          // Gecikmeli çağrı da kendi türünün sonucunu döner (model listesi, gömme, skor ya da sohbet).
          start: (resolve, reject) => {
            timer = setTimeout(() => {
              try { resolve(resultOf(call.kind, behavior, input)); } catch (error) { reject(error); }
            }, behavior.ms);
          },
          cancel: () => clearTimeout(timer)
        });
      }
      case 'stall':
        return abortable(signal, call, { start: () => {} });
      case 'deferred':
        return new Promise((resolve, reject) => {
          call.resolve = (text = defaultText) => {
            try { resolve(resultOf(call.kind, behavior, input, text)); } catch (error) { reject(error); }
          };
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

  /** Çağrı türünün sıradaki davranışı: işaretsiz davranış her türe, `kind` ile işaretli davranış yalnızca o türe gider. */
  function take(kind) {
    const semantic = kind === 'embeddings' || kind === 'rerank';
    const index = !semantic || semanticQueue ? queue.findIndex((item) => !item.kind || item.kind === kind) : queue.findIndex((item) => item.kind === kind);
    return index >= 0 ? queue.splice(index, 1)[0] : null;
  }

  async function execute(kind, input) {
    // Gerçek ağ geçitleri gibi anahtarsız ya da geçersiz anahtarlı model listesi
    // varsayılan olarak 401 döner.
    const rejectedKey = !input.apiKey || String(input.apiKey).startsWith(AI_CONTROL_KEY_PREFIX);
    const fallback = kind === 'models' && rejectedKey ? { type: 'status', status: 401 } : { type: 'reply' };
    const call = {
      kind,
      model: input.model ?? null,
      apiKey: input.apiKey ?? null,
      // Doğrulamanın denetim isteği (rastgele, geçersiz anahtar).
      control: String(input.apiKey ?? '').startsWith(AI_CONTROL_KEY_PREFIX),
      baseUrl: input.baseUrl,
      messages: input.messages ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      input: input.input ?? null,
      truncateTokens: input.truncateTokens ?? null,
      query: input.query ?? null,
      documents: input.documents ?? null,
      signal: input.signal ?? null,
      aborted: false,
      settled: false
    };
    const behavior = take(kind) || respond?.(call) || fallback;
    // Ortak sıra dışındaki planlama öncesi keşif sohbet çağrılarının sayımını ve sırasını değiştirmez.
    const hidden = !semanticQueue && (kind === 'embeddings' || kind === 'rerank');
    (hidden ? semanticCalls : calls).push(call);
    if (!hidden) {
      active.add(call);
      peakActive = Math.max(peakActive, active.size);
      notify();
    }
    try {
      return await run(behavior, call, input);
    } finally {
      call.settled = true;
      if (!hidden) {
        active.delete(call);
        notify();
      }
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
      done: ({ finishReason = 'stop', model = call.model, usage = null, toolCalls = [] } = {}) => {
        push({ event: { type: 'done', finishReason, model, usage, toolCalls } });
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
      call.emitPlan = (arguments_) => {
        feed.push({ event: { type: 'tool_call_started' } });
        feed.done({ finishReason: 'tool_calls', toolCalls: [{ id: 'native_plan', name: 'rota_plan', arguments: JSON.stringify(arguments_) }] });
      };
      call.think = feed.reasoning;
      call.complete = feed.done;
      call.fail = feed.fail;
    } else if (behavior.type === 'reply' || behavior.type === 'stream' || behavior.type === 'interrupt') {
      const text = behavior.text ?? defaultText;
      const chunks = behavior.chunks ?? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
      for (let index = 0; index < (behavior.reasoning ?? 0); index += 1) feed.reasoning();
      for (const chunk of chunks) feed.text(chunk);
      if (behavior.type === 'interrupt') feed.fail(streamInterrupted());
      else feed.done({ finishReason: behavior.finishReason ?? 'stop', model: behavior.model === undefined ? input.model : behavior.model, usage: behavior.usage ?? null });
    } else {
      return Promise.reject(new Error(`Tanınmayan sahte akış davranışı: ${behavior.type}`));
    }
    return Promise.resolve({ events: feed.iterate() });
  }

  async function executeStream(input) {
    const behavior = take('chat') || { type: 'reply' };
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

  /**
   * Araçlı model turu (`streamToolCompletion`). Davranışlar:
   *  - `{ type: 'tool-calls', calls: [{ name, arguments, id? }], preface?: [metin parçaları] }`
   *  - `{ type: 'answer', text, chunks? }` (ya da `reply` / `stream`)
   *  - `native: true`: gerçek modelin metni ve araç çağrıları dönüştürülmez.
   *  - `{ type: 'script', respond: (call) => davranış }` — isteğin iletilerine
   *    (araç sonuçları, kanıt kimlikleri) bakarak yanıt kuran senaryo
   *  - `status`, `network`, `stall`, `deferred-stream`, `interrupt` akışlı sohbetle aynı.
   */
  function openToolStream(behavior, call, input) {
    let resolved = behavior.type === 'script' ? (behavior.respond(call) || { type: 'answer', text: '' }) : behavior;
    if (!resolved.native && ['answer', 'reply', 'stream', 'tool-calls'].includes(resolved.type) && resolved.finishReason !== 'length'
      && resolved.chunks === undefined) {
      const native = nativeDeclaration({ text: resolved.type === 'tool-calls' ? (resolved.preface || []).join('') : resolved.text, toolCalls: resolved.calls || [] });
      if (native.toolCalls.some((tool) => tool.name === 'rota_plan')) {
        resolved = { ...resolved, type: 'tool-calls', preface: native.text === '' ? [] : resolved.preface || [], calls: native.toolCalls };
      }
    }
    call.behavior = resolved.type;
    if (resolved.type === 'tool-calls') {
      const feed = createFeed(input.signal, call, { ignoreAbort: resolved.ignoreAbort });
      for (let index = 0; index < (resolved.reasoning ?? 0); index += 1) feed.reasoning();
      for (const chunk of resolved.preface ?? []) feed.text(chunk);
      const toolCalls = resolved.calls.map((entry, index) => ({
        id: entry.id ?? `call_${call.index}_${index + 1}`,
        name: entry.name,
        arguments: typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments ?? {}),
        oversize: Boolean(entry.oversize)
      }));
      for (let index = 0; index < toolCalls.length; index += 1) feed.push({ event: { type: 'tool_call_started' } });
      feed.push({ event: { type: 'done', finishReason: resolved.finishReason ?? 'tool_calls',
        model: resolved.model === undefined ? input.model : resolved.model, usage: resolved.usage ?? null, toolCalls } });
      feed.push({ end: true });
      return Promise.resolve({ events: feed.iterate() });
    }
    const normalized = resolved.type === 'answer' ? { ...resolved, type: 'stream' } : resolved;
    return openStream(normalized, call, input);
  }

  async function executeToolStream(input) {
    const behavior = take('chat') || { type: 'reply' };
    const call = {
      kind: 'tools',
      index: calls.length + 1,
      model: input.model ?? null,
      apiKey: input.apiKey ?? null,
      control: false,
      baseUrl: input.baseUrl,
      messages: input.messages ?? null,
      tools: input.tools ?? [],
      toolChoice: input.toolChoice ?? null,
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
      const opened = await openToolStream(behavior, call, input);
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
    /** Ortak sırayı kullanmayan (semanticQueue: false) gömme ve yeniden sıralama çağrıları. */
    semanticCalls,
    get pendingCount() { return queue.length; },
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
    streamToolCompletion(input) {
      return executeToolStream(input);
    },
    listModels(input) {
      return execute('models', input);
    },
    embeddings(input) {
      return execute('embeddings', input);
    },
    rerank(input) {
      return execute('rerank', input);
    }
  };
}
