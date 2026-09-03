import { loadApplicationData } from './persistence.js';
import { resolvePersistenceDataRefreshSafety } from './dataRefreshSafety.js';
import { shouldSurfaceAutomaticRefreshFailure } from './automaticDataRefresh.js';

/**
 * Yenileme türünü ortak tek-uçuş ilkesine dönüştürür.
 *
 * `requestKey`, isteğin SEÇENEKLERİNİ de taşır: kaydedilmemiş değişiklikleri
 * atma ya da koruma kararı, süren bir yenilemeyle birleştirilip yutulmamalıdır.
 */
export function dataReloadSingleFlightOptions(refreshMode = 'manual', {
  discardFailedTaskUpdates = false,
  preserveFailedTaskUpdates = false
} = {}) {
  return {
    skipIfBusy: refreshMode === 'automatic',
    operationKind: refreshMode,
    queueIfActiveKind: refreshMode === 'automatic' ? null : 'automatic',
    requestKey: `${refreshMode}:${discardFailedTaskUpdates ? 1 : 0}:${preserveFailedTaskUpdates ? 1 : 0}`
  };
}

/**
 * Uygulama veri yenilemesinin üretimde ve testte ortak yürütme yolu.
 *
 * Tek-uçuş kararı dışarıda kalır; bu işlem bekleyen yazmaları boşaltır,
 * yenileme güvenliğini denetler ve sonucu uygulama durumuna işler.
 */
export function createDataReloadOperation({
  repository,
  persistence,
  getState,
  applyStateAction,
  requestGuard,
  now = () => new Date().toISOString()
}) {
  return async function runDataReload({
    discardFailedTaskUpdates = false,
    preserveFailedTaskUpdates = false,
    refreshMode = 'manual'
  } = {}) {
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;
    const refreshSafety = resolvePersistenceDataRefreshSafety(persistence, {
      discardFailedTaskUpdates,
      preserveFailedTaskUpdates
    });
    if (!refreshSafety.ok) return refreshSafety;

    const request = requestGuard.begin();
    const backgroundRefresh = refreshMode === 'automatic' && getState().hasLoadedOnce;
    if (!backgroundRefresh) applyStateAction({ type: 'data/load-start' });
    return persistence.runSerialized(async () => {
      if (!request.isCurrent()) return request.settle();

      const result = await loadApplicationData(repository, { refreshMode });
      if (!request.isCurrent()) return request.settle(result);

      if (result.ok) {
        if (refreshSafety.discardFailedTaskUpdates) persistence.discardFailedTaskUpdates();
        const rebased = preserveFailedTaskUpdates
          ? persistence.rebaseFailedTaskUpdates(result.snapshot)
          : { snapshot: result.snapshot, missingTaskIds: [] };
        applyStateAction({
          type: 'data/load-success',
          snapshot: rebased.snapshot,
          preserveSaveError: preserveFailedTaskUpdates && persistence.hasFailedTaskUpdates(),
          refreshedAt: now()
        });
        if (rebased.missingTaskIds.length) {
          const error = {
            kind: 'persistence',
            code: 'TASK_NOT_FOUND',
            message: 'Kaydedilemeyen değişikliklere ait görev artık bulunamıyor.',
            operation: 'task/update',
            details: { taskIds: rebased.missingTaskIds }
          };
          applyStateAction({ type: 'persistence/failure', error });
          return { ok: false, error };
        }
      } else if (!backgroundRefresh || shouldSurfaceAutomaticRefreshFailure(result.error)) {
        applyStateAction({ type: 'data/load-error', error: result.error });
      }
      return result;
    });
  };
}
