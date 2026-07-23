import 'server-only';
import sql from 'mssql';
import { getSqlServerConfig } from './config.js';
import { ServerPersistenceError } from '../errors.js';

let poolPromise;

export async function getSqlPool() {
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

export async function withSqlTransaction(work) {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    const result = await work(transaction, sql);
    await transaction.commit();
    return result;
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
