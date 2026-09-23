import 'server-only';
import { TASK_NOTIFICATION_KINDS } from '../../domain/notifications/notificationInbox.js';
import { sql } from '../db/pool.js';

/**
 * Görev bildirimlerinin YAZMA yolu.
 *
 * Kayıt yalnızca YETKİLİ sorumlu kümesi gerçekten değiştiğinde yazılır: başlık,
 * açıklama, öncelik ya da tarih düzenlemesi "size görev atandı" bildirimini
 * yeniden göndermez. Kişi kendini atadığında bildirim üretilmez.
 *
 * Toplu ve yinelenen yazmalarda kişi başına TEK satır üretilir: kırk yinelemeli
 * bir seri kırk bildirim değil, "40 görev" taşıyan bir bildirim olur. Olay
 * anahtarı işlem ilişkilendirme kimliğinden türetildiği için aynı yazma iki kez
 * uygulanamaz (idempotent).
 */

const NOTIFICATION_TABLE_MISSING = new Set([208, 4145]);

/** Göç uygulanmadan açılan kurulumda bildirim sessizce atlanır. */
export function isMissingNotificationSchema(error) {
  const number = Number(error?.number);
  const message = String(error?.message || '');
  return NOTIFICATION_TABLE_MISSING.has(number) && [
    'MR_TaskNotifications',
    'MR_TaskMailOutbox',
    'MR_TaskAssignmentCoordinations',
    'MR_AssignmentCoordinationRecipients'
  ].some((name) => message.includes(name));
}

function sicilSet(values = []) {
  return new Set((values || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0));
}

/**
 * Sorumlu kümesi farkı.
 *
 * @returns {{added: number[], removed: number[]}}
 */
export function assigneeSetDelta(before = [], after = []) {
  const previous = sicilSet(before);
  const next = sicilSet(after);
  return {
    added: [...next].filter((sicil) => !previous.has(sicil)).sort((left, right) => left - right),
    removed: [...previous].filter((sicil) => !next.has(sicil)).sort((left, right) => left - right)
  };
}

/**
 * Değişiklik kümesini alıcı başına TEK bildirime indirger.
 *
 * SAF işlev: veritabanına dokunmaz, böylece toplama kuralı tek başına
 * sınanabilir.
 *
 * @param {Array} changes `{ taskId, added, removed, task }`
 * @param {number} actorSicil zil için kendine atama bildirilmez
 * @param {{includeActor?: boolean}} options açık e-posta niyetinde aktör de alıcı olabilir
 */
export function aggregateAssignmentNotifications(changes = [], actorSicil, { includeActor = false } = {}) {
  const actor = Number(actorSicil);
  const buckets = new Map();
  for (const change of changes) {
    for (const [kind, sicils] of [
      [TASK_NOTIFICATION_KINDS.TASK_ASSIGNED, change?.added || []],
      [TASK_NOTIFICATION_KINDS.TASK_UNASSIGNED, change?.removed || []]
    ]) {
      for (const sicil of sicils) {
        const recipient = Number(sicil);
        if (!Number.isSafeInteger(recipient) || recipient <= 0 || (!includeActor && recipient === actor)) continue;
        const key = `${recipient}:${kind}`;
        if (!buckets.has(key)) {
          buckets.set(key, { recipientSicil: recipient, kind, taskCount: 0, task: change?.task || null, taskId: change?.taskId || null });
        }
        const bucket = buckets.get(key);
        if (bucket.taskCount > 0 && bucket.task
          && String(bucket.task.projectId || '') !== String(change?.task?.projectId || '')) {
          bucket.task = { ...bucket.task, projectId: null, projectName: null, projectCode: null };
        }
        bucket.taskCount += 1;
      }
    }
  }
  return [...buckets.values()].sort((left, right) => left.recipientSicil - right.recipientSicil
    || left.kind.localeCompare(right.kind));
}

/**
 * Toplanmış bildirimleri görev işlemiyle AYNI işlemde yazar.
 *
 * Yazma dayanıklıdır: görev kalıcı olduysa bildirim de kalıcıdır.
 */
export async function writeAssignmentNotifications(executor, {
  actorSicil,
  actorName = null,
  correlationId,
  changes = []
} = {}) {
  const entries = aggregateAssignmentNotifications(changes, actorSicil);
  if (!entries.length) return [];
  for (const entry of entries) {
    const request = executor.request();
    request.input('recipientSicil', sql.Int, entry.recipientSicil);
    request.input('kind', sql.VarChar(30), entry.kind);
    request.input('taskId', sql.UniqueIdentifier, entry.taskId || null);
    request.input('actorSicil', sql.Int, Number(actorSicil));
    request.input('actorName', sql.NVarChar(1000), actorName);
    request.input('taskTitle', sql.NVarChar(1000), entry.task?.title || null);
    request.input('projectId', sql.UniqueIdentifier, entry.task?.projectId || null);
    request.input('projectName', sql.NVarChar(1000), entry.task?.projectName || null);
    request.input('projectCode', sql.NVarChar(100), entry.task?.projectCode || null);
    request.input('targetFinish', sql.Date, entry.task?.targetFinish || null);
    request.input('priority', sql.VarChar(20), entry.task?.priority || null);
    request.input('taskCount', sql.Int, entry.taskCount);
    request.input('eventKey', sql.NVarChar(200), `${correlationId}:${entry.kind}`);
    await request.query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_TaskNotifications WITH (UPDLOCK, HOLDLOCK)
        WHERE RecipientSicil = @recipientSicil AND EventKey = @eventKey
      )
      INSERT dbo.MR_TaskNotifications(
        RecipientSicil, Kind, TaskId, ActorSicil, ActorNameSnapshot, TaskTitleSnapshot,
        ProjectIdSnapshot, ProjectNameSnapshot, ProjectCodeSnapshot,
        TargetFinishSnapshot, PrioritySnapshot, TaskCount, EventKey
      ) VALUES (
        @recipientSicil, @kind, @taskId, @actorSicil, @actorName, @taskTitle,
        @projectId, @projectName, @projectCode,
        @targetFinish, @priority, @taskCount, @eventKey
      );
    `);
  }
  return entries;
}
