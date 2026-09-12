import 'server-only';
import { getSqlPool } from '../db/pool.js';
import { runOutlookCalendarOutbox } from './outlookCalendarService.js';
import { isOutlookCalendarEnabled, outlookApplicationLink, outlookPollIntervalMs } from './outlookConfig.js';
import { outlookFailureCode } from './outlookFailure.js';
import { abortableOutlookOperation, outlookDeadline } from './outlookExecution.js';
import { observeOutcome } from '../observability/observeOperation.js';
import { COMPONENTS } from '../../domain/observability/eventModel.js';

const WORKER_KEY = Symbol.for('mergen-rota.outlook-worker');

async function runAutomaticOutlookPass() {
  const connection = outlookDeadline(15000);
  let pool;
  try { pool = await abortableOutlookOperation(getSqlPool, connection.signal); }
  catch (error) {
    return { ok: false, reason: connection.signal.aborted ? 'DATABASE_TIMEOUT' : outlookFailureCode(error) };
  } finally { connection.close(); }
  // Tur süresi ve sonucu ölçülür; ölçüm turun davranışını değiştirmez.
  return observeOutcome('background.outlook.outbox',
    () => runOutlookCalendarOutbox(pool, { link: outlookApplicationLink() }),
    { component: COMPONENTS.OUTLOOK });
}

export function createOutlookWorker({
  run = runAutomaticOutlookPass,
  enabled = isOutlookCalendarEnabled,
  intervalMs = outlookPollIntervalMs(),
  log = (result) => console.error('[outlook] otomatik tur başarısız', result)
} = {}) {
  let started = false;
  let timer = null;
  let running = null;
  let lastFinishedAt = null;
  let lastResult = null;
  let lastFailure = null;

  const schedule = (delay) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = () => {
    timer = null;
    if (!started || running) return;
    running = Promise.resolve().then(() => enabled() ? run() : { ok: true, enabled: false })
      .catch((error) => ({ ok: false, reason: outlookFailureCode(error) }))
      .then((result) => {
        lastResult = result;
        lastFinishedAt = new Date().toISOString();
        const failure = result.ok === false ? result.reason || 'UNEXPECTED_ERROR' : null;
        if (failure && failure !== lastFailure) log({ reason: failure, failureCodes: result.failureCodes || {} });
        lastFailure = failure;
      }).finally(() => {
        running = null;
        if (started) schedule(intervalMs);
      });
  };

  return {
    start() {
      if (!started) { started = true; schedule(0); }
      return this;
    },
    async stop() {
      started = false;
      clearTimeout(timer);
      timer = null;
      await running;
    },
    status() { return { started, running: Boolean(running), intervalMs, lastFinishedAt, lastResult }; }
  };
}

export function startOutlookWorker() {
  globalThis[WORKER_KEY] ||= createOutlookWorker();
  return globalThis[WORKER_KEY].start();
}

export function outlookWorkerStatus() {
  const enabled = isOutlookCalendarEnabled();
  const status = globalThis[WORKER_KEY]?.status() || {
    started: false, running: false, intervalMs: outlookPollIntervalMs(), lastFinishedAt: null, lastResult: null
  };
  return { ...status, enabled, automatic: enabled && status.started };
}
