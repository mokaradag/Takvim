'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react';
import { appRepository } from '../data';
import { selectTaskStats } from '../scheduling/metrics';
import { appStateReducer, createLoadingState, createNewTask } from './appState';
import { createStateMutationOrchestrator, loadApplicationData } from './persistence';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';
import { selectWorkspaceContext, WORKSPACE_MODE_PROJECT } from './selectors/workspaceSelectors';
import { readWorkspacePreference, writeWorkspacePreference } from './workspacePreference';

const AppStateContext = createContext(null);

function uniqueId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstFailedResult(results = []) {
  return results.find((result) => result && !result.ok) || null;
}

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(appStateReducer, undefined, createLoadingState);
  const stateRef = useRef(state);
  const loadRequestRef = useRef(0);
  const initialLoadStartedRef = useRef(false);
  const workspacePreferenceRef = useRef(null);
  const workspaceRestoredRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  stateRef.current = state;

  const applyStateAction = useCallback((action) => {
    stateRef.current = appStateReducer(stateRef.current, action);
    dispatch(action);
    return stateRef.current;
  }, []);

  const persistence = useMemo(() => createStateMutationOrchestrator({
    repository,
    getState: () => stateRef.current,
    applyStateAction
  }), [repository, applyStateAction]);

  useEffect(() => () => persistence.dispose(), [persistence]);

  const reloadData = useCallback(async () => {
    const flushResults = await persistence.flushAllTaskUpdates();
    const failedFlush = firstFailedResult(flushResults);
    if (failedFlush) return failedFlush;

    await persistence.whenIdle();
    const requestId = ++loadRequestRef.current;
    applyStateAction({ type: 'data/load-start' });
    const result = await loadApplicationData(repository);
    if (requestId !== loadRequestRef.current) return result;

    if (result.ok) applyStateAction({ type: 'data/load-success', snapshot: result.snapshot });
    else applyStateAction({ type: 'data/load-error', error: result.error });
    return result;
  }, [applyStateAction, persistence, repository]);

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    reloadData();
  }, [reloadData]);

  useEffect(() => {
    workspacePreferenceRef.current = readWorkspacePreference();
    setWorkspaceReady(true);
  }, []);

  useEffect(() => {
    if (!workspaceReady || workspaceRestoredRef.current || state.dataStatus !== 'ready') return;
    const preference = workspacePreferenceRef.current;
    applyStateAction({
      type: 'workspace/restore',
      workspaceMode: preference?.workspaceMode,
      selectedProjectId: preference?.selectedProjectId
    });
    workspaceRestoredRef.current = true;
  }, [applyStateAction, state.dataStatus, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !workspaceRestoredRef.current || state.dataStatus !== 'ready') return;
    writeWorkspacePreference({
      workspaceMode: state.workspaceMode,
      selectedProjectId: state.selectedProjectId
    });
  }, [workspaceReady, state.dataStatus, state.workspaceMode, state.selectedProjectId]);

  const openTask = useCallback((taskOrId) => {
    applyStateAction({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, [applyStateAction]);
  const closeTask = useCallback(() => applyStateAction({ type: 'task/select', id: null }), [applyStateAction]);

  const updateTask = useCallback((id, patch) => persistence.updateTask(id, patch), [persistence]);

  const moveTaskToWbs = useCallback(async (id, wbsId) => {
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failedFlush) return failedFlush;
    return persistence.mutate('task/move-wbs', { type: 'task/move-wbs', id, wbsId });
  }, [persistence]);

  const moveTasksToWbs = useCallback(async (ids, wbsId) => {
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates(ids));
    if (failedFlush) return failedFlush;
    return persistence.mutate('task/bulk-move-wbs', { type: 'task/bulk-move-wbs', ids, wbsId });
  }, [persistence]);

  const deleteTask = useCallback(async (id) => {
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failedFlush) return failedFlush;
    const result = await persistence.mutate('task/delete', { type: 'task/delete', id });
    if (result.ok && stateRef.current.selectedTaskId === id) {
      applyStateAction({ type: 'task/select', id: null });
    }
    return result;
  }, [applyStateAction, persistence]);

  const addTask = useCallback(async () => {
    const id = uniqueId('task');
    const result = await persistence.mutate('task/create', (current) => ({
      type: 'task/add',
      task: createNewTask(current, undefined, id)
    }));
    const created = result.ok ? result.value?.taskUpserts?.find((task) => task.id === id) || null : null;
    if (created) applyStateAction({ type: 'task/select', id: created.id });
    return result.ok ? { ...result, value: created } : result;
  }, [applyStateAction, persistence]);

  const selectWorkspace = useCallback((projectId) => {
    applyStateAction({
      type: 'workspace/select',
      workspaceMode: projectId ? WORKSPACE_MODE_PROJECT : 'portfolio',
      selectedProjectId: projectId || null
    });
  }, [applyStateAction]);

  const addWbsChild = useCallback((parentId, name) => {
    const id = uniqueId('wbs');
    return persistence.mutate('wbs/create', { type: 'wbs/add-child', id, parentId, name });
  }, [persistence]);
  const renameWbs = useCallback((id, name) => (
    persistence.mutate('wbs/update', { type: 'wbs/rename', id, name })
  ), [persistence]);
  const reparentWbs = useCallback((id, parentId) => (
    persistence.mutate('wbs/reparent', { type: 'wbs/reparent', id, parentId })
  ), [persistence]);
  const deleteWbs = useCallback((id) => (
    persistence.mutate('wbs/delete', { type: 'wbs/delete', id })
  ), [persistence]);
  const clearWbsError = useCallback(() => applyStateAction({ type: 'wbs/clear-error' }), [applyStateAction]);
  const clearPersistenceError = useCallback(() => applyStateAction({ type: 'persistence/clear-error' }), [applyStateAction]);

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
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    addTask,
    selectWorkspace,
    addWbsChild,
    renameWbs,
    reparentWbs,
    deleteWbs,
    clearWbsError,
    clearPersistenceError,
    reloadData
  }), [
    openTask,
    closeTask,
    updateTask,
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    addTask,
    selectWorkspace,
    addWbsChild,
    renameWbs,
    reparentWbs,
    deleteWbs,
    clearWbsError,
    clearPersistenceError,
    reloadData
  ]);
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
