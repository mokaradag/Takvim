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

/**
 * Tek bir "encoded-word" için sekizlik bütçesi.
 *
 * RFC 2047 üst sınırı 75'tir; burada daha DAR tutulur. `Subject: ` gibi en uzun
 * başlık öneki 9 sekizliktir ve 75'lik bir sözcük eklendiğinde ilk fiziksel
 * satır RFC 5322'nin önerdiği 78 sekizliği aşıyordu. 63 ile önek + sözcük her
 * koşulda sınırın altında kalır.
 */
const MAX_ENCODED_WORD = 63;

/** RFC 5322 · 2.1.1 önerilen satır sınırı 78 sekizliktir; altında kalınır. */
const MAX_HEADER_LINE = 76;

const ENCODED_WORD_PREFIX = '=?UTF-8?B?';
const ENCODED_WORD_SUFFIX = '?=';

/**
 * Başlığı RFC 2047 base64 "encoded-word" dizisine çevirir.
 *
 * Uzun Türkçe konu satırı TEK bir sözcüğe sıkıştırılamaz: 75 sekizliği aşan
 * encoded-word'ü kimi sunucular reddediyor, kimi istemciler bozuk çözüyor.
 * Bu yüzden metin, kod noktası bütünlüğü korunarak birden çok sözcüğe bölünür.
 */
export function encodeHeaderWords(value) {
  const clean = sanitizeHeaderValue(value);
  if (!clean) return [];
  if (!needsEncoding(clean)) return [clean];
  // base64 her 3 sekizliği 4 karaktere çevirir; sözcük başına düşen sekizlik
  // bütçesi buradan gelir.
  const budget = MAX_ENCODED_WORD - ENCODED_WORD_PREFIX.length - ENCODED_WORD_SUFFIX.length;
  const maxBytes = Math.floor(budget / 4) * 3;
  const words = [];
  let chunk = '';
  let size = 0;
  const push = () => {
    if (!chunk) return;
    words.push(`${ENCODED_WORD_PREFIX}${Buffer.from(chunk, 'utf8').toString('base64')}${ENCODED_WORD_SUFFIX}`);
    chunk = '';
    size = 0;
  };
  // `for…of` kod noktalarında ilerler: çok baytlı karakter ikiye bölünmez.
  for (const char of clean) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > maxBytes) push();
    chunk += char;
    size += bytes;
  }
  push();
  return words;
}

/** Başlığı RFC 2047 base64 "encoded-word" biçimine çevirir (gerekiyorsa). */
export function encodeHeaderValue(value) {
  return encodeHeaderWords(value).join(' ');
}

/**
 * Başlık satırını RFC 5322 · 2.2.3 katlama kurallarıyla yazar.
 *
 * Belirteçler arasına boşluk konur; satır sınırı aşılacaksa CRLF + tek boşluk
 * ile devam edilir. Katlama olmadan uzun konu ya da kalabalık alıcı listesi
 * fiziksel satır sınırını aşıyor ve kimi SMTP sunucularınca bozuluyordu.
 */
export function foldHeader(name, tokens) {
  const parts = (Array.isArray(tokens) ? tokens : [tokens])
    .map((token) => String(token ?? '').trim())
    .filter(Boolean);
  if (!parts.length) return `${name}:`;
  const lines = [];
  let current = `${name}:`;
  for (const part of parts) {
    // Belirteç HİÇBİR koşulda bölünmez; sınırı tek başına aşan bir belirteç
    // (örneğin çok uzun bir adres) kendi satırında yazılır.
    if (current !== `${name}:` && current.length + 1 + part.length > MAX_HEADER_LINE) {
      lines.push(current);
      current = ' ';
    }
    current = current === ' ' ? ` ${part}` : `${current} ${part}`;
  }
  lines.push(current);
  return lines.join('\r\n');
}

// RFC 5322 · 3.2.3 "specials": tırnaksız bir phrase içinde yer alamazlar.
// Örneğin `MERGEN Rota, PMO` virgül yüzünden iki posta kutusu gibi ayrıştırılır.
const ADDRESS_SPECIALS = /[()<>@,;:\\".\[\]]/;

/** Görünen adı gerekiyorsa kodlar, gerekiyorsa tırnaklayıp kaçırır. */
export function quoteDisplayName(value) {
  const clean = sanitizeHeaderValue(value);
  if (!clean) return '';
  if (needsEncoding(clean)) return encodeHeaderValue(clean);
  if (!ADDRESS_SPECIALS.test(clean)) return clean;
  return `"${clean.replace(/([\\"])/g, '\\$1')}"`;
}

/** `Ad <adres>` biçiminde bir gönderici/alıcı başlığı üretir. */
export function formatAddress(address, displayName = '') {
  const cleanAddress = sanitizeHeaderValue(address);
  const cleanName = quoteDisplayName(displayName);
  if (!cleanName) return cleanAddress;
  return `${cleanName} <${cleanAddress}>`;
}

function base64Body(value) {
  return Buffer.from(String(value ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
    .replace(/\r\n$/, '');
}

function boundaryToken(prefix) {
  return `----=_MERGENRota${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Ek adı başlık değerine yazılmadan önce sadeleştirilir. */
function calendarFilename(value) {
  const clean = sanitizeHeaderValue(value).replace(/[^A-Za-z0-9._-]/g, '');
  return clean || 'davet.ics';
}

/**
 * Takvim parçasının yöntemi. Yalnızca iki değer geçerlidir; başlık değerine
 * serbest metin yazılmaz.
 */
function calendarMethod(value) {
  return String(value ?? '').toUpperCase() === 'CANCEL' ? 'CANCEL' : 'REQUEST';
}

/**
 * Çok parçalı (HTML + düz metin) ileti gövdesini kurar.
 *
 * `calendar` verildiğinde yapı Outlook/Exchange'in beklediği biçime genişler:
 *
 *   multipart/mixed
 *     ├── multipart/alternative  (text/plain · text/html · text/calendar)
 *     └── application/ics        (aynı davet, ek olarak)
 *
 * Takvim parçası `multipart/alternative` İÇİNDEDİR: Outlook iletiyi ancak bu
 * konumda gerçek bir toplantı isteği olarak işler. Ek kopyası, davet parçasını
 * anlamayan istemciler için durur. `calendar` verilmediğinde gövde eskisi gibi
 * yalın `multipart/alternative` kalır — hatırlatma e-postaları bu yüzden
 * değişmez.
 *
 * @param {{from:string, fromName?:string, to:string[], subject:string,
 *   html:string, text:string, messageId?:string, date?:Date,
 *   calendar?:{method:'REQUEST'|'CANCEL', content:string, filename?:string}|null}} input
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
  date = new Date(),
  calendar = null
}) {
  const recipients = [...new Set(to.map((value) => sanitizeHeaderValue(value)).filter(Boolean))];
  if (!recipients.length) throw new Error('En az bir alıcı adresi gereklidir.');
  for (const address of recipients) {
    if (!isValidEmailAddress(address)) throw new Error(`Geçersiz alıcı adresi: ${address}`);
  }
  const sender = sanitizeHeaderValue(from);
  if (!isValidEmailAddress(sender)) throw new Error(`Geçersiz gönderici adresi: ${sender}`);

  const boundary = boundaryToken('');
  const method = calendar ? calendarMethod(calendar.method) : null;
  const mixedBoundary = calendar ? boundaryToken('Mixed') : null;
  const headers = [
    foldHeader('From', [formatAddress(sender, fromName)]),
    // Alıcı listesi katlanır: virgül belirtece bitişik kalır, sınır aşılınca
    // satır devam eder.
    foldHeader('To', recipients.map((address, index) => (
      index < recipients.length - 1 ? `${address},` : address
    ))),
    foldHeader('Subject', encodeHeaderWords(subject)),
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${sanitizeHeaderValue(messageId || `${Date.now()}.${Math.random().toString(36).slice(2)}@mergen-rota`)}>`,
    'MIME-Version: 1.0'
  ];
  if (calendar) {
    // Exchange bu başlığa bakarak iletiyi takvim iletisi olarak sınıflandırır.
    headers.push('Content-class: urn:content-classes:calendarmessage');
  }
  headers.push(calendar
    ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
    : `Content-Type: multipart/alternative; boundary="${boundary}"`);

  const alternative = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html)
  ];
  if (calendar) {
    alternative.push(
      `--${boundary}`,
      `Content-Type: text/calendar; charset="UTF-8"; method=${method}`,
      'Content-Transfer-Encoding: base64',
      '',
      // Base64 kodlama davetin CRLF satır sonlarını ve Türkçe karakterlerini
      // aktarım boyunca bozulmadan taşır.
      base64Body(calendar.content)
    );
  }
  alternative.push(`--${boundary}--`, '');

  if (!calendar) return `${headers.join('\r\n')}\r\n\r\n${alternative.join('\r\n')}`;

  const filename = calendarFilename(calendar.filename);
  const parts = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    ...alternative,
    `--${mixedBoundary}`,
    `Content-Type: application/ics; charset="UTF-8"; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(calendar.content),
    `--${mixedBoundary}--`,
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
