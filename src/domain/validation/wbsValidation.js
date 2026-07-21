function issue(code, nodeId, details = {}) {
  return { code, nodeId: nodeId || null, details };
}

function indexWbs(wbs) {
  return new Map((wbs || []).filter((node) => node?.id).map((node) => [node.id, node]));
}

function descendantIds(wbs, wbsId) {
  const childrenByParent = new Map();
  for (const node of wbs || []) {
    const children = childrenByParent.get(node.parentId) || [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const descendants = [];
  const visited = new Set([wbsId]);
  const stack = [...(childrenByParent.get(wbsId) || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node?.id || visited.has(node.id)) continue;
    visited.add(node.id);
    descendants.push(node.id);
    stack.push(...(childrenByParent.get(node.id) || []));
  }
  return descendants;
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

export function validateTaskWbsMove(tasks, wbs, taskIds, targetWbsId) {
  const ids = [...new Set((taskIds || []).filter(Boolean))];
  if (!ids.length) return [issue('TASK_MOVE_SELECTION_EMPTY', null)];

  const target = indexWbs(wbs).get(targetWbsId) || null;
  if (!target) return [issue('WBS_TARGET_NOT_FOUND', targetWbsId)];

  const tasksById = new Map((tasks || []).filter((task) => task?.id).map((task) => [task.id, task]));
  const issues = [];
  for (const taskId of ids) {
    const task = tasksById.get(taskId) || null;
    if (!task) {
      issues.push(issue('TASK_NOT_FOUND', taskId));
      continue;
    }
    if (task.projectId !== target.projectId) {
      issues.push(issue('CROSS_PROJECT_TASK_WBS_MOVE', task.id, {
        taskProjectId: task.projectId || null,
        targetWbsId: target.id,
        targetProjectId: target.projectId
      }));
    }
  }
  return issues;
}

export function validateWbsReparent(wbs, nodeId, targetParentId) {
  const byId = indexWbs(wbs);
  const node = byId.get(nodeId) || null;
  const target = byId.get(targetParentId) || null;

  if (!node) return [issue('WBS_NODE_NOT_FOUND', nodeId)];
  if (!target) return [issue('WBS_PARENT_NOT_FOUND', targetParentId)];
  if (node.parentId == null) return [issue('WBS_ROOT_REPARENT_FORBIDDEN', node.id)];
  if (node.id === target.id) return [issue('WBS_SELF_PARENT', node.id, { parentId: target.id })];
  if (node.projectId !== target.projectId) {
    return [issue('CROSS_PROJECT_WBS_PARENT', node.id, {
      parentId: target.id,
      projectId: node.projectId,
      parentProjectId: target.projectId
    })];
  }
  if (descendantIds(wbs, node.id).includes(target.id)) {
    return [issue('WBS_REPARENT_TO_DESCENDANT', node.id, { targetParentId: target.id })];
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