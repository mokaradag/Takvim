export function selectPrimaryBaselineForProject(baselines = [], projectId) {
  if (!projectId) return null;
  return baselines.find((baseline) => baseline.projectId === projectId && baseline.isPrimary) || null;
}

export function selectTaskBaselineSnapshot(taskBaselineSnapshots = [], taskId, baselineId) {
  if (!taskId || !baselineId) return null;
  return taskBaselineSnapshots.find(
    (snapshot) => snapshot.taskId === taskId && snapshot.baselineId === baselineId
  ) || null;
}
