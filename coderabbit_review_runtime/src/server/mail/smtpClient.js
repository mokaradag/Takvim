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
  // Çok satırlı yanıtın biriken satırları: ARA satırlar da yetenek taşır ve
  // atılırsa AUTH duyurusu görünmez olur.
  let pending = [];
  const waiters = [];

  const flush = () => {
    // Yanıt satırları CRLF ile gelir; çok satırlı yanıtta ara satırlar
    // `250-...`, son satır `250 ...` biçimindedir.
    let index = buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const match = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (match) {
        pending.push(line);
        if (match[2] !== '-') {
          const lines = pending;
          pending = [];
          const waiter = waiters.shift();
          // `text` yanıtın TAMAMIDIR; `lastLine` yalnızca kapanış satırı.
          if (waiter) waiter.resolve({ code: Number(match[1]), text: lines.join('\n'), lines, lastLine: line });
        }
      }
      index = buffer.indexOf('\r\n');
    }
  };

  const onData = (chunk) => { buffer += chunk; flush(); };
  const onError = (error) => {
    while (waiters.length) waiters.shift().reject(error);
  };
  const onClose = () => {
    while (waiters.length) {
      waiters.shift().reject(new SmtpError('SMTP_CONNECTION_FAILED', 'SMTP bağlantısı beklenmedik biçimde kapandı.'));
    }
  };

  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  const read = () => new Promise((resolve, reject) => {
    // Zaman aşımına uğrayan bekleyici KUYRUKTAN DÜŞÜRÜLÜR. Ölü kayıt kuyrukta
    // kalınca sunucunun bir sonraki satırı ona teslim ediliyor ve bundan sonraki
    // bütün yanıtlar bir kayıyordu: zaman aşımından sonra devam eden çağıran
    // yanlış durum kodunu okuyordu.
    const entry = {};
    const timer = setTimeout(() => {
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      reject(new SmtpError('SMTP_TIMEOUT', 'SMTP sunucusu zamanında yanıt vermedi.'));
    }, timeoutMs);
    entry.resolve = (value) => { clearTimeout(timer); resolve(value); };
    entry.reject = (error) => { clearTimeout(timer); reject(error); };
    waiters.push(entry);
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
    },
    /**
     * Dinleyicileri SÖKER ve bekleyenleri düşürür.
     *
     * STARTTLS yükseltmesinde alttaki yuva `tls.connect({ socket })` ile
     * sarılır. Düz oturumun `data` dinleyicisi ve `utf8` kodlaması yuvada
     * kalırsa el sıkışma baytları eski konuşmaya da akar; yükseltmeden önce
     * konuşma kapatılmalıdır.
     */
    dispose() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      while (waiters.length) {
        waiters.shift().reject(new SmtpError('SMTP_CONNECTION_FAILED', 'SMTP oturumu yükseltildi.'));
      }
      buffer = '';
      pending = [];
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
    let settled = false;
    // STARTTLS'i kabul edip el sıkışmasında duran sunucu, zaman aşımı
    // bağlanmadığında `sendSmtpMail`i süresiz askıda bırakıyordu; otomatik tur
    // sıralı çalıştığı için tek bağlantı bütün turu dondurabiliyordu.
    const cleanup = () => {
      settled = true;
      secure.removeListener('error', onError);
      secure.removeListener('timeout', onTimeout);
    };
    const onError = (error) => {
      if (settled) return;
      cleanup();
      secure.destroy();
      reject(new SmtpError('SMTP_TLS_FAILED', 'STARTTLS el sıkışması tamamlanamadı.', { cause: error }));
    };
    const onTimeout = () => {
      if (settled) return;
      cleanup();
      secure.destroy();
      reject(new SmtpError('SMTP_TIMEOUT', 'STARTTLS el sıkışması zamanında tamamlanmadı.'));
    };
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized }, () => {
      if (settled) return;
      cleanup();
      secure.setTimeout(0);
      resolve(secure);
    });
    secure.setTimeout(timeoutMs);
    secure.once('error', onError);
    secure.once('timeout', onTimeout);
  });
}

/** AUTH PLAIN belirteci: NUL + kullanıcı + NUL + parola (RFC 4616). */
export function authPlainToken(username, password) {
  return Buffer.from(`${NUL}${username}${NUL}${password}`, 'utf8').toString('base64');
}

/**
 * EHLO yanıtından AUTH mekanizmalarını çıkarır (RFC 4954).
 *
 * `advertised`, sunucunun AUTH satırı bildirip bildirmediğini ayırır: hiç
 * bildirmeyen sunucuda eski LOGIN yedeği korunur, bildiren sunucuda ise
 * yalnızca duyurulan mekanizma denenir.
 */
export function parseAuthMechanisms(capabilities) {
  const mechanisms = new Set();
  let advertised = false;
  for (const rawLine of String(capabilities || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    // `250-AUTH LOGIN PLAIN` ve eski `250-AUTH=LOGIN` biçimleri.
    const match = /^(?:\d{3}[ -]?)?AUTH(?:[ =]+(.*))?$/i.exec(line);
    if (!match) continue;
    advertised = true;
    for (const token of String(match[1] || '').split(/[\s,]+/)) {
      if (token) mechanisms.add(token.toUpperCase());
    }
  }
  return { advertised, mechanisms };
}

/**
 * Kimlik doğrulama.
 *
 * ŞİFRESİZ kanalda kimlik bilgisi GÖNDERİLMEZ. `AUTH LOGIN`/`AUTH PLAIN`
 * kullanıcı adını ve parolayı base64 ile taşır; base64 şifreleme değildir.
 * `SMTP_USE_STARTTLS=false` yapıldığında bunlar düz TCP üzerinden gidiyordu.
 * Şifresiz kanalda kimlik doğrulama ancak `SMTP_ALLOW_INSECURE_AUTH=true` ile
 * açıkça izin verildiğinde denenir.
 */
async function authenticate(dialogue, capabilities, { username, password, secureChannel, allowInsecureAuth }) {
  if (!username) return;
  if (!secureChannel && !allowInsecureAuth) {
    throw new SmtpError(
      'SMTP_INSECURE_AUTH',
      'Şifrelenmemiş SMTP bağlantısında kimlik doğrulama yapılmaz. STARTTLS açın '
      + 'ya da bilinçli olarak SMTP_ALLOW_INSECURE_AUTH=true tanımlayın.'
    );
  }
  const { advertised, mechanisms } = parseAuthMechanisms(capabilities);
  // Sunucu yeteneklerini hiç bildirmiyorsa da LOGIN denenir: Python karşılığı
  // da aynı sırayla çalışıyor ve kurumsal sunucuda kabul ediliyor.
  if (!advertised || mechanisms.has('LOGIN')) {
    await dialogue.command('AUTH LOGIN', { expect: [334], code: 'SMTP_AUTH_FAILED', description: 'AUTH LOGIN' });
    await dialogue.command(Buffer.from(username, 'utf8').toString('base64'), {
      expect: [334], code: 'SMTP_AUTH_FAILED', description: 'Kullanıcı adı'
    });
    await dialogue.command(Buffer.from(password, 'utf8').toString('base64'), {
      expect: [235], code: 'SMTP_AUTH_FAILED', description: 'Kimlik doğrulama'
    });
    return;
  }
  if (mechanisms.has('PLAIN')) {
    await dialogue.command(`AUTH PLAIN ${authPlainToken(username, password)}`, {
      expect: [235], code: 'SMTP_AUTH_FAILED', description: 'Kimlik doğrulama'
    });
    return;
  }
  // Duyurulmayan bir mekanizmayı denemek yerine açık hata verilir: sunucu
  // CRAM-MD5 gibi başka bir yöntem istiyorsa bu açıkça görünür.
  throw new SmtpError(
    'SMTP_AUTH_UNSUPPORTED',
    `Sunucu desteklenen bir kimlik doğrulama yöntemi bildirmedi (${[...mechanisms].join(', ') || 'yok'}).`
  );
}

/**
 * Tek bir iletiyi gönderir.
 *
 * @param {object} config `getSmtpConfig()` çıktısı
 * @param {{to:string[], subject:string, html:string, text:string}} message
 * @returns {Promise<{accepted:string[],
 *   rejected:{address:string, statusCode:number|null}[], messageId:string}>}
 *   Söz YALNIZCA sunucu iletiyi kabul ettiğinde çözülür; aksi hâlde `SmtpError`
 *   fırlatılır. Böylece "gönderildi" bilgisi hiçbir zaman uydurulmaz.
 *   `rejected`, kabul edilen en az bir alıcı varken düşen kutuları taşır.
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
      // Düz oturum yükseltmeden ÖNCE kapatılır (bkz. dialogue.dispose).
      dialogue.dispose();
      const secure = await upgradeToTls(socket, config);
      socket = secure;
      dialogue = createSmtpDialogue(secure, config.timeoutMs);
      // TLS sonrası EHLO TEKRARLANIR: yetenek listesi şifreli oturumda yeniden
      // bildirilir ve AUTH çoğu sunucuda ancak burada duyurulur.
      ehlo = await dialogue.command('EHLO mergen-rota', { description: 'EHLO (TLS sonrası)' });
    }

    await authenticate(dialogue, ehlo.text, {
      username: config.username,
      password: config.password,
      secureChannel: Boolean(config.useStartTls),
      allowInsecureAuth: Boolean(config.allowInsecureAuth)
    });
    await dialogue.command(`MAIL FROM:<${config.from}>`, { description: 'MAIL FROM' });
    // Alıcı çözümü kısmi sorunlarla sürdüğü gibi SMTP de sürer: kapatılmış tek
    // bir kutu, öteki sorumluların hatırlatmayı almasını engellemez.
    const acceptedRecipients = [];
    const rejectedRecipients = [];
    for (const address of recipients) {
      const outcome = await dialogue
        .command(`RCPT TO:<${address}>`, { expect: [250, 251], description: `RCPT TO ${address}` })
        .catch((error) => {
          // Yalnızca sunucunun DURUM KODUYLA reddi alıcıya özeldir; bağlantı ve
          // zaman aşımı hataları bütün gönderimi düşürmeye devam eder.
          if (error instanceof SmtpError && error.statusCode != null) return error;
          throw error;
        });
      if (outcome instanceof SmtpError) rejectedRecipients.push({ address, statusCode: outcome.statusCode });
      else acceptedRecipients.push(address);
    }
    if (!acceptedRecipients.length) {
      throw new SmtpError('SMTP_NO_RECIPIENTS', 'Sunucu hiçbir alıcı adresini kabul etmedi.', {
        statusCode: rejectedRecipients[0]?.statusCode ?? null
      });
    }
    await dialogue.command('DATA', { expect: [354], description: 'DATA' });
    socket.write(`${dotStuff(mime)}\r\n.\r\n`);
    const accepted = await dialogue.read();
    if (accepted.code !== 250) {
      throw new SmtpError('SMTP_SEND_FAILED', `Sunucu iletiyi kabul etmedi (${accepted.code}).`, { statusCode: accepted.code });
    }
    await dialogue.command('QUIT', { expect: [221], description: 'QUIT' }).catch(() => null);
    return { accepted: acceptedRecipients, rejected: rejectedRecipients, messageId };
  } finally {
    // Bağlantı her koşulda serbest bırakılır.
    socket.destroy();
  }
}
