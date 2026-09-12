import assert from 'node:assert/strict';
import test from 'node:test';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';
import { createRecurringTasks, taskCreationWithRecurrences } from '../src/state/recurringTaskCreation.js';
import { withCompletionStamp } from '../src/state/appState.js';
import { milestoneCompletion } from '../src/domain/milestoneCompletion.js';

const projectId = '11111111-1111-4111-8111-888888888888';
const wbsId = '22222222-2222-4222-8222-888888888888';
const taskId = '33333333-3333-4333-8333-888888888888';
const owner = 950001;
const assignee = 950002;
function seed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1, WorkingDays: [1, 2, 3, 4, 5] }],
    people: [owner, assignee].map((Sicil) => ({ Sicil, DisplayName: `Kişi ${Sicil}`, Username: `u${Sicil}` })),
    projects: [{ ProjectId: projectId, SourceType: 'MANUAL', ProjectCode: 'SERİ', ProjectName: 'Tekrar', LeadSicil: owner, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1 }],
    wbs: [{ WbsId: wbsId, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 1 }]
  };
}
function input() {
  return { projectId, wbsId, task: 'Haftalık toplantı', assigneeIds: [String(assignee)], sorumlu: [`Kişi ${assignee}`],
    plannedStart: '2026-09-07', plannedFinish: '2026-09-07', targetFinish: '2026-09-07',
    recurrence: 'FREQ=WEEKLY;COUNT=3', status: 'todo', priority: 'medium' };
}

test('yeni şablon ve tekrarlar tek kalıcı istekle oluşur; yeniden üretim kopya oluşturmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: owner, corporateWbsSource: false });
  try {
    const { result, created } = await executeTaskCreation({ state: stack.state, input: input(), id: taskId,
      mutate: (operation, factory) => stack.persistence.mutate(operation, (state) => taskCreationWithRecurrences(state, factory(state))) });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(created.id, taskId);
    assert.equal(stack.requests.filter((request) => request.path.endsWith('/commit')).length, 1);
    assert.equal(stack.db.tasks.length, 3);
    assert.ok(stack.db.tasks.every((task) => task.PlannedDurationDays === 1));
    assert.deepEqual(stack.state.tasks.map((task) => task.plannedStart).sort(), ['2026-09-07', '2026-09-14', '2026-09-21']);
    const children = stack.state.tasks.filter((task) => task.recurrenceParentId === taskId);
    assert.equal(children.length, 2);
    assert.ok(children.every((task) => !task.recurrence && task.progress === 0 && !task.actualFinish && !task.deps.length));
    assert.deepEqual(createRecurringTasks(stack.state, created), []);
  } finally { await stack.dispose(); }
});

test('geçersiz yeni seri kalıcı yazılmaz ve yeniden denenecek taslak korunur', async () => {
  const stack = await createActualStack(seed(), { sicil: owner, corporateWbsSource: false });
  try {
    const draft = { ...input(), task: '' };
    const { result, created } = await executeTaskCreation({ state: stack.state, input: draft, id: taskId,
      mutate: (operation, factory) => stack.persistence.mutate(operation, (state) => taskCreationWithRecurrences(state, factory(state))) });
    assert.equal(result.ok, false);
    assert.equal(created, null);
    assert.equal(stack.db.tasks.length, 0);
    assert.equal(draft.recurrence, 'FREQ=WEEKLY;COUNT=3');
  } finally { await stack.dispose(); }
});

test('kilometre taşının tamamlanması, tarih düzeltmesi ve yeniden açılması tek gerçekleşen tarihi korur', () => {
  const task = { id: taskId, milestone: true, status: 'todo', progress: 30, actualStart: '2026-09-01' };
  const done = withCompletionStamp({ tasks: [task] }, taskId, { status: 'done' }, new Date('2026-09-07T12:00:00Z'));
  assert.deepEqual(done, { status: 'done', progress: 100, actualStart: '2026-09-07', actualFinish: '2026-09-07' });
  const titlePatch = { task: 'Yeni başlık' };
  assert.equal(withCompletionStamp({ tasks: [task] }, taskId, titlePatch), titlePatch);
  const complete = { ...task, ...done };
  assert.deepEqual(milestoneCompletion(complete, { actualFinish: '2026-09-08' }), { ...done, actualStart: '2026-09-08', actualFinish: '2026-09-08' });
  for (const patch of [{ status: 'todo' }, { status: 'in_progress' }, { actualFinish: null }]) {
    assert.deepEqual(milestoneCompletion(complete, patch), { status: 'todo', progress: 0, actualStart: null, actualFinish: null });
  }
  assert.equal(milestoneCompletion({ milestone: false, status: 'in_progress', progress: 30 }), null);

  const inProgress = { id: taskId, milestone: false, isMilestone: false, status: 'in_progress', progress: 30, actualStart: '2026-09-01' };
  assert.deepEqual(
    withCompletionStamp({ tasks: [inProgress] }, taskId, { milestone: true, isMilestone: true }, new Date('2026-09-07T12:00:00Z')),
    { milestone: true, isMilestone: true, status: 'todo', progress: 0, actualStart: null, actualFinish: null }
  );
});

test('SQL deposu kilometre taşında farklı gerçekleşen tarihleri ve kesirli ilerlemeyi normalleştirir', async () => {
  const stack = await createActualStack(seed(), { sicil: owner, corporateWbsSource: false });
  try {
    const { result } = await executeTaskCreation({ state: stack.state, input: { ...input(), recurrence: null, milestone: true, isMilestone: true,
      status: 'done', plannedDurationDays: 0, progress: 45, actualStart: '2026-09-01', actualFinish: '2026-09-07' }, id: taskId,
      mutate: (operation, factory) => stack.persistence.mutate(operation, factory) });
    assert.equal(result.ok, true, result.error?.message);
    const stored = stack.db.tasks[0];
    assert.equal(stored.ActualStart, stored.ActualFinish);
    assert.equal(stored.Progress, 100);
    assert.equal(stored.PlannedDurationDays, 0);
    const task = stack.state.tasks.find((item) => item.id === taskId);
    await stack.repository.commitChanges({ taskUpserts: [{ ...task, status: 'in_progress', progress: 50, resetActualDates: true, assigneeMutation: false }] });
    assert.equal(stack.db.tasks[0].Status, 'planned');
    assert.equal(stack.db.tasks[0].Progress, 0);
    assert.equal(stack.db.tasks[0].ActualStart, null);
    assert.equal(stack.db.tasks[0].ActualFinish, null);
  } finally { await stack.dispose(); }
});
