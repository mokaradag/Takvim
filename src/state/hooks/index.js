'use client';
import { useAppState } from '../AppStateProvider';

export function useTasks() { return useAppState().tasks; }
export function useProjects() { return useAppState().projects; }
export function usePeople() { return useAppState().people; }
export function useWbs() { return useAppState().wbs; }
export function useCalendars() { return useAppState().calendars; }
export function useSelectedTask() { return useAppState().selectedTask; }
export function useTaskStats() { return useAppState().taskStats; }
export function useTaskActions() { return useAppState().actions; }
