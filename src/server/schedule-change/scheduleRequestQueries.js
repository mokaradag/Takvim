import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { activityDateRange } from '../reports/activityDates.js';
import { decodeVersion } from '../repository/versionTokens.js';
import { mapRequest } from './scheduleRequestMapping.js';

export const SCHEDULE_INBOX_LIMIT = 8;
const STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'STALE'];
const SOURCE = `
  FROM dbo.MR_TaskScheduleChangeRequests r
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = r.TaskId
  LEFT JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  LEFT JOIN dbo.MR_V_PeopleDirectory requester ON requester.Sicil = r.RequesterSicil
  LEFT JOIN dbo.MR_V_PeopleDirectory ownerPerson ON ownerPerson.Sicil = r.DecisionOwnerSicil
  LEFT JOIN dbo.MR_ScheduleRequestNotifications n ON n.RequestId = r.RequestId AND n.Sicil = @sicil
`;
const PARTICIPANT = '(r.RequesterSicil = @sicil OR r.DecisionOwnerSicil = @sicil)';
const ACTIONABLE = "(r.Status = 'PENDING' AND r.DecisionOwnerSicil = @sicil AND t.TaskId IS NOT NULL AND p.IsActive = 1)";
const UNREAD = '(n.ReadVersion IS NULL OR n.ReadVersion <> r.RowVersion)';
const VISIBLE = `(${ACTIONABLE} OR n.DismissedVersion IS NULL OR n.DismissedVersion <> r.RowVersion)`;
// Eski canlı-öncelikli COALESCE(t.Title, r.TaskTitleSnapshot) sırası tarihsel künyeyi bozuyordu;
// kalıcı talep snapshotı aşağıdaki alanlarda ve arama/süzmede bilinçli olarak önce gelir.
const FIELDS = `r.*, COALESCE(r.TaskTitleSnapshot, t.Title) AS TaskTitle,
  COALESCE(r.ProjectIdSnapshot, t.ProjectId) AS ProjectId,
  COALESCE(r.ProjectNameSnapshot, p.ProjectName) AS ProjectName,
  COALESCE(r.ProjectCodeSnapshot, p.ProjectCode) AS ProjectCode,
  requester.DisplayName AS RequesterName, ownerPerson.DisplayName AS DecisionOwnerName,
  CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS IsUnread,
  CASE WHEN t.TaskId IS NOT NULL AND p.IsActive = 1 THEN 1 ELSE 0 END AS TaskAvailable`;
const ORDER = `CASE WHEN ${ACTIONABLE} THEN 0 ELSE 1 END,
  COALESCE(r.DecidedAt, r.CreatedAt) DESC, r.RequestId DESC`;

export async function readScheduleInbox(executor, actor) {
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('limit', sql.Int, SCHEDULE_INBOX_LIMIT);
  const result = await request.query(`
    SELECT COUNT(CASE WHEN ${UNREAD} AND ${VISIBLE} THEN 1 END) AS UnreadCount,
      COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount
    ${SOURCE} WHERE ${PARTICIPANT} AND t.TaskId IS NOT NULL AND p.IsActive = 1;
    SELECT TOP (@limit) ${FIELDS} ${SOURCE}
    WHERE ${PARTICIPANT} AND t.TaskId IS NOT NULL AND p.IsActive = 1 AND ${VISIBLE} ORDER BY ${ORDER};
  `);
  const counts = result.recordsets?.[0]?.[0] || {};
  return { items: (result.recordsets?.[1] || []).map((row) => mapRequest(row, actor.sicil)),
    unreadCount: Number(counts.UnreadCount || 0), pendingCount: Number(counts.PendingCount || 0) };
}

function invalid(message) { throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 }); }

export function normalizeScheduleQuery(input = {}) {
  const tab = input.tab || 'pending';
  if (!['pending', 'sent', 'history', 'all'].includes(tab)) invalid('Talep sekmesi geçersiz.');
  const page = Number(input.page || 0), pageSize = Number(input.pageSize || 25);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) invalid('Sayfa numarası geçersiz.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('Sayfa boyutu 1–100 arasında olmalıdır.');
  const query = { tab, page, pageSize, search: String(input.search || '').trim().slice(0, 200) };
  for (const field of ['projectId', 'taskId']) {
    query[field] = input[field] ? canonicalActualId(input[field]) : null;
    if (input[field] && !query[field]) invalid('Proje veya görev kimliği geçersiz.');
  }
  query.requester = String(input.requester || '').trim().slice(0, 100);
  query.status = input.status || null;
  if (query.status && !STATUSES.includes(query.status)) invalid('Talep durumu geçersiz.');
  for (const field of ['from', 'to']) {
    const value = input[field] || null;
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900 || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value)) invalid('Tarih geçersiz.');
    query[field] = value;
  }
  if (query.from && query.to && query.from > query.to) invalid('Başlangıç tarihi bitişten sonra olamaz.');
  return query;
}

function requestDateBounds(query) {
  const fromUtc = query.from
    ? activityDateRange({ period: 'custom', from: query.from, to: query.from }).startUtc
    : null;
  const toUtc = query.to
    ? activityDateRange({ period: 'custom', from: query.to, to: query.to }).endUtc
    : null;
  return { fromUtc, toUtc };
}

export async function readSchedulePage(executor, actor, input = {}) {
  const query = normalizeScheduleQuery(input);
  const { fromUtc, toUtc } = requestDateBounds(query);
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('tab', sql.VarChar(10), query.tab);
  request.input('pageSize', sql.Int, query.pageSize);
  request.input('page', sql.Int, query.page);
  request.input('search', sql.NVarChar(200), query.search);
  request.input('requester', sql.NVarChar(100), query.requester);
  for (const field of ['projectId', 'taskId']) request.input(field, sql.UniqueIdentifier, query[field]);
  request.input('status', sql.VarChar(20), query.status);
  // Eski sahte SQL katmanı `from`/`to` parametrelerini de okur; gerçek sorgu
  // Türkiye takvim gününü UTC yarı-açık aralığına dönüştüren sınırları kullanır.
  for (const field of ['from', 'to']) request.input(field, sql.Date, query[field]);
  request.input('fromUtc', sql.DateTime2, fromUtc);
  request.input('toUtc', sql.DateTime2, toUtc);
  const filters = `${PARTICIPANT}
    AND (@projectId IS NULL OR COALESCE(r.ProjectIdSnapshot, t.ProjectId) = @projectId)
    AND (@taskId IS NULL OR r.TaskId = @taskId)
    AND (@status IS NULL OR r.Status = @status)
    AND (@fromUtc IS NULL OR r.CreatedAt >= @fromUtc)
    AND (@toUtc IS NULL OR r.CreatedAt < @toUtc)
    AND (@requester = '' OR CHARINDEX(@requester, COALESCE(requester.DisplayName, '') COLLATE Turkish_100_CI_AI) > 0
      OR CONVERT(varchar(20), r.RequesterSicil) = @requester)
    AND (@search = '' OR CHARINDEX(@search, CONCAT(COALESCE(r.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(r.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(r.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', r.RequesterMessage) COLLATE Turkish_100_CI_AI) > 0)`;
  const tabFilter = `(@tab = 'all' OR (@tab = 'pending' AND ${ACTIONABLE})
    OR (@tab = 'sent' AND r.RequesterSicil = @sicil) OR (@tab = 'history' AND (r.Status <> 'PENDING' OR t.TaskId IS NULL OR p.IsActive = 0)))`;
  const result = await request.query(`
    SELECT COUNT(*) AS Total,
      COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount,
      COUNT(CASE WHEN r.RequesterSicil = @sicil THEN 1 END) AS SentCount,
      COUNT(CASE WHEN (r.Status <> 'PENDING' OR t.TaskId IS NULL OR p.IsActive = 0) THEN 1 END) AS HistoryCount
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
  return { items: (result.recordsets?.[2] || []).map((row) => mapRequest(row, actor.sicil)),
    total: Number(pagination.Total || 0), page: Number(pagination.Page || 0), pageSize: query.pageSize,
    counts: { pending: Number(counts.PendingCount || 0), sent: Number(counts.SentCount || 0), history: Number(counts.HistoryCount || 0) } };
}

export async function queryScheduleChanges(input) {
  return withSqlTransaction(async (executor) => readSchedulePage(executor, await loadAuthorizationContext(executor), input));
}

export async function updateScheduleNotifications(input = {}) {
  if (!['read', 'dismiss'].includes(input.action) || !Array.isArray(input.notifications)
    || !input.notifications.length || input.notifications.length > 100) invalid('Bildirim işlemi geçersiz.');
  const notifications = input.notifications.map((item) => {
    const id = canonicalActualId(item?.id);
    if (!id) invalid('Bildirim kimliği geçersiz.');
    return { id, version: decodeVersion(item.version) };
  });
  return withSqlTransaction(async (executor) => {
    const actor = await loadAuthorizationContext(executor);
    for (const item of notifications) {
      const request = executor.request();
      request.input('sicil', sql.Int, actor.sicil);
      request.input('requestId', sql.UniqueIdentifier, item.id);
      request.input('eventVersion', sql.Binary(8), item.version);
      request.input('dismiss', sql.Bit, input.action === 'dismiss');
      await request.query(`
        IF EXISTS (SELECT 1 FROM dbo.MR_TaskScheduleChangeRequests r WITH (UPDLOCK, HOLDLOCK)
          WHERE r.RequestId = @requestId AND ${PARTICIPANT} AND r.RowVersion = @eventVersion)
        BEGIN
          UPDATE dbo.MR_ScheduleRequestNotifications WITH (UPDLOCK, HOLDLOCK)
          SET ReadVersion = @eventVersion,
            DismissedVersion = CASE WHEN @dismiss = 1 THEN @eventVersion ELSE DismissedVersion END,
            UpdatedAt = SYSUTCDATETIME()
          WHERE RequestId = @requestId AND Sicil = @sicil;
          IF @@ROWCOUNT = 0
            INSERT dbo.MR_ScheduleRequestNotifications(RequestId, Sicil, ReadVersion, DismissedVersion)
            VALUES(@requestId, @sicil, @eventVersion, CASE WHEN @dismiss = 1 THEN @eventVersion ELSE NULL END);
        END;
      `);
    }
    return { ok: true };
  }, { deadlockRetries: 2 });
}
