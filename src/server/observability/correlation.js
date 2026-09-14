import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * İlişkilendirme kimliği (correlation ID).
 *
 * Bir isteğin ya da arka plan turunun tüm günlük satırları ve ürettiği işletim
 * olayları aynı kimliği taşır. Yönetici "Commit başarısız" satırından tek bir
 * kimliğe, oradan da o isteğin bütün izine ulaşabilir.
 *
 * Kimlik ÜRETİLİR; istemciden gelen değer güvenilmez. Yalnızca biçimi doğru
 * olan bir üst kimlik (ör. ters vekil sunucunun ürettiği izleme kimliği)
 * kabul edilir ve o da kırpılır.
 */

const storage = new AsyncLocalStorage();
const SAFE_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function newCorrelationId() {
  return randomUUID();
}

/** Üst sistemden gelen kimliği yalnızca güvenli biçimdeyse kullanır. */
export function acceptedCorrelationId(value) {
  const text = String(value ?? '').trim();
  return SAFE_PATTERN.test(text) ? text : null;
}

export function currentCorrelationId() {
  return storage.getStore()?.correlationId ?? null;
}

export function currentOperation() {
  return storage.getStore()?.operation ?? null;
}

/** Verilen kapsamı ilişkilendirme bağlamı içinde çalıştırır. */
export function withCorrelation(context, work) {
  const store = {
    correlationId: context?.correlationId || newCorrelationId(),
    operation: context?.operation || null
  };
  return storage.run(store, () => work(store.correlationId));
}
