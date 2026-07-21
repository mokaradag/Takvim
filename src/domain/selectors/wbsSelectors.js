function compareCodes(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'tr', { numeric: true, sensitivity: 'base' });
}

export function compareWbsNodes(left, right) {
  const leftOrder = Number.isFinite(left?.sortOrder) ? left.sortOrder : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right?.sortOrder) ? right.sortOrder : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  const codeOrder = compareCodes(left?.code, right?.code);
  if (codeOrder !== 0) return codeOrder;

  const nameOrder = String(left?.name || '').localeCompare(String(right?.name || ''), 'tr', { sensitivity: 'base' });
  if (nameOrder !== 0) return nameOrder;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function selectProjectWbs(wbs, projectId) {
  if (!projectId) return [];
  return (wbs || []).filter((node) => node.projectId === projectId).slice().sort(compareWbsNodes);
}

export function selectWbsRoots(wbs, projectId = null) {
  const nodes = projectId ? selectProjectWbs(wbs, projectId) : [...(wbs || [])].sort(compareWbsNodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (node.parentId == null) return true;
    const parent = byId.get(node.parentId);
    return !parent || parent.projectId !== node.projectId || parent.id === node.id;
  });
}

export function selectDefaultProjectWbs(wbs, projectId) {
  const roots = selectWbsRoots(wbs, projectId).filter((node) => node.parentId == null);
  return roots.length === 1 ? roots[0] : null;
}

export function selectWbsChildren(wbs, parentId) {
  return (wbs || []).filter((node) => node.parentId === parentId).slice().sort(compareWbsNodes);
}

export function selectWbsDescendantIds(wbs, wbsId) {
  const childrenByParentId = new Map();
  for (const node of wbs || []) {
    const bucket = childrenByParentId.get(node.parentId) || [];
    bucket.push(node);
    childrenByParentId.set(node.parentId, bucket);
  }
  for (const children of childrenByParentId.values()) children.sort(compareWbsNodes);

  const visited = new Set([wbsId]);
  const descendants = [];
  const stack = [...(childrenByParentId.get(wbsId) || [])].reverse();

  while (stack.length) {
    const node = stack.pop();
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);
    descendants.push(node.id);
    const children = childrenByParentId.get(node.id) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }

  return descendants;
}

export function selectWbsAncestors(wbs, wbsId) {
  const byId = new Map((wbs || []).map((node) => [node.id, node]));
  const node = byId.get(wbsId);
  if (!node) return [];

  const ancestors = [];
  const visited = new Set([node.id]);
  let parentId = node.parentId;

  while (parentId != null) {
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.projectId !== node.projectId) break;
    ancestors.push(parent);
    parentId = parent.parentId;
  }

  return ancestors.reverse();
}

export function selectWbsPath(wbs, wbsId) {
  const node = (wbs || []).find((item) => item.id === wbsId) || null;
  return node ? [...selectWbsAncestors(wbs, wbsId), node] : [];
}

export function formatWbsPath(wbs, wbsId) {
  return selectWbsPath(wbs, wbsId)
    .map((node) => `${node.code} ${node.name}`.trim())
    .join(' / ');
}

export function buildWbsTree(wbs) {
  const nodes = [...(wbs || [])].sort(compareWbsNodes);
  const byId = new Map();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }

  const childrenByParentId = new Map();
  const rootIds = [];

  for (const node of nodes) {
    const parent = node.parentId == null ? null : byId.get(node.parentId);
    if (!parent || parent.projectId !== node.projectId || parent.id === node.id) {
      rootIds.push(node.id);
      continue;
    }
    const bucket = childrenByParentId.get(parent.id) || [];
    bucket.push(node.id);
    childrenByParentId.set(parent.id, bucket);
  }

  for (const childIds of childrenByParentId.values()) {
    childIds.sort((leftId, rightId) => compareWbsNodes(byId.get(leftId), byId.get(rightId)));
  }

  const built = new Set();
  function buildNode(nodeId, ancestry = new Set()) {
    const node = byId.get(nodeId);
    if (!node) return null;
    if (ancestry.has(nodeId)) return { ...node, children: [], cycle: true };
    if (built.has(nodeId)) return null;

    built.add(nodeId);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeId);
    const children = (childrenByParentId.get(nodeId) || [])
      .map((childId) => buildNode(childId, nextAncestry))
      .filter(Boolean);

    return { ...node, children };
  }

  const tree = [];
  const orderedRootIds = [...new Set(rootIds)].sort((leftId, rightId) => compareWbsNodes(byId.get(leftId), byId.get(rightId)));
  for (const rootId of orderedRootIds) {
    const root = buildNode(rootId);
    if (root) tree.push(root);
  }

  // Cyclic components can have no natural root. Keep them visible without recursing forever.
  for (const node of nodes) {
    if (built.has(node.id)) continue;
    const root = buildNode(node.id);
    if (root) tree.push(root);
  }

  return tree;
}

export function flattenWbsTree(tree) {
  const rows = [];
  const visited = new Set();

  function visit(node, depth) {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    rows.push({ node, depth });
    for (const child of node.children || []) visit(child, depth + 1);
  }

  for (const root of tree || []) visit(root, 0);
  return rows;
}

export function selectTasksForWbs(tasks, wbs, wbsId, { includeDescendants = false } = {}) {
  const allowed = new Set([wbsId]);
  if (includeDescendants) {
    for (const descendantId of selectWbsDescendantIds(wbs, wbsId)) allowed.add(descendantId);
  }
  return (tasks || []).filter((task) => allowed.has(task.wbsId));
}

function taskProgress(task) {
  if (Number.isFinite(task?.progress)) return Math.min(100, Math.max(0, task.progress));
  return task?.status === 'done' ? 100 : 0;
}

export function selectWbsTaskRollup(wbs, tasks, wbsId, taskSchedules = {}) {
  const subtreeTasks = selectTasksForWbs(tasks, wbs, wbsId, { includeDescendants: true });
  const directTasks = selectTasksForWbs(tasks, wbs, wbsId);
  const scheduled = subtreeTasks.filter((task) => task.plannedStart && task.plannedFinish);
  const weighted = subtreeTasks.reduce((total, task) => {
    const weight = Math.max(1, Number.isFinite(task.plannedDurationDays) ? task.plannedDurationDays : 1);
    return {
      weight: total.weight + weight,
      progress: total.progress + (taskProgress(task) * weight)
    };
  }, { weight: 0, progress: 0 });

  return {
    wbsId,
    taskCount: subtreeTasks.length,
    directTaskCount: directTasks.length,
    completedTaskCount: subtreeTasks.filter((task) => task.status === 'done').length,
    criticalTaskCount: subtreeTasks.filter((task) => taskSchedules?.[task.id]?.isCritical).length,
    progress: weighted.weight ? Math.round(weighted.progress / weighted.weight) : 0,
    plannedStart: scheduled.length ? scheduled.reduce((min, task) => (task.plannedStart < min ? task.plannedStart : min), scheduled[0].plannedStart) : null,
    plannedFinish: scheduled.length ? scheduled.reduce((max, task) => (task.plannedFinish > max ? task.plannedFinish : max), scheduled[0].plannedFinish) : null
  };
}
