import {
  NOTIFICATION_PREVIEW_LIMIT,
  NOTIFICATION_SOURCES,
  TASK_NOTIFICATION_KINDS,
  mergeNotificationPreviews,
  totalNotificationCounts
} from '../../domain/notifications/notificationInbox.js';
import { COORDINATION_MODES, COORDINATION_STATUS_LABELS } from '../../domain/assignment/assignmentCoordination.js';

/**
 * Zil merkezinin liste kalemleri — SAF dönüşüm.
 *
 * Zil TEKTİR: tarih talebi, atama koordinasyonu ve atama olayı aynı listede,
 * aynı okundu/temizlendi anlambilimiyle görünür. Bileşen yalnızca çizer;
 * birleştirme ve metin kuralı burada durur ve tarayıcı olmadan sınanabilir.
 */

export const SCHEDULE_STATUS_LABELS = Object.freeze({
  PENDING: 'Bekliyor',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  CANCELLED: 'Değiştirildi',
  STALE: 'Güncelliğini yitirdi'
});

function scheduleItem(request) {
  const actionable = Boolean(request.isDecisionOwner) && request.status === 'PENDING'
    && request.taskAvailable !== false;
  return {
    ...request,
    source: NOTIFICATION_SOURCES.SCHEDULE_REQUEST,
    sortAt: request.decidedAt || request.createdAt || null,
    actionable,
    statusLabel: SCHEDULE_STATUS_LABELS[request.status] || request.status,
    statusClass: String(request.status || '').toLowerCase(),
    headline: actionable
      ? 'Kararınız bekleniyor'
      : request.status === 'PENDING'
        ? 'Tarih değişikliği talebi'
        : `Tarih değişikliği ${(SCHEDULE_STATUS_LABELS[request.status] || 'sonuçlandı').toLocaleLowerCase('tr-TR')}`,
    subtitle: request.isRequester
      ? request.taskTitle
      : `${request.requesterName} · ${request.taskTitle}`
  };
}

function coordinationItem(record) {
  const notice = record.mode === COORDINATION_MODES.NOTICE;
  return {
    ...record,
    statusLabel: COORDINATION_STATUS_LABELS[record.status] || record.status,
    statusClass: `coordination-${String(record.status || '').toLowerCase()}`,
    headline: record.actionable
      ? 'Kararınız bekleniyor'
      : notice
        ? 'Kurum dışı atama bildirimi'
        : `Atama talebi · ${(COORDINATION_STATUS_LABELS[record.status] || 'güncellendi').toLocaleLowerCase('tr-TR')}`,
    subtitle: `${record.assigneeName} · ${record.taskTitle || 'Silinen görev'}`,
    detail: record.assigneeOrganization || record.projectName || ''
  };
}

function taskEventItem(notification) {
  const assigned = notification.kind === TASK_NOTIFICATION_KINDS.TASK_ASSIGNED;
  const many = Number(notification.taskCount || 1) > 1;
  return {
    ...notification,
    statusLabel: assigned ? 'Görev atandı' : 'Sorumluluk kaldırıldı',
    statusClass: assigned ? 'coordination-approved' : 'coordination-cancelled',
    headline: many
      ? `${notification.taskCount} görev ${assigned ? 'atandı' : 'sorumluluğunuzdan çıkarıldı'}`
      : assigned ? 'Size görev atandı' : 'Görev sorumluluğunuz kaldırıldı',
    subtitle: many
      ? `${notification.actorName} · ${notification.taskCount} görev`
      : `${notification.actorName} · ${notification.taskTitle || 'Görev'}`,
    detail: [notification.projectCode, notification.projectName].filter(Boolean).join(' · ')
  };
}

/**
 * Üç kaynağın önizlemelerini tek listeye indirir.
 *
 * Her kaynak sunucudan zaten sınırlı sayıda satırla gelir; burada ek istek
 * yapılmaz ve geçmişin tamamı hiçbir zaman yüklenmez.
 */
export function notificationCenterItems({
  scheduleRequests = [],
  assignmentCoordinations = [],
  taskNotifications = []
} = {}, limit = NOTIFICATION_PREVIEW_LIMIT) {
  return mergeNotificationPreviews([
    scheduleRequests.map(scheduleItem),
    assignmentCoordinations.map(coordinationItem),
    taskNotifications.map(taskEventItem)
  ], limit);
}

export function notificationCenterCounts(scheduleSummary, notificationSummary) {
  return totalNotificationCounts([scheduleSummary, notificationSummary]);
}

export { NOTIFICATION_SOURCES };
