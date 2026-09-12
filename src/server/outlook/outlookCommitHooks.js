import 'server-only';
import { hasOutlookCalendarChange } from '../../domain/outlook/outlookCalendarPayload.js';
import {
  enqueueOutlookProjectUpdate,
  enqueueOutlookTaskCancellation,
  enqueueOutlookTaskUpdate,
  isMissingOutlookSchema
} from './outlookStore.js';

/**
 * Kalıcılık işleminin Outlook takvim kancaları.
 *
 * İki kural bilinçlidir:
 *
 *  1. Kuyruğa yazma, görev yazmasıyla AYNI işlemdedir: değişiklik kalıcı
 *     olduysa kuyruk kaydı da kalıcıdır, olmadıysa ikisi de yoktur. Hiçbir SMTP
 *     çağrısı bu yolda yapılmaz — posta sunucusu erişilemez olsa da görev kaydı
 *     tamamlanır.
 *  2. Takvim alanları veya görünürlük değiştiğinde kuyruk yazılır; aynı
 *     içerik teslimat sırasında elenir. Özelliği kapatmak kuyruğu durdurmaz.
 */

function day(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * SQL görev satırının takvimde GÖRÜNEN alanları.
 *
 * Proje KİMLİĞİ, randevu açıklamasındaki proje künyesinin vekilidir: künye
 * metni yalnızca projenin kendisi yeniden adlandırıldığında değişir ve o durum
 * `enqueueOutlookProjectChange` ile ele alınır.
 */
export function outlookTaskFields(row) {
  return {
    task: row?.Title ?? '',
    targetFinish: day(row?.TargetFinish),
    plannedFinish: day(row?.PlannedFinish),
    projectName: String(row?.ProjectId ?? '')
  };
}

/**
 * Kancayı EN İYİ ÇABAYLA çalıştırır.
 *
 * 0010 yükseltmesi henüz uygulanmamışsa (tablo yok) görev kaydı etkilenmez:
 * özellik kapalı davranır. Bunun dışındaki hatalar yukarı taşınır.
 */
async function guarded(work) {
  try {
    await work();
  } catch (error) {
    if (!isMissingOutlookSchema(error)) throw error;
  }
}

/** Görev yazıldıktan sonra: takvim alanları değiştiyse kuyruğa alınır. */
export async function enqueueOutlookTaskChange(executor, taskId, before, after) {
  const assignees = (row) => [...new Set((row?.assigneeIds || []).map(String))].sort().join(',');
  const visibilityChanged = assignees(before) !== assignees(after)
    || String(before?.CreatedBySicil ?? '') !== String(after?.CreatedBySicil ?? '');
  if (!visibilityChanged && !hasOutlookCalendarChange(outlookTaskFields(before), outlookTaskFields(after))) return false;
  await guarded(() => enqueueOutlookTaskUpdate(executor, taskId));
  return true;
}

/** Görev silindiğinde etkin abonelikler iptal için kuyruğa alınır. */
export async function enqueueOutlookTaskRemoval(executor, taskId) {
  await guarded(() => enqueueOutlookTaskCancellation(executor, taskId));
}

/** Proje künyesi değiştiğinde o projenin abonelikleri kuyruğa alınır. */
export async function enqueueOutlookProjectChange(executor, projectId, before, after) {
  const changed = String(before?.ProjectName ?? '') !== String(after?.ProjectName ?? '')
    || String(before?.ProjectCode ?? '') !== String(after?.ProjectCode ?? '')
    || String(before?.LeadSicil ?? '') !== String(after?.LeadSicil ?? '')
    || before?.IsActive !== after?.IsActive
    || before?.SourceType !== after?.SourceType;
  if (!changed) return false;
  await enqueueOutlookProjectRefresh(executor, projectId);
  return true;
}

export async function enqueueOutlookProjectRefresh(executor, projectId) {
  await guarded(() => enqueueOutlookProjectUpdate(executor, projectId));
}
