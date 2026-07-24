import 'server-only';
import { getSqlPool, sql } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';

async function loadVisibleTaskAssignees(taskIds) {
  if (!taskIds.length) return [];

  const pool = await getSqlPool();
  const request = pool.request();
  request.input('taskIds', sql.NVarChar(sql.MAX), taskIds.join(','));
  const result = await request.query(`
    SELECT ta.TaskId, ta.Sicil
    FROM dbo.MR_TaskAssignees ta
    JOIN STRING_SPLIT(@taskIds, ',') visible
      ON ta.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(visible.value)))
    ORDER BY ta.TaskId, ta.Sicil;
  `);
  return result.recordset || [];
}

export function createProjectedSqlAppRepository() {
  const baseRepository = createBaseSqlAppRepository();
  return {
    ...baseRepository,
    async loadSnapshot() {
      const snapshot = await baseRepository.loadSnapshot();
      const taskIds = [...new Set((snapshot.tasks || []).map((task) => String(task.id)).filter(Boolean))];
      const assigneeRows = await loadVisibleTaskAssignees(taskIds);
      return applyTaskAssigneeProjection(snapshot, assigneeRows);
    }
  };
}
