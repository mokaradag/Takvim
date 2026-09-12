import { publicRotaPath } from '../../lib/publicPath.js';
import { outlookFailureMessage, safeOutlookFailureCode } from '../../domain/outlook/outlookFailures.js';

/**
 * MERGEN Rota uçlarının ortak istemci sarmalayıcısı.
 *
 * İstek SÜRESİ SINIRLIDIR.
 *
 * Fetch'in kendiliğinden bir zaman aşımı yoktur: bağlantıyı kabul edip yanıt
 * göndermeyen (ya da başlıkları gönderip gövdeyi askıda bırakan) bir uç,
 * eylemi tetikleyen düğmeyi kalıcı olarak devre dışı bırakıyordu. Sayaç GÖVDE
 * OKUNANA kadar açık tutulur; süre aşımı, çağıran iptali ve ağ hatası ayrı
 * sonuçlar olarak bildirilir.
 */
export const REQUEST_TIMEOUT_MS = 30000;

export async function requestJson(path, init, { timeoutMs = REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const abortable = typeof AbortController === 'function';
  const controller = abortable ? new AbortController() : null;
  let timedOut = false;
  let cancelledByCaller = Boolean(signal?.aborted);
  const abortFromCaller = () => {
    cancelledByCaller = true;
    controller?.abort();
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const requestSignal = controller?.signal || signal || undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  };
  const connectionFailure = () => timedOut
    ? { ok: false, code: 'REQUEST_TIMEOUT', message: 'REQUEST_TIMEOUT: Sunucu yanıtı süre sınırında alınamadı. İşlem sonucu henüz doğrulanmadı.' }
    : cancelledByCaller
      ? { ok: false, code: 'REQUEST_CANCELLED', message: 'İstek iptal edildi.' }
      : { ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' };

  let response;
  try {
    response = await fetch(publicRotaPath(path), {
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...init,
      ...(requestSignal ? { signal: requestSignal } : {})
    });
  } catch {
    cleanup();
    return connectionFailure();
  }

  // KESİLEN gövde, boş gövdeden ayrılır: süre aşımı ayrı bildirilir, ayrıştırıla-
  // mayan ama tamamlanmış bir gövde ise boş nesnedir (durum kodu eşlemesi korunur).
  // Tek bir `.catch(() => ({}))` ikisini birleştirip zaman aşımına uğramış bir
  // yanıtı başarılı boş yanıt gibi gösteriyordu.
  let body;
  try {
    body = await response.json();
  } catch {
    if (controller?.signal.aborted) {
      cleanup();
      return connectionFailure();
    }
    if (signal?.aborted) {
      cleanup();
      return connectionFailure();
    }
    body = {};
  } finally {
    cleanup();
  }
  if (!response.ok) {
    return {
      ...body,
      ok: false,
      code: body?.error?.code || body?.code || safeOutlookFailureCode(body?.outlook?.reason || body?.reason, 'REQUEST_FAILED'),
      message: body?.error?.message || body?.message
        || (safeOutlookFailureCode(body?.outlook?.reason || body?.reason, null)
          ? outlookFailureMessage(body?.outlook?.reason || body?.reason) : 'İşlem tamamlanamadı.')
    };
  }
  return { ok: true, ...body };
}
