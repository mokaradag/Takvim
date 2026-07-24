import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import sql from 'mssql/msnodesqlv8.js';
import { getSqlServerConfig } from './config.js';
import { ServerPersistenceError } from '../errors.js';

let poolPromise;
const transactionContext = new AsyncLocalStorage();

export async function getSqlPool() {
  const activeTransaction = transactionContext.getStore();
  if (activeTransaction) return activeTransaction;

  if (!poolPromise) {
    const pool = new sql.ConnectionPool(getSqlServerConfig());
    pool.on('error', () => {
      poolPromise = undefined;
    });
    poolPromise = pool.connect().catch((cause) => {
      poolPromise = undefined;
      throw new ServerPersistenceError('DATABASE_UNAVAILABLE', 'SQL Server bağlantısı kurulamadı.', { cause });
    });
  }
  return poolPromise;
}

export async function withSqlTransaction(work, { isolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED } = {}) {
  const activeTransaction = transactionContext.getStore();
  if (activeTransaction) return work(activeTransaction, sql);

  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
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
      // Preserve the original failure; rollback errors are server-log concerns.
    }
    throw error;
  }
}

export { sql };
