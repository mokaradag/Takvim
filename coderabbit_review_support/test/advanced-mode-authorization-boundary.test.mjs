import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canWriteProject,
  projectWriteFailure,
  resolveTaskCreationProject,
  resolveTaskMutationAccess,
  resolveTaskWbsMoveAccess,
  resolveWbsMutationAccess,
  writableProjects
} from '../src/state/projectWritePolicy.js';

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
  const provider = fs.readFileSync(new URL('../src/state/AppStateProvider.jsx', import.meta.url), 'utf8');
  const tasksView = fs.readFileSync(new URL('../src/features/tasks/TasksView.jsx', import.meta.url), 'utf8');
  const detailOverlay = fs.readFileSync(new URL('../src/features/task-detail/TaskDetailOverlay.jsx', import.meta.url), 'utf8');
  const wbsView = fs.readFileSync(new URL('../src/features/wbs/WbsView.jsx', import.meta.url), 'utf8');

  assert.match(provider, /resolveTaskCreationProject/);
  assert.match(provider, /resolveTaskMutationAccess/);
  assert.match(provider, /resolveTaskWbsMoveAccess/);
  assert.match(provider, /resolveWbsMutationAccess/);
  assert.match(tasksView, /disabled=\{!canAddTask\}/);
  assert.match(tasksView, /canWriteProject\(projectById\.get\(t\.projectId\)\)/);
  assert.match(detailOverlay, /ReadOnlyTaskDrawer/);
  assert.match(wbsView, /canEdit\s*&&/);
});
