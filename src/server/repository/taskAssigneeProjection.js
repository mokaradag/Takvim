import { canonicalActualId } from '../../domain/identity/actualId.js';

// Satır kimlikleri kanonikleştirilir: SQL Server büyük harfli GUID döndürür,
// anlık görüntüdeki görev kimlikleri ise kanonik küçük harftir.
function rowId(value) {
  return value == null ? '' : (canonicalActualId(value) ?? String(value));
}

export function applyTaskAssigneeProjection(snapshot = {}, rows = []) {
  const assigneesByTask = new Map();
  const displayNamesByTask = new Map();
  const seenAssignees = new Set();

  for (const row of rows || []) {
    const taskId = rowId(row?.TaskId);
    const sicil = row?.Sicil == null ? '' : String(row.Sicil);
    const displayName = row?.DisplayName == null ? '' : String(row.DisplayName).trim();
    if (!taskId) continue;
    if (sicil) {
      const assigneeKey = `${taskId}:${sicil}`;
      if (seenAssignees.has(assigneeKey)) continue;
      seenAssignees.add(assigneeKey);
      if (!assigneesByTask.has(taskId)) assigneesByTask.set(taskId, []);
      const assignees = assigneesByTask.get(taskId);
      if (!assignees.includes(sicil)) assignees.push(sicil);
    }
    if (displayName) {
      if (!displayNamesByTask.has(taskId)) displayNamesByTask.set(taskId, []);
      displayNamesByTask.get(taskId).push(displayName);
    }
  }

  return {
    ...snapshot,
    tasks: (snapshot.tasks || []).map((task) => ({
      ...task,
      assigneeIds: assigneesByTask.get(rowId(task.id)) || [],
      assigneeDisplayNames: displayNamesByTask.get(rowId(task.id)) || []
    }))
  };
}
