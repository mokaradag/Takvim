import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTaskLifecycle } from '../src/domain/taskLifecycle.js';
import { businessDate } from '../src/domain/calendar/businessDate.js';
import { prepareTaskLifecycleIntent, withCompletionStamp } from '../src/state/appState.js';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';
import { prepareTaskCreationCommit, commitTaskEditorEdits } from '../src/state/taskEditorCommit.js';
import { resolveTaskMutationAccess } from '../src/state/projectWritePolicy.js';

const today = '2026-09-11';
const initial = { status: 'todo', progress: 40, actualStart: null, actualFinish: null };
const ongoing = { ...initial, status: 'in_progress', actualStart: '2026-09-07' };
const done = { ...ongoing, status: 'done', progress: 100, actualFinish: '2026-09-10' };
const cases = [
  ['başlat', initial, { status: 'in_progress' }, { ...initial, status: 'in_progress', actualStart: today }],
  ['mevcut başlangıcı koru', { ...initial, actualStart: '2026-09-07' }, { status: 'in_progress' }, ongoing],
  ['doğrudan tamamla', initial, { status: 'done' }, { ...done, actualStart: today, actualFinish: today }],
  ['devam eden işi tamamla', ongoing, { status: 'done' }, { ...done, actualFinish: today }],
  ['başlangıç gir', initial, { actualStart: '2026-09-07' }, ongoing],
  ['tamamlanmış başlangıcı düzelt', done, { actualStart: '2026-09-06' }, { ...done, actualStart: '2026-09-06' }],
  ['doğrudan geçmiş bitiş gir', initial, { actualFinish: '2026-09-03' }, { ...done, actualStart: '2026-09-03', actualFinish: '2026-09-03' }],
  ['devam eden işe bitiş gir', ongoing, { actualFinish: '2026-09-10' }, done],
  ['yüzde yüz kapatmaz', initial, { progress: 100 }, { ...initial, progress: 100 }],
  ['tamamlanma ilerlemesi korunur', done, { progress: 60 }, done],
  ['yeniden aç', done, { status: 'in_progress' }, { ...done, status: 'in_progress', actualFinish: null }],
  ['tam satırla yeniden aç', done, { ...done, status: 'in_progress' }, { ...done, status: 'in_progress', actualFinish: null }],
  ['mevcut bitişi koru', done, { status: 'done' }, done]
];

for (const [name, before, patch, expected] of cases) {
  test(`yaşam döngüsü: ${name}`, () => {
    const resolved = { ...before, ...normalizeTaskLifecycle(before, patch, today) };
    assert.deepEqual(resolved, expected);
    assert.deepEqual({ ...resolved, ...normalizeTaskLifecycle(resolved, {}, today) }, resolved);
  });
}

test('geçersiz gerçek tarih aralığı düzeltilmiş gibi gösterilmez', () => {
  assert.throws(() => normalizeTaskLifecycle(ongoing, { actualFinish: '2026-09-06' }, today), { code: 'TASK_ACTUAL_RANGE_INVALID' });
  assert.throws(() => normalizeTaskLifecycle({ ...ongoing, actualStart: '2026-09-12' }, { status: 'done' }, today), { code: 'TASK_ACTUAL_RANGE_INVALID' });
});

test('kilometre taşı tam satırda da tarih niyetini ve sıfırlama onayını korur', () => {
  const task = { ...initial, milestone: true, progress: 0 };
  const completed = { ...task, status: 'done', progress: 100, actualStart: today, actualFinish: today };
  assert.deepEqual(normalizeTaskLifecycle(task, { ...task, actualFinish: today }, today), completed);
  assert.throws(() => normalizeTaskLifecycle(completed, { ...completed, actualFinish: null }, today), { code: 'ACTUAL_DATE_RESET_CONFIRMATION_REQUIRED' });
  assert.deepEqual(normalizeTaskLifecycle(completed, { ...completed, actualFinish: null, resetActualDates: true }, today), { ...task, resetActualDates: true });
});

test('Yapılacak onayı reddedilince durum değişmez; kabul edilince tarihler ve ilerleme temizlenir', () => {
  const state = { tasks: [{ ...done, id: 'a' }] };
  let confirmations = 0;
  assert.equal(prepareTaskLifecycleIntent(state, 'a', { status: 'todo' }, () => { confirmations++; return false; }), null);
  assert.deepEqual(state.tasks[0], { ...done, id: 'a' });
  assert.equal(confirmations, 1);
  const result = prepareTaskLifecycleIntent(state, 'a', { status: 'todo' }, () => true);
  assert.deepEqual(result, { status: 'todo', actualStart: null, actualFinish: null, progress: 0, resetActualDates: true });
  assert.throws(() => normalizeTaskLifecycle(done, { status: 'todo', actualStart: null, actualFinish: null }, today), { code: 'ACTUAL_DATE_RESET_CONFIRMATION_REQUIRED' });
});

test('takvim günleri UTC ve tarayıcı diliminden bağımsızdır', () => {
  const now = new Date('2026-09-10T22:15:00Z');
  assert.equal(businessDate(now, 'Europe/Istanbul'), today);
  assert.equal(businessDate(now, 'America/New_York'), '2026-09-10');
  assert.equal(businessDate(now, 'invalid'), today);
  const state = { tasks: [{ ...initial, id: 'a', calendarId: 'c' }], calendars: [{ id: 'c', timezone: 'America/New_York' }] };
  assert.equal(withCompletionStamp(state, 'a', { status: 'done' }, now).actualFinish, '2026-09-10');
});

test('proje adıyla taşınan görevin tamamlanması hedef takvimin gününü kullanır', () => {
  const now = new Date('2026-09-10T22:15:00Z');
  const state = {
    tasks: [{ ...initial, id: 'a', projectId: 'old', proje: 'Eski' }],
    projects: [{ id: 'old', name: 'Eski', calendarId: 'west' }],
    assignableProjects: [{ id: 'new', name: 'Yeni', calendarId: 'east' }],
    calendars: [
      { id: 'west', timezone: 'America/New_York' },
      { id: 'east', timezone: 'Europe/Istanbul' }
    ]
  };
  const patch = { proje: 'Yeni', status: 'done' };
  const result = withCompletionStamp(state, 'a', patch, now);
  assert.equal(result.actualStart, '2026-09-11');
  assert.equal(result.actualFinish, '2026-09-11');
  assert.deepEqual(patch, { proje: 'Yeni', status: 'done' });
  assert.equal(state.tasks[0].projectId, 'old');
  assert.equal(withCompletionStamp(state, 'a', { ...patch, projectId: 'old' }, now).actualFinish, '2026-09-10');
  const taskCalendar = { ...state, tasks: [{ ...state.tasks[0], calendarId: 'west' }] };
  assert.equal(withCompletionStamp(taskCalendar, 'a', patch, now).actualFinish, '2026-09-10');
});

const projectId = '11111111-1111-4111-8111-888888888888';
const wbsId = '22222222-2222-4222-8222-888888888888';
const taskId = '33333333-3333-4333-8333-888888888888';
const newId = '44444444-4444-4444-8444-888888888888';
const owner = 950001, actor = 950002;
function seed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', TimeZone: 'Europe/Istanbul', IsDefault: 1, IsActive: 1, WorkingDays: [1, 2, 3, 4, 5] }],
    people: [owner, actor].map((Sicil) => ({ Sicil, DisplayName: `Kişi ${Sicil}`, Username: `u${Sicil}` })),
    projects: [{ ProjectId: projectId, SourceType: 'MANUAL', ProjectCode: 'SERİ', ProjectName: 'Tekrar', LeadSicil: owner, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1 }],
    wbs: [{ WbsId: wbsId, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: 'Kök' }],
    tasks: [{ TaskId: taskId, ProjectId: projectId, WbsId: wbsId, Title: 'Görev', Status: 'planned', Priority: 'medium', Progress: 40, PlannedStart: '2026-09-07', PlannedFinish: '2026-09-07', ...overrides }],
    taskAssignees: [{ TaskId: taskId, Sicil: actor }]
  };
}

test('SQL yaşam döngüsünü atomik kaydeder, sürüm ve reset onayını korur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T22:15:00Z') });
  const stack = await createActualStack(seed(), { sicil: actor, corporateWbsSource: false });
  try {
    const original = stack.state.tasks[0];
    await stack.repository.commitChanges({ taskUpserts: [{ ...original, actualFinish: '2026-09-08' }] });
    let stored = stack.db.tasks[0];
    assert.equal(stored.Status, 'done');
    assert.equal(stored.Progress, 100);
    assert.equal(stored.ActualStart, '2026-09-08');
    assert.equal(stored.ActualFinish, '2026-09-08');
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...original, status: 'in_progress' }] }), { code: 'CONFLICT' });
    await stack.reload();
    const completed = stack.state.tasks[0];
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...completed, status: 'todo', actualStart: null, actualFinish: null }] }), { code: 'ACTUAL_DATE_RESET_CONFIRMATION_REQUIRED' });
    assert.equal(stack.db.tasks[0].Status, 'done');
    const reset = await commitTaskEditorEdits(stack.persistence, () => stack.state, [{ id: taskId, version: completed.version, patch: { status: 'todo', resetActualDates: true } }]);
    assert.equal(reset.ok, true, reset.error?.message);
    stored = stack.db.tasks[0];
    assert.equal(stored.Status, 'planned');
    assert.equal(stored.ActualStart, null);
    assert.equal(stored.ActualFinish, null);
    assert.equal(stored.Progress, 0);
    assert.equal(Object.hasOwn(stack.state.tasks[0], 'resetActualDates'), false);
    await stack.repository.commitChanges({ taskUpserts: [{ ...stack.state.tasks[0], status: 'in_progress' }] });
    assert.equal(stack.db.tasks[0].ActualStart, today);
  } finally { await stack.dispose(); }
});

for (const [rule, expectedChildren] of [['FREQ=WEEKLY;COUNT=3', 2], ['FREQ=WEEKLY;BYDAY=TU;COUNT=3', 3]]) {
test(`normal kullanıcı kendi tekrarını oluşturur; yapı ve diğer sorumlular kapalı kalır: ${rule}`, async () => {
  const stack = await createActualStack(seed(), { sicil: actor, corporateWbsSource: false });
  try {
    const access = resolveTaskMutationAccess(stack.state, taskId, { recurrence: 'FREQ=WEEKLY;COUNT=3' });
    assert.equal(access.ok, true);
    assert.equal(access.canManageRecurrence, true);
    assert.equal(access.canManageStructure, false);
    assert.equal(access.canManageAssignees, false);
    const { result } = await executeTaskCreation({ state: stack.state, id: newId,
      input: { projectId, wbsId, task: 'Kendi tekrarım', plannedStart: '2026-09-07', plannedFinish: '2026-09-07', targetFinish: '2026-09-07', recurrence: rule },
      mutate: (operation, factory) => stack.persistence.mutate(operation, (state) => prepareTaskCreationCommit(state, factory(state), { generateSeries: true })) });
    assert.equal(result.ok, true, result.error?.message);
    const children = stack.state.tasks.filter((task) => task.recurrenceParentId === newId);
    assert.equal(children.length, expectedChildren);
    assert.ok(children.every((task) => task.assigneeIds.join() === String(actor)));
    const template = stack.state.tasks.find((task) => task.id === newId);
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...template, recurrence: 'FREQ=DAILY;COUNT=4' }] }),
      { code: 'MUTATION_FAILED', message: 'Yinelemeler üretildikten sonra tekrar kuralı veya seri planı değiştirilemez.' }
    );
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...template, assigneeIds: [String(owner)], assigneeMutation: true }] }), { code: 'FORBIDDEN' });
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...template, milestone: true, isMilestone: true, plannedDurationDays: 0 }] }), { code: 'FORBIDDEN' });
  } finally { await stack.dispose(); }
});
}

for (const milestone of [false, true]) {
  test(`atanmış görevin tekrarları yalnız mevcut yapısal değerleri devralır: kilometre taşı ${milestone}`, async () => {
    const stack = await createActualStack(seed({ PlannedHours: 8, Budget: 50, SortOrder: 10, IsMilestone: milestone, PlannedDurationDays: milestone ? 0 : 1 }), { sicil: actor, corporateWbsSource: false });
    try {
      const result = await commitTaskEditorEdits(stack.persistence, () => stack.state, [{ id: taskId, patch: { recurrence: 'FREQ=WEEKLY;COUNT=3' } }], { taskId, generateSeries: true });
      assert.equal(result.ok, true, result.error?.message);
      const children = stack.state.tasks.filter((task) => task.recurrenceParentId === taskId);
      assert.equal(children.length, 2);
      assert.ok(children.every((task) => task.plannedHours === 8 && task.budget === 50 && task.milestone === milestone));
      const forged = { ...children[0], id: newId, version: undefined, recurrenceOccurrenceDate: '2026-09-28' };
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...forged, assigneeIds: [String(owner)] }] }), { code: 'FORBIDDEN' });
      await assert.rejects(stack.repository.commitChanges({ taskUpserts: [forged] }), { code: 'MUTATION_FAILED' });
      assert.equal(stack.state.tasks.length, 3);
    } finally { await stack.dispose(); }
  });
}

test('gizli veya ikinci sorumlu kendi-tekrar hakkı vermez', async () => {
  const data = seed();
  data.taskAssignees.push({ TaskId: taskId, Sicil: owner });
  const stack = await createActualStack(data, { sicil: actor, corporateWbsSource: false });
  try {
    assert.equal(resolveTaskMutationAccess(stack.state, taskId).canManageRecurrence, false);
    await assert.rejects(stack.repository.commitChanges({ taskUpserts: [{ ...stack.state.tasks[0], recurrence: 'FREQ=WEEKLY;COUNT=3' }] }), { code: 'FORBIDDEN' });
  } finally { await stack.dispose(); }
});
