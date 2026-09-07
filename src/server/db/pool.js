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

  // Havuz sözü, sürücü BEKLENMEDEN önce atanır.
  //
  // `await getSqlDriver()` olay döngüsünü bırakır. Atama yalnızca o beklemeden
  // SONRA yapıldığında, soğuk açılıştaki eşzamanlı isteklerin hepsi
  // `!poolPromise` denetimini geçiyor ve her biri AYRI bir `ConnectionPool`
  // kuruyordu. Önbellekte yalnızca sonuncusu kalıyor, öncekiler ne kapatılıyor
  // ne de erişilebiliyordu: açılıştaki bir istek yığını SQL Server
  // bağlantılarını tüketip kalıcılığı kullanılamaz hâle getirebilirdi.
  if (!poolPromise) {
    // Kurulumun TAMAMI tek bir hata yoluyla korunur.
    //
    // Yapılandırma okuması, sürücü yüklemesi ve `ConnectionPool` kurucusu da
    // hata yükseltebilir. Yalnızca `pool.connect()` çağrısı sarılsaydı, bu üç
    // durumdan biri REDDEDİLMİŞ bir sözü önbellekte bırakır ve sonraki her
    // istek — sorun giderilse bile — süreç yeniden başlatılana kadar aynı
    // hatayı alırdı: kurtarılabilir bir yapılandırma hatası kalıcı kesintiye
    // dönüşürdü.
    const attempt = (async () => {
      let pool = null;
      try {
        const config = getSqlServerConfig();
        const driver = await getSqlDriver();

        pool = new driver.ConnectionPool({
          ...config,
          pool: { ...config.pool },
          options: { ...config.options },
        });

        // Bozulan havuz önbellekten düşerken KAPATILIR: yalnızca söz silinseydi
        // her geçici hata bir havuzu ve bağlantılarını süreç ömrü boyunca açık
        // bırakırdı.
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
          'SQL Server bağlantısı kurulamadı.',
          { cause }
        );
      }
    })();
    poolPromise = attempt;
    // Önbellek temizliği ATAMADAN SONRA bağlanır. Kurulum eşzamanlı olarak
    // (bozuk yapılandırma) hata yükselttiğinde, IIFE içindeki `catch` bloğu
    // `poolPromise` daha atanmadan çalışır; temizlik orada yapılsaydı reddedilen
    // söz yine önbelleğe yazılırdı. Çağıran yine bu reddi görür.
    attempt.catch(() => {
      if (poolPromise === attempt) poolPromise = undefined;
    });
  }
  return poolPromise;
}

function isDeadlock(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  return Number(error.number) === 1205 || Number(error.code) === 1205
    || [error.cause, error.originalError, error.info, ...(error.precedingErrors || [])]
      .some((nested) => isDeadlock(nested, seen));
}

export async function withSqlTransaction(work, {
  isolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED,
  deadlockRetries = 0
} = {}) {
  const activeTransaction = transactionContext.getStore();
  if (activeTransaction) return work(activeTransaction, sql);

  const pool = await getSqlPool();
  const driver = await getSqlDriver();
  for (let attempt = 0; ; attempt += 1) {
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
        // Asıl hata korunur.
      }
      if (!isDeadlock(error)) throw error;
      if (attempt >= deadlockRetries) {
        if (!deadlockRetries) throw error;
        throw new ServerPersistenceError('DATABASE_UNAVAILABLE',
          'İşlem eşzamanlı bir kayıtla çakıştı. Lütfen yeniden deneyin.', { cause: error });
      }
      // SQL Server'ın geri aldığı işlemin tamamı yeni bağlantı işlemiyle yinelenir.
      await new Promise((resolve) => setTimeout(resolve, 60 * (2 ** attempt) + Math.random() * 60));
    }
  }
}

/** Testlerde bağlantı havuzunu sıfırlar; enjekte edilen sürücüye yeniden bağlanılır. */
export function resetSqlPoolForTests() {
  poolPromise = undefined;
}

export { sql, setSqlDriverForTests };
