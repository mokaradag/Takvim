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
import { resolveProjectCalendar } from '../scheduling/calendars';
import { selectTaskStats } from '../scheduling/metrics';
import { normalizeRecurrenceRule, planRecurringOccurrences } from '../scheduling/recurrence';
import { appStateReducer, createLoadingState, createNewTask, normalizeStateTask } from './appState';
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

  /**
   * Tekrarlayan görev serisini somut görevlere açar.
   *
   * Şablon görev kuralı taşır (`recurrence`); burada üretilen her yineleme
   * gerçek bir görevdir ve `recurrenceParentId` ile şablona bağlanır. Böylece
   * yinelemeler Gantt, Kanban ve Takvim'de sıradan görevler gibi görünür,
   * tek tek ilerletilebilir ve gerektiğinde ayrı ayrı düzenlenebilir.
   *
   * Zaten üretilmiş yinelemelerin tarihleri tekrar üretilmez: düğmeye ikinci
   * kez basmak kopya görev oluşturmaz, yalnızca eksik kalan günleri tamamlar.
   */
  const generateTaskSeries = useCallback(async (taskId, { limit = 60 } = {}) => {
    const current = stateRef.current;
    const template = current.tasks.find((task) => task.id === taskId) || null;
    if (!template) {
      return projectWriteFailure('task/series', {
        code: 'TASK_NOT_FOUND', field: 'taskId', message: 'Tekrar şablonu bulunamadı.'
      });
    }
    const access = resolveTaskMutationAccess(current, taskId);
    if (!access.ok) return projectWriteFailure('task/series', access);
    const rule = normalizeRecurrenceRule(template.recurrence);
    if (!rule) {
      return projectWriteFailure('task/series', {
        code: 'RECURRENCE_RULE_INVALID', field: 'recurrence', message: 'Geçerli bir tekrar kuralı tanımlanmalıdır.'
      });
    }

    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([taskId]));
    if (failedFlush) return failedFlush;

    const project = current.projects.find((item) => item.id === template.projectId) || null;
    const calendar = resolveProjectCalendar(project, current.calendars);
    const existingStarts = new Set(current.tasks
      .filter((task) => task.recurrenceParentId === taskId || task.id === taskId)
      .map((task) => task.plannedStart));

    const plan = planRecurringOccurrences(template, rule, { calendar, limit })
      .filter((occurrence) => !existingStarts.has(occurrence.plannedStart));
    if (!plan.length) return { ok: true, value: [] };

    const tasks = plan.map((occurrence) => normalizeStateTask({
      ...template,
      id: createClientEntityId('task'),
      version: undefined,
      recurrence: null,
      recurrenceParentId: taskId,
      status: 'todo',
      progress: 0,
      actualStart: null,
      actualFinish: null,
      plannedStart: occurrence.plannedStart,
      plannedFinish: occurrence.plannedFinish,
      targetFinish: occurrence.targetFinish,
      // Yineleme başka bir göreve bağımlı değildir: şablonun bağımlılıkları
      // kopyalanırsa aynı öncül onlarca kez tekrarlanır ve CPM ağı bozulur.
      deps: []
    }, current));

    return persistence.mutate('task/series', { type: 'task/add-many', tasks });
  }, [persistence]);

  // `focusWorkspace` yeni projeyi etkin çalışma alanı yapar. Basit Mod bunu kapatır:
  // çalışma alanı değişimi uygulama kabuğunda içerik alanını yeniden monte ettiği
  // için hızlı görev formu kayıt tamamlanmadan sıfırlanıyor, kullanıcı ne sonucu
  // ne de hatayı görebiliyordu.
  const addProject = useCallback(async (input, { focusWorkspace = true } = {}) => {
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;

    const current = stateRef.current;
    const prepared = prepareProjectCreation(input, {
      projects: current.projects,
      people: current.people,
      calendars: current.calendars,
      canCreateProjects: current.canCreateProjects,
      wbs: current.wbs
    }, {
      projectId: createClientEntityId('project'),
      rootWbsId: createClientEntityId('wbs')
    });
    if (!prepared.ok) return prepared;

    const result = await persistence.commitChanges('project/create', prepared.changes);
    if (!result.ok) return result;

    const committedProject = result.value?.projectUpserts?.find((projectValue) => projectValue.id === prepared.project.id) || null;
    if (!committedProject) {
      // Depo yeni projeyi yankılamadıysa yerel kayıtta sürüm anahtarı bulunmaz.
      // Sürümsüz bir kaydı durumda tutmak, sonraki her güncellemenin sunucu
      // tarafında "oluşturma" sanılmasına ve çakışmayla reddedilmesine yol açar.
      await reloadData();
    } else if (!stateRef.current.projects.some((projectValue) => projectValue.id === committedProject.id)) {
      applyStateAction({ type: 'data/apply-changes', changes: { projectUpserts: [committedProject] } });
    }

    const latest = stateRef.current;
    const storedProject = latest.projects.find((projectValue) => projectValue.id === prepared.project.id)
      || committedProject
      || prepared.project;
    const rootWbs = latest.wbs.find(
      (node) => node.projectId === storedProject.id && node.parentId == null
    ) || result.value?.wbsUpserts?.find(
      (node) => node.projectId === storedProject.id && node.parentId == null
    ) || null;

    if (focusWorkspace) {
      applyStateAction({
        type: 'workspace/select',
        workspaceMode: WORKSPACE_MODE_PROJECT,
        selectedProjectId: storedProject.id
      });
    }

    return { ok: true, value: storedProject, rootWbs, changes: result.value };
  }, [applyStateAction, persistence, reloadData]);

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
    if (!committed.projectUpserts?.length) {
      // Sunucu güncellenen projeyi yankılamadıysa elimizdeki sürüm anahtarı artık
      // eskimiştir; yerel kopyayı yazmak yerine yetkili anlık görüntü yeniden yüklenir.
      await reloadData();
    } else if (!committed.taskUpserts?.length && changes.taskUpserts?.length) {
      // Etiket kataloğu yeniden adlandırıldığında görev kayıtları da yerel olarak hizalanır.
      applyStateAction({ type: 'data/apply-changes', changes: { taskUpserts: changes.taskUpserts } });
    }

    const latest = stateRef.current;
    return {
      ok: true,
      value: latest.projects.find((projectValue) => projectValue.id === projectId) || prepared.project,
      changes: committed
    };
  }, [applyStateAction, persistence, reloadData]);

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
  // Sürükle-bırak taşıması: üst düğüm değişimi + kardeşler arası sıralama.
  const moveWbsNode = useCallback((id, parentId, index) => {
    const access = resolveWbsMutationAccess(stateRef.current, id, parentId);
    if (!access.ok) return rejectedWrite('wbs/move', access);
    return persistence.mutate('wbs/move', { type: 'wbs/move', id, parentId, index });
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
    generateTaskSeries,
    addProject,
    updateProject,
    selectWorkspace,
    addWbsChild,
    renameWbs,
    reparentWbs,
    moveWbsNode,
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
    generateTaskSeries,
    addProject,
    updateProject,
    selectWorkspace,
    addWbsChild,
    renameWbs,
    reparentWbs,
    moveWbsNode,
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
