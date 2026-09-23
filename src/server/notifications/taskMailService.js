import 'server-only';
import { buildTaskAssignmentMail } from '../../domain/notifications/taskAssignmentMail.js';
import { isValidEmailAddress } from '../../domain/reminders/emailAddress.js';
import { corporateUserEmailSql } from '../identity/corporateDirectory.js';
import { sql } from '../db/pool.js';
import { sendMail } from '../mail/mailService.js';
import { getSmtpConfig, isSmtpConfigured } from '../mail/smtpConfig.js';
import {
  claimDueTaskMail,
  isMissingTaskMailSchema,
  markTaskMailFailed,
  markTaskMailSent,
  markTaskMailUncertain,
  TASK_MAIL_LEASE_SLACK_MS,
  taskMailBatchSize,
  taskMailDeliveryBudgetMs,
  taskMailLeaseSeconds
} from './taskMailOutbox.js';

/**
 * Görev bildirim postasının TESLİMATI.
 *
 * Var olan SMTP altyapısı yeniden kullanılır (bkz. server/mail/mailService.js);
 * ikinci bir SMTP istemcisi yazılmaz. Alıcı adresi görev kaydına KOPYALANMAZ,
 * her teslimatta kurumsal dizinden okunur.
 */

const MAX_BATCH = 20;

async function resolveRecipientAddress(pool, sicil) {
  const request = pool.request();
  request.input('sicil', sql.Int, Number(sicil));
  const result = await request.query(corporateUserEmailSql());
  const row = result.recordset?.[0] || null;
  if (!row) return { ok: false, code: 'MAIL_RECIPIENT_UNKNOWN' };
  if (!row.Username) return { ok: false, code: 'MAIL_RECIPIENT_NO_USERNAME' };
  const email = String(row.Email || '').trim();
  if (!email) return { ok: false, code: 'MAIL_RECIPIENT_NO_EMAIL' };
  if (!isValidEmailAddress(email)) return { ok: false, code: 'MAIL_RECIPIENT_INVALID_EMAIL' };
  return { ok: true, email };
}

/**
 * Kiralanmış TEK satırın teslimatı.
 *
 * Satıra özgü bir hata (dizin okuması, ileti kurulumu, gönderici) yalnızca o
 * satırı etkiler ve deneme olarak kaydedilir. Daha önce böyle bir hata turu
 * düşürüyordu: satır `AttemptCount` artmadan `PENDING` kalıyor, kira dolunca
 * `NextAttemptAt, MailId` sırasıyla yeniden ilk sıraya geliyor ve partideki
 * sonraki satırların işlenmesini süresiz engelleyebiliyordu.
 *
 * Aşama ayrımı bilinçlidir:
 *   · SMTP'ye ulaşmadan önceki hata olağan geri çekilmeyle yeniden denenir,
 *   · gönderici FIRLATIRSA iletinin sunucuya ulaşıp ulaşmadığı bilinemez ve
 *     satır belirsiz teslimat olarak durur,
 *   · teslimattan SONRAKİ durum yazması hatası yutulmaz: veritabanı yazılamıyorsa
 *     sonraki satırlar da kaydedilemeyecek gönderimler üretir; tur durur ve satır
 *     kira dolunca yeniden kiralanır.
 */
async function deliverClaimedTaskMail(pool, item, { link, send, deliveryBudgetMs, leaseDeadlineMs }) {
  let address;
  let message;
  try {
    address = await resolveRecipientAddress(pool, item.recipientSicil);
    if (address.ok) message = buildTaskAssignmentMail({ ...item.payload, link: item.payload?.link || link });
  } catch {
    await markTaskMailFailed(pool, item.mailId, 'MAIL_PREPARE_FAILED', item.leaseToken).catch(() => {});
    return 'failed';
  }
  if (!address.ok) {
    await markTaskMailFailed(pool, item.mailId, address.code, item.leaseToken);
    return 'failed';
  }
  // Teslimat kira içinde BİTEMEYECEKSE hiç başlatılmaz; satır kira dolunca
  // yeniden kiralanır. Kira bittikten sonra başlayan bir gönderim, satırı
  // devralan örneğin gönderimiyle çakışırdı.
  if (Date.now() + deliveryBudgetMs + TASK_MAIL_LEASE_SLACK_MS > leaseDeadlineMs) return 'deferred';

  let delivery;
  try {
    delivery = await send({
      to: [address.email],
      subject: message.subject,
      html: message.html,
      text: message.text,
      signal: AbortSignal.timeout(deliveryBudgetMs)
    });
  } catch {
    delivery = { ok: false, code: 'MAIL_SEND_FAILED', deliveryMayHaveEscaped: true };
  }
  if (delivery?.ok) {
    await markTaskMailSent(pool, item.mailId, item.leaseToken);
    return 'sent';
  }
  if (delivery?.deliveryMayHaveEscaped) {
    await markTaskMailUncertain(pool, item.mailId, item.leaseToken);
    return 'uncertain';
  }
  await markTaskMailFailed(pool, item.mailId, delivery?.code, item.leaseToken);
  return 'failed';
}

/**
 * Kuyruğun bir turunu işler.
 *
 * Kiralanan satır ancak SMTP kabul ettiğinde SENT olur, aksi hâlde geri
 * çekilmeyle yeniden denenir. Her teslimat uçtan uca bütçesiyle kesilir ve kira
 * partinin bütçe toplamını kapsar; kira bitmeden tamamlanamayacak teslimat hiç
 * başlatılmaz. Her durum yazması kiranın sahiplik belirtecini taşır: kira yine
 * de dolarsa satırı başka bir örnek devralır, bu tur onun durumunu ezmez.
 *
 * Teslimatı belirsiz kalan satır (gövde aktarıldı, kabul yanıtı okunamadı)
 * yeniden denenmez: alıcı aynı iletiyi ikinci kez almaz. Tam olarak bir kez
 * teslimat garanti edilmez: SMTP kabulü ile `SENT` yazımı arasında çalışan
 * durursa satır kira dolunca yeniden gönderilebilir.
 */
export async function runTaskMailOutbox(pool, { limit = MAX_BATCH, link = null, send = sendMail } = {}) {
  if (!isSmtpConfigured()) return { ok: true, enabled: false, sent: 0, failed: 0 };
  let claimed;
  const timeoutMs = getSmtpConfig()?.timeoutMs;
  const batchSize = taskMailBatchSize(limit, timeoutMs);
  const leaseSeconds = taskMailLeaseSeconds(batchSize, timeoutMs);
  const deliveryBudgetMs = taskMailDeliveryBudgetMs(timeoutMs);
  // Yerel saat kiralamadan ÖNCE okunur: veritabanındaki kira bitişi bu andan
  // en az `leaseSeconds` sonradır, yerel son tarih ondan geç olamaz.
  const leaseDeadlineMs = Date.now() + leaseSeconds * 1000;
  try {
    claimed = await claimDueTaskMail(pool, batchSize, { leaseSeconds });
  } catch (error) {
    if (isMissingTaskMailSchema(error)) return { ok: true, enabled: false, sent: 0, failed: 0 };
    throw error;
  }
  const outcomes = { sent: 0, failed: 0, uncertain: 0, deferred: 0 };
  for (const item of claimed) {
    // Süre yalnızca ilerler: ertelenen bir satırdan sonrakiler de kiraya
    // sığmaz, dizin okumasıyla boşuna yük bindirilmez.
    const outcome = outcomes.deferred
      ? 'deferred'
      : await deliverClaimedTaskMail(pool, item, { link, send, deliveryBudgetMs, leaseDeadlineMs });
    outcomes[outcome] += 1;
  }
  const reason = outcomes.uncertain
    ? 'MAIL_DELIVERY_UNCERTAIN'
    : outcomes.failed
      ? 'MAIL_DELIVERY_FAILED'
      : null;
  return {
    ok: !reason,
    ...(reason ? { reason } : {}),
    enabled: true,
    ...outcomes,
    claimed: claimed.length
  };
}
