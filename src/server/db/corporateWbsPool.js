import 'server-only';
import { getSqlDriver, sql } from './driver.js';
import { getCorporateWbsDbConfig, isCorporateWbsSourceConfigured } from './corporateWbsConfig.js';
import { ServerPersistenceError } from '../errors.js';

let poolPromise;

/**
 * CN43N kaynağı için ikinci (salt okunur kullanılan) bağlantı havuzu.
 * Kaynak yapılandırılmadıysa `null` döner; çağıran taraf eşitlemeyi atlar.
 */
export async function getCorporateWbsPool() {
  if (!isCorporateWbsSourceConfigured()) return null;

  if (!poolPromise) {
    const config = getCorporateWbsDbConfig();
    const driver = await getSqlDriver();
    const { schema, table, projectBatchSize, ...connectionConfig } = config;
    const pool = new driver.ConnectionPool({
      ...connectionConfig,
      pool: { ...config.pool },
      options: { ...config.options }
    });

    pool.on('error', () => {
      poolPromise = undefined;
    });

    poolPromise = pool.connect().catch((cause) => {
      poolPromise = undefined;
      throw new ServerPersistenceError(
        'DATABASE_UNAVAILABLE',
        'Kurumsal WBS kaynağı (CN43N) veritabanına bağlanılamadı.',
        { cause }
      );
    });
  }
  return poolPromise;
}

/** Testlerde havuzu sıfırlar. */
export function resetCorporateWbsPoolForTests() {
  poolPromise = undefined;
}

export { sql };
