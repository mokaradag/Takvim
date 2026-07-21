import { normalizeTaskRecord } from '../data/normalizeTaskRecord.js';
import { fmtISO, today } from '../scheduling/dates/index.js';
import { addWorkingDays, moveToWorkingDay, resolveProjectCalendar } from '../scheduling/calendars/index.js';

function taskContext(state) {
  return {
    projects: state.projects || [],
    people: state.people || [],
    wbs: state.wbs || [],
    calendars: state.calendars || []
  };
}

export function createInitialState(repository) {
  const snapshot = repository.getSnapshot();
  const base = {
    ...snapshot,
    calendars: snapshot.calendars || [],
    projects: snapshot.projects || [],
    people: snapshot.people || [],
    wbs: snapshot.wbs || [],
    baselines: snapshot.baselines || [],
    taskBaselineSnapshots: snapshot.taskBaselineSnapshots || []
  };

  return {
    ...base,
    tasks: (snapshot.tasks || []).map((task) => normalizeTaskRecord(task, taskContext(base))),
    selectedTaskId: null
  };
}

export function normalizeStateTask(task, state) {
  return normalizeTaskRecord(task, taskContext(state));
}

export function appStateReducer(state, action) {
  switch (action.type) {
    case 'task/add':
      return { ...state, tasks: [action.task, ...state.tasks], selectedTaskId: action.task.id };
    case 'task/update':
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          if (task.id !== action.id) return task;
          const next = { ...task, ...action.patch };
          if (Object.prototype.hasOwnProperty.call(action.patch, 'sorumlu')) delete next.assigneeIds;
          if (Object.prototype.hasOwnProperty.call(action.patch, 'proje')) {
            delete next.projectId;
            delete next.wbsId;
          }
          return normalizeStateTask(next, state);
        })
      };
    case 'task/delete':
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== action.id),
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId
      };
    case 'task/select':
      return { ...state, selectedTaskId: action.id || null };
    default:
      return state;
  }
}

export function createNewTask(state, referenceDate = today(), id = `n-${Date.now()}`) {
  const project = state.projects[0];
  const person = state.people[0];
  const calendar = resolveProjectCalendar(project, state.calendars);
  const start = moveToWorkingDay(referenceDate, calendar, 1);

  const task = normalizeStateTask({
    id,
    projectId: project?.id || null,
    proje: project?.name || '',
    task: 'Yeni görev',
    keyword: 'Yeni',
    assigneeIds: person ? [person.id] : [],
    sorumlu: person ? [person.name] : [],
    status: 'todo',
    plannedStart: fmtISO(start),
    plannedFinish: fmtISO(addWorkingDays(start, 5, calendar)),
    targetFinish: fmtISO(addWorkingDays(start, 7, calendar)),
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    color: project?.color || 'blue',
    deps: []
  }, state);

  return {
    ...task,
    remainingDurationDays: task.plannedDurationDays
  };
}
