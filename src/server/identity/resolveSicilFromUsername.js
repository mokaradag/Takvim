import 'server-only';
import { getSqlPool, sql } from '../db/pool.js';
import { parseSicil } from './sicil.js';

/**
 * İkincil kimlik çözümü: Keycloak `preferred_username` → HR02 kurumsal kullanıcı
 * adı → Sicil.
 *
 * Yalnızca doğrulanmış bir token'daki kullanıcı adıyla ve YALNIZCA `sicil`
 * claim'i yokken çağrılır. Birden çok Sicil eşleşirse kimlik BELİRSİZDİR ve
 * kapalı başarısızlık ilkesi gereği hiçbir kimlik döndürülmez.
 */
export const USERNAME_SICIL_QUERY = `
    SELECT DISTINCT TOP (2) Sicil
    FROM dbo.MR_V_PeopleDirectory
    WHERE LTRIM(RTRIM(Username)) COLLATE Latin1_General_CI_AS = @username;
  `;

export async function resolveSicilFromUsername(username, executor = null) {
  const normalized = String(username ?? '').trim();
  if (!normalized || normalized.length > 128) return null;

  const pool = executor || await getSqlPool();
  const request = pool.request();
  request.input('username', sql.NVarChar(128), normalized);
  const result = await request.query(USERNAME_SICIL_QUERY);
  const rows = result.recordset || result.recordsets?.[0] || [];
  if (rows.length !== 1) return null;
  return parseSicil(rows[0]?.Sicil);
}
