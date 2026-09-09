import { createHash } from 'node:crypto';
import { taskCalendarDate } from '../calendar/taskCalendarDate.js';
import { buildTaskCalendarDocument, outlookCalendarUid } from './icalendar.js';

/**
 * Outlook takvim öğesinin KANONİK gösterimi.
 *
 * Bu modül tek bir soruyu yanıtlar: "görev, Outlook'ta ne olarak görünür?".
 * Yanıt bir özet nesnesidir ve özetin özü karma (`hash`) ile mühürlenir.
 * Güncelleme kararı bu karmadan verilir: MERGEN'de yapılan bir düzenleme
 * Outlook'ta GÖRÜNEN hiçbir şeyi değiştirmiyorsa yeni bir davet gönderilmez.
 *
 * Böylece etiket, yorum, ilerleme yüzdesi ya da denetim üst verisi gibi
 * randevuya hiç yazılmayan alanlar posta kutusunu şişirmez.
 */

const SUMMARY_PREFIX = 'MERGEN Rota';
const MAX_SUMMARY = 200;
const MAX_LINE = 300;

function cleanText(value, limit = MAX_LINE) {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

/** `YYYY-MM-DD` → `GG.AA.YYYY` (Türkçe gösterim). */
export function formatCalendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}

/** Proje künyesi: kod varsa `KOD · Ad`, yoksa yalnızca ad. */
export function projectLabel(task = {}) {
  const code = cleanText(task.projectCode, 100);
  const name = cleanText(task.projectName || task.proje, 200);
  if (code && name) return `${code} · ${name}`;
  return code || name;
}

/**
 * Takvim öğesinin İÇERİK alanları.
 *
 * Sorumlu listesi BİLİNÇLİ OLARAK yazılmaz: görev görünürlüğü kısmi olduğunda
 * eş sorumluların kimliği kullanıcıdan gizlenir ve takvim daveti bu sınırı
 * delmemelidir. Aynı gerekçeyle açıklama/not alanı da taşınmaz.
 */
export function outlookRevisionFields(task = {}) {
  return {
    title: cleanText(task.task || task.title, MAX_SUMMARY),
    project: projectLabel(task),
    date: taskCalendarDate(task) || null
  };
}

/**
 * Görevin Outlook karşılığını kurar.
 *
 * @param {object} task görev satırı (sunucu tarafında yetkiyle okunmuş)
 * @param {{link?: string|null}} [context] uygulamaya dönüş bağlantısı
 * @returns {{ok: true, summary: string, description: string, date: string,
 *   fields: object} | {ok: false, code: string}}
 */
export function buildOutlookCalendarPayload(task = {}, { link = null } = {}) {
  const fields = outlookRevisionFields(task);
  if (!fields.date) return { ok: false, code: 'NO_CALENDAR_DATE' };
  if (!fields.title) return { ok: false, code: 'NO_TASK_TITLE' };

  const summary = cleanText(`${SUMMARY_PREFIX} · ${fields.title}`, MAX_SUMMARY);
  const lines = [`Görev: ${fields.title}`];
  if (fields.project) lines.push(`Proje: ${fields.project}`);
  lines.push(`Termin: ${formatCalendarDay(fields.date)}`);
  // Bağlantı KARMAYA girmez (bkz. outlookPayloadHash): dağıtım adresi
  // değiştiğinde bütün abonelere gereksiz bir güncelleme gitmemelidir.
  const description = link ? `${lines.join('\n')}\n\nMERGEN Rota: ${link}` : lines.join('\n');

  return { ok: true, summary, description, date: fields.date, fields };
}

/**
 * Kanonik gösterimin parmak izi.
 *
 * Yalnızca randevuya GERÇEKTEN yazılan alanlar karmalanır. Sıra sabittir;
 * nesne anahtar sırası değişse bile aynı içerik aynı karmayı üretir.
 */
export function outlookPayloadHash(payload) {
  const fields = payload?.fields || payload || {};
  const canonical = JSON.stringify([
    String(fields.title ?? ''),
    String(fields.project ?? ''),
    String(fields.date ?? '')
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * İptal iletisinin parmak izi.
 *
 * Yeniden denemede aynı iptalin ikinci bir revizyon üretmemesi için gerekir:
 * SMTP başarılı olup kayıt güncellenemediğinde sonraki deneme aynı `SEQUENCE`
 * ile aynı iptali gönderir.
 */
export function outlookCancellationHash({ summary, date }) {
  const canonical = JSON.stringify(['CANCEL', String(summary ?? ''), String(date ?? '')]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Görevin takvimde GÖRÜNEN alanlarından biri değişti mi?
 *
 * Kalıcılık katmanı bunu görev yazıldıktan hemen sonra sorar: yanıt hayırsa
 * kuyruğa hiçbir iş yazılmaz (etiket, yorum, ilerleme gibi düzenlemeler
 * Outlook'a hiç ulaşmaz). Yanıt evetse teslim anında karma bir kez daha
 * karşılaştırılır; iki katmanlı denetim gereksiz gönderimi tümüyle keser.
 */
export function hasOutlookCalendarChange(before, after) {
  const left = outlookRevisionFields(before || {});
  const right = outlookRevisionFields(after || {});
  return left.title !== right.title || left.project !== right.project || left.date !== right.date;
}

export { outlookCalendarUid };

/**
 * Aboneliğin iCalendar belgesini üretir.
 *
 * @param {{method:'REQUEST'|'CANCEL', uid:string, sequence:number,
 *   summary:string, description?:string, date:string,
 *   organizer:object, attendee:object, link?:string|null, dtstamp?:Date}} input
 */
export function renderOutlookInvitation({
  method,
  uid,
  sequence,
  summary,
  description = '',
  date,
  organizer,
  attendee,
  link = null,
  dtstamp = new Date()
}) {
  return buildTaskCalendarDocument({
    method,
    uid,
    sequence,
    summary,
    description,
    start: date,
    organizer,
    attendee,
    url: link,
    dtstamp
  });
}
