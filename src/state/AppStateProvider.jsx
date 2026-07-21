'use client';
import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { appRepository } from '../data';
import { normalizeTaskReferences } from '../domain/validation';
import { fmtISO, today } from '../scheduling/dates';
import { addWorkingDays, moveToWorkingDay, resolveProjectCalendar } from '../scheduling/calendars';
import { normalizeDependency } from '../scheduling/dependencies';
import { selectTaskStats } from '../scheduling/metrics';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';

const AppStateContext = createContext(null);

function initState(repository) {
  const snapshot = repository.getSnapshot();
  return { ...snapshot, selectedTaskId: null };
}

function normalizeTask(task, state) {
  return normalizeTaskReferences({
    ...task,
    deps: (task.deps || []).map(normalizeDependency)
  }, state);
}

function reducer(state, action) {
  switch (action.type) {
    case 'task/add':
      return { ...state, tasks: [action.task, ...state.tasks], selectedTaskId: action.task.id };
    case 'task/update':
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          if (task.id !== action.id) return task;
          const next = { ...task, ...action.patch };
          if (Object.prototype.hasOwnProperty.call(action.patch, 'sorumlu')) delete next.assigneeIds;
          if (Object.prototype.hasOwnProperty.call(action.patch, 'proje')) {
            delete next.projectId;
            delete next.wbsId;
          }
          return normalizeTask(next, state);
        })
      };
    case 'task/delete':
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== action.id),
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId
      };
    case 'task/select':
      return { ...state, selectedTaskId: action.id || null };
    default:
      return state;
  }
}

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(reducer, repository, initState);

  const openTask = useCallback((taskOrId) => {
    dispatch({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, []);
  const closeTask = useCallback(() => dispatch({ type: 'task/select', id: null }), []);
  const updateTask = useCallback((id, patch) => dispatch({ type: 'task/update', id, patch }), []);
  const deleteTask = useCallback((id) => dispatch({ type: 'task/delete', id }), []);
  const addTask = useCallback(() => {
    const project = state.projects[0];
    const person = state.people[0];
    const calendar = resolveProjectCalendar(project, state.calendars);
    const start = moveToWorkingDay(today(), calendar, 1);
    const task = normalizeTask({
      id: `n-${Date.now()}`,
      projectId: project?.id || null,
      proje: project?.name || '',
      task: 'Yeni görev',
      keyword: 'Yeni',
      assigneeIds: person ? [person.id] : [],
      sorumlu: person ? [person.name] : [],
      status: 'todo',
      baslangicTarihi: fmtISO(start),
      bitisTarihi: fmtISO(addWorkingDays(start, 5, calendar)),
      hedefTarih: fmtISO(addWorkingDays(start, 7, calendar)),
      color: project?.color || 'blue',
      deps: []
    }, state);
    dispatch({ type: 'task/add', task });
    return task;
  }, [state]);

  const selectedTask = useMemo(
    () => state.tasks.find((task) => task.id === state.selectedTaskId) || null,
    [state.tasks, state.selectedTaskId]
  );
  const taskStats = useMemo(() => selectTaskStats(state.tasks), [state.tasks]);
  const schedule = useMemo(
    () => buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars }),
    [state.tasks, state.projects, state.calendars]
  );
  const actions = useMemo(() => ({ openTask, closeTask, updateTask, deleteTask, addTask }), [openTask, closeTask, updateTask, deleteTask, addTask]);
  const value = useMemo(() => ({ ...state, selectedTask, taskStats, schedule, actions }), [state, selectedTask, taskStats, schedule, actions]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider.');
  return value;
}
