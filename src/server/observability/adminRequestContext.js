import 'server-only';
import { assertSystemAdmin } from '../authorization/authorization.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';

/**
 * Sistem Yönetimi uçlarının ortak giriş kapısı.
 *
 * Her yönetim ucu bu işlevle başlar: oturum okunur, yetki SUNUCUDA yeniden
 * denetlenir ve ancak ondan sonra veri toplanır. Arayüzdeki gizleme hiçbir
 * zaman tek başına sınır değildir.
 */
export async function loadSystemAdminContext() {
  const pool = await getSqlPool();
  const actor = await loadAuthorizationContext(pool);
  assertSystemAdmin(actor);
  return { pool, actor };
}

const LOCK_KEY = Symbol.for('mergen-rota.admin-action-locks');

function locks() {
  globalThis[LOCK_KEY] ||= new Map();
  return globalThis[LOCK_KEY];
}

/**
 * Yönetici eylemlerinin TEK UÇUŞ kilidi.
 *
 * Aynı eylem süreç içinde eşzamanlı iki kez çalıştırılamaz: iki sekmeden
 * gelen "Şimdi Çalıştır" isteği ikinci bir tur başlatmaz, ikincisi açık bir
 * çakışma yanıtı alır. Kuyruk semantiği zaten kiralarla korunur; bu kilit
 * gereksiz yükü ve kafa karıştıran çifte sonucu önler.
 */
export async function withAdminActionLock(actionId, work) {
  const key = String(actionId);
  if (locks().get(key)) {
    throw new ServerPersistenceError('CONFLICT', 'Bu işlem şu anda çalışıyor. Tamamlanmasını bekleyin.');
  }
  locks().set(key, true);
  try {
    return await work();
  } finally {
    locks().delete(key);
  }
}

export function isAdminActionRunning(actionId) {
  return Boolean(locks().get(String(actionId)));
}

export function resetAdminActionLocksForTests() {
  globalThis[LOCK_KEY] = new Map();
}
