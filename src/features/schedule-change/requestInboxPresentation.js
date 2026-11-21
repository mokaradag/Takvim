import {
  COORDINATION_MODES,
  COORDINATION_STATUS_LABELS
} from '../../domain/assignment/assignmentCoordination.js';
import { NOTIFICATION_SOURCES, TASK_NOTIFICATION_KINDS } from '../../domain/notifications/notificationInbox.js';
import {
  REQUEST_INBOX_CATEGORIES,
  REQUEST_INBOX_CATEGORY_LABELS
} from '../../domain/notifications/requestInbox.js';
import { SCHEDULE_STATUS_LABELS } from '../notifications/notificationCenterItems.js';

/**
 * Talepler birleşik tablosunun satır sunumu — SAF dönüşüm.
 *
 * Üç kaynak aynı tabloda gösterilir; her kaynağın durum sözlüğü ve iş anlamı
 * korunur. "Okundu" bir durum değildir: satırdaki "Yeni" etiketi yalnızca
 * okunmamışlığı söyler, kabul/ret/tamamlanma yerine geçmez.
 */

/** Durum süzgecinin seçenekleri: iki talep kaynağının durum kodlarının birleşimi. */
export const REQUEST_STATUS_FILTER_OPTIONS = Object.freeze([
  { value: 'PENDING', label: 'Bekliyor / Onay bekliyor' },
  { value: 'ACCEPTED', label: SCHEDULE_STATUS_LABELS.ACCEPTED },
  { value: 'APPROVED', label: COORDINATION_STATUS_LABELS.APPROVED },
  { value: 'REJECTED', label: 'Reddedildi' },
  { value: 'CHANGE_REQUESTED', label: COORDINATION_STATUS_LABELS.CHANGE_REQUESTED },
  { value: 'CANCELLATION_REQUESTED', label: COORDINATION_STATUS_LABELS.CANCELLATION_REQUESTED },
  { value: 'CANCELLED', label: 'Değiştirildi / İptal edildi' },
  { value: 'STALE', label: 'Güncelliğini yitirdi' }
]);

export const REQUEST_CATEGORY_FILTER_OPTIONS = Object.freeze(
  Object.values(REQUEST_INBOX_CATEGORIES).map((value) => ({ value, label: REQUEST_INBOX_CATEGORY_LABELS[value] }))
);

/** Kaynak + kimlik: üç tabloda kimlikler çakışabilir, satır anahtarı ikisini taşır. */
export function requestInboxKey(item) {
  return `${item?.source || NOTIFICATION_SOURCES.SCHEDULE_REQUEST}:${item?.id}`;
}

export function sameRequestInboxItem(left, right) {
  return Boolean(left && right) && requestInboxKey(left) === requestInboxKey(right);
}

function scheduleRow(item) {
  const actionable = Boolean(item.isDecisionOwner) && item.status === 'PENDING' && item.taskAvailable !== false;
  return {
    category: REQUEST_INBOX_CATEGORY_LABELS.SCHEDULE_REQUEST,
    statusLabel: SCHEDULE_STATUS_LABELS[item.status] || item.status,
    statusClass: String(item.status || '').toLowerCase(),
    actorName: item.requesterName,
    actorSicil: item.requesterSicil,
    detail: '',
    createdAt: item.createdAt,
    decidedAt: item.decidedAt,
    actionable
  };
}

function coordinationRow(item) {
  const notice = item.mode === COORDINATION_MODES.NOTICE;
  return {
    category: notice ? REQUEST_INBOX_CATEGORY_LABELS.ASSIGNMENT_NOTICE : REQUEST_INBOX_CATEGORY_LABELS.ASSIGNMENT_REQUEST,
    statusLabel: COORDINATION_STATUS_LABELS[item.status] || item.status,
    statusClass: `coordination-${String(item.status || '').toLowerCase()}`,
    actorName: item.requesterName,
    actorSicil: item.requesterSicil,
    detail: item.assigneeName ? `Görevlendirilen: ${item.assigneeName}` : '',
    createdAt: item.createdAt,
    decidedAt: item.decidedAt,
    actionable: Boolean(item.actionable)
  };
}

function taskEventRow(item) {
  const assigned = item.kind === TASK_NOTIFICATION_KINDS.TASK_ASSIGNED;
  const count = Number(item.taskCount || 1);
  return {
    category: count > 1
      ? `${count} görev ${assigned ? 'atandı' : 'sorumluluğunuzdan çıkarıldı'}`
      : REQUEST_INBOX_CATEGORY_LABELS[assigned ? 'TASK_ASSIGNED' : 'TASK_UNASSIGNED'],
    statusLabel: assigned ? 'Görev atandı' : 'Sorumluluk kaldırıldı',
    statusClass: assigned ? 'coordination-approved' : 'coordination-cancelled',
    actorName: item.actorName,
    actorSicil: item.actorSicil,
    detail: '',
    createdAt: item.occurredAt,
    decidedAt: null,
    actionable: false
  };
}

export function requestInboxRow(item) {
  const source = item?.source || NOTIFICATION_SOURCES.SCHEDULE_REQUEST;
  const row = source === NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION
    ? coordinationRow(item)
    : source === NOTIFICATION_SOURCES.TASK_EVENT ? taskEventRow(item) : scheduleRow(item);
  return {
    ...row,
    key: requestInboxKey(item),
    source,
    unread: Boolean(item?.unread),
    taskAvailable: item?.taskAvailable !== false,
    taskTitle: item?.taskTitle || (source === NOTIFICATION_SOURCES.TASK_EVENT ? 'Görev' : 'Silinen görev'),
    projectLabel: [item?.projectCode, item?.projectName].filter(Boolean).join(' · ')
  };
}
