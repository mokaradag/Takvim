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

test("başlangıç koleksiyon kimlikleri her kanonik koleksiyonda tekildir", () => {
  expectUnique(CALENDARS.map((item) => item.id), 'calendar ids');
  expectUnique(PROJECTS.map((item) => item.id), 'project ids');
  expectUnique(PEOPLE.map((item) => item.id), 'people ids');
  expectUnique(WBS.map((item) => item.id), 'WBS ids');
  expectUnique(TASKS.map((item) => item.id), 'task ids');
  expectUnique(BASELINES.map((item) => item.id), 'baseline ids');
});

test("başlangıç proje ve kişi görünüm adları tekildir", () => {
  expectUnique(PROJECTS.map((item) => item.name), 'project names');
  expectUnique(PEOPLE.map((item) => item.name), 'people names');
});

test("her başlangıç projesi mevcut takvime başvurur", () => {
  for (const project of PROJECTS) {
    assert.equal(calendarsById.has(project.calendarId), true, project.id);
  }
});

test("her başlangıç projesi liderini mevcut kişiye çözer", () => {
  for (const project of PROJECTS) {
    assert.equal(peopleById.has(project.leadId), true, project.id);
  }
});

test("her başlangıç projesinin geçerli ISO veri tarihi vardır", () => {
  for (const project of PROJECTS) {
    assert.equal(isIsoDate(project.dataDate), true, project.id);
  }
});

test("takvim iş günü tanımı yalnızca tekil gün numarası içerir", () => {
  for (const calendar of CALENDARS) {
    assert.equal(calendar.workingDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6), true, calendar.id);
    expectUnique(calendar.workingDays, `${calendar.id} working days`);
  }
});

test("takvim tatil tarihleri takvim içinde tekildir", () => {
  for (const calendar of CALENDARS) {
    const dates = calendar.holidays.map((holiday) => holiday.date);
    assert.equal(dates.every(isIsoDate), true, calendar.id);
    expectUnique(dates, `${calendar.id} holiday dates`);
  }
});

test("başlangıç WBS yapısında yapısal doğrulama sorunu yoktur", () => {
  assert.deepEqual(validateWbsStructure(WBS), []);
});

test("her WBS düğümü mevcut projeye aittir", () => {
  for (const node of WBS) {
    assert.equal(projectsById.has(node.projectId), true, node.id);
  }
});

test("her projenin tam bir doğal varsayılan WBS kökü vardır", () => {
  for (const project of PROJECTS) {
    const root = selectDefaultProjectWbs(WBS, project.id);
    assert.ok(root, project.id);
    assert.equal(root.projectId, project.id);
    assert.equal(root.parentId, null);
  }
});

test("WBS kodları proje içinde tekildir", () => {
  for (const project of PROJECTS) {
    const codes = WBS.filter((node) => node.projectId === project.id).map((node) => node.code);
    expectUnique(codes, `${project.id} WBS codes`);
  }
});

test("kök olmayan her WBS düğümünün üstleri aynı projededir", () => {
  for (const node of WBS) {
    for (const ancestor of selectWbsAncestors(WBS, node.id)) {
      assert.equal(ancestor.projectId, node.projectId, `${node.id} -> ${ancestor.id}`);
    }
  }
});

test("her başlangıç görevi mevcut proje ve WBS düğümüne aittir", () => {
  for (const task of TASKS) {
    assert.equal(projectsById.has(task.projectId), true, task.id);
    assert.equal(wbsById.has(task.wbsId), true, task.id);
    assert.equal(wbsById.get(task.wbsId).projectId, task.projectId, task.id);
  }
});

test("her başlangıç sorumlu kimliği eşleşen kanonik ada çözülür", () => {
  for (const task of TASKS) {
    assert.equal(task.assigneeIds.every((id) => peopleById.has(id)), true, task.id);
    assert.deepEqual(task.assigneeIds.map((id) => peopleById.get(id).name), task.sorumlu, task.id);
  }
});

test("her başlangıç görevi kullanılabilir çizelgeleme takvimine çözülür", () => {
  for (const task of TASKS) {
    const calendar = resolveTaskCalendar(task, PROJECTS, CALENDARS);
    assert.ok(calendar, task.id);
    assert.equal(calendarsById.has(calendar.id), true, task.id);
  }
});

test("her başlangıç görevi kanonik çizelge doğrulamasını geçer", () => {
  for (const task of TASKS) {
    assert.deepEqual(validateTaskSchedule(task), [], task.id);
  }
});

test("başlangıç kilometre taşı sıfır süre ve tek plan tarihi kullanır", () => {
  for (const task of TASKS.filter((item) => item.milestone)) {
    assert.equal(task.plannedDurationDays, 0, task.id);
    assert.equal(task.plannedStart, task.plannedFinish, task.id);
  }
});

test("normal başlangıç görevi sonlu ve negatif olmayan plan süresi taşır", () => {
  for (const task of TASKS.filter((item) => !item.milestone)) {
    assert.equal(Number.isFinite(task.plannedDurationDays), true, task.id);
    assert.equal(task.plannedDurationDays >= 0, true, task.id);
  }
});

test("başlangıç bağımlılık kayıtları normaldir ve mevcut göreve başvurur", () => {
  for (const task of TASKS) {
    for (const dependency of task.deps || []) {
      assert.equal(dependency.id, dependency.predecessorId, task.id);
      assert.equal(tasksById.has(dependency.predecessorId), true, `${task.id} -> ${dependency.predecessorId}`);
      assert.equal(Object.hasOwn(REL_TYPES, dependency.type), true, `${task.id} ${dependency.type}`);
      assert.equal(Number.isFinite(dependency.lagDays), true, task.id);
    }
  }
});

test("her projenin tam bir birincil baz planı vardır", () => {
  for (const project of PROJECTS) {
    const baselines = BASELINES.filter((baseline) => baseline.projectId === project.id && baseline.isPrimary);
    assert.equal(baselines.length, 1, project.id);
  }
});

test("her baz plan mevcut projeye aittir ve geçerli oluşturma tarihi taşır", () => {
  for (const baseline of BASELINES) {
    assert.equal(projectsById.has(baseline.projectId), true, baseline.id);
    assert.equal(isIsoDate(baseline.createdAt), true, baseline.id);
  }
});

test("her baz plan görüntüsü tarihsel çizelge doğrulamasını geçer", () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    assert.deepEqual(validateTaskBaselineSnapshot(snapshot), [], snapshot.taskId);
  }
});

test("her görevin proje birincil baz planı için tam bir görüntüsü vardır", () => {
  for (const task of TASKS) {
    const primary = BASELINES.find((baseline) => baseline.projectId === task.projectId && baseline.isPrimary);
    const snapshots = TASK_BASELINE_SNAPSHOTS.filter((snapshot) => (
      snapshot.taskId === task.id && snapshot.baselineId === primary.id
    ));
    assert.equal(snapshots.length, 1, task.id);
  }
});

test("baz plan görüntüsü aynı projedeki mevcut görev ve baz plana başvurur", () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    const task = tasksById.get(snapshot.taskId);
    const baseline = baselinesById.get(snapshot.baselineId);
    assert.ok(task, snapshot.taskId);
    assert.ok(baseline, snapshot.baselineId);
    assert.equal(task.projectId, baseline.projectId, snapshot.taskId);
    assert.equal(calendarsById.has(snapshot.calendarId), true, snapshot.taskId);
  }
});

test("ilk baz plan görüntüsü normalleştirilmiş görev planını korur", () => {
  for (const snapshot of TASK_BASELINE_SNAPSHOTS) {
    const task = tasksById.get(snapshot.taskId);
    assert.equal(snapshot.plannedStart, task.plannedStart, task.id);
    assert.equal(snapshot.plannedFinish, task.plannedFinish, task.id);
    assert.equal(snapshot.plannedDurationDays, task.plannedDurationDays, task.id);
  }
});

test("bir proje geçersizken de portföy çizelgesi her başlangıç projesini temsil eder", () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  assert.deepEqual(Object.keys(schedule.projects).sort(), PROJECTS.map((project) => project.id).sort());
});

test("başlangıçtaki projeler arası bağımlılık açık proje uyarısı olur", () => {
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

test("geçerli başlangıç projesinin görevleri türetilmiş çizelge alır", () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  for (const task of TASKS) {
    const projectSchedule = schedule.projects[task.projectId];
    if (projectSchedule.status === 'valid') assert.ok(schedule.tasks[task.id], task.id);
    else assert.equal(schedule.tasks[task.id], undefined, task.id);
  }
});

test("portföy kritik görev toplamı görev kimliğini çoğaltmaz", () => {
  const schedule = buildPortfolioSchedule({ tasks: TASKS, projects: PROJECTS, calendars: CALENDARS });
  expectUnique(schedule.criticalTaskIds, 'critical task ids');
});
