import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { normalizePriorityId } from '../../domain/constants/index.js';
import {
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
  sanitizeReminderHtml
} from '../../domain/reminders/reminderTemplate.js';
import { DEFAULT_REMINDER_SETTINGS, normalizeReminderSettings } from '../../domain/reminders/reminderPolicy.js';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import {
  REMINDER_CANDIDATES_SQL,
  REMINDER_CLAIM_SQL,
  REMINDER_COMPLETE_SQL,
  REMINDER_HISTORY_SQL,
  REMINDER_LAST_MANUAL_SQL,
  REMINDER_MANUAL_LOG_SQL,
  REMINDER_SETTINGS_SQL,
  REMINDER_SETTINGS_UPSERT_SQL,
  REMINDER_TASK_PROJECT_STATE_SQL,
  REMINDER_TASK_SQL,
  reminderRecipientsSql
} from './reminderQueries.js';

/**
 * Hatırlatma verisinin kalıcı katmanı.
 *
 * Gönderim geçmişi VERİTABANINDA tutulur; bellek içi bir küme uygulama ya da
 * sunucu yeniden başladığında sıfırlanır ve aynı aralık için ikinci bir ileti
 * gönderilirdi.
 */

function id(value) {
  return value == null ? null : (canonicalActualId(value) ?? String(value));
}

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

const MISSING_TABLE_CODES = new Set([208, 2812]);

function isMissingReminderSchema(error) {
  // Yükseltme betiği henüz çalıştırılmamış olabilir: yapılandırma okunamadığında
  // uygulama çökmez, VARSAYILAN şablonla ve kapalı otomatik gönderimle sürer.
  return MISSING_TABLE_CODES.has(Number(error?.number)) || /Invalid object name/i.test(String(error?.message || ''));
}

/** Yönetici ayarları + şablon. Kayıt yoksa belgelenen varsayılanlar döner. */
export async function loadReminderSettings(executor) {
  let row = null;
  try {
    const result = await executor.request().query(REMINDER_SETTINGS_SQL);
    row = result.recordset?.[0] || null;
  } catch (error) {
    if (!isMissingReminderSchema(error)) throw error;
    return {
      ...normalizeReminderSettings(DEFAULT_REMINDER_SETTINGS),
      subject: DEFAULT_REMINDER_SUBJECT,
      body: DEFAULT_REMINDER_BODY,
      updatedAt: null,
      updatedBySicil: null,
      rowVersion: null,
      schemaReady: false
    };
  }

  const settings = normalizeReminderSettings(row ? {
    automaticEnabled: Boolean(row.AutomaticEnabled),
    windowValue: row.WindowValue,
    windowUnit: row.WindowUnit,
    frequencyValue: row.FrequencyValue,
    frequencyUnit: row.FrequencyUnit
  } : DEFAULT_REMINDER_SETTINGS);

  return {
    ...settings,
    subject: row?.SubjectTemplate || DEFAULT_REMINDER_SUBJECT,
    // Saklanan gövde okunurken DE temizlenir: kayıt eski bir sürümde ya da
    // doğrudan veritabanından yazılmış olabilir.
    body: sanitizeReminderHtml(row?.BodyTemplate || DEFAULT_REMINDER_BODY),
    updatedAt: row?.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : null,
    updatedBySicil: row?.UpdatedBySicil == null ? null : Number(row.UpdatedBySicil),
    // Satır sürümü İSTEMCİYE kadar taşınır: yönetici ekranı düzenlediği sürümü
    // geri gönderir ve arada yapılan başka bir kayıt sessizce ezilmez.
    rowVersion: encodeRowVersion(row?.RowVersion),
    schemaReady: true
  };
}

/** `rowversion` ikili değerini taşınabilir onaltılık metne çevirir. */
export function encodeRowVersion(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex').toUpperCase()}`;
  const text = String(value).trim();
  return /^0x[0-9a-f]+$/i.test(text) ? text.toUpperCase() : null;
}

/** Onaltılık satır sürümünü SQL parametresi için ikiliye çevirir. */
export function decodeRowVersion(value) {
  if (value == null || value === '') return null;
  if (Buffer.isBuffer(value)) return value;
  const text = String(value).trim();
  // "Yok" ile "BOZUK" ayrılır. Çözülemeyen belirteç `null` bağlandığında
  // yükseltme sorgusu bunu "koşulsuz güncelle" olarak yorumluyor ve iyimser
  // kilit sessizce devre dışı kalıyordu: kırpılmış bir belirteç gönderen
  // istemci, beklenen 409 yerine eşzamanlı değişikliği eziyordu.
  if (!/^0x[0-9a-f]+$/i.test(text)) {
    throw new ServerPersistenceError(
      'MUTATION_FAILED',
      'Geçersiz satır sürümü gönderildi. Sayfayı yenileyip yeniden deneyin.',
      { status: 400 }
    );
  }
  return Buffer.from(text.slice(2), 'hex');
}

/**
 * Ayarları yazar. Şablon gövdesi yazmadan ÖNCE temizlenir.
 *
 * `input.rowVersion` verildiğinde yazma İYİMSER KİLİTLİDİR: satır arada
 * değiştiyse hiçbir alan güncellenmez ve çakışma bildirilir.
 */
export async function saveReminderSettings(executor, actorSicil, input = {}) {
  const settings = normalizeReminderSettings(input);
  const subject = String(input.subject || DEFAULT_REMINDER_SUBJECT).replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  const body = sanitizeReminderHtml(input.body || DEFAULT_REMINDER_BODY);

  const request = executor.request();
  request.input('automaticEnabled', sql.Bit, settings.automaticEnabled);
  request.input('windowValue', sql.Int, settings.windowValue);
  request.input('windowUnit', sql.VarChar(10), settings.windowUnit);
  request.input('frequencyValue', sql.Int, settings.frequencyValue);
  request.input('frequencyUnit', sql.VarChar(10), settings.frequencyUnit);
  request.input('subjectTemplate', sql.NVarChar(400), subject);
  request.input('bodyTemplate', sql.NVarChar(sql.MAX), body);
  request.input('actorSicil', sql.Int, actorSicil);
  request.input('rowVersion', sql.VarBinary(8), decodeRowVersion(input.rowVersion));
  const result = await request.query(REMINDER_SETTINGS_UPSERT_SQL);

  // Okunamayan sonuç ÇAKIŞMA sayılır: 1 varsaymak, kaybolan bir güncellemeyi
  // yöneticiye "kaydedildi" diye bildiriyordu.
  const affected = Number(result?.recordset?.[0]?.AffectedRows ?? 0);
  if (!affected) {
    throw new ServerPersistenceError(
      'VERSION_CONFLICT',
      'Hatırlatma yapılandırması başka bir yönetici tarafından güncellendi. Sayfayı yenileyip değişikliğinizi yeniden uygulayın.',
      { status: 409 }
    );
  }

  return { ...settings, subject, body };
}

/** Hatırlatma için gereken görev alanları. */
export async function loadReminderTask(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await request.query(REMINDER_TASK_SQL);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    id: id(row.TaskId),
    projectId: id(row.ProjectId),
    task: row.Title,
    description: row.Description || '',
    keyword: row.Keyword || '',
    status: row.Status,
    priority: normalizePriorityId(row.Priority),
    targetFinish: isoDate(row.TargetFinish),
    plannedStart: isoDate(row.PlannedStart),
    plannedFinish: isoDate(row.PlannedFinish),
    projectCode: row.ProjectCode || '',
    projectName: row.ProjectName || ''
  };
}

/**
 * `loadReminderTask` boş döndüğünde NEDENİ ayırt eder.
 *
 * Yalnızca RAPORLAMA içindir: görev gerçekten yoksa `{ exists: false }`,
 * görev duruyor ama projesi devre dışı ise `{ exists: true, projectActive:
 * false }` döner. Çağıran her iki durumda da gönderimi iptal eder.
 */
export async function loadReminderTaskProjectState(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await request.query(REMINDER_TASK_PROJECT_STATE_SQL);
  const row = result.recordset?.[0];
  if (!row) return { exists: false, projectActive: false };
  return { exists: true, projectActive: Number(row.IsActive) === 1 };
}

/** Sorumlu → kullanıcı adı → DC01_userr adresi satırları. */
export async function loadReminderRecipientRows(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await request.query(reminderRecipientsSql());
  return (result.recordset || []).map((row) => ({
    sicil: row.Sicil == null ? '' : String(row.Sicil),
    name: row.Name || '',
    username: row.Username || '',
    email: row.Email || ''
  }));
}

/** Turu çalıştıran sürecin İŞ GÜNÜ (yerel takvim günü). */
export function workerBusinessDate(now = new Date()) {
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}-${String(reference.getDate()).padStart(2, '0')}`;
}

/**
 * Otomatik gönderim adayları (kapalı ve terminsiz görevler zaten elenir).
 *
 * İş günü, uygunluğu değerlendiren süreçten gelir; ön eleme ile ilke katmanı
 * böylece AYNI saati kullanır (bkz. REMINDER_CANDIDATES_SQL).
 */
export async function loadReminderCandidates(executor, horizonDays, now = new Date()) {
  const request = executor.request();
  request.input('horizonDays', sql.Int, Math.max(1, Math.min(Number(horizonDays) || 7, 365)));
  request.input('today', sql.Date, workerBusinessDate(now));
  const result = await request.query(REMINDER_CANDIDATES_SQL);
  return (result.recordset || []).map((row) => ({
    id: id(row.TaskId),
    projectId: id(row.ProjectId),
    task: row.Title,
    status: row.Status,
    targetFinish: isoDate(row.TargetFinish)
  }));
}

/**
 * Bir `PENDING` kaydın TERK EDİLMİŞ sayılması için geçmesi gereken süre.
 *
 * Gönderim `SMTP_TIMEOUT_MS` kadar sürebilir; eşik bunun çok üzerindedir ki
 * hâlâ süren bir gönderim yanlışlıkla ikinci kez sahiplenilmesin.
 */
export const ABANDONED_CLAIM_MINUTES = 30;

/**
 * Otomatik aralığı sahiplenir.
 *
 * @returns {Promise<number|null>} günlük kaydı kimliği; aralık zaten
 *   sahiplenilmişse `null` (bu turda gönderim YAPILMAZ). Süreç çökmesi yüzünden
 *   `PENDING` kalmış eski bir kayıt yeniden sahiplenilir.
 */
export async function claimAutomaticReminder(executor, {
  taskId,
  projectId,
  slotKey,
  actorSicil = null,
  staleMinutes = ABANDONED_CLAIM_MINUTES
}) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('projectId', sql.UniqueIdentifier, projectId || null);
  request.input('slotKey', sql.NVarChar(200), slotKey);
  request.input('actorSicil', sql.Int, actorSicil);
  request.input('staleMinutes', sql.Int, Math.max(1, Math.trunc(Number(staleMinutes) || ABANDONED_CLAIM_MINUTES)));
  try {
    const result = await request.query(REMINDER_CLAIM_SQL);
    const logId = result.recordset?.[0]?.TaskReminderLogId;
    return logId == null ? null : Number(logId);
  } catch (error) {
    // Benzersiz dizin ihlali: aralığı başka bir çalıştırma (ya da başka bir
    // uygulama örneği) az önce sahiplendi.
    if (Number(error?.number) === 2601 || Number(error?.number) === 2627) return null;
    throw error;
  }
}

/**
 * Kullanıcının o göreve yaptığı SON elle gönderimin zamanı.
 *
 * @returns {Promise<Date|null>} kayıt yoksa (ya da şema henüz kurulmamışsa) `null`
 */
export async function loadLastManualReminderAt(executor, taskId, actorSicil) {
  if (actorSicil == null) return null;
  try {
    const request = executor.request();
    request.input('taskId', sql.UniqueIdentifier, taskId);
    request.input('actorSicil', sql.Int, actorSicil);
    const result = await request.query(REMINDER_LAST_MANUAL_SQL);
    const createdAt = result.recordset?.[0]?.CreatedAt;
    if (!createdAt) return null;
    const value = new Date(createdAt);
    return Number.isNaN(value.getTime()) ? null : value;
  } catch (error) {
    if (isMissingReminderSchema(error)) return null;
    throw error;
  }
}

/**
 * Elle gönderim hakkını sahiplenir ve kaydı açar.
 *
 * En küçük aralık denetimi ile kaydın açılması TEK SQL deyimidir: aralığı ayrı
 * bir okumada denetleyip sonra koşulsuz eklemek, aynı kullanıcının eşzamanlı
 * iki isteğinin de sınırı geçmesine izin veriyordu.
 *
 * @param {{intervalStart?: Date|null}} input `intervalStart` aralığın
 *   başlangıcıdır; bu andan sonra açılmış başarısız olmayan bir kayıt varsa
 *   sahiplenme reddedilir. `null` verilirse sınır uygulanmaz.
 * @returns {Promise<number|null>} kayıt kimliği; aralık henüz dolmadıysa `null`
 *   (bu durumda hiçbir posta gönderilmez).
 */
export async function logManualReminder(executor, {
  taskId,
  projectId,
  slotKey,
  actorSicil = null,
  intervalStart = null
}) {
  const boundary = intervalStart instanceof Date && !Number.isNaN(intervalStart.getTime())
    ? intervalStart
    : null;
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('projectId', sql.UniqueIdentifier, projectId || null);
  request.input('slotKey', sql.NVarChar(200), slotKey);
  request.input('actorSicil', sql.Int, actorSicil);
  request.input('intervalStart', sql.DateTime2, boundary);
  const result = await request.query(REMINDER_MANUAL_LOG_SQL);
  const logId = result.recordset?.[0]?.TaskReminderLogId;
  return logId == null ? null : Number(logId);
}

/**
 * Alıcı özeti; kişisel veri yığmamak için adresler MASKELENİR.
 * Sorun gidermeye yetecek kadar bilgi kalır, posta kutusu adresi kalmaz.
 */
export function maskRecipients(recipients = []) {
  return recipients
    .map((address) => {
      const [local, domain] = String(address).split('@');
      if (!domain) return '***';
      const head = local.slice(0, 1);
      return `${head}***@${domain}`;
    })
    .join(', ')
    .slice(0, 400);
}

export async function completeReminderLog(executor, logId, { status, recipients = [], failureCode = null }) {
  if (logId == null) return;
  const request = executor.request();
  request.input('logId', sql.BigInt, logId);
  request.input('status', sql.VarChar(20), status);
  request.input('recipientCount', sql.Int, recipients.length);
  request.input('recipientDigest', sql.NVarChar(400), maskRecipients(recipients) || null);
  request.input('failureCode', sql.VarChar(60), failureCode);
  await request.query(REMINDER_COMPLETE_SQL);
}

/** Son gönderim kayıtları (yönetici ekranı için). */
export async function loadReminderHistory(executor, limit = 20) {
  try {
    const request = executor.request();
    request.input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 20, 100)));
    const result = await request.query(REMINDER_HISTORY_SQL);
    return (result.recordset || []).map((row) => ({
      id: Number(row.TaskReminderLogId),
      taskId: id(row.TaskId),
      kind: row.ReminderKind,
      slotKey: row.SlotKey,
      status: row.Status,
      recipientCount: Number(row.RecipientCount || 0),
      failureCode: row.FailureCode || null,
      createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
      completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : null
    }));
  } catch (error) {
    if (isMissingReminderSchema(error)) return [];
    throw error;
  }
}
