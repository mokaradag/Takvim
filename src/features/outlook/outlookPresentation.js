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
  NO_TASK: 'Kaydedilmemiş görev Outlook takvimine eklenemez.',
  COMPLETED: 'Tamamlanan görevin Outlook bağlantısı yeniden açılana kadar bekletilir.'
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
    if (task?.status === 'done') return { available: false, reason: OUTLOOK_REASONS.COMPLETED };
    if (!task?.id) return { available: false, reason: OUTLOOK_REASONS.NO_TASK };
    if (!taskCalendarDate(task)) return { available: false, reason: OUTLOOK_REASONS.NO_DATE };
  }
  return { available: true, reason: null };
}

/** Seçimi toplu Outlook eyleminin gerçek atlama nedenlerine göre ayırır. */
export function classifyOutlookBulkTasks(tasks = []) {
  const selection = { eligible: [], completed: 0, unsaved: 0, undated: 0 };
  for (const task of tasks || []) {
    if (task?.status === 'done') selection.completed += 1;
    else if (!task?.id) selection.unsaved += 1;
    else if (!taskCalendarDate(task)) selection.undated += 1;
    else selection.eligible.push(task);
  }
  return selection;
}

/** Seçili görevlerden Outlook'a eklenebilecek olanlar (termini olanlar). */
export function selectableOutlookTasks(tasks = []) {
  return classifyOutlookBulkTasks(tasks).eligible;
}

/** Yerelde atlanan görevleri gerçek nedenleriyle özetler. */
export function outlookBulkSkipText(selection = {}) {
  const parts = [];
  if (selection.completed) parts.push(`${selection.completed} tamamlanmış görev atlandı.`);
  if (selection.unsaved) parts.push(`${selection.unsaved} kaydedilmemiş görev atlandı.`);
  if (selection.undated) parts.push(`${selection.undated} görev termini olmadığı için atlandı.`);
  return parts.join(' ');
}

/** Hiç uygun görev yoksa düğmenin doğru engelleme nedenini üretir. */
export function outlookBulkBlockedReason(selection = {}) {
  if (selection.eligible?.length) return null;
  const completed = Number(selection.completed || 0);
  const unsaved = Number(selection.unsaved || 0);
  const undated = Number(selection.undated || 0);
  if (completed > 0 && unsaved === 0 && undated === 0) {
    return 'Seçilen görevlerin tümü tamamlanmış. Tamamlanan görevler Outlook takvimine eklenemez.';
  }
  if (undated > 0 && completed === 0 && unsaved === 0) {
    return 'Seçilen görevlerin takvime eklenebilecek bir termini yok.';
  }
  if (unsaved > 0 && completed === 0 && undated === 0) {
    return 'Seçilen görevler kaydedilmemiş olduğu için Outlook takvimine eklenemez.';
  }
  const detail = outlookBulkSkipText(selection);
  return detail ? `Seçilen görevlerin hiçbiri Outlook takvimine eklenemez. ${detail}` : 'Outlook takvimine eklenecek görev seçilmedi.';
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
  if (summary.added) parts.push(`${summary.added} Outlook daveti gönderildi`);
  if (summary.alreadyAdded) parts.push(`${summary.alreadyAdded} Outlook bağlantısı zaten günceldi`);
  if (summary.queued) parts.push(`${summary.queued} görev gönderim kuyruğuna alındı`);
  if (summary.failed) parts.push(`${summary.failed} görev eklenemedi`);

  if (!parts.length) return { tone: 'error', text: 'Outlook takvimine görev eklenmedi.' };
  const text = `${parts.join(', ')}.`;
  if (summary.failed && !summary.added && !summary.alreadyAdded && !summary.queued) return { tone: 'error', text };
  if (summary.failed) return { tone: 'warning', text };
  return { tone: 'success', text };
}
