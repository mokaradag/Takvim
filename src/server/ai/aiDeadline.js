import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AiError } from './aiErrors.js';

/**
 * Kapasite kirasından ÖNCEKİ rehber üyeliği denetiminin bütçesi. Denetim
 * sınırlı sayıda eşzamanlı SQL sorgusuyla yapılır (bkz. aiCredentialService);
 * bekleme ve sorgu bu süreyle sınırlıdır ve istemci süreleri bunu da kapsar.
 */
export const AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS = 5000;

/** Kişisel anahtar doğrulamasının (kiradan sonra) üst süresi. */
export const AI_VALIDATION_TIMEOUT_MS = 15000;

/** Doğrulamanın sunucudaki uçtan uca bütçesi: rehber denetimi + sıra + doğrulama. */
export function aiValidationBudgetMs(config) {
  return AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS + config.queueTimeoutMs + Math.min(AI_VALIDATION_TIMEOUT_MS, config.requestTimeoutMs);
}

/**
 * Sağlayıcı İLERLEME gözcüsü (canlı tutma değil): istek gönderildikten sonra ilk
 * anlamlı akış olayı (rol, metin, akıl yürütme, araç parçası) `firstEventMs`,
 * sonrakiler `idleMs` içinde gelmezse sinyal `AI_TIMEOUT` (`PROVIDER_STALLED`)
 * ile kesilir; aradaki SSE yorum satırları ya da boş parçalar süreyi uzatmaz.
 * Üst sinyalin kesilmesi gözcüyü de keser (nedeni korunur). `dispose()` her
 * yolda zamanlayıcıyı ve dinleyiciyi bırakır. Sınırlar yapılandırmadan gelir
 * (`MERGEN_ROTA_AI_PROVIDER_*_TIMEOUT_MS`).
 */
export function createProgressWatch({ firstEventMs, idleMs, parentSignal = null }) {
  const controller = new AbortController();
  let failure = null;
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      failure = new AiError(AI_ERROR_CODES.AI_TIMEOUT, { details: { reason: 'PROVIDER_STALLED', idleMs: ms } });
      controller.abort(failure);
    }, Math.max(1, ms));
  };
  const onParentAbort = () => {
    clearTimeout(timer);
    controller.abort(parentSignal.reason);
  };
  if (parentSignal?.aborted) onParentAbort();
  else {
    parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
    arm(firstEventMs);
  }
  return {
    signal: controller.signal,
    /** İlerleme yoksa sınıflandırılmış hata; aksi hâlde `null`. */
    failure: () => failure,
    touch() {
      if (!controller.signal.aborted) arm(idleMs);
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
  };
}

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
