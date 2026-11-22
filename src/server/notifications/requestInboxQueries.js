import 'server-only';
import { COORDINATION_STATUSES } from '../../domain/assignment/assignmentCoordination.js';
import { canonicalActualId, extractActualId } from '../../domain/identity/actualId.js';
import { NOTIFICATION_SOURCES } from '../../domain/notifications/notificationInbox.js';
import { REQUEST_INBOX_CATEGORIES, REQUEST_INBOX_TABS } from '../../domain/notifications/requestInbox.js';
import { COORDINATION_SQL, bindCoordinationScope } from '../assignment/assignmentCoordinationQueries.js';
import { mapCoordination } from '../assignment/assignmentCoordinationMapping.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { activityDateRange } from '../reports/activityDates.js';
import { encodeVersion } from '../repository/versionTokens.js';
import { mapRequest } from '../schedule-change/scheduleRequestMapping.js';
import { SCHEDULE_REQUEST_SQL } from '../schedule-change/scheduleRequestQueries.js';
import { isMissingNotificationInboxSchema } from './notificationInboxQueries.js';
import { TASK_NOTIFICATION_SQL, mapTaskNotification } from './taskNotificationQueries.js';

/**
 * Talepler · Gelenler / Gönderdiklerim / Geçmiş — BİRLEŞİK, sunucuda sayfalanan
 * okuma.
 *
 * Üç kalıcı kaynak kendi tablosunda ve kendi anlamıyla kalır:
 *   · tarih değişikliği talebi  (MR_TaskScheduleChangeRequests)
 *   · atama koordinasyonu       (MR_TaskAssignmentCoordinations)
 *   · atama olayı               (MR_TaskNotifications)
 * Burada yalnızca ORTAK sekme anlamı, süzgeç, sıralama ve sayfalama vardır.
 * Katılım/yetki yüklemleri her kaynağın kendi modülünden alınır; ikinci bir
 * kural yazılmaz. Kullanıcı kimliği oturumdan gelir, bütün değerler
 * parametrelidir ve geçmişin tamamı uygulama anlık görüntüsüne yüklenmez.
 *
 * Sekme anlamı (bkz. docs/TALEPLER-VE-BILDIRIMLER.md):
 *   · Gelenler: kararınızı bekleyen kayıtlar + etkin görevlere ait okunmamış
 *     ve temizlenmemiş bildirimler. Okundu işareti bilgilendirme satırını
 *     buradan çıkarır; karar bekleyen kayıt okunsa da kalır. Kullanıcının kendi
 *     açık talebi gelen sayılmaz (Gönderdiklerim'dedir); sonuçlandığında yanıtı
 *     gelen olur.
 *   · Gönderdiklerim: kullanıcının gönderdiği tarih ve atama talepleri. Olay
 *     bildirimleri ve doğrudan atama bildirimleri (NOTICE) talep sayılmaz.
 *   · Geçmiş: sonuçlanan talepler, görevi silinen/projesi kapalı kayıtlar ve
 *     atama olaylarının tamamı. Okundu/temizlendi durumundan BAĞIMSIZDIR:
 *     okumak silmek değildir.
 */

const SCHEDULE_STATUS_CODES = new Set(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'STALE']);
const STATUS_CODES = new Set([...SCHEDULE_STATUS_CODES, ...Object.keys(COORDINATION_STATUSES)]);
const CATEGORY_CODES = new Set(Object.values(REQUEST_INBOX_CATEGORIES));
const CURSOR_SOURCES = new Set(Object.values(NOTIFICATION_SOURCES));

function invalid(message) {
  throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 });
}

function normalizeProjectId(value) {
  if (!value) return null;
  const plain = canonicalActualId(value);
  if (plain) return plain;
  const text = String(value).trim();
  if (!text.toLowerCase().startsWith('project-')) return null;
  const extracted = extractActualId(text);
  return extracted && canonicalActualId(text.slice('project-'.length)) === extracted ? extracted : null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    invalid('Tarih geçersiz.');
  }
  return value;
}

function isInboxItemActionable(item) {
  if (!item) return false;
  if (item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST) {
    return Boolean(item.isDecisionOwner) && item.status === 'PENDING' && item.taskAvailable !== false;
  }
  return Boolean(item.actionable);
}

// SQL sıralama anahtarını Date nesnesine çevirmek 100 nanosaniye duyarlılığını kaybettirir.
function normalizeCursorTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z?$/.exec(value);
  if (!parts || parts[1].startsWith('0000')) return null;
  const second = parts[1];
  const date = new Date(second + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== second) return null;
  return second + '.' + (parts[2] || '').padEnd(7, '0');
}

/** Sonraki sayfa geçişi için belirlenimci sıralama sınırını kodlar. */
export function encodeRequestInboxCursor(item, orderKey = null) {
  if (!item) return null;
  const source = item.source;
  const id = canonicalActualId(item.id);
  if (!CURSOR_SOURCES.has(source) || !id) return null;
  const timestamp = normalizeCursorTimestamp(orderKey?.CursorSortAt ?? item.sortAt ?? item.decidedAt ?? item.createdAt ?? item.occurredAt);
  if (!timestamp) return null;
  return Buffer.from(JSON.stringify({
    a: (orderKey ? Boolean(orderKey.ActionableFlag) : isInboxItemActionable(item)) ? 1 : 0,
    t: timestamp + 'Z',
    s: source,
    i: id
  }), 'utf8').toString('base64url');
}

function decodeRequestInboxCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) invalid('Sayfalama imleci geçersiz.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalid('Sayfalama imleci geçersiz.');
  }
  if (!parsed || typeof parsed !== 'object') invalid('Sayfalama imleci geçersiz.');
  const actionable = parsed.a === 1 ? 1 : parsed.a === 0 ? 0 : null;
  const source = CURSOR_SOURCES.has(parsed.s) ? parsed.s : null;
  const id = canonicalActualId(parsed.i);
  const sortAt = normalizeCursorTimestamp(parsed.t);
  if (actionable == null || !source || !id || !sortAt) invalid('Sayfalama imleci geçersiz.');
  return { actionable, sortAt, source, id, legacy: !/\.\d{7}Z$/.test(parsed.t) };
}

export function normalizeRequestInboxQuery(input = {}) {
  const tab = input.tab || REQUEST_INBOX_TABS.INCOMING;
  if (!Object.values(REQUEST_INBOX_TABS).includes(tab)) invalid('Talep sekmesi geçersiz.');
  const page = Number(input.page || 0);
  const pageSize = Number(input.pageSize || 25);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) invalid('Sayfa numarası geçersiz.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('Sayfa boyutu 1–100 arasında olmalıdır.');
  const projectId = normalizeProjectId(input.projectId);
  if (input.projectId && !projectId) invalid('Proje kimliği geçersiz.');
  const status = input.status || null;
  if (status && !STATUS_CODES.has(status)) invalid('Talep durumu geçersiz.');
  const category = input.category || null;
  if (category && !CATEGORY_CODES.has(category)) invalid('Talep türü geçersiz.');
  const from = normalizeDate(input.from || null);
  const to = normalizeDate(input.to || null);
  if (from && to && from > to) invalid('Başlangıç tarihi bitişten sonra olamaz.');
  const cursor = decodeRequestInboxCursor(input.cursor || null);
  return {
    tab, page, pageSize, projectId, status, category, from, to, cursor,
    search: String(input.search || '').trim().slice(0, 200),
    requester: String(input.requester || '').trim().slice(0, 100)
  };
}

const S = SCHEDULE_REQUEST_SQL;
const C = COORDINATION_SQL;
const N = TASK_NOTIFICATION_SQL;
const SCHEDULE_AVAILABLE = '(t.TaskId IS NOT NULL AND p.IsActive = 1)';
const text = (expression) => `${expression} COLLATE Turkish_100_CI_AI`;
const matches = (needle, haystack) => `CHARINDEX(${needle}, ${text(`COALESCE(${haystack}, '')`)}) > 0`;

const S_INCOMING = `(${S.ACTIONABLE} OR (${S.UNREAD} AND ${S.VISIBLE} AND ${SCHEDULE_AVAILABLE}
  AND NOT (r.RequesterSicil = @sicil AND r.Status = 'PENDING')))`;
const S_SENT = '(r.RequesterSicil = @sicil)';
const S_HISTORY = `(r.Status <> 'PENDING' OR NOT ${SCHEDULE_AVAILABLE})`;
const S_SORT_AT = 'COALESCE(r.DecidedAt, r.CreatedAt)';
const S_ACTIONABLE_BIT = `CASE WHEN ${S.ACTIONABLE} THEN 1 ELSE 0 END`;
const S_FILTERS = `(@projectId IS NULL OR COALESCE(r.ProjectIdSnapshot, t.ProjectId) = @projectId)
  AND (@status IS NULL OR r.Status = @status)
  AND (@fromUtc IS NULL OR r.CreatedAt >= @fromUtc)
  AND (@toUtc IS NULL OR r.CreatedAt < @toUtc)
  AND (@requester = '' OR ${matches('@requester', 'requester.DisplayName')}
    OR CONVERT(varchar(20), r.RequesterSicil) = @requester)
  AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(COALESCE(r.TaskTitleSnapshot, t.Title), ' ',
    COALESCE(r.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(r.ProjectCodeSnapshot, p.ProjectCode), ' ',
    requester.DisplayName, ' ', r.RequesterMessage)`)}) > 0)`;

const C_INCOMING = `(${C.ACTIONABLE} OR (${C.UNREAD} AND ${C.VISIBLE} AND ${C.TASK_AVAILABLE}
  AND NOT (c.RequesterSicil = @sicil AND c.Status = 'PENDING')))`;
const C_SENT = "(c.RequesterSicil = @sicil AND c.Mode = 'REQUEST')";
const C_HISTORY = `(c.Status NOT IN ('PENDING','CANCELLATION_REQUESTED') OR NOT ${C.TASK_AVAILABLE})`;
const C_SORT_AT = 'COALESCE(c.DecidedAt, c.CreatedAt)';
const C_ACTIONABLE_BIT = `CASE WHEN ${C.ACTIONABLE} THEN 1 ELSE 0 END`;
const C_FILTERS = `(@category IS NULL OR (@category = 'ASSIGNMENT_REQUEST' AND c.Mode = 'REQUEST')
    OR (@category = 'ASSIGNMENT_NOTICE' AND c.Mode = 'NOTICE'))
  AND (@projectId IS NULL OR ${C.DISPLAYED_PROJECT_ID} = @projectId)
  AND (@status IS NULL OR c.Status = @status)
  AND (@fromUtc IS NULL OR c.CreatedAt >= @fromUtc)
  AND (@toUtc IS NULL OR c.CreatedAt < @toUtc)
  AND (@requester = '' OR ${matches('@requester', 'requester.DisplayName')}
    OR CONVERT(varchar(20), c.RequesterSicil) = @requester)
  AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(COALESCE(c.TaskTitleSnapshot, t.Title), ' ',
    COALESCE(c.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(c.ProjectCodeSnapshot, p.ProjectCode), ' ',
    requester.DisplayName, ' ', COALESCE(assignee.DisplayName, c.AssigneeNameSnapshot), ' ',
    c.RequesterMessage)`)}) > 0)`;

const N_INCOMING = `(${N.UNREAD} AND ${N.VISIBLE} AND ${N.TASK_AVAILABLE})`;
// Çok projeli toplu atama bildirimi kasıtlı olarak tek proje kimliği taşımaz
// (ProjectIdSnapshot NULL ve TaskCount > 1); proje süzgecinde yalnızca ilk
// görevin projesine yanlış biçimde bağlanmaz.
const N_FILTERS = `(@category IS NULL OR n.Kind = @category)
  AND (@projectId IS NULL OR n.ProjectIdSnapshot = @projectId
    OR (n.ProjectIdSnapshot IS NULL AND n.TaskCount <= 1 AND t.ProjectId = @projectId))
  AND (@fromUtc IS NULL OR n.OccurredAt >= @fromUtc)
  AND (@toUtc IS NULL OR n.OccurredAt < @toUtc)
  AND (@requester = '' OR ${matches('@requester', 'COALESCE(n.ActorNameSnapshot, actor.DisplayName)')}
    OR CONVERT(varchar(20), n.ActorSicil) = @requester)
  AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(n.TaskTitleSnapshot, ' ', n.ProjectNameSnapshot, ' ',
    n.ProjectCodeSnapshot, ' ', COALESCE(n.ActorNameSnapshot, actor.DisplayName))`)}) > 0)`;

function cursorAfter(actionableExpr, sortAtExpr, sourceLiteral, idExpr) {
  return `(@useCursor = 0
    OR ${actionableExpr} < @cursorActionable
    OR (${actionableExpr} = @cursorActionable AND ${sortAtExpr} < @cursorSortAt)
    OR (${actionableExpr} = @cursorActionable AND ${sortAtExpr} = @cursorSortAt AND '${sourceLiteral}' > @cursorSource)
    OR (${actionableExpr} = @cursorActionable AND ${sortAtExpr} = @cursorSortAt AND '${sourceLiteral}' = @cursorSource AND ${idExpr} < @cursorItemId))`;
}

/**
 * Sayaçlar tam geçmişi tablo değişkenine yığmadan akar toplamla hesaplanır;
 * sayfa adayları yalnızca etkin sekme ve sayfa penceresiyle sınırlanır.
 * Ayrıntı okuması, sayfa üyeliği sırasında yakalanan sürüm ve okunmamışlık
 * bayraklarıyla karşılaştırılır.
 */
const requestInboxSql = (scheduleOnly) => `
  /* rota-request-inbox */
  DECLARE @incomingCount int = 0, @sentCount int = 0, @historyCount int = 0;

  IF @category IS NULL OR @category = 'SCHEDULE_REQUEST'
  SELECT
    @incomingCount += COALESCE(SUM(IsIncoming), 0),
    @sentCount += COALESCE(SUM(IsSent), 0),
    @historyCount += COALESCE(SUM(IsHistory), 0)
  FROM (
    SELECT
      CASE WHEN ${S_INCOMING} THEN 1 ELSE 0 END AS IsIncoming,
      CASE WHEN ${S_SENT} THEN 1 ELSE 0 END AS IsSent,
      CASE WHEN ${S_HISTORY} THEN 1 ELSE 0 END AS IsHistory
    ${S.SOURCE} WHERE ${S.PARTICIPANT} AND ${S_FILTERS}
  ) AS members;

  ${scheduleOnly ? '' : `
  IF @category IS NULL OR @category IN ('ASSIGNMENT_REQUEST', 'ASSIGNMENT_NOTICE')
  SELECT
    @incomingCount += COALESCE(SUM(IsIncoming), 0),
    @sentCount += COALESCE(SUM(IsSent), 0),
    @historyCount += COALESCE(SUM(IsHistory), 0)
  FROM (
    SELECT
      CASE WHEN ${C_INCOMING} THEN 1 ELSE 0 END AS IsIncoming,
      CASE WHEN ${C_SENT} THEN 1 ELSE 0 END AS IsSent,
      CASE WHEN ${C_HISTORY} THEN 1 ELSE 0 END AS IsHistory
    ${C.SOURCE} WHERE ${C.PARTICIPANT} AND ${C_FILTERS}
  ) AS members;

  IF @status IS NULL AND (@category IS NULL OR @category IN ('TASK_ASSIGNED', 'TASK_UNASSIGNED'))
  SELECT
    @incomingCount += COALESCE(SUM(IsIncoming), 0),
    @historyCount += COUNT(*)
  FROM (
    SELECT
      CASE WHEN ${N_INCOMING} THEN 1 ELSE 0 END AS IsIncoming
    ${N.SOURCE} WHERE ${N.OWNED} AND ${N_FILTERS}
  ) AS members;
  `}

  SELECT @incomingCount AS IncomingCount, @sentCount AS SentCount, @historyCount AS HistoryCount;
  -- Atama Koordinasyonu sekmesinin süzgeçsiz "Tüm kayıtlar" sayısı: sekme
  -- kendi bağımsız süzgeçleriyle açıldığında aynı sayıyı readCoordinationPage verir.
  ${scheduleOnly ? 'SELECT 0 AS CoordinationCount;' :
    `SELECT COUNT(*) AS CoordinationCount ${C.COUNT_SOURCE} WHERE ${C.PARTICIPANT};`}

  DECLARE @total int = CASE
    WHEN @tab = 'pending' THEN @incomingCount
    WHEN @tab = 'sent' THEN @sentCount
    ELSE @historyCount
  END;
  DECLARE @lastPage int = CASE WHEN @total = 0 THEN 0 ELSE (@total - 1) / @pageSize END;
  DECLARE @safePage int = @page, @useCursor bit = @hasCursor;
  DECLARE @windowSize int, @pageAttempt int = 0;
  DECLARE @cursorSortAt datetime2(7) = CONVERT(datetime2(7), @cursorTimestamp, 126);
  DECLARE @pageCandidates TABLE (
    Source varchar(30) NOT NULL, ItemId uniqueidentifier NOT NULL, SortAt datetime2(7) NOT NULL,
    Actionable bit NOT NULL, ItemVersion binary(8) NULL, UnreadFlag bit NOT NULL,
    PRIMARY KEY (Source, ItemId));

  -- İmleç sonrasında kayıt kaldığında toplam değişse de konumu koru.
  -- Boşalan sınırda bir kez konuma göre oku; bu okumada sayfayı sınırla.
  WHILE @pageAttempt < 2
  BEGIN
    SET @pageAttempt += 1;
    IF @useCursor = 0 AND @page > @lastPage SET @safePage = @lastPage;
    SET @windowSize = CASE WHEN @useCursor = 1 THEN @pageSize + 1 ELSE (@safePage + 1) * @pageSize + 1 END;
    IF @category IS NULL OR @category = 'SCHEDULE_REQUEST'
    INSERT @pageCandidates
    SELECT TOP (@windowSize) 'SCHEDULE_REQUEST', r.RequestId, ${S_SORT_AT},
      ${S_ACTIONABLE_BIT}, r.RowVersion, CASE WHEN ${S.UNREAD} THEN 1 ELSE 0 END
    ${S.SOURCE}
    WHERE ${S.PARTICIPANT} AND ${S_FILTERS}
      AND ((@tab = 'pending' AND ${S_INCOMING}) OR (@tab = 'sent' AND ${S_SENT}) OR (@tab = 'history' AND ${S_HISTORY}))
      AND ${cursorAfter(S_ACTIONABLE_BIT, S_SORT_AT, 'SCHEDULE_REQUEST', 'r.RequestId')}
    ORDER BY ${S_ACTIONABLE_BIT} DESC, ${S_SORT_AT} DESC, r.RequestId DESC;

    ${scheduleOnly ? '' : `
    IF @category IS NULL OR @category IN ('ASSIGNMENT_REQUEST', 'ASSIGNMENT_NOTICE')
    INSERT @pageCandidates
    SELECT TOP (@windowSize) 'ASSIGNMENT_COORDINATION', c.CoordinationId, ${C_SORT_AT},
      ${C_ACTIONABLE_BIT}, c.RowVersion, CASE WHEN ${C.UNREAD} THEN 1 ELSE 0 END
    ${C.SOURCE}
    WHERE ${C.PARTICIPANT} AND ${C_FILTERS}
      AND ((@tab = 'pending' AND ${C_INCOMING}) OR (@tab = 'sent' AND ${C_SENT}) OR (@tab = 'history' AND ${C_HISTORY}))
      AND ${cursorAfter(C_ACTIONABLE_BIT, C_SORT_AT, 'ASSIGNMENT_COORDINATION', 'c.CoordinationId')}
    ORDER BY ${C_ACTIONABLE_BIT} DESC, ${C_SORT_AT} DESC, c.CoordinationId DESC;

    IF @status IS NULL AND @tab <> 'sent' AND (@category IS NULL OR @category IN ('TASK_ASSIGNED', 'TASK_UNASSIGNED'))
    INSERT @pageCandidates
    SELECT TOP (@windowSize) 'TASK_EVENT', n.NotificationId, n.OccurredAt,
      0, n.RowVersion, CASE WHEN ${N.UNREAD} THEN 1 ELSE 0 END
    ${N.SOURCE}
    WHERE ${N.OWNED} AND ${N_FILTERS}
      AND ((@tab = 'pending' AND ${N_INCOMING}) OR @tab = 'history')
      AND ${cursorAfter('0', 'n.OccurredAt', 'TASK_EVENT', 'n.NotificationId')}
    ORDER BY n.OccurredAt DESC, n.NotificationId DESC;
    `}

    IF @useCursor = 0 OR EXISTS (SELECT 1 FROM @pageCandidates) BREAK;
    SET @useCursor = 0;
  END;
  SELECT @total AS Total, @safePage AS Page, @useCursor AS CursorUsed;

  DECLARE @pageItems TABLE (
    Ordinal int NOT NULL PRIMARY KEY, Source varchar(30) NOT NULL, ItemId uniqueidentifier NOT NULL,
    SortAt datetime2(7) NOT NULL, ItemVersion binary(8) NULL, UnreadFlag bit NOT NULL, ActionableFlag bit NOT NULL);
  -- Bir ek aday, sayaçlar değişse de bir sonraki sayfanın varlığını gösterir.
  DECLARE @offset int = CASE WHEN @useCursor = 1 THEN 0 ELSE @safePage * @pageSize END;
  INSERT @pageItems(Ordinal, Source, ItemId, SortAt, ItemVersion, UnreadFlag, ActionableFlag)
  SELECT ROW_NUMBER() OVER (ORDER BY Actionable DESC, SortAt DESC, Source, ItemId DESC),
    Source, ItemId, SortAt, ItemVersion, UnreadFlag, Actionable
  FROM @pageCandidates
  ORDER BY Actionable DESC, SortAt DESC, Source, ItemId DESC
  OFFSET @offset ROWS FETCH NEXT (@pageSize + 1) ROWS ONLY;

  SELECT Ordinal, Source, ItemId, ItemVersion, UnreadFlag, ActionableFlag,
    CONVERT(varchar(27), SortAt, 126) AS CursorSortAt
  FROM @pageItems ORDER BY Ordinal;

  SELECT ${S.FIELDS} ${S.SOURCE}
  WHERE r.RequestId IN (SELECT ItemId FROM @pageItems WHERE Source = 'SCHEDULE_REQUEST') AND ${S.PARTICIPANT};
  ${scheduleOnly ? '' : `
  SELECT ${C.FIELDS} ${C.SOURCE}
  WHERE c.CoordinationId IN (SELECT ItemId FROM @pageItems WHERE Source = 'ASSIGNMENT_COORDINATION') AND ${C.PARTICIPANT};
  SELECT ${N.FIELDS} ${N.SOURCE}
  WHERE n.NotificationId IN (SELECT ItemId FROM @pageItems WHERE Source = 'TASK_EVENT') AND ${N.OWNED};
  `}
`;

const REQUEST_INBOX_SQL = requestInboxSql(false);
// 0015 öncesinde de Gelenler ölçütü ile tarih talebi sayaçları aynı kalır.
const SCHEDULE_ONLY_INBOX_SQL = requestInboxSql(true);

function idKey(value) {
  return canonicalActualId(value) ?? String(value || '').toLowerCase();
}

function scheduleItem(row, sicil) {
  return { ...mapRequest(row, sicil), source: NOTIFICATION_SOURCES.SCHEDULE_REQUEST };
}

function itemBelongsToTab(item, tab, actorSicil) {
  if (!item) return false;
  if (tab === REQUEST_INBOX_TABS.INCOMING) {
    if (item.source === NOTIFICATION_SOURCES.TASK_EVENT) {
      return Boolean(item.unread) && item.taskAvailable !== false;
    }
    if (isInboxItemActionable(item)) return true;
    const ownPending = String(item.requesterSicil ?? '') === String(actorSicil) && item.status === 'PENDING';
    return Boolean(item.unread) && item.taskAvailable !== false && !ownPending;
  }
  if (tab === REQUEST_INBOX_TABS.SENT) {
    if (item.source === NOTIFICATION_SOURCES.TASK_EVENT) return false;
    if (item.source === NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION) {
      return String(item.requesterSicil ?? '') === String(actorSicil) && item.mode === 'REQUEST';
    }
    return String(item.requesterSicil ?? '') === String(actorSicil);
  }
  if (item.source === NOTIFICATION_SOURCES.TASK_EVENT || item.taskAvailable === false) return true;
  if (item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST) return item.status !== 'PENDING';
  return item.status !== 'PENDING' && item.status !== 'CANCELLATION_REQUESTED';
}

function hasPageSnapshotDrift(order, details, tab, actorSicil) {
  for (const entry of order) {
    const detail = details.get(`${entry.Source}:${idKey(entry.ItemId)}`);
    if (!detail) return true;
    if (!itemBelongsToTab(detail, tab, actorSicil)) return true;
    if (entry.ItemVersion != null) {
      const expectedVersion = Buffer.isBuffer(entry.ItemVersion)
        ? encodeVersion(entry.ItemVersion)
        : String(entry.ItemVersion);
      if (detail.version && expectedVersion && detail.version !== expectedVersion) return true;
    }
    if (entry.UnreadFlag != null && Boolean(detail.unread) !== Boolean(entry.UnreadFlag)) return true;
    if (entry.ActionableFlag != null && isInboxItemActionable(detail) !== Boolean(entry.ActionableFlag)) return true;
  }
  return false;
}

export async function readRequestInboxPage(executor, actor, input = {}, attempt = 0, scheduleOnly = false) {
  const query = normalizeRequestInboxQuery(input);
  const fromUtc = query.from ? activityDateRange({ period: 'custom', from: query.from, to: query.from }).startUtc : null;
  const toUtc = query.to ? activityDateRange({ period: 'custom', from: query.to, to: query.to }).endUtc : null;
  // `@sicil`, `@isSystemAdmin` ve `@fullProjectIds` oturum bağlamından gelir;
  // üç kaynağın yüklemleri de bu tek bağlamla çalışır.
  const request = bindCoordinationScope(executor.request(), actor);
  request.input('tab', sql.VarChar(10), query.tab);
  request.input('page', sql.Int, query.page);
  request.input('pageSize', sql.Int, query.pageSize);
  request.input('search', sql.NVarChar(200), query.search);
  request.input('requester', sql.NVarChar(100), query.requester);
  request.input('projectId', sql.UniqueIdentifier, query.projectId);
  request.input('status', sql.VarChar(25), query.status);
  request.input('category', sql.VarChar(30), query.category);
  request.input('fromUtc', sql.DateTime2, fromUtc);
  request.input('toUtc', sql.DateTime2, toUtc);
  request.input('hasCursor', sql.Bit, query.page > 0 && query.cursor && !query.cursor.legacy ? 1 : 0);
  request.input('cursorActionable', sql.Bit, query.cursor ? query.cursor.actionable : 0);
  request.input('cursorTimestamp', sql.VarChar(27), query.cursor?.sortAt ?? null);
  request.input('cursorSource', sql.VarChar(30), query.cursor ? query.cursor.source : '');
  request.input('cursorItemId', sql.UniqueIdentifier, query.cursor ? query.cursor.id : null);
  let result;
  try {
    result = await request.query(scheduleOnly ? SCHEDULE_ONLY_INBOX_SQL : REQUEST_INBOX_SQL);
  } catch (error) {
    if (!scheduleOnly && isMissingNotificationInboxSchema(error)) {
      return readRequestInboxPage(executor, actor, input, attempt, true);
    }
    throw error;
  }
  const sets = result.recordsets || [];
  const counts = sets[0]?.[0] || {};
  const coordination = sets[1]?.[0] || {};
  const pagination = sets[2]?.[0] || {};
  const order = sets[3] || [];
  const details = new Map();
  for (const row of sets[4] || []) details.set(`${NOTIFICATION_SOURCES.SCHEDULE_REQUEST}:${idKey(row.RequestId)}`, scheduleItem(row, actor.sicil));
  for (const row of sets[5] || []) details.set(`${NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION}:${idKey(row.CoordinationId)}`, mapCoordination(row, actor.sicil));
  for (const row of sets[6] || []) details.set(`${NOTIFICATION_SOURCES.TASK_EVENT}:${idKey(row.NotificationId)}`, mapTaskNotification(row));
  // Sayfa üyeliği ile ayrıntı okuması arasında eşzamanlı bir yazma satırı
  // değiştirdiyse tutarlı bir okuma için sınırlı olarak bir kez yinelenir.
  if (attempt === 0 && (hasPageSnapshotDrift(order, details, query.tab, actor.sicil)
    || (!order.length && Number(pagination.Total) > 0))) {
    return readRequestInboxPage(executor, actor, input, 1, scheduleOnly);
  }
  const matched = order
    .map((entry) => ({ entry, item: details.get(`${entry.Source}:${idKey(entry.ItemId)}`) }))
    .filter(({ item }) => itemBelongsToTab(item, query.tab, actor.sicil));
  const items = matched.slice(0, query.pageSize).map(({ item }) => item);
  const boundary = matched[query.pageSize - 1];
  const total = Number(pagination.Total || 0);
  const page = Number(pagination.Page || 0);
  return {
    items,
    total,
    page,
    pageSize: query.pageSize,
    hasNext: matched.length > query.pageSize,
    nextCursor: matched.length > query.pageSize ? encodeRequestInboxCursor(boundary.item, boundary.entry) : null,
    cursorReset: Boolean(query.cursor && !pagination.CursorUsed),
    counts: {
      pending: Number(counts.IncomingCount || 0),
      sent: Number(counts.SentCount || 0),
      history: Number(counts.HistoryCount || 0),
      coordination: Number(coordination.CoordinationCount || 0)
    }
  };
}

export async function queryRequestInbox(input) {
  return withSqlTransaction(async (executor) =>
    readRequestInboxPage(executor, await loadAuthorizationContext(executor), input));
}
