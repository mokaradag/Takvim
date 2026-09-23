import 'server-only';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/pool.js';

/**
 * Görev bildirim postasının DAYANIKLI kuyruğu.
 *
 * Kuyruğa yazma, görev yazmasıyla AYNI işlemdedir; SMTP çağrısı bu yolda
 * HİÇ yapılmaz. Görev kaydı posta sunucusu erişilemez olsa da tamamlanır ve
 * `api.commit` süresi SMTP'ye bağlı değildir.
 *
 * Teslimat arka plan çalışanındadır (bkz. taskMailWorker.js). Tekilleştirme
 * anahtarı aynı değişikliğin kuyruğa iki kez girmesini, kira ise aynı satırın
 * iki örnekte aynı anda gönderilmesini önler. Tam olarak bir kez teslimat
 * GARANTİ EDİLMEZ: SMTP kabulü ile `SENT` yazımı arasında çalışan durursa ya da
 * durum yazması başarısız olursa satır kira dolunca yeniden kiralanır ve ileti
 * yeniden gönderilebilir.
 */

export const TASK_MAIL_KINDS = Object.freeze({ TASK_ASSIGNMENT: 'TASK_ASSIGNMENT' });

const MISSING_TABLE_NUMBERS = new Set([208, 4145]);

export function isMissingTaskMailSchema(error) {
  const number = Number(error?.number);
  return MISSING_TABLE_NUMBERS.has(number) && String(error?.message || '').includes('MR_TaskMailOutbox');
}

/** Kaç deneme sonra kayıt BAŞARISIZ sayılır (yönetim konsolunda görünür). */
export const TASK_MAIL_MAX_ATTEMPTS = 6;
export const TASK_MAIL_ATTEMPTS_EXHAUSTED_CODE = 'MAIL_ATTEMPTS_EXHAUSTED';
const RETRY_BASE_SECONDS = 60;
const MIN_LEASE_SECONDS = 120;
const MAX_LEASE_SECONDS = 3600;
/** Dizin okuması ve durum yazması için satır başına pay. */
export const TASK_MAIL_LEASE_SLACK_MS = 5000;
/**
 * Tek teslimatın uçtan uca bütçesi, SMTP zaman aşımının kaç katıdır.
 *
 * `SMTP_TIMEOUT_MS` diyaloğun TAMAMINA değil, bağlantıya, TLS'e ve HER komut
 * yanıtına ayrı ayrı uygulanır; yavaş ama başarılı bir sunucuyla tek bir
 * teslimat zaman aşımının birkaç katı sürebilir.
 */
const DELIVERY_BUDGET_TIMEOUT_FACTOR = 2;

/**
 * Tek teslimatın UÇTAN UCA süre sınırı.
 *
 * Teslimat bu süre dolunca kesilir (`sendMail` · `signal`). Kira bu sınır
 * üzerinden ölçülür; sınır olmadan tek bir yavaş diyalog kirayı aşabiliyor,
 * başka bir örnek satırı yeniden kiralayıp AYNI iletiyi ikinci kez
 * gönderebiliyordu — sahiplik belirteci yalnızca geciken turun durum yazmasını
 * engelliyor, ikinci gönderimi engellemiyordu.
 */
export function taskMailDeliveryBudgetMs(smtpTimeoutMs = 20000) {
  return Math.max(1000, Number(smtpTimeoutMs) || 20000) * DELIVERY_BUDGET_TIMEOUT_FACTOR;
}

function leaseSecondsPerRow(smtpTimeoutMs) {
  return Math.ceil((taskMailDeliveryBudgetMs(smtpTimeoutMs) + TASK_MAIL_LEASE_SLACK_MS) / 1000);
}

/**
 * Parti boyu, kiranın TAŞIYABİLECEĞİ satır sayısını aşmaz.
 *
 * Sabit 120 saniyelik kira, bir turda en çok 20 satırın sırayla gönderildiği ve
 * tek bir SMTP işleminin yapılandırılabilir zaman aşımının 300 saniyeye
 * çıkabildiği düzende yetmiyordu: kira parti işlenirken dolduğunda başka bir
 * uygulama örneği aynı satırı yeniden kiralayıp AYNI iletiyi ikinci kez
 * gönderebiliyordu. Parti, kira üst sınırına sığacak biçimde daraltılır;
 * her teslimat uçtan uca bütçesiyle sınırlıdır ve sahiplik belirteci tur
 * sonundaki durum yazmasını kiranın sahibine kilitler.
 */
export function taskMailBatchSize(limit = 20, smtpTimeoutMs = 20000) {
  const requested = Math.max(1, Math.min(100, Number(limit) || 20));
  return Math.max(1, Math.min(requested, Math.floor(MAX_LEASE_SECONDS / leaseSecondsPerRow(smtpTimeoutMs))));
}

/** Kira, TURUN TAMAMINI kapsar. */
export function taskMailLeaseSeconds(batchSize, smtpTimeoutMs = 20000) {
  const rows = Math.max(1, Math.min(100, Number(batchSize) || 1));
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, rows * leaseSecondsPerRow(smtpTimeoutMs)));
}

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
 * süresi dolmamış kiralı satır başka bir tura düşmez. Kira süresi turun
 * tamamını kapsar ve her satır kirayı alan turun BELİRTECİNİ taşır.
 */
export async function claimDueTaskMail(executor, limit = 20, { leaseSeconds } = {}) {
  const batchSize = Math.max(1, Math.min(100, Number(limit) || 20));
  const leaseToken = randomUUID();
  const request = executor.request();
  request.input('limit', sql.Int, batchSize);
  request.input('leaseSeconds', sql.Int, Number(leaseSeconds) || taskMailLeaseSeconds(batchSize));
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  request.input('maxAttempts', sql.Int, TASK_MAIL_MAX_ATTEMPTS);
  request.input('attemptsExhaustedCode', sql.VarChar(60), TASK_MAIL_ATTEMPTS_EXHAUSTED_CODE);
  const result = await request.query(`
    /* READPAST her oturumda kilit tabanlı READ COMMITTED ile çalışır. */
    SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
    DECLARE @claimed TABLE(MailId bigint PRIMARY KEY);

    /* Deneme, satır KİRALANDIĞINDA sayılır. Böylece SMTP kabulünden sonra
       SENT yazımı kaybolsa bile her yeniden sahiplenme bütçeyi tüketir. */
    UPDATE dbo.MR_TaskMailOutbox WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)
    SET Status = 'FAILED',
        LeaseExpiresAt = NULL,
        LeaseToken = NULL,
        LastFailureCode = COALESCE(LastFailureCode, @attemptsExhaustedCode),
        UpdatedAt = SYSUTCDATETIME()
    WHERE Status = 'PENDING'
      AND AttemptCount >= @maxAttempts
      AND NextAttemptAt <= SYSUTCDATETIME()
      AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME());

    ;WITH due AS (
      SELECT TOP (@limit) MailId
      FROM dbo.MR_TaskMailOutbox WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)
      WHERE Status = 'PENDING'
        AND AttemptCount < @maxAttempts
        AND NextAttemptAt <= SYSUTCDATETIME()
        AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME())
      ORDER BY NextAttemptAt, MailId
    )
    UPDATE o
    SET AttemptCount = AttemptCount + 1,
        LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
        LeaseToken = @leaseToken,
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
    leaseToken,
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

/**
 * Kira SAHİPLİĞİ koşulu.
 *
 * Kira dolduktan sonra satırı başka bir örnek kiralamış olabilir; o durumda bu
 * turun durum yazması satıra DOKUNMAZ.
 */
const OWNS_LEASE = '(@leaseToken IS NULL OR LeaseToken = @leaseToken)';

function bindLease(request, leaseToken) {
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken || null);
  return request;
}

export async function markTaskMailSent(executor, mailId, leaseToken = null) {
  const request = bindLease(executor.request(), leaseToken);
  request.input('mailId', sql.BigInt, Number(mailId));
  await request.query(`
    UPDATE dbo.MR_TaskMailOutbox
    SET Status = 'SENT', SentAt = SYSUTCDATETIME(), LeaseExpiresAt = NULL, LeaseToken = NULL,
        LastFailureCode = NULL, UpdatedAt = SYSUTCDATETIME()
    WHERE MailId = @mailId AND Status = 'PENDING' AND ${OWNS_LEASE};
  `);
}

/** Başarısız deneme: geri çekilme uygulanır, sınır aşılınca kayıt FAILED olur. */
export async function markTaskMailFailed(executor, mailId, failureCode, leaseToken = null) {
  const request = bindLease(executor.request(), leaseToken);
  request.input('mailId', sql.BigInt, Number(mailId));
  request.input('failureCode', sql.VarChar(60), String(failureCode || 'MAIL_SEND_FAILED').slice(0, 60));
  request.input('maxAttempts', sql.Int, TASK_MAIL_MAX_ATTEMPTS);
  request.input('retryBaseSeconds', sql.Int, RETRY_BASE_SECONDS);
  await request.query(`
    UPDATE dbo.MR_TaskMailOutbox
    SET LastFailureCode = @failureCode,
        LeaseExpiresAt = NULL,
        LeaseToken = NULL,
        Status = CASE WHEN AttemptCount >= @maxAttempts THEN 'FAILED' ELSE 'PENDING' END,
        NextAttemptAt = DATEADD(second, @retryBaseSeconds * POWER(2,
          CASE WHEN AttemptCount <= 1 THEN 0 WHEN AttemptCount > 5 THEN 4 ELSE AttemptCount - 1 END),
          SYSUTCDATETIME()),
        UpdatedAt = SYSUTCDATETIME()
    WHERE MailId = @mailId AND Status = 'PENDING' AND ${OWNS_LEASE};
  `);
}

/** Teslimatı BELİRSİZ kalan satırın kodu; kendiliğinden yeniden denenmez. */
export const TASK_MAIL_UNCERTAIN_CODE = 'MAIL_DELIVERY_UNCERTAIN';

/**
 * Teslimatı BELİRSİZ kalan satır.
 *
 * Bağlantı ileti gövdesi aktarıldıktan sonra, SMTP kabul yanıtı okunmadan
 * koptuğunda posta sunucusu iletiyi kabul etmiş olabilir
 * (`sendMail` · `deliveryMayHaveEscaped`). Böyle bir satır olağan yeniden deneme
 * yoluna döndürüldüğünde alıcı AYNI iletiyi ikinci kez alabiliyordu. Satır bu
 * yüzden bir daha gönderilmez; kaybolmaz da, yönetim konsolunda kendi kodu ile
 * görünür ve gerekirse elle ele alınır.
 */
export async function markTaskMailUncertain(executor, mailId, leaseToken = null) {
  const request = bindLease(executor.request(), leaseToken);
  request.input('mailId', sql.BigInt, Number(mailId));
  request.input('failureCode', sql.VarChar(60), TASK_MAIL_UNCERTAIN_CODE);
  await request.query(`
    UPDATE dbo.MR_TaskMailOutbox
    SET LastFailureCode = @failureCode,
        LeaseExpiresAt = NULL,
        LeaseToken = NULL,
        Status = 'FAILED',
        UpdatedAt = SYSUTCDATETIME()
    WHERE MailId = @mailId AND Status = 'PENDING' AND ${OWNS_LEASE};
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
