import 'server-only';
import { getSmtpConfig, smtpConfigurationProblem } from './smtpConfig.js';
import { SmtpError, sendSmtpMail } from './smtpClient.js';

/**
 * Yeniden kullanılabilir posta hizmeti.
 *
 * Elle ve otomatik hatırlatmalar AYNI hizmeti kullanır; ikinci bir SMTP akışı
 * yazılmaz. React bileşenleri bu modülü hiç görmez — gönderim yalnızca sunucu
 * uçlarından yapılır.
 */

const MAIL_ERROR_MESSAGES = Object.freeze({
  SMTP_NOT_CONFIGURED: 'E-posta gönderimi yapılandırılmamış. Sunucuda SMTP_HOST ve SMTP_FROM tanımlanmalıdır.',
  SMTP_CONFIG_INVALID: 'E-posta yapılandırması geçersiz. Sunucudaki SMTP ayarları gözden geçirilmelidir.',
  SMTP_CONNECTION_FAILED: 'E-posta sunucusuna ulaşılamadı.',
  SMTP_TLS_FAILED: 'E-posta sunucusuyla güvenli bağlantı kurulamadı.',
  SMTP_AUTH_FAILED: 'E-posta sunucusunda kimlik doğrulama başarısız oldu.',
  SMTP_TIMEOUT: 'E-posta sunucusu zamanında yanıt vermedi.',
  SMTP_NO_RECIPIENTS: 'Gönderilecek geçerli bir alıcı adresi bulunamadı.',
  SMTP_INVALID_RECIPIENT: 'Alıcı adresi geçerli değil.',
  SMTP_AUTH_UNSUPPORTED: 'E-posta sunucusu desteklenen bir kimlik doğrulama yöntemi bildirmedi.',
  // `smtpClient.authenticate()` bu kodu yükseltiyor ama karşılığı burada yoktu:
  // `mailErrorMessage` ham hata metnine düşüyor ve kullanıcıya sunucu
  // yapılandırma değişkeninin adını (`SMTP_ALLOW_INSECURE_AUTH`) gösteriyordu.
  SMTP_INSECURE_AUTH: 'Şifrelenmemiş e-posta bağlantısında kimlik doğrulama yapılamaz.',
  SMTP_SEND_FAILED: 'E-posta gönderilemedi.'
});

/** Kullanıcıya gösterilebilir, gizli bilgi taşımayan hata iletisi. */
export function mailErrorMessage(code, fallback = MAIL_ERROR_MESSAGES.SMTP_SEND_FAILED) {
  return MAIL_ERROR_MESSAGES[code] || fallback;
}

/**
 * İletiyi gönderir.
 *
 * @returns {Promise<{ok: true, accepted: string[],
 *   rejected: {address: string, statusCode: number|null}[], messageId: string}
 *   | {ok: false, code: string, message: string}>}
 *   Başarı YALNIZCA SMTP sunucusu iletiyi kabul ettiğinde bildirilir.
 */
export async function sendMail({ to = [], subject = '', html = '', text = '' } = {}) {
  // Yapılandırma ÇÖZÜMLEMESİ de denetlenir: bozuk `SMTP_PORT`/`SMTP_TIMEOUT_MS`
  // değeri genel bir sunucu hatası olarak dışarı sızmaz, sözleşmedeki
  // `{ ok: false, code, message }` biçiminde döner.
  const problem = smtpConfigurationProblem();
  if (problem) {
    return { ok: false, code: problem, message: mailErrorMessage(problem) };
  }
  const config = getSmtpConfig();
  try {
    const result = await sendSmtpMail(config, { to, subject, html, text });
    return { ok: true, accepted: result.accepted, rejected: result.rejected || [], messageId: result.messageId };
  } catch (error) {
    // Hata gövdesi kullanıcıya gider: kimlik bilgisi, parola ve ham yığın izi
    // asla taşınmaz.
    const code = error instanceof SmtpError ? error.code : 'SMTP_SEND_FAILED';
    return { ok: false, code, message: mailErrorMessage(code, error?.message || MAIL_ERROR_MESSAGES.SMTP_SEND_FAILED) };
  }
}
