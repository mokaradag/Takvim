/**
 * Belirlenimci yapay zekâ sağlayıcısı ikizi (süreç içi).
 *
 * Gerçek bir dil modeli olmadan ağ geçidinin bütün yollarını sınamak için
 * sağlayıcı sözleşmesini (`chatCompletion`, `listModels`) uygular. Davranış
 * çağrı başına sıraya konur: normal yanıt, gecikmeli yanıt, takılı kalma,
 * HTTP durumu, ağ hatası, bozuk yanıt ya da testin elle çözdüğü ertelenmiş
 * yanıt. Takılı ve gecikmeli davranışlar sinyale uyar; `ignoreAbort` ile
 * sinyali yok sayan (kötü davranan) bir sağlayıcı da taklit edilir.
 *
 * Duvar saati beklenmez: testler `waitForActive()` ile çağrının gerçekten
 * sağlayıcıya ulaştığını bekler.
 */
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

registerServerOnlyShim();

const { classifyNetworkFailure, classifyProviderStatus, parseChatCompletion } = await import('../../src/server/ai/providers/openAiCompatibleProvider.js');

function chatResult(text, model) {
  return parseChatCompletion({
    model,
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  });
}

export function createFakeAiProvider({ defaultText = 'Merhaba, bağlantı çalışıyor.' } = {}) {
  const calls = [];
  const queue = [];
  const active = new Set();
  const listeners = new Set();
  let peakActive = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function waitFor(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = () => {
        if (!predicate()) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
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
        return Promise.resolve(call.kind === 'models' ? { status: 200 } : chatResult(behavior.text ?? defaultText, model));
      case 'status':
        if (call.kind === 'models') return Promise.resolve({ status: behavior.status });
        return Promise.reject(classifyProviderStatus(behavior.status, behavior.retryAfter ?? null));
      case 'network':
        return Promise.reject(classifyNetworkFailure({ cause: { code: behavior.code } }));
      case 'malformed':
        return Promise.resolve().then(() => parseChatCompletion({ choices: [] }));
      case 'delay': {
        let timer;
        return abortable(signal, call, {
          start: (resolve) => { timer = setTimeout(() => resolve(chatResult(behavior.text ?? defaultText, model)), behavior.ms); },
          cancel: () => clearTimeout(timer)
        });
      }
      case 'stall':
        return abortable(signal, call, { start: () => {} });
      case 'deferred':
        return new Promise((resolve, reject) => {
          call.resolve = (text = defaultText) => resolve(call.kind === 'models' ? { status: 200 } : chatResult(text, model));
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
    const behavior = queue.shift() || { type: 'reply' };
    const call = {
      kind,
      model: input.model ?? null,
      apiKey: input.apiKey ?? null,
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
      return waitFor(() => active.size >= count);
    },
    waitForCalls(count) {
      return waitFor(() => calls.length >= count);
    },
    chatCompletion(input) {
      return execute('chat', input);
    },
    listModels(input) {
      return execute('models', input);
    }
  };
}
