/**
 * iCalendar (RFC 5545 / RFC 5546) üretimi.
 *
 * Saf modüldür: ağ bağlantısı kurmaz, veritabanı okumaz, yalnızca metin üretir.
 * Kaçırma, satır katlama ve CRLF kuralları tek yerde durur; React bileşenleri ya
 * da SQL katmanı hiçbir zaman iCalendar metni birleştirmez.
 *
 * Outlook/Exchange davranışı için üç karar bilinçlidir:
 *  - Görev bir TERMİN kaydıdır: tüm gün süren bir olay yazılır ve `TRANSP`
 *    değeri `TRANSPARENT` olur; kullanıcının bütün günü meşgul görünmez.
 *  - Hatırlatıcı (`VALARM`) eklenmez; Outlook/kullanıcı ilkesi bunu kendisi
 *    yönetir.
 *  - `RSVP` kapalıdır: MERGEN Rota yanıt iletisi işlemez, ortak posta kutusu
 *    "kabul edildi" iletileriyle dolmaz.
 */

const CRLF = '\r\n';

/** Tek bir içerik satırının en fazla sekizlik sayısı (RFC 5545 · 3.1). */
const MAX_OCTETS = 75;

/** iCalendar METİN değeri kaçırma (RFC 5545 · 3.3.11). */
export function escapeIcsText(value) {
  return String(value ?? '')
    // Ters bölü ÖNCE kaçırılır; sonra kaçırılsaydı sonraki kaçışların bölüsünü
    // de ikilerdi.
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Kalan denetim karakterleri iCalendar içerik satırında yer alamaz.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Özellik parametresi değeri (RFC 5545 · 3.2): tırnak ve satır sonu taşımaz. */
export function escapeIcsParameter(value) {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

/**
 * İçerik satırını 75 sekizlikte katlar (RFC 5545 · 3.1 · "content line").
 *
 * Katlama SEKİZLİK sayısına göredir ama çok baytlı bir karakter ikiye
 * BÖLÜNMEZ: bölünen bir UTF-8 dizisi Türkçe karakterleri bozar. Devam satırı
 * tek boşlukla başlar.
 */
export function foldIcsLine(line) {
  const text = String(line ?? '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_OCTETS) return text;
  const lines = [];
  let chunk = '';
  let size = 0;
  // İlk satırın bütçesi 75, devam satırlarının bütçesi baştaki boşlukla
  // birlikte 75 sekizliktir.
  let budget = MAX_OCTETS;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > budget) {
      lines.push(chunk);
      chunk = '';
      size = 0;
      budget = MAX_OCTETS - 1;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk) lines.push(chunk);
  return lines.map((value, index) => (index === 0 ? value : ` ${value}`)).join(CRLF);
}

/** `YYYY-MM-DD` → `YYYYMMDD` (VALUE=DATE biçimi). */
export function icsDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/**
 * Tüm gün süren olayın BİTİŞ günü DIŞLAYICIDIR (RFC 5545 · 3.8.2.2).
 *
 * 15.09.2026 terminli bir görev için `DTEND` 16.09.2026 olmalıdır; aksi hâlde
 * Outlook olayı sıfır uzunlukta sayar ya da bir gün geri kaydırır.
 */
export function nextIcsDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, '0')}${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** `YYYYMMDDTHHMMSSZ` (UTC damgası). */
export function icsTimestamp(date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${value.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Görev/kullanıcı aboneliğinin DEĞİŞMEZ iCalendar kimliği.
 *
 * Görev adına ya da kullanıcının tam adına DAYANMAZ: ikisi de değişebilir ve
 * değiştiğinde Outlook aynı randevuyu bulamaz, güncelleme yerine ikinci bir
 * kayıt açılırdı.
 */
export function outlookCalendarUid(taskId, sicil) {
  const task = String(taskId ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const user = String(sicil ?? '').trim().replace(/[^0-9]/g, '');
  if (!task || !user) return null;
  return `mergen-rota-task-${task}-user-${user}@mergen-rota`;
}

function property(name, value, parameters = {}) {
  const params = Object.entries(parameters)
    .filter(([, parameterValue]) => parameterValue != null && parameterValue !== '')
    .map(([key, parameterValue]) => `;${key}=${escapeIcsParameter(parameterValue)}`)
    .join('');
  return foldIcsLine(`${name}${params}:${value}`);
}

/** Adres, `mailto:` değerine yazılmadan önce denetlenir. */
function mailtoValue(address) {
  const clean = String(address ?? '').trim();
  return clean ? `mailto:${clean.replace(/[\s<>",;:]/g, '')}` : null;
}

/**
 * Tek görev/kullanıcı ilişkisi için VCALENDAR metni üretir.
 *
 * @param {{method:'REQUEST'|'CANCEL', uid:string, sequence:number,
 *   summary:string, description?:string, start:string, end?:string,
 *   organizer:{address:string, name?:string},
 *   attendee:{address:string, name?:string},
 *   url?:string|null, dtstamp?:Date}} input
 * @returns {string} CRLF satır sonlu iCalendar gövdesi
 */
export function buildTaskCalendarDocument({
  method,
  uid,
  sequence = 0,
  summary,
  description = '',
  start,
  end = null,
  organizer,
  attendee,
  url = null,
  dtstamp = new Date()
}) {
  const cancelled = method === 'CANCEL';
  const startDate = icsDate(start);
  if (!startDate && !cancelled) throw new Error('Takvim daveti için geçerli bir başlangıç günü gereklidir.');
  if (!uid) throw new Error('Takvim daveti için değişmez bir UID gereklidir.');
  const organizerValue = mailtoValue(organizer?.address);
  const attendeeValue = mailtoValue(attendee?.address);
  if (!organizerValue) throw new Error('Takvim daveti için geçerli bir düzenleyici adresi gereklidir.');
  if (!attendeeValue) throw new Error('Takvim daveti için geçerli bir katılımcı adresi gereklidir.');

  const lines = [
    'BEGIN:VCALENDAR',
    property('PRODID', '-//MERGEN Rota//Gorev Takvimi//TR'),
    property('VERSION', '2.0'),
    property('CALSCALE', 'GREGORIAN'),
    property('METHOD', cancelled ? 'CANCEL' : 'REQUEST'),
    'BEGIN:VEVENT',
    property('UID', escapeIcsText(uid)),
    property('SEQUENCE', String(Math.max(0, Math.trunc(Number(sequence) || 0)))),
    property('DTSTAMP', icsTimestamp(dtstamp)),
    ...(startDate ? [
      property('DTSTART', startDate, { VALUE: 'DATE' }),
      property('DTEND', icsDate(end) || nextIcsDate(start), { VALUE: 'DATE' })
    ] : []),
    property('SUMMARY', escapeIcsText(summary)),
    property('ORGANIZER', organizerValue, { CN: organizer?.name || undefined }),
    property('ATTENDEE', attendeeValue, {
      CUTYPE: 'INDIVIDUAL',
      ROLE: 'REQ-PARTICIPANT',
      PARTSTAT: 'NEEDS-ACTION',
      RSVP: 'FALSE',
      CN: attendee?.name || undefined
    }),
    property('STATUS', cancelled ? 'CANCELLED' : 'CONFIRMED'),
    // Termin kaydı kullanıcıyı MEŞGUL göstermez.
    property('TRANSP', 'TRANSPARENT'),
    // Outlook serbest/meşgul durumunu bu özel alandan da okur.
    property('X-MICROSOFT-CDO-BUSYSTATUS', 'FREE'),
    property('X-MICROSOFT-CDO-ALLDAYEVENT', 'TRUE'),
    property('X-MICROSOFT-DISALLOW-COUNTER', 'TRUE')
  ];
  if (description) lines.push(property('DESCRIPTION', escapeIcsText(description)));
  if (url) {
    const value = String(url);
    if (/[\x00-\x20\x7f]/.test(value) || !/^https?:$/.test(new URL(value).protocol)) {
      throw new Error('Takvim bağlantısı geçerli bir HTTP(S) adresi olmalıdır.');
    }
    lines.push(property('URL', new URL(value).href));
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join(CRLF)}${CRLF}`;
}
