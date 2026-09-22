import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { NOTIFICATION_SOURCES } from '../../domain/notifications/notificationInbox.js';
import { sql } from '../db/pool.js';
import { encodeVersion } from '../repository/versionTokens.js';

/**
 * Görev bildirimlerinin OKUMA yolu.
 *
 * Zil yalnızca sınırlı bir önizleme taşır; tam geçmiş anlık görüntüye girmez.
 * Bildirim göreve erişim VERMEZ: açılan görev olağan yetkili yükleme yolundan
 * geçer ve yetki orada yeniden doğrulanır.
 */

const SOURCE = `
  FROM dbo.MR_TaskNotifications n
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = n.TaskId
  LEFT JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  LEFT JOIN dbo.MR_V_PeopleDirectory actor ON actor.Sicil = n.ActorSicil
`;
const OWNED = 'n.RecipientSicil = @sicil';
const UNREAD = 'n.ReadAt IS NULL';
const VISIBLE = 'n.DismissedAt IS NULL';
const TASK_AVAILABLE = '(t.TaskId IS NOT NULL AND p.IsActive = 1)';
const FIELDS = `n.*, COALESCE(n.ActorNameSnapshot, actor.DisplayName) AS ActorName,
  CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS IsUnread,
  CASE WHEN ${TASK_AVAILABLE} THEN 1 ELSE 0 END AS TaskAvailable`;

function isoTime(value) {
  return value ? new Date(value).toISOString() : null;
}

export function mapTaskNotification(row) {
  if (!row) return null;
  return {
    source: NOTIFICATION_SOURCES.TASK_EVENT,
    id: canonicalActualId(row.NotificationId) ?? String(row.NotificationId),
    kind: String(row.Kind),
    taskId: row.TaskId ? (canonicalActualId(row.TaskId) ?? String(row.TaskId)) : null,
    taskTitle: row.TaskTitleSnapshot || '',
    projectId: row.ProjectIdSnapshot
      ? (canonicalActualId(row.ProjectIdSnapshot) ?? String(row.ProjectIdSnapshot)) : '',
    projectName: row.ProjectNameSnapshot || '',
    projectCode: row.ProjectCodeSnapshot || '',
    actorSicil: row.ActorSicil == null ? null : String(row.ActorSicil),
    actorName: row.ActorName || (row.ActorSicil == null ? '' : String(row.ActorSicil)),
    targetFinish: row.TargetFinishSnapshot ? new Date(row.TargetFinishSnapshot).toISOString().slice(0, 10) : null,
    priority: row.PrioritySnapshot || null,
    taskCount: Number(row.TaskCount || 1),
    occurredAt: isoTime(row.OccurredAt),
    sortAt: isoTime(row.OccurredAt),
    version: encodeVersion(row.RowVersion),
    unread: row.IsUnread == null ? true : Boolean(row.IsUnread),
    taskAvailable: row.TaskAvailable == null ? false : Boolean(row.TaskAvailable),
    // Bildirim bir karar istemez; zilde yalnızca bilgilendirme olarak durur.
    actionable: false
  };
}

export const TASK_NOTIFICATION_INBOX_SQL = `
  SELECT COUNT(CASE WHEN ${UNREAD} AND ${VISIBLE} THEN 1 END) AS UnreadCount
  ${SOURCE} WHERE ${OWNED} AND ${TASK_AVAILABLE};
  SELECT TOP (@limit) ${FIELDS} ${SOURCE}
  WHERE ${OWNED} AND ${TASK_AVAILABLE} AND ${VISIBLE}
  ORDER BY n.OccurredAt DESC, n.NotificationId DESC;
`;

export function mapTaskNotificationInbox(countRows, itemRows) {
  const counts = countRows?.[0] || {};
  return {
    items: (itemRows || []).map(mapTaskNotification),
    unreadCount: Number(counts.UnreadCount || 0),
    pendingCount: 0
  };
}

/**
 * Okundu / temizlendi.
 *
 * Bildirim satırı yazıldıktan sonra DEĞİŞMEZ; bu yüzden işaretleme tek yönlü ve
 * etkisizdir (idempotent): gecikmiş bir işlem daha yeni bir durumu geri alamaz.
 * İşaret kişiye özeldir — bir alıcının okuması ötekini etkilemez.
 */
export async function updateTaskNotifications(executor, actor, notifications = [], action = 'read') {
  for (const item of notifications) {
    const request = executor.request();
    request.input('sicil', sql.Int, actor.sicil);
    request.input('notificationId', sql.UniqueIdentifier, item.id);
    request.input('dismiss', sql.Bit, action === 'dismiss');
    await request.query(`
      UPDATE dbo.MR_TaskNotifications WITH (UPDLOCK, HOLDLOCK)
      SET ReadAt = COALESCE(ReadAt, SYSUTCDATETIME()),
        DismissedAt = CASE WHEN @dismiss = 1 THEN COALESCE(DismissedAt, SYSUTCDATETIME()) ELSE DismissedAt END
      WHERE NotificationId = @notificationId AND RecipientSicil = @sicil;
    `);
  }
}
