import { formatCalendarDay } from './outlookCalendarPayload.js';

/**
 * Takvim davetini taşıyan iletinin OKUNABİLİR gövdesi.
 *
 * Davetin kendisi `text/calendar` parçasındadır; buradaki metin/HTML yedek
 * gösterimdir. Takvim eklentisini işlemeyen bir istemcide kullanıcı yine de ne
 * olduğunu görür.
 *
 * Gövde, takvim öğesinin taşıdığından FAZLA bilgi taşımaz: sorumlu listesi,
 * açıklama ve durum alanları bilinçli olarak dışarıdadır.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CANCEL_NOTE = 'Bu görev için Outlook takvim iptali gönderildi.';
const REQUEST_NOTE = 'Bu görev için Outlook daveti gönderildi. Termin değiştiğinde MERGEN Rota aynı takvim öğesi için güncelleme gönderir.';

/**
 * @param {{method:'REQUEST'|'CANCEL', payload:{summary:string, date:string,
 *   fields:{title:string, project:string}}, link?:string|null}} input
 * @returns {{subject:string, text:string, html:string}}
 */
export function renderOutlookInvitationMail({ method, payload, link = null }) {
  const cancelled = method === 'CANCEL';
  const title = payload?.fields?.title || payload?.summary || '';
  const project = payload?.fields?.project || '';
  const day = formatCalendarDay(payload?.date);
  const subject = `${cancelled ? 'İptal' : 'Takvim daveti'}: ${payload?.summary || title}`;

  const rows = [['Görev', title]];
  if (project) rows.push(['Proje', project]);
  if (day) rows.push(['Termin', day]);

  const text = [
    cancelled ? CANCEL_NOTE : REQUEST_NOTE,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(link ? ['', `MERGEN Rota: ${link}`] : [])
  ].join('\r\n');

  const html = [
    '<div style="font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #1f2937;">',
    `<p style="margin: 0 0 14px; line-height: 1.55;">${escapeHtml(cancelled ? CANCEL_NOTE : REQUEST_NOTE)}</p>`,
    '<table style="border-collapse: collapse;">',
    ...rows.map(([label, value]) => (
      '<tr>'
      + `<td style="padding: 6px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>${escapeHtml(label)}</strong></td>`
      + `<td style="padding: 6px 10px; border: 1px solid #e5e7eb;">${escapeHtml(value)}</td>`
      + '</tr>'
    )),
    '</table>',
    link
      ? `<p style="margin: 14px 0 0;"><a href="${escapeHtml(link)}" style="color: #2563eb;">MERGEN Rota</a></p>`
      : '',
    '</div>'
  ].join('');

  return { subject, text, html };
}
