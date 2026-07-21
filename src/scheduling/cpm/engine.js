import { fmtISO, parseDate } from '../dates/index.js';
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  countWorkingDays,
  diffWorkingDays,
  moveToWorkingDay,
  resolveTaskCalendar
} from '../calendars/index.js';
import { applyDependencyLag } from '../dependencies/index.js';
import { buildDependencyGraph, CpmValidationError } from './graph.js';

function dateOnly(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function requireValidDate(value, taskId, field) {
  if (!value) {
    throw new CpmValidationError(
      'MISSING_TASK_DATE',
      `Task ${taskId} is missing ${field}.`,
      { taskId, field }
    );
  }
  const date = dateOnly(value);
  if (Number.isNaN(date.getTime())) {
    throw new CpmValidationError(
      'INVALID_TASK_DATE',
      `Task ${taskId} has invalid ${field}: ${value}`,
      { taskId, field, value }
    );
  }
  return date;
}

function inferProjectStart(tasks) {
  const starts = (tasks || [])
    .filter((task) => task.baslangicTarihi)
    .map((task) => requireValidDate(task.baslangicTarihi, task.id, 'baslangicTarihi'));

  if (!starts.length) {
    throw new CpmValidationError(
      'MISSING_PROJECT_START',
      'CPM requires projectStart or at least one task baslangicTarihi.'
    );
  }

  return starts.reduce((earliest, date) => (date < earliest ? date : earliest));
}

function activityDuration(task, calendar) {
  if (Number.isFinite(task.durationDays)) return Math.max(0, Math.trunc(task.durationDays));
  if (task.milestone) return 0;

  const start = requireValidDate(task.baslangicTarihi, task.id, 'baslangicTarihi');
  const end = requireValidDate(task.bitisTarihi, task.id, 'bitisTarihi');
  if (end < start) {
    throw new CpmValidationError(
      'INVALID_TASK_DATES',
      `Task ${task.id} ends before it starts.`,
      { taskId: task.id, start: fmtISO(start), end: fmtISO(end) }
    );
  }

  return Math.max(1, countWorkingDays(start, end, calendar));
}

function finishFromStart(start, durationDays, calendar) {
  const alignedStart = moveToWorkingDay(start, calendar, 1);
  if (durationDays === 0) return alignedStart;
  return addWorkingDays(alignedStart, durationDays - 1, calendar);
}

function startFromFinish(finish, durationDays, calendar) {
  const alignedFinish = moveToWorkingDay(finish, calendar, -1);
  if (durationDays === 0) return alignedFinish;
  return addWorkingDays(alignedFinish, -(durationDays - 1), calendar);
}

function latestDate(values) {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function earliestDate(values) {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function forwardConstraint(predecessorSchedule, dependency, successorDuration, successorCalendar) {
  switch (dependency.type) {
    case 'SS': {
      const start = applyDependencyLag(predecessorSchedule.earlyStart, dependency, successorCalendar);
      return moveToWorkingDay(start, successorCalendar, 1);
    }
    case 'FF': {
      const finish = applyDependencyLag(predecessorSchedule.earlyFinish, dependency, successorCalendar);
      return startFromFinish(moveToWorkingDay(finish, successorCalendar, 1), successorDuration, successorCalendar);
    }
    case 'SF': {
      const finish = applyDependencyLag(predecessorSchedule.earlyStart, dependency, successorCalendar);
      return startFromFinish(moveToWorkingDay(finish, successorCalendar, 1), successorDuration, successorCalendar);
    }
    case 'FS':
    default: {
      const laggedFinish = applyDependencyLag(predecessorSchedule.earlyFinish, dependency, successorCalendar);
      return moveToWorkingDay(addWorkingDays(laggedFinish, 1, successorCalendar), successorCalendar, 1);
    }
  }
}

function backwardStartBound(taskSchedule, successorSchedule, dependency, taskCalendar, successorCalendar) {
  switch (dependency.type) {
    case 'SS': {
      const bound = addWorkingDays(successorSchedule.lateStart, -dependency.lagDays, successorCalendar);
      return moveToWorkingDay(bound, taskCalendar, -1);
    }
    case 'FF': {
      const finishBound = addWorkingDays(successorSchedule.lateFinish, -dependency.lagDays, successorCalendar);
      return startFromFinish(moveToWorkingDay(finishBound, taskCalendar, -1), taskSchedule.durationDays, taskCalendar);
    }
    case 'SF': {
      const bound = addWorkingDays(successorSchedule.lateFinish, -dependency.lagDays, successorCalendar);
      return moveToWorkingDay(bound, taskCalendar, -1);
    }
    case 'FS':
    default: {
      const finishBound = addWorkingDays(
        successorSchedule.lateStart,
        -(dependency.lagDays + 1),
        successorCalendar
      );
      return startFromFinish(moveToWorkingDay(finishBound, taskCalendar, -1), taskSchedule.durationDays, taskCalendar);
    }
  }
}

function relationshipSlack(edge, schedules, metadata) {
  const predecessor = schedules.get(edge.predecessorId);
  const successor = schedules.get(edge.successorId);
  const successorMeta = metadata.get(edge.successorId);
  const requiredStart = forwardConstraint(
    predecessor,
    edge.dependency,
    successorMeta.durationDays,
    successorMeta.calendar
  );
  return Math.max(0, diffWorkingDays(successor.earlyStart, requiredStart, successorMeta.calendar));
}

function findCriticalPaths(graph, schedules, metadata) {
  const criticalIds = new Set(
    graph.topologicalOrder.filter((id) => schedules.get(id).totalFloatDays <= 0)
  );
  const criticalOutgoing = new Map(graph.topologicalOrder.map((id) => [id, []]));
  const criticalIncomingCount = new Map(graph.topologicalOrder.map((id) => [id, 0]));

  for (const edge of graph.edges) {
    if (!criticalIds.has(edge.predecessorId) || !criticalIds.has(edge.successorId)) continue;
    if (relationshipSlack(edge, schedules, metadata) !== 0) continue;
    criticalOutgoing.get(edge.predecessorId).push(edge.successorId);
    criticalIncomingCount.set(edge.successorId, criticalIncomingCount.get(edge.successorId) + 1);
  }

  const starts = graph.topologicalOrder.filter(
    (id) => criticalIds.has(id) && criticalIncomingCount.get(id) === 0
  );
  const paths = [];

  function visit(taskId, path) {
    const nextPath = [...path, taskId];
    const successors = criticalOutgoing.get(taskId);
    if (!successors.length) {
      paths.push(nextPath);
      return;
    }
    for (const successorId of successors) visit(successorId, nextPath);
  }

  for (const taskId of starts) visit(taskId, []);
  return paths;
}

function serializeSchedule(schedule) {
  return {
    id: schedule.id,
    calendarId: schedule.calendarId,
    durationDays: schedule.durationDays,
    earlyStart: fmtISO(schedule.earlyStart),
    earlyFinish: fmtISO(schedule.earlyFinish),
    lateStart: fmtISO(schedule.lateStart),
    lateFinish: fmtISO(schedule.lateFinish),
    totalFloatDays: schedule.totalFloatDays,
    freeFloatDays: schedule.freeFloatDays,
    isCritical: schedule.totalFloatDays <= 0
  };
}

export function calculateCpm(tasks, {
  projects = [],
  calendars = [],
  projectStart = null,
  fallbackCalendar = DEFAULT_CALENDAR
} = {}) {
  if (!tasks?.length) {
    return {
      projectStart: null,
      projectFinish: null,
      orderedTaskIds: [],
      criticalTaskIds: [],
      criticalPaths: [],
      tasks: {}
    };
  }

  const graph = buildDependencyGraph(tasks);
  const startAnchor = projectStart ? dateOnly(projectStart) : inferProjectStart(tasks);
  if (Number.isNaN(startAnchor.getTime())) {
    throw new CpmValidationError('INVALID_PROJECT_START', `Invalid projectStart: ${projectStart}`, { projectStart });
  }

  const metadata = new Map();
  for (const taskId of graph.topologicalOrder) {
    const task = graph.tasksById.get(taskId);
    const calendar = resolveTaskCalendar(task, projects, calendars, fallbackCalendar);
    metadata.set(taskId, {
      task,
      calendar,
      durationDays: activityDuration(task, calendar)
    });
  }

  const schedules = new Map();

  for (const taskId of graph.topologicalOrder) {
    const meta = metadata.get(taskId);
    const startCandidates = [moveToWorkingDay(startAnchor, meta.calendar, 1)];

    for (const edge of graph.incoming.get(taskId)) {
      startCandidates.push(
        forwardConstraint(
          schedules.get(edge.predecessorId),
          edge.dependency,
          meta.durationDays,
          meta.calendar
        )
      );
    }

    const earlyStart = latestDate(startCandidates);
    const earlyFinish = finishFromStart(earlyStart, meta.durationDays, meta.calendar);
    schedules.set(taskId, {
      id: taskId,
      calendarId: meta.calendar.id,
      durationDays: meta.durationDays,
      earlyStart,
      earlyFinish,
      lateStart: null,
      lateFinish: null,
      totalFloatDays: null,
      freeFloatDays: null
    });
  }

  const projectFinish = latestDate([...schedules.values()].map((schedule) => schedule.earlyFinish));

  for (const taskId of [...graph.topologicalOrder].reverse()) {
    const meta = metadata.get(taskId);
    const schedule = schedules.get(taskId);
    const projectFinishBound = moveToWorkingDay(projectFinish, meta.calendar, -1);
    const startBounds = [startFromFinish(projectFinishBound, meta.durationDays, meta.calendar)];

    for (const edge of graph.outgoing.get(taskId)) {
      const successorSchedule = schedules.get(edge.successorId);
      const successorMeta = metadata.get(edge.successorId);
      startBounds.push(
        backwardStartBound(
          schedule,
          successorSchedule,
          edge.dependency,
          meta.calendar,
          successorMeta.calendar
        )
      );
    }

    schedule.lateStart = earliestDate(startBounds);
    schedule.lateFinish = finishFromStart(schedule.lateStart, meta.durationDays, meta.calendar);
    schedule.totalFloatDays = diffWorkingDays(schedule.lateStart, schedule.earlyStart, meta.calendar);
  }

  for (const taskId of graph.topologicalOrder) {
    const schedule = schedules.get(taskId);
    const meta = metadata.get(taskId);
    const outgoing = graph.outgoing.get(taskId);
    if (!outgoing.length) {
      const finishBound = moveToWorkingDay(projectFinish, meta.calendar, -1);
      schedule.freeFloatDays = Math.max(0, diffWorkingDays(finishBound, schedule.earlyFinish, meta.calendar));
    } else {
      schedule.freeFloatDays = Math.min(...outgoing.map((edge) => relationshipSlack(edge, schedules, metadata)));
    }
  }

  const actualProjectStart = earliestDate([...schedules.values()].map((schedule) => schedule.earlyStart));
  const criticalTaskIds = graph.topologicalOrder.filter((id) => schedules.get(id).totalFloatDays <= 0);
  const criticalPaths = findCriticalPaths(graph, schedules, metadata);
  const serializedTasks = Object.fromEntries(
    graph.topologicalOrder.map((id) => [id, serializeSchedule(schedules.get(id))])
  );

  return {
    projectStart: fmtISO(actualProjectStart),
    projectFinish: fmtISO(projectFinish),
    orderedTaskIds: [...graph.topologicalOrder],
    criticalTaskIds,
    criticalPaths,
    tasks: serializedTasks
  };
}
