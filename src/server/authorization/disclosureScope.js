import 'server-only';
import { sql } from '../db/pool.js';
import { ACCESS_REASONS } from './authorization.js';

export const CURRENT_TASK_DISCLOSURE_SQL = `(t.TaskId IS NOT NULL AND p.IsActive = 1 AND (
  @disclosureAdmin = 1
  OR EXISTS (SELECT 1 FROM STRING_SPLIT(@disclosureProjects, ',') permitted
    WHERE TRY_CONVERT(uniqueidentifier, permitted.value) = t.ProjectId)
  OR EXISTS (SELECT 1 FROM STRING_SPLIT(@disclosureTasks, ',') permitted
    WHERE TRY_CONVERT(uniqueidentifier, permitted.value) = t.TaskId)))`;

export function bindDisclosureScope(request, actor) {
  const projects = [...(actor.effective?.access || [])].filter(([, access]) => access.accessLevel === 'FULL'
    || access.reasons?.includes(ACCESS_REASONS.MANUAL_GRANT)).map(([id]) => id);
  request.input('disclosureAdmin', sql.Bit, actor.isSystemAdmin ? 1 : 0);
  request.input('disclosureProjects', sql.NVarChar(sql.MAX), projects.join(','));
  request.input('disclosureTasks', sql.NVarChar(sql.MAX), [...(actor.effective?.partialTaskIds || [])].join(','));
  return request;
}
