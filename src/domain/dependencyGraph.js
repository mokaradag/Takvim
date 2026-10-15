import { canonicalActualIdOrValue } from './identity/actualId.js';
const key = (value) => String(canonicalActualIdOrValue(value) ?? '');

function normalizedEdge(edge) {
  const taskId = edge?.taskId ?? edge?.TaskId;
  const predecessorId = edge?.predecessorId ?? edge?.PredecessorTaskId;
  if (taskId == null || predecessorId == null) return null;
  return { taskId: String(taskId), predecessorId: String(predecessorId) };
}

export function findDependencyCycle(edges = []) {
  const outgoing = new Map();
  const nodes = new Set();

  for (const rawEdge of edges || []) {
    const edge = normalizedEdge(rawEdge);
    if (!edge) continue;
    nodes.add(edge.taskId);
    nodes.add(edge.predecessorId);
    if (!outgoing.has(edge.predecessorId)) outgoing.set(edge.predecessorId, new Set());
    outgoing.get(edge.predecessorId).add(edge.taskId);
  }

  const state = new Map();
  const stack = [];
  const stackIndex = new Map();

  function visit(taskId) {
    state.set(taskId, 1);
    stackIndex.set(taskId, stack.length);
    stack.push(taskId);

    const successors = [...(outgoing.get(taskId) || [])].sort();
    for (const successorId of successors) {
      const successorState = state.get(successorId) || 0;
      if (successorState === 0) {
        const cycle = visit(successorId);
        if (cycle.length) return cycle;
      } else if (successorState === 1) {
        return stack.slice(stackIndex.get(successorId));
      }
    }

    stack.pop();
    stackIndex.delete(taskId);
    state.set(taskId, 2);
    return [];
  }

  for (const taskId of [...nodes].sort()) {
    if ((state.get(taskId) || 0) !== 0) continue;
    const cycle = visit(taskId);
    if (cycle.length) return cycle;
  }
  return [];
}

export function reconcileTaskDependencies(stored = [], task = {}, { replace = false, deletedIds = new Set() } = {}) {
  const previous = new Map(stored.map((dep) => [key(dep.predecessorId), dep]));
  const next = new Map((replace ? [] : stored).map((dep) => [key(dep.predecessorId), dep]));
  for (const target of task.dependencyChanges?.removals || []) next.delete(key(target));
  for (const dep of task.dependencyChanges?.upserts || task.deps || []) next.set(key(dep.predecessorId), dep);
  for (const target of deletedIds) next.delete(key(target));
  const signature = (dep) => JSON.stringify([dep.type, Number(dep.lagDays || 0), dep.lagValue ?? null, dep.lagUnit || null]);
  return { deps: [...next.values()],
    inserts: [...next.values()].filter((dep) => !previous.has(key(dep.predecessorId))),
    updates: [...next.values()].filter((dep) => previous.has(key(dep.predecessorId)) && signature(dep) !== signature(previous.get(key(dep.predecessorId)))),
    deletes: stored.filter((dep) => !next.has(key(dep.predecessorId))).map((dep) => dep.predecessorId) };
}

export function reconcileDependencyGraph({ storedEdges = [], taskProjects = new Map(), taskUpserts = [], deletedIds = new Set() } = {}) {
  const projects = new Map([...taskProjects].map(([id, project]) => [key(id), key(project)]));
  const replaced = new Set(taskUpserts.filter((task) => !projects.has(key(task.id)) || task.dependencyMutation !== false).map((task) => key(task.id)));
  const edges = new Map();
  for (const edge of storedEdges) {
    const taskId = key(edge.taskId), predecessorId = key(edge.predecessorId);
    if (!replaced.has(taskId) && !deletedIds.has(taskId) && !deletedIds.has(predecessorId)) {
      edges.set(`${taskId}:${predecessorId}`, { ...edge, taskId, predecessorId });
    }
  }
  for (const task of taskUpserts) {
    const taskId = key(task.id);
    projects.set(taskId, key(task.projectId));
    if (!replaced.has(taskId) || deletedIds.has(taskId)) continue;
    for (const dep of task.deps || []) {
      const predecessorId = key(dep.predecessorId);
      if (!deletedIds.has(predecessorId)) edges.set(`${taskId}:${predecessorId}`, { ...dep, taskId, predecessorId });
    }
  }
  const result = [...edges.values()];
  const invalid = result.some((edge) => !projects.get(edge.taskId) || projects.get(edge.taskId) !== projects.get(edge.predecessorId) || edge.taskId === edge.predecessorId);
  return { edges: result, invalid, cycle: invalid ? [] : findDependencyCycle(result) };
}

export function pruneDeletedDependencies(tasks, deletedIds) {
  if (!deletedIds.size) return tasks;
  return tasks.map((task) => {
    const deps = (task.deps || []).filter((dep) => !deletedIds.has(key(dep.predecessorId)));
    return deps.length === (task.deps || []).length ? task : { ...task, deps };
  });
}
