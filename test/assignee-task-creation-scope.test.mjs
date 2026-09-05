import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_CALENDAR_ID, createActualStack } from './helpers/actualStack.mjs';
import { canResolveTaskAssignee } from '../src/state/appState.js';
import {
  canAssignTasksInProject,
  canCreateTasksInProject,
  resolveTaskCreationAccess,
  resolveTaskMutationAccess,
  taskAssignableProjects,
  taskCreationScopeInProject
} from '../src/state/projectWritePolicy.js';

const PROJECT_P = '11111111-1111-4111-8111-111111111111';
const PROJECT_Q = '11111111-1111-4111-8111-222222222222';
const WBS_P = '22222222-2222-4222-8222-111111111111';
const WBS_P_CHILD = '22222222-2222-4222-8222-111111111112';
const WBS_Q = '22222222-2222-4222-8222-222222222222';
const TASK_A = '33333333-3333-4333-8333-111111111111';
const TASK_Q = '33333333-3333-4333-8333-222222222222';
const TASK_B = '44444444-4444-4444-8444-111111111111';
const TASK_C = '44444444-4444-4444-8444-222222222222';
const OWNER = 920001;
const ASSIGNEE = 920002;
const OUTSIDER = 920003;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function seed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [OWNER, ASSIGNEE, OUTSIDER].map((Sicil) => ({
      Sicil,
      DisplayName: `Kullanıcı ${Sicil}`,
      Username: `u${Sicil}`
    })),
    projects: [
      { ProjectId: PROJECT_P, SourceType: 'MANUAL', ProjectCode: 'P', ProjectName: 'Proje P', LeadSicil: OWNER, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1 },
      { ProjectId: PROJECT_Q, SourceType: 'MANUAL', ProjectCode: 'Q', ProjectName: 'Proje Q', LeadSicil: OWNER, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1 }
    ],
    projectAccess: [{ ProjectId: PROJECT_P, Sicil: OWNER, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [
      { WbsId: WBS_P, ProjectId: PROJECT_P, ParentWbsId: null, Code: 'P', Name: 'Proje P', SortOrder: 1 },
      { WbsId: WBS_P_CHILD, ProjectId: PROJECT_P, ParentWbsId: WBS_P, Code: 'P.1', Name: 'Mevcut iş paketi', SortOrder: 2 },
      { WbsId: WBS_Q, ProjectId: PROJECT_Q, ParentWbsId: null, Code: 'Q', Name: 'Proje Q', SortOrder: 1 }
    ],
    tasks: [
      { TaskId: TASK_A, ProjectId: PROJECT_P, WbsId: WBS_P, Title: 'Görev A', Status: 'todo', Priority: 'medium', PlannedStart: '2026-08-20', PlannedFinish: '2026-08-24', TargetFinish: '2026-08-24' },
      { TaskId: TASK_Q, ProjectId: PROJECT_Q, WbsId: WBS_Q, Title: 'Gizli görev', Status: 'todo', Priority: 'medium', TargetFinish: '2026-08-24' }
    ],
    taskAssignees: [
      { TaskId: TASK_A, Sicil: ASSIGNEE },
      { TaskId: TASK_Q, Sicil: OUTSIDER }
    ]
  };
}

function newTask(id = TASK_B, overrides = {}) {
  return {
    id,
    projectId: PROJECT_P,
    wbsId: WBS_P,
    calendarId: null,
    task: 'Görev B',
    keyword: 'Dar kapsam',
    status: 'todo',
    priority: 'medium',
    plannedStart: null,
    plannedFinish: null,
    plannedDurationDays: null,
    targetFinish: null,
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    plannedHours: null,
    actualHours: null,
    budget: null,
    spent: null,
    sortOrder: null,
    assigneeIds: [String(ASSIGNEE)],
    deps: [],
    ...overrides
  };
}

test('istemci tek merkezi modelle PARTIAL projede dar sorumlu oluşturma kapsamını açar', () => {
  const project = { id: PROJECT_P, accessLevel: 'PARTIAL', name: 'Proje P' };
  const state = {
    projects: [project],
    assignableProjects: [],
    tasks: [{ id: TASK_A, projectId: PROJECT_P, isCurrentUserAssignee: true }],
    session: { dataMode: 'actual' },
    currentUser: { id: String(ASSIGNEE), name: 'Sorumlu' },
    people: [{ id: String(ASSIGNEE), name: 'Sorumlu' }],
    workspaceMode: 'project',
    selectedProjectId: PROJECT_P
  };

  assert.deepEqual(taskAssignableProjects(state), [project]);
  assert.equal(taskCreationScopeInProject(state, PROJECT_P), 'ASSIGNEE_CREATE');
  assert.equal(canCreateTasksInProject(state, PROJECT_P), true);
  assert.equal(taskAssignableProjects(state).some((entry) => canResolveTaskAssignee(state, entry)), true);
  assert.equal(canAssignTasksInProject(state, PROJECT_P), false, 'dar oluşturma, atama yönetimi değildir');
  assert.deepEqual(resolveTaskCreationAccess(state), { ok: true, project, scope: 'ASSIGNEE_CREATE' });
  assert.equal(resolveTaskMutationAccess(state, TASK_A, { progress: 20 }).scope, 'ASSIGNEE');

  const removed = { ...state, tasks: [{ ...state.tasks[0], isCurrentUserAssignee: false }] };
  assert.equal(taskCreationScopeInProject(removed, PROJECT_P), null);
  assert.deepEqual(taskAssignableProjects(removed), []);
});

test('Temel ve Kapsamlı Kip aynı merkezi görev oluşturma uygunluk listesini kullanır', () => {
  const advanced = read('src/features/tasks/TasksView.jsx');
  const simpleTasks = read('src/features/tasks/SimpleTasksView.jsx');
  const quickEntry = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(advanced, /useTaskAssignableProjects\(\)/);
  assert.match(simpleTasks, /useTaskAssignableProjects\(\)/);
  assert.match(quickEntry, /useTaskAssignableProjects\(\)/);
  assert.match(quickEntry, /selectedCreationScope === 'ASSIGNEE_CREATE'/);
});

test('yetkili görev sorumlusu doğrudan sunucu isteğiyle aynı projede kendisine görev oluşturabilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    assert.deepEqual(stack.state.projects.map((project) => project.id), [PROJECT_P]);
    assert.deepEqual(stack.state.tasks.map((task) => task.id), [TASK_A]);
    assert.equal(stack.state.projects[0].accessLevel, 'PARTIAL');

    const committed = await stack.repository.commitChanges({
      taskUpserts: [newTask(TASK_B, {
        wbsId: WBS_P_CHILD,
        plannedStart: '2026-08-25',
        plannedFinish: '2026-08-28',
        targetFinish: '2026-08-28'
      })]
    });
    assert.equal(committed.taskUpserts[0].id, TASK_B);
    assert.equal(committed.taskUpserts[0].isCurrentUserAssignee, true);
    assert.equal(committed.taskUpserts[0].wbsId, WBS_P_CHILD);
    assert.equal(committed.taskUpserts[0].targetFinish, '2026-08-28');
    assert.equal(committed.taskUpserts[0].plannedDurationDays, 4);
    assert.equal(stack.db.tasks.find((task) => String(task.TaskId).toLowerCase() === TASK_B).PlannedDurationDays, 4);
    assert.deepEqual(
      stack.db.taskAssignees.filter((entry) => String(entry.TaskId).toLowerCase() === TASK_B).map((entry) => entry.Sicil),
      [ASSIGNEE]
    );
  } finally {
    await stack.dispose();
  }
});

test('dar kapsam başka proje, başka sorumlu ve yapısal yönetim için kullanılamaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [newTask(TASK_B, { projectId: PROJECT_Q, wbsId: WBS_Q })] }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [newTask(TASK_B, { assigneeIds: [String(OUTSIDER)] })] }),
      (error) => error.code === 'FORBIDDEN' && /yalnızca kendisini/.test(error.message)
    );
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [newTask(TASK_B, { recurrence: 'FREQ=WEEKLY' })] }),
      (error) => error.code === 'FORBIDDEN'
    );
    for (const [field, value] of [
      ['plannedDurationDays', 3],
      ['actualStart', '2026-08-25'],
      ['actualFinish', '2026-08-28'],
      ['remainingDurationDays', 2]
    ]) {
      const schedulingPatch = field === 'actualFinish'
        ? { actualStart: '2026-08-25', actualFinish: value }
        : { [field]: value };
      await assert.rejects(
        stack.repository.commitChanges({ taskUpserts: [newTask(TASK_B, schedulingPatch)] }),
        (error) => error.code === 'FORBIDDEN' && /saat veya finans/.test(error.message),
        `${field} dar oluşturma kapsamında reddedilmelidir`
      );
    }
    await assert.rejects(
      stack.repository.commitChanges({ projectUpserts: [{ ...stack.state.projects[0], name: 'Yetkisiz' }] }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      stack.repository.commitChanges({ wbsUpserts: [{ ...stack.state.wbs[0], name: 'Yetkisiz' }] }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      stack.repository.commitChanges({ projectDeletes: [{ id: PROJECT_P, version: stack.state.projects[0].version }] }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await stack.dispose();
  }
});

test('dar sorumlu oluşturması WBS bulunmayan projede boş WbsId ile güvenle tamamlanır', async () => {
  const withoutRoot = seed();
  withoutRoot.wbs = [];
  const stack = await createActualStack(withoutRoot, { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const committed = await stack.repository.commitChanges({ taskUpserts: [newTask(TASK_B, { wbsId: null })] });
    assert.equal(committed.taskUpserts[0].wbsId, null);
    assert.equal(stack.db.tasks.some((task) => String(task.TaskId).toLowerCase() === TASK_B), true);
  } finally {
    await stack.dispose();
  }
});

test('işlemden önce yetkili sorumluluk kaldırılırsa eski istemci isteği sunucuda reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const forgedFromStaleSnapshot = newTask(TASK_C);
    stack.db.taskAssignees = stack.db.taskAssignees
      .filter((entry) => !(String(entry.TaskId).toLowerCase() === TASK_A && entry.Sicil === ASSIGNEE));

    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [forgedFromStaleSnapshot] }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(stack.db.tasks.some((task) => String(task.TaskId).toLowerCase() === TASK_C), false);
  } finally {
    await stack.dispose();
  }
});
