import { requestJson } from '../shared/jsonRequest.js';

/**
 * Outlook takvim uçlarının istemci sarmalayıcısı.
 *
 * İstemci hiçbir zaman ALICI göndermez: davet, oturum sahibinin kurumsal
 * e-posta adresine gider ve o adres sunucuda Sicil üzerinden çözülür. Gövdede
 * yalnızca görev kimlikleri taşınır ve her biri sunucuda yeniden yetkilendirilir.
 */

/** Kullanıcının etkin abonelikleri ve özelliğin kullanılabilirliği. */
export function loadOutlookCalendarStateRequest() {
  return requestJson('/api/mergen-rota/outlook/tasks', { method: 'GET' });
}

export function addTaskToOutlookRequest(taskId) {
  return requestJson(`/api/mergen-rota/tasks/${encodeURIComponent(taskId)}/outlook`, { method: 'POST' });
}

export function resendOutlookInvitationRequest(taskId) {
  return requestJson(`/api/mergen-rota/tasks/${encodeURIComponent(taskId)}/outlook`, { method: 'PUT' });
}

export function removeTaskFromOutlookRequest(taskId) {
  return requestJson(`/api/mergen-rota/tasks/${encodeURIComponent(taskId)}/outlook`, { method: 'DELETE' });
}

/** Seçili görevlerin TOPLU eklenmesi; sunucu her görevi ayrı ayrı yetkilendirir. */
export function addTasksToOutlookRequest(taskIds) {
  return requestJson('/api/mergen-rota/outlook/tasks', {
    method: 'POST',
    body: JSON.stringify({ taskIds })
  });
}
