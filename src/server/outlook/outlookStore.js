import 'server-only';
import { randomUUID } from 'node:crypto';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql } from '../db/pool.js';
import { corporateUserEmailSql } from '../identity/corporateDirectory.js';
import {
  OUTLOOK_ALLOCATE_SQL,
  OUTLOOK_CLAIM_ONE_SQL,
  OUTLOOK_CLAIM_SQL,
  OUTLOOK_COMPLETE_SQL,
  OUTLOOK_DEACTIVATE_SQL,
  OUTLOOK_ENQUEUE_PROJECT_SQL,
  OUTLOOK_ENQUEUE_TASK_CANCEL_SQL,
  OUTLOOK_ENQUEUE_TASK_SQL,
  OUTLOOK_FAIL_SQL,
  OUTLOOK_QUEUE_CANCEL_SQL,
  OUTLOOK_QUEUE_RESEND_SQL,
  OUTLOOK_REVALIDATE_SQL,
  OUTLOOK_HEALTH_SQL,
  OUTLOOK_QUEUE_STATUS_SQL,
  OUTLOOK_RENEW_SQL,
  OUTLOOK_SETTLE_SQL,
  OUTLOOK_SUBSCRIPTION_SQL,
  OUTLOOK_SUBSCRIPTION_UPSERT_SQL,
  OUTLOOK_TASK_SQL,
  OUTLOOK_USER_SUBSCRIPTIONS_SQL
} from './outlookQueries.js';

/**
 * Outlook takvim aboneliklerinin kalıcı katmanı.
 *
 * Abonelik durumu VERİTABANINDADIR: bellek içi bir küme uygulama yeniden
 * başladığında sıfırlanır, aynı görev için ikinci bir randevu açılır ve
 * güncellemeler kaybolurdu.
 */

function id(value) {
  return value == null ? null : (canonicalActualId(value) ?? String(value));
}

function isoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// Gönderim sırasında yenilenir; çöken çalışanın işi bir dakika içinde kurtarılır.
export const INTERACTIVE_LEASE_SECONDS = 60;

export function isMissingOutlookSchema(error) {
  const errors = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return errors.some((entry) => ([207, 208].includes(Number(entry?.number))
    || /(?:Invalid object name|Invalid column name)/i.test(String(entry?.message || '')))
    && /(?:MR_TaskOutlookSubscriptions|LeaseToken|LeaseExpiresAt|CalendarAttendee|CalendarOrganizer|CancelRequested|ForceResend|DeliveryMayHaveEscaped|LastValidatedAt|CompletionSuspended|CompletionDate|LastCancellationReason|DeliveredMethod|PendingDate)/i.test(String(entry?.message || '')));
}

function subscriptionRow(row) {
  if (!row) return null;
  return {
    subscriptionId: Number(row.SubscriptionId),
    taskId: id(row.TaskId),
    projectId: id(row.ProjectId),
    userSicil: Number(row.UserSicil),
    calendarUid: row.CalendarUid,
    cancelRequested: Boolean(row.CancelRequested),
    forceResend: Boolean(row.ForceResend),
    completionSuspended: Boolean(row.CompletionSuspended),
    completionDate: isoDate(row.CompletionDate),
    lastCancellationReason: row.LastCancellationReason || null,
    deliveredMethod: row.DeliveredMethod || null,
    pendingDate: isoDate(row.PendingDate),
    deliveryMayHaveEscaped: Boolean(row.DeliveryMayHaveEscaped),
    leaseToken: row.LeaseToken || null,
    calendarAttendee: row.CalendarAttendee || null,
    calendarOrganizer: row.CalendarOrganizer || null,
    sequence: Number(row.Sequence ?? 0),
    isActive: Boolean(row.IsActive),
    queueSeq: Number(row.QueueSeq ?? 0),
    pendingMethod: row.PendingMethod || null,
    pendingSequence: row.PendingSequence == null ? null : Number(row.PendingSequence),
    pendingPayloadHash: row.PendingPayloadHash ? String(row.PendingPayloadHash).trim() : null,
    deliveredSequence: row.DeliveredSequence == null ? null : Number(row.DeliveredSequence),
    deliveredPayloadHash: row.DeliveredPayloadHash ? String(row.DeliveredPayloadHash).trim() : null,
    deliveredSummary: row.DeliveredSummary || null,
    deliveredDate: isoDate(row.DeliveredDate),
    attemptCount: Number(row.AttemptCount ?? 0)
  };
}

/**
 * Takvim daveti için gereken görev alanları ve KULLANICI GÖRÜNÜRLÜĞÜ.
 *
 * @returns {Promise<{exists: boolean, visible: boolean, task: object|null}>}
 */
export async function loadOutlookTask(executor, taskId, sicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(OUTLOOK_TASK_SQL);
  const row = result.recordset?.[0];
  if (!row) return { exists: false, visible: false, task: null };
  return {
    exists: true,
    visible: Boolean(row.Visible),
    task: {
      id: id(row.TaskId),
      projectId: id(row.ProjectId),
      task: row.Title,
      status: row.Status,
      targetFinish: isoDate(row.TargetFinish),
      plannedFinish: isoDate(row.PlannedFinish),
      projectCode: row.ProjectCode || '',
      projectName: row.ProjectName || ''
    }
  };
}

/** Sicil → kurumsal e-posta adresi (tek kanonik çözümleyici). */
export async function loadCorporateRecipient(executor, sicil) {
  const request = executor.request();
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(corporateUserEmailSql());
  const row = result.recordset?.[0];
  if (!row) return { found: false, name: '', email: '' };
  return {
    found: true,
    name: String(row.Name || '').trim(),
    email: String(row.Email || '').trim()
  };
}

/** Görev + kullanıcı aboneliğini açar ya da yeniden etkinleştirir. */
export async function upsertOutlookSubscription(executor, {
  taskId,
  projectId = null,
  sicil,
  calendarUid,
  payloadHash
}) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('projectId', sql.UniqueIdentifier, projectId || null);
  request.input('sicil', sql.Int, sicil);
  request.input('calendarUid', sql.NVarChar(200), calendarUid);
  request.input('payloadHash', sql.Char(64), payloadHash);
  const result = await request.query(OUTLOOK_SUBSCRIPTION_UPSERT_SQL);
  return subscriptionRow(result.recordset?.[0]);
}

export async function loadOutlookSubscription(executor, taskId, sicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(OUTLOOK_SUBSCRIPTION_SQL);
  return subscriptionRow(result.recordset?.[0]);
}

/** Etkin abonelik tercihi ve son davetin teslimat durumu. */
export async function loadUserOutlookSubscriptions(executor, sicil) {
  const request = executor.request();
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(OUTLOOK_USER_SUBSCRIPTIONS_SQL);
  return (result.recordset || []).map((row) => ({
    taskId: id(row.TaskId),
    pending: Boolean(row.PendingMethod),
    delivered: row.DeliveredSequence != null && row.DeliveredMethod !== 'CANCEL',
    completionSuspended: Boolean(row.CompletionSuspended),
    failureCode: row.LastFailureCode || null
  }));
}

export async function queueOutlookCancellation(executor, taskId, sicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(OUTLOOK_QUEUE_CANCEL_SQL);
  return subscriptionRow(result.recordset?.[0]);
}

export async function queueOutlookResend(executor, taskId, sicil) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, sicil);
  return subscriptionRow((await request.query(OUTLOOK_QUEUE_RESEND_SQL)).recordset?.[0]);
}

export async function revalidateOutlookSubscriptions(executor, limit) {
  const request = executor.request();
  request.input('limit', sql.Int, limit);
  await request.query(OUTLOOK_REVALIDATE_SQL);
}

export async function outlookOutboxHealth(executor, maxAttempts) {
  const request = executor.request();
  request.input('maxAttempts', sql.Int, maxAttempts);
  return Number((await request.query(OUTLOOK_HEALTH_SQL)).recordset?.[0]?.Exhausted || 0);
}

export async function outlookQueueStatus(executor, maxAttempts) {
  const request = executor.request();
  request.input('maxAttempts', sql.Int, maxAttempts);
  const row = (await request.query(OUTLOOK_QUEUE_STATUS_SQL)).recordset?.[0] || {};
  return Object.fromEntries(['Pending', 'Failed', 'Exhausted', 'InFlight', 'Due']
    .map((key) => [key[0].toLowerCase() + key.slice(1), Number(row[key] || 0)]));
}

export async function renewOutlookLease(executor, { subscriptionId, leaseToken }) {
  const request = executor.request();
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  request.input('leaseSeconds', sql.Int, INTERACTIVE_LEASE_SECONDS);
  return Boolean((await request.query(OUTLOOK_RENEW_SQL)).recordset?.length);
}

export async function deactivateOutlookSubscription(executor, { subscriptionId, queueSeq, leaseToken, cancellationReason = null }) {
  const request = executor.request();
  request.input('cancellationReason', sql.VarChar(60), cancellationReason);
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('queueSeq', sql.BigInt, queueSeq);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  const result = await request.query(OUTLOOK_DEACTIVATE_SQL);
  return Boolean(result.recordset?.length);
}

/** Zamanlanmış turun sahiplendiği bekleyen teslimatlar. */
export async function claimOutlookDeliveries(executor, { limit, maxAttempts, leaseSeconds }) {
  const request = executor.request();
  request.input('limit', sql.Int, Math.max(1, Math.trunc(Number(limit) || 25)));
  request.input('maxAttempts', sql.Int, Math.max(1, Math.trunc(Number(maxAttempts) || 6)));
  request.input('leaseSeconds', sql.Int, INTERACTIVE_LEASE_SECONDS);
  request.input('leaseToken', sql.UniqueIdentifier, randomUUID());
  const result = await request.query(OUTLOOK_CLAIM_SQL);
  return (result.recordset || []).map(subscriptionRow);
}

/**
 * Kullanıcının açık eylemi için TEK aboneliği sahiplenir.
 *
 * @returns {Promise<object|null>} süren bir teslimat varsa `null` (çift tıklama
 *   ya da ikinci sekme ikinci bir davet üretemez).
 */
export async function claimOutlookSubscription(executor, subscriptionId, { leaseSeconds = INTERACTIVE_LEASE_SECONDS } = {}) {
  const request = executor.request();
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('leaseSeconds', sql.Int, INTERACTIVE_LEASE_SECONDS);
  request.input('leaseToken', sql.UniqueIdentifier, randomUUID());
  const result = await request.query(OUTLOOK_CLAIM_ONE_SQL);
  return subscriptionRow(result.recordset?.[0]);
}

/**
 * Gönderilecek sürümü ayırır.
 *
 * @returns {Promise<{sequence: number, queueSeq: number}|null>}
 */
export async function allocateOutlookRevision(executor, { subscriptionId, method, payloadHash, queueSeq, leaseToken, attendee, organizer, reuseDelivered = false, calendarDate = null, cancellationReason = null }) {
  const request = executor.request();
  request.input('calendarDate', sql.Date, calendarDate);
  request.input('cancellationReason', sql.VarChar(60), cancellationReason);
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('method', sql.VarChar(10), method);
  request.input('payloadHash', sql.Char(64), payloadHash);
  request.input('queueSeq', sql.BigInt, queueSeq);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  request.input('leaseSeconds', sql.Int, INTERACTIVE_LEASE_SECONDS);
  request.input('reuseDelivered', sql.Bit, reuseDelivered);
  request.input('attendee', sql.NVarChar(320), attendee);
  request.input('organizer', sql.NVarChar(320), organizer);
  const result = await request.query(OUTLOOK_ALLOCATE_SQL);
  const row = result.recordset?.[0];
  if (!row) return null;
  return { sequence: Number(row.AllocatedSequence), queueSeq: Number(row.QueueSeq), attendee: row.CalendarAttendee, organizer: row.CalendarOrganizer };
}

export async function completeOutlookDelivery(executor, {
  subscriptionId,
  method,
  sequence,
  payloadHash,
  summary,
  calendarDate,
  completionSuspended = false,
  cancellationReason = null,
  queueSeq,
  leaseToken
}) {
  const request = executor.request();
  request.input('completionSuspended', sql.Bit, completionSuspended);
  request.input('cancellationReason', sql.VarChar(60), cancellationReason);
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('method', sql.VarChar(10), method);
  request.input('sequence', sql.Int, sequence);
  request.input('payloadHash', sql.Char(64), payloadHash);
  request.input('summary', sql.NVarChar(400), summary || null);
  request.input('calendarDate', sql.Date, calendarDate || null);
  request.input('queueSeq', sql.BigInt, queueSeq);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  return Boolean((await request.query(OUTLOOK_COMPLETE_SQL)).recordset?.length);
}

/** Gönderilecek bir şey kalmadığında kuyruk kaydını düşürür. */
export async function settleOutlookDelivery(executor, { subscriptionId, queueSeq, leaseToken, completionSuspended = false, cancellationReason = null }) {
  const request = executor.request();
  request.input('completionSuspended', sql.Bit, completionSuspended);
  request.input('cancellationReason', sql.VarChar(60), cancellationReason);
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('queueSeq', sql.BigInt, queueSeq);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  return Boolean((await request.query(OUTLOOK_SETTLE_SQL)).recordset?.length);
}

export async function failOutlookDelivery(executor, { subscriptionId, failureCode, retrySeconds, queueSeq, leaseToken, clearProvisional = false }) {
  const request = executor.request();
  request.input('subscriptionId', sql.BigInt, subscriptionId);
  request.input('clearProvisional', sql.Bit, clearProvisional);
  request.input('failureCode', sql.VarChar(60), String(failureCode || 'UNKNOWN').slice(0, 60));
  request.input('retrySeconds', sql.Int, Math.max(60, Math.trunc(Number(retrySeconds) || 60)));
  request.input('queueSeq', sql.BigInt, queueSeq);
  request.input('leaseToken', sql.UniqueIdentifier, leaseToken);
  await request.query(OUTLOOK_FAIL_SQL);
}

/**
 * Görev/proje değişikliklerini kuyruğa alır.
 *
 * Kalıcılık işleminin içinde çağrılır ve HATA YUTMAZ: çağıran, şema eksikse
 * (0010 henüz çalıştırılmamışsa) sessizce geçer. Bunun dışındaki hatalar
 * yukarı taşınır; kuyruk kaydı görev kaydıyla aynı işlemdedir.
 */
export async function enqueueOutlookTaskUpdate(executor, taskId, { suspendCompletion = false, completionDate = null } = {}) {
  const request = executor.request();
  request.input('suspendCompletion', sql.Bit, suspendCompletion);
  request.input('completionDate', sql.Date, completionDate);
  request.input('taskId', sql.UniqueIdentifier, taskId);
  await request.query(OUTLOOK_ENQUEUE_TASK_SQL);
}

export async function enqueueOutlookTaskCancellation(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  await request.query(OUTLOOK_ENQUEUE_TASK_CANCEL_SQL);
}

export async function enqueueOutlookProjectUpdate(executor, projectId) {
  const request = executor.request();
  request.input('projectId', sql.UniqueIdentifier, projectId);
  await request.query(OUTLOOK_ENQUEUE_PROJECT_SQL);
}
