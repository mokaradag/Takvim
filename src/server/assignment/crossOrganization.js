import 'server-only';
import { organizationPath } from '../../domain/assignment/assignmentCoordination.js';
import { sql } from '../db/pool.js';

/**
 * Kurum DIŞI atamanın belirlenmesi.
 *
 * Ölçüt ikilidir ve ikisi de YETKİLİ kaynaktan okunur:
 *   · çalışan, atayanın `MR_V_ExecutiveScope` kapsamında DEĞİLSE ve
 *   · kurumsal künyesi (Direktörlük / Müdürlük / Birim) atayanınkinden farklıysa
 * atama kurum dışıdır ve karşı yönetim zinciri haberdar edilir.
 *
 * Sorgu KÜME tabanlıdır: sorumlu başına ayrı sorgu açılmaz.
 */
export async function classifyAssigneeOrganizations(executor, actorSicil, sicils = []) {
  const unique = [...new Set((sicils || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value !== Number(actorSicil)))];
  if (!unique.length) return new Map();

  const request = executor.request();
  request.input('actorSicil', sql.Int, Number(actorSicil));
  request.input('assigneeSicils', sql.NVarChar(sql.MAX), unique.join(','));
  const result = await request.query(`
    SELECT pd.Sicil, pd.DisplayName, pd.Directorate, pd.Department, pd.Unit,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.MR_V_ExecutiveScope es
        WHERE es.ManagerSicil = @actorSicil AND es.EmployeeSicil = pd.Sicil
      ) THEN 1 ELSE 0 END AS InActorScope,
      actor.Directorate AS ActorDirectorate, actor.Department AS ActorDepartment, actor.Unit AS ActorUnit
    FROM dbo.MR_V_PeopleDirectory pd
    JOIN STRING_SPLIT(@assigneeSicils, ',') requested
      ON pd.Sicil = TRY_CONVERT(int, LTRIM(RTRIM(requested.value)))
    OUTER APPLY (
      SELECT TOP (1) a.Directorate, a.Department, a.Unit
      FROM dbo.MR_V_PeopleDirectory a WHERE a.Sicil = @actorSicil
    ) actor;
  `);

  const classified = new Map();
  for (const row of result.recordset || []) {
    const organization = {
      directorate: row.Directorate || null,
      department: row.Department || null,
      unit: row.Unit || null
    };
    const actorOrganization = organizationPath({
      directorate: row.ActorDirectorate || null,
      department: row.ActorDepartment || null,
      unit: row.ActorUnit || null
    });
    const path = organizationPath(organization);
    classified.set(Number(row.Sicil), {
      sicil: Number(row.Sicil),
      name: row.DisplayName || String(row.Sicil),
      organization,
      organizationPath: path,
      crossOrganization: !Boolean(row.InActorScope)
        && Boolean(path) && Boolean(actorOrganization)
        && path.localeCompare(actorOrganization, 'tr', { sensitivity: 'base' }) !== 0
    });
  }
  return classified;
}
