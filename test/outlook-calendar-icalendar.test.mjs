/**
 * Outlook takvim daveti · iCalendar ve MIME sözleşmesi.
 *
 * Saf katman burada sınanır: kaçırma, satır katlama, CRLF, tüm gün tarih
 * anlambilimi, kanonik gösterim/karma ve `text/calendar` parçasının Outlook
 * uyumlu MIME yapısı. Hiçbir sınama ağ bağlantısı kurmaz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

import {
  buildTaskCalendarDocument,
  escapeIcsParameter,
  escapeIcsText,
  foldIcsLine,
  icsDate,
  icsTimestamp,
  nextIcsDate,
  outlookCalendarUid
} from '../src/domain/outlook/icalendar.js';
import {
  buildOutlookCalendarPayload,
  formatCalendarDay,
  hasOutlookCalendarChange,
  outlookCancellationHash,
  outlookPayloadHash,
  outlookRevisionFields,
  renderOutlookInvitation
} from '../src/domain/outlook/outlookCalendarPayload.js';
import { renderOutlookInvitationMail } from '../src/domain/outlook/outlookMailContent.js';
import { taskCalendarDate } from '../src/domain/calendar/taskCalendarDate.js';
import {
  OUTLOOK_REASONS,
  outlookActionAvailability,
  selectableOutlookTasks,
  summarizeOutlookBulkResult
} from '../src/features/outlook/outlookPresentation.js';

registerServerOnlyShim();
const { buildMimeMessage } = await import('../src/server/mail/mimeMessage.js');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const ORGANIZER = { address: 'mergen-rota@example.internal', name: 'MERGEN Rota' };
const ATTENDEE = { address: 'ayse.yilmaz@example.internal', name: 'Ayşe Yılmaz' };

/** Katlanmış içerik satırlarını birleştirir (RFC 5545 · 3.1). */
function unfold(document) {
  return String(document).replace(/\r\n /g, '');
}

function invitation(overrides = {}) {
  return buildTaskCalendarDocument({
    method: 'REQUEST',
    uid: 'mergen-rota-task-abc-user-900001@mergen-rota',
    sequence: 0,
    summary: 'MERGEN Rota · Teklif dosyası',
    description: 'Görev: Teklif dosyası\nProje: P4417041 · İHA',
    start: '2026-09-15',
    organizer: ORGANIZER,
    attendee: ATTENDEE,
    dtstamp: new Date(Date.UTC(2026, 8, 8, 6, 30, 0)),
    ...overrides
  });
}

/* ── 1. Kaçırma ve satır kuralları ──────────────────────────────── */

test('iCalendar METİN değeri virgül, noktalı virgül, ters bölü ve satır sonunu kaçırır', () => {
  assert.equal(escapeIcsText('a,b'), 'a\\,b');
  assert.equal(escapeIcsText('a;b'), 'a\\;b');
  // Ters bölü ÖNCE kaçırılır; sonra kaçırılsaydı sonraki kaçışların bölüsü de ikilenirdi.
  assert.equal(escapeIcsText('a\\b'), 'a\\\\b');
  assert.equal(escapeIcsText('a\r\nb\nc'), 'a\\nb\\nc');
  assert.equal(escapeIcsText('ab'), 'ab');
  // İki nokta üst üste RFC 5545'te METİN değerinde kaçırılmaz.
  assert.equal(escapeIcsText('Görev: X'), 'Görev: X');
});

test('özellik parametresi satır sonu taşımaz ve gerekiyorsa tırnaklanır', () => {
  assert.equal(escapeIcsParameter('MERGEN Rota'), 'MERGEN Rota');
  assert.equal(escapeIcsParameter('PMO, Rota'), '"PMO, Rota"');
  assert.equal(escapeIcsParameter('bir\r\niki'), 'bir iki');
  assert.equal(escapeIcsParameter('"alıntı"'), "'alıntı'");
});

test('içerik satırı 75 sekizlikte katlanır ve çok baytlı karakter bölünmez', () => {
  const folded = foldIcsLine(`DESCRIPTION:${'ğüşiöç'.repeat(40)}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'uzun satır katlanmalıdır');
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `satır 75 sekizliği aşmamalı: ${line.length}`);
  }
  for (const line of lines.slice(1)) assert.match(line, /^ /);
  // Katlama geri alındığında metin AYNEN geri gelir (bozulan karakter yok).
  const unfolded = lines.map((line, index) => (index === 0 ? line : line.slice(1))).join('');
  assert.equal(unfolded, `DESCRIPTION:${'ğüşiöç'.repeat(40)}`);
});

test('kısa satır katlanmaz', () => {
  assert.equal(foldIcsLine('SUMMARY:Kısa'), 'SUMMARY:Kısa');
});

/* ── 2. Tarih anlambilimi ───────────────────────────────────────── */

test('tüm gün DTEND DIŞLAYICIDIR ve ay/yıl sınırında taşar', () => {
  assert.equal(icsDate('2026-09-15'), '20260915');
  assert.equal(nextIcsDate('2026-09-15'), '20260916');
  assert.equal(nextIcsDate('2026-02-28'), '20260301');
  assert.equal(nextIcsDate('2026-12-31'), '20270101');
  assert.equal(nextIcsDate('geçersiz'), null);
});

test('DTSTAMP UTC damgasıdır', () => {
  assert.equal(icsTimestamp(new Date(Date.UTC(2026, 8, 8, 6, 30, 15))), '20260908T063015Z');
});

test('takvim tarihi Takvim görünümüyle AYNI kuraldan gelir', () => {
  assert.equal(taskCalendarDate({ targetFinish: '2026-08-24', plannedFinish: '2026-08-20' }), '2026-08-24');
  assert.equal(taskCalendarDate({ targetFinish: null, plannedFinish: '2026-07-31' }), '2026-07-31');
  assert.equal(taskCalendarDate({}), null);
  // Takvim görünümü kuralı ALAN MODELİNDEN yeniden yayımlar; ikinci bir kopya yoktur.
  const bucketing = read('src/features/calendar/calendarTaskBucketing.js');
  assert.match(bucketing, /from '\.\.\/\.\.\/domain\/calendar\/taskCalendarDate\.js'/);
  assert.doesNotMatch(bucketing, /export function taskCalendarDate/);
});

/* ── 3. REQUEST ve CANCEL belgeleri ─────────────────────────────── */

test('REQUEST daveti geçerli, tüm gün ve MEŞGUL GÖSTERMEYEN bir VEVENT üretir', () => {
  const document = invitation();
  assert.ok(document.endsWith('\r\n'));
  // Boş içerik satırı CRLF belgede `\r\n\r\n` olarak görünür.
  assert.equal(document.includes('\r\n\r\n'), false);
  for (const line of document.split('\r\n').filter(Boolean)) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  }
  assert.match(document, /^BEGIN:VCALENDAR\r\n/);
  assert.match(document, /\r\nMETHOD:REQUEST\r\n/);
  assert.match(document, /\r\nUID:mergen-rota-task-abc-user-900001@mergen-rota\r\n/);
  assert.match(document, /\r\nSEQUENCE:0\r\n/);
  assert.match(document, /\r\nDTSTAMP:20260908T063000Z\r\n/);
  assert.match(document, /\r\nDTSTART;VALUE=DATE:20260915\r\n/);
  assert.match(document, /\r\nDTEND;VALUE=DATE:20260916\r\n/);
  assert.match(document, /\r\nSTATUS:CONFIRMED\r\n/);
  assert.match(document, /\r\nTRANSP:TRANSPARENT\r\n/);
  assert.match(document, /X-MICROSOFT-CDO-BUSYSTATUS:FREE/);
  assert.match(document, /ORGANIZER;CN=MERGEN Rota:mailto:mergen-rota@example\.internal/);
  // Katılımcı satırı 75 sekizliği aştığı için KATLANIR; açıldığında bütündür.
  assert.match(unfold(document), /ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE;CN=Ayşe Yılmaz:mailto:ayse\.yilmaz@example\.internal/);
  assert.match(document, /END:VCALENDAR\r\n$/);
  // Hatırlatıcı EKLENMEZ: Outlook/kullanıcı ilkesi bunu kendisi yönetir.
  assert.equal(document.includes('BEGIN:VALARM'), false);
});

test('CANCEL daveti aynı UID ile ve YÜKSEK sürümle iptal durumu taşır', () => {
  const document = invitation({ method: 'CANCEL', sequence: 3, description: '' });
  assert.match(document, /\r\nMETHOD:CANCEL\r\n/);
  assert.match(document, /\r\nUID:mergen-rota-task-abc-user-900001@mergen-rota\r\n/);
  assert.match(document, /\r\nSEQUENCE:3\r\n/);
  assert.match(document, /\r\nSTATUS:CANCELLED\r\n/);
  assert.equal(document.includes('DESCRIPTION'), false);
});

test('Türkçe içerik ve ayraç karakterleri davet gövdesinde kaçırılır', () => {
  const document = invitation({
    summary: 'MERGEN Rota · Şartname; teklif, gözden geçirme\\son',
    description: 'Görev: Şartname\nProje: İHA, PMO'
  });
  assert.ok(document.includes('Şartname\\; teklif\\, gözden geçirme\\\\son'.slice(0, 20)));
  assert.match(document, /DESCRIPTION:Görev: Şartname\\nProje: İHA\\, PMO/);
});

test('geçersiz girdiler sessizce kabul edilmez', () => {
  assert.throws(() => invitation({ start: null }), /başlangıç günü/);
  assert.throws(() => invitation({ uid: '' }), /UID/);
  assert.throws(() => invitation({ attendee: { address: '' } }), /katılımcı/);
});

test('UID görev adına ya da kullanıcı adına DAYANMAZ ve harf büyüklüğünden bağımsızdır', () => {
  const upper = outlookCalendarUid('C3C3C3C3-3333-4333-8333-333333333333', 900001);
  const lower = outlookCalendarUid('c3c3c3c3-3333-4333-8333-333333333333', '900001');
  assert.equal(upper, lower);
  assert.equal(upper, 'mergen-rota-task-c3c3c3c3-3333-4333-8333-333333333333-user-900001@mergen-rota');
  assert.equal(outlookCalendarUid('', 900001), null);
  assert.equal(outlookCalendarUid('abc', null), null);
});

/* ── 4. Kanonik gösterim ve karma ───────────────────────────────── */

const TASK = Object.freeze({
  id: 'task-1',
  task: 'Teklif dosyasının hazırlanması',
  projectCode: 'P4417041',
  projectName: 'İHA Projesi',
  targetFinish: '2026-09-15'
});

test('kanonik gösterim yalnızca randevuda GÖRÜNEN alanları taşır', () => {
  const payload = buildOutlookCalendarPayload(TASK, { link: 'https://mergen.example.internal/rota/' });
  assert.equal(payload.ok, true);
  assert.equal(payload.summary, 'MERGEN Rota · Teklif dosyasının hazırlanması');
  assert.equal(payload.date, '2026-09-15');
  assert.match(payload.description, /Görev: Teklif dosyasının hazırlanması/);
  assert.match(payload.description, /Proje: P4417041 · İHA Projesi/);
  assert.match(payload.description, /Termin: 15\.09\.2026/);
  assert.match(payload.description, /MERGEN Rota: https:\/\/mergen\.example\.internal\/rota\//);
  // Sorumlular ve notlar takvim öğesine YAZILMAZ: kısmi görünürlükte eş
  // sorumlunun kimliği kullanıcıdan gizlenir.
  assert.equal(payload.description.includes('Sorumlu'), false);
  assert.equal(Object.keys(payload.fields).sort().join(','), 'date,project,title');
});

test('termini olmayan görev takvime eklenemez', () => {
  assert.deepEqual(buildOutlookCalendarPayload({ task: 'X' }), { ok: false, code: 'NO_CALENDAR_DATE' });
  assert.deepEqual(
    buildOutlookCalendarPayload({ targetFinish: '2026-09-15', task: '   ' }),
    { ok: false, code: 'NO_TASK_TITLE' }
  );
});

test('karma yalnızca içerik alanlarına bağlıdır; dağıtım adresi güncelleme üretmez', () => {
  const first = buildOutlookCalendarPayload(TASK, { link: 'https://a.internal/rota/' });
  const second = buildOutlookCalendarPayload(TASK, { link: 'https://b.internal/rota/' });
  assert.equal(outlookPayloadHash(first), outlookPayloadHash(second));

  const renamed = buildOutlookCalendarPayload({ ...TASK, task: 'Teklif dosyası' }, {});
  assert.notEqual(outlookPayloadHash(first), outlookPayloadHash(renamed));

  const moved = buildOutlookCalendarPayload({ ...TASK, targetFinish: '2026-09-18' }, {});
  assert.notEqual(outlookPayloadHash(first), outlookPayloadHash(moved));

  assert.match(outlookPayloadHash(first), /^[0-9a-f]{64}$/);
  assert.match(outlookCancellationHash({ summary: 'X', date: '2026-09-15' }), /^[0-9a-f]{64}$/);
  assert.notEqual(
    outlookCancellationHash({ summary: 'X', date: '2026-09-15' }),
    outlookCancellationHash({ summary: 'X', date: '2026-09-18' })
  );
});

test('takvim güncellemesi yalnızca GÖRÜNEN alan değiştiğinde gerekir', () => {
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, progress: 40, keyword: 'Teklif' }), false);
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, description: 'yeni not' }), false);
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, targetFinish: '2026-09-18' }), true);
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, task: 'Başka görev' }), true);
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, projectName: 'Yeni Proje' }), true);
  // Boşluk farkı içerik farkı DEĞİLDİR.
  assert.equal(hasOutlookCalendarChange(TASK, { ...TASK, task: '  Teklif dosyasının   hazırlanması ' }), false);
  assert.equal(outlookRevisionFields({}).date, null);
  assert.equal(formatCalendarDay('2026-09-15'), '15.09.2026');
  assert.equal(formatCalendarDay('bozuk'), '');
});

/* ── 5. Posta gövdesi ve MIME ───────────────────────────────────── */

test('davet iletisi metin ve HTML yedeğini taşır, fazladan bilgi sızdırmaz', () => {
  const payload = buildOutlookCalendarPayload(TASK, { link: 'https://mergen.example.internal/rota/' });
  const mail = renderOutlookInvitationMail({ method: 'REQUEST', payload, link: 'https://mergen.example.internal/rota/' });
  assert.match(mail.subject, /^Takvim daveti: MERGEN Rota · Teklif/);
  assert.match(mail.text, /Görev: Teklif dosyasının hazırlanması/);
  assert.match(mail.text, /Outlook daveti gönderildi/);
  assert.doesNotMatch(mail.text + mail.html, /takviminize eklendi/);
  assert.match(mail.html, /<td[^>]*>Teklif dosyasının hazırlanması<\/td>/);
  assert.equal(mail.html.includes('<script'), false);

  const cancel = renderOutlookInvitationMail({
    method: 'CANCEL',
    payload: { summary: 'MERGEN Rota · Teklif', date: '2026-09-15', fields: { title: 'Teklif', project: '' } }
  });
  assert.match(cancel.subject, /^İptal: /);
  assert.match(cancel.text, /takvim iptali gönderildi/);
  assert.doesNotMatch(cancel.text + cancel.html, /takviminizden kaldırıldı/);
});

test('HTML gövdesi görev adındaki işaretlemeyi kaçırır', () => {
  const mail = renderOutlookInvitationMail({
    method: 'REQUEST',
    payload: { summary: 'S', date: '2026-09-15', fields: { title: '<b>x</b>&"', project: '' } }
  });
  assert.match(mail.html, /&lt;b&gt;x&lt;\/b&gt;&amp;&quot;/);
});

test('takvim parçası Outlook uyumlu MIME yapısında ve base64 taşınır', () => {
  const calendar = { method: 'REQUEST', content: invitation(), filename: 'mergen-rota.ics' };
  const message = buildMimeMessage({
    from: 'mergen-rota@example.internal',
    fromName: 'MERGEN Rota',
    to: ['ayse.yilmaz@example.internal'],
    subject: 'Takvim daveti: Şartname',
    text: 'düz metin',
    html: '<p>HTML</p>',
    calendar
  });

  assert.match(message, /^From: MERGEN Rota <mergen-rota@example\.internal>/);
  assert.match(message, /\r\nContent-class: urn:content-classes:calendarmessage\r\n/);
  assert.match(message, /Content-Type: multipart\/mixed; boundary="[^"]+"/);
  assert.match(message, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
  assert.match(message, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(message, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(message, /Content-Type: text\/calendar; charset="UTF-8"; method=REQUEST/);
  assert.match(message, /Content-Type: application\/ics; charset="UTF-8"; name="mergen-rota\.ics"/);
  assert.match(message, /Content-Disposition: attachment; filename="mergen-rota\.ics"/);
  // Konu satırı Türkçe karakter için RFC 2047 ile kodlanır.
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  // Davet base64 taşınır: CRLF ve Türkçe karakterler aktarımda bozulmaz.
  const part = message.split('Content-Type: text/calendar; charset="UTF-8"; method=REQUEST')[1];
  const encoded = part.split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), calendar.content);
});

test('CANCEL yöntemi başlığa yazılır ve serbest metin kabul edilmez', () => {
  const cancel = buildMimeMessage({
    from: 'mergen-rota@example.internal',
    to: ['a@example.internal'],
    subject: 'İptal',
    text: 't',
    html: 'h',
    calendar: { method: 'CANCEL', content: invitation({ method: 'CANCEL' }) }
  });
  assert.match(cancel, /method=CANCEL/);

  const injected = buildMimeMessage({
    from: 'mergen-rota@example.internal',
    to: ['a@example.internal'],
    subject: 'X',
    text: 't',
    html: 'h',
    calendar: { method: 'REQUEST\r\nBcc: kotu@example.internal', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }
  });
  assert.match(injected, /method=REQUEST\r\n/);
  assert.equal(injected.includes('Bcc:'), false);
});

test('ek adı başlık değerine ham geçmez', () => {
  const message = buildMimeMessage({
    from: 'mergen-rota@example.internal',
    to: ['a@example.internal'],
    subject: 'X',
    text: 't',
    html: 'h',
    calendar: { method: 'REQUEST', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', filename: 'kötü"; x\r\nBcc: b@c.d' }
  });
  assert.match(message, /filename="ktxBccbc\.d"/);
  assert.equal(message.includes('Bcc: b@c.d'), false);
});

test('takvim parçası OLMAYAN ileti eskisi gibi yalın multipart/alternative kalır', () => {
  const message = buildMimeMessage({
    from: 'mergen-rota@example.internal',
    to: ['a@example.internal'],
    subject: 'Hatırlatma',
    text: 'metin',
    html: '<p>html</p>'
  });
  assert.match(message, /Content-Type: multipart\/alternative; boundary="----=_MERGENRota_/);
  assert.equal(message.includes('multipart/mixed'), false);
  assert.equal(message.includes('text/calendar'), false);
  assert.equal(message.includes('Content-class:'), false);
});

/* ── 6. Arayüz sunum kuralları ──────────────────────────────────── */

test('eylem Demo Kipte, kapalı özellikte ve eksik yapılandırmada AÇIKÇA kapalıdır', () => {
  const ready = { status: 'ready', enabled: true, schemaReady: true, mailConfigured: true };
  assert.deepEqual(
    outlookActionAvailability({ actualDataMode: false, state: ready }),
    { available: false, reason: OUTLOOK_REASONS.DEMO }
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: { ...ready, enabled: false } }).reason,
    OUTLOOK_REASONS.DISABLED
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: { ...ready, schemaReady: false } }).reason,
    OUTLOOK_REASONS.SCHEMA
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: { ...ready, mailConfigured: false } }).reason,
    OUTLOOK_REASONS.MAIL
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: ready, task: { id: 't' } }).reason,
    OUTLOOK_REASONS.NO_DATE
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: ready, task: { targetFinish: '2026-09-15' } }).reason,
    OUTLOOK_REASONS.NO_TASK
  );
  assert.equal(
    outlookActionAvailability({ actualDataMode: true, state: ready, task: TASK }).available,
    true
  );
});

test('toplu sonuç TEK cümleyle özetlenir', () => {
  assert.deepEqual(summarizeOutlookBulkResult({ summary: { added: 8, alreadyAdded: 0, failed: 0, total: 8 } }), {
    tone: 'success',
    text: '8 Outlook daveti gönderildi.'
  });
  assert.deepEqual(summarizeOutlookBulkResult({ summary: { added: 5, alreadyAdded: 2, failed: 1, total: 8 } }), {
    tone: 'warning',
    text: '5 Outlook daveti gönderildi, 2 Outlook bağlantısı zaten günceldi, 1 görev eklenemedi.'
  });
  assert.deepEqual(summarizeOutlookBulkResult({ summary: { added: 0, alreadyAdded: 0, failed: 3, total: 3 } }), {
    tone: 'error',
    text: '3 görev eklenemedi.'
  });
  assert.equal(summarizeOutlookBulkResult({}).tone, 'error');
});

test('termini olmayan görevler toplu seçimden ayıklanır', () => {
  const tasks = [TASK, { id: 'x' }, { id: 'y', plannedFinish: '2026-10-01' }, { task: 'kimliksiz' }];
  assert.deepEqual(selectableOutlookTasks(tasks).map((task) => task.id), ['task-1', 'y']);
});

/* ── 7. Davet üretimi uçtan uca ─────────────────────────────────── */

test('renderOutlookInvitation kanonik gösterimi doğrudan davete çevirir', () => {
  const payload = buildOutlookCalendarPayload(TASK, { link: 'https://mergen.example.internal/rota/' });
  const document = renderOutlookInvitation({
    method: 'REQUEST',
    uid: 'uid@mergen-rota',
    sequence: 2,
    summary: payload.summary,
    description: payload.description,
    date: payload.date,
    organizer: ORGANIZER,
    attendee: ATTENDEE,
    link: 'https://mergen.example.internal/rota/',
    dtstamp: new Date(Date.UTC(2026, 8, 8))
  });
  assert.match(document, /SEQUENCE:2/);
  assert.match(document, /DTSTART;VALUE=DATE:20260915/);
  assert.match(document, /URL:https:\/\/mergen\.example\.internal\/rota\//);
});

test('takvim metni kesilirken Unicode karakteri bölünmez', () => {
  const payload = buildOutlookCalendarPayload({ ...TASK, task: 'a'.repeat(199) + '😀son' });
  assert.ok(payload.description.includes('a'.repeat(199) + '😀'));
  assert.equal(Buffer.from(payload.description, 'utf8').toString('utf8'), payload.description);
  assert.equal(Buffer.from(payload.summary, 'utf8').toString('utf8'), payload.summary);
});

test('iCalendar URL alanı URI ayraçlarını korur ve satır enjeksiyonunu reddeder', () => {
  const input = {
    method: 'REQUEST', uid: 'uri-test@mergen-rota', sequence: 1, summary: 'Görev',
    date: '2026-09-15', organizer: { address: 'organizer@example.internal' },
    attendee: { address: 'attendee@example.internal' }
  };
  const url = 'https://example.internal/base;a,b/?x=1,2;y=3';
  const document = renderOutlookInvitation({ ...input, link: url }).replace(/\r\n /g, '');
  assert.ok(document.includes(`URL:${url}\r\n`));
  assert.throws(() => renderOutlookInvitation({ ...input, link: 'https://example.internal/\r\nSUMMARY:changed' }));
  const cancel = renderOutlookInvitation({ ...input, method: 'CANCEL', date: null });
  assert.doesNotMatch(cancel, /DTSTART|DTEND/);
});
