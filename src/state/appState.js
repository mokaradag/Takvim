import { normalizeTaskRecord } from '../data/normalizeTaskRecord.js';
import { selectDefaultProjectWbs } from '../domain/selectors/index.js';
import { validateWbsDeletion, validateWbsStructure } from '../domain/validation/index.js';
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
    WBS_NAME_REQUIRED: 'WBS adı boş bırakılamaz.',
    WBS_HAS_CHILDREN: 'Alt WBS düğümleri bulunan bir WBS silinemez.',
    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.'
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
