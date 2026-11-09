/** UI kabulü: gerçek uygulamanın SQL sürücüsü yerine deponun bellek içi SQL Server ikizi (sentetik veri). */
import { createFakeDatabase, createFakeSqlServerDriver } from '../../test/helpers/fakeSqlServer.mjs';
import { uiSeed } from './uiSeed.mjs';
import { analysisBenchmarkSeed } from '../../test/helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed } from '../../test/helpers/executiveBenchmarkSeed.mjs';
// UI_SEED=analysis: Bilgin yönetim analizi kıyas kümesinin sentetik verisi (arayüz kabul verisinin genişletilmiş hâli).
// UI_SEED=executive: Aşama G yönetici kıyas verisi (örgütsel birimler, kilometre taşları, görünür görevi olmayan kadro üyesi).
const SEEDS = { analysis: analysisBenchmarkSeed, executive: executiveBenchmarkSeed };
const db = createFakeDatabase((SEEDS[process.env.UI_SEED] || uiSeed)());
const statements = db.statements;
setInterval(() => { if (statements.length > 2000) statements.splice(0, statements.length - 200); }, 5000).unref();
globalThis.__rotaUiDb = db;
const driver = createFakeSqlServerDriver(db);
// Paketleyicinin CJS/ESM birlikte çalışması `default` yerine ad alanını verebilir: üyeler adlı olarak da dışa verilir.
export const ConnectionPool = driver.ConnectionPool;
export const Transaction = driver.Transaction;
export default driver;
