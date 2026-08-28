import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canDeleteTask,
  canWriteProject,
  projectWriteFailure,
  resolveTaskCreationProject,
  resolveTaskMutationAccess,
  resolveTaskWbsMoveAccess,
  resolveWbsMutationAccess,
  writableProjects
} from '../src/state/projectWritePolicy.js';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';

const projects = [
  { id: 'partial', name: 'Partial', accessLevel: 'PARTIAL' },
  { id: 'full', name: 'Full', accessLevel: 'FULL' },
  { id: 'read', name: 'Read', accessLevel: 'READ' },
  { id: 'demo', name: 'Demo' }
];
const state = {
  projects,
  tasks: [
    { id: 'task-full', projectId: 'full' },
    { id: 'task-partial', projectId: 'partial' }
  ],
  wbs: [
    { id: 'wbs-full', projectId: 'full' },
    { id: 'wbs-full-2', projectId: 'full' },
    { id: 'wbs-partial', projectId: 'partial' }
  ]
};

test('portfolio task creation skips read-only projects and selects the first writable project', () => {
  assert.equal(resolveTaskCreationProject({ ...state, workspaceMode: 'portfolio' })?.id, 'full');
  assert.equal(resolveTaskCreationProject({ ...state, workspaceMode: 'project', selectedProjectId: 'partial' }), null);
  assert.equal(resolveTaskCreationProject({ ...state, workspaceMode: 'project', selectedProjectId: 'full' })?.id, 'full');
  assert.equal(resolveTaskCreationProject(state, 'read'), null);
  assert.equal(resolveTaskCreationProject(state, 'demo')?.id, 'demo');
});

test('write capability treats demo projects as writable but rejects PARTIAL and READ', () => {
  assert.equal(canWriteProject(projects[0]), false);
  assert.equal(canWriteProject(projects[1]), true);
  assert.equal(canWriteProject(projects[2]), false);
  assert.equal(canWriteProject(projects[3]), true);
  assert.deepEqual(writableProjects(projects).map((project) => project.id), ['full', 'demo']);
});

test('task mutations require writable source and destination projects', () => {
  assert.equal(resolveTaskMutationAccess(state, 'task-full', {}).ok, true);
  assert.equal(resolveTaskMutationAccess(state, 'task-partial', {}).code, 'PROJECT_WRITE_FORBIDDEN');
  assert.equal(resolveTaskMutationAccess(state, 'task-full', { projectId: 'partial' }).code, 'PROJECT_WRITE_FORBIDDEN');
  assert.equal(resolveTaskMutationAccess(state, 'task-full', { projectId: 'full' }).ok, true);
  assert.equal(resolveTaskMutationAccess(state, 'missing', {}).code, 'TASK_NOT_FOUND');
  assert.equal(canDeleteTask(state, 'task-full'), true);
  assert.equal(canDeleteTask(state, 'task-partial'), false);
});

test('WBS mutations and task moves require the same writable project', () => {
  assert.equal(resolveWbsMutationAccess(state, 'wbs-full').ok, true);
  assert.equal(resolveWbsMutationAccess(state, 'wbs-partial').code, 'PROJECT_WRITE_FORBIDDEN');
  assert.equal(resolveWbsMutationAccess(state, 'wbs-full', 'wbs-full-2').ok, true);
  assert.equal(resolveWbsMutationAccess(state, 'wbs-full', 'wbs-partial').code, 'PROJECT_WRITE_FORBIDDEN');
  assert.equal(resolveTaskWbsMoveAccess(state, ['task-full'], 'wbs-full').ok, true);
  assert.equal(resolveTaskWbsMoveAccess(state, ['task-partial'], 'wbs-full').code, 'PROJECT_WRITE_FORBIDDEN');
});

test('forbidden writes return a stable domain error without entering persistence', () => {
  const failure = projectWriteFailure('task/update', {
    code: 'PROJECT_WRITE_FORBIDDEN',
    projectId: 'partial',
    message: 'Salt okunur.'
  });
  assert.deepEqual(failure, {
    ok: false,
    error: {
      kind: 'domain',
      code: 'PROJECT_WRITE_FORBIDDEN',
      field: 'projectId',
      message: 'Salt okunur.',
      operation: 'task/update',
      details: { projectId: 'partial' }
    }
  });
});

test('Advanced Mode views use the shared capability boundary', () => {
  const tasksView = fs.readFileSync(new URL('../src/features/tasks/TasksView.jsx', import.meta.url), 'utf8');
  const detailOverlay = fs.readFileSync(new URL('../src/features/task-detail/TaskDetailOverlay.jsx', import.meta.url), 'utf8');
  const wbsView = fs.readFileSync(new URL('../src/features/wbs/WbsView.jsx', import.meta.url), 'utf8');

  assert.match(tasksView, /disabled=\{!canAddTask\}/);
  assert.match(tasksView, /canDeleteTask\(taskMutationState, t\.id\)/);
  assert.match(detailOverlay, /ReadOnlyTaskDrawer/);
  assert.match(wbsView, /canEdit\s*&&/);
});

test('Advanced Mode task creation applies the restricted payload before persistence', async () => {
  const currentUser = { id: '1001', name: 'Görevli Kullanıcı' };
  const project = { id: 'partial', code: 'P-1', name: 'Kısıtlı proje', accessLevel: 'PARTIAL' };
  const restrictedState = {
    projects: [project],
    assignableProjects: [],
    tasks: [{ id: 'assigned', projectId: project.id, isCurrentUserAssignee: true }],
    wbs: [{ id: 'root', projectId: project.id, parentId: null, code: '1', name: 'Kök' }],
    people: [currentUser, { id: '2002', name: 'Başka Kullanıcı' }],
    calendars: [],
    currentUser,
    workspaceMode: 'portfolio'
  };
  const calls = [];
  const createdTask = { id: 'task-created' };
  const mutation = await executeTaskCreation({
    state: restrictedState,
    id: createdTask.id,
    input: {
      projectId: project.id,
      task: 'Yeni görev',
      wbsId: 'forged-wbs',
      assigneeIds: ['2002'],
      recurrence: 'FREQ=WEEKLY',
      plannedStart: '2026-08-28',
      targetFinish: '2026-08-30'
    },
    async mutate(operation, actionFactory) {
      const action = actionFactory();
      calls.push({ operation, action });
      return { ok: true, value: { taskUpserts: [action.task] } };
    }
  });

  assert.equal(mutation.result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'task/create');
  assert.equal(calls[0].action.task.projectId, project.id);
  assert.equal(calls[0].action.task.wbsId, 'root');
  assert.deepEqual(calls[0].action.task.assigneeIds, ['1001']);
  assert.deepEqual(calls[0].action.task.sorumlu, ['Görevli Kullanıcı']);
  assert.equal(calls[0].action.task.recurrence, null);
  assert.equal(calls[0].action.task.plannedStart, null);
  assert.equal(calls[0].action.task.targetFinish, null);

  let unauthorizedMutationCalls = 0;
  const unauthorized = await executeTaskCreation({
    state: restrictedState,
    id: 'task-forged',
    input: { projectId: 'read', task: 'Yetkisiz görev' },
    async mutate() {
      unauthorizedMutationCalls += 1;
      return { ok: true };
    }
  });
  assert.equal(unauthorized.result.ok, false);
  assert.equal(unauthorized.result.error.code, 'PROJECT_WRITE_FORBIDDEN');
  assert.equal(unauthorizedMutationCalls, 0);
});
