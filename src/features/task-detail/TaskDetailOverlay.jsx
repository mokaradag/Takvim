'use client';
import { useEffect, useRef, useState } from 'react';
import { useAllTasks, useSelectedTask, useTaskActions } from '../../state/hooks';
import { TaskDrawer } from './TaskDrawer';
import { createTaskUpdateTracker, reconcileTaskDraft } from './taskDraft';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useAllTasks();
  const { closeTask, updateTask, moveTaskToWbs, deleteTask } = useTaskActions();
  const [displayTask, setDisplayTask] = useState(task);
  const taskIdRef = useRef(task?.id || null);
  const dirtyFieldsRef = useRef(new Set());
  const updateTrackerRef = useRef(createTaskUpdateTracker());

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

  const onUpdate = (taskId, patch) => {
    const keys = Object.keys(patch || {});
    for (const key of keys) dirtyFieldsRef.current.add(key);
    setDisplayTask((current) => ({ ...(current || task), ...patch }));

    const result = keys.length === 1 && keys[0] === 'wbsId' && patch.wbsId
      ? moveTaskToWbs(taskId, patch.wbsId)
      : updateTask(taskId, patch);
    return updateTrackerRef.current.track(result);
  };

  const onClose = async () => {
    const pendingResult = await updateTrackerRef.current.waitForIdle();
    if (!pendingResult.ok) return pendingResult;
    return closeTask();
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
