import { outlookFailureMessage, safeOutlookFailureCode } from '../outlook/outlookFailures.js';

const MESSAGES = Object.freeze({
  TASK_NOT_FOUND: 'Hatırlatma gönderilecek görev bulunamadı.',
  PROJECT_INACTIVE: 'Görevin projesi devre dışı olduğu için hatırlatma gönderilemedi.',
  NO_RECIPIENTS: 'Hatırlatma için geçerli alıcı adresi bulunamadı.'
});

export function safeReminderFailureCode(code) {
  return Object.hasOwn(MESSAGES, code) ? code : safeOutlookFailureCode(code);
}

export function reminderFailureMessage(code) {
  const safe = safeReminderFailureCode(code);
  return Object.hasOwn(MESSAGES, safe) ? `${safe}: ${MESSAGES[safe]}` : outlookFailureMessage(safe);
}

export function reminderRunOutcome(summary = {}) {
  const failedItems = (summary.results || []).filter((item) => item.status === 'FAILED');
  const failed = Math.max(Number(summary.failed) || 0, failedItems.length);
  const ok = summary.ok !== false && failed === 0;
  return { ...summary, failed, ok,
    ...(!ok ? { reason: safeReminderFailureCode(summary.reason || failedItems[0]?.reason || failedItems[0]?.code) } : {}) };
}
