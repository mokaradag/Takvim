const MESSAGES = Object.freeze({
  SMTP_NOT_CONFIGURED: 'E-posta gönderimi yapılandırılmamış.',
  SMTP_CONFIG_INVALID: 'E-posta yapılandırması geçersiz.',
  SMTP_CONNECTION_FAILED: 'E-posta sunucusuna ulaşılamadı.',
  SMTP_TLS_FAILED: 'Güvenli e-posta bağlantısı kurulamadı.',
  SMTP_AUTH_FAILED: 'E-posta sunucusu kimlik doğrulamasını reddetti.',
  SMTP_AUTH_UNSUPPORTED: 'E-posta sunucusunun kimlik doğrulama yöntemi desteklenmiyor.',
  SMTP_INSECURE_AUTH: 'Güvensiz bağlantıda kimlik doğrulama engellendi.',
  SMTP_INVALID_RECIPIENT: 'Alıcı adresi geçersiz.',
  SMTP_NO_RECIPIENTS: 'E-posta sunucusu hiçbir alıcıyı kabul etmedi.',
  SMTP_TIMEOUT: 'E-posta sunucusu zamanında yanıt vermedi.',
  SMTP_SEND_FAILED: 'E-posta gönderilemedi.',
  NO_RECIPIENT_ADDRESS: 'Kurumsal e-posta adresi çözülemedi.',
  OUTLOOK_RUN_TIMEOUT: 'Outlook turunun süre sınırına ulaşıldı; kuyruk otomatik yeniden denenecek.',
  OUTLOOK_LEASE_LOST: 'Outlook teslimat sahipliği kaybedildi; kalıcı kuyruk yeniden değerlendirilecek.',
  OUTLOOK_SCHEMA_MISSING: 'Outlook veritabanı şeması eksik; güncel 0010 ve 0011 yükseltmelerini uygulayın.',
  OUTLOOK_RETRY_EXHAUSTED: 'Deneme eşiğini aşan işler var; otomatik yeniden deneme sürüyor.',
  DATABASE_UNAVAILABLE: 'Veritabanı bağlantısı kurulamadı.',
  DATABASE_TIMEOUT: 'Veritabanı zamanında yanıt vermedi.',
  DATABASE_DEADLOCK: 'Veritabanında geçici işlem çakışması oluştu.',
  DATABASE_QUERY_FAILED: 'Veritabanı sorgusu tamamlanamadı.',
  UNEXPECTED_ERROR: 'Tur tamamlanamadı; sunucu günlüğünü inceleyin.'
});

export function safeOutlookFailureCode(code, fallback = 'UNEXPECTED_ERROR') {
  return Object.hasOwn(MESSAGES, code) ? code : fallback;
}

export function outlookFailureMessage(code) {
  const safe = safeOutlookFailureCode(code);
  return `${safe}: ${MESSAGES[safe]}`;
}
