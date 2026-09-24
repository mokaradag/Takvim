import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AiError } from './aiErrors.js';

/** Kapasite doluyken istemciye önerilen bekleme. */
const BUSY_RETRY_AFTER_MS = 2000;

/**
 * Yapay zekâ isteklerinin SINIRLI eşzamanlılık denetimi; küresel kilit yoktur.
 *
 * Küresel ve kullanıcı başına etkin/sıra sınırları (isteğe bağlı model sınırı)
 * birlikte uygulanır. Sıra doluysa istek bekletilmez, AI_BUSY ile hemen döner.
 * Sıra FIFO'dur ama kendi sınırına takılmış bekleyen arkasındakileri
 * engellemez; her serbest bırakma sırayı yeniden tarar.
 */
export function createAiAdmissionController({ limits, now = Date.now, onChange = null }) {
  const { maxActive, maxQueued, maxActivePerUser, maxQueuedPerUser } = limits;
  const waiters = [];
  const activeByUser = new Map();
  const queuedByUser = new Map();
  const activeByModel = new Map();
  const counters = { admitted: 0, rejectedBusy: 0, queueTimeouts: 0, cancelledWhileQueued: 0 };
  let active = 0;

  const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const decrement = (map, key) => {
    const next = (map.get(key) || 0) - 1;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  };

  function status() {
    return {
      active,
      queued: waiters.length,
      activeUsers: activeByUser.size,
      queuedUsers: queuedByUser.size,
      limits: { maxActive, maxQueued, maxActivePerUser, maxQueuedPerUser },
      counters: { ...counters }
    };
  }

  function notify() {
    if (!onChange) return;
    try {
      onChange(status());
    } catch {
      // Ölçüm hatası kapasite denetimini bozmaz.
    }
  }

  const modelSaturated = (modelKey, modelLimit) => modelKey != null && modelLimit != null
    && (activeByModel.get(modelKey) || 0) >= modelLimit;

  function hasCapacity(userKey, modelKey, modelLimit) {
    if (active >= maxActive) return false;
    if ((activeByUser.get(userKey) || 0) >= maxActivePerUser) return false;
    return !modelSaturated(modelKey, modelLimit);
  }

  /**
   * İsteği hemen başlatmayan sınır: `global` ya da `model` paylaşılan
   * kapasitedir; `user` yalnızca o kullanıcının kendi etkin sınırıdır.
   */
  function saturationOf(userKey, modelKey, modelLimit) {
    if (active >= maxActive) return 'global';
    if (modelSaturated(modelKey, modelLimit)) return 'model';
    if ((activeByUser.get(userKey) || 0) >= maxActivePerUser) return 'user';
    return 'global';
  }

  function start(userKey, modelKey, queueWaitMs) {
    active += 1;
    increment(activeByUser, userKey);
    // Model kimliği olmayan iş (ör. anahtar doğrulaması) model sayacına girmez.
    if (modelKey != null) increment(activeByModel, modelKey);
    counters.admitted += 1;
    let released = false;
    return {
      queueWaitMs,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        decrement(activeByUser, userKey);
        if (modelKey != null) decrement(activeByModel, modelKey);
        drain();
        notify();
      }
    };
  }

  function leaveQueue(waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    decrement(queuedByUser, waiter.userKey);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
  }

  function drain() {
    for (let index = 0; index < waiters.length && active < maxActive;) {
      const waiter = waiters[index];
      if (!hasCapacity(waiter.userKey, waiter.modelKey, waiter.modelLimit)) {
        index += 1;
        continue;
      }
      leaveQueue(waiter);
      waiter.resolve(start(waiter.userKey, waiter.modelKey, Math.max(0, now() - waiter.enqueuedAt)));
    }
  }

  /**
   * Kapasite ister. Söz, `release()` taşıyan bir kira ile çözülür; kira her
   * yolda (başarı, hata, süre aşımı, iptal) çağıran tarafından bırakılmalıdır.
   *
   * `modelKey` verilmezse (`null`) istek model sayacına hiç girmez: kayıttaki
   * hiçbir model kimliği, sağlayıcı düzeyindeki işle aynı sayacı paylaşamaz.
   */
  function acquire({ userKey, modelKey = null, modelLimit = null, signal = null, timeoutMs }) {
    const user = String(userKey);
    const model = modelKey == null ? null : String(modelKey);
    if (signal?.aborted) return Promise.reject(new AiError(AI_ERROR_CODES.AI_CANCELLED));
    if (hasCapacity(user, model, modelLimit)) {
      const lease = start(user, model, 0);
      notify();
      return Promise.resolve(lease);
    }
    const busy = (scope) => {
      counters.rejectedBusy += 1;
      notify();
      return Promise.reject(new AiError(AI_ERROR_CODES.AI_BUSY, {
        retryAfterMs: BUSY_RETRY_AFTER_MS,
        details: { scope, saturation: saturationOf(user, model, modelLimit) }
      }));
    };
    if ((queuedByUser.get(user) || 0) >= maxQueuedPerUser) return busy('user');
    if (waiters.length >= maxQueued) return busy('global');

    return new Promise((resolve, reject) => {
      const waiter = { userKey: user, modelKey: model, modelLimit, signal, enqueuedAt: now(), resolve, timer: null, onAbort: null };
      waiter.onAbort = () => {
        leaveQueue(waiter);
        counters.cancelledWhileQueued += 1;
        notify();
        reject(new AiError(AI_ERROR_CODES.AI_CANCELLED));
      };
      waiter.timer = setTimeout(() => {
        const saturation = saturationOf(waiter.userKey, waiter.modelKey, waiter.modelLimit);
        leaveQueue(waiter);
        counters.queueTimeouts += 1;
        notify();
        reject(new AiError(AI_ERROR_CODES.AI_QUEUE_TIMEOUT, {
          retryAfterMs: BUSY_RETRY_AFTER_MS,
          details: { queueTimeoutMs: timeoutMs, queueWaitMs: Math.max(0, now() - waiter.enqueuedAt), saturation }
        }));
      }, Math.max(1, Number(timeoutMs) || 1));
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      waiters.push(waiter);
      increment(queuedByUser, user);
      notify();
    });
  }

  return { acquire, status };
}
