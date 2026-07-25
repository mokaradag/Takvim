import { canonicalActualId } from '../../domain/identity/actualId.js';

// Satır kimlikleri kanonikleştirilir: SQL Server büyük harfli GUID döndürür,
// anlık görüntüdeki görev kimlikleri ise kanonik küçük harftir.
function rowId(value) {
  return value == null ? '' : (canonicalActualId(value) ?? String(value));
}

export function applyTaskAssigneeProjection(snapshot = {}, rows = []) {
  const assigneesByTask = new Map();

  for (const row of rows || []) {
    const taskId = rowId(row?.TaskId);
    const sicil = row?.Sicil == null ? '' : String(row.Sicil);
    if (!taskId || !sicil) continue;
    if (!assigneesByTask.has(taskId)) assigneesByTask.set(taskId, []);
    const assignees = assigneesByTask.get(taskId);
    if (!assignees.includes(sicil)) assignees.push(sicil);
  }

  return {
    ...snapshot,
    tasks: (snapshot.tasks || []).map((task) => ({
      ...task,
      assigneeIds: assigneesByTask.get(rowId(task.id)) || []
    }))
  };
}
