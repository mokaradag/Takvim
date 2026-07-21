'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import { appRepository } from '../data';
import { selectTaskStats } from '../scheduling/metrics';
import { createInitialState, appStateReducer, createNewTask } from './appState';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';
import { selectWorkspaceContext, WORKSPACE_MODE_PROJECT } from './selectors/workspaceSelectors';
import { readWorkspacePreference, writeWorkspacePreference } from './workspacePreference';

const AppStateContext = createContext(null);

function createWbsId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `wbs-${crypto.randomUUID()}`;
  }
  return `wbs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(appStateReducer, repository, createInitialState);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  useEffect(() => {
    const preference = readWorkspacePreference();
    dispatch({
      type: 'workspace/restore',
      workspaceMode: preference?.workspaceMode,
      selectedProjectId: preference?.selectedProjectId
    });
    setWorkspaceReady(true);
  }, []);

  useEffect(() => {
    if (!workspaceReady) return;
    writeWorkspacePreference({
      workspaceMode: state.workspaceMode,
      selectedProjectId: state.selectedProjectId
    });
  }, [workspaceReady, state.workspaceMode, state.selectedProjectId]);

  const openTask = useCallback((taskOrId) => {
    dispatch({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, []);
  const closeTask = useCallback(() => dispatch({ type: 'task/select', id: null }), []);
  const updateTask = useCallback((id, patch) => dispatch({ type: 'task/update', id, patch }), []);
  const deleteTask = useCallback((id) => dispatch({ type: 'task/delete', id }), []);
  const selectWorkspace = useCallback((projectId) => {
    dispatch({
      type: 'workspace/select',
      workspaceMode: projectId ? WORKSPACE_MODE_PROJECT : 'portfolio',
      selectedProjectId: projectId || null
    });
  }, []);
  const addWbsChild = useCallback((parentId, name) => {
    const id = createWbsId();
    dispatch({ type: 'wbs/add-child', id, parentId, name });
    return id;
  }, []);
  const renameWbs = useCallback((id, name) => dispatch({ type: 'wbs/rename', id, name }), []);
  const deleteWbs = useCallback((id) => dispatch({ type: 'wbs/delete', id }), []);
  const clearWbsError = useCallback(() => dispatch({ type: 'wbs/clear-error' }), []);
  const addTask = useCallback(() => {
    const task = createNewTask(state);
    dispatch({ type: 'task/add', task });
    return task;
  }, [state]);

  const selectedTask = useMemo(
    () => state.tasks.find((task) => task.id === state.selectedTaskId) || null,
    [state.tasks, state.selectedTaskId]
  );
  const workspace = useMemo(() => selectWorkspaceContext(state), [state]);
  const taskStats = useMemo(() => selectTaskStats(workspace.tasks), [workspace.tasks]);
  const schedule = useMemo(
    () => buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars }),
    [state.tasks, state.projects, state.calendars]
  );
  const actions = useMemo(() => ({
    openTask,
    closeTask,
    updateTask,
    deleteTask,
    addTask,
    selectWorkspace,
    addWbsChild,
    renameWbs,
    deleteWbs,
    clearWbsError
  }), [openTask, closeTask, updateTask, deleteTask, addTask, selectWorkspace, addWbsChild, renameWbs, deleteWbs, clearWbsError]);
  const value = useMemo(
    () => ({ ...state, selectedTask, taskStats, schedule, workspace, actions }),
    [state, selectedTask, taskStats, schedule, workspace, actions]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider.');
  return value;
}
