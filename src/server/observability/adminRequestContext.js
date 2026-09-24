import 'server-only';
import { assertSystemAdmin } from '../authorization/authorization.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { getSqlDriver, sql } from '../db/driver.js';
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

/** Aynı eylemi bütün uygulama örneklerinde tek SQL kilidiyle korur. */
export async function withAdminActionLock(actionId, work, pool = null) {
  const key = String(actionId);
  const conflict = () => new ServerPersistenceError('CONFLICT', 'Bu işlem şu anda çalışıyor. Tamamlanmasını bekleyin.');
  if (locks().get(key)) throw conflict();
  locks().set(key, true);
  let transaction = null;
  let began = false;
  try {
    const executor = pool || await getSqlPool();
    const driver = await getSqlDriver();
    transaction = new driver.Transaction(executor);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    began = true;
    const request = transaction.request();
    request.input('resource', sql.NVarChar(255), `mergen-rota:admin:${key}`);
    const result = await request.query(`
      DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource = @resource,
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
      SELECT @result AS LockResult;`);
    const lockResult = result.recordset?.[0]?.LockResult;
    if (lockResult === -1) throw conflict();
    if (!Number.isInteger(lockResult) || lockResult < 0) {
      throw new ServerPersistenceError('DATABASE_UNAVAILABLE', 'Yönetim işlemi kilidi alınamadı.');
    }
    // Kilit bağlantısı yalnız kilidi tutar; işin kendi kalıcılık sınırları korunur.
    const outcome = await work();
    await transaction.commit();
    began = false;
    return outcome;
  } finally {
    try {
      if (began && transaction._aborted !== true) await transaction.rollback();
    } finally {
      locks().delete(key);
    }
  }
}

/**
 * Yalnızca bu süreçte tekil çalışan yönetim eylemi; SQL kilidi ALMAZ.
 *
 * Veritabanına dokunmayan ve yalnızca dış bir uca süre sınırlı istek gönderen
 * eylemler (ör. yapay zekâ bağlantı testi) için kullanılır: dış uç beklenirken
 * bir SQL işlemi ve havuz bağlantısı tutulmaz. Eylemin yan etkisi olmadığı için
 * örnekler arası tekillik gerekmez.
 */
export async function withLocalAdminActionLock(actionId, work) {
  const key = String(actionId);
  if (locks().get(key)) throw new ServerPersistenceError('CONFLICT', 'Bu işlem şu anda çalışıyor. Tamamlanmasını bekleyin.');
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
