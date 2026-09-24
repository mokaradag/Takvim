import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AiError } from './aiErrors.js';

/**
 * Yapay zekâ işinin süre sınırı ve iptali.
 *
 * Tek bir `AbortSignal`, hem süre dolmasını hem de istemcinin iptalini taşır;
 * hangisinin ÖNCE gerçekleştiği korunur ki zaman aşımı ile iptal ayrı
 * kodlarla bildirilsin. `dispose()` zamanlayıcıyı ve üst sinyal dinleyicisini
 * HER yolda temizler; zamanlayıcı yalnızca iş sürerken yaşar.
 */
export function createAiDeadline({ timeoutMs, parentSignal = null, now = Date.now }) {
  const controller = new AbortController();
  const startedAt = now();
  const budgetMs = Math.max(1, Math.trunc(Number(timeoutMs) || 1));
  let failure = null;

  const abort = (code) => {
    if (failure) return;
    failure = new AiError(code, code === AI_ERROR_CODES.AI_TIMEOUT ? { details: { timeoutMs: budgetMs } } : {});
    controller.abort(failure);
  };
  const timer = setTimeout(() => abort(AI_ERROR_CODES.AI_TIMEOUT), budgetMs);
  const onParentAbort = () => abort(AI_ERROR_CODES.AI_CANCELLED);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    /** Süre dolduysa ya da iptal edildiyse sınıflandırılmış hata; aksi hâlde `null`. */
    failure: () => failure,
    remainingMs: () => Math.max(0, budgetMs - (now() - startedAt)),
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
  };
}

/**
 * Sözü sinyale bağlar: sinyal kesilince söz beklenmeden reddedilir.
 *
 * Sinyale uymayan bir alt yürütücü bile kapasiteyi ve çağıranı askıda
 * bırakamaz; dinleyici her yolda kaldırılır.
 */
export function raceWithAbort(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(work), aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

/** İptal edilebilir bekleme; her iki yolda da zamanlayıcı ve dinleyici temizlenir. */
export function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
