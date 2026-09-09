import { loadOutlookSubscription } from '../../../../../../server/outlook/outlookStore.js';
import { extractActualId } from '../../../../../../domain/identity/actualId.js';
import { loadAuthorizationContext } from '../../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import {
  addTaskToOutlook,
  outlookMessage,
  outlookSchemaProblem,
  removeTaskFromOutlook,
  resendTaskInvitation
} from '../../../../../../server/outlook/outlookCalendarService.js';
import { isOutlookCalendarEnabled, outlookApplicationLink } from '../../../../../../server/outlook/outlookConfig.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Görevi kullanıcının KENDİ Outlook takvimine ekler, daveti yeniden gönderir ya
 * da takvimden kaldırır.
 *
 * Alıcı istek gövdesinden ALINMAZ: kullanıcının kurumsal e-posta adresi
 * sunucuda Sicil üzerinden çözülür. Gövde hiç okunmaz, böylece uç açık bir
 * posta rölesine dönüşemez.
 *
 * Görünürlük istemciye bırakılmaz: görevi görme yetkisi her istekte SQL'de
 * yeniden değerlendirilir. Görevi GÖREBİLEN herkes onu kendi takvimine
 * ekleyebilir; görev düzenleme yetkisi aranmaz.
 */

const STATUS_CODES = Object.freeze({
  TASK_NOT_FOUND: 404,
  NOT_SUBSCRIBED: 404,
  FORBIDDEN: 403,
  SMTP_NOT_CONFIGURED: 503,
  SMTP_CONFIG_INVALID: 503,
  OUTLOOK_SCHEMA_MISSING: 503
});

async function handle(request, context, action) {
  try {
    if (!isOutlookCalendarEnabled()) {
      throw new ServerPersistenceError('FORBIDDEN', outlookMessage('DISABLED'));
    }
    const taskId = extractActualId((await context?.params)?.taskId);
    if (!taskId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir görev kimliği gereklidir.', { status: 400 });
    }

    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    const link = outlookApplicationLink(request?.url || null);

    let result;
    try {
      result = await action(pool, { taskId, sicil: actor.sicil, link, queueOnly: true });
    } catch (error) {
      const problem = outlookSchemaProblem(error);
      if (!problem) throw error;
      result = problem;
    }

    const row = result.code === 'OUTLOOK_SCHEMA_MISSING' ? null : await loadOutlookSubscription(pool, taskId, actor.sicil);
    const state = {
      subscribed: Boolean(row?.isActive),
      pending: Boolean(row?.pendingMethod),
      delivered: Boolean(row?.isActive && row?.deliveredSequence != null),
      failureCode: result.status === 'FAILED' ? result.code : null
    };

    if (result.status === 'FAILED' || result.status === 'NOT_FOUND' || result.status === 'FORBIDDEN'
      || result.status === 'NOT_SUBSCRIBED') {
      const status = STATUS_CODES[result.code] || STATUS_CODES[result.status] || 422;
      return Response.json({
        ...state,
        error: { code: result.code || result.status, message: result.message, details: null }
      }, { status, headers: { 'cache-control': 'no-store' } });
    }

    return Response.json({
      ok: true,
      status: result.status,
      message: result.message,
      ...state
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

export function POST(request, context) {
  return handle(request, context, (pool, input) => addTaskToOutlook(pool, input));
}

export function PUT(request, context) {
  return handle(request, context, (pool, input) => resendTaskInvitation(pool, input));
}

export function DELETE(request, context) {
  return handle(request, context, (pool, input) => removeTaskFromOutlook(pool, input));
}
