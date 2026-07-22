import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASELINES,
  CALENDARS,
  PEOPLE,
  PROJECTS,
  TASK_BASELINE_SNAPSHOTS,
  TASKS,
  WBS
} from '../src/data/mock/seed.js';
import {
  selectDefaultProjectWbs,
  selectWbsAncestors
} from '../src/domain/selectors/index.js';
import {
  validateTaskBaselineSnapshot,
  validateTaskSchedule,
  validateWbsStructure
} from '../src/domain/validation/index.js';
import { resolveTaskCalendar } from '../src/scheduling/calendars/index.js';
import { REL_TYPES } from '../src/scheduling/dependencies/index.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';

function expectUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const projectsById = new Map(PROJECTS.map((project) => [project.id, project]));
const peopleById = new Map(PEOPLE.map((person) => [person.id, person]));
const calendarsById = new Map(CALENDARS.map((calendar) => [calendar.id, calendar]));
const wbsById = new Map(WBS.map((node) => [node.id, node]));
const tasksById = new Map(TASKS.map((task) => [task.id, task]));
const baselinesById = new Map(BASELINES.map((baseline) => [baseline.id, baseline]));

test('seed collection IDs are globally unique inside each canonical collection', () => {
  expectUnique(CALENDARS.map((item) => item.id), 'calendar ids');
  expectUnique(PROJECTS.map((item) => item.id), 'project ids');
  expectUnique(PEOPLE.map((item) => item.id), 'people ids');
  expectUnique(WBS.map((item) => item.id), 'WBS ids');
  expectUnique(TASKS.map((item) => item.id), 'task ids');
  expectUnique(BASELINES.map((item) => item.id), 'baseline ids');
});

test('seed project and person display names are unique', () => {
  expectUnique(PROJECTS.map((item) => item.name), 'project names');
  expectUnique(PEOPLE.map((item) => item.name), 'people names');
});

test('every seed project references an existing calendar', () => {
  for (const project of PROJECTS) {
    assert.equal(calendarsById.has(project.calendarId), true, project.id);
  }
});

test('every seed project resolves its lead to an existing person', () => {
  for (const project of PROJECTS) {
    assert.equal(peopleById.has(project.leadId), true, project.id);
  }
});

test('every seed project has a valid ISO data date', () => {
  for (const project of PROJECTS) {
    assert.equal(isIsoDate(project.dataDate), true, project.id);
  }
});

test('calendar working-day definitions contain unique weekday numbers only', () => {
  for (const calendar of CALENDARS) {
    assert.equal(calendar.workingDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6), true, calendar.id);
    expectUnique(calendar.workingDays, `${calendar.id} working days`);
  }
});

test('calendar holiday dates are unique within each calendar', () => {
  for (const calendar of CALENDARS) {
    const dates = calendar.holidays.map((holiday) => holiday.date);
    assert.equal(dates.every(isIsoDate), true, calendar.id);
    expectUnique(dates, `${calendar.id} holiday dates`);
  }
});

test('seed WBS structure has no structural validation issues', () => {
  assert.deepEqual(validateWbsStructure(WBS), []);
});

test('every WBS node belongs to an existing project', () => {
  for (const node of WBS) {
    assert.equal(projectsById.has(node.projectId), true, node.id);
  }
});

test('every project has exactly one natural default WBS root', () => {
  for (const project of PROJECTS) {
    const root = selectDefaultProjectWbs(WBS, project.id);
    assert.ok(root, project.id);
    assert.equal(root.projectId, project.id);
    assert.equal(root.parentId, null);
  }
});

test('WBS codes are unique within each project', () => {
  for (const project of PROJECTS) {
    const codes = WBS.filter((node) => node.projectId === project.id).map((node) => node.code);
    expectUnique(codes, `${project.id} WBS codes`);
  }
});

test('every non-root WBS node has same-project ancestors only', () => {
  for (const node of WBS) {
    for (const ancestor of selectWbsAncestors(WBS, node.id)) {
      assert.equal(ancestor.projectId, node.projectId, `${node.id} -> ${ancestor.id}`);
    }
  }
});

test('every seed task belongs to an existing project and WBS node', () => {
  for (const task of TASKS) {
    assert.equal(projectsById.has(task.projectId), true, task.id);
    assert.equal(wbsById.has(task.wbsId), true, task.id);
    assert.equal(wbsById.get(task.wbsId).projectId, task.projectId, task.id);
  }
});

test('every seed task assignee ID resolves to the matching canonical display name', () => {
  for (const task of TASKS) {
    assert.equal(task.assigneeIds.every((id) => peopleById.has(id)), true, task.id);
    assert.deepEqual(task.assigneeIds.map((id) => peopleById.get(id).name), task.sorumlu, task.id);
  }
});

test('every seed task resolves to an available scheduling calendar', () => {
  for (const task of TASKS) {
    const calendar = resolveTaskCalendar(task, PROJECTS, CALENDARS);
    assert.ok(calendar, task.id);
    assert.equal(calendarsById.has(calendar.id), true, task.id);
  }
});

test('every seed task passes canonical schedule validation', () => {
  for (const task of TASKS) {
    assert.deepEqual(validateTaskSchedule(task), [], task.id);
  }
});

test('seed milestones always use zero duration and a single planned date', () => {
  for (const task of TASKS.filter((item) => item.milestone)) {
    assert.equal(task.plannedDurationDays, 0, task.id);
    assert.equal(task.plannedStart, task.plannedFinish, task.id);
  }
});

test('non-milestone seed tasks have finite non-negative planned durations', () => {
  for (const task of TASKS.filter((item) => !item.milestone)) {
    assert.equal(Number.isFinite(task.plannedDurationDays), true, task.id);
    assert.equal(task.plannedDurationDays >= 0, true, task.id);
  }
});

test('seed dependency records are normalized and reference existing tasks', () => {
  for (const task of TASKS) {
    for (const dependency of task.deps || []) {
      assert.equal(dependency.id, dependency.predecessorId, task.id);
      assert.equal(tasksById.has(dependency.predecessorId), true, `${task.id} -> ${dependency.predecessorId}`);
      assert.equal(Object.hasOwn(REL_TYPES, dependency.type), true, `${task.id} ${dependency.type}`);
      assert.equal(Number.isFinite(dependency.lagDays), true, task.id);
    }
  }
});

test('every project has exactly one primary baseline', () => {
  for (const project of PROJECTS) {
    const baselines = BASELINES.filter((baseline) => baseline.projectId === project.id && baseline.isPrimary);
    assert.equal(baselines.length, 1, project.id);
  }
});

test('every baseline belongs to an existing project and has a valid creation date', () => {
  for (const baseline of BASELINES) {
    assert.equal(projectsById.has(baseline.projectId), true, baseline.id);
    assert.equal(isIsoDate(baseline.createdAt), true, baseline.id);
  }
});

test('every baseline snapshot passes historical schedule validation', () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    assert.deepEqual(validateTaskBaselineSnapshot(snapshot), [], snapshot.taskId);
  }
});

test('every task has exactly one snapshot for its project primary baseline', () => {
  for (const task of TASKS) {
    const primary = BASELINES.find((baseline) => baseline.projectId === task.projectId && baseline.isPrimary);
    const snapshots = TASK_BASELINE_SNAPSHOTS.filter((snapshot) => (
      snapshot.taskId === task.id && snapshot.baselineId === primary.id
    ));
    assert.equal(snapshots.length, 1, task.id);
  }
});

test('baseline snapshots reference existing tasks and baselines from the same project', () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    const task = tasksById.get(snapshot.taskId);
    const baseline = baselinesById.get(snapshot.baselineId);
    assert.ok(task, snapshot.taskId);
    assert.ok(baseline, snapshot.baselineId);
    assert.equal(task.projectId, baseline.projectId, snapshot.taskId);
    assert.equal(calendarsById.has(snapshot.calendarId), true, snapshot.taskId);
  }
});

test('initial baseline snapshots preserve the normalized seed task plan', () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    const task = tasksById.get(snapshot.taskId);
    assert.equal(snapshot.plannedStart, task.plannedStart, task.id);
    assert.equal(snapshot.plannedFinish, task.plannedFinish, task.id);
    assert.equal(snapshot.plannedDurationDays, task.plannedDurationDays, task.id);
  }
});

test('portfolio scheduling represents every seed project even when one project is invalid', () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  assert.deepEqual(Object.keys(schedule.projects).sort(), PROJECTS.map((project) => project.id).sort());
});

test('cross-project seed dependencies are surfaced as explicit project warnings', () => {
  const expected = [];
  for (const task of TASKS) {
    for (const dependency of task.deps || []) {
      const predecessor = tasksById.get(dependency.predecessorId);
      if (predecessor && predecessor.projectId !== task.projectId) {
        expected.push({
          taskId: task.id,
          predecessorId: predecessor.id,
          projectId: task.projectId,
          predecessorProjectId: predecessor.projectId
        });
      }
    }
  }

  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  const actual = schedule.warnings
    .filter((warning) => warning.code === 'CROSS_PROJECT_DEPENDENCY')
    .flatMap((warning) => warning.details.dependencies.map((dependency) => ({
      taskId: dependency.taskId,
      predecessorId: dependency.predecessorId,
      projectId: warning.projectId,
      predecessorProjectId: dependency.predecessorProjectId
    })));

  assert.deepEqual(actual, expected);
  assert.equal(schedule.status, expected.length ? 'warning' : 'valid');
});

test('tasks from valid seed projects receive derived schedule projections', () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  for (const task of TASKS) {
    const projectSchedule = schedule.projects[task.projectId];
    if (projectSchedule.status === 'valid') assert.ok(schedule.tasks[task.id], task.id);
    else assert.equal(schedule.tasks[task.id], undefined, task.id);
  }
});

test('portfolio critical task aggregation does not duplicate task IDs', () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  expectUnique(schedule.criticalTaskIds, 'critical task ids');
});
