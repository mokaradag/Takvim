import 'server-only';
import { sql } from '../db/pool.js';

/**
 * Görev bildirim postasının DAYANIKLI kuyruğu.
 *
 * Kuyruğa yazma, görev yazmasıyla AYNI işlemdedir; SMTP çağrısı bu yolda
 * HİÇ yapılmaz. Görev kaydı posta sunucusu erişilemez olsa da tamamlanır ve
 * `api.commit` süresi SMTP'ye bağlı değildir.
 *
 * Teslimat arka plan çalışanındadır (bkz. taskMailWorker.js). Kiralama ve
 * tekilleştirme anahtarı sayesinde yeniden deneme aynı iletiyi ikinci kez
 * göndermez.
 */

export const TASK_MAIL_KINDS = Object.freeze({ TASK_ASSIGNMENT: 'TASK_ASSIGNMENT' });

const MISSING_TABLE_NUMBERS = new Set([208, 4145]);

export function isMissingTaskMailSchema(error) {
  const number = Number(error?.number);
  return MISSING_TABLE_NUMBERS.has(number) && String(error?.message || '').includes('MR_TaskMailOutbox');
}

/** Kaç deneme sonra kayıt BAŞARISIZ sayılır (yönetim konsolunda görünür). */
export const TASK_MAIL_MAX_ATTEMPTS = 6;
const RETRY_BASE_SECONDS = 60;
const LEASE_SECONDS = 120;

/**
 * Posta NİYETİNİ yazar.
 *
 * @param {Array} entries `{ taskId, recipientSicil, payload }`
 * @returns {Promise<number>} yazılan satır sayısı
 */
export async function enqueueTaskAssignmentMail(executor, { correlationId, entries = [] } = {}) {
  let written = 0;
  for (const entry of entries) {
    const recipientSicil = Number(entry?.recipientSicil);
    if (!Number.isSafeInteger(recipientSicil) || recipientSicil <= 0) continue;
    const request = executor.request();
    request.input('kind', sql.VarChar(30), TASK_MAIL_KINDS.TASK_ASSIGNMENT);
    request.input('taskId', sql.UniqueIdentifier, entry.taskId || null);
    request.input('recipientSicil', sql.Int, recipientSicil);
    request.input('payload', sql.NVarChar(sql.MAX), JSON.stringify(entry.payload || {}));
    request.input('dedupeKey', sql.NVarChar(200), `${correlationId}:${entry.taskId || 'task'}:${recipientSicil}`);
    const result = await request.query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_TaskMailOutbox WITH (UPDLOCK, HOLDLOCK) WHERE DedupeKey = @dedupeKey
      )
      INSERT dbo.MR_TaskMailOutbox(Kind, TaskId, RecipientSicil, PayloadJson, DedupeKey)
      VALUES(@kind, @taskId, @recipientSicil, @payload, @dedupeKey);
      SELECT @@ROWCOUNT AS Affected;
    `);
    written += Number(result.recordset?.[0]?.Affected || 0);
  }
  return written;
}

/**
 * Gönderilebilir satırları KİRALAR.
 *
 * Kiralama, birden fazla uygulama örneğinin aynı iletiyi göndermesini önler:
 * süresi dolmamış kiralı satır başka bir tura düşmez.
 */
export async function claimDueTaskMail(executor, limit = 20) {
  const request = executor.request();
  request.input('limit', sql.Int, Math.max(1, Math.min(100, Number(limit) || 20)));
  request.input('leaseSeconds', sql.Int, LEASE_SECONDS);
  const result = await request.query(`
    DECLARE @claimed TABLE(MailId bigint PRIMARY KEY);
    ;WITH due AS (
      SELECT TOP (@limit) MailId
      FROM dbo.MR_TaskMailOutbox WITH (UPDLOCK, READPAST)
      WHERE Status = 'PENDING'
        AND NextAttemptAt <= SYSUTCDATETIME()
        AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME())
      ORDER BY NextAttemptAt, MailId
    )
    UPDATE o
    SET LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
        UpdatedAt = SYSUTCDATETIME()
    OUTPUT inserted.MailId INTO @claimed(MailId)
    FROM dbo.MR_TaskMailOutbox o JOIN due ON due.MailId = o.MailId;

    SELECT o.MailId, o.Kind, o.TaskId, o.RecipientSicil, o.PayloadJson, o.AttemptCount
    FROM dbo.MR_TaskMailOutbox o
    JOIN @claimed c ON c.MailId = o.MailId
    ORDER BY o.MailId;
  `);
  return (result.recordsets?.[1] || result.recordset || []).map((row) => ({
    mailId: Number(row.MailId),
    kind: String(row.Kind),
    taskId: row.TaskId ? String(row.TaskId).toLowerCase() : null,
    recipientSicil: Number(row.RecipientSicil),
    attemptCount: Number(row.AttemptCount || 0),
    payload: parsePayload(row.PayloadJson)
  }));
}

function parsePayload(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function markTaskMailSent(executor, mailId) {
  const request = executor.request();
  request.input('mailId', sql.BigInt, Number(mailId));
  await request.query(`
    UPDATE dbo.MR_TaskMailOutbox
    SET Status = 'SENT', SentAt = SYSUTCDATETIME(), LeaseExpiresAt = NULL,
        LastFailureCode = NULL, AttemptCount = AttemptCount + 1, UpdatedAt = SYSUTCDATETIME()
    WHERE MailId = @mailId AND Status = 'PENDING';
  `);
}

/** Başarısız deneme: geri çekilme uygulanır, sınır aşılınca kayıt FAILED olur. */
export async function markTaskMailFailed(executor, mailId, failureCode) {
  const request = executor.request();
  request.input('mailId', sql.BigInt, Number(mailId));
  request.input('failureCode', sql.VarChar(60), String(failureCode || 'MAIL_SEND_FAILED').slice(0, 60));
  request.input('maxAttempts', sql.Int, TASK_MAIL_MAX_ATTEMPTS);
  request.input('retryBaseSeconds', sql.Int, RETRY_BASE_SECONDS);
  await request.query(`
    UPDATE dbo.MR_TaskMailOutbox
    SET AttemptCount = AttemptCount + 1,
        LastFailureCode = @failureCode,
        LeaseExpiresAt = NULL,
        Status = CASE WHEN AttemptCount + 1 >= @maxAttempts THEN 'FAILED' ELSE 'PENDING' END,
        NextAttemptAt = DATEADD(second, @retryBaseSeconds * POWER(2, CASE WHEN AttemptCount > 4 THEN 4 ELSE AttemptCount END), SYSUTCDATETIME()),
        UpdatedAt = SYSUTCDATETIME()
    WHERE MailId = @mailId AND Status = 'PENDING';
  `);
}

/** Yönetim konsolu künyesi: adres ve ileti gövdesi TAŞINMAZ. */
export async function taskMailQueueStatus(executor) {
  const result = await executor.request().query(`
    SELECT
      COUNT(CASE WHEN Status = 'PENDING' THEN 1 END) AS PendingCount,
      COUNT(CASE WHEN Status = 'FAILED' THEN 1 END) AS FailedCount,
      COUNT(CASE WHEN Status = 'SENT' THEN 1 END) AS SentCount,
      MIN(CASE WHEN Status = 'PENDING' THEN NextAttemptAt END) AS NextAttemptAt,
      MAX(CASE WHEN Status = 'SENT' THEN SentAt END) AS LastSentAt
    FROM dbo.MR_TaskMailOutbox;
  `);
  const row = result.recordset?.[0] || {};
  return {
    pending: Number(row.PendingCount || 0),
    failed: Number(row.FailedCount || 0),
    sent: Number(row.SentCount || 0),
    nextAttemptAt: row.NextAttemptAt ? new Date(row.NextAttemptAt).toISOString() : null,
    lastSentAt: row.LastSentAt ? new Date(row.LastSentAt).toISOString() : null,
    maxAttempts: TASK_MAIL_MAX_ATTEMPTS
  };
}
