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
  let abortCause = signal?.aborted ? 'caller' : null;
  const abortFromCaller = () => {
    if (!abortCause) abortCause = 'caller';
    controller?.abort();
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = controller ? setTimeout(() => {
    if (abortCause) return;
    abortCause = 'timeout';
    controller.abort();
  }, timeoutMs) : null;
  const requestSignal = controller?.signal || signal || undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  };
  const connectionFailure = () => abortCause === 'timeout'
    ? { ok: false, code: 'REQUEST_TIMEOUT', message: 'REQUEST_TIMEOUT: Sunucu yanıtı süre sınırında alınamadı. İşlem sonucu henüz doğrulanmadı.' }
    : abortCause === 'caller'
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

  // KESİLEN gövde, boş gövdeden ayrılır: yalnızca ayrıştırmayı gerçekten
  // AbortError ile kesen durum iptal/süre aşımıdır. Sinyalin aynı anda başka
  // bir nedenle kesilmesi, tamamlanmış ama bozuk JSON gövdesini yanlışlıkla
  // REQUEST_CANCELLED/REQUEST_TIMEOUT olarak sınıflandırmamalıdır.
  let body;
  try {
    body = await response.json();
  } catch (error) {
    // Sinyalin kesilmiş olması tek başına yeterli değildir: aynı anda oluşan
    // SyntaxError tamamlanmış ama bozuk bir gövdedir. Yalnız gerçek AbortError
    // bağlantı/iptal sonucu olarak sınıflandırılır.
    if (controller?.signal.aborted) {
      if (error?.name === 'AbortError') return connectionFailure();
    }
    if (error?.name === 'AbortError') return connectionFailure();
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
