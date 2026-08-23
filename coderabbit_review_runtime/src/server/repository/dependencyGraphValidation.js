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
