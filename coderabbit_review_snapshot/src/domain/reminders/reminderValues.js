import { PRIORITIES, normalizePriorityId } from '../constants/index.js';
import { describeRemainingDuration } from './reminderPolicy.js';

/**
 * Görev kaydından ŞABLON DEĞERLERİNİ üretir.
 *
 * Zaman bağımlı alanlar (kalan gün/süre) gönderim anında YETKİLİ görev
 * verisinden hesaplanır; hiçbir yerde saklanmaz. Aksi hâlde bir kez üretilen
 * "3 gün kaldı" metni sonraki gönderimlerde de aynen tekrarlanırdı.
 *
 * Eksik alanlar UYDURULMAZ: değeri olmayan yer tutucu, şablon katmanında nötr
 * işaretle (—) gösterilir.
 */

const STATUS_LABELS = Object.freeze({
  todo: 'Yapılacak',
  planned: 'Yapılacak',
  'not-started': 'Yapılacak',
  in_progress: 'Devam ediyor',
  'in-progress': 'Devam ediyor',
  blocked: 'Beklemede',
  done: 'Tamamlandı',
  completed: 'Tamamlandı',
  cancelled: 'İptal edildi'
});

const MINUTES_PER_DAY = 1440;

export function reminderStatusLabel(status) {
  const key = String(status ?? '').trim().toLowerCase();
  return STATUS_LABELS[key] || (key ? key : '');
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return '';
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function dueDateAtMidnight(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * @param {object} task hatırlatma görevi
 * @param {{assigneeNames?: string[], appName?: string, now?: Date}} [context]
 * @returns {Record<string, string>} yer tutucu değerleri
 */
export function buildReminderValues(task, { assigneeNames = [], appName = 'MERGEN Rota', now = new Date() } = {}) {
  const due = dueDateAtMidnight(task?.targetFinish);
  const remainingMinutes = due ? Math.floor((due.getTime() - now.getTime()) / 60000) : null;
  const remainingDays = remainingMinutes == null ? null : Math.ceil(remainingMinutes / MINUTES_PER_DAY);
  const priority = PRIORITIES[normalizePriorityId(task?.priority)];

  return {
    task_name: task?.task || task?.title || '',
    project_name: task?.projectName || task?.proje || '',
    project_code: task?.projectCode || '',
    description: task?.description || '',
    keyword: task?.keyword || '',
    assignees: assigneeNames.filter(Boolean).join(', '),
    due_date: formatDate(task?.targetFinish),
    remaining_days: remainingDays == null ? '' : String(remainingDays),
    // Gün farkı BİRLİKTE verilir: termin günü içindeki gönderim "geçti" diye
    // anlatılmaz, `remaining_days` ile `remaining_duration` aynı günü söyler.
    remaining_duration: remainingMinutes == null ? '' : describeRemainingDuration(remainingMinutes, { remainingDays }),
    priority: priority?.label || '',
    status: reminderStatusLabel(task?.status),
    app_name: appName,
    today: formatDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    )
  };
}
