import { isValidEmailAddress } from '../../domain/reminders/emailAddress.js';

/**
 * RFC 5322 / MIME ileti kurulumu.
 *
 * Saf modüldür: ağ bağlantısı kurmaz, yalnızca metin üretir. Böylece başlık
 * enjeksiyonu, Türkçe karakter korunumu ve çok parçalı gövde tek başına
 * sınanabilir.
 *
 * İki karar bilinçlidir:
 *  - Başlıklar RFC 2047 "encoded-word" ile base64 olarak yazılır. Türkçe konu
 *    satırı ham gönderildiğinde Outlook onu 8 bit ISO-8859-1 sanıp bozuyordu.
 *  - Gövde `multipart/alternative` taşır: HTML okuyamayan istemci düz metin
 *    karşılığını görür (spesifikasyonun istediği yedek).
 */

/** Başlık değerine satır sonu enjekte edilemez (RFC 5322 · başlık enjeksiyonu). */
export function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
}

// Adres kuralı ALAN MODELİNDE tanımlıdır; iki katmanın ayrışması, alıcı
// çözümünün kabul ettiği bir adresin MIME katmanında reddedilmesine yol açardı.
export { isValidEmailAddress };

function needsEncoding(value) {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7E]/.test(value);
}

/** Başlığı RFC 2047 base64 "encoded-word" biçimine çevirir (gerekiyorsa). */
export function encodeHeaderValue(value) {
  const clean = sanitizeHeaderValue(value);
  if (!clean) return '';
  if (!needsEncoding(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** `Ad <adres>` biçiminde bir gönderici/alıcı başlığı üretir. */
export function formatAddress(address, displayName = '') {
  const cleanAddress = sanitizeHeaderValue(address);
  const cleanName = sanitizeHeaderValue(displayName);
  if (!cleanName) return cleanAddress;
  return `${encodeHeaderValue(cleanName)} <${cleanAddress}>`;
}

function base64Body(value) {
  return Buffer.from(String(value ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
    .replace(/\r\n$/, '');
}

/**
 * Çok parçalı (HTML + düz metin) ileti gövdesini kurar.
 *
 * @param {{from:string, fromName?:string, to:string[], subject:string,
 *   html:string, text:string, messageId?:string, date?:Date}} input
 * @returns {string} CRLF satır sonlu RFC 5322 iletisi
 */
export function buildMimeMessage({
  from,
  fromName = '',
  to = [],
  subject = '',
  html = '',
  text = '',
  messageId = null,
  date = new Date()
}) {
  const recipients = [...new Set(to.map((value) => sanitizeHeaderValue(value)).filter(Boolean))];
  if (!recipients.length) throw new Error('En az bir alıcı adresi gereklidir.');
  for (const address of recipients) {
    if (!isValidEmailAddress(address)) throw new Error(`Geçersiz alıcı adresi: ${address}`);
  }
  const sender = sanitizeHeaderValue(from);
  if (!isValidEmailAddress(sender)) throw new Error(`Geçersiz gönderici adresi: ${sender}`);

  const boundary = `----=_MERGENRota_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const headers = [
    `From: ${formatAddress(sender, fromName)}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${sanitizeHeaderValue(messageId || `${Date.now()}.${Math.random().toString(36).slice(2)}@mergen-rota`)}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html),
    `--${boundary}--`,
    ''
  ];

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/**
 * DATA gövdesinde satır başındaki tek nokta kaçırılır (RFC 5321 · nokta
 * doldurma). Aksi hâlde ileti o satırda erken sonlanır.
 */
export function dotStuff(message) {
  return String(message ?? '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}
