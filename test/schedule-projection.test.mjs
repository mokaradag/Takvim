import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCalendar } from '../src/scheduling/calendars/index.js';
import {
  buildPortfolioSchedule,
  selectProjectSchedule,
  selectTaskSchedule
} from '../src/state/selectors/scheduleSelectors.js';

const calendar = normalizeCalendar({
  id: 'cal-standard',
  name: 'Standard',
  timezone: 'Europe/Istanbul',
  workingDays: [1, 2, 3, 4, 5],
  holidays: []
});

const projects = [
  { id: 'p1', name: 'Project A', calendarId: calendar.id },
  { id: 'p2', name: 'Project B', calendarId: calendar.id },
  { id: 'p3', name: 'Empty Project', calendarId: calendar.id }
];

function dependency(predecessorId, type = 'FS', lagDays = 0) {
  return { predecessorId, type, lagDays };
}

function task(projectId, id, plannedDurationDays, deps = [], start = '2026-06-01') {
  return {
    id,
    projectId,
    task: id,
    plannedDurationDays,
    deps,
    plannedStart: start,
    plannedFinish: start
  };
}

function build(tasks, projectList = projects) {
  return buildPortfolioSchedule({ tasks, projects: projectList, calendars: [calendar] });
}

test("CPM ilgisiz projeler için bağımsız hesaplanır", () => {
  const schedule = build([
    task('p1', 'A', 2),
    task('p2', 'B', 10)
  ]);

  assert.equal(schedule.projects.p1.projectFinish, '2026-06-02');
  assert.equal(schedule.projects.p2.projectFinish, '2026-06-12');
  assert.equal(schedule.tasks.A.totalFloatDays, 0);
  assert.equal(schedule.tasks.B.totalFloatDays, 0);
});

test("başka proje geçersizken geçerli proje kullanılabilir kalır", () => {
  const schedule = build([
    task('p1', 'A', 1),
    task('p1', 'B', 1, [dependency('A')]),
    task('p2', 'C', 1, [dependency('D')]),
    task('p2', 'D', 1, [dependency('C')])
  ]);

  assert.equal(schedule.projects.p1.status, 'valid');
  assert.equal(schedule.projects.p2.status, 'invalid');
  assert.equal(schedule.projects.p2.error.code, 'DEPENDENCY_CYCLE');
  assert.equal(schedule.tasks.A.isCritical, true);
  assert.equal(schedule.tasks.C, undefined);
  assert.ok(schedule.warnings.some((warning) => warning.projectId === 'p2' && warning.code === 'DEPENDENCY_CYCLE'));
});

test("görev düzeyi çizelge araması izdüşürülmüş CPM sonucunu döndürür", () => {
  const schedule = build([
    task('p1', 'A', 2),
    task('p1', 'B', 1, [dependency('A')])
  ]);

  const result = selectTaskSchedule(schedule, 'B');
  assert.equal(result.projectId, 'p1');
  assert.equal(result.earlyStart, '2026-06-03');
  assert.equal(result.earlyFinish, '2026-06-03');
  assert.equal(selectTaskSchedule(schedule, 'missing'), null);
});

test("kritik görev toplaması proje kapsamlı sonuçları birleştirir", () => {
  const schedule = build([
    task('p1', 'A', 1),
    task('p1', 'B', 2, [dependency('A')]),
    task('p2', 'X', 3)
  ]);

  assert.deepEqual(schedule.criticalTaskIds, ['A', 'B', 'X']);
  assert.deepEqual(schedule.projects.p1.criticalTaskIds, ['A', 'B']);
  assert.deepEqual(schedule.projects.p2.criticalTaskIds, ['X']);
});

test("hesaplanmış proje bitişi projeye özgü kalır", () => {
  const schedule = build([
    task('p1', 'A', 1),
    task('p1', 'B', 1, [dependency('A')]),
    task('p2', 'X', 5)
  ]);

  assert.equal(selectProjectSchedule(schedule, 'p1').projectFinish, '2026-06-02');
  assert.equal(selectProjectSchedule(schedule, 'p2').projectFinish, '2026-06-05');
});

test("projeler arası bağımlılık diğer projeleri etkilemeden belirlenimci reddedilir", () => {
  const schedule = build([
    task('p1', 'A', 2),
    task('p2', 'B', 1, [dependency('A')])
  ]);

  assert.equal(schedule.projects.p1.status, 'valid');
  assert.equal(schedule.projects.p2.status, 'invalid');
  assert.equal(schedule.projects.p2.error.code, 'CROSS_PROJECT_DEPENDENCY');
  assert.deepEqual(schedule.projects.p2.error.details.dependencies, [{
    taskId: 'B',
    predecessorId: 'A',
    predecessorProjectId: 'p1',
    type: 'FS',
    lagDays: 0
  }]);
  assert.equal(schedule.tasks.A.projectId, 'p1');
  assert.equal(schedule.tasks.B, undefined);
});

test("görevsiz proje güvenli boş çizelgeyle temsil edilir", () => {
  const schedule = build([task('p1', 'A', 1)]);

  assert.equal(schedule.projects.p3.status, 'empty');
  assert.equal(schedule.projects.p3.projectFinish, null);
  assert.deepEqual(schedule.projects.p3.tasks, {});
  assert.equal(schedule.projects.p3.error, null);
});
