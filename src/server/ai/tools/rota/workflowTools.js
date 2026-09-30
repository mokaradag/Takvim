import 'server-only';
import { COORDINATION_MODES, COORDINATION_STATUS_LABELS, COORDINATION_STATUSES } from '../../../../domain/assignment/assignmentCoordination.js';
import { TASK_NOTIFICATION_KINDS } from '../../../../domain/notifications/notificationInbox.js';
import { SCHEDULE_STATUS_LABELS } from '../../../../features/notifications/notificationCenterItems.js';
import { readCoordinationPage } from '../../../assignment/assignmentCoordinationQueries.js';
import { isMissingNotificationInboxSchema, readNotificationInbox } from '../../../notifications/notificationInboxQueries.js';
import { readTaskActivityReport } from '../../../reports/taskActivityReport.js';
import { readScheduleInbox, readSchedulePage } from '../../../schedule-change/scheduleRequestQueries.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import {
  CURSOR_PROPERTY,
  currentUserScope,
  DATE_PROPERTY,
  dataText,
  ID_PROPERTY,
  LIMIT_PROPERTY,
  participantScope,
  PERSON_SICIL_PROPERTY,
  requireVisibleProject,
  searchedScope
} from './rotaToolSupport.js';
import { isCompleteTaskView, projectAccess } from './rotaScope.js';
import { decodeCursor, encodeCursor } from './taskFacts.js';

/**
 * İş akışı araçları Rota'nın VAR OLAN okuma hizmetlerini kullanır: yetki
 * (katılımcı kuralı, canlı karar yetkisi, görünür görev kuralı) bu hizmetlerin
 * kendisindedir ve burada yeniden yazılmaz. Hiçbir araç okundu/temizlendi
 * işareti koymaz, karar vermez, talep açmaz.
 */

function pageOf(tool, key, cursor, pageSize) {
  const offset = decodeCursor(tool, key, cursor ?? null);
  if (offset % pageSize !== 0) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:invalid'] });
  return offset / pageSize;
}

function pageWindow(tool, key, page, pageSize, total) {
  const nextOffset = (page + 1) * pageSize;
  const complete = nextOffset >= total;
  const nextCursor = !complete && nextOffset <= TOOL_LIMITS.maxCursorOffset
    ? encodeCursor(tool, key, nextOffset)
    : null;
  return { nextCursor, complete, truncated: !complete && !nextCursor };
}

function clippedLines(lines, max = 6, { hideAssigneeNames = false } = {}) {
  const list = (lines || []).map((line) => {
    const value = hideAssigneeNames
      ? String(line ?? '').replace(/^(Sorumlu (?:eklendi|çıkarıldı)):\s*.*$/u, '$1: Gizli sorumlu')
      : line;
    return dataText(value, 160);
  });
  return { changes: list.slice(0, max), ...(list.length > max ? { moreChanges: list.length - max } : {}) };
}

/* ── rota_activity_search ─────────────────────────────────── */

const ACTIVITY_KIND_LABELS = Object.freeze({ created: 'Oluşturuldu', updated: 'Güncellendi', completed: 'Tamamlandı', deleted: 'Silindi' });
const ACTIVITY_PERIODS = Object.freeze({ today: 'today', yesterday: 'yesterday', last_7_days: 'week', custom: 'custom' });

const activitySearch = {
  name: 'rota_activity_search',
  version: 1,
  topic: 'activity',
  evidenceKind: 'activity',
  authorization: 'Görev Hareketleri raporunun kuralı: görünür görevlerin denetim kayıtları; ekip kapsamı yalnızca yöneticilere açıktır.',
  description: 'Görev hareket geçmişi (oluşturma, güncelleme, tamamlama, silme) — kim, ne zaman, neyi değiştirdi; değişiklikler iş diliyle. Tarih aralığı Türkiye günüdür ve en fazla 366 gündür. "Dün kim ne yaptı", "bu görevde son ne değişti" gibi sorularda kullanın.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      period: { type: 'string', enum: Object.keys(ACTIVITY_PERIODS), description: 'today (varsayılan), yesterday, last_7_days (bugün dahil 7 gün), custom (dateFrom/dateTo ile).' },
      dateFrom: DATE_PROPERTY('custom dönemin ilk günü (YYYY-MM-DD).'),
      dateTo: DATE_PROPERTY('custom dönemin son günü (YYYY-MM-DD, dahil; verilmezse dateFrom).'),
      scope: { type: 'string', enum: ['visible', 'mine', 'team'], description: 'visible = görebildiğiniz bütün görevler (varsayılan), mine = yalnızca sizin yaptıklarınız, team = yönetim kapsamınızdaki çalışanlar (yalnızca yöneticiler).' },
      projectId: ID_PROPERTY('Yalnızca bu proje.'),
      taskId: ID_PROPERTY('Yalnızca bu görev.'),
      personSicil: PERSON_SICIL_PROPERTY,
      kind: { type: 'string', enum: Object.keys(ACTIVITY_KIND_LABELS), description: 'Hareket türü.' },
      limit: LIMIT_PROPERTY(20, 10),
      cursor: CURSOR_PROPERTY
    }
  },
  async handler(args, call) {
    const period = args.period || (args.dateFrom ? 'custom' : 'today');
    if (period === 'custom' && !args.dateFrom) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateFrom:required'] });
    if (period !== 'custom' && (args.dateFrom || args.dateTo)) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.period:custom'] });
    if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateFrom:reversed'] });
    const pageSize = args.limit ?? 10;
    const key = { period, dateFrom: args.dateFrom || null, dateTo: args.dateTo || null, scope: args.scope || 'visible', projectId: args.projectId || null,
      taskId: args.taskId || null, personSicil: args.personSicil ?? null, kind: args.kind || null, pageSize };
    const page = pageOf('rota_activity_search', key, args.cursor, pageSize);
    const { auth, scope } = await call.authorization();
    if (key.scope === 'team' && !auth.isExecutive && !auth.isSystemAdmin) throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Ekip kapsamı yalnızca yönetim kapsamı olan kullanıcılara açıktır.'
    });
    if (key.projectId) requireVisibleProject(scope, key.projectId);
    const report = await call.sql((executor) => readTaskActivityReport(executor, auth, {
      period: ACTIVITY_PERIODS[period],
      from: key.dateFrom,
      to: key.dateTo || key.dateFrom,
      scope: key.scope,
      projectId: key.projectId,
      taskId: key.taskId,
      person: key.personSicil,
      kind: key.kind || '',
      page,
      pageSize
    }, call.now));
    if (report.page !== page) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:stale'] });
    const items = report.items.map((item) => {
      const access = item.projectId ? projectAccess(scope, item.projectId) : null;
      const hideAssigneeNames = !scope.isAdmin && !isCompleteTaskView(access);
      return {
        occurredAt: item.occurredAt,
        actor: dataText(item.actorName, 120),
        kind: item.kind,
        kindLabel: ACTIVITY_KIND_LABELS[item.kind] || item.kind,
        task: {
          ...(item.taskAvailable ? { taskId: item.taskId } : {}),
          title: dataText(item.taskTitle, 160),
          available: Boolean(item.taskAvailable)
        },
        project: { name: dataText(item.projectName, 160), ...(item.projectCode ? { code: dataText(item.projectCode, 60) } : {}) },
        ...clippedLines(item.changes, 6, { hideAssigneeNames }),
        ...(item.detailsLimited ? { detailsLimited: true } : {})
      };
    });
    const pageState = pageWindow('rota_activity_search', key, page, pageSize, report.total);
    const detailsLimited = items.some((item) => item.detailsLimited || Number(item.moreChanges || 0) > 0);
    return {
      data: {
        range: report.range,
        scope: report.scope,
        summary: { events: report.total, tasks: report.summary.tasks, people: report.summary.people, completedTasks: report.summary.completed },
        items
      },
      scope: searchedScope(scope, key.projectId),
      complete: pageState.complete && !detailsLimited,
      truncated: pageState.truncated || detailsLimited,
      returnedCount: items.length,
      totalCount: report.total,
      nextCursor: pageState.nextCursor,
      evidence: {
        label: `Hareket geçmişi · ${report.total} hareket`,
        entity: key.taskId ? { type: 'task', id: key.taskId, name: items[0]?.task.title || null } : (key.projectId ? { type: 'project', id: key.projectId, name: null } : null),
        highlights: [`${report.range.from} – ${report.range.to}`, `Görev: ${report.summary.tasks}`, `Kişi: ${report.summary.people}`]
      }
    };
  }
};

/* ── rota_schedule_requests ───────────────────────────────── */

const SCHEDULE_STATUSES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'STALE']);

function dateChanges(request) {
  const changes = {};
  for (const [field, original, proposed] of [
    ['plannedStart', request.originalPlannedStart, request.proposedPlannedStart],
    ['plannedFinish', request.originalPlannedFinish, request.proposedPlannedFinish],
    ['targetFinish', request.originalTargetFinish, request.proposedTargetFinish]
  ]) {
    if (original !== proposed) changes[field] = { from: original, to: proposed };
  }
  return changes;
}

const scheduleRequests = {
  name: 'rota_schedule_requests',
  version: 1,
  topic: 'requests',
  evidenceKind: 'schedule-requests',
  authorization: 'Yalnızca kullanıcının talep eden ya da karar sahibi olduğu tarih değişikliği talepleri (Talepler ekranıyla aynı).',
  description: 'Tarih değişikliği taleplerini salt okunur listeler: kararınızı bekleyenler, gönderdikleriniz ve geçmiş; önerilen tarih değişiklikleri ve iletiler. Talep açmaz, karar vermez, okundu işaretlemez.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tab: { type: 'string', enum: ['pending', 'sent', 'history', 'all'], description: 'pending = kararınızı bekleyen, sent = gönderdikleriniz, history = sonuçlananlar, all = hepsi (varsayılan).' },
      status: { type: 'string', enum: [...SCHEDULE_STATUSES], description: 'Talep durumu.' },
      projectId: ID_PROPERTY('Yalnızca bu proje.'),
      taskId: ID_PROPERTY('Yalnızca bu görev.'),
      dateFrom: DATE_PROPERTY('Talep oluşturma tarihi alt sınırı (Türkiye günü, dahil).'),
      dateTo: DATE_PROPERTY('Talep oluşturma tarihi üst sınırı (Türkiye günü, dahil).'),
      text: { type: 'string', minLength: 1, maxLength: 100, description: 'Görev/proje adı, talep eden ya da iletide geçen metin.' },
      limit: LIMIT_PROPERTY(25, 10),
      cursor: CURSOR_PROPERTY
    }
  },
  async handler(args, call) {
    if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateFrom:reversed'] });
    const pageSize = args.limit ?? 10;
    const key = { tab: args.tab || 'all', status: args.status || null, projectId: args.projectId || null, taskId: args.taskId || null,
      dateFrom: args.dateFrom || null, dateTo: args.dateTo || null, text: args.text || '', pageSize };
    const page = pageOf('rota_schedule_requests', key, args.cursor, pageSize);
    const { auth } = await call.authorization();
    const result = await call.sql((executor) => readSchedulePage(executor, auth, {
      tab: key.tab, status: key.status, projectId: key.projectId, taskId: key.taskId, from: key.dateFrom, to: key.dateTo,
      search: key.text, page, pageSize
    }));
    if (result.page !== page) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:stale'] });
    const items = result.items.map((request) => {
      const awaiting = request.status === 'PENDING' && request.isDecisionOwner && request.taskAvailable;
      return {
        requestId: request.id,
        task: { ...(request.taskAvailable ? { taskId: request.taskId } : {}), title: dataText(request.taskTitle, 160), available: request.taskAvailable },
        project: { name: dataText(request.projectName, 160), ...(request.projectCode ? { code: dataText(request.projectCode, 60) } : {}) },
        requester: dataText(request.requesterName, 120),
        decisionOwner: dataText(request.decisionOwnerName, 120),
        yourRole: request.isDecisionOwner && request.isRequester ? 'requester-and-decision-owner' : (request.isDecisionOwner ? 'decision-owner' : 'requester'),
        status: request.status,
        statusLabel: SCHEDULE_STATUS_LABELS[request.status] || request.status,
        awaitingYourDecision: awaiting,
        proposedChanges: dateChanges(request),
        requesterMessage: dataText(request.requesterMessage, 300),
        ...(request.decisionMessage ? { decisionMessage: dataText(request.decisionMessage, 300) } : {}),
        createdAt: request.createdAt,
        ...(request.decidedAt ? { decidedAt: request.decidedAt } : {})
      };
    });
    const pageState = pageWindow('rota_schedule_requests', key, page, pageSize, result.total);
    return {
      data: { counts: { awaitingYourDecision: result.counts.pending, sent: result.counts.sent, history: result.counts.history }, tab: key.tab, items },
      scope: participantScope('Yalnızca talep eden ya da karar sahibi olduğunuz talepler.'),
      complete: pageState.complete,
      truncated: pageState.truncated,
      returnedCount: items.length,
      totalCount: result.total,
      nextCursor: pageState.nextCursor,
      evidence: {
        label: `Tarih değişikliği talepleri · ${result.total} talep`,
        entity: null,
        highlights: [`Kararınızı bekleyen: ${result.counts.pending}`, `Gönderdiğiniz: ${result.counts.sent}`]
      }
    };
  }
};

/* ── rota_assignment_requests ─────────────────────────────── */

const assignmentRequests = {
  name: 'rota_assignment_requests',
  version: 1,
  topic: 'requests',
  evidenceKind: 'assignment-requests',
  authorization: 'Atama Koordinasyonu ekranının kuralı: talep eden, alıcı, CANLI karar yetkisi (sistem yöneticisi, güncel FULL proje yetkisi ya da güncel yönetim ilişkisi). Alıcı satırı tek başına yetki değildir.',
  description: 'Kurum dışı atama koordinasyonu kayıtlarını salt okunur listeler: onay bekleyen talepler, bildirimler ve geçmiş; kararın kimde olduğu ve kullanıcının karar verip veremeyeceği. Karar vermez, okundu işaretlemez.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tab: { type: 'string', enum: ['pending', 'sent', 'history', 'all'], description: 'pending = işlem bekleyen, sent = gönderdikleriniz, history = sonuçlananlar, all = hepsi (varsayılan).' },
      status: { type: 'string', enum: Object.keys(COORDINATION_STATUSES), description: 'Kayıt durumu.' },
      projectId: ID_PROPERTY('Yalnızca bu proje.'),
      taskId: ID_PROPERTY('Yalnızca bu görev.'),
      dateFrom: DATE_PROPERTY('Oluşturma tarihi alt sınırı (Türkiye günü, dahil).'),
      dateTo: DATE_PROPERTY('Oluşturma tarihi üst sınırı (Türkiye günü, dahil).'),
      text: { type: 'string', minLength: 1, maxLength: 100, description: 'Görev/proje adı, kişi adı ya da iletide geçen metin.' },
      limit: LIMIT_PROPERTY(25, 10),
      cursor: CURSOR_PROPERTY
    }
  },
  async handler(args, call) {
    if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateFrom:reversed'] });
    const pageSize = args.limit ?? 10;
    const key = { tab: args.tab || 'all', status: args.status || null, projectId: args.projectId || null, taskId: args.taskId || null,
      dateFrom: args.dateFrom || null, dateTo: args.dateTo || null, text: args.text || '', pageSize };
    const page = pageOf('rota_assignment_requests', key, args.cursor, pageSize);
    const { auth } = await call.authorization();
    let result;
    try {
      result = await call.sql((executor) => readCoordinationPage(executor, auth, {
        tab: key.tab, status: key.status, projectId: key.projectId, taskId: key.taskId, from: key.dateFrom, to: key.dateTo,
        search: key.text, page, pageSize
      }, { decisionAuthority: true }));
    } catch (error) {
      if (isMissingNotificationInboxSchema(error)) throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED, { message: 'Atama koordinasyonu bu kurulumda etkin değil.' });
      throw error;
    }
    if (result.page !== page) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:stale'] });
    const items = result.items.map((record) => ({
      coordinationId: record.id,
      mode: record.mode,
      modeLabel: record.mode === COORDINATION_MODES.NOTICE ? 'Bildirim (yürürlükte)' : 'Onay talebi',
      status: record.status,
      statusLabel: COORDINATION_STATUS_LABELS[record.status] || record.status,
      task: { ...(record.taskAvailable ? { taskId: record.taskId } : {}), title: dataText(record.taskTitle, 160), available: record.taskAvailable },
      project: { name: dataText(record.projectName, 160), ...(record.projectCode ? { code: dataText(record.projectCode, 60) } : {}) },
      requester: dataText(record.requesterName, 120),
      requestedAssignee: dataText(record.assigneeName, 120),
      ...(record.assigneeOrganization ? { requestedAssigneeOrganization: dataText(record.assigneeOrganization, 160) } : {}),
      ...(record.suggestedAssigneeName ? { suggestedAssignee: dataText(record.suggestedAssigneeName, 120) } : {}),
      ...(record.targetFinish ? { targetFinish: record.targetFinish } : {}),
      you: { requester: record.isRequester, requestedAssignee: record.isAssignee, canDecide: record.allowedDecisions.length > 0 },
      actionRequiredFromYou: record.actionable,
      ...(record.requesterMessage ? { requesterMessage: dataText(record.requesterMessage, 300) } : {}),
      ...(record.decisionMessage ? { decisionMessage: dataText(record.decisionMessage, 300) } : {}),
      ...(record.decisionByName ? { decidedBy: dataText(record.decisionByName, 120) } : {}),
      createdAt: record.createdAt,
      ...(record.decidedAt ? { decidedAt: record.decidedAt } : {})
    }));
    const pageState = pageWindow('rota_assignment_requests', key, page, pageSize, result.total);
    return {
      data: {
        counts: { actionRequired: result.counts.pending, sent: result.counts.sent, history: result.counts.history },
        tab: key.tab,
        items,
        note: 'Talep edilen sorumlu onaylanana kadar görevin sorumlusu değildir; iş yükü ve raporlar yalnızca gerçek sorumluyu sayar.'
      },
      scope: participantScope('Yalnızca katılımcısı olduğunuz ya da güncel karar yetkiniz bulunan kayıtlar.'),
      complete: pageState.complete,
      truncated: pageState.truncated,
      returnedCount: items.length,
      totalCount: result.total,
      nextCursor: pageState.nextCursor,
      evidence: {
        label: `Atama koordinasyonu · ${result.total} kayıt`,
        entity: null,
        highlights: [`İşlem bekleyen: ${result.counts.pending}`, `Gönderdiğiniz: ${result.counts.sent}`]
      }
    };
  }
};

/* ── rota_notifications ───────────────────────────────────── */

const TASK_EVENT_LABELS = Object.freeze({
  [TASK_NOTIFICATION_KINDS.TASK_ASSIGNED]: 'Göreve sorumlu olarak eklendiniz',
  [TASK_NOTIFICATION_KINDS.TASK_UNASSIGNED]: 'Görevin sorumluluğundan çıkarıldınız'
});

const notifications = {
  name: 'rota_notifications',
  version: 1,
  topic: 'notifications',
  evidenceKind: 'notifications',
  authorization: 'Yalnızca kullanıcının KENDİ bildirim zili (tarih talepleri, atama koordinasyonu, atama olayları).',
  description: 'Kullanıcının kendi bildirimlerini okur: okunmamış sayıları, kararını bekleyen kayıtlar ve son bildirimler. Bildirimleri okundu olarak İŞARETLEMEZ.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  async handler(args, call) {
    const { auth } = await call.authorization();
    const [schedule, inbox] = await call.sql(async (executor) => {
      const scheduleInbox = await readScheduleInbox(executor, auth);
      let combined = null;
      try {
        combined = await readNotificationInbox(executor, auth);
      } catch (error) {
        if (!isMissingNotificationInboxSchema(error)) throw error;
      }
      return [scheduleInbox, combined];
    });
    const scheduleItems = schedule.items.map((request) => ({
      source: 'schedule-request',
      title: dataText(request.taskTitle, 160),
      project: dataText(request.projectName, 160),
      statusLabel: SCHEDULE_STATUS_LABELS[request.status] || request.status,
      actionRequired: request.status === 'PENDING' && request.isDecisionOwner && request.taskAvailable,
      unread: request.unread,
      at: request.decidedAt || request.createdAt
    }));
    const coordinationItems = (inbox?.coordination.items || []).map((record) => ({
      source: 'assignment-coordination',
      title: dataText(record.taskTitle, 160),
      project: dataText(record.projectName, 160),
      statusLabel: COORDINATION_STATUS_LABELS[record.status] || record.status,
      requestedAssignee: dataText(record.assigneeName, 120),
      actionRequired: record.actionable,
      unread: record.unread,
      at: record.sortAt
    }));
    const eventItems = (inbox?.taskEvents.items || []).map((event) => ({
      source: 'task-event',
      label: TASK_EVENT_LABELS[event.kind] || 'Görev bildirimi',
      title: dataText(event.taskTitle, 160),
      project: dataText(event.projectName, 160),
      ...(event.actorName ? { by: dataText(event.actorName, 120) } : {}),
      ...(event.taskCount > 1 ? { taskCount: event.taskCount } : {}),
      unread: event.unread,
      at: event.occurredAt
    }));
    const unread = schedule.unreadCount + (inbox?.unreadCount || 0);
    const actionRequired = schedule.pendingCount + (inbox?.pendingCount || 0);
    return {
      data: {
        unreadCount: unread,
        actionRequiredCount: actionRequired,
        scheduleRequests: { unread: schedule.unreadCount, awaitingYourDecision: schedule.pendingCount, latest: scheduleItems },
        assignmentCoordination: inbox ? { unread: inbox.coordination.unreadCount, actionRequired: inbox.coordination.pendingCount, latest: coordinationItems } : null,
        taskEvents: inbox ? { unread: inbox.taskEvents.unreadCount, latest: eventItems } : null,
        note: 'Bu okuma bildirimleri okundu olarak işaretlemez. Liste zil önizlemesidir (kaynak başına en yeni kayıtlar).'
      },
      scope: currentUserScope('Yalnızca sizin bildirimleriniz.'),
      complete: false,
      truncated: true,
      returnedCount: scheduleItems.length + coordinationItems.length + eventItems.length,
      totalCount: null,
      nextCursor: null,
      evidence: {
        label: `Bildirimler · ${unread} okunmamış`,
        entity: { type: 'user', id: 'me', name: 'Bildirimleriniz' },
        highlights: [`Okunmamış: ${unread}`, `İşlem bekleyen: ${actionRequired}`]
      }
    };
  }
};

export const WORKFLOW_TOOLS = Object.freeze([activitySearch, scheduleRequests, assignmentRequests, notifications]);
