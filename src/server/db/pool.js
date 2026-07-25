import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import sql from 'mssql';
import { getSqlServerConfig } from './config.js';
import { ServerPersistenceError } from '../errors.js';

let poolPromise;
let driverPromise;
const transactionContext = new AsyncLocalStorage();

// Yerel `msnodesqlv8` sürücüsü yalnızca gerçek bir bağlantı kurulurken yüklenir.
// Modül düzeyinde içe aktarıldığında Windows dışı derleme ortamlarında (CI, Linux)
// üretim derlemesi rota modüllerini toplarken çöküyordu. Tip sabitleri ve
// ISOLATION_LEVEL saf JavaScript `mssql` çekirdeğinden gelir; iki modül de
// aynı `lib/base` tanımlarını paylaştığı için değerler birebir aynıdır.
async function getSqlDriver() {
  if (!driverPromise) {
    driverPromise = import('mssql/msnodesqlv8.js')
      .then((module) => module.default || module)
      .catch((cause) => {
        driverPromise = undefined;
        throw new ServerPersistenceError(
          'DATABASE_UNAVAILABLE',
          'SQL Server sürücüsü (msnodesqlv8) yüklenemedi. Yerel sürücü ve ODBC bileşenleri kurulmalıdır.',
          { cause }
        );
      });
  }
  return driverPromise;
}

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

export { sql };
