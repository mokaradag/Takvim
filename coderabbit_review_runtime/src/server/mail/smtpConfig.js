import 'server-only';
import { isValidEmailAddress } from '../../domain/reminders/emailAddress.js';

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

/**
 * Yapılandırma sorununu döner; sorun yoksa `null`.
 *
 * Varlık denetimi TEK BAŞINA yetmez: `SMTP_HOST`/`SMTP_FROM` tanımlıyken bozuk
 * bir `SMTP_PORT` değeri de gönderimi olanaksız kılar. İki durum ayrı kodlarla
 * bildirilir ki arayüz "yapılandırılmamış" ile "yapılandırma hatalı"yı
 * karıştırmasın.
 *
 * @returns {'SMTP_NOT_CONFIGURED'|'SMTP_CONFIG_INVALID'|null}
 */
export function smtpConfigurationProblem() {
  if (!(stringValue('SMTP_HOST') && stringValue('SMTP_FROM'))) return 'SMTP_NOT_CONFIGURED';
  try {
    readSmtpConfig();
  } catch {
    // Değerin kendisi taşınmaz: hata iletisi ortam değişkeni içeriğini sızdırmaz.
    return 'SMTP_CONFIG_INVALID';
  }
  return null;
}

/** Posta gönderimi eksiksiz yapılandırıldı mı? */
export function isSmtpConfigured() {
  return smtpConfigurationProblem() === null;
}

/**
 * @returns {{host:string, port:number, username:string, password:string,
 *   from:string, fromName:string, useStartTls:boolean, rejectUnauthorized:boolean,
 *   timeoutMs:number}|null}
 */
export function getSmtpConfig() {
  if (!(stringValue('SMTP_HOST') && stringValue('SMTP_FROM'))) return null;
  return readSmtpConfig();
}

function readSmtpConfig() {
  // Gönderen adresi YAPILANDIRMA anında doğrulanır. Geçersiz bir `SMTP_FROM`
  // ile yapılandırma "hazır" görünüyor, hata ancak MIME kurulurken ortaya
  // çıkıyordu: otomatik turda bu, aralık zaten sahiplenildikten SONRA olduğu
  // için o hatırlatma değer düzeltilse bile bir daha gönderilemiyordu.
  const from = stringValue('SMTP_FROM');
  if (from && !isValidEmailAddress(from)) {
    throw new Error('SMTP_FROM must be a valid email address.');
  }
  return Object.freeze({
    host: stringValue('SMTP_HOST'),
    port: integerValue('SMTP_PORT', 587),
    username: stringValue('SMTP_USERNAME'),
    // Parola yalnızca burada okunur; günlüklere ve hata iletilerine geçmez.
    password: stringValue('SMTP_PASSWORD'),
    from: stringValue('SMTP_FROM'),
    fromName: stringValue('SMTP_FROM_NAME', 'MERGEN Rota'),
    useStartTls: booleanValue('SMTP_USE_STARTTLS', true),
    // Şifresiz kanalda kimlik doğrulama ancak BİLİNÇLİ olarak açılır.
    allowInsecureAuth: booleanValue('SMTP_ALLOW_INSECURE_AUTH', false),
    // Kurumsal sunucular çoğu zaman kendi kök sertifikalarını kullanır.
    rejectUnauthorized: booleanValue('SMTP_TLS_REJECT_UNAUTHORIZED', true),
    timeoutMs: integerValue('SMTP_TIMEOUT_MS', 20000, { max: 300000 })
  });
}
