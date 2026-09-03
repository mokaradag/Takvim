import { publicRotaPath } from '../../lib/publicPath.js';

/**
 * Hatırlatma uçlarının istemci sarmalayıcısı.
 *
 * İstemci hiçbir zaman ALICI göndermez: gövde boştur ve sunucu alıcıları
 * görevin kendisinden çözer. Böylece uç açık bir posta rölesine dönüşemez.
 */

/**
 * İstek SÜRESİ SINIRLIDIR.
 *
 * Fetch'in kendiliğinden bir zaman aşımı yoktur: bağlantıyı kabul edip yanıt
 * göndermeyen (ya da başlıkları gönderip gövdeyi askıda bırakan) bir uç,
 * hatırlatma düğmesini kalıcı olarak devre dışı bırakıyordu
 * (`TaskReminderButton.send`, `busy` bayrağını yanıtı bekledikten sonra temizler).
 * Sayaç GÖVDE OKUNANA kadar açık tutulur; iptal edilen istek ağ hatası
 * biçimine çevrilir.
 */
const REQUEST_TIMEOUT_MS = 30000;

async function requestJson(path, init) {
  const abortable = typeof AbortController === 'function';
  const controller = abortable ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

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
  // İç `.catch(() => ({}))` ikisini birleştirip zaman aşımına uğramış bir yanıtı
  // başarılı boş yanıt gibi gösteriyordu.
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
      ok: false,
      code: body?.error?.code || 'REQUEST_FAILED',
      message: body?.error?.message || 'İşlem tamamlanamadı.'
    };
  }
  return { ok: true, ...body };
}

/** Tek bir görev için hatırlatma gönderir. */
export function sendTaskReminderRequest(taskId) {
  return requestJson(`/api/mergen-rota/tasks/${encodeURIComponent(taskId)}/reminder`, { method: 'POST' });
}

export function loadReminderSettingsRequest() {
  return requestJson('/api/mergen-rota/admin/reminder-settings', { method: 'GET' });
}

export function saveReminderSettingsRequest(settings) {
  return requestJson('/api/mergen-rota/admin/reminder-settings', {
    method: 'PUT',
    body: JSON.stringify(settings)
  });
}

/** Yönetici, zamanlanmış turu elle de başlatabilir (deneme amaçlı). */
export function runAutomaticRemindersRequest() {
  return requestJson('/api/mergen-rota/reminders/run', { method: 'POST' });
}
