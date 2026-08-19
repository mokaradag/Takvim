import 'server-only';
import { randomUUID } from 'node:crypto';
import { describeRecipientProblems, resolveReminderRecipients } from '../../domain/reminders/reminderRecipients.js';
import { buildReminderValues } from '../../domain/reminders/reminderValues.js';
import { renderReminderEmail } from '../../domain/reminders/reminderTemplate.js';
import { evaluateReminderEligibility } from '../../domain/reminders/reminderPolicy.js';
import { sendMail } from '../mail/mailService.js';
import {
  claimAutomaticReminder,
  completeReminderLog,
  loadReminderCandidates,
  loadReminderRecipientRows,
  loadReminderSettings,
  loadReminderTask,
  logManualReminder
} from './reminderStore.js';

/**
 * Hatırlatma gönderiminin ORTAK çekirdeği.
 *
 * Elle ve otomatik akışlar aynı adımları paylaşır: alıcı çözümü → şablon
 * yerleştirme → SMTP → kalıcı gönderim kaydı. İkinci bir uygulama yazılmaz;
 * böylece iki yol arasında davranış farkı oluşamaz.
 */

/**
 * Tek bir görev için hatırlatma gönderir.
 *
 * @param {object} executor SQL yürütücüsü
 * @param {{task: object, settings: object, kind: 'MANUAL'|'AUTOMATIC',
 *   logId: number|null, actorSicil: number|null, now?: Date}} input
 * @returns {Promise<{ok: boolean, code?: string, message?: string,
 *   recipientCount?: number, problems?: Array<object>}>}
 */
export async function deliverTaskReminder(executor, {
  task,
  settings,
  kind,
  logId = null,
  actorSicil = null,
  now = new Date(),
  // Posta hizmeti ENJEKTE EDİLEBİLİR: testler SMTP sunucusu olmadan da
  // başarı/başarısızlık yollarını sınayabilir. Üretimde varsayılan kullanılır.
  send = sendMail
}) {
  const rows = await loadReminderRecipientRows(executor, task.id);
  const { recipients, resolved, problems } = resolveReminderRecipients(rows);

  if (!recipients.length) {
    await completeReminderLog(executor, logId, { status: 'FAILED', recipients: [], failureCode: 'NO_RECIPIENTS' });
    return {
      ok: false,
      code: 'NO_RECIPIENTS',
      message: describeRecipientProblems(problems),
      problems
    };
  }

  const values = buildReminderValues(task, {
    assigneeNames: resolved.map((entry) => entry.name || entry.username).filter(Boolean),
    now
  });
  const rendered = renderReminderEmail({ subject: settings.subject, body: settings.body }, values);
  const sent = await send({
    to: recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text
  });

  if (!sent.ok) {
    await completeReminderLog(executor, logId, { status: 'FAILED', recipients, failureCode: sent.code });
    return { ok: false, code: sent.code, message: sent.message, problems };
  }

  await completeReminderLog(executor, logId, { status: 'SENT', recipients, failureCode: null });
  return {
    ok: true,
    recipientCount: recipients.length,
    // Adresler istemciye DÖNMEZ: kişisel veri gereksiz yere tarayıcıya taşınmaz.
    message: `Hatırlatma e-postası ${recipients.length} sorumluya gönderildi.`,
    problems
  };
}

/**
 * ELLE tetiklenen hatırlatma.
 *
 * Alıcılar yalnızca görevin kendisinden türetilir; istemci alıcı listesi
 * gönderemez (açık posta rölesi olmaması için).
 */
export async function sendManualReminder(executor, { taskId, actorSicil, now = new Date(), send = sendMail }) {
  const task = await loadReminderTask(executor, taskId);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND', message: 'Hatırlatma gönderilecek görev bulunamadı.' };

  const settings = await loadReminderSettings(executor);
  // Elle gönderim, otomatik hatırlatma KAPALI olsa da çalışır.
  const logId = await logManualReminder(executor, {
    taskId: task.id,
    projectId: task.projectId,
    slotKey: `manual:${randomUUID()}`,
    actorSicil
  });

  return deliverTaskReminder(executor, { task, settings, kind: 'MANUAL', logId, actorSicil, now, send });
}

/**
 * OTOMATİK hatırlatma turu.
 *
 * Her görev bağımsız işlenir: birinin gönderimi başarısız olduğunda tur durmaz,
 * öteki uygun görevler işlenmeye devam eder.
 *
 * @returns {Promise<{ok: boolean, enabled: boolean, evaluated: number,
 *   sent: number, skipped: number, failed: number, results: Array<object>}>}
 */
export async function runAutomaticReminders(executor, { now = new Date(), actorSicil = null, send = sendMail } = {}) {
  const settings = await loadReminderSettings(executor);
  if (!settings.automaticEnabled) {
    return { ok: true, enabled: false, evaluated: 0, sent: 0, skipped: 0, failed: 0, results: [] };
  }

  const horizonDays = Math.ceil(settings.windowMinutes / 1440) + 1;
  const candidates = await loadReminderCandidates(executor, horizonDays);
  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const evaluation = evaluateReminderEligibility(candidate, settings, now);
    if (!evaluation.eligible) {
      skipped += 1;
      results.push({ taskId: candidate.id, status: 'SKIPPED', reason: evaluation.reason });
      continue;
    }

    try {
      // Aralık ÖNCE sahiplenilir: aynı aralık için ikinci bir gönderim, tur
      // saatte bir çalışsa ya da ikinci bir uygulama örneği aynı anda başlasa
      // bile oluşamaz.
      const logId = await claimAutomaticReminder(executor, {
        taskId: candidate.id,
        projectId: candidate.projectId,
        slotKey: evaluation.slotKey,
        actorSicil
      });
      if (logId == null) {
        skipped += 1;
        results.push({ taskId: candidate.id, status: 'SKIPPED', reason: 'ALREADY_SENT' });
        continue;
      }

      const task = await loadReminderTask(executor, candidate.id);
      if (!task) {
        // Görev tur sırasında silinmiş olabilir.
        await completeReminderLog(executor, logId, { status: 'FAILED', recipients: [], failureCode: 'TASK_NOT_FOUND' });
        failed += 1;
        results.push({ taskId: candidate.id, status: 'FAILED', reason: 'TASK_NOT_FOUND' });
        continue;
      }

      const delivery = await deliverTaskReminder(executor, {
        task,
        settings,
        kind: 'AUTOMATIC',
        logId,
        actorSicil,
        now,
        send
      });
      if (delivery.ok) {
        sent += 1;
        results.push({ taskId: candidate.id, status: 'SENT', recipientCount: delivery.recipientCount });
      } else {
        failed += 1;
        results.push({ taskId: candidate.id, status: 'FAILED', reason: delivery.code });
      }
    } catch (error) {
      // Tek bir görevin hatası turu düşürmez; kayıt kodu tutulur, ayrıntı
      // (bağlantı dizesi, parola vb.) günlüğe yazılmaz.
      failed += 1;
      results.push({ taskId: candidate.id, status: 'FAILED', reason: 'UNEXPECTED_ERROR' });
      console.error('[reminders] görev işlenemedi', { taskId: candidate.id, code: error?.code || error?.number || null });
    }
  }

  return { ok: true, enabled: true, evaluated: candidates.length, sent, skipped, failed, results };
}
