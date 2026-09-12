'use client';
import { scheduleRequestItems } from '../schedule-change/scheduleRequestQueryState.js';
import { useScheduleRequestQuery } from '../schedule-change/useScheduleRequestQuery.js';
import { useEffect, useRef, useState } from 'react';
import {
  useAllPeople, useAllProjects, useAllTasks, useTaskAssignmentScope, useCurrentUser,
  useScheduleRequests, useSelectedTask, useTaskCreationDraft, useTaskActions
} from '../../state/hooks';
import { projectWriteFailure, resolveTaskMutationAccess } from '../../state/projectWritePolicy.js';
import { resolveTaskEditorAccess, taskEditorPatch } from '../../state/taskEditorCommit.js';
import { ReadOnlyTaskDrawer } from './ReadOnlyTaskDrawer';
import { SimpleTaskDrawer } from './SimpleTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import { normalizeTaskAssigneePatch } from './taskAssigneePatch.js';

function TaskEditor({ task, simple, creationDraft, tasks, projects, assignableProjects, people, currentUser, scheduleRequests }) {
  const { closeTask, saveTaskEdits, deleteTask, submitScheduleChange, updateTaskDraft, cancelTaskDraft, saveTaskDraft, registerTaskEditorDraft } = useTaskActions();
  const [displayTask, setDisplayTask] = useState(task);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const pendingRef = useRef(new Map());
  const seriesRef = useRef(false);
  const [generateSeries, setGenerateSeries] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => registerTaskEditorDraft?.((id) => (
    id == null || id === task.id
      ? pendingRef.current.size > 0 || seriesRef.current
      : pendingRef.current.has(id)
  )), [registerTaskEditorDraft, task.id]);
  const isCreating = creationDraft?.task?.id === task.id;
  const writeState = { projects, tasks, assignableProjects, currentUser };
  const initialAccess = resolveTaskMutationAccess(writeState, task.id, {});
  const draftAccess = isCreating ? initialAccess : resolveTaskEditorAccess(writeState, task.id, pendingRef.current.get(task.id)?.patch);

  useEffect(() => {
    setDisplayTask({ ...task, ...pendingRef.current.get(task.id)?.patch });
  }, [task]);

  const onUpdate = (taskId, patch) => {
    if (saveRef.current) return Promise.resolve({ ok: false, error: { message: 'Kayıt işlemi sürüyor.' } });
    if (isCreating && taskId === task.id) {
      return Promise.resolve(updateTaskDraft(taskId, patch)).then((result) => {
        if (result?.ok && patch.projectId && patch.projectId !== task.projectId) {
          pendingRef.current.clear();
          setDirty(false);
        }
        return result;
      });
    }
    const normalized = normalizeTaskAssigneePatch(patch, people);
    const previous = pendingRef.current.get(taskId);
    const combined = { ...previous?.patch, ...patch, ...normalized.patch };
    const access = normalized.ok ? resolveTaskEditorAccess(writeState, taskId, combined) : normalized.error;
    if (!normalized.ok || !access.ok) {
      setSaveError(access.message);
      return Promise.resolve(projectWriteFailure('task/update', access));
    }
    if (taskId === task.id && patch.projectId && patch.projectId !== displayTask.projectId) {
      for (const id of pendingRef.current.keys()) if (id !== task.id) pendingRef.current.delete(id);
    }
    const original = tasks.find((item) => item.id === taskId);
    const entry = { id: taskId, version: previous?.version || original?.version, patch: combined };
    if (Object.keys(taskEditorPatch(original, combined)).length) pendingRef.current.set(taskId, entry);
    else pendingRef.current.delete(taskId);
    setDirty(pendingRef.current.size > 0);
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
        result = await saveTaskDraft(input, { generateSeries: seriesRef.current, ...options, syncKeywordCatalog: simple, relatedEdits: [...pendingRef.current.values()] });
      } else {
        const previous = pendingRef.current.get(task.id);
        const edits = new Map(pendingRef.current);
        edits.set(task.id, { id: task.id, version: previous?.version || task.version, patch: taskEditorPatch(task, input) });
        result = await saveTaskEdits([...edits.values()], {
          generateSeries: seriesRef.current, ...options, taskId: task.id, syncKeywordCatalog: simple,
          onRebase: (rebased) => {
            for (const edit of rebased) {
              const staged = pendingRef.current.get(edit.id);
              if (staged) pendingRef.current.set(edit.id, { ...staged, version: edit.version });
            }
          }
        });
      }
      if (result?.ok) {
        pendingRef.current.clear();
        seriesRef.current = false;
        setDirty(false);
        setGenerateSeries(false);
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
      seriesRef.current = false;
      return isCreating ? cancelTaskDraft() : closeTask();
    },
    onUpdate,
    onSave,
    onDelete: deleteTask,
    isCreating,
    isSaving: saving,
    hasUnsavedChanges: dirty || generateSeries,
    saveError,
    creatorFallback: isCreating ? { ...currentUser, createdAt: creationDraft.createdAt } : null,
    canManageAssignees: isCreating ? canManageDraft : draftAccess.canManageAssignees,
    canControlSchedule: isCreating || draftAccess.canControlSchedule,
    canEditTargetFinish: isCreating || draftAccess.canEditTargetFinish,
    canProposeSchedule: !isCreating && draftAccess.canProposeSchedule,
    canDelete: !isCreating && draftAccess.canDelete,
    scheduleRequests: scheduleRequests.filter((request) => String(request.taskId) === String(task.id)),
    onProposeSchedule: submitScheduleChange
  };
  return simple ? <SimpleTaskDrawer {...common} /> : <TaskDrawer
    {...common}
    tasks={tasks}
    onUpdateRelatedTask={onUpdate}
    generateSeries={generateSeries}
    onPrepareSeries={() => { seriesRef.current = true; setGenerateSeries(true); return { ok: true, staged: true }; }}
    canManageStructure={isCreating ? creationDraft.scope === 'FULL' : draftAccess.canManageStructure}
    canChooseWbs={isCreating ? Boolean(creationDraft.scope) : draftAccess.canChooseWbs}
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
  const previewRequests = useScheduleRequests();
  const requestQuery = useScheduleRequestQuery({ tab: 'sent', status: 'PENDING', taskId: task?.id }, Boolean(task?.id && creationDraft?.task?.id !== task.id));
  const scheduleRequests = scheduleRequestItems(previewRequests, requestQuery);
  if (!task) return null;
  return <TaskEditor key={task.id} {...{ task, simple, creationDraft, tasks, projects, assignableProjects, people, currentUser, scheduleRequests }} />;
}
