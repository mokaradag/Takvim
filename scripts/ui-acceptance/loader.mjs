/**
 * UI kabulü (yalnızca geliştirme): uygulamanın `mssql/msnodesqlv8.js` sürücüsünü deponun bellek içi SQL Server ikizine
 * yönlendirir. Üretim kodu değişmez; `NODE_OPTIONS=--import` ile yalnızca kabul sunucusunda yüklenir.
 */
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const target = new URL('./fakeDriver.mjs', import.meta.url).href;
const logFile = process.env.UI_ACCEPTANCE_DIR ? `${process.env.UI_ACCEPTANCE_DIR}/loader.log` : null;
const trace = (text) => { if (!logFile) return; try { appendFileSync(logFile, `${process.pid} ${text}\n`); } catch { /* yok */ } };
trace('loaded');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'mssql/msnodesqlv8.js' || specifier === 'mssql/msnodesqlv8' || specifier === 'msnodesqlv8') { trace(`redirect ${specifier}`); return { url: target, shortCircuit: true }; }
    return nextResolve(specifier, context);
  }
});
