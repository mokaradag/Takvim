import { reminderRunOutcome, reminderFailureMessage } from '../../../../../domain/reminders/reminderRunOutcome.js';
import { loadAuthorizationContext } from '../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { runOutlookCalendarOutbox } from '../../../../../server/outlook/outlookCalendarService.js';
import { isOutlookCalendarEnabled, outlookApplicationLink, outlookMaxAttempts, outlookRunBudgetMs } from '../../../../../server/outlook/outlookConfig.js';
import { outlookFailureCode } from '../../../../../server/outlook/outlookFailure.js';
import { outlookFailureMessage, safeOutlookFailureCode } from '../../../../../domain/outlook/outlookFailures.js';
import { outlookWorkerStatus } from '../../../../../server/outlook/outlookWorker.js';
import { outlookQueueStatus } from '../../../../../server/outlook/outlookStore.js';
import { outlookDeadline, outlookExecutor } from '../../../../../server/outlook/outlookExecution.js';
import { hasReminderSchedulerKey } from '../../../../../server/reminders/reminderAccess.js';
import { runAutomaticReminders } from '../../../../../server/reminders/reminderService.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function runErrorResponse(error) {
  if (error instanceof ServerPersistenceError) return safeErrorResponse(error);
  const code = outlookFailureCode(error);
  console.error('[reminders] tur ucu işlenemedi', { code });
  return Response.json({ error: { code, message: outlookFailureMessage(code) } }, { status: 503 });
}

/** Hatırlatma zamanlayıcısı ve yöneticinin tanı turu. */
export async function POST(request) {
  try {
    const pool = await getSqlPool();
    let actorSicil = null;

    if (!hasReminderSchedulerKey(request)) {
      const actor = await loadAuthorizationContext(pool);
      if (!actor.isSystemAdmin) {
        throw new ServerPersistenceError('FORBIDDEN', 'Otomatik hatırlatma turu yalnızca zamanlayıcı anahtarıyla ya da sistem yöneticisiyle çalıştırılabilir.');
      }
      actorSicil = actor.sicil;
    }

    const runSafely = async (name, operation) => {
      try { return await operation(); }
      catch (error) {
        const reason = outlookFailureCode(error);
        console.error(`[${name}] tur işlenemedi`, { reason });
        return { ok: false, reason };
      }
    };
    const outlookEnabled = isOutlookCalendarEnabled();
    const [reminderResult, outlookResult] = await Promise.all([
      runSafely('reminders', () => runAutomaticReminders(pool, { actorSicil })),
      outlookEnabled ? runSafely('outlook', () => runOutlookCalendarOutbox(pool, {
        link: outlookApplicationLink(),
        budgetMs: hasReminderSchedulerKey(request) ? outlookRunBudgetMs() : Math.min(10000, outlookRunBudgetMs())
      })) : Promise.resolve({ ok: true })
    ]);
    const reminders = reminderRunOutcome(reminderResult);
    const outlook = { ...outlookResult, enabled: outlookEnabled };
    const ok = reminders.ok !== false && outlook.ok !== false;
    const reason = outlook.ok === false ? safeOutlookFailureCode(outlook.reason) : reminders.reason;
    const message = outlook.ok === false ? outlookFailureMessage(reason) : reminderFailureMessage(reason);
    return Response.json({
      ...reminders, ok, reminders, outlook,
      ...(!ok ? { error: { code: reason, message } } : {})
    }, {
      status: ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) { return runErrorResponse(error); }
}

export async function GET() {
  try {
    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    if (!actor.isSystemAdmin) throw new ServerPersistenceError('FORBIDDEN', 'Gönderim durumu yalnızca sistem yöneticisine açıktır.');
    const outlook = outlookWorkerStatus();
    const execution = outlookDeadline(5000);
    try {
      outlook.queue = await outlookQueueStatus(outlookExecutor(pool, execution.signal), outlookMaxAttempts());
    } catch (error) {
      outlook.reason = execution.signal.aborted ? 'DATABASE_TIMEOUT' : outlookFailureCode(error);
    } finally { execution.close(); }
    return Response.json({ outlook }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return runErrorResponse(error); }
}
