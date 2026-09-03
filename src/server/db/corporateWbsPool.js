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

  // Bkz. `getSqlPool`: söz, sürücü beklenmeden ÖNCE atanır ki soğuk açılışta
  // eşzamanlı çağrılar aynı havuzu paylaşsın. `readProjectedSnapshot`
  // eşitlemeyi kendi işleminin dışında tetiklediği için art arda gelen anlık
  // görüntü istekleri bu dala gerçekten paralel giriyordu.
  if (!poolPromise) {
    // Bkz. `getSqlPool`: kurulumun TAMAMI (yapılandırma okuması, sürücü
    // yüklemesi, kurucu) tek bir hata yoluyla korunur ve reddedilen bir söz
    // önbellekte bırakılmaz — aksi hâlde bozuk tek bir ortam değeri, düzeltilse
    // bile süreç yeniden başlatılana kadar bu veri yolunu kapatırdı.
    const attempt = (async () => {
      let pool = null;
      try {
        const config = getCorporateWbsDbConfig();
        const driver = await getSqlDriver();
        const { schema, table, projectBatchSize, ...connectionConfig } = config;
        pool = new driver.ConnectionPool({
          ...connectionConfig,
          pool: { ...config.pool },
          options: { ...config.options }
        });

        // Önbellekten düşen havuz KAPATILIR; aksi hâlde kurumsal kaynakta yinelenen
        // geçici bir hata her seferinde dört bağlantılık bir havuz sızdırırdı.
        pool.on('error', () => {
          if (poolPromise === attempt) poolPromise = undefined;
          pool.close().catch(() => {});
        });

        return await pool.connect();
      } catch (cause) {
        pool?.close?.().catch(() => {});
        if (cause instanceof ServerPersistenceError) throw cause;
        throw new ServerPersistenceError(
          'DATABASE_UNAVAILABLE',
          'Kurumsal WBS kaynağı (CN43N) veritabanına bağlanılamadı.',
          { cause }
        );
      }
    })();
    poolPromise = attempt;
    // Temizlik ATAMADAN SONRA bağlanır: eşzamanlı bir hata, `poolPromise` daha
    // atanmadan çalışan bir `catch` bloğuyla temizlenemezdi.
    attempt.catch(() => {
      if (poolPromise === attempt) poolPromise = undefined;
    });
  }
  return poolPromise;
}

/** Testlerde havuzu sıfırlar. */
export function resetCorporateWbsPoolForTests() {
  poolPromise = undefined;
}

export { sql };
