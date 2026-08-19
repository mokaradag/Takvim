import 'server-only';

/**
 * SMTP yapılandırması — YALNIZCA sunucu tarafı.
 *
 * Değerler `.env.local` üzerinden gelir ve hiçbiri `NEXT_PUBLIC_` ön eki
 * taşımaz: kullanıcı adı/parola istemci paketine asla girmez. Yapılandırma
 * eksikse posta gönderimi kapalıdır ve arayüz bunu açık bir iletiyle söyler;
 * sessizce "gönderildi" denmez.
 *
 * Akış, üretimde çalıştığı doğrulanmış Python uygulamasının davranışını birebir
 * yeniden üretir: 587 numaralı bağlantı noktası, `EHLO` → `STARTTLS` → `EHLO`
 * → kimlik doğrulama → `MAIL FROM`/`RCPT TO`/`DATA` → `QUIT`.
 */

function stringValue(name, fallback = '') {
  const value = process.env[name];
  return value == null ? fallback : String(value).trim() || fallback;
}

function booleanValue(name, fallback) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  const text = String(value).trim();
  if (/^(1|true|yes|evet)$/i.test(text)) return true;
  if (/^(0|false|no|hayir|hayır)$/i.test(text)) return false;
  throw new Error(`${name} must be true or false.`);
}

function integerValue(name, fallback, { max = 65535 } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim();
  const value = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

/** Posta gönderimi yapılandırıldı mı? */
export function isSmtpConfigured() {
  return Boolean(stringValue('SMTP_HOST') && stringValue('SMTP_FROM'));
}

/**
 * @returns {{host:string, port:number, username:string, password:string,
 *   from:string, fromName:string, useStartTls:boolean, rejectUnauthorized:boolean,
 *   timeoutMs:number}|null}
 */
export function getSmtpConfig() {
  if (!isSmtpConfigured()) return null;
  return Object.freeze({
    host: stringValue('SMTP_HOST'),
    port: integerValue('SMTP_PORT', 587),
    username: stringValue('SMTP_USERNAME'),
    // Parola yalnızca burada okunur; günlüklere ve hata iletilerine geçmez.
    password: stringValue('SMTP_PASSWORD'),
    from: stringValue('SMTP_FROM'),
    fromName: stringValue('SMTP_FROM_NAME', 'MERGEN Rota'),
    useStartTls: booleanValue('SMTP_USE_STARTTLS', true),
    // Kurumsal sunucular çoğu zaman kendi kök sertifikalarını kullanır.
    rejectUnauthorized: booleanValue('SMTP_TLS_REJECT_UNAUTHORIZED', true),
    timeoutMs: integerValue('SMTP_TIMEOUT_MS', 20000, { max: 300000 })
  });
}
