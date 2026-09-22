import 'server-only';
import { COMPONENTS } from '../../domain/observability/eventModel.js';
import { getSqlPool } from '../db/pool.js';
import { isSmtpConfigured } from '../mail/smtpConfig.js';
import { observeOutcome } from '../observability/observeOperation.js';
import { outlookApplicationLink } from '../outlook/outlookConfig.js';
import { runTaskMailOutbox } from './taskMailService.js';

/**
 * Görev bildirim postasının arka plan çalışanı.
 *
 * Görev yazması SMTP'yi beklemez: niyet işlemle birlikte kalıcılaşır, teslimat
 * bu turda yapılır. Tur, Outlook çalışanıyla AYNI desenle kurulur; ikinci bir
 * zamanlayıcı mimarisi tanımlanmaz.
 */

const WORKER_KEY = Symbol.for('mergen-rota.task-mail-worker');
const DEFAULT_INTERVAL_MS = 30000;

/**
 * Yoklama aralığı.
 *
 * Değişken TANIMSIZ ya da boşken varsayılan uygulanır. Daha önce boş metin
 * `Number('')` ile `0`'a düşüyor, `Number.isSafeInteger(0)` doğru olduğu için
 * varsayılan hiç okunmuyor ve alt sınır kuralı aralığı 5 saniyeye çekiyordu:
 * belgelenen 30 saniye yerine altı kat sık yoklanıyor, yönetim konsolu da
 * yanlış aralığı gösteriyordu.
 */
export function taskMailPollIntervalMs() {
  const raw = String(process.env.MERGEN_ROTA_TASK_MAIL_POLL_MS ?? '').trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(300000, Math.max(5000, value));
}

async function runAutomaticTaskMailPass() {
  return observeOutcome('background.task-mail.outbox', async () => {
    let pool;
    try {
      pool = await getSqlPool();
    } catch {
      return { ok: false, reason: 'DATABASE_UNAVAILABLE' };
    }
    return runTaskMailOutbox(pool, { link: outlookApplicationLink() });
  }, { component: COMPONENTS.SMTP });
}

export function createTaskMailWorker({
  run = runAutomaticTaskMailPass,
  enabled = isSmtpConfigured,
  intervalMs = taskMailPollIntervalMs(),
  log = (result) => console.error('[task-mail] otomatik tur başarısız', result)
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
    running = Promise.resolve()
      .then(() => (enabled() ? run() : { ok: true, enabled: false }))
      .catch((error) => ({ ok: false, reason: String(error?.code || 'UNEXPECTED_ERROR') }))
      .then((result) => {
        lastResult = result;
        lastFinishedAt = new Date().toISOString();
        const failure = result?.ok === false ? result.reason || 'UNEXPECTED_ERROR' : null;
        if (failure && failure !== lastFailure) log({ reason: failure });
        lastFailure = failure;
      })
      .finally(() => {
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
    status() {
      return { started, running: Boolean(running), intervalMs, lastFinishedAt, lastResult };
    }
  };
}

export function startTaskMailWorker() {
  globalThis[WORKER_KEY] ||= createTaskMailWorker();
  return globalThis[WORKER_KEY].start();
}

export function taskMailWorkerStatus() {
  const enabled = isSmtpConfigured();
  const status = globalThis[WORKER_KEY]?.status() || {
    started: false, running: false, intervalMs: taskMailPollIntervalMs(), lastFinishedAt: null, lastResult: null
  };
  return { ...status, enabled, automatic: enabled && status.started };
}
