/**
 * Bellek içi SQL Server ikizinin ATAMA KOORDİNASYONU, GÖREV BİLDİRİMİ,
 * POSTA KUYRUĞU ve KULLANICI VARLIĞI yüzeyi.
 *
 * Amaç, 0015 yükseltmesiyle gelen sorguları aynı ikiz içinde karşılamak;
 * böylece testler GERÇEK sunucu kodunu (rota → depo → SQL) çalıştırmaya devam
 * eder. `db.assignmentCoordinationSchemaMissing = true` verildiğinde yeni
 * tablolar YOK sayılır ve SQL Server'ın "Invalid object name" hatası taklit
 * edilir: uygulamanın göç uygulanmadan da ayakta kalması sınanabilir.
 */

function missingObject(name) {
  const error = new Error(`Invalid object name 'dbo.${name}'.`);
  error.number = 208;
  return error;
}

/** `UX_MR_TaskAssignmentCoordinations_OpenRequest` ihlali (SQL Server 2601). */
function duplicateOpenCoordination() {
  const error = new Error("Cannot insert duplicate key row in object 'dbo.MR_TaskAssignmentCoordinations' "
    + "with unique index 'UX_MR_TaskAssignmentCoordinations_OpenRequest'.");
  error.number = 2601;
  return error;
}

const OPEN_STATUSES = ['PENDING', 'CANCELLATION_REQUESTED'];

function guid(value) {
  return value == null ? null : String(value).toUpperCase();
}

function sameGuid(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return String(left).toUpperCase() === String(right).toUpperCase();
}

function iso(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

let versionCounter = 0;
function nextVersion() {
  versionCounter += 1;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0xc0000000 + versionCounter, 0);
  buffer.writeUInt32BE(versionCounter, 4);
  return buffer;
}

function ensureCollections(db) {
  db.taskAssignmentCoordinations ||= [];
  db.assignmentCoordinationRecipients ||= [];
  db.taskNotifications ||= [];
  db.taskMailOutbox ||= [];
  db.userPresence ||= [];
}

function splitSicils(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function person(db, sicil) {
  return db.people.find((entry) => Number(entry.Sicil) === Number(sicil)) || null;
}

function organizationPath(entry) {
  return [entry?.Directorate, entry?.Department, entry?.Unit]
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean)
    .join(' / ');
}

function taskOf(db, taskId) {
  return db.tasks.find((task) => sameGuid(task.TaskId, taskId)) || null;
}

function projectOf(db, projectId) {
  return db.projects.find((project) => sameGuid(project.ProjectId, projectId)) || null;
}

function contains(haystack, needle) {
  if (!needle) return true;
  return String(haystack ?? '').toLocaleLowerCase('tr-TR').includes(String(needle).toLocaleLowerCase('tr-TR'));
}

function recipientsOf(db, coordinationId) {
  return db.assignmentCoordinationRecipients.filter((row) => sameGuid(row.CoordinationId, coordinationId));
}

/** `MR_V_ExecutiveScope` üzerinden GÜNCEL yönetim ilişkisi. */
function liveManagerOfAssignee(db, row, sicil) {
  return (db.executiveScope || []).some((scope) =>
    Number(scope.ManagerSicil) === Number(sicil)
    && Number(scope.EmployeeSicil) === Number(row.RequestedAssigneeSicil));
}

/** Sunucudaki `COALESCE(t.ProjectId, c.ProjectIdSnapshot)` karşılığı. */
function recordProjectId(db, row) {
  return taskOf(db, row.TaskId)?.ProjectId ?? row.ProjectIdSnapshot ?? null;
}

function liveFullProjectAccess(db, row, params) {
  const projectId = recordProjectId(db, row);
  return String(params.fullProjectIds ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => sameGuid(value, projectId));
}

/**
 * Sunucudaki `DECISION_AUTHORITY` yükleminin ikizi.
 *
 * Alıcı satırı yetki taşımaz: karar hakkı sistem yöneticiliğinden, güncel tam
 * proje yetkisinden ya da güncel İK ilişkisinden gelir.
 */
function decisionAuthority(db, row, params) {
  const sicil = Number(params.sicil);
  if (Number(row.RequesterSicil) === sicil) return false;
  if (Number(params.isSystemAdmin) === 1) return true;
  return liveManagerOfAssignee(db, row, sicil) || liveFullProjectAccess(db, row, params);
}

/** Sistem yöneticiliği bilinçli olarak dışarıdadır (bkz. sunucudaki yüklem). */
function isParticipant(db, row, params) {
  const sicil = Number(params.sicil);
  return Number(row.RequesterSicil) === sicil
    || recipientsOf(db, row.CoordinationId).some((entry) => Number(entry.Sicil) === sicil)
    || liveManagerOfAssignee(db, row, sicil)
    || liveFullProjectAccess(db, row, params);
}

function taskAvailable(db, row) {
  const task = taskOf(db, row.TaskId);
  if (!task) return false;
  const project = projectOf(db, task.ProjectId);
  return Boolean(project && project.IsActive);
}

function actionable(db, row, params) {
  if (!taskAvailable(db, row)) return false;
  if (row.Status === 'PENDING') return decisionAuthority(db, row, params);
  if (row.Status === 'CANCELLATION_REQUESTED') return Number(row.RequesterSicil) === Number(params.sicil);
  return false;
}

function notificationState(db, row, sicil) {
  return recipientsOf(db, row.CoordinationId)
    .find((entry) => Number(entry.Sicil) === Number(sicil)) || null;
}

function isUnread(db, row, sicil) {
  const state = notificationState(db, row, sicil);
  return !state?.ReadVersion || !Buffer.isBuffer(state.ReadVersion)
    || !state.ReadVersion.equals(row.RowVersion);
}

function isVisible(db, row, params) {
  if (actionable(db, row, params)) return true;
  const state = notificationState(db, row, params.sicil);
  return !state?.DismissedVersion || !Buffer.isBuffer(state.DismissedVersion)
    || !state.DismissedVersion.equals(row.RowVersion);
}

function coordinationRow(db, row, params) {
  const sicil = Number(params.sicil);
  const task = taskOf(db, row.TaskId);
  const project = task ? projectOf(db, task.ProjectId) : null;
  return {
    ...row,
    IsManager: decisionAuthority(db, row, params) ? 1 : 0,
    TaskTitle: row.TaskTitleSnapshot ?? task?.Title ?? '',
    ProjectId: row.ProjectIdSnapshot ?? task?.ProjectId ?? null,
    ProjectName: row.ProjectNameSnapshot ?? project?.ProjectName ?? '',
    ProjectCode: row.ProjectCodeSnapshot ?? project?.ProjectCode ?? '',
    RequesterName: person(db, row.RequesterSicil)?.DisplayName || null,
    AssigneeName: person(db, row.RequestedAssigneeSicil)?.DisplayName || row.AssigneeNameSnapshot || null,
    SuggestedAssigneeName: row.SuggestedAssigneeSicil == null
      ? null : (person(db, row.SuggestedAssigneeSicil)?.DisplayName || null),
    DecisionByName: row.DecisionBySicil == null
      ? null : (person(db, row.DecisionBySicil)?.DisplayName || null),
    IsUnread: isUnread(db, row, sicil) ? 1 : 0,
    TaskAvailable: taskAvailable(db, row) ? 1 : 0
  };
}

function coordinationOrder(db, params) {
  return (left, right) => {
    const rank = Number(!actionable(db, left, params)) - Number(!actionable(db, right, params));
    if (rank) return rank;
    const leftAt = Date.parse(left.DecidedAt || left.CreatedAt) || 0;
    const rightAt = Date.parse(right.DecidedAt || right.CreatedAt) || 0;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return String(right.CoordinationId).localeCompare(String(left.CoordinationId));
  };
}

function taskNotificationRow(db, row) {
  const task = taskOf(db, row.TaskId);
  const project = task ? projectOf(db, task.ProjectId) : null;
  return {
    ...row,
    ActorName: row.ActorNameSnapshot || person(db, row.ActorSicil)?.DisplayName || null,
    IsUnread: row.ReadAt ? 0 : 1,
    TaskAvailable: task && project?.IsActive ? 1 : 0
  };
}

/* ── Koordinasyon okumaları ─────────────────────────────────── */

function coordinationInbox(db, params) {
  const sicil = Number(params.sicil);
  const limit = Number(params.limit || 8);
  const owned = db.taskAssignmentCoordinations
    .filter((row) => isParticipant(db, row, params) && taskAvailable(db, row));
  const counts = {
    UnreadCount: owned.filter((row) => isUnread(db, row, sicil) && isVisible(db, row, params)).length,
    PendingCount: owned.filter((row) => actionable(db, row, params)).length
  };
  const items = owned
    .filter((row) => isVisible(db, row, params))
    .sort(coordinationOrder(db, params))
    .slice(0, limit)
    .map((row) => coordinationRow(db, row, params));
  return [[counts], items];
}

function taskNotificationInbox(db, params) {
  const sicil = Number(params.sicil);
  const limit = Number(params.limit || 8);
  const owned = db.taskNotifications
    .filter((row) => Number(row.RecipientSicil) === sicil)
    .map((row) => taskNotificationRow(db, row))
    .filter((row) => row.TaskAvailable === 1);
  const counts = { UnreadCount: owned.filter((row) => row.IsUnread === 1 && !row.DismissedAt).length };
  const items = owned
    .filter((row) => !row.DismissedAt)
    .sort((left, right) => (Date.parse(right.OccurredAt) || 0) - (Date.parse(left.OccurredAt) || 0))
    .slice(0, limit);
  return [[counts], items];
}

function coordinationPage(db, params) {
  const sicil = Number(params.sicil);
  const pageSize = Number(params.pageSize || 25);
  const requestedPage = Number(params.page || 0);
  const matches = db.taskAssignmentCoordinations.filter((row) => {
    if (!isParticipant(db, row, params)) return false;
    const view = coordinationRow(db, row, params);
    if (params.projectId && !sameGuid(view.ProjectId, params.projectId)) return false;
    if (params.taskId && !sameGuid(row.TaskId, params.taskId)) return false;
    if (params.status && row.Status !== params.status) return false;
    if (params.fromUtc && Date.parse(row.CreatedAt) < Date.parse(params.fromUtc)) return false;
    if (params.toUtc && Date.parse(row.CreatedAt) >= Date.parse(params.toUtc)) return false;
    if (params.requester && !(contains(view.RequesterName, params.requester)
      || String(row.RequesterSicil) === String(params.requester))) return false;
    if (params.assignee && !(contains(view.AssigneeName, params.assignee)
      || String(row.RequestedAssigneeSicil) === String(params.assignee))) return false;
    if (params.organization && !contains(row.AssigneeOrgSnapshot, params.organization)) return false;
    if (params.search) {
      const haystack = [view.TaskTitle, view.ProjectName, view.ProjectCode, view.RequesterName,
        view.AssigneeName, row.RequesterMessage].filter(Boolean).join(' ');
      if (!contains(haystack, params.search)) return false;
    }
    return true;
  });
  const history = (row) => !['PENDING', 'CANCELLATION_REQUESTED'].includes(row.Status) || !taskAvailable(db, row);
  const counts = {
    Total: matches.length,
    PendingCount: matches.filter((row) => actionable(db, row, params)).length,
    SentCount: matches.filter((row) => Number(row.RequesterSicil) === sicil).length,
    HistoryCount: matches.filter(history).length
  };
  const tab = params.tab || 'all';
  const tabbed = matches.filter((row) => {
    if (tab === 'all') return true;
    if (tab === 'pending') return actionable(db, row, params);
    if (tab === 'sent') return Number(row.RequesterSicil) === sicil;
    return history(row);
  });
  const lastPage = tabbed.length === 0 ? 0 : Math.floor((tabbed.length - 1) / pageSize);
  const page = Math.min(requestedPage, lastPage);
  const items = tabbed
    .sort(coordinationOrder(db, params))
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((row) => coordinationRow(db, row, params));
  return [[counts], [{ Total: tabbed.length, Page: page }], items];
}

/* ── Yazmalar ───────────────────────────────────────────────── */

function insertCoordination(db, sqlText, params) {
  // Aynı görev + kişi için AÇIK kayıt, YALNIZCA toplu komut kapatma
  // deyimini taşıdığında kapanır; ikiz sunucu sorgusunun yapmadığını yapmaz.
  const closesOpen = sqlText.includes("SET Status = 'CANCELLED'")
    && sqlText.includes("Status IN ('PENDING','CANCELLATION_REQUESTED')");
  for (const row of closesOpen ? db.taskAssignmentCoordinations : []) {
    if (sameGuid(row.TaskId, params.taskId)
      && Number(row.RequestedAssigneeSicil) === Number(params.assigneeSicil)
      && OPEN_STATUSES.includes(row.Status)) {
      row.Status = 'CANCELLED';
      row.DecidedAt = new Date().toISOString();
      row.DecisionBySicil = Number(params.requesterSicil);
      row.DecisionMessage = params.supersededMessage ?? null;
      row.RowVersion = nextVersion();
    }
  }
  const closesApprovedNotices = sqlText.includes("Mode = 'NOTICE' AND Status = 'APPROVED'");
  for (const row of closesApprovedNotices ? db.taskAssignmentCoordinations : []) {
    if (sameGuid(row.TaskId, params.taskId)
      && Number(row.RequestedAssigneeSicil) === Number(params.assigneeSicil)
      && row.Mode === 'NOTICE' && row.Status === 'APPROVED') {
      row.Status = 'CANCELLED';
      row.DecidedAt = new Date().toISOString();
      row.DecisionBySicil = Number(params.requesterSicil);
      row.DecisionMessage = params.supersededNoticeMessage ?? null;
      row.RowVersion = nextVersion();
    }
  }
  // Benzersiz filtrelenmiş dizinin (UX_..._OpenRequest) karşılığı.
  if (OPEN_STATUSES.includes(params.status)
    && db.taskAssignmentCoordinations.some((row) => sameGuid(row.TaskId, params.taskId)
      && Number(row.RequestedAssigneeSicil) === Number(params.assigneeSicil)
      && OPEN_STATUSES.includes(row.Status))) {
    throw duplicateOpenCoordination();
  }
  db.taskAssignmentCoordinations.push({
    CoordinationId: guid(params.coordinationId),
    TaskId: guid(params.taskId),
    RequesterSicil: Number(params.requesterSicil),
    RequestedAssigneeSicil: Number(params.assigneeSicil),
    SuggestedAssigneeSicil: null,
    Mode: params.mode,
    Status: params.status,
    RequesterMessage: params.requesterMessage ?? null,
    DecisionMessage: null,
    DecisionBySicil: null,
    OriginalAssigneeSicils: params.originalAssignees ?? '',
    TaskTitleSnapshot: params.taskTitle ?? null,
    ProjectIdSnapshot: guid(params.projectId),
    ProjectNameSnapshot: params.projectName ?? null,
    ProjectCodeSnapshot: params.projectCode ?? null,
    AssigneeNameSnapshot: params.assigneeName ?? null,
    AssigneeOrgSnapshot: params.assigneeOrg ?? null,
    TargetFinishSnapshot: params.targetFinish ?? null,
    CreatedAgainstTaskVersion: params.taskVersion ?? null,
    CorrelationId: guid(params.correlationId),
    CreatedAt: new Date().toISOString(),
    DecidedAt: params.status === 'APPROVED' ? new Date().toISOString() : null,
    RowVersion: nextVersion()
  });
  return [[]];
}

function insertRecipient(db, params) {
  const existing = db.assignmentCoordinationRecipients.find((row) =>
    sameGuid(row.CoordinationId, params.coordinationId) && Number(row.Sicil) === Number(params.sicil));
  if (!existing) {
    db.assignmentCoordinationRecipients.push({
      CoordinationId: guid(params.coordinationId),
      Sicil: Number(params.sicil),
      RecipientRole: params.role,
      ReadVersion: null,
      DismissedVersion: null,
      UpdatedAt: new Date().toISOString()
    });
  }
  return [[]];
}

function markCoordinationNotification(db, params) {
  const row = db.taskAssignmentCoordinations.find((entry) =>
    sameGuid(entry.CoordinationId, params.coordinationId));
  if (!row || !isParticipant(db, row, params)) return [[]];
  if (!Buffer.isBuffer(params.eventVersion) || !row.RowVersion.equals(params.eventVersion)) return [[]];
  const existing = db.assignmentCoordinationRecipients.find((entry) =>
    sameGuid(entry.CoordinationId, params.coordinationId) && Number(entry.Sicil) === Number(params.sicil));
  if (existing) {
    existing.ReadVersion = params.eventVersion;
    if (params.dismiss) existing.DismissedVersion = params.eventVersion;
    existing.UpdatedAt = new Date().toISOString();
  } else {
    db.assignmentCoordinationRecipients.push({
      CoordinationId: guid(params.coordinationId),
      Sicil: Number(params.sicil),
      RecipientRole: 'REQUESTER',
      ReadVersion: params.eventVersion,
      DismissedVersion: params.dismiss ? params.eventVersion : null,
      UpdatedAt: new Date().toISOString()
    });
  }
  return [[]];
}

/** SQL Server `NEWSEQUENTIALID()` karşılığı: geçerli ve artan bir GUID. */
let notificationSequence = 0;
function nextNotificationId() {
  notificationSequence += 1;
  return guid(`b0000000-0000-4000-8000-${notificationSequence.toString(16).padStart(12, '0')}`);
}

function insertTaskNotification(db, params) {
  const duplicate = db.taskNotifications.some((row) =>
    Number(row.RecipientSicil) === Number(params.recipientSicil) && row.EventKey === params.eventKey);
  if (duplicate) return [[]];
  db.taskNotifications.push({
    NotificationId: nextNotificationId(),
    RecipientSicil: Number(params.recipientSicil),
    Kind: params.kind,
    TaskId: guid(params.taskId),
    ActorSicil: params.actorSicil == null ? null : Number(params.actorSicil),
    ActorNameSnapshot: params.actorName ?? null,
    TaskTitleSnapshot: params.taskTitle ?? null,
    ProjectIdSnapshot: guid(params.projectId),
    ProjectNameSnapshot: params.projectName ?? null,
    ProjectCodeSnapshot: params.projectCode ?? null,
    TargetFinishSnapshot: params.targetFinish ?? null,
    PrioritySnapshot: params.priority ?? null,
    TaskCount: Number(params.taskCount || 1),
    EventKey: params.eventKey,
    OccurredAt: new Date().toISOString(),
    ReadAt: null,
    DismissedAt: null,
    RowVersion: nextVersion()
  });
  return [[]];
}

function insertMailIntent(db, params) {
  if (db.taskMailOutbox.some((row) => row.DedupeKey === params.dedupeKey)) return [[{ Affected: 0 }]];
  db.taskMailOutbox.push({
    MailId: db.taskMailOutbox.length + 1,
    Kind: params.kind,
    TaskId: guid(params.taskId),
    RecipientSicil: Number(params.recipientSicil),
    PayloadJson: params.payload,
    Status: 'PENDING',
    AttemptCount: 0,
    NextAttemptAt: new Date(0).toISOString(),
    LeaseExpiresAt: null,
    LeaseToken: null,
    LastFailureCode: null,
    DedupeKey: params.dedupeKey,
    CreatedAt: new Date().toISOString(),
    UpdatedAt: new Date().toISOString(),
    SentAt: null
  });
  return [[{ Affected: 1 }]];
}

/* ── Varlık (presence) ──────────────────────────────────────── */

function presenceHeartbeat(db, params) {
  const sicil = Number(params.sicil);
  const now = new Date().toISOString();
  const existing = db.userPresence.find((row) => Number(row.Sicil) === sicil);
  if (existing) {
    const gapSeconds = (Date.now() - Date.parse(existing.LastSeenAt)) / 1000;
    if (gapSeconds > Number(params.gapSeconds || 900)) existing.SessionStartedAt = now;
    existing.LastSeenAt = now;
  } else {
    db.userPresence.push({ Sicil: sicil, FirstSeenAt: now, SessionStartedAt: now, LastSeenAt: now });
  }
  const row = db.userPresence.find((entry) => Number(entry.Sicil) === sicil);
  return [[], [{ FirstSeenAt: row.FirstSeenAt, SessionStartedAt: row.SessionStartedAt, LastSeenAt: row.LastSeenAt }]];
}

function presenceList(db, params) {
  const now = Date.now();
  const within = (row, seconds) => (now - Date.parse(row.LastSeenAt)) / 1000 <= Number(seconds);
  const counts = {
    ActiveCount: db.userPresence.filter((row) => within(row, params.activeSeconds)).length,
    RecentCount: db.userPresence.filter((row) => within(row, params.recentSeconds)).length,
    ServerNow: new Date(now).toISOString()
  };
  // Kurumsal sayaçlar AKTİF kümenin TAMAMI üzerindedir; liste sınırı buraya
  // uygulanmaz.
  const active = db.userPresence
    .filter((row) => within(row, params.activeSeconds))
    .map((row) => person(db, row.Sicil))
    .filter(Boolean);
  const organizations = {
    DirectorateCount: new Set(active.map((entry) => entry.Directorate).filter(Boolean)).size,
    DepartmentCount: new Set(active.map((entry) => entry.Department).filter(Boolean)).size
  };
  const rows = db.userPresence
    .filter((row) => within(row, params.recentSeconds))
    .sort((left, right) => Date.parse(right.LastSeenAt) - Date.parse(left.LastSeenAt))
    .slice(0, Number(params.limit || 200))
    .map((row) => {
      const directory = person(db, row.Sicil);
      return {
        Sicil: row.Sicil,
        FirstSeenAt: row.FirstSeenAt,
        SessionStartedAt: row.SessionStartedAt,
        LastSeenAt: row.LastSeenAt,
        DisplayName: directory?.DisplayName ?? null,
        Directorate: directory?.Directorate ?? null,
        Department: directory?.Department ?? null,
        Unit: directory?.Unit ?? null
      };
    });
  return [[counts], [organizations], rows];
}

/* ── Posta kuyruğu ──────────────────────────────────────────── */

function claimMail(db, params) {
  const now = Date.now();
  const due = db.taskMailOutbox
    .filter((row) => row.Status === 'PENDING'
      && Date.parse(row.NextAttemptAt) <= now
      && (!row.LeaseExpiresAt || Date.parse(row.LeaseExpiresAt) <= now))
    .sort((left, right) => Date.parse(left.NextAttemptAt) - Date.parse(right.NextAttemptAt) || left.MailId - right.MailId)
    .slice(0, Number(params.limit || 20));
  for (const row of due) {
    row.LeaseExpiresAt = new Date(now + Number(params.leaseSeconds || 120) * 1000).toISOString();
    row.LeaseToken = guid(params.leaseToken);
    row.UpdatedAt = new Date(now).toISOString();
  }
  return [[], due.map((row) => ({
    MailId: row.MailId,
    Kind: row.Kind,
    TaskId: row.TaskId,
    RecipientSicil: row.RecipientSicil,
    PayloadJson: row.PayloadJson,
    AttemptCount: row.AttemptCount
  }))];
}

function completeMail(db, params, { sent, uncertain = false }) {
  const row = db.taskMailOutbox.find((entry) => Number(entry.MailId) === Number(params.mailId));
  if (!row || row.Status !== 'PENDING') return [[]];
  // Kira SAHİPLİĞİ: kira dolduktan sonra satırı başka bir tur devralmışsa bu
  // turun durum yazması satıra dokunmaz.
  if (params.leaseToken != null && !sameGuid(row.LeaseToken, params.leaseToken)) return [[]];
  const previousAttemptCount = Number(row.AttemptCount || 0);
  row.AttemptCount = previousAttemptCount + 1;
  row.LeaseExpiresAt = null;
  row.LeaseToken = null;
  row.UpdatedAt = new Date().toISOString();
  if (sent) {
    row.Status = 'SENT';
    row.SentAt = new Date().toISOString();
    row.LastFailureCode = null;
  } else if (uncertain) {
    // Teslimat belirsizse satır bir daha GÖNDERİLMEZ; kaybolmaz da.
    row.LastFailureCode = params.failureCode;
    row.Status = 'FAILED';
  } else {
    row.LastFailureCode = params.failureCode;
    row.Status = row.AttemptCount >= Number(params.maxAttempts || 6) ? 'FAILED' : 'PENDING';
    const retryBaseSeconds = Number(params.retryBaseSeconds || 60);
    const multiplier = 2 ** Math.min(previousAttemptCount, 4);
    row.NextAttemptAt = new Date(Date.now() + retryBaseSeconds * multiplier * 1000).toISOString();
  }
  return [[]];
}

function mailQueueStatus(db) {
  const pending = db.taskMailOutbox.filter((row) => row.Status === 'PENDING');
  return [[{
    PendingCount: pending.length,
    FailedCount: db.taskMailOutbox.filter((row) => row.Status === 'FAILED').length,
    SentCount: db.taskMailOutbox.filter((row) => row.Status === 'SENT').length,
    // `MIN(NextAttemptAt)` karşılığı: ekleme sırası değil, EN ERKEN deneme.
    NextAttemptAt: pending.reduce((earliest, row) => (earliest == null
      || Date.parse(row.NextAttemptAt) < Date.parse(earliest) ? row.NextAttemptAt : earliest), null),
    LastSentAt: db.taskMailOutbox.filter((row) => row.SentAt).map((row) => row.SentAt).sort().pop() || null
  }]];
}

/* ── Yönlendirici ───────────────────────────────────────────── */

export function runAssignmentCoordinationQuery(db, sqlText, params) {
  ensureCollections(db);
  const missing = db.assignmentCoordinationSchemaMissing === true;

  // Kurumsal dizin araması ve yönetim zinciri çözümü mevcut görünümleri okur;
  // 0015 tabloları olmadan da çalışır.
  if (sqlText.includes('AS MatchRank')) {
    const query = String(params.query || '');
    const sicilQuery = params.sicilQuery == null ? null : Number(params.sicilQuery);
    const rows = db.people
      .filter((entry) => (sicilQuery != null && Number(entry.Sicil) === sicilQuery)
        || contains(entry.DisplayName, query))
      .map((entry) => ({
        Sicil: entry.Sicil,
        DisplayName: entry.DisplayName,
        JobTitle: entry.JobTitle ?? null,
        Directorate: entry.Directorate ?? null,
        Department: entry.Department ?? null,
        Unit: entry.Unit ?? null,
        MatchRank: sicilQuery != null && Number(entry.Sicil) === sicilQuery ? 0 : 1
      }))
      .sort((left, right) => left.MatchRank - right.MatchRank
        || String(left.DisplayName || '').localeCompare(String(right.DisplayName || ''), 'tr')
        || Number(left.Sicil) - Number(right.Sicil))
      .slice(0, Number(params.limit || 25));
    return [rows];
  }

  if (sqlText.includes('AS InActorScope')) {
    const actor = person(db, params.actorSicil);
    const rows = splitSicils(params.assigneeSicils).map((sicil) => {
      const entry = person(db, sicil);
      if (!entry) return null;
      return {
        Sicil: entry.Sicil,
        DisplayName: entry.DisplayName,
        Directorate: entry.Directorate ?? null,
        Department: entry.Department ?? null,
        Unit: entry.Unit ?? null,
        InActorScope: db.executiveScope.some((scope) =>
          Number(scope.ManagerSicil) === Number(params.actorSicil)
          && Number(scope.EmployeeSicil) === Number(sicil)) ? 1 : 0,
        ActorDirectorate: actor?.Directorate ?? null,
        ActorDepartment: actor?.Department ?? null,
        ActorUnit: actor?.Unit ?? null
      };
    }).filter(Boolean);
    return [rows];
  }

  if (sqlText.includes('SELECT DISTINCT es.EmployeeSicil, es.ManagerSicil')) {
    const scopes = splitSicils(params.employeeSicils);
    const allowed = String(params.scopeTypes || '').split(',').map((value) => value.trim()).filter(Boolean);
    const rows = [];
    for (const scope of db.executiveScope) {
      if (!scopes.includes(Number(scope.EmployeeSicil))) continue;
      // Tohumda ScopeType verilmemişse kural uygulanmaz: eski düzenekler
      // yalnızca yönetici/çalışan çiftini taşır.
      if (scope.ScopeType && allowed.length && !allowed.includes(scope.ScopeType)) continue;
      if (Number(scope.ManagerSicil) === Number(scope.EmployeeSicil)) continue;
      if (!person(db, scope.ManagerSicil)) continue;
      if (rows.some((row) => Number(row.EmployeeSicil) === Number(scope.EmployeeSicil)
        && Number(row.ManagerSicil) === Number(scope.ManagerSicil))) continue;
      rows.push({ EmployeeSicil: Number(scope.EmployeeSicil), ManagerSicil: Number(scope.ManagerSicil) });
    }
    rows.sort((left, right) => left.EmployeeSicil - right.EmployeeSicil || left.ManagerSicil - right.ManagerSicil);
    return [rows];
  }

  if (sqlText.includes('AS InScope') && sqlText.includes('dbo.MR_V_ExecutiveScope')) {
    const found = db.executiveScope.some((scope) =>
      Number(scope.ManagerSicil) === Number(params.managerSicil)
      && Number(scope.EmployeeSicil) === Number(params.employeeSicil));
    return [found ? [{ InScope: 1 }] : []];
  }

  if (sqlText.includes('FROM dbo.MR_V_PeopleDirectory pd')
    && sqlText.includes("JOIN STRING_SPLIT(@sicils, ',') requested")) {
    const rows = splitSicils(params.sicils).map((sicil) => person(db, sicil)).filter(Boolean)
      .map((entry) => ({
        Sicil: entry.Sicil,
        DisplayName: entry.DisplayName,
        Directorate: entry.Directorate ?? null,
        Department: entry.Department ?? null,
        Unit: entry.Unit ?? null
      }));
    return [rows];
  }

  if (sqlText.includes('SELECT DISTINCT candidate.Sicil')) {
    // Görev OLUŞTURAN kişi aday DEĞİLDİR: görev oluşturmak tam proje yetkisi
    // vermez, karar sunucuda her durumda reddedilirdi.
    const owners = new Set();
    const project = projectOf(db, params.projectId);
    if (project?.IsActive && project.SourceType === 'MANUAL' && project.LeadSicil != null) {
      owners.add(Number(project.LeadSicil));
    }
    for (const access of db.projectAccess) {
      if (sameGuid(access.ProjectId, params.projectId) && access.IsActive && access.AccessLevel === 'FULL') {
        owners.add(Number(access.Sicil));
      }
    }
    if (String(params.sourceType) === 'CORPORATE') {
      for (const access of db.corporateProjectAccess) {
        if (String(access.ProjectCode || '').toUpperCase() === String(params.projectCode || '').toUpperCase()) {
          owners.add(Number(access.Sicil));
        }
      }
    }
    owners.delete(Number(params.requesterSicil));
    return [[...owners].filter((sicil) => person(db, sicil)).map((sicil) => ({ Sicil: sicil }))];
  }

  /* ── 0015 tabloları ──────────────────────────────────────── */

  if (sqlText.includes('dbo.MR_UserPresence')) {
    if (missing) throw missingObject('MR_UserPresence');
    if (sqlText.includes('UPDATE dbo.MR_UserPresence')) return presenceHeartbeat(db, params);
    if (sqlText.includes('FROM dbo.MR_UserPresence')) return presenceList(db, params);
  }

  if (sqlText.includes('dbo.MR_TaskMailOutbox')) {
    if (missing) throw missingObject('MR_TaskMailOutbox');
    if (sqlText.includes('INSERT dbo.MR_TaskMailOutbox(')) return insertMailIntent(db, params);
    if (sqlText.includes('WITH due AS')) return claimMail(db, params);
    if (sqlText.includes("SET Status = 'SENT'")) return completeMail(db, params, { sent: true });
    if (sqlText.includes("Status = 'FAILED',")) return completeMail(db, params, { sent: false, uncertain: true });
    if (sqlText.includes('SET AttemptCount = AttemptCount + 1')) return completeMail(db, params, { sent: false });
    if (sqlText.includes('AS PendingCount')) return mailQueueStatus(db);
  }

  if (sqlText.includes('INSERT dbo.MR_TaskNotifications(')) {
    if (missing) throw missingObject('MR_TaskNotifications');
    return insertTaskNotification(db, params);
  }

  if (sqlText.includes('UPDATE dbo.MR_TaskNotifications')) {
    if (missing) throw missingObject('MR_TaskNotifications');
    const row = db.taskNotifications.find((entry) => sameGuid(entry.NotificationId, params.notificationId)
      && Number(entry.RecipientSicil) === Number(params.sicil));
    if (row) {
      row.ReadAt ||= new Date().toISOString();
      if (params.dismiss) row.DismissedAt ||= new Date().toISOString();
    }
    return [[]];
  }

  if (sqlText.includes('INSERT dbo.MR_TaskAssignmentCoordinations(')) {
    if (missing) throw missingObject('MR_TaskAssignmentCoordinations');
    return insertCoordination(db, sqlText, params);
  }

  if (sqlText.includes('INSERT dbo.MR_AssignmentCoordinationRecipients(')
    && sqlText.includes('IF NOT EXISTS')) {
    if (missing) throw missingObject('MR_AssignmentCoordinationRecipients');
    return insertRecipient(db, params);
  }

  if (sqlText.includes('UPDATE dbo.MR_AssignmentCoordinationRecipients')) {
    if (missing) throw missingObject('MR_AssignmentCoordinationRecipients');
    return markCoordinationNotification(db, params);
  }

  if (sqlText.includes('UPDATE dbo.MR_TaskAssignmentCoordinations')
    && sqlText.includes('SET Status = @status')) {
    if (missing) throw missingObject('MR_TaskAssignmentCoordinations');
    const row = db.taskAssignmentCoordinations.find((entry) =>
      sameGuid(entry.CoordinationId, params.coordinationId));
    if (row && OPEN_STATUSES.includes(params.status)
      && db.taskAssignmentCoordinations.some((entry) => entry !== row
        && sameGuid(entry.TaskId, row.TaskId)
        && Number(entry.RequestedAssigneeSicil) === Number(row.RequestedAssigneeSicil)
        && OPEN_STATUSES.includes(entry.Status))) {
      throw duplicateOpenCoordination();
    }
    if (row) {
      row.Status = params.status;
      row.DecidedAt = new Date().toISOString();
      row.DecisionBySicil = Number(params.actorSicil);
      if (params.message != null) row.DecisionMessage = params.message;
      if (params.suggested != null) row.SuggestedAssigneeSicil = Number(params.suggested);
      row.RowVersion = nextVersion();
    }
    return [[]];
  }

  if (sqlText.includes('AS LiveTaskId')) {
    if (missing) throw missingObject('MR_TaskAssignmentCoordinations');
    const row = db.taskAssignmentCoordinations.find((entry) =>
      sameGuid(entry.CoordinationId, params.coordinationId));
    if (!row) return [[]];
    // Sunucu sorgusunun birebir karşılığı: görev alanları `LEFT JOIN MR_Tasks`
    // satırından gelir ve proje kapatılsa da DOLU kalır; proje alanları
    // yalnızca `p.IsActive = 1` birleşiminden gelir.
    const task = taskOf(db, row.TaskId);
    const project = task ? projectOf(db, task.ProjectId) : null;
    const activeProject = project?.IsActive ? project : null;
    return [[{
      ...row,
      LiveTaskId: task ? task.TaskId : null,
      LiveTaskTitle: task?.Title ?? null,
      LiveProjectId: task ? task.ProjectId : null,
      LiveTargetFinish: task?.TargetFinish ?? null,
      LivePriority: task?.Priority ?? null,
      LiveActiveProjectId: activeProject ? activeProject.ProjectId : null,
      LiveProjectName: activeProject ? activeProject.ProjectName : null,
      LiveProjectCode: activeProject ? activeProject.ProjectCode : null
    }]];
  }

  // Aynı gönderimden doğan kardeş talepler (bayatlık denetimi).
  if (sqlText.includes('SELECT RequestedAssigneeSicil FROM dbo.MR_TaskAssignmentCoordinations')) {
    if (missing) throw missingObject('MR_TaskAssignmentCoordinations');
    return [db.taskAssignmentCoordinations
      .filter((row) => sameGuid(row.CorrelationId, params.correlationId)
        && sameGuid(row.TaskId, params.taskId)
        && !sameGuid(row.CoordinationId, params.coordinationId))
      .map((row) => ({ RequestedAssigneeSicil: Number(row.RequestedAssigneeSicil) }))];
  }

  // Sorumlu kümesi değiştiğinde görev SÜRÜMÜ ilerler; açık bir düzenleyicinin
  // elindeki eski sürüm bayatlar ve yeni sorumluyu sessizce silemez.
  if (sqlText.includes('SET UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil')) {
    const task = taskOf(db, params.taskId);
    if (task) {
      task.UpdatedAt = new Date().toISOString();
      task.UpdatedBySicil = params.actorSicil == null ? null : Number(params.actorSicil);
      task.RowVersion = nextVersion();
    }
    return [[]];
  }

  if (sqlText.includes('AS IsActorAssignee')) {
    const task = taskOf(db, params.taskId);
    if (!task) return [[]];
    const project = projectOf(db, task.ProjectId);
    if (!project?.IsActive) return [[]];
    return [[{
      TaskId: task.TaskId,
      ProjectId: task.ProjectId,
      Title: task.Title,
      TargetFinish: task.TargetFinish,
      Priority: task.Priority,
      CreatedBySicil: task.CreatedBySicil,
      RowVersion: task.RowVersion,
      ProjectName: project.ProjectName,
      ProjectCode: project.ProjectCode,
      SourceType: project.SourceType,
      LeadSicil: project.LeadSicil,
      IsActorAssignee: db.taskAssignees.some((entry) => sameGuid(entry.TaskId, task.TaskId)
        && Number(entry.Sicil) === Number(params.sicil)) ? 1 : 0
    }]];
  }

  if (sqlText.includes('FROM dbo.MR_TaskAssignmentCoordinations c')) {
    if (missing) throw missingObject('MR_TaskAssignmentCoordinations');
    if (sqlText.includes('FROM dbo.MR_TaskNotifications n')) {
      return [...coordinationInbox(db, params), ...taskNotificationInbox(db, params)];
    }
    if (sqlText.includes('DECLARE @safePage')) return coordinationPage(db, params);
    if (sqlText.includes('SELECT TOP (1)')) {
      const row = db.taskAssignmentCoordinations.find((entry) =>
        sameGuid(entry.CoordinationId, params.coordinationId)
        && isParticipant(db, entry, params));
      return [row ? [coordinationRow(db, row, params)] : []];
    }
    return [...coordinationInbox(db, params)];
  }

  if (sqlText.includes('INSERT dbo.MR_TaskAssignees(TaskId, Sicil, AssignedBySicil)')
    && sqlText.includes('IF NOT EXISTS')) {
    const exists = db.taskAssignees.some((entry) => sameGuid(entry.TaskId, params.taskId)
      && Number(entry.Sicil) === Number(params.sicil));
    if (!exists) {
      db.taskAssignees.push({
        TaskId: guid(params.taskId),
        Sicil: Number(params.sicil),
        AssignedBySicil: params.actorSicil == null ? null : Number(params.actorSicil)
      });
    }
    return [[]];
  }

  if (sqlText.includes('DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId AND Sicil = @sicil;')) {
    db.taskAssignees = db.taskAssignees.filter((entry) => !(sameGuid(entry.TaskId, params.taskId)
      && Number(entry.Sicil) === Number(params.sicil)));
    return [[]];
  }

  return null;
}

export { iso };
