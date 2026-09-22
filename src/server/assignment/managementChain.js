import 'server-only';
import { sql } from '../db/pool.js';

/**
 * Karşı tarafın yönetim zinciri.
 *
 * Zincir YETKİLİ İK ilişkisinden türetilir (`MR_V_ExecutiveScope`), addan
 * değil. En az birim ve müdürlük yöneticisi dikkate alınır; aynı kişi birden
 * fazla rolü taşıyorsa TEK kez döner.
 *
 * Sorgu KÜME tabanlıdır: sorumlu başına ayrı sorgu (N+1) açılmaz.
 */

/** Bildirilen yönetim rolleri. Direktörlük zinciri bilinçli olarak dışarıdadır. */
const MANAGEMENT_SCOPE_TYPES = Object.freeze(['UNIT', 'DEPARTMENT']);

function normalizeSicils(values = []) {
  return [...new Set((values || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/**
 * @returns {Promise<Map<number, number[]>>} sorumlu Sicil → tekilleştirilmiş
 *   yönetici Sicil listesi. Rehberde bulunmayan kimlik hiç dönmez.
 */
export async function resolveManagementChain(executor, assigneeSicils = [], { excludeSicils = [] } = {}) {
  const sicils = normalizeSicils(assigneeSicils);
  const chains = new Map(sicils.map((sicil) => [sicil, []]));
  if (!sicils.length) return chains;
  const excluded = new Set(normalizeSicils(excludeSicils));

  const request = executor.request();
  request.input('employeeSicils', sql.NVarChar(sql.MAX), sicils.join(','));
  request.input('scopeTypes', sql.NVarChar(200), MANAGEMENT_SCOPE_TYPES.join(','));
  const result = await request.query(`
    SELECT DISTINCT es.EmployeeSicil, es.ManagerSicil
    FROM dbo.MR_V_ExecutiveScope es
    JOIN STRING_SPLIT(@employeeSicils, ',') requested
      ON es.EmployeeSicil = TRY_CONVERT(int, LTRIM(RTRIM(requested.value)))
    JOIN STRING_SPLIT(@scopeTypes, ',') scopes
      ON es.ScopeType = LTRIM(RTRIM(scopes.value))
    WHERE es.ManagerSicil IS NOT NULL
      AND es.ManagerSicil <> es.EmployeeSicil
      AND EXISTS (
        SELECT 1 FROM dbo.MR_V_PeopleDirectory pd WHERE pd.Sicil = es.ManagerSicil
      )
    ORDER BY es.EmployeeSicil, es.ManagerSicil;
  `);

  for (const row of result.recordset || []) {
    const employee = Number(row.EmployeeSicil);
    const manager = Number(row.ManagerSicil);
    if (!chains.has(employee) || excluded.has(manager)) continue;
    const list = chains.get(employee);
    if (!list.includes(manager)) list.push(manager);
  }
  return chains;
}

/**
 * Aktör, bu çalışanın YETKİLİ yöneticisi mi?
 *
 * Karar anında yeniden sorulur: eski bir alıcı satırı yetki taşımaz.
 */
export async function isAuthoritativeManagerOf(executor, managerSicil, employeeSicil) {
  const request = executor.request();
  request.input('managerSicil', sql.Int, Number(managerSicil));
  request.input('employeeSicil', sql.Int, Number(employeeSicil));
  const result = await request.query(`
    SELECT TOP (1) 1 AS InScope
    FROM dbo.MR_V_ExecutiveScope es
    WHERE es.ManagerSicil = @managerSicil AND es.EmployeeSicil = @employeeSicil;
  `);
  return Boolean(result.recordset?.length);
}
