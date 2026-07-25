import 'server-only';
import sql from 'mssql';
import { ServerPersistenceError } from '../errors.js';

let driverPromise;
let injectedDriver = null;

/**
 * Yerel `msnodesqlv8` sürücüsü yalnızca gerçek bir bağlantı kurulurken yüklenir.
 * Modül düzeyinde içe aktarıldığında Windows dışı derleme ortamlarında (CI, Linux)
 * üretim derlemesi rota modüllerini toplarken çöküyordu. Tip sabitleri ve
 * ISOLATION_LEVEL saf JavaScript `mssql` çekirdeğinden gelir; iki modül de
 * aynı `lib/base` tanımlarını paylaştığı için değerler birebir aynıdır.
 */
export async function getSqlDriver() {
  if (injectedDriver) return injectedDriver;
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

/**
 * Uçtan uca testler için sürücü enjeksiyon noktası. Üretim kodu bu işlevi hiç
 * çağırmaz; testler gerçek SQL Server yerine bellek içi bir ikizi bağlar ve
 * böylece kalıcılaştırma zinciri (rota → depo sarmalayıcıları → SQL) gerçek
 * kodla sınanır. `null` verildiğinde gerçek sürücü davranışına dönülür.
 */
export function setSqlDriverForTests(driver) {
  injectedDriver = driver || null;
  driverPromise = undefined;
}

export { sql };
