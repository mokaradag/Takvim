'use client';
import { useAppState } from '../AppStateProvider';
import { selectPrimaryBaselineForProject, selectTaskBaselineSnapshot } from '../selectors/baselineSelectors';
import { selectProjectSchedule, selectTaskSchedule } from '../selectors/scheduleSelectors';

export function useTasks() { return useAppState().workspace.tasks; }
export function useAllTasks() { return useAppState().tasks; }
export function useProjects() { return useAppState().workspace.projects; }
export function useAllProjects() { return useAppState().projects; }
export function usePeople() { return useAppState().workspace.people; }
export function useAllPeople() { return useAppState().people; }
export function useWbs() { return useAppState().workspace.wbs; }
export function useAllWbs() { return useAppState().wbs; }
export function useWorkspaceTasks() { return useAppState().workspace.tasks; }
export function useWorkspaceWbs() { return useAppState().workspace.wbs; }
export function useWorkspacePeople() { return useAppState().workspace.people; }
export function useCalendars() { return useAppState().calendars; }
export function useSelectedTask() { return useAppState().selectedTask; }
export function useTaskStats() { return useAppState().taskStats; }
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
  const state = useAppState();
  return {
    dataStatus: state.dataStatus,
    loadError: state.loadError,
    pendingMutationCount: state.pendingMutationCount,
    isSaving: state.pendingMutationCount > 0,
    saveError: state.saveError,
    lastSavedAt: state.lastSavedAt,
    reloadData: state.actions.reloadData,
    clearPersistenceError: state.actions.clearPersistenceError
  };
}
export function useTaskActions() { return useAppState().actions; }
export function useWbsActions() {
  const state = useAppState();
  return {
    addWbsChild: state.actions.addWbsChild,
    renameWbs: state.actions.renameWbs,
    reparentWbs: state.actions.reparentWbs,
    deleteWbs: state.actions.deleteWbs,
    clearWbsError: state.actions.clearWbsError,
    error: state.wbsActionError
  };
}
