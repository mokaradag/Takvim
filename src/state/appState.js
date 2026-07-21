import { normalizeTaskRecord } from '../data/normalizeTaskRecord.js';
import { selectDefaultProjectWbs, selectWbsDescendantIds } from '../domain/selectors/index.js';
import {
  validateTaskWbsMove,
  validateWbsDeletion,
  validateWbsReparent,
  validateWbsStructure
} from '../domain/validation/index.js';
import { fmtISO, today } from '../scheduling/dates/index.js';
import { addWorkingDays, moveToWorkingDay, resolveProjectCalendar } from '../scheduling/calendars/index.js';
import {
  WORKSPACE_MODE_PORTFOLIO,
  WORKSPACE_MODE_PROJECT,
  normalizeWorkspaceSelection
} from './selectors/workspaceSelectors.js';

function taskContext(state) {
  return {
    projects: state.projects || [],
    people: state.people || [],
    wbs: state.wbs || [],
    calendars: state.calendars || []
  };
}

function workspaceState(state, selection) {
  const normalized = normalizeWorkspaceSelection(selection, state.projects || []);
  const selectedTask = (state.tasks || []).find((task) => task.id === state.selectedTaskId) || null;
  const selectedTaskId = normalized.workspaceMode === WORKSPACE_MODE_PROJECT
    && selectedTask
    && selectedTask.projectId !== normalized.selectedProjectId
    ? null
    : state.selectedTaskId;

  return { ...normalized, selectedTaskId };
}

function wbsMessage(code) {
  const messages = {
    WBS_PARENT_NOT_FOUND: 'Üst WBS düğümü bulunamadı.',
    WBS_NODE_NOT_FOUND: 'Taşınacak WBS düğümü bulunamadı.',
    WBS_NAME_REQUIRED: 'WBS adı boş bırakılamaz.',
    WBS_HAS_CHILDREN: 'Alt WBS düğümleri bulunan bir WBS silinemez.',
    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',
    WBS_ROOT_REPARENT_FORBIDDEN: 'Proje kök WBS düğümü başka bir WBS altına taşınamaz.',
    WBS_REPARENT_TO_DESCENDANT: 'Bir WBS kendi alt düğümlerinden birinin altına taşınamaz.',
    WBS_SELF_PARENT: 'Bir WBS kendi üst düğümü olamaz.',
    CROSS_PROJECT_WBS_PARENT: 'WBS düğümleri farklı projeler arasında taşınamaz.',
    TASK_MOVE_SELECTION_EMPTY: 'Taşınacak en az bir görev seçilmelidir.',
    WBS_TARGET_NOT_FOUND: 'Hedef WBS düğümü bulunamadı.',
    TASK_NOT_FOUND: 'Taşınacak görevlerden biri bulunamadı.',
    CROSS_PROJECT_TASK_WBS_MOVE: 'Görevler yalnızca kendi projelerindeki WBS düğümlerine taşınabilir.'
  };
  return messages[code] || 'WBS işlemi doğrulama nedeniyle tamamlanamadı.';
}

function withWbsError(state, code, nodeId = null, details = {}) {
  return {
    ...state,
    wbsActionError: { code, nodeId, details, message: wbsMessage(code) }
  };
}

function nextChildDefinition(state, parent) {
  const siblings = (state.wbs || []).filter((node) => node.parentId === parent.id);
  const maxOrder = siblings.reduce((max, node) => Math.max(max, Number.isFinite(node.sortOrder) ? node.sortOrder : 0), 0);
  const maxSegment = siblings.reduce((max, node) => {
    const segment = Number.parseInt(String(node.code || '').split('.').at(-1), 10);
    return Number.isFinite(segment) ? Math.max(max, segment) : max;
  }, 0);
  const next = Math.max(maxOrder, maxSegment, siblings.length) + 1;
  return { code: `${parent.code}.${next}`, sortOrder: next };
}

function moveTasksToWbs(state, taskIds, targetWbsId) {
  const issues = validateTaskWbsMove(state.tasks, state.wbs, taskIds, targetWbsId);
  if (issues.length) {
    const first = issues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  const selectedIds = new Set(taskIds);
  return {
    ...state,
    tasks: state.tasks.map((task) => (selectedIds.has(task.id) ? { ...task, wbsId: targetWbsId } : task)),
    wbsActionError: null
  };
}

function rebaseWbsCode(code, oldPrefix, newPrefix) {
  const value = String(code || '');
  const previous = String(oldPrefix || '');
  if (!previous) return value;
  if (value === previous) return newPrefix;
  if (value.startsWith(`${previous}.`)) return `${newPrefix}${value.slice(previous.length)}`;
  return value;
}

function reparentWbs(state, nodeId, targetParentId) {
  const issues = validateWbsReparent(state.wbs, nodeId, targetParentId);
  if (issues.length) {
    const first = issues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  const node = state.wbs.find((item) => item.id === nodeId);
  const target = state.wbs.find((item) => item.id === targetParentId);
  if (node.parentId === target.id) return { ...state, wbsActionError: null };

  const stateWithoutSourceSibling = {
    ...state,
    wbs: state.wbs.filter((item) => item.id !== node.id)
  };
  const ordering = nextChildDefinition(stateWithoutSourceSibling, target);
  const descendants = new Set(selectWbsDescendantIds(state.wbs, node.id));
  const nextWbs = state.wbs.map((item) => {
    if (item.id === node.id) {
      return {
        ...item,
        parentId: target.id,
        code: ordering.code,
        sortOrder: ordering.sortOrder
      };
    }
    if (descendants.has(item.id)) {
      return { ...item, code: rebaseWbsCode(item.code, node.code, ordering.code) };
    }
    return item;
  });

  const structureIssues = validateWbsStructure(nextWbs);
  if (structureIssues.length) {
    const first = structureIssues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  return { ...state, wbs: nextWbs, wbsActionError: null };
}

export function createInitialState(repository) {
  const snapshot = repository.getSnapshot();
  const base = {
    ...snapshot,
    calendars: snapshot.calendars || [],
    projects: snapshot.projects || [],
    people: snapshot.people || [],
    wbs: snapshot.wbs || [],
    baselines: snapshot.baselines || [],
    taskBaselineSnapshots: snapshot.taskBaselineSnapshots || []
  };

  return {
    ...base,
    tasks: (snapshot.tasks || []).map((task) => normalizeTaskRecord(task, taskContext(base))),
    selectedTaskId: null,
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null,
    wbsActionError: null
  };
}

export function normalizeStateTask(task, state) {
  return normalizeTaskRecord(task, taskContext(state));
}

export function appStateReducer(state, action) {
  switch (action.type) {
    case 'task/add':
      return { ...state, tasks: [action.task, ...state.tasks], selectedTaskId: action.task.id };
    case 'task/update': {
      let updatedTask = null;
      const tasks = state.tasks.map((task) => {
        if (task.id !== action.id) return task;
        const next = { ...task, ...action.patch };
        if (Object.prototype.hasOwnProperty.call(action.patch, 'sorumlu')) delete next.assigneeIds;
        if (Object.prototype.hasOwnProperty.call(action.patch, 'proje')) {
          delete next.projectId;
          delete next.wbsId;
        }
        updatedTask = normalizeStateTask(next, state);
        return updatedTask;
      });
      const selectedTaskId = state.workspaceMode === WORKSPACE_MODE_PROJECT
        && state.selectedTaskId === action.id
        && updatedTask
        && updatedTask.projectId !== state.selectedProjectId
        ? null
        : state.selectedTaskId;
      return { ...state, tasks, selectedTaskId };
    }
    case 'task/move-wbs':
      return moveTasksToWbs(state, [action.id], action.wbsId);
    case 'task/bulk-move-wbs':
      return moveTasksToWbs(state, action.ids || [], action.wbsId);
    case 'task/delete':
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== action.id),
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId
      };
    case 'task/select':
      return { ...state, selectedTaskId: action.id || null };
    case 'workspace/select':
    case 'workspace/restore':
      return { ...state, ...workspaceState(state, action) };
    case 'wbs/add-child': {
      const parent = state.wbs.find((node) => node.id === action.parentId) || null;
      if (!parent) return withWbsError(state, 'WBS_PARENT_NOT_FOUND', action.parentId);
      const name = String(action.name || '').trim();
      if (!name) return withWbsError(state, 'WBS_NAME_REQUIRED', parent.id);
      const ordering = nextChildDefinition(state, parent);
      const node = {
        id: action.id,
        projectId: parent.projectId,
        parentId: parent.id,
        code: action.code || ordering.code,
        name,
        sortOrder: Number.isFinite(action.sortOrder) ? action.sortOrder : ordering.sortOrder
      };
      const nextWbs = [...state.wbs, node];
      const issues = validateWbsStructure(nextWbs);
      if (issues.length) {
        const first = issues[0];
        return withWbsError(state, first.code, first.nodeId, first.details);
      }
      return { ...state, wbs: nextWbs, wbsActionError: null };
    }
    case 'wbs/rename': {
      const name = String(action.name || '').trim();
      if (!name) return withWbsError(state, 'WBS_NAME_REQUIRED', action.id);
      return {
        ...state,
        wbs: state.wbs.map((node) => (node.id === action.id ? { ...node, name } : node)),
        wbsActionError: null
      };
    }
    case 'wbs/reparent':
      return reparentWbs(state, action.id, action.parentId);
    case 'wbs/delete': {
      const issues = validateWbsDeletion(state.wbs, state.tasks, action.id);
      if (issues.length) {
        const first = issues[0];
        return withWbsError(state, first.code, first.nodeId, first.details);
      }
      return {
        ...state,
        wbs: state.wbs.filter((node) => node.id !== action.id),
        wbsActionError: null
      };
    }
    case 'wbs/clear-error':
      return { ...state, wbsActionError: null };
    default:
      return state;
  }
}

export function createNewTask(state, referenceDate = today(), id = `n-${Date.now()}`) {
  const selectedProject = state.workspaceMode === WORKSPACE_MODE_PROJECT
    ? state.projects.find((project) => project.id === state.selectedProjectId) || null
    : null;
  const project = selectedProject || state.projects[0] || null;
  const person = state.people[0];
  const calendar = resolveProjectCalendar(project, state.calendars);
  const start = moveToWorkingDay(referenceDate, calendar, 1);
  const defaultWbs = project ? selectDefaultProjectWbs(state.wbs, project.id) : null;

  const task = normalizeStateTask({
    id,
    projectId: project?.id || null,
    wbsId: defaultWbs?.id || null,
    proje: project?.name || '',
    task: 'Yeni görev',
    keyword: 'Yeni',
    assigneeIds: person ? [person.id] : [],
    sorumlu: person ? [person.name] : [],
    status: 'todo',
    plannedStart: fmtISO(start),
    plannedFinish: fmtISO(addWorkingDays(start, 5, calendar)),
    targetFinish: fmtISO(addWorkingDays(start, 7, calendar)),
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    color: project?.color || 'blue',
    deps: []
  }, state);

  return {
    ...task,
    remainingDurationDays: task.plannedDurationDays
  };
}