export function applyTaskAssigneeProjection(snapshot = {}, rows = []) {
  const assigneesByTask = new Map();

  for (const row of rows || []) {
    const taskId = row?.TaskId == null ? '' : String(row.TaskId);
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
      assigneeIds: assigneesByTask.get(String(task.id)) || []
    }))
  };
}
