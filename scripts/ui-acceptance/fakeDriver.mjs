/** UI kabulü: gerçek uygulamanın SQL sürücüsü yerine deponun bellek içi SQL Server ikizi (sentetik veri). */
import { createFakeDatabase, createFakeSqlServerDriver } from '../../test/helpers/fakeSqlServer.mjs';
import { uiSeed } from './uiSeed.mjs';
const db = createFakeDatabase(uiSeed());
const statements = db.statements;
setInterval(() => { if (statements.length > 2000) statements.splice(0, statements.length - 200); }, 5000).unref();
globalThis.__rotaUiDb = db;
const driver = createFakeSqlServerDriver(db);
// Paketleyicinin CJS/ESM birlikte çalışması `default` yerine ad alanını verebilir: üyeler adlı olarak da dışa verilir.
export const ConnectionPool = driver.ConnectionPool;
export const Transaction = driver.Transaction;
export default driver;
