import 'server-only';
import { bindDisclosureScope, CURRENT_TASK_DISCLOSURE_SQL, DISCLOSURE_SCOPE_CLEANUP_SQL, DISCLOSURE_SCOPE_SETUP_SQL } from '../authorization/disclosureScope.js';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { activityDateRange } from '../reports/activityDates.js';
import { decodeVersion } from '../repository/versionTokens.js';
import { mapRequest } from './scheduleRequestMapping.js';
import { normalizeScheduleQuery } from './scheduleRequestQueryNormalization.js';

export { normalizeScheduleQuery };

export const SCHEDULE_INBOX_LIMIT = 8;
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

export async function readScheduleInbox(executor, actor, { evidenceSnapshotLimit = null } = {}) {
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('limit', sql.Int, SCHEDULE_INBOX_LIMIT);
  if (evidenceSnapshotLimit != null) {
    bindDisclosureScope(request, actor);
    request.input('evidenceSnapshotLimit', sql.Int, evidenceSnapshotLimit);
  }
  // Her sayaç kendi nüfusunu ayrı ve sınırlı yoklar: okunmuş ama kaldırılmamış eski
  // kayıtlar okunmamış/bekleyen sayılarını bilinmez yapmaz. Sayılan kayıtların
  // görevleri son yetki denetimi için döner.
  const evidenceStatement = evidenceSnapshotLimit == null ? null : `
    ${DISCLOSURE_SCOPE_SETUP_SQL}
    DROP TABLE IF EXISTS #ScheduleUnreadProbe, #SchedulePendingProbe;
    SELECT TOP (@evidenceSnapshotLimit + 1) r.TaskId, t.ProjectId AS CurrentProjectId
    INTO #ScheduleUnreadProbe ${SOURCE}
    WHERE ${PARTICIPANT} AND ${CURRENT_TASK_DISCLOSURE_SQL} AND ${VISIBLE} AND ${UNREAD};
    SELECT TOP (@evidenceSnapshotLimit + 1) r.TaskId, t.ProjectId AS CurrentProjectId
    INTO #SchedulePendingProbe ${SOURCE}
    WHERE ${PARTICIPANT} AND ${CURRENT_TASK_DISCLOSURE_SQL} AND ${ACTIONABLE};
    DECLARE @unreadProbe int = (SELECT COUNT(*) FROM #ScheduleUnreadProbe);
    DECLARE @pendingProbe int = (SELECT COUNT(*) FROM #SchedulePendingProbe);
    SELECT CASE WHEN @unreadProbe > @evidenceSnapshotLimit THEN NULL ELSE @unreadProbe END AS UnreadCount,
      CASE WHEN @pendingProbe > @evidenceSnapshotLimit THEN NULL ELSE @pendingProbe END AS PendingCount;
    SELECT TOP (@limit) ${FIELDS}, CASE WHEN ${ACTIONABLE} THEN 1 ELSE 0 END AS IsPending ${SOURCE}
    WHERE ${PARTICIPANT} AND ${CURRENT_TASK_DISCLOSURE_SQL} AND ${VISIBLE} ORDER BY ${ORDER};
    SELECT TaskId, CurrentProjectId, CAST(1 AS bit) AS CountsUnread, CAST(0 AS bit) AS CountsPending
    FROM #ScheduleUnreadProbe WHERE @unreadProbe <= @evidenceSnapshotLimit
    UNION ALL
    SELECT TaskId, CurrentProjectId, CAST(0 AS bit), CAST(1 AS bit)
    FROM #SchedulePendingProbe WHERE @pendingProbe <= @evidenceSnapshotLimit;
    DROP TABLE #ScheduleUnreadProbe, #SchedulePendingProbe;
    ${DISCLOSURE_SCOPE_CLEANUP_SQL}
  `;
  const result = await request.query(evidenceStatement || `
    SELECT COUNT(CASE WHEN ${UNREAD} AND ${VISIBLE} THEN 1 END) AS UnreadCount,
      COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount
    ${SOURCE} WHERE ${PARTICIPANT} AND t.TaskId IS NOT NULL AND p.IsActive = 1;
    SELECT TOP (@limit) ${FIELDS} ${SOURCE}
    WHERE ${PARTICIPANT} AND t.TaskId IS NOT NULL AND p.IsActive = 1 AND ${VISIBLE} ORDER BY ${ORDER};
  `);
  const counts = result.recordsets?.[0]?.[0] || {};
  const evidence = evidenceSnapshotLimit != null;
  return { items: (result.recordsets?.[1] || []).map((row) => mapRequest(row, actor.sicil)),
    unreadCount: evidence && counts.UnreadCount == null ? null : Number(counts.UnreadCount || 0),
    pendingCount: evidence && counts.PendingCount == null ? null : Number(counts.PendingCount || 0),
    ...(evidence ? { population: countedPopulation(result.recordsets?.[2]) } : {}) };
}

/** Sayaçların dayandığı görevler (güncel proje kimliğiyle). */
function countedPopulation(rows = []) {
  return rows.map((row) => ({ taskId: canonicalActualId(row.TaskId), projectId: canonicalActualId(row.CurrentProjectId),
    unread: Boolean(row.CountsUnread), pending: Boolean(row.CountsPending) })).filter((row) => row.taskId);
}

function invalid(message) { throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 }); }

function requestDateBounds(query) {
  const fromUtc = query.from
    ? activityDateRange({ period: 'custom', from: query.from, to: query.from }).startUtc
    : null;
  const toUtc = query.to
    ? activityDateRange({ period: 'custom', from: query.to, to: query.to }).endUtc
    : null;
  return { fromUtc, toUtc };
}

export async function readSchedulePage(executor, actor, input = {}, { evidenceSnapshotLimit = null, messageSearch = {} } = {}) {
  const query = normalizeScheduleQuery(input);
  const { fromUtc, toUtc } = requestDateBounds(query);
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('tab', sql.VarChar(10), query.tab);
  request.input('pageSize', sql.Int, evidenceSnapshotLimit == null ? query.pageSize : evidenceSnapshotLimit + 1);
  if (evidenceSnapshotLimit != null) request.input('evidenceSnapshotLimit', sql.Int, evidenceSnapshotLimit);
  request.input('page', sql.Int, evidenceSnapshotLimit == null ? query.page : 0);
  request.input('search', sql.NVarChar(200), query.search);
  request.input('requester', sql.NVarChar(100), query.requester);
  for (const field of ['projectId', 'taskId']) request.input(field, sql.UniqueIdentifier, query[field]);
  request.input('status', sql.VarChar(20), query.status);
  // Eski sahte SQL katmanı `from`/`to` parametrelerini de okur; gerçek sorgu
  // Türkiye takvim gününü UTC yarı-açık aralığına dönüştüren sınırları kullanır.
  for (const field of ['from', 'to']) request.input(field, sql.Date, query[field]);
  request.input('fromUtc', sql.DateTime2, fromUtc);
  request.input('toUtc', sql.DateTime2, toUtc);
  if (evidenceSnapshotLimit != null) {
    bindDisclosureScope(request, actor);
    // Yapay zekâ okumasında iletiler yalnızca kullanıcının bu turda açtığı alanlarda aranır.
    request.input('searchRequesterMessage', sql.Bit, messageSearch.requester === true ? 1 : 0);
    request.input('searchDecisionMessage', sql.Bit, messageSearch.decision === true ? 1 : 0);
  }
  const searchCorpus = evidenceSnapshotLimit == null
    ? `CONCAT(COALESCE(r.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(r.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(r.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', r.RequesterMessage)`
    : `CONCAT(COALESCE(r.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(r.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(r.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', ownerPerson.DisplayName,
      CASE WHEN @searchRequesterMessage = 1 THEN CONCAT(' ', r.RequesterMessage) ELSE '' END,
      CASE WHEN @searchDecisionMessage = 1 THEN CONCAT(' ', r.DecisionMessage) ELSE '' END)`;
  const filters = `${PARTICIPANT}${evidenceSnapshotLimit == null ? '' : ` AND ${CURRENT_TASK_DISCLOSURE_SQL}`}
    AND (@projectId IS NULL OR COALESCE(r.ProjectIdSnapshot, t.ProjectId) = @projectId)
    AND (@taskId IS NULL OR r.TaskId = @taskId)
    AND (@status IS NULL OR r.Status = @status)
    AND (@fromUtc IS NULL OR r.CreatedAt >= @fromUtc)
    AND (@toUtc IS NULL OR r.CreatedAt < @toUtc)
    AND (@requester = '' OR CHARINDEX(@requester, COALESCE(requester.DisplayName, '') COLLATE Turkish_100_CI_AI) > 0
      OR CONVERT(varchar(20), r.RequesterSicil) = @requester)
    AND (@search = '' OR CHARINDEX(@search, ${searchCorpus} COLLATE Turkish_100_CI_AI) > 0)`;
  const tabFilter = `(@tab = 'all' OR (@tab = 'pending' AND ${ACTIONABLE})
    OR (@tab = 'sent' AND r.RequesterSicil = @sicil) OR (@tab = 'history' AND (r.Status <> 'PENDING' OR t.TaskId IS NULL OR p.IsActive = 0)))`;
  const evidenceStatement = evidenceSnapshotLimit == null ? null : `
    ${DISCLOSURE_SCOPE_SETUP_SQL}
    DROP TABLE IF EXISTS #ScheduleEvidenceSnapshot;
    SELECT TOP (@evidenceSnapshotLimit + 1) ${FIELDS}, t.ProjectId AS CurrentProjectId,
      CASE WHEN ${ACTIONABLE} THEN 1 ELSE 0 END AS IsPending,
      CASE WHEN r.RequesterSicil = @sicil THEN 1 ELSE 0 END AS IsSent,
      CASE WHEN r.Status <> 'PENDING' OR t.TaskId IS NULL OR p.IsActive = 0 THEN 1 ELSE 0 END AS IsHistory
    INTO #ScheduleEvidenceSnapshot ${SOURCE} WHERE ${filters} AND ${tabFilter}
    ORDER BY ${ORDER};
    DECLARE @total int = (SELECT COUNT(*) FROM #ScheduleEvidenceSnapshot);
    IF @total > @evidenceSnapshotLimit
    BEGIN
      -- Paylaşılan havuz oturumunda geçici tablo kalmaz.
      DROP TABLE #ScheduleEvidenceSnapshot, #AiDisclosureProjects, #AiDisclosureTasks;
      THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;
    END
    SELECT @total AS Total, SUM(IsPending) AS PendingCount, SUM(IsSent) AS SentCount, SUM(IsHistory) AS HistoryCount
    FROM #ScheduleEvidenceSnapshot;
    SELECT @total AS Total, 0 AS Page;
    SELECT * FROM #ScheduleEvidenceSnapshot ORDER BY IsPending DESC, COALESCE(DecidedAt, CreatedAt) DESC, RequestId DESC;
    DROP TABLE #ScheduleEvidenceSnapshot;
    ${DISCLOSURE_SCOPE_CLEANUP_SQL}
  `;
  const result = await request.query(evidenceStatement || `
    SELECT COUNT(*) AS Total,
      COUNT(CASE WHEN ${ACTIONABLE} THEN 1 END) AS PendingCount,
      COUNT(CASE WHEN r.RequesterSicil = @sicil THEN 1 END) AS SentCount,
      COUNT(CASE WHEN (r.Status <> 'PENDING' OR t.TaskId IS NULL OR p.IsActive = 0) THEN 1 END) AS HistoryCount
    ${SOURCE} WHERE ${filters};
    DECLARE @total int = (SELECT COUNT(*) ${SOURCE} WHERE ${filters} AND ${tabFilter});
    ${evidenceSnapshotLimit == null ? '' : "IF @total > @evidenceSnapshotLimit THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;"}
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
