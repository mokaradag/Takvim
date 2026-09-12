import 'server-only';
import { outlookCompletionNeedsCancellation } from '../../domain/outlook/outlookCompletion.js';
import { abortableOutlookOperation, keepOutlookLease, outlookDeadline, outlookExecutor } from './outlookExecution.js';
import { outlookFailureCode } from './outlookFailure.js';
import { outlookFailureMessage, safeOutlookFailureCode } from '../../domain/outlook/outlookFailures.js';
import { isValidEmailAddress } from '../../domain/reminders/emailAddress.js';
import {
  buildOutlookCalendarPayload,
  outlookCalendarUid,
  outlookCancellationHash,
  outlookPayloadHash,
  renderOutlookInvitation
} from '../../domain/outlook/outlookCalendarPayload.js';
import { renderOutlookInvitationMail } from '../../domain/outlook/outlookMailContent.js';
import { sendMail } from '../mail/mailService.js';
import { getSmtpConfig, smtpConfigurationProblem } from '../mail/smtpConfig.js';
import {
  outlookBulkLimit,
  outlookMaxAttempts,
  outlookOutboxBatchSize,
  outlookRunBudgetMs,
  outlookRetryDelaySeconds
} from './outlookConfig.js';
import {
  allocateOutlookRevision,
  claimOutlookDeliveries,
  claimOutlookSubscription,
  completeOutlookDelivery,
  deactivateOutlookSubscription,
  failOutlookDelivery,
  isMissingOutlookSchema,
  loadCorporateRecipient,
  loadOutlookSubscription,
  loadOutlookTask,
  loadUserOutlookSubscriptions,
  queueOutlookCancellation,
  queueOutlookResend,
  revalidateOutlookSubscriptions,
  outlookOutboxHealth,
  settleOutlookDelivery,
  upsertOutlookSubscription
} from './outlookStore.js';

/**
 * Outlook takvim aboneliklerinin ORTAK çekirdeği.
 *
 * Kullanıcının elle eklemesi, toplu ekleme ve zamanlanmış kuyruk turu aynı
 * teslimat işlevini paylaşır: yetki yeniden denetimi, alıcı çözümü, sürüm
 * ayırma, iCalendar üretimi ve kalıcı sonuç kaydı tek yerdedir. İkinci bir
 * uygulama, iki yol arasında davranış farkı üretirdi.
 *
 * Teslimat SMTP'ye bağlıdır ama görev kaydı DEĞİLDİR: kuyruk kayıtları
 * kalıcılık işleminin içinde yazılır, gönderim ise ayrı ve yeniden
 * denenebilirdir.
 */

const MESSAGES = Object.freeze({
  DISABLED: 'Outlook takvim tümleştirmesi bu kurulumda kapalı.',
  SMTP_NOT_CONFIGURED: 'Outlook daveti gönderilemiyor: sunucuda e-posta gönderimi yapılandırılmamış.',
  SMTP_CONFIG_INVALID: 'Outlook daveti gönderilemiyor: sunucudaki e-posta yapılandırması geçersiz.',
  OUTLOOK_RUN_TIMEOUT: 'Outlook gönderimi süre sınırına ulaştı; sistem yeniden deneyecek.',
  OUTLOOK_LEASE_LOST: 'Outlook gönderimi başka bir çalışana devredildi.',
  REMOVE_QUEUED: 'Outlook iptali gönderim kuyruğuna alındı.',
  TASK_NOT_FOUND: 'Takvime eklenecek görev bulunamadı.',
  FORBIDDEN: 'Bu görevi görüntüleme yetkiniz olmadığı için Outlook takviminize ekleyemezsiniz.',
  NO_CALENDAR_DATE: 'Görevin termin tarihi yok; takvime eklenebilmesi için bir termin girin.',
  NO_RECIPIENT_ADDRESS: 'Kurumsal e-posta adresiniz personel kaydında bulunamadı.',
  NOT_SUBSCRIBED: 'Bu görev için Outlook bağlantısı etkin değil.',
  TASK_COMPLETED: 'Görev tamamlandı; Outlook bağlantısı yeniden açılana kadar bekletiliyor.',
  ADDED: 'Outlook daveti gönderildi.',
  ALREADY_ADDED: 'Outlook bağlantısı etkin; son davet güncel.',
  RESENT: 'Outlook daveti yeniden gönderildi.',
  REMOVED: 'Outlook bağlantısı kapatıldı; gerekli iptal daveti gönderildi.',
  QUEUED: 'Outlook daveti gönderim kuyruğuna alındı.',
  RETRY_QUEUED: 'Sistem gönderimi yeniden deneyecek.',
  IN_PROGRESS: 'Outlook daveti şu anda gönderiliyor. Birkaç saniye sonra durumu yenileyin.',
  INVALID_IDENTITY: 'Görev ya da kullanıcı kimliği takvim daveti için geçerli değil.',
  SUBSCRIPTION_MISSING: 'Outlook takvim kaydı bulunamadı.',
  UNEXPECTED_ERROR: 'Outlook takvim işlemi tamamlanamadı.',
  OUTLOOK_SCHEMA_MISSING: 'Outlook takvim şeması kurulmamış. Sunucuda güncel 0010 ve 0011 yükseltme betikleri çalıştırılmalıdır.'
});

/** Kullanıcıya gösterilebilir, gizli bilgi taşımayan ileti. */
export function outlookMessage(code, fallback = 'Outlook takvim işlemi tamamlanamadı.') {
  return MESSAGES[code] || (safeOutlookFailureCode(code, null) ? outlookFailureMessage(code) : fallback);
}

/**
 * 0010 yükseltmesi çalıştırılmamışsa uç, ham SQL hatası yerine açıklayıcı bir
 * sonuç döndürür.
 *
 * @returns {{status: 'FAILED', code: string, message: string}|null}
 */
export function outlookSchemaProblem(error) {
  if (!isMissingOutlookSchema(error)) return null;
  return { status: 'FAILED', code: 'OUTLOOK_SCHEMA_MISSING', message: outlookMessage('OUTLOOK_SCHEMA_MISSING') };
}

function organizerFrom(config) {
  return { address: config?.from || '', name: config?.fromName || 'MERGEN Rota' };
}

/**
 * Abonelik yazılmadan önce yalnızca görev ve görünürlük yüklenir.
 */
async function resolveTaskPayload(executor, { taskId, sicil, link }) {
  const taskState = await loadOutlookTask(executor, taskId, sicil);
  const payload = taskState.task ? buildOutlookCalendarPayload(taskState.task, { link }) : { ok: false, code: 'TASK_NOT_FOUND' };
  return { taskState, payload };
}

async function deliverSubscription(baseExecutor, { subscription, link, send, now = new Date(), signal = null }) {
  const execution = outlookDeadline(signal ? 240000 : outlookRunBudgetMs(), signal);
  const executor = outlookExecutor(baseExecutor, execution.signal);
  const stopRenewal = keepOutlookLease(executor, subscription, execution);
  const force = subscription.forceResend;
  const finish = async (operation) => {
    const completion = outlookDeadline(5000);
    try {
      return await operation(outlookExecutor(baseExecutor, completion.signal));
    } finally {
      completion.close();
    }
  };
  const claim = {
    subscriptionId: subscription.subscriptionId,
    queueSeq: subscription.queueSeq,
    leaseToken: subscription.leaseToken
  };
  const failed = async (code, clearProvisional = false) => {
    await finish((cleanup) => failOutlookDelivery(cleanup, {
      ...claim, failureCode: code, clearProvisional,
      retrySeconds: outlookRetryDelaySeconds(subscription.attemptCount)
    }));
    return { status: 'FAILED', code, message: outlookMessage(code) };
  };
  try {
    // Açık iptal isteği, silinmiş dizin/görev verisine bağlı değildir.
    const { taskState, payload } = subscription.cancelRequested
      ? { taskState: { exists: false }, payload: { ok: false } }
      : await resolveTaskPayload(executor, { taskId: subscription.taskId, sicil: subscription.userSicil, link });
    const unavailable = subscription.cancelRequested ? 'USER_REMOVED'
      : !taskState.exists ? 'TASK_NOT_FOUND' : !taskState.visible ? 'FORBIDDEN' : null;
    const completedTask = !unavailable && taskState.task?.status === 'done';
    if (completedTask && !outlookCompletionNeedsCancellation(subscription, payload.date, now)) {
      const settled = await settleOutlookDelivery(executor, {
        ...claim, completionSuspended: true, cancellationReason: 'TASK_COMPLETED'
      });
      return settled ? { status: 'UNCHANGED', code: 'TASK_COMPLETED' }
        : { status: 'FAILED', code: 'OUTLOOK_LEASE_LOST' };
    }
    const cancellationReason = unavailable || (completedTask ? 'TASK_COMPLETED' : !payload.ok ? payload.code : null);
    const cancellationCode = cancellationReason === 'USER_REMOVED' ? 'REMOVED' : cancellationReason;
    const mustCancel = Boolean(cancellationReason);
    const method = mustCancel ? 'CANCEL' : 'REQUEST';
    const summary = mustCancel ? 'MERGEN Rota takvim kaydı' : payload.summary;
    const calendarDate = mustCancel ? null : payload.date;

    if (mustCancel && subscription.deliveredSequence == null && !subscription.deliveryMayHaveEscaped) {
      const removed = await deactivateOutlookSubscription(executor, { ...claim, cancellationReason });
      if (!removed) await settleOutlookDelivery(executor, claim);
      return { status: removed ? 'CANCELLED' : 'IN_PROGRESS', code: cancellationCode };
    }
    const payloadHash = mustCancel
      ? outlookCancellationHash({ summary, date: calendarDate }) : outlookPayloadHash(payload);
    if (!mustCancel && !force && !subscription.completionSuspended && subscription.deliveredMethod !== 'CANCEL'
      && payloadHash === subscription.deliveredPayloadHash
      && (!subscription.pendingPayloadHash || subscription.pendingPayloadHash === subscription.deliveredPayloadHash)) {
      const settled = await settleOutlookDelivery(executor, claim);
      return settled ? { status: 'UNCHANGED' } : { status: 'FAILED', code: 'OUTLOOK_LEASE_LOST' };
    }

    const configurationProblem = smtpConfigurationProblem();
    if (configurationProblem) return await failed(configurationProblem);
    const config = getSmtpConfig();
    if (!config) return await failed('SMTP_NOT_CONFIGURED');
    const recipient = subscription.calendarAttendee
      ? { email: subscription.calendarAttendee, name: '' }
      : await loadCorporateRecipient(executor, subscription.userSicil);
    if (!isValidEmailAddress(recipient.email)) return await failed('NO_RECIPIENT_ADDRESS');
    const allocated = await allocateOutlookRevision(executor, {
      ...claim, method, payloadHash,
      attendee: recipient.email,
      organizer: subscription.calendarOrganizer || config.from,
      calendarDate, cancellationReason,
      reuseDelivered: !mustCancel && force && !subscription.completionSuspended && subscription.deliveredMethod !== 'CANCEL'
    });
    if (!allocated) {
      await settleOutlookDelivery(executor, claim);
      return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
    }
    const invitation = renderOutlookInvitation({
      method, uid: subscription.calendarUid, sequence: allocated.sequence,
      summary, description: mustCancel ? '' : payload.description, date: calendarDate,
      organizer: { ...organizerFrom(config), address: allocated.organizer },
      attendee: { address: allocated.attendee, name: recipient.name },
      link: mustCancel ? null : link, dtstamp: now
    });
    const mail = renderOutlookInvitationMail({
      method,
      payload: mustCancel ? { summary, date: calendarDate, fields: { title: summary, project: '' } } : payload,
      link: mustCancel ? null : link
    });
    const sent = await abortableOutlookOperation(() => send({
      to: [allocated.attendee], subject: mail.subject, text: mail.text, html: mail.html,
      calendar: { method, content: invitation, filename: 'mergen-rota.ics' },
      signal: execution.signal
    }), execution.signal);
    if (!sent.ok) return await failed(safeOutlookFailureCode(sent.code, 'SMTP_SEND_FAILED'),
      sent.deliveryMayHaveEscaped === false && !subscription.deliveryMayHaveEscaped && subscription.deliveredSequence == null);
    const completed = await finish((cleanup) => completeOutlookDelivery(cleanup, {
      ...claim, method, sequence: allocated.sequence, payloadHash, summary, calendarDate,
      completionSuspended: completedTask, cancellationReason
    }));
    if (!completed) return { status: 'FAILED', code: 'OUTLOOK_LEASE_LOST', message: outlookMessage('OUTLOOK_LEASE_LOST') };
    return { status: mustCancel ? 'CANCELLED' : 'SENT', code: cancellationCode, sequence: allocated.sequence };
  } catch (error) {
    if (isMissingOutlookSchema(error)) throw error;
    const code = outlookFailureCode(execution.signal.aborted ? execution.signal.reason : error);
    console.error('[outlook] teslimat tamamlanamadı', { subscriptionId: subscription.subscriptionId, code });
    return await failed(code);
  } finally {
    await stopRenewal();
    execution.close();
  }
}

/** HTTP eylemleri kalıcı kuyruğa yazar; otomatik çalışan teslim eder. */
async function addOne(executor, { taskId, sicil, link, send, now, queueOnly = false }) {
  const { taskState, payload } = await resolveTaskPayload(executor, { taskId, sicil, link });
  if (!taskState.exists) return { status: 'NOT_FOUND', code: 'TASK_NOT_FOUND', message: outlookMessage('TASK_NOT_FOUND') };
  if (!taskState.visible) return { status: 'FORBIDDEN', code: 'FORBIDDEN', message: outlookMessage('FORBIDDEN') };
  if (taskState.task.status === 'done') return { status: 'FAILED', code: 'TASK_COMPLETED', message: outlookMessage('TASK_COMPLETED') };
  if (!payload.ok) {
    return { status: 'FAILED', code: payload.code, message: outlookMessage(payload.code) };
  }

  const calendarUid = outlookCalendarUid(taskId, sicil);
  if (!calendarUid) return { status: 'FAILED', code: 'INVALID_IDENTITY', message: outlookMessage('INVALID_IDENTITY') };

  const payloadHash = outlookPayloadHash(payload);
  const stored = await upsertOutlookSubscription(executor, {
    taskId,
    projectId: taskState.task.projectId,
    sicil,
    calendarUid,
    payloadHash
  });
  if (!stored) return { status: 'FAILED', code: 'SUBSCRIPTION_MISSING', message: outlookMessage('SUBSCRIPTION_MISSING') };
  // Kuyruğa hiçbir iş yazılmadıysa kayıt zaten güncel: çift tıklama, ikinci
  // sekme ya da toplu eklemede yinelenen görev ikinci bir davet üretmez.
  if (!stored.pendingMethod) return { status: 'ALREADY_ADDED', message: outlookMessage('ALREADY_ADDED') };

  if (queueOnly) return { status: 'QUEUED', subscribed: true, pending: true, delivered: stored.deliveredSequence != null, message: outlookMessage('QUEUED') };

  // Süren bir teslimat varsa satır SAHİPLENİLEMEZ: çift tıklama ve ikinci sekme
  // ikinci bir davet üretmez.
  const claimed = await claimOutlookSubscription(executor, stored.subscriptionId);
  if (!claimed) return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  const delivery = await deliverSubscription(executor, { subscription: claimed, link, send, now });
  if (delivery.status === 'IN_PROGRESS') return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  if (delivery.status === 'SENT') return { status: 'ADDED', message: outlookMessage('ADDED') };
  if (delivery.status === 'UNCHANGED') return { status: 'ALREADY_ADDED', message: outlookMessage('ALREADY_ADDED') };
  if (delivery.status === 'CANCELLED') {
    const code = delivery.code || 'TASK_NOT_FOUND';
    return { status: 'FAILED', code, message: outlookMessage(code) };
  }
  return {
    status: 'FAILED',
    code: delivery.code || 'SMTP_SEND_FAILED',
    // Abonelik KALICIDIR: gönderim başarısız olsa da kuyrukta kalır ve
    // zamanlanmış tur yeniden dener.
    message: `${delivery.message || outlookMessage('QUEUED')} ${outlookMessage('RETRY_QUEUED')}`.trim()
  };
}

/** Tek görev · Outlook'a ekle. */
export async function addTaskToOutlook(executor, { taskId, sicil, link = null, send = sendMail, now = new Date(), queueOnly = false }) {
  return addOne(executor, { taskId, sicil, link, send, now, queueOnly });
}

/**
 * Toplu ekleme.
 *
 * Her görev için yetki BAĞIMSIZ olarak yeniden denetlenir, her görev kendi
 * bağımsız iCalendar davetini alır ve tek bir görevin hatası ötekileri
 * durdurmaz. Görevler tek bir Outlook randevusunda BİRLEŞTİRİLMEZ: her biri
 * ayrı ayrı güncellenebilir ve iptal edilebilir kalır.
 */
export async function addTasksToOutlook(executor, {
  taskIds = [],
  sicil,
  link = null,
  send = sendMail,
  now = new Date(),
  limit = outlookBulkLimit()
}) {
  const unique = [];
  const seen = new Set();
  for (const value of taskIds) {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  if (unique.length > limit) {
    return { ok: false, code: 'BULK_LIMIT_EXCEEDED', limit, requested: unique.length };
  }

  const results = [];
  for (const taskId of unique) {
    try {
      const outcome = await addOne(executor, { taskId, sicil, link, send, now, queueOnly: true });
      results.push({ taskId, ...outcome });
    } catch (error) {
      if (isMissingOutlookSchema(error)) throw error;
      // Tek bir görevin hatası turu düşürmez; ayrıntı (bağlantı dizesi, adres)
      // günlüğe yazılmaz.
      console.error('[outlook] görev eklenemedi', { code: error?.code || error?.number || null });
      results.push({ taskId, status: 'FAILED', code: 'UNEXPECTED_ERROR', message: outlookMessage('UNEXPECTED_ERROR') });
    }
  }
  return { ok: true, limit, results, summary: summarizeOutlookResults(results) };
}

/**
 * Toplu sonucun sayısal özeti (arayüz tek bir cümleyle bildirir).
 *
 * Bekleyen işler teslim edilmiş sayılmaz; kuyruk sayısı ayrı bildirilir.
 */
export function summarizeOutlookResults(results = []) {
  const summary = { added: 0, alreadyAdded: 0, queued: 0, failed: 0, total: results.length };
  for (const item of results) {
    if (item.status === 'ADDED') summary.added += 1;
    else if (item.status === 'ALREADY_ADDED') summary.alreadyAdded += 1;
    else if (item.status === 'QUEUED' || item.status === 'IN_PROGRESS') summary.queued += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** Aynı randevunun daveti yeniden gönderilir (sürüm ancak içerik değiştiyse artar). */
export async function resendTaskInvitation(executor, { taskId, sicil, link = null, send = sendMail, now = new Date(), queueOnly = false }) {
  const subscription = await loadOutlookSubscription(executor, taskId, sicil);
  if (!subscription || !subscription.isActive) {
    return { status: 'NOT_SUBSCRIBED', code: 'NOT_SUBSCRIBED', message: outlookMessage('NOT_SUBSCRIBED') };
  }
  const taskState = await loadOutlookTask(executor, taskId, sicil);
  if (!taskState.exists) return { status: 'NOT_FOUND', code: 'TASK_NOT_FOUND', message: outlookMessage('TASK_NOT_FOUND') };
  if (!taskState.visible) return { status: 'FORBIDDEN', code: 'FORBIDDEN', message: outlookMessage('FORBIDDEN') };
  if (taskState.task.status === 'done') return { status: 'FAILED', code: 'TASK_COMPLETED', message: outlookMessage('TASK_COMPLETED') };

  const payload = buildOutlookCalendarPayload(taskState.task, { link });
  if (!payload.ok) return { status: 'FAILED', code: payload.code, message: outlookMessage(payload.code) };
  const queued = await queueOutlookResend(executor, taskId, sicil);
  if (!queued) return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  if (queueOnly) return { status: 'QUEUED', message: outlookMessage('QUEUED') };
  const claimed = await claimOutlookSubscription(executor, queued.subscriptionId);
  if (!claimed) return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  const delivery = await deliverSubscription(executor, { subscription: claimed, link, send, now });
  if (delivery.status === 'IN_PROGRESS') return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  if (delivery.status === 'SENT') return { status: 'RESENT', message: outlookMessage('RESENT') };
  if (delivery.status === 'CANCELLED') return { status: 'REMOVED', message: outlookMessage('REMOVED') };
  return {
    status: 'FAILED',
    code: delivery.code || 'SMTP_SEND_FAILED',
    message: delivery.message || outlookMessage('QUEUED')
  };
}

/** Outlook'tan kaldır: iptal daveti gönderilir ve abonelik kapatılır. */
export async function removeTaskFromOutlook(executor, { taskId, sicil, link = null, send = sendMail, now = new Date(), queueOnly = false }) {
  const queued = await queueOutlookCancellation(executor, taskId, sicil);
  if (!queued) return { status: 'NOT_SUBSCRIBED', code: 'NOT_SUBSCRIBED', message: outlookMessage('NOT_SUBSCRIBED') };
  if (queueOnly) return { status: 'QUEUED', message: outlookMessage('REMOVE_QUEUED') };

  const claimed = await claimOutlookSubscription(executor, queued.subscriptionId);
  if (!claimed) return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  const delivery = await deliverSubscription(executor, {
    subscription: claimed,
    link,
    send,
    now
  });
  if (delivery.status === 'IN_PROGRESS') return { status: 'IN_PROGRESS', message: outlookMessage('IN_PROGRESS') };
  if (delivery.status === 'CANCELLED') return { status: 'REMOVED', message: outlookMessage('REMOVED') };
  return {
    status: 'FAILED',
    code: delivery.code || 'SMTP_SEND_FAILED',
    message: `${delivery.message || ''} ${outlookMessage('RETRY_QUEUED')}`.trim()
  };
}

/** Kullanıcının etkin abonelik ve son teslimat durumu. */
export async function loadOutlookCalendarState(executor, { sicil }) {
  try {
    const rows = await loadUserOutlookSubscriptions(executor, sicil);
    return { ok: true, schemaReady: true, tasks: rows };
  } catch (error) {
    if (!isMissingOutlookSchema(error)) throw error;
    return { ok: true, schemaReady: false, tasks: [] };
  }
}

/** Otomatik çalışan ve tanı ucu aynı sınırlı, kiralı teslimat turunu kullanır. */
export async function runOutlookCalendarOutbox(executor, {
  link = null,
  send = sendMail,
  now = new Date(),
  limit = outlookOutboxBatchSize(),
  maxAttempts = outlookMaxAttempts(),
  budgetMs = outlookRunBudgetMs(),
  mailConfigured = null
} = {}) {
  const problem = smtpConfigurationProblem() || (mailConfigured === false ? 'SMTP_NOT_CONFIGURED' : null);
  if (problem) return { ok: false, reason: problem, claimed: 0, sent: 0, cancelled: 0, unchanged: 0, failed: 0 };

  const summary = { ok: true, schemaReady: true, claimed: 0, sent: 0, cancelled: 0, unchanged: 0, inProgress: 0, failed: 0, exhausted: 0, failureCodes: {} };
  const execution = outlookDeadline(Math.max(1, Math.min(240000, Number(budgetMs) || outlookRunBudgetMs())));
  const bounded = outlookExecutor(executor, execution.signal);
  let deliveryInProgress = false;
  try {
    await revalidateOutlookSubscriptions(bounded, limit);
    summary.exhausted = await outlookOutboxHealth(bounded, maxAttempts);
    for (let index = 0; index < limit && !execution.signal.aborted; index += 1) {
      const [subscription] = await claimOutlookDeliveries(bounded, { limit: 1, maxAttempts });
      if (!subscription) break;
      summary.claimed += 1;
      deliveryInProgress = true;
      const delivery = await deliverSubscription(executor, { subscription, link, send, now, signal: execution.signal });
      deliveryInProgress = false;
      if (delivery.status === 'SENT') summary.sent += 1;
      else if (delivery.status === 'CANCELLED') summary.cancelled += 1;
      else if (delivery.status === 'UNCHANGED') summary.unchanged += 1;
      else if (delivery.status === 'IN_PROGRESS') summary.inProgress += 1;
      else {
        summary.failed += 1;
        const code = safeOutlookFailureCode(delivery.code);
        summary.failureCodes[code] = (summary.failureCodes[code] || 0) + 1;
      }
    }
    if (!execution.signal.aborted) summary.exhausted = await outlookOutboxHealth(bounded, maxAttempts);
    summary.ok = summary.failed === 0 && summary.exhausted === 0 && !execution.signal.aborted;
    if (execution.signal.aborted) summary.reason = 'OUTLOOK_RUN_TIMEOUT';
    else if (summary.exhausted) summary.reason = 'OUTLOOK_RETRY_EXHAUSTED';
    else if (summary.failed) summary.reason = Object.keys(summary.failureCodes)[0];
    return summary;
  } catch (error) {
    if (deliveryInProgress) {
      summary.failed += 1;
      const code = outlookFailureCode(execution.signal.aborted ? execution.signal.reason : error);
      summary.failureCodes[code] = (summary.failureCodes[code] || 0) + 1;
    }
    if (isMissingOutlookSchema(error)) return { ...summary, ok: false, schemaReady: false, reason: 'OUTLOOK_SCHEMA_MISSING' };
    if (execution.signal.aborted) return { ...summary, ok: false, reason: 'OUTLOOK_RUN_TIMEOUT' };
    console.error('[outlook] kuyruk sorgusu tamamlanamadı', { code: outlookFailureCode(error) });
    return { ...summary, ok: false, reason: outlookFailureCode(error) };
  } finally { execution.close(); }
}
