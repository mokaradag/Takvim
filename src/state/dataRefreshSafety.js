export function resolveDataRefreshSafety({
  hasFailedTaskUpdates = false,
  discardFailedTaskUpdates = false,
  preserveFailedTaskUpdates = false
} = {}) {
  if (!hasFailedTaskUpdates) return { ok: true, discardFailedTaskUpdates: false };
  if (discardFailedTaskUpdates) return { ok: true, discardFailedTaskUpdates: true };
  if (preserveFailedTaskUpdates) return { ok: true, discardFailedTaskUpdates: false };
  return {
    ok: false,
    error: {
      kind: 'persistence',
      code: 'UNSAVED_TASK_CHANGES',
      message: 'Kaydedilemeyen görev değişiklikleri çözülmeden veriler yenilenemez.'
    }
  };
}

/** Gerçek kalıcılık durumunu yenileme seçenekleriyle tek noktada değerlendirir. */
export function resolvePersistenceDataRefreshSafety(persistence, options = {}) {
  return resolveDataRefreshSafety({
    hasFailedTaskUpdates: Boolean(persistence?.hasFailedTaskUpdates?.()),
    discardFailedTaskUpdates: Boolean(options.discardFailedTaskUpdates),
    preserveFailedTaskUpdates: Boolean(options.preserveFailedTaskUpdates)
  });
}

/** Eşzamanlı yenilemelerde yalnızca son başlayan isteğin sonucu geçerlidir. */
export function createDataRefreshRequestGuard() {
  let latestRequestId = 0;
  return {
    begin() {
      const requestId = ++latestRequestId;
      const isCurrent = () => requestId === latestRequestId;
      return {
        isCurrent,
        settle(result = null) {
          return isCurrent()
            ? result
            : { ok: true, value: null, superseded: true };
        }
      };
    }
  };
}

/** Manuel ve otomatik yenilemeleri aynı tek-uçuş sınırında güvenle sıralar. */
export function createDataRefreshSingleFlight() {
  let active = null;
  let queued = null;

  function start(operation, operationKind) {
    const promise = Promise.resolve().then(operation);
    const current = { promise, operationKind };
    active = current;
    const clear = () => {
      if (active === current) active = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  function queueAfterActive(operation, operationKind) {
    if (queued) return queued;
    const activePromise = active.promise;
    queued = activePromise
      .then(() => undefined, () => undefined)
      .then(() => {
        queued = null;
        return active ? active.promise : start(operation, operationKind);
      });
    return queued;
  }

  return {
    run(operation, {
      skipIfBusy = false,
      operationKind = 'default',
      queueIfActiveKind = null
    } = {}) {
      if (active) {
        if (skipIfBusy) {
          return Promise.resolve({ ok: true, value: null, skipped: true, reason: 'REFRESH_IN_PROGRESS' });
        }
        if (queueIfActiveKind && active.operationKind === queueIfActiveKind) {
          return queueAfterActive(operation, operationKind);
        }
        return active.promise;
      }
      return start(operation, operationKind);
    }
  };
}
