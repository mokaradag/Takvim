import 'server-only';
import { businessDate } from '../../domain/calendar/businessDate.js';
import { DEFAULT_CALENDAR } from '../../scheduling/calendars/index.js';
import { hasOutlookCalendarChange } from '../../domain/outlook/outlookCalendarPayload.js';
import { sql } from '../db/pool.js';
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

async function taskCalendarTimeZone(executor, row) {
  if (!row?.ProjectId) return DEFAULT_CALENDAR.timezone;
  const request = executor.request();
  request.input('projectId', sql.UniqueIdentifier, row.ProjectId);
  request.input('calendarId', sql.UniqueIdentifier, row.CalendarId || null);
  const result = await request.query(`
    SELECT c.CalendarId AS PlanCalendarId, c.Name, c.TimeZone
    FROM dbo.MR_Projects p
    OUTER APPLY (
      SELECT TOP (1) taskCalendar.CalendarId
      FROM dbo.MR_Calendars taskCalendar
      WHERE taskCalendar.CalendarId = @calendarId AND taskCalendar.IsActive = 1
    ) taskCalendar
    OUTER APPLY (
      SELECT TOP (1) projectCalendar.CalendarId
      FROM dbo.MR_Calendars projectCalendar
      WHERE projectCalendar.CalendarId = p.CalendarId AND projectCalendar.IsActive = 1
    ) projectCalendar
    OUTER APPLY (
      SELECT TOP (1) defaultCalendar.CalendarId
      FROM dbo.MR_Calendars defaultCalendar
      WHERE defaultCalendar.IsDefault = 1 AND defaultCalendar.IsActive = 1
      ORDER BY defaultCalendar.CreatedAt, defaultCalendar.CalendarId
    ) defaultCalendar
    JOIN dbo.MR_Calendars c
      ON c.CalendarId = COALESCE(taskCalendar.CalendarId, projectCalendar.CalendarId, defaultCalendar.CalendarId)
    WHERE p.ProjectId = @projectId;
  `);
  return String(result.recordset?.[0]?.TimeZone || '').trim() || DEFAULT_CALENDAR.timezone;
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
export async function enqueueOutlookTaskChange(executor, taskId, before, after, { now = new Date() } = {}) {
  const assignees = (row) => [...new Set((row?.assigneeIds || []).map(String))].sort().join(',');
  const visibilityChanged = assignees(before) !== assignees(after)
    || String(before?.CreatedBySicil ?? '') !== String(after?.CreatedBySicil ?? '');
  const completionChanged = (before?.Status === 'done') !== (after?.Status === 'done');
  if (!completionChanged && !visibilityChanged && !hasOutlookCalendarChange(outlookTaskFields(before), outlookTaskFields(after))) return false;
  await guarded(async () => {
    const completionDate = completionChanged && after?.Status === 'done'
      ? businessDate(now, await taskCalendarTimeZone(executor, after))
      : null;
    await enqueueOutlookTaskUpdate(executor, taskId, {
      suspendCompletion: after?.Status === 'done',
      completionDate
    });
  });
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
