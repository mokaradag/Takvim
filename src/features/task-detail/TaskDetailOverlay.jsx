'use client';
import { useEffect, useRef, useState } from 'react';
import {
  useAllPeople, useAllProjects, useAllTasks, useTaskAssignmentScope, useCurrentUser,
  useScheduleRequests, useSelectedTask, useTaskCreationDraft, useTaskActions
} from '../../state/hooks';
import { projectWriteFailure, resolveTaskMutationAccess } from '../../state/projectWritePolicy.js';
import { taskEditorPatch } from '../../state/taskEditorCommit.js';
import { ReadOnlyTaskDrawer } from './ReadOnlyTaskDrawer';
import { SimpleTaskDrawer } from './SimpleTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import { normalizeTaskAssigneePatch } from './taskAssigneePatch.js';

function TaskEditor({ task, simple, creationDraft, tasks, projects, assignableProjects, people, currentUser, scheduleRequests }) {
  const { closeTask, saveTaskEdits, deleteTask, submitScheduleChange, updateTaskDraft, cancelTaskDraft, saveTaskDraft } = useTaskActions();
  const [displayTask, setDisplayTask] = useState(task);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const pendingRef = useRef(new Map());
  const saveRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const isCreating = creationDraft?.task?.id === task.id;
  const writeState = { projects, tasks, assignableProjects, currentUser };
  const initialAccess = resolveTaskMutationAccess(writeState, task.id, {});

  useEffect(() => {
    setDisplayTask({ ...task, ...pendingRef.current.get(task.id)?.patch });
  }, [task]);

  const onUpdate = (taskId, patch) => {
    if (saveRef.current) return Promise.resolve({ ok: false, error: { message: 'Kayıt işlemi sürüyor.' } });
    if (taskId === task.id && patch.projectId && patch.projectId !== (isCreating ? task : displayTask).projectId) {
      for (const id of pendingRef.current.keys()) if (id !== task.id) pendingRef.current.delete(id);
    }
    if (isCreating && taskId === task.id) return updateTaskDraft(taskId, patch);
    const normalized = normalizeTaskAssigneePatch(patch, people);
    const access = normalized.ok ? resolveTaskMutationAccess(writeState, taskId, normalized.patch) : normalized.error;
    if (!normalized.ok || !access.ok) {
      setSaveError(access.message);
      return Promise.resolve(projectWriteFailure('task/update', access));
    }
    const original = tasks.find((item) => item.id === taskId);
    const previous = pendingRef.current.get(taskId);
    const entry = { id: taskId, version: previous?.version || original?.version, patch: { ...previous?.patch, ...patch, ...normalized.patch } };
    pendingRef.current.set(taskId, entry);
    if (taskId === task.id) setDisplayTask((current) => ({ ...current, ...entry.patch }));
    setSaveError(null);
    return Promise.resolve({ ok: true, value: entry, staged: true });
  };

  const onSave = (input, options = {}) => {
    if (saveRef.current) return saveRef.current;
    setSaving(true);
    setSaveError(null);
    const pending = (async () => {
      let result;
      if (isCreating) {
        result = await saveTaskDraft(input, { ...options, syncKeywordCatalog: simple, relatedEdits: [...pendingRef.current.values()] });
      } else {
        const previous = pendingRef.current.get(task.id);
        const edits = new Map(pendingRef.current);
        edits.set(task.id, { id: task.id, version: previous?.version || task.version, patch: taskEditorPatch(task, input) });
        result = await saveTaskEdits([...edits.values()], { ...options, taskId: task.id, syncKeywordCatalog: simple });
      }
      if (result?.ok) {
        pendingRef.current.clear();
        if (mountedRef.current) await closeTask();
      } else {
        setSaveError(result?.error?.message || 'Görev kaydedilemedi.');
      }
      return result;
    })().catch((error) => {
      setSaveError(error.message || 'Görev kaydedilemedi.');
      return { ok: false, error };
    }).finally(() => { saveRef.current = null; setSaving(false); });
    saveRef.current = pending;
    return pending;
  };

  if (!isCreating && !initialAccess.ok) return <ReadOnlyTaskDrawer task={task} onClose={closeTask} />;
  const canManageDraft = creationDraft?.scope === 'FULL' || creationDraft?.scope === 'ASSIGNMENT';
  const common = {
    task: isCreating ? task : displayTask,
    onClose: () => {
      if (saveRef.current) return;
      pendingRef.current.clear();
      return isCreating ? cancelTaskDraft() : closeTask();
    },
    onUpdate,
    onSave,
    onDelete: deleteTask,
    isCreating,
    isSaving: saving,
    saveError,
    creatorFallback: isCreating ? { ...currentUser, createdAt: creationDraft.createdAt } : null,
    canManageAssignees: isCreating ? canManageDraft : initialAccess.canManageAssignees,
    canControlSchedule: isCreating || initialAccess.canControlSchedule,
    canEditTargetFinish: isCreating || initialAccess.canEditTargetFinish,
    canProposeSchedule: !isCreating && initialAccess.canProposeSchedule,
    canDelete: !isCreating && initialAccess.canDelete,
    scheduleRequests: scheduleRequests.filter((request) => String(request.taskId) === String(task.id)),
    onProposeSchedule: submitScheduleChange
  };
  return simple ? <SimpleTaskDrawer {...common} /> : <TaskDrawer
    {...common}
    tasks={tasks}
    onUpdateRelatedTask={onUpdate}
    canManageStructure={isCreating ? creationDraft.scope === 'FULL' : initialAccess.canManageStructure}
    canChooseWbs={isCreating ? Boolean(creationDraft.scope) : initialAccess.canChooseWbs}
  />;
}

export function TaskDetailOverlay({ simple = false }) {
  const task = useSelectedTask();
  const creationDraft = useTaskCreationDraft();
  const tasks = useAllTasks();
  const projects = useAllProjects();
  const assignableProjects = useTaskAssignmentScope();
  const people = useAllPeople();
  const currentUser = useCurrentUser();
  const scheduleRequests = useScheduleRequests();
  if (!task) return null;
  return <TaskEditor key={`${task.id}:${simple}`} {...{ task, simple, creationDraft, tasks, projects, assignableProjects, people, currentUser, scheduleRequests }} />;
}
