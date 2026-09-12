import 'server-only';

/**
 * Sağlık yoklamalarının süre sınırı.
 *
 * Yönetim konsolu on saniyede bir yenilenir; tek bir yanıt vermeyen bağımlılık
 * bütün yanıtı askıda bırakmamalıdır. Yoklamalar bu yüzden kendi süre
 * bütçeleriyle çalışır ve süre dolduğunda "bilinmiyor" olarak bildirilir —
 * "sağlıklı" olarak DEĞİL.
 */

export const PROBE_TIMEOUT_MS = 4000;

export function probeDeadline(timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PROBE_TIMEOUT')), Math.max(250, Number(timeoutMs) || PROBE_TIMEOUT_MS));
  timer.unref?.();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function raceWithSignal(operation, signal, cancel = () => {}) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => { try { cancel(); } finally { reject(signal.reason); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Verilen yürütücünün sorgularını süre sınırına bağlar. */
export function boundedExecutor(executor, signal) {
  return {
    request() {
      const request = executor.request();
      const query = request.query.bind(request);
      request.query = (text) => raceWithSignal(() => query(text), signal, () => request.cancel?.());
      return request;
    }
  };
}

/** Bir yoklamayı süre sınırıyla çalıştırır; süre dolarsa `PROBE_TIMEOUT` fırlatır. */
export async function withProbeDeadline(work, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = probeDeadline(timeoutMs);
  try {
    return await raceWithSignal(() => work(boundedExecutor, deadline.signal), deadline.signal);
  } finally {
    deadline.close();
  }
}
