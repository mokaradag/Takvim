/**
 * Canlı nitelendirme sınamalarında alt sürece `node --import` ile yüklenen,
 * tek ve belirlenimci bir `fetch` arızası. Üretim kodu değişmez; arıza gerçek
 * bağdaştırıcının çağırdığı küresel `fetch` üzerinde oluşur.
 *
 *   ROTA_TEST_FETCH_FAULT=refuse-first
 *     İlk istek bağlantı kurulamamış gibi düşer (`ECONNREFUSED`): ağ geçidi
 *     isteği bir kez yineler ve yinelemeyi günlüğe yazar.
 *   ROTA_TEST_FETCH_FAULT=delay-first-rerank:<ms>
 *     İlk `/rerank` isteği bu kadar bekletilir (iptale uyar).
 */
const [kind, value] = String(process.env.ROTA_TEST_FETCH_FAULT ?? '').split(':');
const realFetch = globalThis.fetch;
let used = false;

function refused() {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

globalThis.fetch = async (url, init = {}) => {
  if (!used && kind === 'refuse-first') {
    used = true;
    throw refused();
  }
  if (!used && kind === 'delay-first-rerank' && String(url).endsWith('/rerank')) {
    used = true;
    await wait(Number(value), init.signal);
  }
  return realFetch(url, init);
};
