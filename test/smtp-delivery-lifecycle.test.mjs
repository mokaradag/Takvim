import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
registerServerOnlyShim();
const { sendSmtpMail } = await import('../src/server/mail/smtpClient.js');

async function withSmtpServer(mode, run) {
  const sockets = new Set();
  const commands = [];
  const postStartTlsChunks = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let data = false;
    if (mode !== 'stallGreeting') setImmediate(() => socket.write('220 test SMTP\r\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let split;
      while ((split = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (data) {
          if (line !== '.') continue;
          data = false;
          if (mode === 'disconnectAfterData') { socket.destroy(); return; }
          socket.write(mode === 'rejectData' ? '554 rejected\r\n' : '250 queued\r\n');
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250 test\r\n');
        else if (line === 'STARTTLS') {
          socket.write('220 start TLS\r\n');
          socket.removeAllListeners('data');
          socket.on('data', (rawChunk) => {
            postStartTlsChunks.push(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));
          });
          return;
        }
        else if (line.startsWith('MAIL FROM')) socket.write('250 sender\r\n');
        else if (line.startsWith('RCPT TO')) socket.write(mode === 'rejectRecipient' ? '550 no mailbox\r\n' : '250 recipient\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({ config: {
      host: '127.0.0.1', port: server.address().port, timeoutMs: 20000,
      from: 'sender@example.internal', fromName: 'MERGEN', useStartTls: mode === 'stallTls',
      rejectUnauthorized: false, username: '', password: ''
    }, commands, postStartTlsChunks });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
const message = { to: ['user@example.internal'], subject: 'Takvim', text: 'Görev' };

for (const [mode, uncertain] of [['rejectRecipient', false], ['rejectData', false], ['disconnectAfterData', true]]) {
  test(`SMTP ${mode} sonucunda teslimat belirsizliği doğru taşınır`, async () => {
    await withSmtpServer(mode, async ({ config }) => {
      await assert.rejects(sendSmtpMail(config, message), (error) => error.deliveryMayHaveEscaped === uncertain);
    });
  });
}

for (const mode of ['stallGreeting', 'stallTls']) {
  test(`SMTP ${mode} süre sınırında bağlantıyı kapatır`, async () => {
    await withSmtpServer(mode, async ({ config, commands, postStartTlsChunks }) => {
      const expectedCode = mode === 'stallTls' ? 'SMTP_TIMEOUT' : 'SMTP_CONNECTION_FAILED';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 75);
      const started = Date.now();
      try {
        await assert.rejects(sendSmtpMail(config, { ...message, signal: controller.signal }),
          (error) => error.deliveryMayHaveEscaped === false && error.code === expectedCode);
        assert.ok(Date.now() - started < 1000);
        if (mode === 'stallTls') {
          const postStartTls = Buffer.concat(postStartTlsChunks).toString('latin1');
          assert.equal(/(?:^|\r\n)MAIL FROM:<[^>]+>\r\n/.test(postStartTls), false);
        } else {
          assert.ok(!commands.some((line) => line.startsWith('MAIL FROM')));
        }
      } finally { clearTimeout(timer); }
    });
  });
}

test('SMTP kabul edilen iletiyi başarı olarak bildirir', async () => {
  await withSmtpServer('success', async ({ config }) => {
    const result = await sendSmtpMail(config, message);
    assert.deepEqual(result.accepted, message.to);
  });
});
test('SMTP replies reject oversized unterminated and multiline input before unbounded buffering', async () => {
  const { EventEmitter } = await import('node:events');
  const { createSmtpDialogue, SMTP_REPLY_LIMITS } = await import('../src/server/mail/smtpClient.js');
  for (const multiline of [false, true]) {
    const socket = new EventEmitter(); let destroyed = false; socket.setEncoding = () => {}; socket.destroy = () => { destroyed = true; };
    const dialogue = createSmtpDialogue(socket, 1000), rejected = assert.rejects(dialogue.read(), error => error.code === 'SMTP_SEND_FAILED');
    const chunk = multiline ? '250-x\r\n' : 'x', bound = multiline ? SMTP_REPLY_LIMITS.maxResponseBytes : SMTP_REPLY_LIMITS.maxLineBytes;
    for (let bytes = 0; bytes <= bound && !destroyed; bytes += chunk.length) socket.emit('data', chunk);
    await rejected; assert.equal(destroyed, true); await assert.rejects(dialogue.read(), error => error.code === 'SMTP_SEND_FAILED'); dialogue.dispose();
  }
});

test('SMTP multiline replies survive every TCP split, including CRLF and UTF-8 fragments', async () => {
  const { EventEmitter } = await import('node:events');
  const { createSmtpDialogue } = await import('../src/server/mail/smtpClient.js');
  const reply = '250-test\r\n250-AUTH PLAIN LOGIN\r\n250 sıra\r\n';
  for (let split = 0; split <= reply.length; split += 1) {
    const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.destroy = () => {};
    const dialogue = createSmtpDialogue(socket, 1000), waiting = dialogue.read();
    for (const chunk of [reply.slice(0, split), reply.slice(split)]) socket.emit('data', chunk);
    const response = await waiting; assert.equal(response.code, 250); assert.deepEqual(response.lines, ['250-test', '250-AUTH PLAIN LOGIN', '250 sıra']); dialogue.dispose();
  }
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.destroy = () => {};
  const dialogue = createSmtpDialogue(socket, 1000), waiting = dialogue.read();
  for (const character of reply) socket.emit('data', character);
  assert.equal((await waiting).lastLine, '250 sıra'); dialogue.dispose();
});
