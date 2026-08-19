/**
 * Hatırlatma gönderim zincirinin sertleştirilmesi.
 *
 * İnceleme bulgularının davranış karşılıkları burada sabitlenir:
 *   1. SMTP el sıkışması — çok satırlı EHLO, mekanizma pazarlığı ve kısmen
 *      reddedilen alıcı listesi.
 *   2. MIME — uzun başlığın katlanması, encoded-word bölünmesi ve adres
 *      özel karakterlerinin tırnaklanması.
 *   3. Yapılandırma — bozuk SMTP değeri genel sunucu hatasına dönüşmez.
 *   4. İlke — pencere kırpması, sıklığın korunması ve termin gününe ayrılan
 *      aralık.
 *   5. Şablon/alıcı — temizleyicinin idempotentliği ve kapsam güvenli uyarı.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const { createSmtpDialogue, parseAuthMechanisms } = await import('../src/server/mail/smtpClient.js');
const { buildMimeMessage, encodeHeaderWords, foldHeader, formatAddress, quoteDisplayName } =
  await import('../src/server/mail/mimeMessage.js');
const { smtpConfigurationProblem } = await import('../src/server/mail/smtpConfig.js');
const { sendMail } = await import('../src/server/mail/mailService.js');
const { workerBusinessDate } = await import('../src/server/reminders/reminderStore.js');
// `server-only` taşıyan modüller shim'den SONRA yüklenmelidir; statik `import`
// bildirimleri yukarı taşındığı için bu modüller dinamik olarak alınır.
const { REMINDER_CANDIDATES_SQL } = await import('../src/server/reminders/reminderQueries.js');

import {
  describeRemainingDuration,
  describeReminderSchedule,
  evaluateReminderEligibility,
  normalizeReminderSettings
} from '../src/domain/reminders/reminderPolicy.js';
import { sanitizeReminderHtml } from '../src/domain/reminders/reminderTemplate.js';
import { resolveReminderRecipients, summarizeRecipientProblems } from '../src/domain/reminders/reminderRecipients.js';
import { buildReminderValues } from '../src/domain/reminders/reminderValues.js';

function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/* ── 1. SMTP el sıkışması ───────────────────────────────────────── */

test('çok satırlı EHLO yanıtının ARA satırları da korunur', async () => {
  // `250-AUTH PLAIN` ara satırda gelip son satır `250 SIZE` olduğunda, yalnızca
  // son satır saklanırsa sunucu hiç AUTH bildirmemiş gibi görünüyordu.
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.write = () => {};
  const dialogue = createSmtpDialogue(socket, 1000);

  const ehlo = dialogue.command('EHLO mergen-rota');
  socket.emit('data', '250-mail.example.internal\r\n250-AUTH PLAIN\r\n');
  socket.emit('data', '250 SIZE 10240000\r\n');
  const response = await ehlo;

  assert.equal(response.code, 250);
  assert.match(response.text, /AUTH PLAIN/);
  assert.equal(response.lines.length, 3);
  assert.match(response.lastLine, /SIZE/);
});

test('AUTH mekanizması yalnızca DUYURULAN yöntemlerden seçilir', () => {
  const advertisedPlain = parseAuthMechanisms('250-AUTH PLAIN\n250 SIZE 1');
  assert.equal(advertisedPlain.advertised, true);
  assert.equal(advertisedPlain.mechanisms.has('PLAIN'), true);
  assert.equal(advertisedPlain.mechanisms.has('LOGIN'), false);

  const cramOnly = parseAuthMechanisms('250 AUTH CRAM-MD5');
  assert.deepEqual([...cramOnly.mechanisms], ['CRAM-MD5']);

  // Hiç AUTH bildirmeyen sunucuda eski LOGIN yedeği korunur.
  const silent = parseAuthMechanisms('250 SIZE 10240000');
  assert.equal(silent.advertised, false);
  assert.equal(silent.mechanisms.size, 0);

  // Eski `AUTH=LOGIN` biçimi de anlaşılır.
  assert.equal(parseAuthMechanisms('250-AUTH=LOGIN').mechanisms.has('LOGIN'), true);
});

test('reddedilen tek alıcı ötekilerin iletiyi almasını engellemez', () => {
  // Sözleşme kaynak metninde sabitlenir: en az bir alıcı kabul edildiğinde
  // DATA aşamasına geçilir, hiçbiri kabul edilmezse gönderim düşer.
  const client = readSource('src/server/mail/smtpClient.js');
  assert.match(client, /const acceptedRecipients = \[\];/);
  assert.match(client, /if \(!acceptedRecipients\.length\) \{[\s\S]*?SMTP_NO_RECIPIENTS/);
  // Bağlantı ve zaman aşımı hataları alıcıya özel sayılmaz.
  assert.match(client, /if \(error instanceof SmtpError && error\.statusCode != null\) return error;/);
});

test('STARTTLS el sıkışması zaman aşımında sözü reddeder', () => {
  const client = readSource('src/server/mail/smtpClient.js');
  assert.match(client, /secure\.once\('timeout', onTimeout\)/);
  assert.match(client, /const onTimeout = \(\) => \{[\s\S]*?secure\.destroy\(\);[\s\S]*?SMTP_TIMEOUT/);
});

/* ── 2. MIME başlıkları ─────────────────────────────────────────── */

test('uzun Türkçe konu 75 sekizliği aşmayan encoded-word dizisine bölünür', () => {
  const subject = 'Görev hatırlatması · '.repeat(12);
  const words = encodeHeaderWords(subject);
  assert.ok(words.length > 1, 'uzun konu tek sözcüğe sıkıştırılmamalıdır');
  for (const word of words) {
    assert.ok(Buffer.byteLength(word, 'utf8') <= 75, `encoded-word 75 sekizliği aşmamalı: ${word.length}`);
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  }
  // Çözüldüğünde metin AYNEN geri gelir: çok baytlı karakter ikiye bölünmez.
  const decoded = words
    .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
    .join('');
  assert.equal(decoded, subject.trim());
});

test('uzun başlık ve kalabalık alıcı listesi RFC 5322 kurallarıyla katlanır', () => {
  const recipients = Array.from({ length: 12 }, (_, index) => `kullanici${index}@example.internal`);
  const message = buildMimeMessage({
    from: 'rota@example.internal',
    fromName: 'MERGEN Rota',
    to: recipients,
    subject: 'Görev hatırlatması · '.repeat(10),
    html: '<p>x</p>',
    text: 'x'
  });

  const headerBlock = message.split('\r\n\r\n')[0];
  const lines = headerBlock.split('\r\n');

  // Katlama, KULLANICI verisi taşıyan başlıklarda uygulanır: uzun konu ve
  // kalabalık alıcı listesi buradan gelir. `Content-Type` sınırı yapısaldır
  // (benzersiz sınırlayıcı) ve RFC 2231 parametre bölmesi gerektirir; bu
  // sürümün kapsamı dışındadır.
  const foldedNames = ['Subject:', 'To:', 'From:'];
  let inFolded = false;
  for (const line of lines) {
    if (!line.startsWith(' ')) inFolded = foldedNames.some((name) => line.startsWith(name));
    if (inFolded) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 78, `başlık satırı 78 sekizliği aşmamalı: ${line}`);
    }
    // RFC 5322 · 2.1.1 KATI sınırı her satır için geçerlidir.
    assert.ok(Buffer.byteLength(line, 'utf8') <= 998, `başlık satırı 998 sekizliği aşamaz: ${line}`);
  }

  // Katlanan satırlar boşlukla başlar; alıcıların tamamı iletide durur.
  assert.match(headerBlock, /\r\n /);
  for (const address of recipients) assert.ok(headerBlock.includes(address), `${address} başlıkta olmalı`);
});

test('özel karakter taşıyan ASCII görünen ad tırnaklanır', () => {
  assert.equal(quoteDisplayName('MERGEN Rota, PMO'), '"MERGEN Rota, PMO"');
  assert.equal(formatAddress('a@b.com', 'MERGEN Rota, PMO'), '"MERGEN Rota, PMO" <a@b.com>');
  // Tırnak ve ters bölü kaçırılır.
  assert.equal(quoteDisplayName('Ad "takma" Soyad'), '"Ad \\"takma\\" Soyad"');
  // Güvenli atom dokunulmadan geçer.
  assert.equal(quoteDisplayName('MERGEN Rota'), 'MERGEN Rota');
});

test('başlık katlama belirteçleri bölmez', () => {
  const folded = foldHeader('To', ['bir@example.internal,', 'iki@example.internal']);
  assert.equal(folded.split('\r\n')[0].startsWith('To: '), true);
  assert.ok(folded.includes('bir@example.internal,'));
  assert.ok(folded.includes('iki@example.internal'));
});

/* ── 3. SMTP yapılandırması ─────────────────────────────────────── */

test('bozuk SMTP yapılandırması genel sunucu hatasına dönüşmez', async () => {
  const previous = { ...process.env };
  process.env.SMTP_HOST = 'mail.example.internal';
  process.env.SMTP_FROM = 'rota@example.internal';
  process.env.SMTP_PORT = 'seksenyedi';
  try {
    assert.equal(smtpConfigurationProblem(), 'SMTP_CONFIG_INVALID');
    const result = await sendMail({ to: ['a@b.com'], subject: 'K', html: '', text: '' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SMTP_CONFIG_INVALID');
    // Ortam değişkeninin İÇERİĞİ hata iletisine taşınmaz.
    assert.equal(result.message.includes('seksenyedi'), false);
  } finally {
    for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_PORT']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

/* ── 4. Hatırlatma ilkesi ───────────────────────────────────────── */

test('pencere değeri motorun kullandığı sınırla AYNI yerde kırpılır', () => {
  const settings = normalizeReminderSettings({ automaticEnabled: true, windowValue: 730, windowUnit: 'day' });
  // Kaydedilen ve gösterilen değer, motorun kullandığı süreyle uyumludur.
  assert.equal(settings.windowValue, 365);
  assert.equal(settings.windowMinutes, 365 * 1440);
  assert.match(describeReminderSchedule(settings), /termine 365 gün kala/);

  const hours = normalizeReminderSettings({ automaticEnabled: true, windowValue: 100000, windowUnit: 'hour' });
  assert.equal(hours.windowValue, 365 * 24);
});

test('pencereden uzun sıklık SESSİZCE kısaltılmaz', () => {
  const settings = normalizeReminderSettings({
    automaticEnabled: true,
    windowValue: 7,
    windowUnit: 'day',
    frequencyValue: 30,
    frequencyUnit: 'day'
  });
  // Yöneticinin gördüğü değerle motorun kullandığı değer aynıdır.
  assert.equal(settings.frequencyMinutes, 30 * 1440);
  assert.match(describeReminderSchedule(settings), /tek hatırlatma gönderilir/);

  // Pencere içinde tek aralık üretilir: hem giriş gününde hem sınırda ileti gitmez.
  const task = { id: 't', status: 'planned', targetFinish: '2026-08-20' };
  const entry = evaluateReminderEligibility(task, settings, new Date(2026, 7, 13, 0));
  const later = evaluateReminderEligibility(task, settings, new Date(2026, 7, 18, 9));
  assert.equal(entry.slotIndex, 0);
  assert.equal(later.slotIndex, 0);
  assert.equal(entry.slotKey, later.slotKey);
});

test('termin gününe AYRI bir hatırlatma aralığı ayrılır', () => {
  const settings = { automaticEnabled: true, windowValue: 7, windowUnit: 'day', frequencyValue: 2, frequencyUnit: 'day' };
  const task = { id: 't', status: 'planned', targetFinish: '2026-08-20' };

  const lastNumbered = evaluateReminderEligibility(task, settings, new Date(2026, 7, 19, 0));
  const dueMidnight = evaluateReminderEligibility(task, settings, new Date(2026, 7, 20, 0));
  const dueNoon = evaluateReminderEligibility(task, settings, new Date(2026, 7, 20, 12));

  assert.equal(dueMidnight.eligible, true);
  // Termin gününün gece yarısından SONRAKİ turu da uygundur.
  assert.equal(dueNoon.eligible, true, 'termin günü öğlen çalışan tur da hatırlatma göndermelidir');
  assert.equal(dueNoon.dueDay, true);
  // Aralık, son sayısal aralıktan AYRIDIR: benzersiz kısıt son iletiyi susturmaz.
  assert.notEqual(dueMidnight.slotKey, lastNumbered.slotKey);
  assert.equal(dueMidnight.slotKey, dueNoon.slotKey);
  assert.match(dueMidnight.slotKey, /\|sdue$/);

  // Termin GÜNÜ geçtikten sonra durur.
  const afterDue = evaluateReminderEligibility(task, settings, new Date(2026, 7, 21, 0));
  assert.equal(afterDue.eligible, false);
  assert.equal(afterDue.reason, 'PAST_DUE');
});

test('termin GÜNÜNDEKİ görev gecikmiş olarak anlatılmaz', () => {
  const values = buildReminderValues(
    { task: 'İş', targetFinish: '2026-08-20', status: 'in-progress' },
    { now: new Date(2026, 7, 20, 12) }
  );
  assert.equal(values.remaining_days, '0');
  assert.equal(values.remaining_duration, 'bugün son gün');

  // Gecikme TAKVİM GÜNÜYLE ölçülür: ertesi günün öğleni bir gün gecikmedir.
  const late = buildReminderValues(
    { task: 'İş', targetFinish: '2026-08-20', status: 'in-progress' },
    { now: new Date(2026, 7, 21, 12) }
  );
  assert.equal(late.remaining_duration, '1 gün geçti');
  assert.equal(describeRemainingDuration(-540), 'bugün son gün');
});

/* ── 5. Şablon ve alıcı ─────────────────────────────────────────── */

test('HTML temizleyicisi IDEMPOTENTTİR', () => {
  // Zengin metin düzenleyicisi `innerHTML` verdiği için metin zaten kodlanmış
  // gelir; her geçişte yeniden kodlanırsa önizleme ham `&amp;` gösterirdi.
  const once = sanitizeReminderHtml('<p>A &amp; B &lt;kod&gt; & ham</p>');
  assert.equal(sanitizeReminderHtml(once), once);
  assert.equal(sanitizeReminderHtml(sanitizeReminderHtml(once)), once);
  assert.equal(once.includes('&amp;amp;'), false);
  // Kodlanmış tehlikeli şema çözülüp REDDEDİLİR.
  assert.equal(sanitizeReminderHtml('<a href="&#106;avascript:alert(1)">x</a>'), '<a>x</a>');
});

test('alıcı uyarıları kapsam dışı sorumlunun KİMLİĞİNİ taşımaz', () => {
  const { problems } = resolveReminderRecipients([
    { sicil: '900001', name: 'Ayşe Yılmaz', username: 'ayilmaz', email: 'ayse@example.internal' },
    { sicil: '900002', name: 'Gizli Personel', username: 'gizli', email: '' }
  ]);
  const warnings = summarizeRecipientProblems(problems);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^1 sorumlunun/);
  for (const warning of warnings) {
    assert.equal(warning.includes('Gizli Personel'), false, 'ad uyarıya taşınmamalıdır');
    assert.equal(warning.includes('gizli'), false, 'kullanıcı adı uyarıya taşınmamalıdır');
  }
});

/* ── 6. Aday sorgusu ────────────────────────────────────────────── */

test('aday ön elemesi İŞÇİ saatini kullanır', () => {
  // `SYSDATETIME()` kullanıldığında ön eleme veritabanı sunucusunun, uygunluk
  // kararı ise Node sürecinin saatine göre veriliyordu.
  assert.equal(REMINDER_CANDIDATES_SQL.includes('SYSDATETIME()'), false);
  assert.match(REMINDER_CANDIDATES_SQL, /t\.TargetFinish >= @today/);
  assert.match(REMINDER_CANDIDATES_SQL, /DATEADD\(day, @horizonDays, @today\)/);
  assert.equal(workerBusinessDate(new Date(2026, 7, 9, 23, 30)), '2026-08-09');
});
