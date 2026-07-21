'use client';
import { useAppState } from '../AppStateProvider';
import { selectPrimaryBaselineForProject, selectTaskBaselineSnapshot } from '../selectors/baselineSelectors';
import { selectProjectSchedule, selectTaskSchedule } from '../selectors/scheduleSelectors';

export function useTasks() { return useAppState().tasks; }
export function useProjects() { return useAppState().projects; }
export function usePeople() { return useAppState().people; }
export function useWbs() { return useAppState().wbs; }
export function useCalendars() { return useAppState().calendars; }
export function useSelectedTask() { return useAppState().selectedTask; }
export function useTaskStats() { return useAppState().taskStats; }
export function usePortfolioSchedule() { return useAppState().schedule; }
export function useProjectSchedule(projectId) { return selectProjectSchedule(useAppState().schedule, projectId); }
export function useTaskSchedule(taskId) { return selectTaskSchedule(useAppState().schedule, taskId); }
export function useTaskPrimaryBaseline(taskId) {
  const state = useAppState();
  const task = state.tasks.find((item) => item.id === taskId) || null;
  const baseline = selectPrimaryBaselineForProject(state.baselines, task?.projectId);
  const snapshot = selectTaskBaselineSnapshot(state.taskBaselineSnapshots, taskId, baseline?.id);
  return { baseline, snapshot };
}
export function useTaskActions() { return useAppState().actions; }
