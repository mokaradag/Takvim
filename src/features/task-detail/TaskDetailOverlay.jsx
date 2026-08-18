'use client';
import { useEffect, useRef, useState } from 'react';
import { useAllPeople, useAllProjects, useAllTasks, useSelectedTask, useTaskActions } from '../../state/hooks';
import {
  canWriteProject,
  projectWriteFailure,
  resolveTaskMutationAccess
} from '../../state/projectWritePolicy.js';
import { ReadOnlyTaskDrawer } from './ReadOnlyTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import { normalizeTaskAssigneePatch } from './taskAssigneePatch.js';
import { createTaskUpdateTracker, reconcileTaskDraft } from './taskDraft';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useAllTasks();
  const projects = useAllProjects();
  const people = useAllPeople();
  const { closeTask, updateTask, moveTaskToWbs, deleteTask } = useTaskActions();
  const [displayTask, setDisplayTask] = useState(task);
  const taskIdRef = useRef(task?.id || null);
  const canonicalTaskRef = useRef(task);
  const dirtyFieldsRef = useRef(new Set());
  const updateTrackerRef = useRef(createTaskUpdateTracker());
  canonicalTaskRef.current = task;

  useEffect(() => {
    if (!task) {
      taskIdRef.current = null;
      dirtyFieldsRef.current = new Set();
      updateTrackerRef.current = createTaskUpdateTracker();
      setDisplayTask(null);
      return;
    }

    if (taskIdRef.current !== task.id) {
      taskIdRef.current = task.id;
      dirtyFieldsRef.current = new Set();
      updateTrackerRef.current = createTaskUpdateTracker();
      setDisplayTask(task);
      return;
    }

    setDisplayTask((current) => {
      const reconciled = reconcileTaskDraft(task, current || task, dirtyFieldsRef.current);
      dirtyFieldsRef.current = reconciled.dirtyFields;
      if (reconciled.dirtyFields.size === 0) updateTrackerRef.current.clearFailure();
      return reconciled.task;
    });
  }, [task]);

  if (!task) return null;

  const project = projects.find((item) => item.id === task.projectId) || null;
  if (!canWriteProject(project)) {
    return <ReadOnlyTaskDrawer task={task} onClose={closeTask} />;
  }

  const rejectedUpdate = (issue) => {
    setDisplayTask({ ...task });
    return Promise.resolve(projectWriteFailure('task/update', issue));
  };

  const onUpdate = (taskId, patch) => {
    const assigneePatch = normalizeTaskAssigneePatch(patch, people);
    if (!assigneePatch.ok) return rejectedUpdate(assigneePatch.error);
    const persistedPatch = assigneePatch.patch;

    const access = resolveTaskMutationAccess({ projects, tasks }, taskId, persistedPatch);
    if (!access.ok) return rejectedUpdate(access);

    const keys = [...new Set([...Object.keys(patch || {}), ...Object.keys(persistedPatch || {})])];
    for (const key of keys) dirtyFieldsRef.current.add(key);
    setDisplayTask((current) => ({ ...(current || task), ...patch, ...persistedPatch }));

    const result = Object.keys(persistedPatch).length === 1
      && Object.prototype.hasOwnProperty.call(persistedPatch, 'wbsId')
      && persistedPatch.wbsId
      ? moveTaskToWbs(taskId, persistedPatch.wbsId)
      : updateTask(taskId, persistedPatch);
    const tracker = updateTrackerRef.current;
    const tracked = tracker.track(result);

    tracked.then((saveResult) => {
      if (!saveResult?.ok || canonicalTaskRef.current?.id !== taskId) return;
      const committedTask = saveResult.value?.taskUpserts?.find((item) => item.id === taskId)
        || canonicalTaskRef.current;
      setDisplayTask((current) => {
        const reconciled = reconcileTaskDraft(committedTask, current || committedTask, dirtyFieldsRef.current);
        dirtyFieldsRef.current = reconciled.dirtyFields;
        if (reconciled.dirtyFields.size === 0) tracker.clearFailure();
        return reconciled.task;
      });
    });

    return tracked;
  };

  /**
   * Panel her koşulda kapanabilir.
   *
   * Önceden başarısız bir kayıt `waitForIdle()` üzerinden geri döndürülüyor ve
   * `closeTask()` hiç çağrılmıyordu: sunucu bir alanı reddettiğinde (örneğin
   * boş görev başlığı) panel kilitleniyor, kullanıcı ne "Tamam" ne de kapatma
   * düğmesiyle çıkabiliyordu. Hata artık paneli rehin almaz.
   *
   * Kapanış düzenlemeyi de atmaz: taslak burada sökülse bile reddedilen yama
   * kalıcılaştırma kuyruğunda saklanır ve şeritteki "Yeniden dene" ile aynı
   * değerlerle gönderilir (bkz. createTaskPatchCoalescer).
   */
  const onClose = async () => {
    const pendingResult = await updateTrackerRef.current.waitForIdle();
    const closeResult = await closeTask();
    return pendingResult.ok ? closeResult : pendingResult;
  };

  return (
    <TaskDrawer
      task={displayTask || task}
      tasks={tasks}
      onClose={onClose}
      onUpdate={onUpdate}
      onDelete={deleteTask}
    />
  );
}
