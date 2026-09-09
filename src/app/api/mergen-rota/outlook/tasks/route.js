import { readOutlookRequestBody } from '../../../../../server/outlook/outlookRequestBody.js';
import { extractActualId } from '../../../../../domain/identity/actualId.js';
import { loadAuthorizationContext } from '../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { isSmtpConfigured } from '../../../../../server/mail/smtpConfig.js';
import {
  addTasksToOutlook,
  loadOutlookCalendarState,
  outlookMessage,
  outlookSchemaProblem
} from '../../../../../server/outlook/outlookCalendarService.js';
import {
  isOutlookCalendarEnabled,
  outlookApplicationLink,
  outlookBulkLimit
} from '../../../../../server/outlook/outlookConfig.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Kullanıcının Outlook takvim aboneliklerinin toplu ucu.
 *
 *  - `GET`  · arayüzün "eklendi" durumu ve özelliğin kullanılabilirliği.
 *  - `POST` · seçili görevlerin TOPLU eklenmesi.
 *
 * Toplu uç, her görev için yetkiyi BAĞIMSIZ olarak yeniden denetler; kullanıcı
 * göremediği bir görev kimliği gönderdiğinde o görev sessizce reddedilir ve
 * ötekiler işlenmeye devam eder. Her görev kendi bağımsız iCalendar davetini
 * alır: görevler tek bir randevuda birleştirilmez.
 */

/** İstek gövdesinin kabul ettiği EN ÇOK kimlik sayısı (sunucu sınırı). */
function requestedTaskIds(body, limit) {
  const raw = Array.isArray(body?.taskIds) ? body.taskIds : [];
  const ids = new Set();
  for (const value of raw) {
    const taskId = extractActualId(value);
    if (taskId) ids.add(taskId.toLowerCase());
  }
  return ids.size > limit ? { ok: false, requested: ids.size } : { ok: true, ids: [...ids] };
}

export async function GET() {
  try {
    const enabled = isOutlookCalendarEnabled();
    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    const state = enabled
      ? await loadOutlookCalendarState(pool, { sicil: actor.sicil })
      : { schemaReady: false, tasks: [] };
    return Response.json({
      ok: true,
      enabled,
      // Arayüz, posta gönderimi kapalıyken eylemi "gönderildi" gibi göstermez;
      // nedenini açıkça yazar.
      mailConfigured: isSmtpConfigured(),
      schemaReady: state.schemaReady,
      bulkLimit: outlookBulkLimit(),
      tasks: state.tasks
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

export async function POST(request) {
  try {
    if (!isOutlookCalendarEnabled()) {
      throw new ServerPersistenceError('FORBIDDEN', outlookMessage('DISABLED'));
    }
    const limit = outlookBulkLimit();
    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    const body = await readOutlookRequestBody(request);
    const requested = requestedTaskIds(body, limit);
    if (!requested.ok) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        `Tek seferde en çok ${limit} görev Outlook takvimine eklenebilir.`,
        { status: 400 }
      );
    }
    if (!requested.ids.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Eklenecek görev seçilmedi.', { status: 400 });
    }

    const link = outlookApplicationLink(request?.url || null);

    let outcome;
    try {
      outcome = await addTasksToOutlook(pool, { taskIds: requested.ids, sicil: actor.sicil, link, limit });
    } catch (error) {
      const problem = outlookSchemaProblem(error);
      if (!problem) throw error;
      throw new ServerPersistenceError('MUTATION_FAILED', problem.message, { status: 503 });
    }

    if (!outcome.ok) {
      throw new ServerPersistenceError(
        'MUTATION_FAILED',
        `Tek seferde en çok ${outcome.limit} görev Outlook takvimine eklenebilir.`,
        { status: 400 }
      );
    }

    return Response.json({
      ok: true,
      limit: outcome.limit,
      summary: outcome.summary,
      // Her görev için AYRI sonuç döner: arayüz kısmi başarıyı tek bir özetle
      // anlatabilir, yığın hâlinde bildirim üretmez.
      results: outcome.results.map((item) => ({
        taskId: item.taskId,
        status: item.status,
        subscribed: item.subscribed ?? item.status === 'ALREADY_ADDED',
        pending: item.pending ?? false,
        delivered: item.delivered ?? item.status === 'ALREADY_ADDED',
        code: item.code || null,
        message: item.message || null
      }))
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
