import { publicRotaPath } from '../../lib/publicPath.js';

export const ACTUAL_AUTH_STATUS_ENDPOINT = publicRotaPath('/api/mergen-rota/auth/status');
export const ACTUAL_AUTH_LOGIN_ENDPOINT = publicRotaPath('/api/mergen-rota/auth/login');
export const ACTUAL_APP_ROOT = publicRotaPath('/');

export function corporateLoginHref(returnTo = ACTUAL_APP_ROOT) {
  return `${ACTUAL_AUTH_LOGIN_ENDPOINT}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Kurumsal oturum durumu isteğinin en fazla bekleme süresi (ms). */
export const CORPORATE_SESSION_TIMEOUT_MS = 15000;

/**
 * Kurumsal oturum var mı?
 *
 * İsteğin KENDİ süre sınırı vardır. Çağıran (`CorporateSessionGate`) yalnızca
 * bileşen sökülürken iptal eden bir `signal` verir ve hiç sayaç kurmaz;
 * bağlantıyı kabul edip yanıt göndermeyen bir uç, kapıyı sonsuza dek
 * `checking` durumunda bırakıyordu. O durumda ekranda yalnızca ilerleme çubuğu
 * çizilir: "Yeniden Dene" ve "Demo moduna geç" düğmeleri YALNIZCA `error`
 * durumunda görünür, yani kullanıcının ne yeniden deneme ne de demo kipine
 * geçme yolu kalıyordu.
 */
export async function hasCorporateSession({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = CORPORATE_SESSION_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Kurumsal oturum denetimi için fetch gereklidir.');
  }

  const abortable = typeof AbortController === 'function';
  const controller = abortable ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(new Error('Kurumsal oturum durumu zaman aşımına uğradı.')), timeoutMs)
    : null;
  // Çağıranın iptali de aynı denetleyiciye bağlanır: sökülme yine iptal eder.
  //
  // Dinleyici İSTEK BİTİNCE sökülür. `{ once: true }` yalnızca iptal GERÇEKLEŞİRSE
  // temizler; istek olağan biçimde tamamlandığında dinleyici çağıranın bileşen
  // ömrü boyunca yaşayan `signal` üzerinde kalıyor ve her "Yeniden Dene" yeni bir
  // denetleyiciyi sökülmeye kadar canlı tutuyordu.
  let detachCallerAbort = null;
  if (controller && signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const onCallerAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onCallerAbort, { once: true });
      detachCallerAbort = () => signal.removeEventListener('abort', onCallerAbort);
    }
  }

  let response;
  let payload;
  try {
    response = await fetchImpl(ACTUAL_AUTH_STATUS_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller ? controller.signal : signal
    });
    // Gövde okuması da sayaç kapsamındadır: başlıklar gelip gövde askıda
    // kalırsa istek yine sonlanmalıdır.
    //
    // İPTAL hatası YUTULMAZ. Yutulsaydı, 200 başlık gönderip gövdeyi askıda
    // bırakan bir uçta sayaç denetleyiciyi iptal eder, `json()` reddeder,
    // `payload` boş nesneye düşer ve `response.ok` doğru olduğu için işlev
    // `false` dönerdi: kimliği doğrulanmış kullanıcı OTURUMU YOK sayılıp
    // kurumsal girişe yönlendirilirdi. Yalnızca gerçek çözümleme hataları
    // boş gövdeye indirgenir.
    payload = await response.json().catch((cause) => {
      if (controller?.signal.aborted) throw controller.signal.reason ?? cause;
      return {};
    });
  } finally {
    if (timer) clearTimeout(timer);
    detachCallerAbort?.();
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Kurumsal oturum durumu alınamadı.');
    error.code = payload?.error?.code || 'AUTH_STATUS_FAILED';
    throw error;
  }

  return payload?.authenticated === true;
}
