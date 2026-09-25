import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AiError } from './aiErrors.js';

/**
 * Yapay zekâ alt sisteminin ortak SQL havuzuna giden işleri için sınırlı kapı.
 *
 * Kapı, işin HAVUZDAN aldığı bağlantıyı temsil eder: en fazla `slots` iş aynı
 * anda çalışır, sıra `queue` ile sınırlıdır ve dolunca istek beklemeden
 * `AI_BUSY` alır. Tek bir Sicil en fazla `perUserActive` yer tutar ve sırada en
 * fazla `perUserQueued` isteği bekler: bir kullanıcı sırayı doldurup öteki
 * kullanıcıların isteklerini genel `AI_BUSY` ile geri çevirtemez.
 *
 * Yer, çağıranın vazgeçtiği anda DEĞİL, işin gerçekten bittiği anda bırakılır:
 * `run()` işi `track(promise)` ile izlenen SQL sorgularını da bekler. İptal
 * edilmeye çalışılan ama sürücüde hâlâ çalışan bir sorgu yerini tutmaya devam
 * eder; süre aşımları, bırakılmış sorgular sürerken yenilerini başlatarak
 * sınırı aşamaz. Havuzun kendisini beklemek yer tutmaz: çağıran havuzu kapıya
 * girmeden (kendi süre sınırıyla) alır.
 *
 * Durum `globalThis` üzerindedir; Next.js modül yeniden yüklemesi ikinci bir
 * kapı açmaz.
 */

function busy(retryAfterMs, scope, saturation) {
  return new AiError(AI_ERROR_CODES.AI_BUSY, { retryAfterMs, details: { scope, saturation } });
}

export function createAiSqlGate({ name, slots, queue, perUserActive, perUserQueued, saturation, retryAfterMs = 2000 }) {
  const stateKey = Symbol.for(`mergen-rota.ai-sql-gate.${name}`);

  function state() {
    globalThis[stateKey] ||= { active: 0, waiters: [], users: new Map() };
    return globalThis[stateKey];
  }

  function user(current, userKey) {
    let entry = current.users.get(userKey);
    if (!entry) {
      entry = { active: 0, queued: 0 };
      current.users.set(userKey, entry);
    }
    return entry;
  }

  function prune(current, userKey) {
    const entry = current.users.get(userKey);
    if (entry && entry.active === 0 && entry.queued === 0) current.users.delete(userKey);
  }

  /** Boş yer oldukça, kendi sınırına takılmayan en eski bekleyen içeri alınır. */
  function pump(current) {
    while (current.active < slots) {
      const index = current.waiters.findIndex((waiter) => user(current, waiter.userKey).active < perUserActive);
      if (index < 0) return;
      const [waiter] = current.waiters.splice(index, 1);
      const entry = user(current, waiter.userKey);
      entry.queued -= 1;
      entry.active += 1;
      current.active += 1;
      waiter.admit();
    }
  }

  function release(current, userKey) {
    current.active -= 1;
    user(current, userKey).active -= 1;
    prune(current, userKey);
    pump(current);
  }

  function acquire(current, userKey, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const entry = user(current, userKey);
    if (current.active < slots && entry.active < perUserActive) {
      entry.active += 1;
      current.active += 1;
      return Promise.resolve();
    }
    if (entry.queued >= perUserQueued) {
      prune(current, userKey);
      return Promise.reject(busy(retryAfterMs, 'user', 'user'));
    }
    if (current.waiters.length >= queue) {
      prune(current, userKey);
      return Promise.reject(busy(retryAfterMs, 'global', saturation));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = current.waiters.indexOf(waiter);
        if (index < 0) return;
        current.waiters.splice(index, 1);
        user(current, userKey).queued -= 1;
        prune(current, userKey);
        reject(signal.reason);
      };
      const waiter = {
        userKey,
        admit() {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        }
      };
      entry.queued += 1;
      current.waiters.push(waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  return {
    /**
     * İşi bir yer alarak çalıştırır. `work(track)`; `track(promise)` sürücüdeki
     * gerçek sorguyu kapıya bağlar ve yer, iş ile izlenen bütün sorgular
     * bitmeden bırakılmaz.
     */
    async run(userKey, signal, work) {
      const current = state();
      await acquire(current, userKey, signal);
      let pending = 0;
      let finished = false;
      let released = false;
      const settle = () => {
        if (!finished || pending > 0 || released) return;
        released = true;
        release(current, userKey);
      };
      const track = (promise) => {
        pending += 1;
        const done = () => {
          pending -= 1;
          settle();
        };
        Promise.resolve(promise).then(done, done);
        return promise;
      };
      try {
        return await work(track);
      } finally {
        finished = true;
        settle();
      }
    },

    status() {
      const current = state();
      return { active: current.active, queued: current.waiters.length, users: current.users.size };
    },

    resetForTests() {
      globalThis[stateKey] = { active: 0, waiters: [], users: new Map() };
    }
  };
}
