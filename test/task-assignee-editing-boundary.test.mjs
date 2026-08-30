import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { resolveTaskMutationAccess, resolveWbsMutationAccess } from '../src/state/projectWritePolicy.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const WBS_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 910001;
const FIRST = 910002;
const SECOND = 910003;
const OUTSIDER = 910004;

function seed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [OWNER, FIRST, SECOND, OUTSIDER].map((Sicil) => ({ Sicil, DisplayName: `Kullanıcı ${Sicil}`, Username: `u${Sicil}` })),
    projects: [{
      ProjectId: PROJECT_ID, SourceType: 'MANUAL', ProjectCode: 'ELLE', ProjectName: 'Elle Proje',
      LeadSicil: OWNER, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [{ WbsId: WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Elle Proje', SortOrder: 1 }],
    tasks: [{
      TaskId: TASK_ID, ProjectId: PROJECT_ID, WbsId: WBS_ID, Title: 'Ortak görev', Status: 'todo',
      Priority: 'medium', PlannedStart: '2026-08-10', PlannedFinish: '2026-08-15', TargetFinish: '2026-08-15',
      PlannedDurationDays: 5, Progress: 0, PlannedHours: 12, ActualHours: 3, SortOrder: 1
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: FIRST }, { TaskId: TASK_ID, Sicil: SECOND }]
  };
}

async function updateVisibleTask(stack, patch) {
  const task = stack.state.tasks.find((entry) => entry.id === TASK_ID.toLowerCase());
  return stack.repository.commitChanges({ taskUpserts: [{ ...task, ...patch, assigneeMutation: false }] });
}

test('iki yetkili sorumludan her biri görev iş alanlarını düzenler ve gizli eş sorumlu korunur', async () => {
  const stack = await createActualStack(seed(), { sicil: FIRST, corporateWbsSource: false });
  try {
    let task = stack.state.tasks[0];
    assert.equal(task.isCurrentUserAssignee, true);
    assert.equal(task.assigneeCount, 2);
    assert.deepEqual(task.assigneeIds, [String(FIRST)]);

    const firstResult = await updateVisibleTask(stack, { task: 'Birinci düzenledi', status: 'in_progress', progress: 35 });
    assert.equal(firstResult.taskUpserts[0].task, 'Birinci düzenledi');
    assert.equal(firstResult.projectUpserts[0].accessLevel, 'PARTIAL');
    assert.deepEqual(stack.db.taskAssignees.map((entry) => entry.Sicil).sort(), [FIRST, SECOND]);
    assert.equal(stack.db.tasks[0].PlannedHours, 12, 'görünmeyen/pasif ürün alanları uyumlu kalır');

    process.env.MERGEN_ROTA_DEV_SICIL = String(SECOND);
    await stack.reload();
    task = stack.state.tasks[0];
    assert.equal(task.isCurrentUserAssignee, true);
    assert.deepEqual(task.assigneeIds, [String(SECOND)]);
    await assert.rejects(
      updateVisibleTask(stack, { targetFinish: '2026-08-18' }),
      (error) => error.code === 'FORBIDDEN' && /tarih değişikliği talebi/.test(error.message)
    );
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-08-15');
    const secondResult = await updateVisibleTask(stack, { progress: 70 });
    assert.equal(secondResult.taskUpserts[0].targetFinish, '2026-08-15');
    assert.deepEqual(stack.db.taskAssignees.map((entry) => entry.Sicil).sort(), [FIRST, SECOND]);
  } finally {
    await stack.dispose();
  }
});

test('manuel proje kodu kurumsal erişim koduyla çakışsa da görünür sorumlu kapsamı genişlemez', async () => {
  const collisionSeed = seed();
  collisionSeed.corporateProjectAccess = [{ ProjectCode: 'ELLE', Sicil: FIRST, RoleCode: 'PROJECT_MANAGER' }];
  const stack = await createActualStack(collisionSeed, { sicil: FIRST, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.equal(task.assigneeCount, 2);
    assert.deepEqual(task.assigneeIds, [String(FIRST)]);

    const result = await updateVisibleTask(stack, { progress: 25 });
    assert.equal(result.taskUpserts[0].progress, 25);
    assert.deepEqual(stack.db.taskAssignees.map((entry) => entry.Sicil).sort(), [FIRST, SECOND]);
  } finally {
    await stack.dispose();
  }
});

test('sorumlu kapsamı atama listesini, projeyi veya WBS yapısını yönetme hakkı vermez', async () => {
  const stack = await createActualStack(seed(), { sicil: FIRST, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    const access = resolveTaskMutationAccess(stack.state, task.id, { progress: 20 });
    assert.equal(access.ok, true);
    assert.equal(access.scope, 'ASSIGNEE');
    assert.equal(access.canManageStructure, false);
    assert.equal(access.canManageAssignees, false);
    assert.equal(access.canDelete, false);
    assert.equal(resolveTaskMutationAccess(stack.state, task.id, { plannedHours: 99 }).ok, false);
    assert.equal(resolveTaskMutationAccess(stack.state, task.id, { budget: 1 }).ok, false);
    assert.equal(resolveWbsMutationAccess(stack.state, WBS_ID).ok, false);

    const withoutHiddenProductFields = { ...task };
    for (const field of ['plannedHours', 'actualHours', 'budget', 'spent']) {
      delete withoutHiddenProductFields[field];
    }
    const ignoredProductFields = await stack.repository.commitChanges({
      taskUpserts: [{ ...withoutHiddenProductFields, progress: 20, assigneeMutation: false }]
    });
    assert.equal(ignoredProductFields.taskUpserts[0].progress, 20);
    assert.equal(stack.db.tasks[0].PlannedHours, 12);
    assert.equal(stack.db.tasks[0].Budget ?? null, null);
    const omittedSchedule = { ...ignoredProductFields.taskUpserts[0], task: 'Tarihler korunarak güncellendi' };
    for (const field of ['plannedStart', 'plannedFinish', 'plannedDurationDays', 'targetFinish']) {
      delete omittedSchedule[field];
    }
    const schedulePreserved = await stack.repository.commitChanges({
      taskUpserts: [{ ...omittedSchedule, assigneeMutation: false }]
    });
    assert.equal(schedulePreserved.taskUpserts[0].plannedStart, '2026-08-10');
    assert.equal(schedulePreserved.taskUpserts[0].plannedFinish, '2026-08-15');
    assert.equal(schedulePreserved.taskUpserts[0].plannedDurationDays, 5);
    assert.equal(schedulePreserved.taskUpserts[0].targetFinish, '2026-08-15');
    assert.equal(stack.db.tasks[0].PlannedStart, '2026-08-10');
    assert.equal(stack.db.tasks[0].PlannedFinish, '2026-08-15');
    assert.equal(stack.db.tasks[0].PlannedDurationDays, 5);
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-08-15');
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...task, plannedHours: 99, assigneeMutation: false }]
      }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(stack.db.tasks[0].PlannedHours, 12);
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...task, assigneeIds: [String(FIRST)], assigneeMutation: true }] }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      stack.repository.commitChanges({ wbsUpserts: [{ ...stack.state.wbs[0], name: 'Yetkisiz ad' }] }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      stack.repository.commitChanges({ projectUpserts: [{ ...stack.state.projects[0], name: 'Yetkisiz proje' }] }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await stack.dispose();
  }
});

test('assigneeMutation işareti olmadan gönderilen değiştirilmiş sorumlu projeksiyonu reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: FIRST, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...task, assigneeIds: [String(FIRST), String(OUTSIDER)] }]
      }),
      (error) => error.code === 'FORBIDDEN' && /görünür sorumlu listesini değiştiremez/.test(error.message)
    );
    assert.deepEqual(stack.db.taskAssignees.map((entry) => entry.Sicil).sort(), [FIRST, SECOND]);
  } finally {
    await stack.dispose();
  }
});

test('sorumlu olmayan ve başka yazma yetkisi bulunmayan kullanıcı görevi değiştiremez', async () => {
  const stack = await createActualStack(seed(), { sicil: FIRST, corporateWbsSource: false });
  try {
    const forged = { ...stack.state.tasks[0], task: 'Yetkisiz', assigneeMutation: false };
    process.env.MERGEN_ROTA_DEV_SICIL = String(OUTSIDER);
    await stack.reload();
    assert.equal(stack.state.tasks.length, 0);
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [forged] }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await stack.dispose();
  }
});
