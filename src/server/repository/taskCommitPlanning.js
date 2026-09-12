function taskId(value) {
  return value == null ? '' : String(value);
}

function projectId(value) {
  return value == null ? '' : String(value);
}

function existingProjectsMap(value) {
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([id, project]) => [taskId(id), projectId(project)]));
  }
  return new Map(Object.entries(value || {}).map(([id, project]) => [taskId(id), projectId(project)]));
}

export function findFinalTaskReferenceIssue({
  existingTaskProjects = new Map(),
  taskUpserts = [],
  taskDeletes = []
} = {}) {
  const finalProjects = existingProjectsMap(existingTaskProjects);
  const deletedIds = new Set((taskDeletes || []).map((entry) => taskId(typeof entry === 'string' ? entry : entry?.id)).filter(Boolean));
  const upsertIds = new Set();

  for (const task of taskUpserts || []) {
    const id = taskId(task?.id);
    const nextProjectId = projectId(task?.projectId);
    if (!id || !nextProjectId) {
      return { code: 'TASK_IDENTITY_REQUIRED', taskId: id || null };
    }
    if (upsertIds.has(id)) {
      return { code: 'DUPLICATE_TASK_UPSERT', taskId: id };
    }
    if (deletedIds.has(id)) {
      return { code: 'TASK_UPSERT_DELETE_CONFLICT', taskId: id };
    }
    upsertIds.add(id);
    finalProjects.set(id, nextProjectId);
  }

  for (const id of deletedIds) finalProjects.delete(id);

  for (const task of taskUpserts || []) {
    const id = taskId(task.id);
    const nextProjectId = projectId(task.projectId);
    const predecessorIds = new Set();

    for (const dependency of task.deps || []) {
      const predecessorId = taskId(dependency?.predecessorId);
      if (!predecessorId) {
        return { code: 'DEPENDENCY_PREDECESSOR_REQUIRED', taskId: id };
      }
      if (predecessorIds.has(predecessorId)) {
        return { code: 'DUPLICATE_DEPENDENCY', taskId: id, predecessorId };
      }
      predecessorIds.add(predecessorId);

      if (predecessorId === id) {
        return { code: 'SELF_DEPENDENCY', taskId: id, predecessorId };
      }
      if (deletedIds.has(predecessorId)) {
        return { code: 'DEPENDENCY_TARGET_DELETED', taskId: id, predecessorId };
      }

      const predecessorProjectId = finalProjects.get(predecessorId);
      if (!predecessorProjectId) {
        return { code: 'DEPENDENCY_TARGET_NOT_FOUND', taskId: id, predecessorId };
      }
      if (predecessorProjectId !== nextProjectId) {
        return {
          code: 'CROSS_PROJECT_DEPENDENCY',
          taskId: id,
          predecessorId,
          projectId: nextProjectId,
          predecessorProjectId
        };
      }
    }
  }

  return null;
}

export function orderTaskUpsertsByDependencies(taskUpserts = []) {
  const tasks = [...(taskUpserts || [])];
  const byId = new Map(tasks.map((task) => [taskId(task?.id), task]));
  if (byId.size !== tasks.length) return tasks;

  const originalIndex = new Map(tasks.map((task, index) => [taskId(task.id), index]));
  const indegree = new Map(tasks.map((task) => [taskId(task.id), 0]));
  const successors = new Map(tasks.map((task) => [taskId(task.id), new Set()]));

  for (const task of tasks) {
    const id = taskId(task.id);
    const references = [...(task.deps || []), ...(task.recurrenceParentId ? [{ predecessorId: task.recurrenceParentId }] : [])];
    for (const dependency of references) {
      const predecessorId = taskId(dependency?.predecessorId);
      if (!byId.has(predecessorId) || predecessorId === id) continue;
      const next = successors.get(predecessorId);
      if (next.has(id)) continue;
      next.add(id);
      indegree.set(id, indegree.get(id) + 1);
    }
  }

  const ready = tasks
    .filter((task) => indegree.get(taskId(task.id)) === 0)
    .map((task) => taskId(task.id))
    .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
  const ordered = [];

  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    const nextIds = [...successors.get(id)].sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
    for (const successorId of nextIds) {
      indegree.set(successorId, indegree.get(successorId) - 1);
      if (indegree.get(successorId) === 0) {
        ready.push(successorId);
        ready.sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
      }
    }
  }

  return ordered.length === tasks.length ? ordered : tasks;
}
