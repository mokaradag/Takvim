import 'server-only';
import { randomUUID } from 'node:crypto';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { MAX_WORKING_DAY_SPAN } from '../../scheduling/calendars/index.js';
import { calculatePlannedDurationDays } from '../../scheduling/plans/index.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { encodeVersion } from '../repository/versionTokens.js';

const DATE_FIELDS = Object.freeze([
  ['plannedStart', 'PlannedStart'],
  ['plannedFinish', 'PlannedFinish'],
  ['targetFinish', 'TargetFinish']
]);
const ASSIGNEE_PROPOSAL_FIELDS = new Set(['targetFinish']);

function canonicalId(value, label) {
  const normalized = canonicalActualId(value);
  if (!normalized) {
    throw new ServerPersistenceError('MUTATION_FAILED', `${label} geçerli bir UUID olmalıdır.`, { status: 400 });
  }
  return normalized;
}

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function proposedDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const [year, month, day] = text.split('-').map(Number);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(text)
    && year >= 1 && month >= 1 && month <= 12 && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!valid) {
    throw new ServerPersistenceError('MUTATION_FAILED', `${field} geçerli bir tarih olmalıdır.`, { status: 400 });
  }
  return text;
}

/**
 * Talebin GÖNDERİLEN tarihleri. Gönderilmeyen alan "değişmesin" demektir.
 *
 * Talep eden yalnızca doğrudan yazamadığı tarihi önerir (bkz. hedef bitiş).
 * Gönderilmeyen alanlar istemcinin panelde tuttuğu ESKİ değerlerle
 * doldurulsaydı, pencere açıkken planı başkası değiştirdiğinde öneri o eski
 * tarihleri de taşır; sunucu `Original*` alanlarını kilitli satırdan güncel
 * okuduğu için bayatlık denetimi tetiklenmez ve kabul, kimsenin istemediği bir
 * geri alma yazardı. Eksik alan bu yüzden istemciden değil, kilitli görev
 * satırından tamamlanır (bkz. effectiveProposal).
 */
function submittedProposal(input = {}, allowedFields = null) {
  const values = {};
  const submitted = new Set();
  for (const [field] of DATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (allowedFields && !allowedFields.has(field)) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        'Tarih değişikliği talebinde yalnızca hedef bitiş önerilebilir.',
        { status: 400 }
      );
    }
    values[field] = proposedDate(input[field], field);
    submitted.add(field);
  }
  if (!submitted.size) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Talepte en az bir plan tarihi yer almalıdır.', { status: 400 });
  }
  return { values, submitted };
}

/** Gönderilmeyen alanlar görevin YÜRÜRLÜKTEKİ değerleriyle tamamlanır. */
function effectiveProposal({ values, submitted }, task) {
  const proposal = Object.fromEntries(DATE_FIELDS.map(([field, column]) => [
    field,
    submitted.has(field) ? values[field] : isoDate(task[column])
  ]));
  if (proposal.plannedStart && proposal.plannedFinish && proposal.plannedFinish < proposal.plannedStart) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Planlanan bitiş, planlanan başlangıçtan önce olamaz.', { status: 400 });
  }
  return proposal;
}

function normalizeMessage(value, { required = false } = {}) {
  const message = String(value || '').trim();
  if (required && !message) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Tarih değişikliğinin gerekçesi yazılmalıdır.', { status: 400 });
  }
  if (message.length > 2000) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Açıklama 2000 karakteri aşamaz.', { status: 400 });
  }
  return message || null;
}

function hasFullProjectAccess(actor, projectId) {
  if (actor.isSystemAdmin) return true;
  const id = canonicalActualId(projectId) ?? String(projectId);
  return actor.effective.access.get(id)?.accessLevel === 'FULL';
}

function mapRequest(row, actorSicil) {
  if (!row) return null;
  const requesterSicil = String(row.RequesterSicil);
  const decisionOwnerSicil = String(row.DecisionOwnerSicil);
  return {
    id: canonicalActualId(row.RequestId) ?? String(row.RequestId),
    taskId: canonicalActualId(row.TaskId) ?? String(row.TaskId),
    taskTitle: row.TaskTitle || '',
    projectId: canonicalActualId(row.ProjectId) ?? String(row.ProjectId),
    projectName: row.ProjectName || '',
    projectCode: row.ProjectCode || '',
    requesterSicil,
    requesterName: row.RequesterName || requesterSicil,
    decisionOwnerSicil,
    decisionOwnerName: row.DecisionOwnerName || decisionOwnerSicil,
    originalPlannedStart: isoDate(row.OriginalPlannedStart),
    proposedPlannedStart: isoDate(row.ProposedPlannedStart),
    originalPlannedFinish: isoDate(row.OriginalPlannedFinish),
    proposedPlannedFinish: isoDate(row.ProposedPlannedFinish),
    originalTargetFinish: isoDate(row.OriginalTargetFinish),
    proposedTargetFinish: isoDate(row.ProposedTargetFinish),
    requesterMessage: row.RequesterMessage || '',
    status: row.Status,
    createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
    decidedAt: row.DecidedAt ? new Date(row.DecidedAt).toISOString() : null,
    decisionBySicil: row.DecisionBySicil == null ? null : String(row.DecisionBySicil),
    decisionMessage: row.DecisionMessage || '',
    version: encodeVersion(row.RowVersion),
    isDecisionOwner: Number(row.DecisionOwnerSicil) === Number(actorSicil),
    isRequester: Number(row.RequesterSicil) === Number(actorSicil)
  };
}

async function audit(executor, actor, actionCode, entityType, entityId, projectId, before, after, correlationId) {
  const request = executor.request();
  request.input('actorSicil', sql.Int, actor.sicil);
  request.input('username', sql.NVarChar(255), actor.currentUser.username || null);
  request.input('displayName', sql.NVarChar(255), actor.currentUser.name || null);
  request.input('actionCode', sql.VarChar(50), actionCode);
  request.input('entityType', sql.VarChar(50), entityType);
  request.input('entityId', sql.NVarChar(100), String(entityId));
  request.input('projectId', sql.UniqueIdentifier, projectId || null);
  request.input('correlationId', sql.UniqueIdentifier, correlationId);
  request.input('beforeJson', sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before));
  request.input('afterJson', sql.NVarChar(sql.MAX), after == null ? null : JSON.stringify(after));
  await request.query(`
    INSERT dbo.MR_AuditLog(
      ActorSicil, ActorUsername, ActorDisplayName, ActionCode, EntityType,
      EntityId, ProjectId, CorrelationId, BeforeJson, AfterJson
    ) VALUES(
      @actorSicil, @username, @displayName, @actionCode, @entityType,
      @entityId, @projectId, @correlationId, @beforeJson, @afterJson
    );
  `);
}

async function loadScheduleCalendar(executor, task) {
  const calendarId = canonicalActualId(task.EffectiveCalendarId);
  if (!calendarId) return { projects: [], calendars: [] };
  const request = executor.request();
  request.input('calendarId', sql.UniqueIdentifier, calendarId);
  const result = await request.query(`
    SELECT CalendarId, Name, TimeZone
    FROM dbo.MR_Calendars
    WHERE CalendarId = @calendarId AND IsActive = 1;

    SELECT Weekday
    FROM dbo.MR_CalendarWorkingDays
    WHERE CalendarId = @calendarId
    ORDER BY Weekday;

    SELECT HolidayDate, Name, ShortName
    FROM dbo.MR_CalendarHolidays
    WHERE CalendarId = @calendarId
    ORDER BY HolidayDate;
  `);
  const calendar = result.recordsets?.[0]?.[0];
  if (!calendar) return { projects: [], calendars: [] };
  return {
    projects: [{ id: canonicalActualId(task.ProjectId), calendarId }],
    calendars: [{
      id: calendarId,
      name: calendar.Name,
      timezone: calendar.TimeZone,
      workingDays: (result.recordsets?.[1] || []).map((row) => Number(row.Weekday)),
      holidays: (result.recordsets?.[2] || []).map((row) => ({
        date: isoDate(row.HolidayDate),
        name: row.Name,
        short: row.ShortName || row.Name
      }))
    }]
  };
}

export async function listScheduleChanges(executor, actor) {
  const request = executor.request();
  request.input('sicil', sql.Int, actor.sicil);
  const result = await request.query(`
    WITH ActorRequests AS (
      SELECT r.*,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN r.Status = 'PENDING' THEN 0 ELSE 1 END
          ORDER BY r.CreatedAt DESC, r.RequestId DESC
        ) AS BucketRow
      FROM dbo.MR_TaskScheduleChangeRequests r
      WHERE r.RequesterSicil = @sicil OR r.DecisionOwnerSicil = @sicil
    )
    SELECT r.*, t.Title AS TaskTitle, t.ProjectId,
      p.ProjectName, p.ProjectCode,
      requester.DisplayName AS RequesterName,
      ownerPerson.DisplayName AS DecisionOwnerName
    FROM ActorRequests r
    JOIN dbo.MR_Tasks t ON t.TaskId = r.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    LEFT JOIN dbo.MR_V_PeopleDirectory requester ON requester.Sicil = r.RequesterSicil
    LEFT JOIN dbo.MR_V_PeopleDirectory ownerPerson ON ownerPerson.Sicil = r.DecisionOwnerSicil
    WHERE r.Status = 'PENDING' OR r.BucketRow <= 100
    ORDER BY CASE WHEN r.Status = 'PENDING' THEN 0 ELSE 1 END, r.CreatedAt DESC, r.RequestId DESC;
  `);
  return (result.recordset || []).map((row) => mapRequest(row, actor.sicil));
}

async function readScheduleChange(executor, actor, requestId) {
  const request = executor.request();
  request.input('requestId', sql.UniqueIdentifier, requestId);
  request.input('sicil', sql.Int, actor.sicil);
  const result = await request.query(`
    SELECT r.*, t.Title AS TaskTitle, t.ProjectId,
      p.ProjectName, p.ProjectCode,
      requester.DisplayName AS RequesterName,
      ownerPerson.DisplayName AS DecisionOwnerName
    FROM dbo.MR_TaskScheduleChangeRequests r
    JOIN dbo.MR_Tasks t ON t.TaskId = r.TaskId
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    LEFT JOIN dbo.MR_V_PeopleDirectory requester ON requester.Sicil = r.RequesterSicil
    LEFT JOIN dbo.MR_V_PeopleDirectory ownerPerson ON ownerPerson.Sicil = r.DecisionOwnerSicil
    WHERE r.RequestId = @requestId
      AND (r.RequesterSicil = @sicil OR r.DecisionOwnerSicil = @sicil);
  `);
  return mapRequest(result.recordset?.[0], actor.sicil);
}

export async function createScheduleChange(input = {}) {
  const taskId = canonicalId(input.taskId, 'Görev kimliği');
  const proposalInput = input.proposedDates || input;
  const requesterMessage = normalizeMessage(input.message, { required: true });

  return withSqlTransaction(async (transaction) => {
    const actor = await loadAuthorizationContext(transaction);
    const taskRequest = transaction.request();
    taskRequest.input('taskId', sql.UniqueIdentifier, taskId);
    taskRequest.input('sicil', sql.Int, actor.sicil);
    const taskResult = await taskRequest.query(`
      SELECT TOP (1) t.*,
        decisionOwner.DecisionOwnerSicil AS EffectiveDecisionOwnerSicil,
        COALESCE(t.CalendarId, p.CalendarId, (
          SELECT TOP (1) c.CalendarId
          FROM dbo.MR_Calendars c
          WHERE c.IsDefault = 1 AND c.IsActive = 1
          ORDER BY c.CreatedAt, c.CalendarId
        )) AS EffectiveCalendarId,
        CASE WHEN EXISTS (
          SELECT 1 FROM dbo.MR_TaskAssignees ta
          WHERE ta.TaskId = t.TaskId AND ta.Sicil = @sicil
        ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsRequesterAssignee
      FROM dbo.MR_Tasks t WITH (UPDLOCK, HOLDLOCK)
      JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
      OUTER APPLY (
        SELECT TOP (1) candidate.Sicil AS DecisionOwnerSicil
        FROM (
          SELECT t.CreatedBySicil AS Sicil, 0 AS Priority
          UNION ALL SELECT p.LeadSicil, 1 WHERE p.SourceType = 'MANUAL'
          UNION ALL
          SELECT pa.Sicil, 2
          FROM dbo.MR_ProjectAccess pa
          WHERE pa.ProjectId = t.ProjectId AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL'
          UNION ALL
          SELECT access.Sicil, 3
          FROM dbo.MR_V_CorporateProjectAccess access
          WHERE p.SourceType = 'CORPORATE' AND access.ProjectCode = UPPER(p.ProjectCode)
        ) candidate
        WHERE candidate.Sicil IS NOT NULL AND candidate.Sicil <> @sicil
        ORDER BY candidate.Priority, candidate.Sicil
      ) decisionOwner
      WHERE t.TaskId = @taskId;
    `);
    const task = taskResult.recordset?.[0] || null;
    if (!task) throw new ServerPersistenceError('FORBIDDEN', 'Bu görev için tarih değişikliği talebi oluşturamazsınız.');
    if (!task.IsRequesterAssignee || Number(task.CreatedBySicil) === Number(actor.sicil)
      || hasFullProjectAccess(actor, task.ProjectId) || task.EffectiveDecisionOwnerSicil == null) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bu görev için tarih değişikliği talebi oluşturamazsınız.');
    }
    // Bu uç nokta yalnızca doğrudan hedef bitiş yazamayan görev sorumlusunun
    // onay talebi yoludur. Yetki veritabanındaki güncel görev/kapsam üzerinden
    // doğrulandıktan sonra istemcinin plan tarihleri taşımaya çalışması kesilir.
    const submission = submittedProposal(proposalInput, ASSIGNEE_PROPOSAL_FIELDS);
    const proposal = effectiveProposal(submission, task);
    const changed = DATE_FIELDS.some(([field, column]) => proposal[field] !== isoDate(task[column]));
    if (!changed) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Önerilen tarihler mevcut planla aynıdır.', { status: 400 });
    }

    const requestId = randomUUID();
    const insert = transaction.request();
    insert.input('requestId', sql.UniqueIdentifier, requestId);
    insert.input('taskId', sql.UniqueIdentifier, taskId);
    insert.input('requesterSicil', sql.Int, actor.sicil);
    insert.input('decisionOwnerSicil', sql.Int, task.EffectiveDecisionOwnerSicil);
    insert.input('originalPlannedStart', sql.Date, isoDate(task.PlannedStart));
    insert.input('proposedPlannedStart', sql.Date, proposal.plannedStart);
    insert.input('originalPlannedFinish', sql.Date, isoDate(task.PlannedFinish));
    insert.input('proposedPlannedFinish', sql.Date, proposal.plannedFinish);
    insert.input('originalTargetFinish', sql.Date, isoDate(task.TargetFinish));
    insert.input('proposedTargetFinish', sql.Date, proposal.targetFinish);
    insert.input('requesterMessage', sql.NVarChar(2000), requesterMessage);
    insert.input('taskVersion', sql.Binary(8), task.RowVersion);
    const correlationId = randomUUID();
    const insertResult = await insert.query(`
      DECLARE @CancelledRequests TABLE(RequestId uniqueidentifier PRIMARY KEY);

      UPDATE dbo.MR_TaskScheduleChangeRequests WITH (UPDLOCK, HOLDLOCK)
      SET Status = 'CANCELLED', DecidedAt = SYSUTCDATETIME(),
          DecisionBySicil = @requesterSicil,
          DecisionMessage = N'Yeni tarih talebiyle değiştirildi.'
      OUTPUT inserted.RequestId INTO @CancelledRequests(RequestId)
      WHERE TaskId = @taskId AND RequesterSicil = @requesterSicil AND Status = 'PENDING';

      INSERT dbo.MR_TaskScheduleChangeRequests(
        RequestId, TaskId, RequesterSicil, DecisionOwnerSicil,
        OriginalPlannedStart, ProposedPlannedStart,
        OriginalPlannedFinish, ProposedPlannedFinish,
        OriginalTargetFinish, ProposedTargetFinish,
        RequesterMessage, Status, CreatedAgainstTaskVersion
      ) VALUES(
        @requestId, @taskId, @requesterSicil, @decisionOwnerSicil,
        @originalPlannedStart, @proposedPlannedStart,
        @originalPlannedFinish, @proposedPlannedFinish,
        @originalTargetFinish, @proposedTargetFinish,
        @requesterMessage, 'PENDING', @taskVersion
      );

      SELECT RequestId FROM @CancelledRequests;
    `);
    for (const cancelled of insertResult.recordset || []) {
      await audit(transaction, actor, 'UPDATE', 'TASK_SCHEDULE_REQUEST', cancelled.RequestId, task.ProjectId,
        { status: 'PENDING' }, { status: 'CANCELLED', replacementRequestId: requestId }, correlationId);
    }
    await audit(transaction, actor, 'CREATE', 'TASK_SCHEDULE_REQUEST', requestId, task.ProjectId, null, {
      taskId,
      decisionOwnerSicil: Number(task.EffectiveDecisionOwnerSicil),
      original: Object.fromEntries(DATE_FIELDS.map(([field, column]) => [field, isoDate(task[column])])),
      proposed: proposal,
      status: 'PENDING'
    }, correlationId);
    return readScheduleChange(transaction, actor, requestId);
  }, { deadlockRetries: 2 });
}

export async function decideScheduleChange(requestIdValue, input = {}) {
  const requestId = canonicalId(requestIdValue, 'Talep kimliği');
  const decision = String(input.decision || '').trim().toUpperCase();
  if (!['ACCEPT', 'REJECT'].includes(decision)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Karar ACCEPT veya REJECT olmalıdır.', { status: 400 });
  }
  const decisionMessage = normalizeMessage(input.message);

  return withSqlTransaction(async (transaction) => {
    const actor = await loadAuthorizationContext(transaction);
    const correlationId = randomUUID();
    const lockedRequest = transaction.request();
    lockedRequest.input('requestId', sql.UniqueIdentifier, requestId);
    lockedRequest.input('sicil', sql.Int, actor.sicil);
    const result = await lockedRequest.query(`
      SELECT TOP (1) r.*, t.ProjectId, t.Title AS TaskTitle,
        t.CalendarId, t.IsMilestone, t.PlannedDurationDays,
        t.PlannedStart, t.PlannedFinish, t.TargetFinish, t.RowVersion AS TaskRowVersion,
        COALESCE(t.CalendarId, p.CalendarId, (
          SELECT TOP (1) c.CalendarId
          FROM dbo.MR_Calendars c
          WHERE c.IsDefault = 1 AND c.IsActive = 1
          ORDER BY c.CreatedAt, c.CalendarId
        )) AS EffectiveCalendarId
      FROM dbo.MR_TaskScheduleChangeRequests r WITH (UPDLOCK, HOLDLOCK)
      JOIN dbo.MR_Tasks t WITH (UPDLOCK, HOLDLOCK) ON t.TaskId = r.TaskId
      JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
      WHERE r.RequestId = @requestId
        AND @sicil <> r.RequesterSicil
        AND (
          t.CreatedBySicil = @sicil
          OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
          OR EXISTS (
            SELECT 1
            FROM dbo.MR_ProjectAccess pa
            WHERE pa.ProjectId = t.ProjectId
              AND pa.Sicil = @sicil
              AND pa.IsActive = 1
              AND pa.AccessLevel = 'FULL'
          )
          OR EXISTS (
            SELECT 1
            FROM dbo.MR_V_CorporateProjectAccess access
            WHERE p.SourceType = 'CORPORATE'
              AND access.ProjectCode = UPPER(p.ProjectCode)
              AND access.Sicil = @sicil
          )
        );
    `);
    const row = result.recordset?.[0] || null;
    if (!row || Number(row.DecisionOwnerSicil) !== Number(actor.sicil)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bu tarih talebini karara bağlama yetkiniz yok.');
    }
    if (row.Status !== 'PENDING') {
      throw new ServerPersistenceError('CONFLICT', 'Bu tarih talebi daha önce sonuçlandırılmış.');
    }

    const currentDatesMatch = isoDate(row.PlannedStart) === isoDate(row.OriginalPlannedStart)
      && isoDate(row.PlannedFinish) === isoDate(row.OriginalPlannedFinish)
      && isoDate(row.TargetFinish) === isoDate(row.OriginalTargetFinish);
    const stale = !currentDatesMatch;
    if (decision === 'ACCEPT' && stale) {
      const staleRequest = transaction.request();
      staleRequest.input('requestId', sql.UniqueIdentifier, requestId);
      staleRequest.input('sicil', sql.Int, actor.sicil);
      staleRequest.input('message', sql.NVarChar(2000), decisionMessage);
      await staleRequest.query(`
        UPDATE dbo.MR_TaskScheduleChangeRequests
        SET Status = 'STALE', DecidedAt = SYSUTCDATETIME(),
            DecisionBySicil = @sicil, DecisionMessage = @message
        WHERE RequestId = @requestId AND Status = 'PENDING';
      `);
      await audit(transaction, actor, 'UPDATE', 'TASK_SCHEDULE_REQUEST', requestId, row.ProjectId, { status: 'PENDING' }, { status: 'STALE' }, correlationId);
      return {
        request: await readScheduleChange(transaction, actor, requestId),
        outcome: 'STALE',
        message: 'Görev planı bu talep oluşturulduktan sonra değiştirildi. Talebi güncel plan üzerinden yeniden değerlendirin.'
      };
    }

    if (decision === 'ACCEPT') {
      const scheduleContext = await loadScheduleCalendar(transaction, row);
      const plannedDurationDays = calculatePlannedDurationDays({
        projectId: canonicalActualId(row.ProjectId),
        calendarId: canonicalActualId(row.EffectiveCalendarId),
        plannedStart: isoDate(row.ProposedPlannedStart),
        plannedFinish: isoDate(row.ProposedPlannedFinish),
        milestone: Boolean(row.IsMilestone)
      }, scheduleContext);
      // Süre ZAMANLAMA UFKUNA karşı doğrulanır.
      //
      // Olağan görev yazmalarında bu sınır `commitScalarValidation` içinde
      // uygulanır (`0..MAX_WORKING_DAY_SPAN`); kabul yolu ise süreyi kendisi
      // hesaplayıp doğrudan yazdığı için denetimi tümüyle atlıyordu. Sonuç,
      // KABUL EDİLMİŞ bir talebin CPM'in zamanlayamayacağı bir süre
      // kalıcılaştırmasıydı: takvim tavanını aşan aralıkta `null`, ufku aşan
      // aralıkta ise motorun temsil edemediği bir sayı yazılıyordu. Karar
      // sahibine hata bildirmek, sessizce tutarsız bir satır bırakmaktan iyidir.
      if (plannedDurationDays == null || !Number.isFinite(plannedDurationDays)) {
        throw new ServerPersistenceError(
          'MUTATION_FAILED',
          'Önerilen tarih aralığı zamanlama ufkunun dışında; süre hesaplanamadı. Talebi daha dar bir aralıkla yeniden oluşturun.',
          { status: 400 }
        );
      }
      if (plannedDurationDays < 0 || plannedDurationDays > MAX_WORKING_DAY_SPAN) {
        throw new ServerPersistenceError(
          'MUTATION_FAILED',
          `Önerilen tarih aralığı en fazla ${MAX_WORKING_DAY_SPAN} iş günü olabilir.`,
          { status: 400 }
        );
      }
      const update = transaction.request();
      update.input('requestId', sql.UniqueIdentifier, requestId);
      update.input('taskId', sql.UniqueIdentifier, row.TaskId);
      update.input('sicil', sql.Int, actor.sicil);
      update.input('plannedStart', sql.Date, isoDate(row.ProposedPlannedStart));
      update.input('plannedFinish', sql.Date, isoDate(row.ProposedPlannedFinish));
      update.input('targetFinish', sql.Date, isoDate(row.ProposedTargetFinish));
      update.input('plannedDuration', sql.Decimal(10, 2), plannedDurationDays);
      update.input('message', sql.NVarChar(2000), decisionMessage);
      await update.query(`
        UPDATE dbo.MR_Tasks
        SET PlannedStart = @plannedStart, PlannedFinish = @plannedFinish,
            PlannedDurationDays = @plannedDuration, TargetFinish = @targetFinish,
            UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @sicil
        WHERE TaskId = @taskId;

        UPDATE dbo.MR_TaskScheduleChangeRequests
        SET Status = 'ACCEPTED', DecidedAt = SYSUTCDATETIME(),
            DecisionBySicil = @sicil, DecisionMessage = @message
        WHERE RequestId = @requestId AND Status = 'PENDING';
      `);
      const beforeDates = {
        plannedStart: isoDate(row.PlannedStart),
        plannedFinish: isoDate(row.PlannedFinish),
        plannedDurationDays: row.PlannedDurationDays == null ? null : Number(row.PlannedDurationDays),
        targetFinish: isoDate(row.TargetFinish)
      };
      const afterDates = {
        plannedStart: isoDate(row.ProposedPlannedStart),
        plannedFinish: isoDate(row.ProposedPlannedFinish),
        plannedDurationDays,
        targetFinish: isoDate(row.ProposedTargetFinish)
      };
      await audit(transaction, actor, 'UPDATE', 'TASK', row.TaskId, row.ProjectId, beforeDates, afterDates, correlationId);
      await audit(transaction, actor, 'UPDATE', 'TASK_SCHEDULE_REQUEST', requestId, row.ProjectId, { status: 'PENDING' }, { status: 'ACCEPTED' }, correlationId);
    } else {
      const reject = transaction.request();
      reject.input('requestId', sql.UniqueIdentifier, requestId);
      reject.input('sicil', sql.Int, actor.sicil);
      reject.input('message', sql.NVarChar(2000), decisionMessage);
      await reject.query(`
        UPDATE dbo.MR_TaskScheduleChangeRequests
        SET Status = 'REJECTED', DecidedAt = SYSUTCDATETIME(),
            DecisionBySicil = @sicil, DecisionMessage = @message
        WHERE RequestId = @requestId AND Status = 'PENDING';
      `);
      await audit(transaction, actor, 'UPDATE', 'TASK_SCHEDULE_REQUEST', requestId, row.ProjectId, { status: 'PENDING' }, { status: 'REJECTED' }, correlationId);
    }

    return {
      request: await readScheduleChange(transaction, actor, requestId),
      outcome: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
      message: decision === 'ACCEPT' ? 'Tarih değişikliği kabul edildi.' : 'Tarih değişikliği reddedildi.'
    };
  }, { deadlockRetries: 2 });
}
