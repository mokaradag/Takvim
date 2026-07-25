import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSqlDriver, setSqlDriverForTests, sql } from './driver.js';
import { getSqlServerConfig } from './config.js';
import { ServerPersistenceError } from '../errors.js';

let poolPromise;
const transactionContext = new AsyncLocalStorage();

export async function getSqlPool() {
  const activeTransaction = transactionContext.getStore();
  if (activeTransaction) return activeTransaction;

  if (!poolPromise) {
    const config = getSqlServerConfig();
    const driver = await getSqlDriver();

    const pool = new driver.ConnectionPool({
      ...config,
      pool: { ...config.pool },
      options: { ...config.options },
    });

    pool.on('error', () => {
      poolPromise = undefined;
    });

    poolPromise = pool.connect().catch((cause) => {
      poolPromise = undefined;
      throw new ServerPersistenceError(
        'DATABASE_UNAVAILABLE',
        'SQL Server bağlantısı kurulamadı.',
        { cause }
      );
    });
  }
  return poolPromise;
}

export async function withSqlTransaction(work, { isolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED } = {}) {
  const activeTransaction = transactionContext.getStore();
  if (activeTransaction) return work(activeTransaction, sql);

  const pool = await getSqlPool();
  const driver = await getSqlDriver();
  const transaction = new driver.Transaction(pool);
  try {
    await transaction.begin(isolationLevel);
    return await transactionContext.run(transaction, async () => {
      const result = await work(transaction, sql);
      await transaction.commit();
      return result;
    });
  } catch (error) {
    try {
      if (transaction._aborted !== true) await transaction.rollback();
    } catch {
      // Asıl hata korunur; geri alma hataları sunucu günlüğünün konusudur.
    }
    throw error;
  }
}

/** Testlerde bağlantı havuzunu sıfırlar; enjekte edilen sürücüye yeniden bağlanılır. */
export function resetSqlPoolForTests() {
  poolPromise = undefined;
}

export { sql, setSqlDriverForTests };
