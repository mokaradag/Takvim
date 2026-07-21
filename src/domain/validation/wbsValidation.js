function issue(code, nodeId, details = {}) {
  return { code, nodeId: nodeId || null, details };
}

export function validateWbsStructure(wbs) {
  const nodes = wbs || [];
  const issues = [];
  const seenIds = new Set();
  const byId = new Map();

  for (const node of nodes) {
    if (!node?.id) continue;
    if (seenIds.has(node.id)) issues.push(issue('DUPLICATE_WBS_ID', node.id));
    else {
      seenIds.add(node.id);
      byId.set(node.id, node);
    }
  }

  for (const node of nodes) {
    if (!node?.id || node.parentId == null) continue;
    if (node.parentId === node.id) {
      issues.push(issue('WBS_SELF_PARENT', node.id, { parentId: node.parentId }));
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) {
      issues.push(issue('MISSING_WBS_PARENT', node.id, { parentId: node.parentId }));
      continue;
    }
    if (parent.projectId !== node.projectId) {
      issues.push(issue('CROSS_PROJECT_WBS_PARENT', node.id, {
        parentId: parent.id,
        projectId: node.projectId,
        parentProjectId: parent.projectId
      }));
    }
  }

  const done = new Set();
  const emittedCycles = new Set();
  const ordered = [...nodes].filter((node) => node?.id).sort((a, b) => a.id.localeCompare(b.id));

  for (const start of ordered) {
    if (done.has(start.id)) continue;
    const path = [];
    const position = new Map();
    let current = start;

    while (current?.id && !done.has(current.id)) {
      if (position.has(current.id)) {
        const cycleIds = path.slice(position.get(current.id));
        const canonicalIds = [...cycleIds].sort();
        const key = canonicalIds.join('::');
        if (!emittedCycles.has(key)) {
          emittedCycles.add(key);
          issues.push(issue('WBS_CYCLE', canonicalIds[0] || current.id, { nodeIds: canonicalIds }));
        }
        break;
      }

      position.set(current.id, path.length);
      path.push(current.id);
      if (current.parentId == null || current.parentId === current.id) break;
      current = byId.get(current.parentId) || null;
    }

    for (const nodeId of path) done.add(nodeId);
  }

  return issues;
}

export function validateTaskWbsAssignment(task, wbs) {
  if (!task?.wbsId) return [];
  const node = (wbs || []).find((item) => item.id === task.wbsId) || null;
  if (!node) return [issue('UNKNOWN_TASK_WBS', task.id, { wbsId: task.wbsId })];
  if (node.projectId !== task.projectId) {
    return [issue('CROSS_PROJECT_TASK_WBS', task.id, {
      taskProjectId: task.projectId || null,
      wbsId: node.id,
      wbsProjectId: node.projectId
    })];
  }
  return [];
}

export function validateWbsDeletion(wbs, tasks, wbsId) {
  const issues = [];
  const childIds = (wbs || []).filter((node) => node.parentId === wbsId).map((node) => node.id);
  const taskIds = (tasks || []).filter((task) => task.wbsId === wbsId).map((task) => task.id);

  if (childIds.length) issues.push(issue('WBS_HAS_CHILDREN', wbsId, { childIds }));
  if (taskIds.length) issues.push(issue('WBS_HAS_TASKS', wbsId, { taskIds }));
  return issues;
}
