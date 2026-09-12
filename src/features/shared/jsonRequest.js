import { publicRotaPath } from '../../lib/publicPath.js';

/**
 * MERGEN Rota uçlarının ortak istemci sarmalayıcısı.
 *
 * İstek SÜRESİ SINIRLIDIR.
 *
 * Fetch'in kendiliğinden bir zaman aşımı yoktur: bağlantıyı kabul edip yanıt
 * göndermeyen (ya da başlıkları gönderip gövdeyi askıda bırakan) bir uç,
 * eylemi tetikleyen düğmeyi kalıcı olarak devre dışı bırakıyordu. Sayaç GÖVDE
 * OKUNANA kadar açık tutulur; iptal edilen istek ağ hatası biçimine çevrilir.
 */
export const REQUEST_TIMEOUT_MS = 30000;

export async function requestJson(path, init, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const abortable = typeof AbortController === 'function';
  const controller = abortable ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(publicRotaPath(path), {
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...init,
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch {
    if (timer) clearTimeout(timer);
    return { ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' };
  }

  // KESİLEN gövde, boş gövdeden ayrılır: iptal `NETWORK` hatasıdır, ayrıştırıla-
  // mayan ama tamamlanmış bir gövde ise boş nesnedir (durum kodu eşlemesi korunur).
  // Tek bir `.catch(() => ({}))` ikisini birleştirip zaman aşımına uğramış bir
  // yanıtı başarılı boş yanıt gibi gösteriyordu.
  let body;
  try {
    body = await response.json();
  } catch {
    if (controller?.signal.aborted) {
      if (timer) clearTimeout(timer);
      return { ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' };
    }
    body = {};
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    return {
      ...body,
      ok: false,
      code: body?.error?.code || 'REQUEST_FAILED',
      message: body?.error?.message || 'İşlem tamamlanamadı.'
    };
  }
  return { ok: true, ...body };
}
