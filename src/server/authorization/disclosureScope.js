import 'server-only';
import { sql } from '../db/pool.js';
import { ACCESS_REASONS } from './authorization.js';

/**
 * Yapay zekâ kanıt okumalarının GÜNCEL görev açıklama kapsamı.
 *
 * Yetki listeleri satır başına yeniden bölünmez: deyim başında anahtarlı geçici
 * tablolara bir kez yazılır, üyelik denetimi bu tablolardan yapılır. Tablolar
 * deyim sonunda ve her sınır `THROW`'undan önce düşürülür.
 */
export const DISCLOSURE_SCOPE_SETUP_SQL = `
  DROP TABLE IF EXISTS #AiDisclosureProjects, #AiDisclosureTasks;
  CREATE TABLE #AiDisclosureProjects(ProjectId uniqueidentifier NOT NULL PRIMARY KEY);
  CREATE TABLE #AiDisclosureTasks(TaskId uniqueidentifier NOT NULL PRIMARY KEY);
  INSERT #AiDisclosureProjects(ProjectId)
  SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(@disclosureProjects, ',')
  WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;
  INSERT #AiDisclosureTasks(TaskId)
  SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(@disclosureTasks, ',')
  WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;
`;

export const DISCLOSURE_SCOPE_CLEANUP_SQL = 'DROP TABLE IF EXISTS #AiDisclosureProjects, #AiDisclosureTasks;';

export const CURRENT_TASK_DISCLOSURE_SQL = `(t.TaskId IS NOT NULL AND p.IsActive = 1 AND (
  @disclosureAdmin = 1
  OR EXISTS (SELECT 1 FROM #AiDisclosureProjects permitted WHERE permitted.ProjectId = t.ProjectId)
  OR EXISTS (SELECT 1 FROM #AiDisclosureTasks permitted WHERE permitted.TaskId = t.TaskId)))`;

export function bindDisclosureScope(request, actor) {
  const projects = actor.isSystemAdmin ? [] : [...(actor.effective?.access || [])].filter(([, access]) => access.accessLevel === 'FULL'
    || access.reasons?.includes(ACCESS_REASONS.MANUAL_GRANT)).map(([id]) => id);
  request.input('disclosureAdmin', sql.Bit, actor.isSystemAdmin ? 1 : 0);
  request.input('disclosureProjects', sql.NVarChar(sql.MAX), projects.join(','));
  request.input('disclosureTasks', sql.NVarChar(sql.MAX), actor.isSystemAdmin ? '' : [...(actor.effective?.partialTaskIds || [])].join(','));
  return request;
}
