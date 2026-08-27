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
