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
import { createClientEntityId } from '../data/clientEntityId.js';
import { setProjectColorOverrides } from '../lib/colors';
import { selectTaskStats } from '../scheduling/metrics';
import { appStateReducer, createLoadingState, createNewTask } from './appState';
import { createStateMutationOrchestrator, loadApplicationData } from './persistence';
import { prepareProjectCreation, prepareProjectUpdateChanges } from './projectCreation';
import {
  projectWriteFailure,
  resolveTaskCreationProject,
  resolveTaskMutationAccess,
  resolveTaskWbsMoveAccess,
  resolveWbsMutationAccess
} from './projectWritePolicy.js';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';
import { selectWorkspaceContext, WORKSPACE_MODE_PROJECT } from './selectors/workspaceSelectors';
import { readWorkspacePreference, writeWorkspacePreference } from './workspacePreference';

const AppStateContext = createContext(null);

function firstFailedResult(results = []) {
  return results.find((result) => result && !result.ok) || null;
}

function mergeUpserts(items = [], upserts = []) {
  const byId = new Map(upserts.map((item) => [item.id, item]));
  const currentIds = new Set(items.map((item) => item.id));
  return [
    ...items.map((item) => byId.get(item.id) || item),
    ...upserts.filter((item) => !currentIds.has(item.id))
  ];
}

function rejectedWrite(operation, issue) {
  return Promise.resolve(projectWriteFailure(operation, issue));
}

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(appStateReducer, undefined, createLoadingState);
  const stateRef = useRef(state);
  const loadRequestRef = useRef(0);
  const initialLoadStartedRef = useRef(false);
  const workspacePreferenceRef = useRef(null);
  const workspaceRestoredRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceWriteReady, setWorkspaceWriteReady] = useState(false);

  stateRef.current = state;
  setProjectColorOverrides(state.projects);

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
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;

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
    setWorkspaceWriteReady(true);
  }, [applyStateAction, state.dataStatus, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !workspaceWriteReady || state.dataStatus !== 'ready') return;
    writeWorkspacePreference({
      workspaceMode: state.workspaceMode,
      selectedProjectId: state.selectedProjectId
    });
  }, [workspaceReady, workspaceWriteReady, state.dataStatus, state.workspaceMode, state.selectedProjectId]);

  const openTask = useCallback((taskOrId) => {
    applyStateAction({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, [applyStateAction]);

  const closeTask = useCallback(async () => {
    const selectedTaskId = stateRef.current.selectedTaskId;
    if (selectedTaskId) {
      const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([selectedTaskId]));
      if (failedFlush) return failedFlush;
    }
    applyStateAction({ type: 'task/select', id: null });
    return { ok: true, value: null };
  }, [applyStateAction, persistence]);

  const updateTask = useCallback((id, patch) => {
    const access = resolveTaskMutationAccess(stateRef.current, id, patch);
    if (!access.ok) return rejectedWrite('task/update', access);
    return persistence.updateTask(id, patch);
  }, [persistence]);
  const flushPendingChanges = useCallback(() => persistence.flush(), [persistence]);

  const moveTaskToWbs = useCallback(async (id, wbsId) => {
    const access = resolveTaskWbsMoveAccess(stateRef.current, [id], wbsId);
    if (!access.ok) return projectWriteFailure('task/move-wbs', access);
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failedFlush) return failedFlush;
    return persistence.mutate('task/move-wbs', { type: 'task/move-wbs', id, wbsId });
  }, [persistence]);

  const moveTasksToWbs = useCallback(async (ids, wbsId) => {
    const access = resolveTaskWbsMoveAccess(stateRef.current, ids, wbsId);
    if (!access.ok) return projectWriteFailure('task/bulk-move-wbs', access);
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates(ids));
    if (failedFlush) return failedFlush;
    return persistence.mutate('task/bulk-move-wbs', { type: 'task/bulk-move-wbs', ids, wbsId });
  }, [persistence]);

  const deleteTask = useCallback(async (id) => {
    const access = resolveTaskMutationAccess(stateRef.current, id);
    if (!access.ok) return projectWriteFailure('task/delete', access);
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failedFlush) return failedFlush;
    const result = await persistence.mutate('task/delete', { type: 'task/delete', id });
    if (result.ok && stateRef.current.selectedTaskId === id) {
      applyStateAction({ type: 'task/select', id: null });
    }
    return result;
  }, [applyStateAction, persistence]);

  const addTask = useCallback(async (input = null) => {
    const current = stateRef.current;
    const project = resolveTaskCreationProject(current, input?.projectId);
    if (!project) {
      return projectWriteFailure('task/create', {
        code: 'PROJECT_WRITE_FORBIDDEN',
        field: 'projectId',
        message: 'Görev eklemek için tam yazma yetkiniz bulunan bir proje gerekir.'
      });
    }

    const id = createClientEntityId('task');
    const scopedState = {
      ...current,
      workspaceMode: WORKSPACE_MODE_PROJECT,
      selectedProjectId: project.id
    };
    const taskInput = input || {};
    const result = await persistence.mutate('task/create', () => {
      const baseTask = createNewTask(scopedState, undefined, id);
      return {
        type: 'task/add',
        task: {
          ...baseTask,
          ...taskInput,
          id,
          projectId: project.id,
          projectCode: taskInput.projectCode ?? project.code ?? '',
          proje: taskInput.proje ?? project.name ?? '',
          color: taskInput.color ?? project.color ?? baseTask.color
        }
      };
    });
    const created = result.ok ? result.value?.taskUpserts?.[0] || null : null;
    if (created) applyStateAction({ type: 'task/select', id: created.id });
    return result.ok ? { ...result, value: created } : result;
  }, [applyStateAction, persistence]);

  const addProject = useCallback(async (input) => {
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;

    const current = stateRef.current;
    const prepared = prepareProjectCreation(input, {
      projects: current.projects,
      people: current.people,
      calendars: current.calendars,
      wbs: current.wbs
    }, {
      projectId: createClientEntityId('project'),
      rootWbsId: createClientEntityId('wbs')
    });
    if (!prepared.ok) return prepared;

    const result = await persistence.commitChanges('project/create', prepared.changes);
    if (!result.ok) return result;

    const committedProject = result.value?.projectUpserts?.find((projectValue) => projectValue.id === prepared.project.id)
      || prepared.project;
    const latest = stateRef.current;

    applyStateAction({
      type: 'data/load-success',
      snapshot: {
        calendars: latest.calendars,
        projects: mergeUpserts(latest.projects, [committedProject]),
        people: latest.people,
        wbs: latest.wbs,
        tasks: latest.tasks,
        baselines: latest.baselines,
        taskBaselineSnapshots: latest.taskBaselineSnapshots
      }
    });
    applyStateAction({
      type: 'workspace/select',
      workspaceMode: WORKSPACE_MODE_PROJECT,
      selectedProjectId: committedProject.id
    });

    return { ok: true, value: committedProject, changes: result.value };
  }, [applyStateAction, persistence]);

  const updateProject = useCallback(async (projectId, input) => {
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;

    const current = stateRef.current;
    const prepared = prepareProjectUpdateChanges(projectId, input, {
      projects: current.projects,
      people: current.people,
      calendars: current.calendars,
      tasks: current.tasks,
      wbs: current.wbs
    });
    if (!prepared.ok) return prepared;

    const changes = prepared.changes;
    const result = await persistence.commitChanges('project/update', changes);
    if (!result.ok) return result;

    const committed = result.value || {};
    const latest = stateRef.current;
    const projectUpserts = committed.projectUpserts?.length ? committed.projectUpserts : changes.projectUpserts;
    const taskUpserts = committed.taskUpserts?.length ? committed.taskUpserts : changes.taskUpserts;
    const wbsUpserts = committed.wbsUpserts?.length ? committed.wbsUpserts : changes.wbsUpserts;
    const projects = mergeUpserts(latest.projects, projectUpserts);

    applyStateAction({
      type: 'data/load-success',
      snapshot: {
        calendars: latest.calendars,
        projects,
        people: latest.people,
        wbs: mergeUpserts(latest.wbs, wbsUpserts),
        tasks: mergeUpserts(latest.tasks, taskUpserts),
        baselines: latest.baselines,
        taskBaselineSnapshots: latest.taskBaselineSnapshots
      }
    });

    return {
      ok: true,
      value: projects.find((projectValue) => projectValue.id === projectId) || prepared.project,
      changes: committed
    };
  }, [applyStateAction, persistence]);

  const selectWorkspace = useCallback((projectId) => {
    applyStateAction({
      type: 'workspace/select',
      workspaceMode: projectId ? WORKSPACE_MODE_PROJECT : 'portfolio',
      selectedProjectId: projectId || null
    });
  }, [applyStateAction]);

  const addWbsChild = useCallback((parentId, name) => {
    const access = resolveWbsMutationAccess(stateRef.current, parentId);
    if (!access.ok) return rejectedWrite('wbs/create', access);
    const id = createClientEntityId('wbs');
    return persistence.mutate('wbs/create', { type: 'wbs/add-child', id, parentId, name });
  }, [persistence]);
  const renameWbs = useCallback((id, name) => {
    const access = resolveWbsMutationAccess(stateRef.current, id);
    if (!access.ok) return rejectedWrite('wbs/update', access);
    return persistence.mutate('wbs/update', { type: 'wbs/rename', id, name });
  }, [persistence]);
  const reparentWbs = useCallback((id, parentId) => {
    const access = resolveWbsMutationAccess(stateRef.current, id, parentId);
    if (!access.ok) return rejectedWrite('wbs/reparent', access);
    return persistence.mutate('wbs/reparent', { type: 'wbs/reparent', id, parentId });
  }, [persistence]);
  const deleteWbs = useCallback((id) => {
    const access = resolveWbsMutationAccess(stateRef.current, id);
    if (!access.ok) return rejectedWrite('wbs/delete', access);
    return persistence.mutate('wbs/delete', { type: 'wbs/delete', id });
  }, [persistence]);
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
    flushPendingChanges,
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    addTask,
    addProject,
    updateProject,
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
    flushPendingChanges,
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    addTask,
    addProject,
    updateProject,
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
