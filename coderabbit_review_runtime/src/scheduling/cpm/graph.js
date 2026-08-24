import { normalizeDependency } from '../dependencies/index.js';

export class CpmValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CpmValidationError';
    this.code = code;
    this.details = details;
  }
}

export function buildDependencyGraph(tasks) {
  const tasksById = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  const edges = [];

  for (const task of tasks || []) {
    if (!task?.id) {
      throw new CpmValidationError('MISSING_TASK_ID', 'Every CPM activity must have a stable id.');
    }
    if (tasksById.has(task.id)) {
      throw new CpmValidationError('DUPLICATE_TASK_ID', `Duplicate task id: ${task.id}`, { taskId: task.id });
    }
    tasksById.set(task.id, task);
    incoming.set(task.id, []);
    outgoing.set(task.id, []);
  }

  for (const task of tasks || []) {
    for (const rawDependency of task.deps || []) {
      const dependency = normalizeDependency(rawDependency);
      const predecessorId = dependency.predecessorId;

      if (!predecessorId || !tasksById.has(predecessorId)) {
        throw new CpmValidationError(
          'MISSING_PREDECESSOR',
          `Task ${task.id} references missing predecessor ${predecessorId || '(empty)'}.`,
          { taskId: task.id, predecessorId }
        );
      }
      if (predecessorId === task.id) {
        throw new CpmValidationError(
          'SELF_DEPENDENCY',
          `Task ${task.id} cannot depend on itself.`,
          { taskId: task.id }
        );
      }

      const edge = {
        predecessorId,
        successorId: task.id,
        dependency
      };
      edges.push(edge);
      incoming.get(task.id).push(edge);
      outgoing.get(predecessorId).push(edge);
    }
  }

  const indegree = new Map([...incoming.entries()].map(([id, taskEdges]) => [id, taskEdges.length]));
  const queue = [];
  for (const task of tasks || []) {
    if (indegree.get(task.id) === 0) queue.push(task.id);
  }

  const topologicalOrder = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const taskId = queue[cursor++];
    topologicalOrder.push(taskId);
    for (const edge of outgoing.get(taskId)) {
      const next = indegree.get(edge.successorId) - 1;
      indegree.set(edge.successorId, next);
      if (next === 0) queue.push(edge.successorId);
    }
  }

  if (topologicalOrder.length !== tasksById.size) {
    const blockedTaskIds = [...indegree.entries()]
      .filter(([, value]) => value > 0)
      .map(([id]) => id);
    throw new CpmValidationError(
      'DEPENDENCY_CYCLE',
      `Dependency cycle detected involving: ${blockedTaskIds.join(', ')}`,
      { taskIds: blockedTaskIds }
    );
  }

  return {
    tasksById,
    incoming,
    outgoing,
    edges,
    topologicalOrder
  };
}
