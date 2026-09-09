import 'server-only';
import { renewOutlookLease } from './outlookStore.js';

export function outlookDeadline(timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('OUTLOOK_RUN_TIMEOUT')), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  return { signal, abort: (reason) => controller.abort(reason), close: () => clearTimeout(timer) };
}

export async function abortableOutlookOperation(operation, signal, cancel = () => {}) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => { try { cancel(); } finally { reject(signal.reason); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function outlookExecutor(executor, signal) {
  return {
    request() {
      const request = executor.request();
      const query = request.query.bind(request);
      request.query = (text) => abortableOutlookOperation(() => query(text), signal, () => request.cancel?.());
      return request;
    }
  };
}

export function keepOutlookLease(executor, subscription, execution, intervalMs = 20000) {
  let stopped = false;
  let timer;
  let renewal = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      const deadline = outlookDeadline(Math.min(5000, intervalMs), execution.signal);
      renewal = renewOutlookLease(outlookExecutor(executor, deadline.signal), subscription).then((owned) => {
        if (!owned) execution.abort(new Error('OUTLOOK_LEASE_LOST'));
      }).catch(() => execution.abort(new Error('OUTLOOK_LEASE_LOST'))).finally(() => {
        deadline.close();
        if (!stopped && !execution.signal.aborted) schedule();
      });
    }, intervalMs);
  };
  schedule();
  return async () => { stopped = true; clearTimeout(timer); await renewal; };
}
