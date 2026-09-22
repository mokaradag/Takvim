import 'server-only';
import { canonicalActualId, extractActualId } from '../../domain/identity/actualId.js';
import { COORDINATION_STATUSES } from '../../domain/assignment/assignmentCoordination.js';
import { NOTIFICATION_PREVIEW_LIMIT } from '../../domain/notifications/notificationInbox.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { activityDateRange } from '../reports/activityDates.js';
import { decodeVersion } from '../repository/versionTokens.js';
import { mapCoordination } from './assignmentCoordinationMapping.js';

/**
 * Atama koordinasyonu okumaları.
 *
 * İki yüzey vardır ve İKİSİ DE sınırlıdır:
 *   · zil önizlemesi — en fazla sekiz satır, anlık görüntüyle birlikte,
 *   · Talepler · Atama Koordinasyonu — sunucu tarafında sayfalanmış geçmiş.
 *
 * Geçmişin tamamı hiçbir zaman anlık görüntüye girmez.
 */

const SOURCE = `
  FROM dbo.MR_TaskAssignmentCoordinations c
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = c.TaskId
  LEFT JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  LEFT JOIN dbo.MR_V_PeopleDirectory requester ON requester.Sicil = c.RequesterSicil
  LEFT JOIN dbo.MR_V_PeopleDirectory assignee ON assignee.Sicil = c.RequestedAssigneeSicil
  LEFT JOIN dbo.MR_V_PeopleDirectory suggested ON suggested.Sicil = c.SuggestedAssigneeSicil
  LEFT JOIN dbo.MR_V_PeopleDirectory decidedBy ON decidedBy.Sicil = c.DecisionBySicil
  LEFT JOIN dbo.MR_AssignmentCoordinationRecipients n
    ON n.CoordinationId = c.CoordinationId AND n.Sicil = @sicil
`;
// Katılım ALICI satırından türetilir. Talep edilen kişi yalnızca atama
// yürürlüğe girdiğinde alıcı olur; onay beklerken kaydı görmez.
const PARTICIPANT = `(c.RequesterSicil = @sicil
  OR EXISTS (SELECT 1 FROM dbo.MR_AssignmentCoordinationRecipients r
    WHERE r.CoordinationId = c.CoordinationId AND r.Sicil = @sicil))`;
const IS_MANAGER = `CASE WHEN EXISTS (SELECT 1 FROM dbo.MR_AssignmentCoordinationRecipients r
  WHERE r.CoordinationId = c.CoordinationId AND r.Sicil = @sicil AND r.RecipientRole = 'MANAGER')
  THEN 1 ELSE 0 END`;
const TASK_AVAILABLE = '(t.TaskId IS NOT NULL AND p.IsActive = 1)';
const ACTIONABLE = `(${TASK_AVAILABLE} AND (
  (c.Status = 'PENDING' AND EXISTS (SELECT 1 FROM dbo.MR_AssignmentCoordinationRecipients r
     WHERE r.CoordinationId = c.CoordinationId AND r.Sicil = @sicil AND r.RecipientRole = 'MANAGER'))
  OR (c.Status = 'CANCELLATION_REQUESTED' AND c.RequesterSicil = @sicil)))`;
const UNREAD = '(n.ReadVersion IS NULL OR n.ReadVersion <> c.RowVersion)';
const VISIBLE = `(${ACTIONABLE} OR n.DismissedVersion IS NULL OR n.DismissedVersion <> c.RowVersion)`;
const FIELDS = `c.*, ${IS_MANAGER} AS IsManager,
  COALESCE(c.TaskTitleSnapshot, t.Title) AS TaskTitle,
  COALESCE(c.ProjectIdSnapshot, t.ProjectId) AS ProjectId,
  COALESCE(c.ProjectNameSnapshot, p.ProjectName) AS ProjectName,
  COALESCE(c.ProjectCodeSnapshot, p.ProjectCode) AS ProjectCode,
  requester.DisplayName AS RequesterName,
  COALESCE(assignee.DisplayName, c.AssigneeNameSnapshot) AS AssigneeName,
  suggested.DisplayName AS SuggestedAssigneeName,
  decidedBy.DisplayName AS DecisionByName,
  CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS IsUnread,
  CASE WHEN ${TASK_AVAILABLE} THEN 1 ELSE 0 END AS TaskAvailable`;
const ORDER = `CASE WHEN ${ACTIONABLE} THEN 0 ELSE 1 END,
  COALESCE(c.DecidedAt, c.CreatedAt) DESC, c.CoordinationId DESC`;

/**
 * Zil önizlemesi: sekiz satır ve iki sayaç.
 *
 * Metin ayrı dışa aktarılır; birleşik bildirim okuması bunu görev bildirimi
 * sorgusuyla TEK gidiş-dönüşte çalıştırır (bkz.
 * server/notifications/notificationInboxQueries.js).
 */
export const COORDINATION_INBOX_SQL = `
  SELECT COUNT(CASE WHEN ${UNREAD} AND ${VISIBLE} THEN 1 END) AS UnreadCount,
    COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount
  ${SOURCE} WHERE ${PARTICIPANT} AND ${TASK_AVAILABLE};
  SELECT TOP (@limit) ${FIELDS} ${SOURCE}
  WHERE ${PARTICIPANT} AND ${TASK_AVAILABLE} AND ${VISIBLE} ORDER BY ${ORDER};
`;

export function mapCoordinationInbox(countRows, itemRows, actorSicil) {
  const counts = countRows?.[0] || {};
  return {
    items: (itemRows || []).map((row) => mapCoordination(row, actorSicil)),
    unreadCount: Number(counts.UnreadCount || 0),
    pendingCount: Number(counts.PendingCount || 0)
  };
}

export async function readCoordinationInbox(executor, actor) {
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('limit', sql.Int, NOTIFICATION_PREVIEW_LIMIT);
  const result = await request.query(COORDINATION_INBOX_SQL);
  return mapCoordinationInbox(result.recordsets?.[0], result.recordsets?.[1], actor.sicil);
}

function invalid(message) {
  throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 });
}

function normalizeId(field, value) {
  if (!value) return null;
  const plain = canonicalActualId(value);
  if (plain) return plain;
  const prefix = field === 'taskId' ? 'task-' : 'project-';
  const text = String(value).trim();
  if (!text.toLowerCase().startsWith(prefix)) return null;
  const extracted = extractActualId(text);
  return extracted && canonicalActualId(text.slice(prefix.length)) === extracted ? extracted : null;
}

export function normalizeCoordinationQuery(input = {}) {
  const tab = input.tab || 'pending';
  if (!['pending', 'sent', 'history', 'all'].includes(tab)) invalid('Koordinasyon sekmesi geçersiz.');
  const page = Number(input.page || 0);
  const pageSize = Number(input.pageSize || 25);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) invalid('Sayfa numarası geçersiz.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('Sayfa boyutu 1–100 arasında olmalıdır.');
  const query = { tab, page, pageSize, search: String(input.search || '').trim().slice(0, 200) };
  for (const field of ['projectId', 'taskId']) {
    query[field] = normalizeId(field, input[field]);
    if (input[field] && !query[field]) invalid('Proje veya görev kimliği geçersiz.');
  }
  query.requester = String(input.requester || '').trim().slice(0, 100);
  query.assignee = String(input.assignee || '').trim().slice(0, 100);
  query.organization = String(input.organization || '').trim().slice(0, 200);
  query.status = input.status || null;
  if (query.status && !Object.prototype.hasOwnProperty.call(COORDINATION_STATUSES, query.status)) {
    invalid('Koordinasyon durumu geçersiz.');
  }
  for (const field of ['from', 'to']) {
    const value = input[field] || null;
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value)) invalid('Tarih geçersiz.');
    query[field] = value;
  }
  if (query.from && query.to && query.from > query.to) invalid('Başlangıç tarihi bitişten sonra olamaz.');
  return query;
}

export async function readCoordinationPage(executor, actor, input = {}) {
  const query = normalizeCoordinationQuery(input);
  const fromUtc = query.from ? activityDateRange({ period: 'custom', from: query.from, to: query.from }).startUtc : null;
  const toUtc = query.to ? activityDateRange({ period: 'custom', from: query.to, to: query.to }).endUtc : null;
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('tab', sql.VarChar(10), query.tab);
  request.input('pageSize', sql.Int, query.pageSize);
  request.input('page', sql.Int, query.page);
  request.input('search', sql.NVarChar(200), query.search);
  request.input('requester', sql.NVarChar(100), query.requester);
  request.input('assignee', sql.NVarChar(100), query.assignee);
  request.input('organization', sql.NVarChar(200), query.organization);
  for (const field of ['projectId', 'taskId']) request.input(field, sql.UniqueIdentifier, query[field]);
  request.input('status', sql.VarChar(25), query.status);
  for (const field of ['from', 'to']) request.input(field, sql.Date, query[field]);
  request.input('fromUtc', sql.DateTime2, fromUtc);
  request.input('toUtc', sql.DateTime2, toUtc);

  const filters = `${PARTICIPANT}
    AND (@projectId IS NULL OR COALESCE(c.ProjectIdSnapshot, t.ProjectId) = @projectId)
    AND (@taskId IS NULL OR c.TaskId = @taskId)
    AND (@status IS NULL OR c.Status = @status)
    AND (@fromUtc IS NULL OR c.CreatedAt >= @fromUtc)
    AND (@toUtc IS NULL OR c.CreatedAt < @toUtc)
    AND (@requester = '' OR CHARINDEX(@requester, COALESCE(requester.DisplayName, '') COLLATE Turkish_100_CI_AI) > 0
      OR CONVERT(varchar(20), c.RequesterSicil) = @requester)
    AND (@assignee = '' OR CHARINDEX(@assignee, COALESCE(assignee.DisplayName, c.AssigneeNameSnapshot, '') COLLATE Turkish_100_CI_AI) > 0
      OR CONVERT(varchar(20), c.RequestedAssigneeSicil) = @assignee)
    AND (@organization = '' OR CHARINDEX(@organization, COALESCE(c.AssigneeOrgSnapshot, '') COLLATE Turkish_100_CI_AI) > 0)
    AND (@search = '' OR CHARINDEX(@search, CONCAT(COALESCE(c.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(c.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(c.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', COALESCE(assignee.DisplayName, c.AssigneeNameSnapshot), ' ',
      c.RequesterMessage) COLLATE Turkish_100_CI_AI) > 0)`;
  const tabFilter = `(@tab = 'all' OR (@tab = 'pending' AND ${ACTIONABLE})
    OR (@tab = 'sent' AND c.RequesterSicil = @sicil)
    OR (@tab = 'history' AND (c.Status NOT IN ('PENDING','CANCELLATION_REQUESTED') OR NOT ${TASK_AVAILABLE})))`;

  const result = await request.query(`
    SELECT COUNT(*) AS Total,
      COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount,
      COUNT(CASE WHEN c.RequesterSicil = @sicil THEN 1 END) AS SentCount,
      COUNT(CASE WHEN (c.Status NOT IN ('PENDING','CANCELLATION_REQUESTED') OR NOT ${TASK_AVAILABLE}) THEN 1 END) AS HistoryCount
    ${SOURCE} WHERE ${filters};
    DECLARE @total int = (SELECT COUNT(*) ${SOURCE} WHERE ${filters} AND ${tabFilter});
    DECLARE @lastPage int = CASE WHEN @total = 0 THEN 0 ELSE (@total - 1) / @pageSize END;
    DECLARE @safePage int = CASE WHEN @page > @lastPage THEN @lastPage ELSE @page END;
    SELECT @total AS Total, @safePage AS Page;
    SELECT ${FIELDS} ${SOURCE} WHERE ${filters} AND ${tabFilter}
    ORDER BY ${ORDER} OFFSET (@safePage * @pageSize) ROWS FETCH NEXT @pageSize ROWS ONLY;
  `);
  const counts = result.recordsets?.[0]?.[0] || {};
  const pagination = result.recordsets?.[1]?.[0] || {};
  return {
    items: (result.recordsets?.[2] || []).map((row) => mapCoordination(row, actor.sicil)),
    total: Number(pagination.Total || 0),
    page: Number(pagination.Page || 0),
    pageSize: query.pageSize,
    counts: {
      pending: Number(counts.PendingCount || 0),
      sent: Number(counts.SentCount || 0),
      history: Number(counts.HistoryCount || 0)
    }
  };
}

export async function queryAssignmentCoordinations(input) {
  return withSqlTransaction(async (executor) =>
    readCoordinationPage(executor, await loadAuthorizationContext(executor), input));
}

/** Tek kaydın güncel künyesi (karar sonrası yanıt ve açılan pencere için). */
export async function readCoordination(executor, actor, coordinationId) {
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('coordinationId', sql.UniqueIdentifier, coordinationId);
  const result = await request.query(`
    SELECT TOP (1) ${FIELDS} ${SOURCE}
    WHERE c.CoordinationId = @coordinationId AND ${PARTICIPANT};
  `);
  return mapCoordination(result.recordset?.[0], actor.sicil);
}

/**
 * Okundu / temizlendi.
 *
 * Sürüm taşınır: gecikmiş bir eski sürüm işlemi yeni kararı temizleyemez.
 * Bir kişinin okuması diğer alıcının bildirimini değiştirmez.
 */
export async function updateCoordinationNotifications(executor, actor, notifications = [], action = 'read') {
  for (const item of notifications) {
    const request = executor.request();
    request.input('sicil', sql.Int, actor.sicil);
    request.input('coordinationId', sql.UniqueIdentifier, item.id);
    request.input('eventVersion', sql.Binary(8), decodeVersion(item.version));
    request.input('dismiss', sql.Bit, action === 'dismiss');
    await request.query(`
      IF EXISTS (SELECT 1 FROM dbo.MR_TaskAssignmentCoordinations c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.CoordinationId = @coordinationId AND ${PARTICIPANT} AND c.RowVersion = @eventVersion)
      BEGIN
        UPDATE dbo.MR_AssignmentCoordinationRecipients WITH (UPDLOCK, HOLDLOCK)
        SET ReadVersion = @eventVersion,
          DismissedVersion = CASE WHEN @dismiss = 1 THEN @eventVersion ELSE DismissedVersion END,
          UpdatedAt = SYSUTCDATETIME()
        WHERE CoordinationId = @coordinationId AND Sicil = @sicil;
        IF @@ROWCOUNT = 0
          INSERT dbo.MR_AssignmentCoordinationRecipients(CoordinationId, Sicil, RecipientRole, ReadVersion, DismissedVersion)
          VALUES(@coordinationId, @sicil, 'REQUESTER', @eventVersion,
            CASE WHEN @dismiss = 1 THEN @eventVersion ELSE NULL END);
      END;
    `);
  }
}
