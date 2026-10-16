import 'server-only';
import { isMissingNotificationInboxSchema } from './notificationSchema.js';
import { CURRENT_TASK_DISCLOSURE_SQL } from '../authorization/disclosureScope.js';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { NOTIFICATION_SOURCES } from '../../domain/notifications/notificationInbox.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { normalizeScheduleQuery } from '../schedule-change/scheduleRequestQueryNormalization.js';
import { ServerPersistenceError } from '../errors.js';
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
const PAGE_SOURCE = `
  FROM dbo.MR_TaskNotifications n
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = n.TaskId
  LEFT JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
`;
const OWNED = 'n.RecipientSicil = @sicil';
const UNREAD = 'n.ReadAt IS NULL';
const VISIBLE = 'n.DismissedAt IS NULL';
const TASK_AVAILABLE = '(t.TaskId IS NOT NULL AND ISNULL(p.IsActive, 0) = 1)';
const FIELDS = `n.*, COALESCE(n.ActorNameSnapshot, actor.DisplayName) AS ActorName,
  CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS IsUnread,
  CASE WHEN ${TASK_AVAILABLE} THEN 1 ELSE 0 END AS TaskAvailable`;
const PAGE_FIELDS = `n.*, COALESCE(n.ActorNameSnapshot, actor.DisplayName) AS ActorName,
  page.IsUnread AS IsUnread, page.TaskAvailable AS TaskAvailable`;

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

/**
 * Talepler sayfası önce dar ve değişmez bir alıcı nüfusu kurar. Sayaç, toplam,
 * güvenli sayfa ve sayfa üyeliği bu nüfustan çıkar; geniş künye yalnız son
 * sayfadaki kimlikler için birleştirilir.
 */
export const TASK_NOTIFICATION_PAGE_SQL = `
  DROP TABLE IF EXISTS #TaskNotificationPopulation, #TaskNotificationPageIds;
  SELECT n.NotificationId, n.OccurredAt,
    CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS IsUnread,
    CASE WHEN ${TASK_AVAILABLE} THEN 1 ELSE 0 END AS TaskAvailable,
    CASE WHEN ${UNREAD} AND ${VISIBLE} AND ${TASK_AVAILABLE} THEN 1 ELSE 0 END AS IsIncoming
  INTO #TaskNotificationPopulation ${PAGE_SOURCE} WHERE ${OWNED};

  SELECT COUNT(CASE WHEN IsIncoming = 1 THEN 1 END) AS IncomingCount,
    COUNT(CASE WHEN IsIncoming = 0 THEN 1 END) AS HistoryCount
  FROM #TaskNotificationPopulation;
  DECLARE @total int = (SELECT COUNT(*) FROM #TaskNotificationPopulation
    WHERE (@tab = 'pending' AND IsIncoming = 1) OR (@tab = 'history' AND IsIncoming = 0));
  DECLARE @lastPage int = CASE WHEN @total = 0 THEN 0 ELSE (@total - 1) / @pageSize END;
  DECLARE @safePage int = CASE WHEN @page > @lastPage THEN @lastPage ELSE @page END;
  SELECT @total AS Total, @safePage AS Page;

  SELECT NotificationId, OccurredAt, IsUnread, TaskAvailable
  INTO #TaskNotificationPageIds
  FROM #TaskNotificationPopulation
  WHERE (@tab = 'pending' AND IsIncoming = 1) OR (@tab = 'history' AND IsIncoming = 0)
  ORDER BY OccurredAt DESC, NotificationId DESC
  OFFSET (@safePage * @pageSize) ROWS FETCH NEXT @pageSize ROWS ONLY;

  SELECT ${PAGE_FIELDS} ${SOURCE}
  INNER JOIN #TaskNotificationPageIds page ON page.NotificationId = n.NotificationId
  ORDER BY page.OccurredAt DESC, n.NotificationId DESC;
  DROP TABLE #TaskNotificationPageIds, #TaskNotificationPopulation;
`;

export async function readTaskNotificationPage(executor, actor, input = {}) {
  const query = normalizeScheduleQuery({ tab: input.tab, page: input.page, pageSize: input.pageSize });
  if (!['pending', 'history'].includes(query.tab)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Bildirim sekmesi geçersiz.', { status: 400 });
  }
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('tab', sql.VarChar(10), query.tab);
  request.input('page', sql.Int, query.page);
  request.input('pageSize', sql.Int, query.pageSize);
  let result;
  try { result = await request.query(TASK_NOTIFICATION_PAGE_SQL); }
  catch (error) {
    if (!isMissingNotificationInboxSchema(error)) throw error;
    result = { recordsets: [] };
  }
  const counts = result.recordsets?.[0]?.[0] || {};
  const pagination = result.recordsets?.[1]?.[0] || {};
  return {
    items: (result.recordsets?.[2] || []).map(mapTaskNotification),
    total: Number(pagination.Total || 0), page: Number(pagination.Page || 0), pageSize: query.pageSize,
    counts: { pending: Number(counts.IncomingCount || 0), history: Number(counts.HistoryCount || 0) }
  };
}

export async function queryTaskNotifications(input) {
  return withSqlTransaction(async (executor) =>
    readTaskNotificationPage(executor, await loadAuthorizationContext(executor), input));
}

/**
 * Yapay zekâ zil okuması: okunmamış sayaç yalnızca okunmamış nüfusu sınırlı
 * yoklar; okunmuş ama kaldırılmamış geçmiş onu bilinmez yapmaz. Sayılan
 * bildirimlerin görevleri son yetki denetimi için döner.
 */
export const TASK_NOTIFICATION_EVIDENCE_INBOX_SQL = `
  DROP TABLE IF EXISTS #TaskNotificationUnreadProbe;
  SELECT TOP (@evidenceSnapshotLimit + 1) n.TaskId, t.ProjectId AS CurrentProjectId
  INTO #TaskNotificationUnreadProbe ${SOURCE}
  WHERE ${OWNED} AND ${UNREAD} AND ${CURRENT_TASK_DISCLOSURE_SQL} AND ${VISIBLE};
  DECLARE @taskEventUnreadProbe int = (SELECT COUNT(*) FROM #TaskNotificationUnreadProbe);
  SELECT CASE WHEN @taskEventUnreadProbe > @evidenceSnapshotLimit THEN NULL ELSE @taskEventUnreadProbe END AS UnreadCount;
  SELECT TOP (@limit) ${FIELDS} ${SOURCE}
  WHERE ${OWNED} AND ${CURRENT_TASK_DISCLOSURE_SQL} AND ${VISIBLE}
  ORDER BY n.OccurredAt DESC, n.NotificationId DESC;
  SELECT TaskId, CurrentProjectId, CAST(1 AS bit) AS CountsUnread, CAST(0 AS bit) AS CountsPending
  FROM #TaskNotificationUnreadProbe WHERE @taskEventUnreadProbe <= @evidenceSnapshotLimit;
  DROP TABLE #TaskNotificationUnreadProbe;
`;

export function mapTaskNotificationInbox(countRows, itemRows, populationRows = null) {
  const counts = countRows?.[0] || {};
  const evidence = Array.isArray(populationRows);
  return {
    items: (itemRows || []).map(mapTaskNotification),
    unreadCount: evidence && counts.UnreadCount == null ? null : Number(counts.UnreadCount || 0),
    pendingCount: 0,
    ...(evidence ? { population: populationRows.map((row) => ({ taskId: canonicalActualId(row.TaskId), projectId: canonicalActualId(row.CurrentProjectId),
      unread: true, pending: false })).filter((row) => row.taskId) } : {})
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
