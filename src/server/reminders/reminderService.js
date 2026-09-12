import { reminderRunOutcome } from '../../domain/reminders/reminderRunOutcome.js';
import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  describeRecipientProblems,
  resolveReminderRecipients,
  summarizeRecipientProblems
} from '../../domain/reminders/reminderRecipients.js';
import { buildReminderValues } from '../../domain/reminders/reminderValues.js';
import { renderReminderEmail } from '../../domain/reminders/reminderTemplate.js';
import { evaluateReminderEligibility } from '../../domain/reminders/reminderPolicy.js';
import { sendMail } from '../mail/mailService.js';
import { isSmtpConfigured } from '../mail/smtpConfig.js';
import {
  claimAutomaticReminder,
  completeReminderLog,
  loadLastManualReminderAt,
  loadReminderCandidates,
  loadReminderRecipientRows,
  loadReminderSettings,
  loadReminderTask,
  loadReminderTaskProjectState,
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
 * Gönderim kaydını EN İYİ ÇABAYLA kapatır.
 *
 * Denetim kaydının yazılamaması teslimatın kendisini geçersiz kılmaz; hatayı
 * yukarı taşımak, SMTP'nin kabul ettiği bir iletiyi "başarısız" göstererek
 * kullanıcıyı ikinci kez göndermeye iterdi.
 *
 * @returns {Promise<boolean>} kayıt güncellendi mi
 */
async function finalizeLog(executor, logId, outcome) {
  if (logId == null) return true;
  try {
    await completeReminderLog(executor, logId, outcome);
    return true;
  } catch (error) {
    console.error('[reminders] gönderim kaydı güncellenemedi', {
      logId,
      code: error?.code || error?.number || null
    });
    return false;
  }
}

/**
 * Tek bir görev için hatırlatma gönderir.
 *
 * @param {object} executor SQL yürütücüsü
 * @param {{task: object, settings: object, kind: 'MANUAL'|'AUTOMATIC',
 *   logId: number|null, actorSicil: number|null, now?: Date}} input
 * @returns {Promise<{ok: boolean, code?: string, message?: string,
 *   recipientCount?: number, problems?: Array<object>, warnings?: string[],
 *   partial?: boolean}>}
 *   `problems` AYRINTILIDIR ve sunucuda kalır; `warnings` istemciye dönebilen
 *   kapsam güvenli özettir.
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
  // Uyarılar KİMLİK TAŞIMAZ: kapsam dışı bir eş sorumlunun adı yanıtla dışarı
  // sızmamalıdır (ayrıntılı `problems` sunucuda kalır).
  const warnings = summarizeRecipientProblems(problems);

  if (!recipients.length) {
    await finalizeLog(executor, logId, { status: 'FAILED', recipients: [], failureCode: 'NO_RECIPIENTS' });
    return {
      ok: false,
      code: 'NO_RECIPIENTS',
      message: describeRecipientProblems(problems),
      problems,
      warnings
    };
  }

  const values = buildReminderValues(task, {
    // Sorumlu listesi BÜTÜN atama satırlarından kurulur. Yalnızca adresi
    // çözülenleri yazmak, adresi olmayan sorumluyu görevden sorumlu DEĞİLMİŞ
    // gibi gösteriyordu; `resolved` yalnızca SMTP alıcı listesini belirler.
    assigneeNames: rows.map((row) => String(row?.name || row?.username || '').trim()).filter(Boolean),
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
    await finalizeLog(executor, logId, { status: 'FAILED', recipients, failureCode: sent.code });
    return { ok: false, code: sent.code, message: sent.message, problems, warnings };
  }

  // Kısmi alıcı çözümü geçmişte de GÖRÜNÜR kalır: durum SENT'tir ama neden
  // alanı eksik sorumlu olduğunu söyler.
  const audited = await finalizeLog(executor, logId, {
    status: 'SENT',
    recipients,
    failureCode: problems.length ? 'PARTIAL_RECIPIENTS' : null
  });
  return {
    ok: true,
    recipientCount: recipients.length,
    // Adresler istemciye DÖNMEZ: kişisel veri gereksiz yere tarayıcıya taşınmaz.
    message: `Hatırlatma e-postası ${recipients.length} sorumluya gönderildi.`,
    problems,
    partial: problems.length > 0,
    warnings: audited
      ? warnings
      : [...warnings, 'Hatırlatma gönderildi; gönderim geçmişi kaydı güncellenemedi.']
  };
}

/** Aynı kullanıcının aynı göreve elle hatırlatma gönderme aralığı (ms). */
export const MANUAL_REMINDER_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Görev YÜKLENEMEDİĞİNDE nedeni ayırt eder.
 *
 * `loadReminderTask` etkin proje koşulunu taşır, bu yüzden "görev gerçekten
 * yok" ile "görev duruyor ama projesi devre dışı" aynı boş sonuca düşer. Tek
 * bir `TASK_NOT_FOUND` bildirmek, görevi ekranında GÖREN kullanıcıya
 * "bulunamadı" (404) diyordu; kullanıcı da hatayı bir arıza sanıp yeniden
 * deniyordu. Ayrım YALNIZCA raporlamadadır: iki durumda da posta gönderilmez.
 *
 * Neden okunamazsa (ağ/izin) genel `TASK_NOT_FOUND` korunur; ek bir tanı
 * sorgusu asıl akışı çökertmemelidir.
 */
async function unloadableTaskReason(executor, taskId) {
  let state = null;
  try {
    state = await loadReminderTaskProjectState(executor, taskId);
  } catch {
    return 'TASK_NOT_FOUND';
  }
  return state?.exists && !state.projectActive ? 'PROJECT_INACTIVE' : 'TASK_NOT_FOUND';
}

async function unloadableTaskFailure(executor, taskId) {
  const code = await unloadableTaskReason(executor, taskId);
  return code === 'PROJECT_INACTIVE'
    ? { ok: false, code, message: 'Görevin projesi devre dışı bırakıldığı için hatırlatma gönderilemez.' }
    : { ok: false, code, message: 'Hatırlatma gönderilecek görev bulunamadı.' };
}

/**
 * ELLE tetiklenen hatırlatma.
 *
 * Alıcılar yalnızca görevin kendisinden türetilir; istemci alıcı listesi
 * gönderemez (açık posta rölesi olmaması için).
 */
export async function sendManualReminder(executor, {
  taskId,
  actorSicil,
  now = new Date(),
  send = sendMail,
  minIntervalMs = MANUAL_REMINDER_MIN_INTERVAL_MS,
  // Yetki, GÖNDERİME GİRECEK satıra karşı yeniden doğrulanır. İlk denetim ile
  // bu yükleme ayrı sorgulardır; görev arada başka bir projeye taşınmış ya da
  // yeniden atanmış olabilir ve eski duruma dayanan bir yetki, kullanıcının
  // artık göremediği bir görevin sorumlularına posta göndermeye yeterdi.
  authorize = null
}) {
  const task = await loadReminderTask(executor, taskId);
  if (!task) return unloadableTaskFailure(executor, taskId);
  if (authorize) await authorize(task);

  // EN KÜÇÜK ARALIK: görevi görebilen herkes bu ucu çağırabilir ve her çağrı
  // bütün sorumlulara gerçek e-posta gönderir. Sınır olmadan uç üzerinde bir
  // döngü, iş arkadaşlarının posta kutularını doldurabilir ve SMTP aktarıcısını
  // engelletebilirdi.
  //
  // Bu ön okuma YALNIZCA kullanıcıya gösterilecek bekleme süresini üretir;
  // sınırı gerçekten uygulayan denetim aşağıdaki koşullu kayıt açmadır. Ayrı
  // bir okuma tek başına yarışa açıktı: aynı kullanıcının iki eşzamanlı isteği
  // de "son gönderim yok" görüp ikisi de posta gönderiyordu.
  const rateLimited = async () => {
    const lastAt = await loadLastManualReminderAt(executor, task.id, actorSicil);
    const elapsedMs = lastAt ? now.getTime() - lastAt.getTime() : 0;
    const remainingMs = Math.max(1000, minIntervalMs - Math.max(0, elapsedMs));
    const waitSeconds = Math.ceil(remainingMs / 1000);
    return {
      ok: false,
      code: 'MANUAL_REMINDER_RATE_LIMITED',
      message: `Bu görev için az önce hatırlatma gönderildi. ${waitSeconds} saniye sonra yeniden deneyebilirsiniz.`,
      retryAfterSeconds: waitSeconds
    };
  };

  const lastManualAt = await loadLastManualReminderAt(executor, task.id, actorSicil);
  if (lastManualAt && minIntervalMs > 0) {
    const elapsedMs = now.getTime() - lastManualAt.getTime();
    if (elapsedMs >= 0 && elapsedMs < minIntervalMs) return rateLimited();
  }

  const settings = await loadReminderSettings(executor);
  // Elle gönderim, otomatik hatırlatma KAPALI olsa da çalışır.
  const logId = await logManualReminder(executor, {
    taskId: task.id,
    projectId: task.projectId,
    slotKey: `manual:${randomUUID()}`,
    actorSicil,
    intervalStart: minIntervalMs > 0 ? new Date(now.getTime() - minIntervalMs) : null
  });
  // Sahiplenme başarısız: aralık henüz dolmamış ya da eşzamanlı bir istek
  // hakkı az önce almış. Hiçbir posta gönderilmez.
  if (logId == null && minIntervalMs > 0) return rateLimited();

  return deliverTaskReminder(executor, { task, settings, kind: 'MANUAL', logId, actorSicil, now, send });
}

/** Durdurma anahtarının yeniden okunma aralığı (ms). */
const SETTINGS_REFRESH_MS = 30000;

/**
 * OTOMATİK hatırlatma turu.
 *
 * Her görev bağımsız işlenir: birinin gönderimi başarısız olduğunda tur durmaz,
 * öteki uygun görevler işlenmeye devam eder.
 *
 * @returns {Promise<{ok: boolean, enabled: boolean, evaluated: number,
 *   sent: number, skipped: number, failed: number, partial: number,
 *   results: Array<object>}>}
 */
export async function runAutomaticReminders(executor, {
  now = new Date(),
  actorSicil = null,
  send = sendMail,
  // Yapılandırma denetimi YALNIZCA gerçek posta hizmeti için anlamlıdır;
  // enjekte edilen bir taşıyıcı tanımı gereği hazırdır.
  mailConfigured = send === sendMail ? isSmtpConfigured() : true
} = {}) {
  let settings = await loadReminderSettings(executor);
  if (!settings.automaticEnabled) {
    return { ok: true, enabled: false, evaluated: 0, sent: 0, skipped: 0, failed: 0, partial: 0, results: [] };
  }
  if (!mailConfigured) {
    // Aralık SAHİPLENİLMEZ. SMTP yapılandırılmadan iddia edilen aralık kalıcı
    // olarak tüketilir; yapılandırma sonradan tamamlandığında o hatırlatma bir
    // daha gönderilemez ve uzun sıklıkta görev termine kadar hiç posta almaz.
    return {
      ok: false,
      enabled: true,
      reason: 'SMTP_NOT_CONFIGURED',
      evaluated: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      partial: 0,
      results: []
    };
  }

  const horizonDays = Math.ceil(settings.windowMinutes / 1440) + 1;
  const candidates = await loadReminderCandidates(executor, horizonDays, now);
  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let partial = 0;

  let settingsReadAt = Date.now();

  for (const candidate of candidates) {
    // Yapılandırma ARALIKLA yeniden okunur: uzun bir tur sürerken yönetici
    // otomatik gönderimi kapatabilir ve belgelenen durdurma anahtarı ancak
    // böyle gerçekten durdurur. Her aday için yeniden okumak, yüzlerce adaylı
    // bir turda aynı sayıda gereksiz SQL gidiş-dönüşü demekti.
    if (Date.now() - settingsReadAt >= SETTINGS_REFRESH_MS) {
      settings = await loadReminderSettings(executor);
      settingsReadAt = Date.now();
    }
    if (!settings.automaticEnabled) {
      skipped += 1;
      results.push({ taskId: candidate.id, status: 'SKIPPED', reason: 'AUTOMATIC_DISABLED' });
      continue;
    }

    const evaluation = evaluateReminderEligibility(candidate, settings, now);
    if (!evaluation.eligible) {
      skipped += 1;
      results.push({ taskId: candidate.id, status: 'SKIPPED', reason: evaluation.reason });
      continue;
    }

    // Sahiplenilen kayıt catch bloğundan da GÖRÜNÜR olmalıdır: beklenmedik bir
    // hata satırı `PENDING` bırakırsa benzersiz aralık kısıtı, sorun giderilse
    // bile o aralığı sonsuza dek gönderilmiş sayar.
    let claimedLogId = null;
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
      claimedLogId = logId;

      const task = await loadReminderTask(executor, candidate.id);
      if (!task) {
        // Görev tur sırasında silinmiş YA DA projesi devre dışı bırakılmış
        // olabilir. İkisi de gönderimi durdurur; denetim kaydında tek bir
        // `TASK_NOT_FOUND` görmek, silinmemiş bir görevi araştıran yöneticiyi
        // yanlış yöne sürüklüyordu.
        const reason = await unloadableTaskReason(executor, candidate.id);
        await finalizeLog(executor, logId, { status: 'FAILED', recipients: [], failureCode: reason });
        failed += 1;
        results.push({ taskId: candidate.id, status: 'FAILED', reason });
        continue;
      }

      // Uygunluk YENİDEN değerlendirilir: aday listesi alındıktan sonra görev
      // tamamlanmış/iptal edilmiş ya da termini değişmiş olabilir. Aksi hâlde
      // belgelenen durma koşulları, sıralı turda önceki gönderimler sürerken
      // atlanıyordu.
      const recheck = evaluateReminderEligibility(task, settings, now);
      if (!recheck.eligible || recheck.slotKey !== evaluation.slotKey) {
        await finalizeLog(executor, logId, {
          status: 'FAILED',
          recipients: [],
          failureCode: recheck.eligible ? 'SLOT_CHANGED' : (recheck.reason || 'NOT_ELIGIBLE')
        });
        skipped += 1;
        results.push({
          taskId: candidate.id,
          status: 'SKIPPED',
          reason: recheck.eligible ? 'SLOT_CHANGED' : recheck.reason
        });
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
        if (delivery.partial) partial += 1;
        results.push({
          taskId: candidate.id,
          status: 'SENT',
          recipientCount: delivery.recipientCount,
          // Kısmi alıcı çözümü özette KAYBOLMAZ: sahiplenilen aralık bir daha
          // denenmeyeceği için eksik sorumlu bilgisi burada görünmelidir.
          partial: Boolean(delivery.partial),
          warnings: delivery.warnings || []
        });
      } else {
        failed += 1;
        results.push({
          taskId: candidate.id,
          status: 'FAILED',
          reason: delivery.code,
          warnings: delivery.warnings || []
        });
      }
    } catch (error) {
      // Tek bir görevin hatası turu düşürmez; kayıt kodu tutulur, ayrıntı
      // (bağlantı dizesi, parola vb.) günlüğe yazılmaz.
      await finalizeLog(executor, claimedLogId, {
        status: 'FAILED',
        recipients: [],
        failureCode: 'UNEXPECTED_ERROR'
      });
      failed += 1;
      results.push({ taskId: candidate.id, status: 'FAILED', reason: 'UNEXPECTED_ERROR' });
      console.error('[reminders] görev işlenemedi', { taskId: candidate.id, code: error?.code || error?.number || null });
    }
  }

  return reminderRunOutcome({ enabled: true, evaluated: candidates.length, sent, skipped, failed, partial, results });
}
