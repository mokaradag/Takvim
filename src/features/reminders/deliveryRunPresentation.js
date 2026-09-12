import { reminderRunOutcome, reminderFailureMessage } from '../../domain/reminders/reminderRunOutcome.js';
import { outlookFailureMessage } from '../../domain/outlook/outlookFailures.js';

const count = (value) => Number(value) || 0;

function failures(summary, format = outlookFailureMessage) {
  const codes = new Set([
    summary.reason,
    ...Object.keys(summary.failureCodes || {}),
    ...(summary.results || []).filter((item) => item.status === 'FAILED').map((item) => item.reason || item.code)
  ].filter(Boolean));
  if (summary.ok === false && !codes.size) codes.add('UNEXPECTED_ERROR');
  return [...new Set([...codes].map(format))].join(' ');
}

export function outlookRunSummary(summary) {
  if (summary.enabled === false) return 'Outlook tümleştirmesi: kapalı.';
  return `Outlook: ${count(summary.claimed)} iş alındı, ${count(summary.sent)} gönderildi, `
    + `${count(summary.unchanged)} değişmedi, ${count(summary.cancelled)} iptal edildi, ${count(summary.failed)} başarısız.`
    + (summary.inProgress ? ` ${count(summary.inProgress)} iş eşzamanlı değişiklik nedeniyle yeniden değerlendirilecek.` : '')
    + (summary.exhausted ? ` Deneme eşiğini aşan: ${count(summary.exhausted)}; otomatik yeniden deneme durdu.` : '')
    + (failures(summary) ? ` ${failures(summary)}` : '');
}

export function deliveryRunMessage(response) {
  const reminderResult = response.reminders || (typeof response.enabled === 'boolean' ? response : null);
  const reminders = reminderResult ? reminderRunOutcome(reminderResult) : null;
  if (!reminders && !response.outlook) {
    return { type: 'error', text: response.message || outlookFailureMessage(response.code) };
  }
  const lines = [];
  if (reminders) {
    lines.push(reminders.enabled === false
      ? 'Otomatik hatırlatma: kapalı.'
      : `Hatırlatmalar: ${count(reminders.sent)} gönderildi, ${count(reminders.skipped)} atlandı, ${count(reminders.failed)} başarısız.`
        + (reminders.partial ? ` ${count(reminders.partial)} kısmi alıcı teslimatı.` : ''));
    const reminderFailures = failures(reminders, reminderFailureMessage);
    if (reminderFailures) lines.push(reminderFailures);
  }
  if (response.outlook) lines.push(outlookRunSummary(response.outlook));
  return {
    type: response.ok === false || reminders?.ok === false || count(reminders?.failed) > 0
      || response.outlook?.ok === false ? 'error' : 'success',
    text: lines.join('\n')
  };
}
