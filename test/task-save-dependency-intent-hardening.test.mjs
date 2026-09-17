import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const PROJECT_ID = '91111111-1111-4111-8111-111111111111';
const TASK_ID = '92222222-2222-4222-8222-222222222222';
const PREDECESSOR_ID = '93333333-3333-4333-8333-333333333333';
const SICIL = 910001;

function seed() {
  return {
    calendars: [{
      CalendarId: DEFAULT_CALENDAR_ID,
      Name: 'Kurumsal Takvim',
      IsDefault: 1,
      IsActive: 1,
      WorkingDays: [1, 2, 3, 4, 5]
    }],
    people: [{ Sicil: SICIL, DisplayName: 'Proje Yetkilisi', Username: 'u910001' }],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'DEP',
      ProjectName: 'Bağımlılık Projesi',
      LeadSicil: SICIL,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: SICIL, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    tasks: [
      {
        TaskId: TASK_ID,
        ProjectId: PROJECT_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Ardıl',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      },
      {
        TaskId: PREDECESSOR_ID,
        ProjectId: PROJECT_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Öncül',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: SICIL
      }
    ],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: SICIL },
      { TaskId: PREDECESSOR_ID, Sicil: SICIL }
    ],
    taskDependencies: [{
      ProjectId: PROJECT_ID,
      TaskId: TASK_ID,
      PredecessorTaskId: PREDECESSOR_ID,
      DependencyType: 'FS',
      LagDays: 0
    }]
  };
}

test('istemci dependencyMutation=false gönderse de gerçek bağımlılık değişikliği döngü doğrulamasını atlayamaz', async () => {
  const stack = await createActualStack(seed(), { sicil: SICIL, corporateWbsSource: false });
  try {
    const predecessor = stack.state.tasks.find((task) => task.id === PREDECESSOR_ID);
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          ...predecessor,
          deps: [{ predecessorId: TASK_ID, type: 'FS', lagDays: 0 }],
          assigneeMutation: false,
          dependencyMutation: false
        }]
      }),
      (error) => error.code === 'MUTATION_FAILED' && /döngü/.test(error.message)
    );

    assert.equal(stack.db.taskDependencies.length, 1);
    assert.equal(String(stack.db.taskDependencies[0].TaskId).toLowerCase(), TASK_ID);
    assert.equal(String(stack.db.taskDependencies[0].PredecessorTaskId).toLowerCase(), PREDECESSOR_ID);
  } finally {
    await stack.dispose();
  }
});
