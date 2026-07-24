import 'server-only';
import { sql, withSqlTransaction } from '../db/pool.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';
import { applyTaskAssigneeProjection } from './taskAssigneeProjection.js';

async function loadVisibleTaskAssignees(executor, taskIds) {
  if (!taskIds.length) return [];

  const request = executor.request();
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
      return withSqlTransaction(async (transaction) => {
        const snapshot = await baseRepository.loadSnapshot();
        const taskIds = [...new Set((snapshot.tasks || []).map((task) => String(task.id)).filter(Boolean))];
        const assigneeRows = await loadVisibleTaskAssignees(transaction, taskIds);
        return applyTaskAssigneeProjection(snapshot, assigneeRows);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
    }
  };
}
