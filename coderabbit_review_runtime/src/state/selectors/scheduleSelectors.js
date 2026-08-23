import { calculateCpm } from '../../scheduling/cpm/index.js';
import { normalizeDependency } from '../../scheduling/dependencies/index.js';

function serializeScheduleError(error) {
  return {
    code: error?.code || 'CPM_CALCULATION_FAILED',
    message: error?.message || 'CPM calculation failed.',
    details: error?.details || {}
  };
}

function findCrossProjectDependencies(project, projectTasks, tasksById) {
  const unsupported = [];
  for (const task of projectTasks) {
    for (const rawDependency of task.deps || []) {
      const dependency = normalizeDependency(rawDependency);
      const predecessor = tasksById.get(dependency.predecessorId);
      if (!predecessor || predecessor.projectId === project.id) continue;
      unsupported.push({
        taskId: task.id,
        predecessorId: dependency.predecessorId,
        predecessorProjectId: predecessor.projectId || null,
        type: dependency.type,
        lagDays: dependency.lagDays
      });
    }
  }
  return unsupported;
}

function criticalDependencyKeys(criticalPaths) {
  const keys = new Set();
  for (const path of criticalPaths || []) {
    for (let index = 1; index < path.length; index += 1) keys.add(`${path[index - 1]}::${path[index]}`);
  }
  return [...keys];
}

function scheduleShape(projectId, status, error = null) {
  return {
    projectId,
    projectStart: null,
    projectFinish: null,
    criticalTaskIds: [],
    criticalPaths: [],
    criticalDependencyKeys: [],
    tasks: {},
    status,
    error
  };
}
function emptyProjectSchedule(projectId) { return scheduleShape(projectId, 'empty'); }
function invalidProjectSchedule(projectId, error) { return scheduleShape(projectId, 'invalid', error); }
function suppressedProjectSchedule(projectId) {
  return scheduleShape(projectId, 'suppressed-partial', {
    code: 'PARTIAL_PROJECT_NETWORK',
    message: 'Complete-project CPM is unavailable because this user can see only an authorized subset of the Project network.',
    details: { projectId }
  });
}
function isPartialProject(project) {
  return project?.accessLevel === 'PARTIAL' || project?.schedulingCapability === 'SUPPRESSED_PARTIAL';
}

export function buildPortfolioSchedule({ tasks = [], projects = [], calendars = [] } = {}) {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const tasksById = new Map(tasks.filter((task) => task?.id).map((task) => [task.id, task]));
  const tasksByProjectId = new Map(projects.map((project) => [project.id, []]));
  const warnings = [];

  for (const task of tasks) {
    if (!task?.projectId || !projectsById.has(task.projectId)) {
      warnings.push({
        scope: 'task',
        taskId: task?.id || null,
        projectId: task?.projectId || null,
        code: 'UNKNOWN_PROJECT',
        message: `Task ${task?.id || '(unknown)'} cannot be scheduled because its project is missing.`,
        details: { taskId: task?.id || null, projectId: task?.projectId || null }
      });
      continue;
    }
    tasksByProjectId.get(task.projectId).push(task);
  }

  const projectSchedules = {};
  const taskSchedules = {};
  const allCriticalTaskIds = [];

  for (const project of projects) {
    const projectTasks = tasksByProjectId.get(project.id) || [];
    if (isPartialProject(project)) {
      const suppressed = suppressedProjectSchedule(project.id);
      projectSchedules[project.id] = suppressed;
      warnings.push({ scope: 'project', projectId: project.id, ...suppressed.error });
      continue;
    }
    if (!projectTasks.length) {
      projectSchedules[project.id] = emptyProjectSchedule(project.id);
      continue;
    }

    const crossProjectDependencies = findCrossProjectDependencies(project, projectTasks, tasksById);
    if (crossProjectDependencies.length) {
      const error = {
        code: 'CROSS_PROJECT_DEPENDENCY',
        message: `Project ${project.id} contains ${crossProjectDependencies.length} cross-project dependency relationship(s), which are not supported by project-scoped CPM.`,
        details: { projectId: project.id, dependencies: crossProjectDependencies }
      };
      projectSchedules[project.id] = invalidProjectSchedule(project.id, error);
      warnings.push({ scope: 'project', projectId: project.id, ...error });
      continue;
    }

    try {
      const cpm = calculateCpm(projectTasks, { projects: [project], calendars });
      const projectedTasks = Object.fromEntries(
        Object.entries(cpm.tasks).map(([taskId, taskSchedule]) => [taskId, { ...taskSchedule, projectId: project.id }])
      );
      projectSchedules[project.id] = {
        projectId: project.id,
        projectStart: cpm.projectStart,
        projectFinish: cpm.projectFinish,
        criticalTaskIds: [...cpm.criticalTaskIds],
        criticalPaths: cpm.criticalPaths.map((path) => [...path]),
        criticalDependencyKeys: criticalDependencyKeys(cpm.criticalPaths),
        tasks: projectedTasks,
        status: 'valid',
        error: null
      };
      Object.assign(taskSchedules, projectedTasks);
      allCriticalTaskIds.push(...cpm.criticalTaskIds);
    } catch (rawError) {
      const error = serializeScheduleError(rawError);
      projectSchedules[project.id] = invalidProjectSchedule(project.id, error);
      warnings.push({ scope: 'project', projectId: project.id, ...error });
    }
  }

  return {
    projects: projectSchedules,
    tasks: taskSchedules,
    criticalTaskIds: allCriticalTaskIds,
    warnings,
    status: warnings.length ? 'warning' : 'valid'
  };
}

export function selectProjectSchedule(schedule, projectId) {
  return schedule?.projects?.[projectId] || null;
}
export function selectTaskSchedule(schedule, taskId) {
  return schedule?.tasks?.[taskId] || null;
}
