/**
 * Görev hatırlatma e-postaları.
 *
 * Kapsanan sözleşmeler:
 *   1. Alıcılar HR02 kullanıcı adı üzerinden `DC01_userr.EmailAddress` ile
 *      çözülür; eksik/boş/bozuk adresler ve yinelenen kayıtlar sessizce
 *      kaybolmaz.
 *   2. Şablon yer tutucuları sunucuda, KAÇIRILARAK yerleştirilir; yönetici
 *      HTML'i kapalı bir etiket kümesine indirgenir.
 *   3. Otomatik gönderim penceresi, sıklığı ve durma koşulları determinist
 *      biçimde hesaplanır; aynı aralık için ikinci ileti gönderilmez.
 *   4. SMTP başarısızlığı "gönderildi" olarak raporlanmaz ve tek bir görevin
 *      hatası turu düşürmez.
 *   5. Yapılandırma yalnızca sistem yöneticisine açıktır ve kimlik bilgileri
 *      hiçbir yanıtta yer almaz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const { buildMimeMessage, dotStuff, encodeHeaderValue, formatAddress, sanitizeHeaderValue } =
  await import('../src/server/mail/mimeMessage.js');
const { authPlainToken, createSmtpDialogue } = await import('../src/server/mail/smtpClient.js');

import {
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
  MISSING_VALUE_MARK,
  REMINDER_PLACEHOLDER_KEYS,
  applyReminderPlaceholders,
  htmlToPlainText,
  renderReminderEmail,
  sanitizeReminderHtml
} from '../src/domain/reminders/reminderTemplate.js';
import {
  DEFAULT_REMINDER_SETTINGS,
  describeRemainingDuration,
  describeReminderSchedule,
  evaluateReminderEligibility,
  isClosedTaskStatus,
  normalizeReminderSettings,
  selectDueReminders
} from '../src/domain/reminders/reminderPolicy.js';
import { resolveReminderRecipients, describeRecipientProblems } from '../src/domain/reminders/reminderRecipients.js';
import { buildReminderValues } from '../src/domain/reminders/reminderValues.js';
import { isValidEmailAddress } from '../src/domain/reminders/emailAddress.js';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/* ── 1. Alıcı çözümü ────────────────────────────────────────────── */

test('tek sorumlu DC01_userr adresine çözülür', () => {
  const { recipients, resolved, problems } = resolveReminderRecipients([
    { sicil: '900001', name: 'Ayşe Yılmaz', username: 'ayilmaz', email: 'ayse.yilmaz@example.internal' }
  ]);
  assert.deepEqual(recipients, ['ayse.yilmaz@example.internal']);
  assert.equal(resolved.length, 1);
  assert.deepEqual(problems, []);
});

test('birden çok sorumlu ayrı ayrı çözülür', () => {
  const { recipients } = resolveReminderRecipients([
    { sicil: '1', name: 'A', username: 'a', email: 'a@example.internal' },
    { sicil: '2', name: 'B', username: 'b', email: 'b@example.internal' }
  ]);
  assert.deepEqual(recipients, ['a@example.internal', 'b@example.internal']);
});

test('DC01_userr kaydı olmayan sorumlu açıklanabilir bir sorun üretir', () => {
  const { recipients, problems } = resolveReminderRecipients([
    { sicil: '3', name: 'Kayıtsız Kişi', username: '', email: '' }
  ]);
  assert.deepEqual(recipients, []);
  assert.equal(problems[0].code, 'NO_USERNAME');
  assert.match(describeRecipientProblems(problems), /kurumsal kullanıcı adı tanımlı değil/);
});

test('boş ve bozuk e-posta adresleri gönderime girmez', () => {
  const { recipients, problems } = resolveReminderRecipients([
    { sicil: '4', name: 'Boş Adres', username: 'bos', email: '   ' },
    { sicil: '5', name: 'Bozuk Adres', username: 'bozuk', email: 'bozuk-adres' },
    { sicil: '6', name: 'Enjeksiyon', username: 'enj', email: 'a@b.com, x@y.com' }
  ]);
  assert.deepEqual(recipients, []);
  assert.deepEqual(problems.map((problem) => problem.code), ['NO_EMAIL', 'INVALID_EMAIL', 'INVALID_EMAIL']);
});

test('yinelenen sorumlu ve yinelenen adres tek kez gönderilir', () => {
  const { recipients, resolved } = resolveReminderRecipients([
    { sicil: '7', name: 'Aynı Kişi', username: 'ayni', email: 'ayni@example.internal' },
    // Aynı sorumlu göreve iki kez bağlanmış.
    { sicil: '7', name: 'Aynı Kişi', username: 'ayni', email: 'ayni@example.internal' },
    // Farklı kişi, PAYLAŞILAN posta kutusu.
    { sicil: '8', name: 'Paylaşan', username: 'paylasan', email: 'AYNI@example.internal' }
  ]);
  assert.deepEqual(recipients, ['ayni@example.internal']);
  assert.equal(resolved.filter((entry) => entry.duplicate).length, 1);
});

test('adres doğrulaması başlık enjeksiyonuna kapalıdır', () => {
  assert.equal(isValidEmailAddress('a@b.com'), true);
  assert.equal(isValidEmailAddress('a@b'), false);
  assert.equal(isValidEmailAddress('a b@c.com'), false);
  assert.equal(isValidEmailAddress('a@b.com\r\nBcc: x@y.com'), false);
  assert.equal(isValidEmailAddress(''), false);
});

/* ── 2. Şablon ve yer tutucular ─────────────────────────────────── */

const TASK = Object.freeze({
  task: 'Teklif dosyasının hazırlanması',
  projectName: 'İHA Projesi',
  projectCode: 'P4417041',
  description: 'Teknik şartname eklenecek.',
  keyword: 'Teklif',
  status: 'in-progress',
  priority: 'high',
  targetFinish: '2026-08-20'
});

test('varsayılan şablon gerçek görev değerleriyle üretilir', () => {
  const values = buildReminderValues(TASK, {
    assigneeNames: ['Ayşe Yılmaz', 'Mehmet Demir'],
    now: new Date(2026, 7, 17, 9, 0, 0)
  });
  const rendered = renderReminderEmail({ subject: DEFAULT_REMINDER_SUBJECT, body: DEFAULT_REMINDER_BODY }, values);

  assert.match(rendered.subject, /Teklif dosyasının hazırlanması/);
  assert.match(rendered.html, /P4417041/);
  assert.match(rendered.html, /Ayşe Yılmaz, Mehmet Demir/);
  assert.match(rendered.html, /20\.08\.2026/);
  assert.match(rendered.html, /Devam ediyor/);
  assert.match(rendered.html, /Yüksek/);
  // Kalan süre GÖNDERİM ANINDA hesaplanır, saklanmaz.
  assert.match(rendered.html, /3 gün kaldı/);
  assert.equal(values.remaining_days, '3');
  // Düz metin karşılığı da üretilir (çok parçalı ileti için).
  assert.match(rendered.text, /Görev hatırlatması/);
  assert.equal(rendered.text.includes('<'), false);
  assert.deepEqual(rendered.unknownPlaceholders, []);
});

test('değeri olmayan alan UYDURULMAZ, nötr işaret gösterilir', () => {
  const values = buildReminderValues({ task: 'İş', status: 'planned' }, { now: new Date(2026, 7, 17) });
  const rendered = renderReminderEmail({ subject: '{{task_name}}', body: '<p>{{description}}</p>' }, values);
  assert.equal(rendered.subject, 'İş');
  assert.equal(rendered.bodyHtml, `<p>${MISSING_VALUE_MARK}</p>`);
});

test('tanınmayan yer tutucu olduğu gibi kalır ve raporlanır', () => {
  const rendered = renderReminderEmail({ subject: '{{task_name}} · {{bilinmeyen}}', body: '<p>{{gizli_alan}}</p>' }, { task_name: 'İş' });
  assert.equal(rendered.subject, 'İş · {{bilinmeyen}}');
  assert.match(rendered.bodyHtml, /\{\{gizli_alan\}\}/);
  assert.deepEqual(rendered.unknownPlaceholders.sort(), ['bilinmeyen', 'gizli_alan']);
});

test('dinamik değerler HTML olarak yorumlanmaz', () => {
  const rendered = renderReminderEmail(
    { subject: 'K', body: '<p>{{task_name}}</p>' },
    { task_name: '<img src=x onerror="alert(1)">Görev' }
  );
  assert.equal(rendered.html.includes('<img'), false);
  assert.match(rendered.bodyHtml, /&lt;img/);
});

test('yönetici HTML’i kapalı bir etiket kümesine indirgenir', () => {
  const sanitized = sanitizeReminderHtml([
    '<p onclick="steal()">Metin</p>',
    '<script>fetch("//evil")</script>',
    '<iframe src="//evil"></iframe>',
    '<a href="javascript:alert(1)">kötü</a>',
    '<a href="https://example.internal">iyi</a>',
    '<span style="color: #111; behavior: url(x)">stil</span>'
  ].join(''));

  assert.equal(sanitized.includes('onclick'), false);
  assert.equal(sanitized.includes('script'), false);
  assert.equal(sanitized.includes('fetch'), false);
  assert.equal(sanitized.includes('iframe'), false);
  assert.equal(sanitized.includes('javascript:'), false);
  assert.match(sanitized, /<a href="https:\/\/example\.internal">iyi<\/a>/);
  // İzin verilen stil özelliği korunur, tehlikeli olan düşer.
  assert.match(sanitized, /style="color: #111"/);
});

test('yer tutucu değiştirme ifade ya da kod çalıştırmaz', () => {
  const { text } = applyReminderPlaceholders('{{task_name}} {{ due_date }}', { task_name: 'A', due_date: 'B' }, { escape: (value) => value });
  assert.equal(text, 'A B');
  // Şablon sözdizimi sabittir; `${}` ya da `<%= %>` çalıştırılmaz.
  const injected = applyReminderPlaceholders('${process.exit(1)} <%= 1+1 %>', {}, { escape: (value) => value });
  assert.equal(injected.text, '${process.exit(1)} <%= 1+1 %>');
});

test('düz metin karşılığı listeleri ve satırları korur', () => {
  const text = htmlToPlainText('<h2>Başlık</h2><ul><li>Bir</li><li>İki</li></ul><p>Son</p>');
  assert.match(text, /Başlık/);
  assert.match(text, /• Bir/);
  assert.match(text, /• İki/);
  assert.match(text, /Son/);
});

test('yer tutucu kataloğu belgelenen adlarla eşleşir', () => {
  for (const key of ['task_name', 'project_name', 'due_date', 'remaining_duration', 'remaining_days', 'assignees', 'priority', 'status', 'description']) {
    assert.ok(REMINDER_PLACEHOLDER_KEYS.includes(key), `${key} desteklenmelidir`);
  }
});

/* ── 3. Otomatik hatırlatma ilkesi ──────────────────────────────── */

const ENABLED = Object.freeze({ automaticEnabled: true, windowValue: 7, windowUnit: 'day', frequencyValue: 2, frequencyUnit: 'day' });
const OPEN_TASK = Object.freeze({ id: 't1', status: 'in-progress', targetFinish: '2026-08-20' });

function at(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0);
}

test('otomatik hatırlatma kapalıyken hiçbir görev uygun değildir', () => {
  const evaluation = evaluateReminderEligibility(OPEN_TASK, { ...ENABLED, automaticEnabled: false }, at(2026, 8, 15));
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.reason, 'AUTOMATIC_DISABLED');
});

test('pencere dışındaki görev hatırlatma almaz', () => {
  // Termine 12 gün var, pencere 7 gün.
  const evaluation = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 8));
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.reason, 'OUTSIDE_WINDOW');
  assert.equal(evaluation.remainingDays, 12);
});

test('görev pencereye girdiğinde uygun olur ve kalan süre doğru hesaplanır', () => {
  // 20 Ağustos termini, 7 günlük pencere → 13 Ağustos'ta pencereye girer.
  const evaluation = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 13, 0));
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.remainingDays, 7);
  assert.equal(evaluation.slotIndex, 0);
  assert.equal(describeRemainingDuration(evaluation.remainingMinutes), '7 gün kaldı');
});

test('yineleme sıklığı aralık anahtarıyla uygulanır', () => {
  // 2 günde bir: 13→0, 14→0, 15→1, 17→2, 19→3 (gün başlangıcı referansıyla).
  const slots = [13, 14, 15, 16, 17, 18, 19].map((day) => evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, day, 0)).slotIndex);
  assert.deepEqual(slots, [0, 0, 1, 1, 2, 2, 3]);
  // Aynı gün içindeki iki farklı saat AYNI aralığa düşer: saatte bir çalışan
  // zamanlayıcı günde 24 ileti göndermez.
  const morning = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 15, 6));
  const evening = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 15, 22));
  assert.equal(morning.slotKey, evening.slotKey);
});

test('termin gününe ulaşıldığında otomatik hatırlatma durur', () => {
  const dueDay = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 20, 0));
  assert.equal(dueDay.eligible, true, 'termin günü son hatırlatmadır');
  const afterDue = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 21));
  assert.equal(afterDue.eligible, false);
  assert.equal(afterDue.reason, 'PAST_DUE');
});

test('tamamlanan ve iptal edilen görev hatırlatma almaz', () => {
  for (const status of ['done', 'completed', 'cancelled']) {
    const evaluation = evaluateReminderEligibility({ ...OPEN_TASK, status }, ENABLED, at(2026, 8, 15));
    assert.equal(evaluation.eligible, false);
    assert.equal(evaluation.reason, 'TASK_CLOSED');
    assert.equal(isClosedTaskStatus(status), true);
  }
  // Silinen görev zaten aday listesine giremez; ilke katmanı da onu bulamaz.
  assert.equal(evaluateReminderEligibility(null, ENABLED, at(2026, 8, 15)).reason, 'TASK_NOT_FOUND');
});

test('terminsiz görev otomatik hatırlatmaya girmez', () => {
  const evaluation = evaluateReminderEligibility({ ...OPEN_TASK, targetFinish: null }, ENABLED, at(2026, 8, 15));
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.reason, 'NO_DUE_DATE');
});

test('yönetici sıklığı ya da pencereyi değiştirdiğinde yeni aralık dizisi başlar', () => {
  const base = evaluateReminderEligibility(OPEN_TASK, ENABLED, at(2026, 8, 15, 0));
  const fasterFrequency = evaluateReminderEligibility(OPEN_TASK, { ...ENABLED, frequencyValue: 1 }, at(2026, 8, 15, 0));
  const widerWindow = evaluateReminderEligibility(OPEN_TASK, { ...ENABLED, windowValue: 14 }, at(2026, 8, 15, 0));
  assert.notEqual(base.slotKey, fasterFrequency.slotKey);
  assert.notEqual(base.slotKey, widerWindow.slotKey);
  // Termin değişimi de yeni bir dizi başlatır.
  const movedDue = evaluateReminderEligibility({ ...OPEN_TASK, targetFinish: '2026-08-25' }, ENABLED, at(2026, 8, 22, 0));
  assert.notEqual(base.slotKey, movedDue.slotKey);
});

test('saat birimi de desteklenir', () => {
  const settings = normalizeReminderSettings({ automaticEnabled: true, windowValue: 48, windowUnit: 'hour', frequencyValue: 12, frequencyUnit: 'hour' });
  assert.equal(settings.windowMinutes, 2880);
  assert.equal(settings.frequencyMinutes, 720);
  const evaluation = evaluateReminderEligibility(OPEN_TASK, settings, at(2026, 8, 19, 0));
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.slotIndex, 2);
});

test('geçersiz ayarlar belgelenen varsayılana düşer', () => {
  const settings = normalizeReminderSettings({ automaticEnabled: true, windowValue: 0, windowUnit: 'yil', frequencyValue: -3, frequencyUnit: '' });
  assert.equal(settings.windowValue, DEFAULT_REMINDER_SETTINGS.windowValue);
  assert.equal(settings.windowUnit, 'day');
  assert.equal(settings.frequencyValue, DEFAULT_REMINDER_SETTINGS.frequencyValue);
  // Kurulum varsayılanı KAPALI gelir: dağıtımdan hemen sonra habersiz posta gitmez.
  assert.equal(DEFAULT_REMINDER_SETTINGS.automaticEnabled, false);
});

test('okunur özet yöneticiye planı anlatır', () => {
  assert.match(describeReminderSchedule(ENABLED), /termine 7 gün kala başlar ve 2 günde bir yinelenir/);
  assert.match(describeReminderSchedule({ ...ENABLED, automaticEnabled: false }), /Otomatik hatırlatma kapalı/);
});

test('birden çok uygun görev bağımsız değerlendirilir', () => {
  const due = selectDueReminders([
    { id: 'a', status: 'planned', targetFinish: '2026-08-20' },
    { id: 'b', status: 'done', targetFinish: '2026-08-20' },
    { id: 'c', status: 'planned', targetFinish: '2026-09-30' },
    { id: 'd', status: 'in-progress', targetFinish: '2026-08-18' }
  ], ENABLED, at(2026, 8, 15));
  assert.deepEqual(due.map((entry) => entry.task.id), ['a', 'd']);
  // Aralık anahtarları görev başına ayrıdır.
  assert.notEqual(due[0].slotKey, due[1].slotKey);
});

/* ── 4. Şema, yapılandırma ve güvenlik sözleşmeleri ─────────────── */

test('kopya gönderimi benzersiz dizin engeller', () => {
  const upgrade = read('database/MR_Upgrade_0005_Task_Reminders.sql');
  assert.match(upgrade, /CREATE UNIQUE INDEX UX_MR_TaskReminderLog_AutomaticSlot[\s\S]*?ON dbo\.MR_TaskReminderLog\(TaskId, SlotKey\)[\s\S]*?WHERE ReminderKind = 'AUTOMATIC'/);
  // Göç YİNELENEBİLİR: ikinci çalıştırma nesneleri yeniden oluşturmaz.
  assert.match(upgrade, /IF OBJECT_ID\(N'dbo\.MR_ReminderSettings', N'U'\) IS NULL/);
  assert.match(upgrade, /IF NOT EXISTS \(SELECT 1 FROM dbo\.MR_ReminderSettings WHERE SettingsId = 1\)/);
  // Varsayılan şablon tohumlanır ve otomatik gönderim KAPALI gelir.
  assert.match(upgrade, /VALUES \(\s*1, 0, 7, 'day', 2, 'day',/);
  // DC01_userr yeniden oluşturulmaz.
  assert.equal(/CREATE TABLE dbo\.DC01_userr/i.test(upgrade), false);
});

test('temiz kurulum ve geri alma betikleri hatırlatma tablolarını taşır', () => {
  const create = read('database/MR_Create_Durable_Persistence.sql');
  const rollback = read('database/MR_Rollback_Durable_Persistence.sql');
  for (const table of ['MR_ReminderSettings', 'MR_TaskReminderLog']) {
    assert.match(create, new RegExp(`CREATE TABLE dbo\\.${table}`));
    assert.match(rollback, new RegExp(`DROP TABLE dbo\\.${table}`));
  }
  assert.match(create, /0005_task_reminders/);
});

test('gönderim kaydı ÖNCE sahiplenilir, sonra gönderilir', () => {
  const service = read('src/server/reminders/reminderService.js');
  const claimIndex = service.indexOf('claimAutomaticReminder');
  const deliverIndex = service.indexOf('deliverTaskReminder(executor, {\n        task');
  assert.ok(claimIndex >= 0 && claimIndex < deliverIndex, 'aralık gönderimden önce sahiplenilmelidir');
  // Sahiplenilemeyen aralık atlanır; ikinci ileti gönderilmez.
  assert.match(service, /if \(logId == null\) \{[\s\S]*?reason: 'ALREADY_SENT'/);
  // Tek bir görevin hatası turu düşürmez.
  assert.match(service, /catch \(error\) \{[\s\S]*?results\.push\(\{ taskId: candidate\.id, status: 'FAILED', reason: 'UNEXPECTED_ERROR' \}\)/);
});

test('SMTP başarısızlığı asla "gönderildi" olarak raporlanmaz', () => {
  const service = read('src/server/reminders/reminderService.js');
  assert.match(service, /if \(!sent\.ok\) \{[\s\S]*?status: 'FAILED'/);
  const client = read('src/server/mail/smtpClient.js');
  // Söz yalnızca sunucu 250 döndüğünde çözülür.
  assert.match(client, /if \(accepted\.code !== 250\) \{[\s\S]*?throw new SmtpError\('SMTP_SEND_FAILED'/);
  // Bağlantı her koşulda serbest bırakılır.
  assert.match(client, /finally \{[\s\S]*?socket\.destroy\(\)/);
});

test('SMTP kimlik bilgileri istemciye taşınmaz ve günlüğe yazılmaz', () => {
  const config = read('src/server/mail/smtpConfig.js');
  assert.match(config, /import 'server-only'/);
  // Tarayıcıya açılan hiçbir ortam değişkeni okunmaz.
  assert.equal(/process\.env\.NEXT_PUBLIC/.test(config), false);
  const client = read('src/server/mail/smtpClient.js');
  assert.equal(/console\.(log|error|warn)/.test(client), false, 'SMTP istemcisi günlük yazmaz');
  const service = read('src/server/reminders/reminderService.js');
  assert.equal(service.includes('config.password'), false);
  // Alıcı adresleri kalıcı kayda MASKELENEREK yazılır.
  const store = read('src/server/reminders/reminderStore.js');
  assert.match(store, /export function maskRecipients/);
  assert.match(store, /return `\$\{head\}\*\*\*@\$\{domain\}`/);
  // İstemci paketi SMTP ortam değişkenlerini hiç görmez.
  for (const file of ['src/features/reminders/reminderClient.js', 'src/features/reminders/TaskReminderButton.jsx']) {
    const source = read(file);
    assert.equal(source.includes('SMTP_'), false, `${file} SMTP yapılandırmasını okumamalıdır`);
  }
});

test('elle gönderim ucu istemciden alıcı kabul etmez', () => {
  const route = read('src/app/api/mergen-rota/tasks/[taskId]/reminder/route.js');
  // Gövde hiç okunmaz: uç açık posta rölesine dönüşemez.
  assert.equal(route.includes('request.json()'), false);
  assert.match(route, /assertTaskReminderAccess\(pool, actor, taskId\)/);
  // Kimlik sunucuda çözülür; istemci öneki (`task-<uuid>`) de kabul edilir,
  // çünkü gerçek kipte yeni oluşturulan görevler takma adı korur.
  assert.match(route, /extractActualId\(rawTaskId\)/);
  // Yetki, gönderime girecek satır yüklendikten sonra YENİDEN doğrulanır.
  assert.match(route, /authorize: \(task\) => assertTaskReminderAccess\(pool, actor, task\.id\)/);
  const client = read('src/features/reminders/reminderClient.js');
  assert.match(client, /sendTaskReminderRequest\(taskId\)/);
  // İstemci istek gövdesi göndermez.
  assert.equal(/reminder`, \{ method: 'POST', body/.test(client), false);
});

test('yapılandırma uçları yalnızca sistem yöneticisine açıktır', () => {
  const route = read('src/app/api/mergen-rota/admin/reminder-settings/route.js');
  const getBody = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function PUT'));
  const putBody = route.slice(route.indexOf('export async function PUT'));
  assert.match(getBody, /assertReminderAdmin\(actor\)/);
  assert.match(putBody, /assertReminderAdmin\(actor\)/);
  // Yanıt yalnızca "yapılandırıldı mı" bilgisini taşır, kimlik bilgisini değil.
  assert.match(route, /smtpConfigured: isSmtpConfigured\(\)/);
  assert.equal(route.includes('SMTP_PASSWORD'), false);

  const access = read('src/server/reminders/reminderAccess.js');
  assert.match(access, /if \(!actor\?\.isSystemAdmin\)/);
  // Zamanlayıcı anahtarı sabit süreli karşılaştırmayla doğrulanır.
  assert.match(access, /timingSafeEqual/);
  assert.match(access, /if \(!configured\) return false;/);
});

test('zamanlayıcı ucu kimliksiz erişime açılmaz', () => {
  const route = read('src/app/api/mergen-rota/reminders/run/route.js');
  assert.match(route, /if \(!hasReminderSchedulerKey\(request\)\) \{[\s\S]*?if \(!actor\.isSystemAdmin\)/);
});

test('elle gönderim otomatik ayardan bağımsız çalışır', () => {
  const service = read('src/server/reminders/reminderService.js');
  const manual = service.slice(service.indexOf('export async function sendManualReminder'), service.indexOf('export async function runAutomaticReminders'));
  // Elle akış `automaticEnabled` denetimi YAPMAZ.
  assert.equal(manual.includes('automaticEnabled'), false);
  const automatic = service.slice(service.indexOf('export async function runAutomaticReminders'));
  assert.match(automatic, /if \(!settings\.automaticEnabled\)/);
});

test('hatırlatma düğmesi görevi değiştirmez ve kopya gönderimi engeller', () => {
  const button = read('src/features/reminders/TaskReminderButton.jsx');
  // İstek sürerken düğme kapalıdır.
  assert.match(button, /const disabled = busy \|\| demo \|\| !task\?\.id;/);
  assert.match(button, /if \(disabled\) return;/);
  // Yalnızca gönderim yapılır; görev yazma eylemi çağrılmaz.
  for (const action of ['updateTask', 'deleteTask', 'onUpdate', 'onDelete']) {
    assert.equal(button.includes(action), false, `${action} hatırlatma düğmesinde çağrılmamalıdır`);
  }
  // Satır tıklaması yutulur: hatırlatma göndermek görev panelini açmaz.
  assert.match(button, /event\.stopPropagation\(\);/);
});

test('şablon ve alıcı çözümü iki akışta da AYNI koddan gelir', () => {
  const service = read('src/server/reminders/reminderService.js');
  // Tek bir teslim işlevi TANIMLANIR; elle ve otomatik akışlar onu çağırır.
  assert.equal((service.match(/export async function deliverTaskReminder/g) || []).length, 1);
  const calls = service.match(/(?<!function )deliverTaskReminder\(executor, \{/g) || [];
  assert.equal(calls.length, 2, 'elle ve otomatik akış aynı çekirdeği çağırmalıdır');
  assert.equal((service.match(/renderReminderEmail\(/g) || []).length, 1);
  assert.equal((service.match(/resolveReminderRecipients\(/g) || []).length, 1);
});

/* ── 5. MIME ve SMTP protokolü ──────────────────────────────────── */

test('ileti çok parçalıdır ve Türkçe karakterleri korur', () => {
  const message = buildMimeMessage({
    from: 'rota@example.internal',
    fromName: 'MERGEN Rota',
    to: ['ayse.yilmaz@example.internal'],
    subject: 'Görev hatırlatması · Şantiye çalışması',
    html: '<p>İşin durumu güncellensin.</p>',
    text: 'İşin durumu güncellensin.',
    date: new Date(Date.UTC(2026, 7, 17, 6, 0, 0))
  });

  assert.match(message, /^From: MERGEN Rota <rota@example\.internal>/m);
  assert.match(message, /^To: ayse\.yilmaz@example\.internal$/m);
  // Başlık RFC 2047 ile kodlanır: Outlook ham 8 bitlik konuyu bozuyordu.
  assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(message, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(message, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(message, /Content-Type: text\/html; charset="UTF-8"/);
  // Gövdeler base64: Türkçe karakterler taşımada bozulmaz.
  const decoded = Buffer.from(message.split('Content-Transfer-Encoding: base64')[1].split('--')[0].trim(), 'base64').toString('utf8');
  assert.match(decoded, /İşin durumu güncellensin\./);
});

test('başlık enjeksiyonu engellenir', () => {
  assert.equal(sanitizeHeaderValue('Konu\r\nBcc: kotu@example.internal'), 'Konu Bcc: kotu@example.internal');
  // Satır sonu ada da girse başlık tek satır kalır.
  assert.equal(formatAddress('a@b.com', 'Ad\nSoyad'), 'Ad Soyad <a@b.com>');
  // Türkçe karakter taşıyan ad RFC 2047 ile kodlanır.
  assert.match(formatAddress('a@b.com', 'Ayşe Yılmaz'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b\.com>$/);
  assert.equal(encodeHeaderValue('Plain Subject'), 'Plain Subject');
  // Geçersiz alıcı iletiyi hiç kurdurmaz.
  assert.throws(() => buildMimeMessage({ from: 'a@b.com', to: ['kotu adres'], subject: 'K', html: '', text: '' }), /Geçersiz alıcı/);
  assert.throws(() => buildMimeMessage({ from: 'a@b.com', to: [], subject: 'K', html: '', text: '' }), /En az bir alıcı/);
});

test('DATA gövdesinde satır başı noktası kaçırılır', () => {
  // Aksi hâlde ileti o satırda erken sonlanır (RFC 5321 · nokta doldurma).
  assert.equal(dotStuff('birinci\n.ikinci\nüçüncü'), 'birinci\r\n..ikinci\r\nüçüncü');
});

test('AUTH PLAIN belirteci RFC 4616 biçimindedir', () => {
  const decoded = Buffer.from(authPlainToken('kullanici', 'parola'), 'base64').toString('utf8');
  assert.equal(decoded.charCodeAt(0), 0);
  assert.deepEqual(decoded.split(String.fromCharCode(0)), ['', 'kullanici', 'parola']);
});

test('SMTP yanıt okuyucusu çok satırlı yanıtı doğru ayrıştırır', async () => {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.write = () => {};
  const dialogue = createSmtpDialogue(socket, 1000);

  const greeting = dialogue.read();
  socket.emit('data', '220 mail.example.internal ESMTP\r\n');
  assert.equal((await greeting).code, 220);

  const ehlo = dialogue.command('EHLO mergen-rota');
  // Ara satırlar `250-`, son satır `250 ` ile gelir; yalnızca sonuncusu çözer.
  socket.emit('data', '250-mail.example.internal\r\n250-STARTTLS\r\n');
  socket.emit('data', '250 AUTH LOGIN PLAIN\r\n');
  const response = await ehlo;
  assert.equal(response.code, 250);
  assert.match(response.text, /AUTH LOGIN PLAIN/);
});

test('beklenmeyen SMTP yanıt kodu hata olarak yükselir', async () => {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.write = () => {};
  const dialogue = createSmtpDialogue(socket, 1000);
  const command = dialogue.command('MAIL FROM:<a@b.com>', { description: 'MAIL FROM' });
  socket.emit('data', '550 Mailbox unavailable\r\n');
  await assert.rejects(command, /MAIL FROM reddedildi \(550\)/);
});

test('SMTP akışı Python karşılığıyla aynı sırayı izler', () => {
  const client = read('src/server/mail/smtpClient.js');
  const flow = ['EHLO mergen-rota', 'STARTTLS', 'EHLO (TLS sonrası)', 'MAIL FROM:<', 'RCPT TO:<', 'DATA', 'QUIT'];
  let cursor = -1;
  for (const step of flow) {
    const index = client.indexOf(step, cursor + 1);
    assert.ok(index > cursor, `${step} adımı sırada bulunmalıdır`);
    cursor = index;
  }
  // Python uygulamasındaki gibi TLS sonrası EHLO tekrarlanır.
  assert.equal((client.match(/EHLO mergen-rota/g) || []).length, 2);
});
