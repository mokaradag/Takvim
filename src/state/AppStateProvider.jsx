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
import { getAppRepository } from '../data';
import { createClientEntityId } from '../data/clientEntityId.js';
import { setProjectColorOverrides } from '../lib/colors';
import { resolveProjectCalendar } from '../scheduling/calendars';
import { selectTaskStats } from '../scheduling/metrics';
import { normalizeRecurrenceRule } from '../scheduling/recurrence';
import { appStateReducer, createLoadingState, normalizeStateTask, withCompletionStamp } from './appState';
import { createStateMutationOrchestrator } from './persistence';
import { prepareProjectCreation, prepareProjectUpdateChanges } from './projectCreation';
import {
  projectWriteFailure,
  resolveTaskCreationAccess,
  resolveTaskMutationAccess,
  resolveTaskWbsMoveAccess,
  resolveWbsMutationAccess
} from './projectWritePolicy.js';
import { reconcileProjectMutationAccess } from './projectMutationReconciliation.js';
import { createRecurringTasks } from './recurringTaskCreation.js';
import { executeTaskCreation } from './taskCreationPolicy.js';
import { commitTaskEditorEdits, prepareTaskCreationCommit } from './taskEditorCommit.js';
import { createTaskEditorDraftRegistry, unsavedTaskEditorResult } from './taskEditorDrafts.js';
import { canonicalActualId } from '../domain/identity/actualId.js';
import {
  createDataRefreshRequestGuard,
  createDataRefreshSingleFlight
} from './dataRefreshSafety.js';
import {
  createDataReloadOperation,
  dataReloadSingleFlightOptions
} from './dataReloadLifecycle.js';
import {
  automaticDataRefreshInterval,
  createAutomaticDataRefreshController,
  supportsAutomaticDataRefresh
} from './automaticDataRefresh.js';
import { buildPortfolioSchedule } from './selectors/scheduleSelectors';
import { selectWorkspaceContext, WORKSPACE_MODE_PROJECT } from './selectors/workspaceSelectors';
import { readWorkspacePreference, writeWorkspacePreference } from './workspacePreference';
import {
  decideScheduleChangeRequest,
  submitScheduleChangeRequest
} from '../data/api/scheduleChangeClient.js';

const AppStateContext = createContext(null);
const DataLifecycleContext = createContext(null);
function firstFailedResult(results = []) {
  return results.find((result) => result && !result.ok) || null;
}

function rejectedWrite(operation, issue) {
  return Promise.resolve(projectWriteFailure(operation, issue));
}

export function AppStateProvider({ children, repository = getAppRepository() }) {
  const [state, dispatch] = useReducer(appStateReducer, undefined, createLoadingState);
  const [taskCreationDraft, setTaskCreationDraft] = useState(null);
  const stateRef = useRef(state);
  const taskCreationDraftRef = useRef(null);
  const editorDraftsRef = useRef(createTaskEditorDraftRegistry());
  const loadRequestGuardRef = useRef(createDataRefreshRequestGuard());
  const loadSingleFlightRef = useRef(createDataRefreshSingleFlight());
  const initialLoadStartedRef = useRef(false);
  const workspacePreferenceRef = useRef(null);
  const workspaceRestoredRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceWriteReady, setWorkspaceWriteReady] = useState(false);

  // `stateRef` RENDER SIRASINDA yazılmaz.
  //
  // `applyStateAction` her eylemi indirgeyiciden geçirip `stateRef` değerini
  // iyimser biçimde ilerletir; kalıcılık katmanı da değişiklik kümesini bu
  // referanstan türetir. Render içinde `stateRef.current = state` yapmak,
  // React'in yarıda kesip attığı ya da yeniden oynattığı bir render'da
  // referansı DAHA ESKİ bir indirgeyici durumuna geri alabiliyordu; sonraki
  // `createPersistenceChangeSet` çağrısı bu bayat durumu "önce" olarak okuyup
  // bekleyen değişiklikleri atlayabiliyor ya da yanlış anlık görüntüden
  // türetebiliyordu (React kuralı: render saf kalmalıdır).

  // Renk geçersiz kılmaları modül düzeyindeki bir eşlemeye yazılır: RENDER
  // içinde yapılan bu yazma, işlenmeyen bir render'ın (StrictMode çift render,
  // kesilen/eşzamanlı render) değerlerini eşlemede bırakıyor ve başka
  // bileşenler bir sonraki boyamada o değerleri okuyordu.
  useEffect(() => {
    setProjectColorOverrides(state.projects);
  }, [state.projects]);

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

  // Sökülmede bekleyen yamalar reddedilir. Yeniden bağlanmada kuyruk yeniden
  // açılır: React 18 `StrictMode` geliştirmede etkileri bir kez söküp yeniden
  // bağladığı için, `useMemo` ile üretilen aynı kuyruk kapalı kalıyor ve
  // geliştirme sunucusunda hiçbir görev düzenlemesi kaydedilmiyordu.
  useEffect(() => {
    persistence.revive();
    return () => persistence.dispose();
  }, [persistence]);

  const runDataReload = useMemo(() => createDataReloadOperation({
    repository,
    persistence,
    getState: () => stateRef.current,
    applyStateAction,
    requestGuard: loadRequestGuardRef.current
  }), [applyStateAction, persistence, repository]);

  const reloadData = useCallback((options = {}) => {
    const refreshMode = options.refreshMode || 'manual';
    return loadSingleFlightRef.current.run(
      () => runDataReload({ ...options, refreshMode }),
      dataReloadSingleFlightOptions(refreshMode, options)
    );
  }, [runDataReload]);

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    reloadData({ refreshMode: 'initial' });
  }, [reloadData]);

  useEffect(() => {
    if (!supportsAutomaticDataRefresh(repository)) return undefined;
    const controller = createAutomaticDataRefreshController({
      intervalMs: automaticDataRefreshInterval(),
      getLastRefreshedAt: () => stateRef.current.lastRefreshedAt,
      refresh: () => reloadData({ refreshMode: 'automatic' })
    });
    controller.start();
    return () => controller.stop();
  }, [reloadData, repository]);

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

  const openTask = useCallback(async (taskOrId) => {
    const rawId = typeof taskOrId === 'string' ? taskOrId : taskOrId?.id;
    const id = canonicalActualId(rawId) || rawId;
    let task = stateRef.current.tasks.find((item) => item.id === id);
    if (!task) {
      const refreshed = await reloadData({ refreshMode: 'manual' });
      if (refreshed?.ok === false) return refreshed;
      task = stateRef.current.tasks.find((item) => item.id === id);
    }
    if (!task) return { ok: false, error: { message: 'Görev bulunamadı veya artık görüntüleme yetkiniz yok.' } };
    taskCreationDraftRef.current = null;
    setTaskCreationDraft(null);
    if (stateRef.current.workspaceMode === 'project' && stateRef.current.selectedProjectId !== task.projectId) {
      applyStateAction({ type: 'workspace/select', selectedProjectId: task.projectId, workspaceMode: 'project' });
    }
    applyStateAction({ type: 'task/select', id: task.id });
    return { ok: true, value: task };
  }, [applyStateAction, reloadData]);

  /**
   * Görev panelini kapatır.
   *
   * Bekleyen düzenlemeler önce sunucuya yazılır. Yazma BAŞARISIZ olsa bile
   * panel kapanır: daha önce başarısız kayıt paneli açık tutuyordu ve
   * kullanıcı hiçbir düğmeyle çıkamıyordu (uygulama donmuş görünüyordu).
   *
   * Düzenleme yine de kaybolmaz. Reddedilen yama birleştirme kuyruğunda
   * saklanır (bkz. createTaskPatchCoalescer): panel kapansa ve taslak sökülse
   * bile alan değerleri durur, kullanıcı yazmaya devam ederse üzerine birleşir
   * ve kalıcılaştırma şeridindeki "Yeniden dene" ile gönderilebilir. Vazgeçme
   * yalnızca açık bir "Verileri yeniden yükle" kararıyla olur.
   */
  const closeTask = useCallback(async () => {
    if (taskCreationDraftRef.current) {
      taskCreationDraftRef.current = null;
      setTaskCreationDraft(null);
      return { ok: true, value: null };
    }
    const selectedTaskId = stateRef.current.selectedTaskId;
    const failedFlush = selectedTaskId
      ? firstFailedResult(await persistence.flushTaskUpdates([selectedTaskId]))
      : null;
    applyStateAction({ type: 'task/select', id: null });
    return failedFlush || { ok: true, value: null };
  }, [applyStateAction, persistence]);

  const updateTask = useCallback((id, patch) => {
    // "Tamamlandı"ya geçiş gerçekleşen bitişi damgalar: aksi hâlde raporlar
    // planlanan bitişi gerçekleşen sanmak zorunda kalırdı.
    const stamped = withCompletionStamp(stateRef.current, id, patch);
    const access = resolveTaskMutationAccess(stateRef.current, id, stamped);
    if (!access.ok) return rejectedWrite('task/update', access);
    return persistence.updateTask(id, stamped);
  }, [persistence]);
  const saveTaskEdits = useCallback((edits, options = {}) => (
    commitTaskEditorEdits(persistence, () => stateRef.current, edits, options)
      .catch((error) => ({ ok: false, error: { code: error.code || 'MUTATION_FAILED', message: error.message } }))
  ), [persistence]);
  const registerTaskEditorDraft = useCallback((reader) => editorDraftsRef.current.register(reader), []);
  const flushPendingChanges = useCallback(async (options = {}) => {
    const result = await persistence.flush(options);
    if (!result.ok) return result;
    return taskCreationDraftRef.current || editorDraftsRef.current.hasPendingChanges()
      ? unsavedTaskEditorResult() : result;
  }, [persistence]);
  /**
   * TEK bir görevin bekleyen düzenlemelerini sunucuya yazar.
   *
   * Alan düzenlemeleri gecikmeli birleştirilir; sunucu tarafında görevi yeniden
   * okuyan eylemler (hatırlatma gönderimi gibi) bu kuyruk boşaltılmadan
   * çalıştırılırsa ESKİ başlık, termin ve sorumlularla iş görür.
   */
  const flushTaskEdits = useCallback(async (id) => {
    if (!id) return { ok: true, value: null };
    if (editorDraftsRef.current.hasPendingChanges(id)) return unsavedTaskEditorResult();
    const failed = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failed) return failed;
    return editorDraftsRef.current.hasPendingChanges(id) ? unsavedTaskEditorResult() : { ok: true, value: null };
  }, [persistence]);
  const hasPendingChanges = useCallback(() => Boolean(taskCreationDraftRef.current)
    || editorDraftsRef.current.hasPendingChanges() || persistence.hasPendingChanges(), [persistence]);
  // Reddedilen yamalar saklanır; kullanıcı kalıcılaştırma şeridinden yeniden
  // deneyebilir, böylece kaybedilen tek kopya diye bir durum oluşmaz.
  const retryFailedChanges = useCallback(() => persistence.retryFailedTaskUpdates(), [persistence]);
  // Arayüz bir alanı geçersiz kıldığında (örneğin başlık silindiğinde) o alanın
  // kuyrukta bekleyen önceki değeri de düşürülür.
  const cancelTaskFieldUpdates = useCallback(
    (id, fields) => persistence.cancelTaskFieldUpdates(id, fields),
    [persistence]
  );

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
    if (!access.canDelete) {
      return projectWriteFailure('task/delete', {
        code: 'TASK_DELETE_FORBIDDEN',
        field: 'taskId',
        message: access.deleteReason || 'Bu görevi silmek için proje yetkisi gerekir.'
      });
    }
    const failedFlush = firstFailedResult(await persistence.flushTaskUpdates([id]));
    if (failedFlush) return failedFlush;
    const result = await persistence.mutate('task/delete', { type: 'task/delete', id });
    if (result.ok && stateRef.current.selectedTaskId === id) {
      applyStateAction({ type: 'task/select', id: null });
    }
    return result;
  }, [applyStateAction, persistence]);

  const submitScheduleChange = useCallback(async (input) => {
    if (String(stateRef.current.session?.dataMode || '').toLowerCase() !== 'actual') {
      return projectWriteFailure('schedule-change/create', {
        code: 'ACTUAL_MODE_REQUIRED',
        message: 'Tarih değişikliği talepleri yalnızca Gerçek Sistem kipinde kullanılabilir.'
      });
    }
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;
    const result = await submitScheduleChangeRequest(input);
    if (!result.ok) {
      const details = result.error && typeof result.error === 'object' ? result.error : result;
      return { ok: false, error: { kind: 'persistence', ...details } };
    }
    const reloadResult = await reloadData({ preserveFailedTaskUpdates: true });
    return reloadResult.ok ? result : { ...result, refreshError: reloadResult.error || reloadResult };
  }, [persistence, reloadData]);

  const decideScheduleChange = useCallback(async (requestId, decision, message = '') => {
    if (String(stateRef.current.session?.dataMode || '').toLowerCase() !== 'actual') {
      return projectWriteFailure('schedule-change/decide', {
        code: 'ACTUAL_MODE_REQUIRED',
        message: 'Tarih değişikliği talepleri yalnızca Gerçek Sistem kipinde kullanılabilir.'
      });
    }
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;
    const result = await decideScheduleChangeRequest(requestId, decision, message);
    if (!result.ok) {
      const details = result.error && typeof result.error === 'object' ? result.error : result;
      return { ok: false, error: { kind: 'persistence', ...details } };
    }
    const reloadResult = await reloadData({ preserveFailedTaskUpdates: true });
    return reloadResult.ok ? result : { ...result, refreshError: reloadResult.error || reloadResult };
  }, [persistence, reloadData]);

  const addTask = useCallback(async (input = null) => {
    const current = stateRef.current;
    const id = createClientEntityId('task');
    const { result, created } = await executeTaskCreation({
      state: current,
      input,
      id,
      mutate: (operation, action) => persistence.mutate(operation, action)
    });
    if (created) applyStateAction({ type: 'task/select', id: created.id });
    return result.ok ? { ...result, value: created } : result;
  }, [applyStateAction, persistence]);

  const beginTaskDraft = useCallback(async (input = null) => {
    const current = stateRef.current;
    const id = createClientEntityId('task');
    const { result, created, scope } = await executeTaskCreation({
      state: current,
      input,
      id,
      mutate: async (_operation, createAction) => {
        const action = createAction();
        const task = normalizeStateTask(action.task, current);
        return { ok: true, value: { taskUpserts: [task] } };
      }
    });
    if (!result.ok || !created) return result;
    const draft = { task: created, scope, createdAt: new Date().toISOString() };
    taskCreationDraftRef.current = draft;
    setTaskCreationDraft(draft);
    applyStateAction({ type: 'task/select', id: null });
    return { ok: true, value: created };
  }, [applyStateAction]);

  const updateTaskDraft = useCallback((id, patch = {}) => {
    const current = taskCreationDraftRef.current;
    if (!current || String(current.task.id) !== String(id)) {
      return rejectedWrite('task/draft-update', {
        code: 'TASK_DRAFT_NOT_FOUND',
        field: 'taskId',
        message: 'Görev taslağı bulunamadı.'
      });
    }
    const draftState = {
      ...stateRef.current,
      tasks: [...(stateRef.current.tasks || []), current.task]
    };
    const stampedPatch = withCompletionStamp(draftState, id, patch);
    const task = normalizeStateTask({ ...current.task, ...stampedPatch }, stateRef.current);
    // Proje değişince taslak yetkileri de HEDEF projenin kapsamına geçer.
    // Kaydetme aynı kapsamı yeniden doğrular; panel eski FULL projenin
    // sorumlu/yapı denetimlerini yeni dar projede açık bırakmaz.
    const creation = resolveTaskCreationAccess(stateRef.current, task.projectId);
    const next = { ...current, task, scope: creation.ok ? creation.scope : null };
    taskCreationDraftRef.current = next;
    setTaskCreationDraft(next);
    return Promise.resolve({ ok: true, value: { taskUpserts: [task] } });
  }, []);

  const cancelTaskDraft = useCallback(() => {
    taskCreationDraftRef.current = null;
    setTaskCreationDraft(null);
    return Promise.resolve({ ok: true, value: null });
  }, []);

  const saveTaskDraft = useCallback(async (input = null, options = {}) => {
    const draft = taskCreationDraftRef.current;
    if (!draft) {
      return projectWriteFailure('task/create', {
        code: 'TASK_DRAFT_NOT_FOUND',
        field: 'taskId',
        message: 'Kaydedilecek görev taslağı bulunamadı.'
      });
    }
    const draftState = {
      ...stateRef.current,
      tasks: [...(stateRef.current.tasks || []), draft.task]
    };
    const taskInput = withCompletionStamp(draftState, draft.task.id, input || draft.task);
    const { result, created } = await executeTaskCreation({
      state: stateRef.current,
      input: taskInput,
      id: draft.task.id,
      mutate: (operation, action) => persistence.mutate(operation, (current) => {
        return prepareTaskCreationCommit(current, action(current), options);
      })
    });
    if (!result.ok || !created) return result;
    // Yavaş kayıt sürerken kullanıcı A taslağını kapatıp B taslağını açmış
    // olabilir. A'nın yanıtı B'yi temizlememeli veya seçimi A'ya çevirmemeli.
    if (String(taskCreationDraftRef.current?.task?.id || '') !== String(draft.task.id)) {
      return { ...result, value: created };
    }
    taskCreationDraftRef.current = null;
    setTaskCreationDraft(null);
    applyStateAction({ type: 'task/select', id: created.id });
    return { ...result, value: created };
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
    // Kuyruktaki bütün yazmalar önce tamamlanır: kullanıcı kuralı veya tarihi
    // değiştirip hemen bu düğmeye bastığında şablon henüz eski durumda olurdu
    // ve yinelemeler kaydedilmiş şablonla çelişen tarihlerle oluşurdu.
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;

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

    const tasks = createRecurringTasks(current, template, { limit });
    if (!tasks.length) return { ok: true, value: [] };

    return persistence.mutate('task/series', { type: 'task/add-many', tasks });
  }, [persistence]);

  // `focusWorkspace` yeni projeyi etkin çalışma alanı yapar. Temel Kip bunu kapatır:
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
      const reloadResult = await reloadData({ preserveFailedTaskUpdates: true });
      if (!reloadResult.ok) return reloadResult;
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
    const committedProject = committed.projectUpserts?.find((projectValue) => projectValue.id === projectId) || null;
    if (!committedProject || committedProject.accessLevel !== 'FULL') {
      // Sunucu güncellenen projeyi yankılamadıysa elimizdeki sürüm anahtarı artık
      // eskimiştir. FULL erişim lead devriyle PARTIAL'a düştüyse de önceki tam
      // görev/WBS ağı güvenli alt küme değildir. Her iki durumda yetkili anlık
      // görüntü yeniden yüklenir.
      const reloadResult = await reconcileProjectMutationAccess(
        committedProject,
        () => reloadData({ preserveFailedTaskUpdates: true })
      );
      if (!reloadResult?.ok) return reloadResult;
    }
    // Etiket yeniden adlandırması görev anahtar sözcüklerine KALICI KATMANDA,
    // katalog yazmasıyla aynı işlemde uygulanır (bkz. planProjectTagPropagation)
    // ve etkilenen görevler `committed.taskUpserts` içinde geri döner; bu
    // yankı `persistence/success` ile duruma zaten işlenir. Yerel bir hizalama
    // dalı yoktu: `prepareProjectUpdateChanges` her zaman boş `taskUpserts`
    // ürettiği için o dal hiç çalışmıyordu.

    const latest = stateRef.current;
    return {
      ok: true,
      value: latest.projects.find((projectValue) => projectValue.id === projectId) || prepared.project,
      changes: committed
    };
  }, [persistence, reloadData]);

  const deleteProject = useCallback(async (projectId) => {
    const flushResult = await persistence.flush();
    if (!flushResult.ok) return flushResult;
    const current = stateRef.current;
    const project = current.projects.find((item) => String(item.id) === String(projectId));
    if (!project) {
      return projectWriteFailure('project/delete', {
        code: 'PROJECT_NOT_FOUND', field: 'projectId', message: 'Silinecek proje bulunamadı.'
      });
    }
    if (!current.isSystemAdmin) {
      return projectWriteFailure('project/delete', {
        code: 'PROJECT_DELETE_FORBIDDEN', field: 'projectId', message: 'Projeyi yalnızca sistem yöneticisi silebilir.'
      });
    }
    if (String(project.source || '').toLowerCase() !== 'manual') {
      return projectWriteFailure('project/delete', {
        code: 'CORPORATE_PROJECT_DELETE_FORBIDDEN', field: 'projectId', message: 'Kurumsal/CN43N projeleri uygulamadan silinemez.'
      });
    }
    const taskCount = current.tasks.filter((task) => String(task.projectId) === String(projectId)).length;
    if (taskCount > 0) {
      return projectWriteFailure('project/delete', {
        code: 'PROJECT_NOT_EMPTY', field: 'projectId',
        message: `Bu manuel proje ${taskCount} görev içerdiği için silinemez.`
      });
    }
    const result = await persistence.commitChanges('project/delete', {
      projectUpserts: [], projectDeletes: [{ id: project.id, version: project.version }],
      wbsUpserts: [], wbsDeletes: [], taskUpserts: [], taskDeletes: []
    });
    if (result.ok && String(stateRef.current.selectedProjectId) === String(projectId)) {
      applyStateAction({ type: 'workspace/select', workspaceMode: 'portfolio', selectedProjectId: null });
    }
    return result;
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
    () => taskCreationDraft?.task || state.tasks.find((task) => task.id === state.selectedTaskId) || null,
    [state.tasks, state.selectedTaskId, taskCreationDraft]
  );
  const workspace = useMemo(() => selectWorkspaceContext({
    workspaceMode: state.workspaceMode,
    selectedProjectId: state.selectedProjectId,
    projects: state.projects,
    tasks: state.tasks,
    wbs: state.wbs,
    people: state.people
  }), [
    state.workspaceMode,
    state.selectedProjectId,
    state.projects,
    state.tasks,
    state.wbs,
    state.people
  ]);
  const taskStats = useMemo(() => selectTaskStats(workspace.tasks), [workspace.tasks]);
  // Karşılama ekranı portföyün TAMAMINI özetlediğini söyler; çalışma alanı
  // ölçümleri son seçilen projeye daralmış olabilir, ikisi ayrı tutulur.
  const portfolioTaskStats = useMemo(() => selectTaskStats(state.tasks), [state.tasks]);
  const schedule = useMemo(
    () => buildPortfolioSchedule({ tasks: state.tasks, projects: state.projects, calendars: state.calendars }),
    [state.tasks, state.projects, state.calendars]
  );
  const actions = useMemo(() => ({
    openTask,
    closeTask,
    updateTask,
    saveTaskEdits,
    registerTaskEditorDraft,
    flushPendingChanges,
    flushTaskEdits,
    hasPendingChanges,
    retryFailedChanges,
    cancelTaskFieldUpdates,
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    submitScheduleChange,
    decideScheduleChange,
    addTask,
    beginTaskDraft,
    updateTaskDraft,
    cancelTaskDraft,
    saveTaskDraft,
    generateTaskSeries,
    addProject,
    updateProject,
    deleteProject,
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
    saveTaskEdits,
    registerTaskEditorDraft,
    flushPendingChanges,
    flushTaskEdits,
    hasPendingChanges,
    retryFailedChanges,
    cancelTaskFieldUpdates,
    moveTaskToWbs,
    moveTasksToWbs,
    deleteTask,
    submitScheduleChange,
    decideScheduleChange,
    addTask,
    beginTaskDraft,
    updateTaskDraft,
    cancelTaskDraft,
    saveTaskDraft,
    generateTaskSeries,
    addProject,
    updateProject,
    deleteProject,
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
  // Yenileme durumunu büyük uygulama bağlamından ayırır. `data/load-start`
  // yalnızca üst çubuktaki yaşam döngüsü tüketicilerini günceller; binlerce
  // görev satırı ve portföy görünümleri aynı iş verisiyle yeniden render olmaz.
  const value = useMemo(() => {
    const applicationState = {
      calendars: state.calendars,
      projects: state.projects,
      assignableProjects: state.assignableProjects,
      assignmentScopeSicils: state.assignmentScopeSicils,
      people: state.people,
      wbs: state.wbs,
      tasks: state.tasks,
      baselines: state.baselines,
      taskBaselineSnapshots: state.taskBaselineSnapshots,
      scheduleRequests: state.scheduleRequests,
      session: state.session,
      currentUser: state.currentUser,
      isSystemAdmin: state.isSystemAdmin,
      isExecutive: state.isExecutive,
      canCreateProjects: state.canCreateProjects,
      projectAccess: state.projectAccess,
      selectedTaskId: state.selectedTaskId,
      taskCreationDraft,
      workspaceMode: state.workspaceMode,
      selectedProjectId: state.selectedProjectId,
      wbsActionError: state.wbsActionError,
      pendingMutationCount: state.pendingMutationCount,
      saveError: state.saveError,
      lastSavedAt: state.lastSavedAt
    };
    return { ...applicationState, selectedTask, taskStats, portfolioTaskStats, schedule, workspace, actions };
  }, [
    state.calendars,
    state.projects,
    state.assignableProjects,
    state.assignmentScopeSicils,
    state.people,
    state.wbs,
    state.tasks,
    state.baselines,
    state.taskBaselineSnapshots,
    state.scheduleRequests,
    state.session,
    state.currentUser,
    state.isSystemAdmin,
    state.isExecutive,
    state.canCreateProjects,
    state.projectAccess,
    state.selectedTaskId,
    taskCreationDraft,
    state.workspaceMode,
    state.selectedProjectId,
    state.wbsActionError,
    state.pendingMutationCount,
    state.saveError,
    state.lastSavedAt,
    selectedTask,
    taskStats,
    portfolioTaskStats,
    schedule,
    workspace,
    actions
  ]);
  const dataLifecycle = useMemo(() => ({
    dataStatus: state.dataStatus,
    hasLoadedOnce: Boolean(state.hasLoadedOnce),
    loadError: state.loadError,
    pendingMutationCount: state.pendingMutationCount,
    isSaving: state.pendingMutationCount > 0,
    saveError: state.saveError,
    lastSavedAt: state.lastSavedAt,
    lastRefreshedAt: state.lastRefreshedAt,
    reloadData,
    retryFailedChanges,
    hasPendingChanges,
    clearPersistenceError
  }), [
    state.dataStatus,
    state.hasLoadedOnce,
    state.loadError,
    state.pendingMutationCount,
    state.saveError,
    state.lastSavedAt,
    state.lastRefreshedAt,
    reloadData,
    retryFailedChanges,
    hasPendingChanges,
    clearPersistenceError
  ]);

  return (
    <AppStateContext.Provider value={value}>
      <DataLifecycleContext.Provider value={dataLifecycle}>{children}</DataLifecycleContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider.');
  return value;
}

export function useDataLifecycleState() {
  const value = useContext(DataLifecycleContext);
  if (!value) throw new Error('useDataLifecycleState must be used inside AppStateProvider.');
  return value;
}
