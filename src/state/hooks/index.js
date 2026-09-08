'use client';
import { useAppState, useDataLifecycleState } from '../AppStateProvider';
import { selectAssignableProjects } from '../appState';
import { taskAssignableProjects } from '../projectWritePolicy.js';
import { selectPrimaryBaselineForProject, selectTaskBaselineSnapshot } from '../selectors/baselineSelectors';
import { selectProjectSchedule, selectTaskSchedule } from '../selectors/scheduleSelectors';

export function useTasks() { return useAppState().workspace.tasks; }
export function useAllTasks() { return useAppState().tasks; }
export function useProjects() { return useAppState().workspace.projects; }
export function useAllProjects() { return useAppState().projects; }
/**
 * Görev tanımlarken SEÇİLEBİLEN projeler.
 *
 * Sıradan kullanıcıda bu küme yazılabilir projeler ile sorumluluktan doğan dar
 * oluşturma projeleridir. Direktör/müdür/birim yöneticisinde ek olarak bütün
 * etkin CN43N projeleri gelir; görünürlük ve çalışma alanı seçicisi değişmez.
 */
export function useTaskAssignableProjects() { return taskAssignableProjects(useAppState()); }
/** Yalnızca görev atama kapsamıyla gelen (görünür olmayan) projeler. */
export function useAssignmentScopeProjects() { return selectAssignableProjects(useAppState()); }
/**
 * Sunucunun bildirdiği HAM görev atama kapsamı.
 *
 * YAZMA kararları bu listeyi kullanmalıdır. `useAssignmentScopeProjects()`
 * görünür olanları süzer (seçici listesini tekrarlamamak için); yönetici bu
 * projede bir görev oluşturur oluşturmaz proje PARTIAL görünür hâle gelir,
 * süzülmüş liste kapsamı düşürür ve yöneticinin kendi görevi salt okunur
 * açılırdı.
 */
export function useTaskAssignmentScope() { return useAppState().assignableProjects || []; }
/**
 * Atama kapsamı projelerinde göreve ATANABİLECEK çalışanların Sicilleri.
 *
 * Sunucu, bu projelerde görevin bütün sorumlularının yöneticinin
 * `MR_V_ExecutiveScope` kapsamında olmasını şart koşar. Küme boşsa (sıradan
 * kullanıcı) kısıtlama yoktur; seçiciler bütün rehberi göstermeye devam eder.
 */
export function useAssignmentScopeSicils() { return useAppState().assignmentScopeSicils || []; }
export function usePeople() { return useAppState().workspace.people; }
export function useAllPeople() { return useAppState().people; }
export function useWbs() { return useAppState().workspace.wbs; }
export function useAllWbs() { return useAppState().wbs; }
export function useWorkspaceTasks() { return useAppState().workspace.tasks; }
export function useWorkspaceWbs() { return useAppState().workspace.wbs; }
export function useWorkspacePeople() { return useAppState().workspace.people; }
export function useCalendars() { return useAppState().calendars; }
/** Oturum kullanıcısının sınırlı bildirim önizlemesi. */
const EMPTY_SCHEDULE_SUMMARY = Object.freeze({ unreadCount: 0, pendingCount: 0 });
export function useScheduleRequestSummary() { return useAppState().scheduleRequestSummary || EMPTY_SCHEDULE_SUMMARY; }
export function useScheduleRequests() { return useAppState().scheduleRequests || []; }
/**
 * Oturum açmış kullanıcı. Gerçek Sistem'de sunucunun doğruladığı Keycloak
 * oturumundan gelir; tarayıcı bu değeri uyduramaz.
 */
export function useCurrentUser() { return useAppState().currentUser; }
export function useSessionContext() { return useAppState().session; }
export function useSelectedTask() { return useAppState().selectedTask; }
export function useTaskCreationDraft() { return useAppState().taskCreationDraft; }
export function useTaskStats() { return useAppState().taskStats; }
/** Portföyün tamamı için ölçümler (çalışma alanı seçiminden bağımsız). */
export function usePortfolioTaskStats() { return useAppState().portfolioTaskStats; }
export function usePortfolioSchedule() { return useAppState().schedule; }
export function useProjectSchedule(projectId) { return selectProjectSchedule(useAppState().schedule, projectId); }
export function useTaskSchedule(taskId) { return selectTaskSchedule(useAppState().schedule, taskId); }
export function useWorkspace() {
  const state = useAppState();
  return { ...state.workspace, selectWorkspace: state.actions.selectWorkspace };
}
export function useTaskPrimaryBaseline(taskId) {
  const state = useAppState();
  const task = state.tasks.find((item) => item.id === taskId) || null;
  const baseline = selectPrimaryBaselineForProject(state.baselines, task?.projectId);
  const snapshot = selectTaskBaselineSnapshot(state.taskBaselineSnapshots, taskId, baseline?.id);
  return { baseline, snapshot };
}
export function useDataLifecycle() {
  return useDataLifecycleState();
}

export function normalizeTaskCreationInput(input) {
  if (!input || typeof input !== 'object') return input;
  const browserEvent = Boolean(input.nativeEvent)
    || (typeof input.preventDefault === 'function' && input.currentTarget && input.target);
  return browserEvent ? undefined : input;
}

export function useTaskActions() {
  const actions = useAppState().actions;
  return {
    ...actions,
    // Düğmenin tıklama olayı yanlışlıkla görev verisi olarak iletilse bile kayıt yüküne girmez.
    addTask: (input) => actions.addTask(normalizeTaskCreationInput(input)),
    beginTaskDraft: (input) => actions.beginTaskDraft(normalizeTaskCreationInput(input))
  };
}
export function useWbsActions() {
  const state = useAppState();
  return {
    addWbsChild: state.actions.addWbsChild,
    renameWbs: state.actions.renameWbs,
    reparentWbs: state.actions.reparentWbs,
    moveWbsNode: state.actions.moveWbsNode,
    deleteWbs: state.actions.deleteWbs,
    clearWbsError: state.actions.clearWbsError,
    error: state.wbsActionError
  };
}
