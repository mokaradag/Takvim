import 'server-only';
import net from 'node:net';
import tls from 'node:tls';
import { buildMimeMessage, dotStuff, isValidEmailAddress } from './mimeMessage.js';

/**
 * Küçük, bağımlılıksız SMTP istemcisi.
 *
 * Akış, üretimde çalıştığı doğrulanmış Python (`smtplib`) uygulamasının
 * davranışını birebir yeniden üretir:
 *
 *   EHLO → STARTTLS → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT
 *
 * Uygulama Next.js/Node üzerinde çalıştığı için yalnızca e-posta göndermek
 * amacıyla Python çalışma zamanı taşımak gerekmez; aynı protokol Node'un
 * `net`/`tls` modülleriyle konuşulur ve yeni bir paket bağımlılığı eklenmez.
 *
 * Hata yönetimi açıktır: bağlantı, kimlik doğrulama ve gönderim hataları ayrı
 * kodlarla döner. Parola hiçbir hata iletisine ya da günlüğe yazılmaz.
 */

/** AUTH PLAIN ayracı (RFC 4616): kullanıcı ve parola NUL ile ayrılır. */
const NUL = String.fromCharCode(0);

export class SmtpError extends Error {
  constructor(code, message, { statusCode = null, cause = null } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

export function createSmtpDialogue(socket, timeoutMs) {
  let buffer = '';
  const waiters = [];

  const flush = () => {
    // Yanıt satırları CRLF ile gelir; çok satırlı yanıtta ara satırlar
    // `250-...`, son satır `250 ...` biçimindedir.
    let index = buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const match = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (match && match[2] !== '-') {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve({ code: Number(match[1]), text: line });
      }
      index = buffer.indexOf('\r\n');
    }
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { buffer += chunk; flush(); });
  socket.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  socket.on('close', () => {
    while (waiters.length) {
      waiters.shift().reject(new SmtpError('SMTP_CONNECTION_FAILED', 'SMTP bağlantısı beklenmedik biçimde kapandı.'));
    }
  });

  const read = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SmtpError('SMTP_TIMEOUT', 'SMTP sunucusu zamanında yanıt vermedi.'));
    }, timeoutMs);
    waiters.push({
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
  });

  return {
    read,
    async command(line, { expect = [250], code = 'SMTP_SEND_FAILED', description = 'SMTP komutu' } = {}) {
      socket.write(`${line}\r\n`);
      const response = await read();
      if (!expect.includes(response.code)) {
        throw new SmtpError(code, `${description} reddedildi (${response.code}).`, { statusCode: response.code });
      }
      return response;
    }
  };
}

function connect({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    const fail = (error) => {
      socket.destroy();
      reject(new SmtpError('SMTP_CONNECTION_FAILED', `SMTP sunucusuna bağlanılamadı (${host}:${port}).`, { cause: error }));
    };
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('timeout')));
    socket.once('connect', () => {
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function upgradeToTls(socket, { host, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized }, () => {
      secure.setTimeout(0);
      resolve(secure);
    });
    secure.setTimeout(timeoutMs);
    secure.once('error', (error) => {
      reject(new SmtpError('SMTP_TLS_FAILED', 'STARTTLS el sıkışması tamamlanamadı.', { cause: error }));
    });
  });
}

/** AUTH PLAIN belirteci: NUL + kullanıcı + NUL + parola (RFC 4616). */
export function authPlainToken(username, password) {
  return Buffer.from(`${NUL}${username}${NUL}${password}`, 'utf8').toString('base64');
}

async function authenticate(dialogue, capabilities, { username, password }) {
  if (!username) return;
  const mechanisms = String(capabilities || '').toUpperCase();
  // Sunucu yeteneklerini bildirmiyorsa da LOGIN denenir: Python karşılığı da
  // aynı sırayla çalışıyor ve kurumsal sunucuda kabul ediliyor.
  if (!mechanisms.includes('AUTH') || mechanisms.includes('LOGIN')) {
    await dialogue.command('AUTH LOGIN', { expect: [334], code: 'SMTP_AUTH_FAILED', description: 'AUTH LOGIN' });
    await dialogue.command(Buffer.from(username, 'utf8').toString('base64'), {
      expect: [334], code: 'SMTP_AUTH_FAILED', description: 'Kullanıcı adı'
    });
    await dialogue.command(Buffer.from(password, 'utf8').toString('base64'), {
      expect: [235], code: 'SMTP_AUTH_FAILED', description: 'Kimlik doğrulama'
    });
    return;
  }
  await dialogue.command(`AUTH PLAIN ${authPlainToken(username, password)}`, {
    expect: [235], code: 'SMTP_AUTH_FAILED', description: 'Kimlik doğrulama'
  });
}

/**
 * Tek bir iletiyi gönderir.
 *
 * @param {object} config `getSmtpConfig()` çıktısı
 * @param {{to:string[], subject:string, html:string, text:string}} message
 * @returns {Promise<{accepted:string[], messageId:string}>}
 *   Söz YALNIZCA sunucu iletiyi kabul ettiğinde çözülür; aksi hâlde `SmtpError`
 *   fırlatılır. Böylece "gönderildi" bilgisi hiçbir zaman uydurulmaz.
 */
export async function sendSmtpMail(config, message) {
  const recipients = [...new Set((message.to || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!recipients.length) throw new SmtpError('SMTP_NO_RECIPIENTS', 'Gönderilecek alıcı adresi yok.');
  for (const address of recipients) {
    if (!isValidEmailAddress(address)) throw new SmtpError('SMTP_INVALID_RECIPIENT', `Geçersiz alıcı adresi: ${address}`);
  }

  const messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@mergen-rota`;
  const mime = buildMimeMessage({
    from: config.from,
    fromName: config.fromName,
    to: recipients,
    subject: message.subject,
    html: message.html,
    text: message.text,
    messageId
  });

  let socket = await connect(config);
  let dialogue = createSmtpDialogue(socket, config.timeoutMs);
  try {
    const greeting = await dialogue.read();
    if (greeting.code !== 220) {
      throw new SmtpError(
        'SMTP_CONNECTION_FAILED',
        `SMTP sunucusu bağlantıyı kabul etmedi (${greeting.code}).`,
        { statusCode: greeting.code }
      );
    }

    let ehlo = await dialogue.command('EHLO mergen-rota', { description: 'EHLO' });
    if (config.useStartTls) {
      await dialogue.command('STARTTLS', { expect: [220], code: 'SMTP_TLS_FAILED', description: 'STARTTLS' });
      const secure = await upgradeToTls(socket, config);
      socket = secure;
      dialogue = createSmtpDialogue(secure, config.timeoutMs);
      // TLS sonrası EHLO TEKRARLANIR: yetenek listesi şifreli oturumda yeniden
      // bildirilir ve AUTH çoğu sunucuda ancak burada duyurulur.
      ehlo = await dialogue.command('EHLO mergen-rota', { description: 'EHLO (TLS sonrası)' });
    }

    await authenticate(dialogue, ehlo.text, config);
    await dialogue.command(`MAIL FROM:<${config.from}>`, { description: 'MAIL FROM' });
    for (const address of recipients) {
      await dialogue.command(`RCPT TO:<${address}>`, { expect: [250, 251], description: `RCPT TO ${address}` });
    }
    await dialogue.command('DATA', { expect: [354], description: 'DATA' });
    socket.write(`${dotStuff(mime)}\r\n.\r\n`);
    const accepted = await dialogue.read();
    if (accepted.code !== 250) {
      throw new SmtpError('SMTP_SEND_FAILED', `Sunucu iletiyi kabul etmedi (${accepted.code}).`, { statusCode: accepted.code });
    }
    await dialogue.command('QUIT', { expect: [221], description: 'QUIT' }).catch(() => null);
    return { accepted: recipients, messageId };
  } finally {
    // Bağlantı her koşulda serbest bırakılır.
    socket.destroy();
  }
}
