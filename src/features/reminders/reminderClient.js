import { requestJson } from '../shared/jsonRequest.js';

/**
 * Hatırlatma uçlarının istemci sarmalayıcısı.
 *
 * İstemci hiçbir zaman ALICI göndermez: gövde boştur ve sunucu alıcıları
 * görevin kendisinden çözer. Böylece uç açık bir posta rölesine dönüşemez.
 *
 * Zaman aşımı ve hata sözleşmesi ORTAK katmandadır (bkz. shared/jsonRequest.js);
 * Outlook takvim ucu da aynı sarmalayıcıyı kullanır.
 */

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
