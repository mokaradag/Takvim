import { outlookFailureMessage, safeOutlookFailureCode } from '../outlook/outlookFailures.js';

const MESSAGES = Object.freeze({
  TASK_NOT_FOUND: 'Hatırlatma gönderilecek görev bulunamadı.',
  PROJECT_INACTIVE: 'Görevin projesi devre dışı olduğu için hatırlatma gönderilemedi.',
  NO_RECIPIENTS: 'Hatırlatma için geçerli alıcı adresi bulunamadı.',
  MAIL_DELIVERY_UNCERTAIN: 'Bazı teslimatların sonucu belirsiz; otomatik yeniden gönderilmeyecek.',
  REMINDER_TEMPLATE_TOO_LARGE: 'Hatırlatma şablonu boyut sınırını aşıyor.',
  REMINDER_RENDER_TOO_LARGE: 'Hatırlatma içeriği gönderim boyutu sınırını aşıyor.'
});

export function safeReminderFailureCode(code) {
  return Object.hasOwn(MESSAGES, code) ? code : safeOutlookFailureCode(code);
}

export function reminderFailureMessage(code) {
  const safe = safeReminderFailureCode(code);
  return Object.hasOwn(MESSAGES, safe) ? `${safe}: ${MESSAGES[safe]}` : outlookFailureMessage(safe);
}

export function reminderRunOutcome(summary = {}) {
  const failedItems = (summary.results || []).filter((item) => item.status === 'FAILED' || item.reason === 'MAIL_DELIVERY_UNCERTAIN');
  const failed = Math.max(Number(summary.failed) || 0, failedItems.length);
  const ok = summary.ok !== false && failed === 0;
  const failureCodes = { ...summary.failureCodes };
  const observedCodes = {};
  for (const item of failedItems) {
    const code = safeReminderFailureCode(item.reason || item.code);
    observedCodes[code] = (observedCodes[code] || 0) + 1;
    failureCodes[code] = Math.max(Number(summary.failureCodes?.[code]) || 0, observedCodes[code]);
  }
  return { ...summary, failed, ok, failureCodes,
    ...(!ok ? { reason: safeReminderFailureCode(summary.reason || failedItems[0]?.reason || failedItems[0]?.code) } : {}) };
}
