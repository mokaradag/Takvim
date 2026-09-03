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

  function start(operation, operationKind, requestKey) {
    const promise = Promise.resolve().then(operation);
    const current = { promise, operationKind, requestKey };
    active = current;
    const clear = () => {
      if (active === current) active = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  function queueAfterActive(operation, operationKind, requestKey) {
    // Kuyrukta AYNI isteği taşıyan bir çalıştırma varsa onunla birleşilir;
    // farklı seçenek taşıyan istek onun ARDINA eklenir.
    if (queued && queued.requestKey === requestKey) return queued.promise;
    const previous = queued ? queued.promise : active.promise;
    const entry = { operationKind, requestKey };
    entry.promise = previous
      .then(() => undefined, () => undefined)
      .then(() => {
        if (queued === entry) queued = null;
        return active && active.requestKey === requestKey
          ? active.promise
          : start(operation, operationKind, requestKey);
      });
    queued = entry;
    return entry.promise;
  }

  return {
    /**
     * @param {object} [options]
     * @param {string|null} [options.requestKey] İSTEĞİN kimliği. Etkin
     *   çalıştırmanın sözünü döndürmek yalnızca aynı isteği yeniden soran
     *   çağıran için doğrudur. Farklı seçenekler taşıyan bir istek
     *   (`discardFailedTaskUpdates` / `preserveFailedTaskUpdates`) birleştirilip
     *   yutulduğunda, kullanıcının "yeniden yükle ve kaydedilmemiş değişiklikleri
     *   at" seçimi hiç çalışmıyor, çağıran da başka bir yenilemenin sonucunu
     *   alıyordu.
     */
    run(operation, {
      skipIfBusy = false,
      operationKind = 'default',
      queueIfActiveKind = null,
      requestKey = null
    } = {}) {
      if (active) {
        if (skipIfBusy) {
          return Promise.resolve({ ok: true, value: null, skipped: true, reason: 'REFRESH_IN_PROGRESS' });
        }
        if (queueIfActiveKind && active.operationKind === queueIfActiveKind) {
          return queueAfterActive(operation, operationKind, requestKey);
        }
        if (active.requestKey === requestKey) return active.promise;
        return queueAfterActive(operation, operationKind, requestKey);
      }
      return start(operation, operationKind, requestKey);
    }
  };
}
