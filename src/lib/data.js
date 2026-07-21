// Compatibility barrel for older imports. New feature code imports from the
// explicit domain, scheduling, data and presentation modules instead.
export { PRIORITIES, TASK_STATUSES } from '../domain/constants';
export * from '../scheduling/dates';
export * from '../scheduling/calendars';
export * from '../scheduling/dependencies';
export { getStatus, getTaskDateRange, getGroupScheduleSummaries, selectTaskStats, taskDurationDays } from '../scheduling/metrics';
export { COLOR_MAP, personColorVar, personInitials, projectColorKey, projectColorVar } from './colors';
export { PEOPLE, PROJECTS, TASKS, WBS } from '../data/mock/seed';
