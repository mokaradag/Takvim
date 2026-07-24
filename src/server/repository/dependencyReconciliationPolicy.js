function normalizedId(value) {
  return value == null || value === '' ? null : String(value);
}

function normalizedIds(values = []) {
  return new Set((values || []).map(normalizedId).filter(Boolean));
}

function incomingIds(incomingTaskIdsByPredecessor, predecessorId) {
  if (incomingTaskIdsByPredecessor instanceof Map) {
    return incomingTaskIdsByPredecessor.get(predecessorId) || [];
  }
  return incomingTaskIdsByPredecessor?.[predecessorId] || [];
}

export function findTaskDependencyReconciliationIssue({
  invalidatedPredecessorIds = [],
  incomingTaskIdsByPredecessor = new Map(),
  taskUpsertIds = [],
  taskDeleteIds = []
} = {}) {
  const upsertIds = normalizedIds(taskUpsertIds);
  const deleteIds = normalizedIds(taskDeleteIds);
  const predecessorIds = [...normalizedIds(invalidatedPredecessorIds)].sort();

  for (const predecessorId of predecessorIds) {
    const missingTaskIds = [...normalizedIds(incomingIds(incomingTaskIdsByPredecessor, predecessorId))]
      .filter((taskId) => !upsertIds.has(taskId) && !deleteIds.has(taskId))
      .sort();

    if (missingTaskIds.length) {
      return {
        code: 'TASK_DEPENDENCY_RECONCILIATION_REQUIRED',
        predecessorId,
        taskIds: missingTaskIds,
        message: 'Görev taşınmadan veya silinmeden önce etkilenen ardıl görevlerin bağımlılıkları aynı değişiklik kümesinde güncellenmelidir.'
      };
    }
  }

  return null;
}
