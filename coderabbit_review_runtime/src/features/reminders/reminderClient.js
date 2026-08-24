import { publicRotaPath } from '../../lib/publicPath.js';

/**
 * Hatırlatma uçlarının istemci sarmalayıcısı.
 *
 * İstemci hiçbir zaman ALICI göndermez: gövde boştur ve sunucu alıcıları
 * görevin kendisinden çözer. Böylece uç açık bir posta rölesine dönüşemez.
 */

async function requestJson(path, init) {
  let response;
  try {
    response = await fetch(publicRotaPath(path), {
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...init
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' };
  }
  const body = await response.json().catch(() => ({}));
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
