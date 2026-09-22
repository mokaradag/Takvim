import 'server-only';
import { buildTaskAssignmentMail } from '../../domain/notifications/taskAssignmentMail.js';
import { isValidEmailAddress } from '../../domain/reminders/emailAddress.js';
import { corporateUserEmailSql } from '../identity/corporateDirectory.js';
import { sql } from '../db/pool.js';
import { sendMail } from '../mail/mailService.js';
import { isSmtpConfigured } from '../mail/smtpConfig.js';
import {
  claimDueTaskMail,
  isMissingTaskMailSchema,
  markTaskMailFailed,
  markTaskMailSent
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
 * Kuyruğun bir turunu işler.
 *
 * Tur ETKİSİZDİR (idempotent): kiralanan satır ancak SMTP kabul ettiğinde SENT
 * olur, aksi hâlde geri çekilmeyle yeniden denenir ve aynı ileti iki kez
 * gönderilmez.
 */
export async function runTaskMailOutbox(pool, { limit = MAX_BATCH, link = null } = {}) {
  if (!isSmtpConfigured()) return { ok: true, enabled: false, sent: 0, failed: 0 };
  let claimed;
  try {
    claimed = await claimDueTaskMail(pool, limit);
  } catch (error) {
    if (isMissingTaskMailSchema(error)) return { ok: true, enabled: false, sent: 0, failed: 0 };
    throw error;
  }
  let sent = 0;
  let failed = 0;
  for (const item of claimed) {
    const address = await resolveRecipientAddress(pool, item.recipientSicil);
    if (!address.ok) {
      failed += 1;
      await markTaskMailFailed(pool, item.mailId, address.code);
      continue;
    }
    const message = buildTaskAssignmentMail({ ...item.payload, link: item.payload?.link || link });
    const delivery = await sendMail({
      to: [address.email],
      subject: message.subject,
      html: message.html,
      text: message.text
    });
    if (delivery.ok) {
      sent += 1;
      await markTaskMailSent(pool, item.mailId);
    } else {
      failed += 1;
      await markTaskMailFailed(pool, item.mailId, delivery.code);
    }
  }
  return { ok: failed === 0, enabled: true, sent, failed, claimed: claimed.length };
}
