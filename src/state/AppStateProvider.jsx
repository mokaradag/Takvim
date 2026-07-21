'use client';
import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { appRepository } from '../data';
import { selectTaskStats } from '../scheduling/metrics';
import { createInitialState, appStateReducer, createNewTask } from './appState';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';

const AppStateContext = createContext(null);

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(appStateReducer, repository, createInitialState);

  const openTask = useCallback((taskOrId) => {
    dispatch({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, []);
  const closeTask = useCallback(() => dispatch({ type: 'task/select', id: null }), []);
  const updateTask = useCallback((id, patch) => dispatch({ type: 'task/update', id, patch }), []);
  const deleteTask = useCallback((id) => dispatch({ type: 'task/delete', id }), []);
  const addTask = useCallback(() => {
    const task = createNewTask(state);
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
