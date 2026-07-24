function wbsId(value) {
  return value == null ? '' : String(value);
}

export function orderWbsUpsertsByParents(wbsUpserts = []) {
  const nodes = [...(wbsUpserts || [])];
  const byId = new Map(nodes.map((node) => [wbsId(node?.id), node]));
  if (byId.size !== nodes.length || byId.has('')) return nodes;

  const originalIndex = new Map(nodes.map((node, index) => [wbsId(node.id), index]));
  const indegree = new Map(nodes.map((node) => [wbsId(node.id), 0]));
  const children = new Map(nodes.map((node) => [wbsId(node.id), new Set()]));

  for (const node of nodes) {
    const id = wbsId(node.id);
    const parentId = wbsId(node.parentId);
    if (!parentId || !byId.has(parentId) || parentId === id) continue;
    const next = children.get(parentId);
    if (next.has(id)) continue;
    next.add(id);
    indegree.set(id, indegree.get(id) + 1);
  }

  const ready = nodes
    .filter((node) => indegree.get(wbsId(node.id)) === 0)
    .map((node) => wbsId(node.id))
    .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
  const ordered = [];

  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    const childIds = [...children.get(id)]
      .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
    for (const childId of childIds) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) {
        ready.push(childId);
        ready.sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
      }
    }
  }

  return ordered.length === nodes.length ? ordered : nodes;
}
