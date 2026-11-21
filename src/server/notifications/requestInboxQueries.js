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
import { mapRequest } from '../schedule-change/scheduleRequestMapping.js';
import { SCHEDULE_REQUEST_SQL, readSchedulePage } from '../schedule-change/scheduleRequestQueries.js';
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
 *   · Gelenler: kararınızı bekleyen kayıtlar + okunmamış ve temizlenmemiş
 *     bildirimler. Okundu işareti bilgilendirme satırını buradan çıkarır; karar
 *     bekleyen kayıt okunsa da kalır. Kullanıcının kendi açık talebi gelen
 *     sayılmaz (Gönderdiklerim'dedir); sonuçlandığında yanıtı gelen olur.
 *   · Gönderdiklerim: kullanıcının gönderdiği tarih ve atama talepleri. Olay
 *     bildirimleri ve doğrudan atama bildirimleri (NOTICE) talep sayılmaz.
 *   · Geçmiş: sonuçlanan talepler ile atama olaylarının tamamı. Okundu/
 *     temizlendi durumundan BAĞIMSIZDIR: okumak silmek değildir.
 */

const SCHEDULE_STATUS_CODES = new Set(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'STALE']);
const STATUS_CODES = new Set([...SCHEDULE_STATUS_CODES, ...Object.keys(COORDINATION_STATUSES)]);
const CATEGORY_CODES = new Set(Object.values(REQUEST_INBOX_CATEGORIES));

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
  return {
    tab, page, pageSize, projectId, status, category, from, to,
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

/**
 * Her kaynak satırını ORTAK anahtara indirger: kaynak, kimlik, sıralama zamanı
 * ve sekme bayrakları. Sayfa yalnızca bu anahtarlarla kesilir; ayrıntı satırı
 * ancak sayfadaki kimlikler için ve kaynağın kendi alan listesiyle okunur.
 */
const REQUEST_INBOX_SQL = `
  /* rota-request-inbox */
  DECLARE @items TABLE (
    Source varchar(30) NOT NULL, ItemId uniqueidentifier NOT NULL, SortAt datetime2 NULL,
    Actionable bit NOT NULL, IsIncoming bit NOT NULL, IsSent bit NOT NULL, IsHistory bit NOT NULL,
    PRIMARY KEY (Source, ItemId));

  IF @category IS NULL OR @category = 'SCHEDULE_REQUEST'
  INSERT @items
  SELECT 'SCHEDULE_REQUEST', r.RequestId, COALESCE(r.DecidedAt, r.CreatedAt),
    CASE WHEN ${S.ACTIONABLE} THEN 1 ELSE 0 END,
    CASE WHEN ${S.ACTIONABLE} OR (${S.UNREAD} AND ${S.VISIBLE} AND ${SCHEDULE_AVAILABLE}
      AND NOT (r.RequesterSicil = @sicil AND r.Status = 'PENDING')) THEN 1 ELSE 0 END,
    CASE WHEN r.RequesterSicil = @sicil THEN 1 ELSE 0 END,
    CASE WHEN r.Status <> 'PENDING' OR NOT ${SCHEDULE_AVAILABLE} THEN 1 ELSE 0 END
  ${S.SOURCE}
  WHERE ${S.PARTICIPANT}
    AND (@projectId IS NULL OR COALESCE(r.ProjectIdSnapshot, t.ProjectId) = @projectId)
    AND (@status IS NULL OR r.Status = @status)
    AND (@fromUtc IS NULL OR r.CreatedAt >= @fromUtc)
    AND (@toUtc IS NULL OR r.CreatedAt < @toUtc)
    AND (@requester = '' OR ${matches('@requester', 'requester.DisplayName')}
      OR CONVERT(varchar(20), r.RequesterSicil) = @requester)
    AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(COALESCE(r.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(r.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(r.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', r.RequesterMessage)`)}) > 0);

  IF @category IS NULL OR @category IN ('ASSIGNMENT_REQUEST', 'ASSIGNMENT_NOTICE')
  INSERT @items
  SELECT 'ASSIGNMENT_COORDINATION', c.CoordinationId, COALESCE(c.DecidedAt, c.CreatedAt),
    CASE WHEN ${C.ACTIONABLE} THEN 1 ELSE 0 END,
    CASE WHEN ${C.ACTIONABLE} OR (${C.UNREAD} AND ${C.VISIBLE} AND ${C.TASK_AVAILABLE}
      AND NOT (c.RequesterSicil = @sicil AND c.Status = 'PENDING')) THEN 1 ELSE 0 END,
    CASE WHEN c.RequesterSicil = @sicil AND c.Mode = 'REQUEST' THEN 1 ELSE 0 END,
    CASE WHEN c.Status NOT IN ('PENDING','CANCELLATION_REQUESTED') OR NOT ${C.TASK_AVAILABLE} THEN 1 ELSE 0 END
  ${C.SOURCE}
  WHERE ${C.PARTICIPANT}
    AND (@category IS NULL OR (@category = 'ASSIGNMENT_REQUEST' AND c.Mode = 'REQUEST')
      OR (@category = 'ASSIGNMENT_NOTICE' AND c.Mode = 'NOTICE'))
    AND (@projectId IS NULL OR COALESCE(t.ProjectId, c.ProjectIdSnapshot) = @projectId)
    AND (@status IS NULL OR c.Status = @status)
    AND (@fromUtc IS NULL OR c.CreatedAt >= @fromUtc)
    AND (@toUtc IS NULL OR c.CreatedAt < @toUtc)
    AND (@requester = '' OR ${matches('@requester', 'requester.DisplayName')}
      OR CONVERT(varchar(20), c.RequesterSicil) = @requester)
    AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(COALESCE(c.TaskTitleSnapshot, t.Title), ' ',
      COALESCE(c.ProjectNameSnapshot, p.ProjectName), ' ', COALESCE(c.ProjectCodeSnapshot, p.ProjectCode), ' ',
      requester.DisplayName, ' ', COALESCE(assignee.DisplayName, c.AssigneeNameSnapshot), ' ',
      c.RequesterMessage)`)}) > 0);

  IF @status IS NULL AND (@category IS NULL OR @category IN ('TASK_ASSIGNED', 'TASK_UNASSIGNED'))
  INSERT @items
  SELECT 'TASK_EVENT', n.NotificationId, n.OccurredAt,
    0,
    CASE WHEN ${N.UNREAD} AND ${N.VISIBLE} AND ${N.TASK_AVAILABLE} THEN 1 ELSE 0 END,
    0,
    1
  ${N.SOURCE}
  WHERE ${N.OWNED}
    AND (@category IS NULL OR n.Kind = @category)
    AND (@projectId IS NULL OR COALESCE(n.ProjectIdSnapshot, t.ProjectId) = @projectId)
    AND (@fromUtc IS NULL OR n.OccurredAt >= @fromUtc)
    AND (@toUtc IS NULL OR n.OccurredAt < @toUtc)
    AND (@requester = '' OR ${matches('@requester', 'COALESCE(n.ActorNameSnapshot, actor.DisplayName)')}
      OR CONVERT(varchar(20), n.ActorSicil) = @requester)
    AND (@search = '' OR CHARINDEX(@search, ${text(`CONCAT(n.TaskTitleSnapshot, ' ', n.ProjectNameSnapshot, ' ',
      n.ProjectCodeSnapshot, ' ', COALESCE(n.ActorNameSnapshot, actor.DisplayName))`)}) > 0);

  SELECT COALESCE(SUM(CAST(IsIncoming AS int)), 0) AS IncomingCount,
    COALESCE(SUM(CAST(IsSent AS int)), 0) AS SentCount,
    COALESCE(SUM(CAST(IsHistory AS int)), 0) AS HistoryCount
  FROM @items;
  -- Atama Koordinasyonu sekmesinin süzgeçsiz "Tüm kayıtlar" sayısı: sekme
  -- kendi süzgeçleriyle açıldığında aynı sayıyı readCoordinationPage verir.
  SELECT COUNT(*) AS CoordinationCount ${C.COUNT_SOURCE} WHERE ${C.PARTICIPANT};

  DECLARE @pageItems TABLE (Ordinal int NOT NULL PRIMARY KEY, Source varchar(30) NOT NULL, ItemId uniqueidentifier NOT NULL);
  DECLARE @total int = (SELECT COUNT(*) FROM @items WHERE (@tab = 'pending' AND IsIncoming = 1)
    OR (@tab = 'sent' AND IsSent = 1) OR (@tab = 'history' AND IsHistory = 1));
  DECLARE @lastPage int = CASE WHEN @total = 0 THEN 0 ELSE (@total - 1) / @pageSize END;
  DECLARE @safePage int = CASE WHEN @page > @lastPage THEN @lastPage ELSE @page END;
  SELECT @total AS Total, @safePage AS Page;
  -- Belirlenimci sıra: karar bekleyen önce, sonra en yeni; eşitlikte kaynak
  -- ve kimlik. Sayfalar arasında yinelenen ya da kaybolan satır olmaz.
  INSERT @pageItems(Ordinal, Source, ItemId)
  SELECT ROW_NUMBER() OVER (ORDER BY Actionable DESC, SortAt DESC, Source, ItemId DESC), Source, ItemId
  FROM @items
  WHERE (@tab = 'pending' AND IsIncoming = 1) OR (@tab = 'sent' AND IsSent = 1) OR (@tab = 'history' AND IsHistory = 1)
  ORDER BY Actionable DESC, SortAt DESC, Source, ItemId DESC
  OFFSET (@safePage * @pageSize) ROWS FETCH NEXT @pageSize ROWS ONLY;
  SELECT Ordinal, Source, ItemId FROM @pageItems ORDER BY Ordinal;

  SELECT ${S.FIELDS} ${S.SOURCE}
  WHERE r.RequestId IN (SELECT ItemId FROM @pageItems WHERE Source = 'SCHEDULE_REQUEST') AND ${S.PARTICIPANT};
  SELECT ${C.FIELDS} ${C.SOURCE}
  WHERE c.CoordinationId IN (SELECT ItemId FROM @pageItems WHERE Source = 'ASSIGNMENT_COORDINATION') AND ${C.PARTICIPANT};
  SELECT ${N.FIELDS} ${N.SOURCE}
  WHERE n.NotificationId IN (SELECT ItemId FROM @pageItems WHERE Source = 'TASK_EVENT') AND ${N.OWNED};
`;

function idKey(value) {
  return canonicalActualId(value) ?? String(value || '').toLowerCase();
}

function scheduleItem(row, sicil) {
  return { ...mapRequest(row, sicil), source: NOTIFICATION_SOURCES.SCHEDULE_REQUEST };
}

/**
 * Göç (0015) uygulanmamış kurulumda Talepler eskisi gibi yalnızca tarih
 * taleplerini gösterir; görev yazması ve zil etkilenmez.
 */
async function readScheduleOnlyPage(executor, actor, query) {
  const empty = { items: [], total: 0, page: 0, pageSize: query.pageSize, counts: { pending: 0, sent: 0, history: 0, coordination: 0 } };
  if ((query.status && !SCHEDULE_STATUS_CODES.has(query.status))
    || (query.category && query.category !== REQUEST_INBOX_CATEGORIES.SCHEDULE_REQUEST)) return empty;
  const page = await readSchedulePage(executor, actor, {
    tab: query.tab, page: query.page, pageSize: query.pageSize, search: query.search,
    projectId: query.projectId, requester: query.requester, status: query.status, from: query.from, to: query.to
  });
  return {
    ...page,
    items: page.items.map((item) => ({ ...item, source: NOTIFICATION_SOURCES.SCHEDULE_REQUEST })),
    counts: { ...page.counts, coordination: 0 }
  };
}

export async function readRequestInboxPage(executor, actor, input = {}) {
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
  let result;
  try {
    result = await request.query(REQUEST_INBOX_SQL);
  } catch (error) {
    if (isMissingNotificationInboxSchema(error)) return readScheduleOnlyPage(executor, actor, query);
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
  return {
    items: order.map((entry) => details.get(`${entry.Source}:${idKey(entry.ItemId)}`)).filter(Boolean),
    total: Number(pagination.Total || 0),
    page: Number(pagination.Page || 0),
    pageSize: query.pageSize,
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
