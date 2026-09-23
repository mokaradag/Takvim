import 'server-only';
import { randomUUID } from 'node:crypto';
import { canonicalActualId, extractActualId } from '../../domain/identity/actualId.js';
import {
  COORDINATION_DECISIONS,
  COORDINATION_MODES,
  COORDINATION_STATUSES,
  allowedCoordinationDecisions,
  organizationPath
} from '../../domain/assignment/assignmentCoordination.js';
import { TASK_NOTIFICATION_KINDS } from '../../domain/notifications/notificationInbox.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { writeAssignmentNotifications } from '../notifications/taskNotificationStore.js';
import { decodeVersion } from '../repository/versionTokens.js';
import { isAuthoritativeManagerOf, resolveManagementChain } from './managementChain.js';
import { readCoordination } from './assignmentCoordinationQueries.js';

/**
 * Atama koordinasyonu · YAZMA yolu.
 *
 * Tasarımın değişmezi tektir: TALEP EDİLEN sorumlu onaylanana kadar
 * `MR_TaskAssignees` satırı yazılmaz. Onay, sorumluyu ATOMİK olarak ekler ve
 * görevin öteki (kimi zaman görünmeyen) sorumlularına DOKUNMAZ — ekleme ve
 * çıkarma her zaman tek Sicil üzerindedir, küme yeniden yazılmaz.
 *
 * Yetki istemciden gelmez: her karar anında güncel İK ilişkisi
 * (`MR_V_ExecutiveScope`) ve güncel proje yetkisi yeniden okunur. Eski bir
 * alıcı satırı tek başına karar hakkı vermez.
 */

/**
 * Aynı görev + kişi için AÇIK kaydı kapatır; geçmiş silinmez.
 *
 * Yeni kayıt eklenmeden hemen önce, aynı toplu komutta çalışır:
 * `UX_MR_TaskAssignmentCoordinations_OpenRequest` görev + kişi başına tek açık
 * kayda izin verir. Metin `@supersededMessage` ile verilir.
 */
const CLOSE_OPEN_COORDINATIONS_SQL = `
  UPDATE dbo.MR_TaskAssignmentCoordinations WITH (UPDLOCK, HOLDLOCK)
  SET Status = 'CANCELLED', DecidedAt = SYSUTCDATETIME(), DecisionBySicil = @requesterSicil,
      DecisionMessage = @supersededMessage
  WHERE TaskId = @taskId AND RequestedAssigneeSicil = @assigneeSicil
    AND Status IN ('PENDING','CANCELLATION_REQUESTED');
`;

function canonicalId(value, label) {
  const normalized = canonicalActualId(value);
  if (!normalized) {
    throw new ServerPersistenceError('MUTATION_FAILED', `${label} geçerli bir UUID olmalıdır.`, { status: 400 });
  }
  return normalized;
}

function normalizeMessage(value, { required = false, label = 'Açıklama' } = {}) {
  const message = String(value || '').trim();
  if (required && !message) {
    throw new ServerPersistenceError('MUTATION_FAILED', `${label} yazılmalıdır.`, { status: 400 });
  }
  if (message.length > 2000) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Açıklama 2000 karakteri aşamaz.', { status: 400 });
  }
  return message || null;
}

function normalizeSicils(values) {
  const list = Array.isArray(values) ? values : [values];
  const sicils = [...new Set(list
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!sicils.length) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'En az bir personel seçilmelidir.', { status: 400 });
  }
  if (sicils.length > 25) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Tek seferde en fazla 25 personel için talep oluşturulabilir.', { status: 400 });
  }
  return sicils;
}

function hasFullProjectAccess(actor, projectId) {
  if (actor.isSystemAdmin) return true;
  const id = canonicalActualId(projectId) ?? String(projectId);
  return actor.effective.access.get(id)?.accessLevel === 'FULL';
}

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function sortedSicilText(values = []) {
  return [...new Set(values.map(Number))].sort((left, right) => left - right).join(',');
}

async function audit(executor, actor, actionCode, entityId, projectId, before, after, correlationId) {
  const request = executor.request();
  request.input('actorSicil', sql.Int, actor.sicil);
  request.input('username', sql.NVarChar(255), actor.currentUser.username || null);
  request.input('displayName', sql.NVarChar(255), actor.currentUser.name || null);
  request.input('actionCode', sql.VarChar(50), actionCode);
  request.input('entityType', sql.VarChar(50), 'TASK_ASSIGNMENT_COORDINATION');
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

/** İşlem boyunca kilitli görev + proje künyesi. */
async function lockedTask(executor, taskId, actorSicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, actorSicil);
  const result = await request.query(`
    SELECT TOP (1) t.TaskId, t.ProjectId, t.Title, t.TargetFinish, t.Priority,
      t.CreatedBySicil, t.RowVersion,
      p.ProjectName, p.ProjectCode, p.SourceType, p.LeadSicil,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees ta WHERE ta.TaskId = t.TaskId AND ta.Sicil = @sicil
      ) THEN 1 ELSE 0 END AS IsActorAssignee
    FROM dbo.MR_Tasks t WITH (UPDLOCK, HOLDLOCK)
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    WHERE t.TaskId = @taskId;
  `);
  return result.recordset?.[0] || null;
}

async function lockedAssigneeSicils(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await request.query(`
    SELECT Sicil FROM dbo.MR_TaskAssignees WITH (UPDLOCK, HOLDLOCK) WHERE TaskId = @taskId;
  `);
  return (result.recordset || []).map((row) => Number(row.Sicil));
}

/** Rehberde GERÇEKTEN bulunan Siciller. Ad hiçbir zaman kimlik değildir. */
async function directoryPeople(executor, sicils) {
  const request = executor.request();
  request.input('sicils', sql.NVarChar(sql.MAX), sicils.join(','));
  const result = await request.query(`
    SELECT pd.Sicil, pd.DisplayName, pd.Directorate, pd.Department, pd.Unit
    FROM dbo.MR_V_PeopleDirectory pd
    JOIN STRING_SPLIT(@sicils, ',') requested
      ON pd.Sicil = TRY_CONVERT(int, LTRIM(RTRIM(requested.value)));
  `);
  return new Map((result.recordset || []).map((row) => [Number(row.Sicil), {
    sicil: Number(row.Sicil),
    name: row.DisplayName || String(row.Sicil),
    organization: {
      directorate: row.Directorate || null,
      department: row.Department || null,
      unit: row.Unit || null
    }
  }]));
}

/**
 * Yönetim zinciri boşsa kararı TAM PROJE YETKİLİSİ verir.
 *
 * Böylece yöneticisi tanımlı olmayan bir çalışan için talep sahipsiz kalmaz.
 *
 * Aday kümesi, `loadAuthorizationContext` içinde `FULL` yetki üreten kaynakların
 * birebir aynısıdır: MANUAL projenin sorumlusu, `MR_ProjectAccess` üzerindeki
 * etkin FULL kayıt ve CORPORATE projede kurumsal proje rolü. Görev OLUŞTURAN
 * kişi bilinçli olarak dışarıdadır — görev oluşturmak `FULL` proje yetkisi
 * vermez. Daha önce projedeki BÜTÜN görev sahipleri aday sayılıyordu; bu hem
 * göreve erişimi olmayan kullanıcılara görev başlığını, proje künyesini ve
 * talep edilen kişinin adı ile kurumsal yolunu açıyor, hem de sunucunun her
 * zaman reddedeceği bir karar düğmesi gösteriyordu.
 */
async function projectDecisionOwners(executor, task, requesterSicil) {
  const request = executor.request();
  request.input('projectId', sql.UniqueIdentifier, task.ProjectId);
  request.input('projectCode', sql.NVarChar(100), task.ProjectCode || '');
  request.input('sourceType', sql.VarChar(20), task.SourceType || '');
  request.input('requesterSicil', sql.Int, requesterSicil);
  const result = await request.query(`
    SELECT DISTINCT candidate.Sicil
    FROM (
      SELECT p.LeadSicil AS Sicil FROM dbo.MR_Projects p
      WHERE p.ProjectId = @projectId AND p.SourceType = 'MANUAL' AND p.IsActive = 1
      UNION
      SELECT pa.Sicil FROM dbo.MR_ProjectAccess pa
      WHERE pa.ProjectId = @projectId AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL'
      UNION
      SELECT access.Sicil FROM dbo.MR_V_CorporateProjectAccess access
      WHERE @sourceType = 'CORPORATE' AND access.ProjectCode = UPPER(@projectCode)
    ) candidate
    WHERE candidate.Sicil IS NOT NULL AND candidate.Sicil <> @requesterSicil
      AND EXISTS (SELECT 1 FROM dbo.MR_V_PeopleDirectory pd WHERE pd.Sicil = candidate.Sicil);
  `);
  return (result.recordset || []).map((row) => Number(row.Sicil));
}

async function insertRecipients(executor, coordinationId, recipients) {
  for (const [sicil, role] of recipients) {
    const request = executor.request();
    request.input('coordinationId', sql.UniqueIdentifier, coordinationId);
    request.input('sicil', sql.Int, Number(sicil));
    request.input('role', sql.VarChar(20), role);
    await request.query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_AssignmentCoordinationRecipients WITH (UPDLOCK, HOLDLOCK)
        WHERE CoordinationId = @coordinationId AND Sicil = @sicil
      )
      INSERT dbo.MR_AssignmentCoordinationRecipients(CoordinationId, Sicil, RecipientRole)
      VALUES(@coordinationId, @sicil, @role);
    `);
  }
}

/**
 * Yeni atama koordinasyonu oluşturur.
 *
 * Sıradan kullanıcı için sonuç her zaman ONAY BEKLEYEN bir taleptir; hiçbir
 * durumda doğrudan atama yazılmaz.
 */
export async function createAssignmentCoordination(input = {}) {
  // İstemci, yeni oluşturulan görev için kendi önekli kimliğini taşıyabilir;
  // her iki biçim de tek kanonik Gerçek Sistem kimliğine indirilir.
  const taskId = extractActualId(input.taskId);
  if (!taskId) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Görev kimliği geçerli bir UUID olmalıdır.', { status: 400 });
  }
  const requestedSicils = normalizeSicils(input.assigneeSicils ?? input.assigneeSicil);
  const requesterMessage = normalizeMessage(input.message, { label: 'Talep notu' });

  return withSqlTransaction(async (transaction) => {
    const actor = await loadAuthorizationContext(transaction);
    const task = await lockedTask(transaction, taskId, actor.sicil);
    // Görevle YETKİLİ bir ilişkisi olmayan kullanıcı talep açamaz. Tek ve aynı
    // ileti döner: var olan ve olmayan görev ayırt edilemez.
    const relatedToTask = actor.isSystemAdmin
      || (task && (hasFullProjectAccess(actor, task.ProjectId)
        || Number(task.CreatedBySicil) === Number(actor.sicil)
        || Boolean(task.IsActorAssignee)));
    if (!task || !relatedToTask) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bu görev için atama talebi oluşturamazsınız.');
    }

    if (requestedSicils.includes(Number(actor.sicil))) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        'Kendinizi göreve doğrudan ekleyebilirsiniz; kendiniz için atama talebi oluşturulmaz.',
        { status: 400 }
      );
    }

    const current = await lockedAssigneeSicils(transaction, taskId);
    const currentSet = new Set(current.map(Number));
    const people = await directoryPeople(transaction, requestedSicils);
    const unknown = requestedSicils.filter((sicil) => !people.has(sicil));
    if (unknown.length) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        `Kurumsal personel kaydında bulunamayan sicil: ${unknown.join(', ')}`,
        { status: 400 }
      );
    }
    const pending = requestedSicils.filter((sicil) => !currentSet.has(sicil));
    if (!pending.length) {
      throw new ServerPersistenceError('CONFLICT', 'Seçilen personel görevin sorumlusu olarak zaten kayıtlı.');
    }

    const chains = await resolveManagementChain(transaction, pending, { excludeSicils: [actor.sicil] });
    let fallbackOwners = null;
    const correlationId = randomUUID();
    const created = [];

    for (const sicil of pending) {
      let managers = chains.get(sicil) || [];
      if (!managers.length) {
        fallbackOwners ||= await projectDecisionOwners(transaction, task, actor.sicil);
        managers = fallbackOwners;
      }
      if (!managers.length) {
        throw new ServerPersistenceError(
          'MUTATION_FAILED',
          'Bu personel için talebi karara bağlayacak bir yönetici bulunamadı.',
          { status: 400 }
        );
      }

      const person = people.get(sicil);
      const coordinationId = randomUUID();
      const insert = transaction.request();
      insert.input('coordinationId', sql.UniqueIdentifier, coordinationId);
      insert.input('taskId', sql.UniqueIdentifier, taskId);
      insert.input('requesterSicil', sql.Int, actor.sicil);
      insert.input('assigneeSicil', sql.Int, sicil);
      insert.input('mode', sql.VarChar(20), COORDINATION_MODES.REQUEST);
      insert.input('status', sql.VarChar(25), COORDINATION_STATUSES.PENDING);
      insert.input('requesterMessage', sql.NVarChar(2000), requesterMessage);
      insert.input('originalAssignees', sql.NVarChar(2000), sortedSicilText(current));
      insert.input('taskTitle', sql.NVarChar(1000), task.Title || null);
      insert.input('projectId', sql.UniqueIdentifier, task.ProjectId);
      insert.input('projectName', sql.NVarChar(1000), task.ProjectName || null);
      insert.input('projectCode', sql.NVarChar(100), task.ProjectCode || null);
      insert.input('assigneeName', sql.NVarChar(1000), person.name);
      insert.input('assigneeOrg', sql.NVarChar(1000), organizationPath(person.organization) || null);
      insert.input('targetFinish', sql.Date, isoDate(task.TargetFinish));
      insert.input('taskVersion', sql.Binary(8), task.RowVersion);
      insert.input('correlationId', sql.UniqueIdentifier, correlationId);
      insert.input('supersededMessage', sql.NVarChar(2000), 'Yeni atama talebiyle değiştirildi.');
      await insert.query(`
        ${CLOSE_OPEN_COORDINATIONS_SQL}

        INSERT dbo.MR_TaskAssignmentCoordinations(
          CoordinationId, TaskId, RequesterSicil, RequestedAssigneeSicil, Mode, Status,
          RequesterMessage, OriginalAssigneeSicils, TaskTitleSnapshot, ProjectIdSnapshot,
          ProjectNameSnapshot, ProjectCodeSnapshot, AssigneeNameSnapshot, AssigneeOrgSnapshot,
          TargetFinishSnapshot, CreatedAgainstTaskVersion, CorrelationId
        ) VALUES(
          @coordinationId, @taskId, @requesterSicil, @assigneeSicil, @mode, @status,
          @requesterMessage, @originalAssignees, @taskTitle, @projectId,
          @projectName, @projectCode, @assigneeName, @assigneeOrg,
          @targetFinish, @taskVersion, @correlationId
        );
      `);
      await insertRecipients(transaction, coordinationId, [
        ...managers.map((manager) => [manager, 'MANAGER']),
        [actor.sicil, 'REQUESTER']
      ]);
      await audit(transaction, actor, 'CREATE', coordinationId, task.ProjectId, null, {
        taskId,
        requestedAssigneeSicil: sicil,
        managerSicils: managers,
        status: COORDINATION_STATUSES.PENDING,
        mode: COORDINATION_MODES.REQUEST
      }, correlationId);
      created.push(coordinationId);
    }

    const items = [];
    for (const coordinationId of created) {
      items.push(await readCoordination(transaction, actor, coordinationId));
    }
    return { ok: true, items: items.filter(Boolean) };
  }, { deadlockRetries: 2 });
}

/**
 * Kurum dışı DOĞRUDAN atamanın koordinasyon kaydı.
 *
 * Yetkili bir atayıcı (tam proje yetkisi ya da yönetici kapsamı) kendi
 * kapsamının dışındaki bir çalışanı göreve eklediğinde çağrılır: atama zaten
 * yürürlüktedir, bu kayıt karşı yönetim zincirini haberdar eder ve itiraz
 * yolunu (Atamanın Kaldırılmasını İste) açar.
 *
 * Görev yazmasıyla AYNI işlemde çalışır.
 */
export async function recordCrossOrganizationAssignments(executor, actor, {
  correlationId,
  assignments = []
} = {}) {
  if (!assignments.length) return [];
  const created = [];
  for (const assignment of assignments) {
    const managers = assignment.managerSicils || [];
    const coordinationId = randomUUID();
    const insert = executor.request();
    insert.input('coordinationId', sql.UniqueIdentifier, coordinationId);
    insert.input('taskId', sql.UniqueIdentifier, assignment.taskId);
    insert.input('requesterSicil', sql.Int, actor.sicil);
    insert.input('assigneeSicil', sql.Int, Number(assignment.assigneeSicil));
    insert.input('mode', sql.VarChar(20), COORDINATION_MODES.NOTICE);
    insert.input('status', sql.VarChar(25), COORDINATION_STATUSES.APPROVED);
    insert.input('originalAssignees', sql.NVarChar(2000), sortedSicilText(assignment.assigneeSicils || []));
    insert.input('taskTitle', sql.NVarChar(1000), assignment.taskTitle || null);
    insert.input('projectId', sql.UniqueIdentifier, assignment.projectId || null);
    insert.input('projectName', sql.NVarChar(1000), assignment.projectName || null);
    insert.input('projectCode', sql.NVarChar(100), assignment.projectCode || null);
    insert.input('assigneeName', sql.NVarChar(1000), assignment.assigneeName || null);
    insert.input('assigneeOrg', sql.NVarChar(1000), assignment.assigneeOrganization || null);
    insert.input('targetFinish', sql.Date, assignment.targetFinish || null);
    insert.input('correlationId', sql.UniqueIdentifier, correlationId);
    insert.input('supersededMessage', sql.NVarChar(2000), 'Doğrudan atamayla karşılandı.');
    // Aynı kişi için AÇIK bir talep varsa doğrudan atama onu karşılamıştır ve
    // kayıt aynı işlemde kapatılır. Kapatılmadığında görev + kişi için iki
    // kayıt birden yaşıyordu: yönetici yürürlükteki atamanın kaldırılmasını
    // istediğinde bildirim CANCELLATION_REQUESTED durumuna geçiyor, açık kayıt
    // benzersizlik kuralına (UX_..._OpenRequest) çarpıyor ve karar düşüyordu.
    await insert.query(`
      ${CLOSE_OPEN_COORDINATIONS_SQL}

      INSERT dbo.MR_TaskAssignmentCoordinations(
        CoordinationId, TaskId, RequesterSicil, RequestedAssigneeSicil, Mode, Status,
        OriginalAssigneeSicils, TaskTitleSnapshot, ProjectIdSnapshot,
        ProjectNameSnapshot, ProjectCodeSnapshot, AssigneeNameSnapshot, AssigneeOrgSnapshot,
        TargetFinishSnapshot, CorrelationId, DecidedAt
      ) VALUES(
        @coordinationId, @taskId, @requesterSicil, @assigneeSicil, @mode, @status,
        @originalAssignees, @taskTitle, @projectId,
        @projectName, @projectCode, @assigneeName, @assigneeOrg,
        @targetFinish, @correlationId, SYSUTCDATETIME()
      );
    `);
    await insertRecipients(executor, coordinationId, [
      ...managers.map((manager) => [manager, 'MANAGER']),
      [Number(assignment.assigneeSicil), 'ASSIGNEE'],
      [actor.sicil, 'REQUESTER']
    ]);
    created.push(coordinationId);
  }
  return created;
}

async function setCoordinationStatus(executor, coordinationId, status, {
  actorSicil,
  message = null,
  suggestedAssigneeSicil = null
}) {
  const request = executor.request();
  request.input('coordinationId', sql.UniqueIdentifier, coordinationId);
  request.input('status', sql.VarChar(25), status);
  request.input('actorSicil', sql.Int, Number(actorSicil));
  request.input('message', sql.NVarChar(2000), message);
  request.input('suggested', sql.Int, suggestedAssigneeSicil == null ? null : Number(suggestedAssigneeSicil));
  await request.query(`
    UPDATE dbo.MR_TaskAssignmentCoordinations
    SET Status = @status, DecidedAt = SYSUTCDATETIME(), DecisionBySicil = @actorSicil,
        DecisionMessage = COALESCE(@message, DecisionMessage),
        SuggestedAssigneeSicil = COALESCE(@suggested, SuggestedAssigneeSicil)
    WHERE CoordinationId = @coordinationId;
  `);
}

/**
 * Görev satırının SÜRÜMÜNÜ ilerletir.
 *
 * Sorumlu kümesi `MR_TaskAssignees` üzerinde değişir; görev satırına
 * dokunulmadığında `MR_Tasks.RowVersion` aynı kalır. Kararla aynı anda görevi
 * açık tutan bir düzenleyici, elindeki ESKİ sürüm ve ESKİ `assigneeIds` ile
 * ilgisiz bir düzenlemeyi kaydedebiliyor; `commitTask` listeyi bilinçli bir
 * değişiklik sayıp ilişkiyi yeniden yazıyor ve yeni onaylanan sorumluyu sessizce
 * siliyordu. Sürüm ilerletildiğinde o kayıt bayat sürüm olarak reddedilir.
 */
async function touchTaskVersion(executor, taskId, actorSicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('actorSicil', sql.Int, Number(actorSicil));
  await request.query(`
    UPDATE dbo.MR_Tasks
    SET UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
    WHERE TaskId = @taskId;
  `);
}

/** Tek Sicil ekler; görevin öteki sorumlularına DOKUNMAZ. */
async function addTaskAssignee(executor, taskId, sicil, actorSicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, Number(sicil));
  request.input('actorSicil', sql.Int, Number(actorSicil));
  await request.query(`
    IF NOT EXISTS (
      SELECT 1 FROM dbo.MR_TaskAssignees WITH (UPDLOCK, HOLDLOCK)
      WHERE TaskId = @taskId AND Sicil = @sicil
    )
    INSERT dbo.MR_TaskAssignees(TaskId, Sicil, AssignedBySicil)
    VALUES(@taskId, @sicil, @actorSicil);
  `);
  await touchTaskVersion(executor, taskId, actorSicil);
}

/** Tek Sicil çıkarır; görevin öteki sorumlularına DOKUNMAZ. */
async function removeTaskAssignee(executor, taskId, sicil, actorSicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, Number(sicil));
  await request.query(`
    DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId AND Sicil = @sicil;
  `);
  await touchTaskVersion(executor, taskId, actorSicil);
}

/**
 * Aynı gönderimden doğan KARDEŞ taleplerin Sicilleri.
 *
 * Çok kişilik tek bir talepte her satır aynı `OriginalAssigneeSicils` künyesini
 * taşır. İlk satır onaylanınca sorumlu kümesi değişir ve kardeş satırlar — hiç
 * kimse görevi düzenlememiş olmasına karşın — bayat sayılıyordu; bir gönderimden
 * yalnızca tek kişi onaylanabiliyordu.
 */
async function siblingRequestedSicils(executor, row) {
  if (!row.CorrelationId) return [];
  const request = executor.request();
  request.input('correlationId', sql.UniqueIdentifier, row.CorrelationId);
  request.input('taskId', sql.UniqueIdentifier, row.TaskId);
  request.input('coordinationId', sql.UniqueIdentifier, row.CoordinationId);
  const result = await request.query(`
    SELECT RequestedAssigneeSicil FROM dbo.MR_TaskAssignmentCoordinations
    WHERE CorrelationId = @correlationId AND TaskId = @taskId
      AND CoordinationId <> @coordinationId;
  `);
  return (result.recordset || []).map((sibling) => Number(sibling.RequestedAssigneeSicil));
}

/**
 * Onay, kaydın oluşturulduğu andaki YETKİLİ sorumlu kümesine dayanır.
 *
 * Kümeden bir kişi düşmüş ya da kaydın kendi gönderimine ait olmayan bir Sicil
 * eklenmişse plan bu arada değişmiştir ve karar uygulanmaz.
 */
function assigneeSetIsStale(currentAssignees, originalText, siblings = []) {
  const current = new Set(currentAssignees.map(Number));
  const original = String(originalText ?? '')
    .split(',')
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const allowed = new Set([...original, ...siblings.map(Number)]);
  if (original.some((sicil) => !current.has(sicil))) return true;
  return [...current].some((sicil) => !allowed.has(sicil));
}

function decisionStatus(decision, currentStatus) {
  if (currentStatus === COORDINATION_STATUSES.PENDING) {
    if (decision === COORDINATION_DECISIONS.APPROVE) return COORDINATION_STATUSES.APPROVED;
    if (decision === COORDINATION_DECISIONS.REJECT) return COORDINATION_STATUSES.REJECTED;
    if (decision === COORDINATION_DECISIONS.REQUEST_CHANGE) return COORDINATION_STATUSES.CHANGE_REQUESTED;
    if (decision === COORDINATION_DECISIONS.CANCEL) return COORDINATION_STATUSES.CANCELLED;
  }
  if (currentStatus === COORDINATION_STATUSES.APPROVED
    && decision === COORDINATION_DECISIONS.REQUEST_CANCELLATION) {
    return COORDINATION_STATUSES.CANCELLATION_REQUESTED;
  }
  if (currentStatus === COORDINATION_STATUSES.CANCELLATION_REQUESTED) {
    if (decision === COORDINATION_DECISIONS.APPROVE) return COORDINATION_STATUSES.CANCELLED;
    if (decision === COORDINATION_DECISIONS.REJECT) return COORDINATION_STATUSES.APPROVED;
  }
  return null;
}

/**
 * Koordinasyon kaydını karara bağlar.
 *
 * Yetki, güncel İK ilişkisinden ve güncel proje yetkisinden yeniden türetilir;
 * bayatlık denetimi kaydın oluşturulduğu andaki YETKİLİ sorumlu kümesine göre
 * yapılır. Arada sorumlu kümesi değiştiyse karar uygulanmaz ve kayıt STALE olur.
 */
export async function decideAssignmentCoordination(coordinationIdValue, input = {}) {
  const coordinationId = canonicalId(coordinationIdValue, 'Koordinasyon kimliği');
  const decision = String(input.decision || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(COORDINATION_DECISIONS, decision)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Karar türü geçersiz.', { status: 400 });
  }
  const decisionMessage = normalizeMessage(input.message, {
    required: decision === COORDINATION_DECISIONS.REQUEST_CHANGE,
    label: 'Değişiklik gerekçesi'
  });
  const expectedVersion = input.version ? decodeVersion(input.version) : null;
  const suggestedInput = input.suggestedAssigneeSicil == null || input.suggestedAssigneeSicil === ''
    ? null : Number(input.suggestedAssigneeSicil);
  if (suggestedInput != null && (!Number.isSafeInteger(suggestedInput) || suggestedInput <= 0)) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Önerilen personel sicili geçersiz.', { status: 400 });
  }

  return withSqlTransaction(async (transaction) => {
    const actor = await loadAuthorizationContext(transaction);
    const correlationId = randomUUID();
    const lock = transaction.request();
    lock.input('coordinationId', sql.UniqueIdentifier, coordinationId);
    lock.input('sicil', sql.Int, actor.sicil);
    // Alıcı satırı SORGULANMAZ: karar yetkisi yalnızca canlı veriden türetilir
    // (aşağıdaki `isManager`), kayıttaki satır bir posta kutusu girdisidir.
    // `LiveProjectId` görev satırından gelir ve proje kapatılsa da dolu kalır;
    // projenin ETKİN olduğunu yalnızca `LiveActiveProjectId` söyler.
    const locked = await lock.query(`
      SELECT TOP (1) c.*, t.TaskId AS LiveTaskId, t.Title AS LiveTaskTitle,
        t.ProjectId AS LiveProjectId, t.TargetFinish AS LiveTargetFinish, t.Priority AS LivePriority,
        p.ProjectId AS LiveActiveProjectId,
        p.ProjectName AS LiveProjectName, p.ProjectCode AS LiveProjectCode
      FROM dbo.MR_TaskAssignmentCoordinations c WITH (UPDLOCK, HOLDLOCK)
      LEFT JOIN dbo.MR_Tasks t WITH (UPDLOCK, HOLDLOCK) ON t.TaskId = c.TaskId
      LEFT JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
      WHERE c.CoordinationId = @coordinationId;
    `);
    const row = locked.recordset?.[0] || null;
    if (!row) throw new ServerPersistenceError('FORBIDDEN', 'Bu koordinasyon kaydını karara bağlama yetkiniz yok.');

    const isRequester = Number(row.RequesterSicil) === Number(actor.sicil);
    // Yönetici yetkisi GÜNCEL İK ilişkisinden doğrulanır: kayıttaki alıcı satırı
    // tek başına karar hakkı vermez.
    const isManager = !isRequester && (
      actor.isSystemAdmin
      || (row.LiveProjectId && hasFullProjectAccess(actor, row.LiveProjectId))
      || await isAuthoritativeManagerOf(transaction, actor.sicil, row.RequestedAssigneeSicil)
    );
    if (!isRequester && !isManager) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bu koordinasyon kaydını karara bağlama yetkiniz yok.');
    }
    if (!allowedCoordinationDecisions(row.Status, { isManager, isRequester }).includes(decision)) {
      throw new ServerPersistenceError('CONFLICT', 'Bu kayıt için seçilen işlem uygulanabilir değil.');
    }
    if (expectedVersion && Buffer.compare(Buffer.from(row.RowVersion), Buffer.from(expectedVersion)) !== 0) {
      throw new ServerPersistenceError('CONFLICT', 'Koordinasyon kaydı bu sırada güncellendi. Verileri yeniden yükleyin.');
    }

    const nextStatus = decisionStatus(decision, row.Status);
    if (!nextStatus) throw new ServerPersistenceError('CONFLICT', 'Bu kayıt için seçilen işlem uygulanabilir değil.');

    // Karar veren aktör yetkisini CANLI veriden almış olabilir (sistem
    // yöneticisi ya da tam proje yetkilisi); alıcı satırı yoksa kendi kararını
    // okuyamıyor ve yanıtta `record: null` alıyordu. Satır bir POSTA KUTUSU
    // kaydıdır, yetki belgesi değildir: karar yetkisi yine canlı veriden gelir.
    if (isManager) {
      await insertRecipients(transaction, coordinationId, [[Number(actor.sicil), 'MANAGER']]);
    }

    // Yalnızca sorumlu kümesine DOKUNAN kararlar bayatlık denetiminden geçer.
    const applies = decision === COORDINATION_DECISIONS.APPROVE;
    // Kapatılmış proje de bayatlık nedenidir: öteki bütün görev yazma yolları
    // etkin olmayan projeyi reddeder (bkz. sqlAppRepository.js ·
    // assertActiveProject). Denetim yalnızca görevin varlığına bakınca onay,
    // kapatılmış projedeki göreve sorumlu yazıyor ve görev sürümünü
    // ilerletiyordu; atama anlık görüntüde de görünmüyordu.
    if (applies && (!row.LiveTaskId || !row.LiveActiveProjectId)) {
      await setCoordinationStatus(transaction, coordinationId, COORDINATION_STATUSES.STALE, {
        actorSicil: actor.sicil, message: decisionMessage
      });
      await audit(transaction, actor, 'UPDATE', coordinationId, row.ProjectIdSnapshot,
        { status: row.Status }, { status: COORDINATION_STATUSES.STALE }, correlationId);
      return {
        record: await readCoordination(transaction, actor, coordinationId),
        outcome: COORDINATION_STATUSES.STALE,
        message: 'İlgili görev silinmiş veya projesi kapatılmış; kayıt güncelliğini yitirdi.'
      };
    }

    let currentAssignees = null;
    if (applies) {
      currentAssignees = await lockedAssigneeSicils(transaction, row.TaskId);
      // Kaldırma onayında ölçüt tekil üyeliktir: kişi arada zaten çıkarılmışsa
      // kararın uygulayacağı bir şey kalmamıştır.
      const stale = row.Status === COORDINATION_STATUSES.CANCELLATION_REQUESTED
        ? !currentAssignees.map(Number).includes(Number(row.RequestedAssigneeSicil))
        : assigneeSetIsStale(
          currentAssignees,
          row.OriginalAssigneeSicils,
          await siblingRequestedSicils(transaction, row)
        );
      if (stale) {
        await setCoordinationStatus(transaction, coordinationId, COORDINATION_STATUSES.STALE, {
          actorSicil: actor.sicil, message: decisionMessage
        });
        await audit(transaction, actor, 'UPDATE', coordinationId, row.LiveProjectId,
          { status: row.Status }, { status: COORDINATION_STATUSES.STALE }, correlationId);
        return {
          record: await readCoordination(transaction, actor, coordinationId),
          outcome: COORDINATION_STATUSES.STALE,
          message: 'Görevin sorumluları bu kayıt oluşturulduktan sonra değişti. Talebi güncel durumla yeniden oluşturun.'
        };
      }
    }

    let suggestedAssigneeSicil = null;
    if (decision === COORDINATION_DECISIONS.REQUEST_CHANGE && suggestedInput != null) {
      // Yönetici yalnızca KENDİ kapsamındaki bir çalışanı önerebilir; öneri
      // kimliği Sicil'dir, ad değildir.
      const inScope = actor.isSystemAdmin
        || await isAuthoritativeManagerOf(transaction, actor.sicil, suggestedInput);
      if (!inScope) {
        throw new ServerPersistenceError('FORBIDDEN', 'Yalnızca kendi personelinizi alternatif olarak önerebilirsiniz.');
      }
      suggestedAssigneeSicil = suggestedInput;
    }

    const notificationChanges = [];
    const taskIdentity = {
      title: row.LiveTaskTitle || row.TaskTitleSnapshot,
      projectId: row.LiveProjectId || row.ProjectIdSnapshot,
      projectName: row.LiveProjectName || row.ProjectNameSnapshot,
      projectCode: row.LiveProjectCode || row.ProjectCodeSnapshot,
      targetFinish: isoDate(row.LiveTargetFinish ?? row.TargetFinishSnapshot),
      priority: row.LivePriority || null
    };

    if (nextStatus === COORDINATION_STATUSES.APPROVED && row.Status === COORDINATION_STATUSES.PENDING) {
      await addTaskAssignee(transaction, row.TaskId, row.RequestedAssigneeSicil, actor.sicil);
      await insertRecipients(transaction, coordinationId, [[Number(row.RequestedAssigneeSicil), 'ASSIGNEE']]);
      notificationChanges.push({
        taskId: String(row.TaskId).toLowerCase(),
        added: [Number(row.RequestedAssigneeSicil)],
        removed: [],
        task: taskIdentity
      });
    } else if (nextStatus === COORDINATION_STATUSES.CANCELLED
      && row.Status === COORDINATION_STATUSES.CANCELLATION_REQUESTED) {
      await removeTaskAssignee(transaction, row.TaskId, row.RequestedAssigneeSicil, actor.sicil);
      notificationChanges.push({
        taskId: String(row.TaskId).toLowerCase(),
        added: [],
        removed: [Number(row.RequestedAssigneeSicil)],
        task: taskIdentity
      });
    }

    await setCoordinationStatus(transaction, coordinationId, nextStatus, {
      actorSicil: actor.sicil,
      message: decisionMessage,
      suggestedAssigneeSicil
    });
    if (notificationChanges.length) {
      await writeAssignmentNotifications(transaction, {
        actorSicil: actor.sicil,
        actorName: actor.currentUser?.name || null,
        correlationId,
        changes: notificationChanges
      });
    }
    await audit(transaction, actor, 'UPDATE', coordinationId, row.LiveProjectId || row.ProjectIdSnapshot,
      { status: row.Status }, {
        status: nextStatus,
        decision,
        requestedAssigneeSicil: Number(row.RequestedAssigneeSicil),
        suggestedAssigneeSicil
      }, correlationId);

    return {
      record: await readCoordination(transaction, actor, coordinationId),
      outcome: nextStatus,
      message: {
        [COORDINATION_STATUSES.APPROVED]: 'Atama onaylandı.',
        [COORDINATION_STATUSES.REJECTED]: 'Atama talebi reddedildi.',
        [COORDINATION_STATUSES.CHANGE_REQUESTED]: 'Değişiklik isteği gönderildi.',
        [COORDINATION_STATUSES.CANCELLATION_REQUESTED]: 'Atamanın kaldırılması istendi.',
        [COORDINATION_STATUSES.CANCELLED]: 'Atama kaldırıldı.'
      }[nextStatus] || 'Kayıt güncellendi.'
    };
  }, { deadlockRetries: 2 });
}

export { TASK_NOTIFICATION_KINDS };
