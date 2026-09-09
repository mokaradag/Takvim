import { taskCalendarDate } from '../../domain/calendar/taskCalendarDate.js';

/**
 * Outlook eyleminin SAF sunum kuralları.
 *
 * Kullanılabilirlik ve toplu sonuç özeti burada, React'ten bağımsız olarak
 * karara bağlanır; bileşenler yalnızca sonucu çizer. Arayüz, kullanılamayan bir
 * işlevi "gönderildi" gibi göstermez: nedenini açıkça yazar.
 */

export const OUTLOOK_REASONS = Object.freeze({
  DEMO: 'Outlook takvimi yalnızca Gerçek Sistem verisiyle kullanılabilir.',
  DISABLED: 'Outlook takvim tümleştirmesi bu kurulumda kapalı.',
  SCHEMA: 'Outlook takvim şeması kurulmamış. Sistem yöneticinizle görüşün.',
  MAIL: 'Sunucuda e-posta gönderimi yapılandırılmadığı için Outlook daveti gönderilemez.',
  NO_DATE: 'Görevin termin tarihi yok. Takvime eklemek için önce bir termin girin.',
  NO_TASK: 'Kaydedilmemiş görev Outlook takvimine eklenemez.'
});

/**
 * Eylem kullanılabilir mi?
 *
 * @param {{actualDataMode: boolean, state: object, task?: object|null}} input
 * @returns {{available: boolean, reason: string|null}}
 */
export function outlookActionAvailability({ actualDataMode, state, task = null }) {
  if (!actualDataMode) return { available: false, reason: OUTLOOK_REASONS.DEMO };
  if (state?.status !== 'ready') return { available: false, reason: state?.error || 'Outlook takvim durumu yükleniyor…' };
  if (state?.enabled === false) return { available: false, reason: OUTLOOK_REASONS.DISABLED };
  if (state?.schemaReady === false) return { available: false, reason: OUTLOOK_REASONS.SCHEMA };
  if (state?.mailConfigured === false) return { available: false, reason: OUTLOOK_REASONS.MAIL };
  if (task !== null) {
    if (!task?.id) return { available: false, reason: OUTLOOK_REASONS.NO_TASK };
    if (!taskCalendarDate(task)) return { available: false, reason: OUTLOOK_REASONS.NO_DATE };
  }
  return { available: true, reason: null };
}

/** Seçili görevlerden Outlook'a eklenebilecek olanlar (termini olanlar). */
export function selectableOutlookTasks(tasks = []) {
  return (tasks || []).filter((task) => task?.id && taskCalendarDate(task));
}

/**
 * Toplu sonucun TEK CÜMLELİK özeti.
 *
 * Görev başına bildirim üretilmez: kalabalık bir seçimde onlarca ileti,
 * kullanıcıya sonucu anlatmak yerine ekranı doldururdu.
 *
 * @param {{summary?: object, results?: Array<object>}} response
 * @returns {{tone: 'success'|'warning'|'error', text: string}}
 */
export function summarizeOutlookBulkResult(response) {
  const summary = response?.summary || { added: 0, alreadyAdded: 0, failed: 0, total: 0 };
  const parts = [];
  if (summary.added) parts.push(`${summary.added} görev eklendi`);
  if (summary.alreadyAdded) parts.push(`${summary.alreadyAdded} görev zaten ekliydi`);
  if (summary.queued) parts.push(`${summary.queued} görev gönderim kuyruğuna alındı`);
  if (summary.failed) parts.push(`${summary.failed} görev eklenemedi`);

  if (!parts.length) return { tone: 'error', text: 'Outlook takvimine görev eklenmedi.' };
  const text = `${parts.join(', ')}.`;
  if (summary.failed && !summary.added && !summary.alreadyAdded && !summary.queued) return { tone: 'error', text };
  if (summary.failed) return { tone: 'warning', text };
  return { tone: 'success', text };
}
