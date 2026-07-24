'use client';
import { useEffect, useRef, useState } from 'react';
import { useAllProjects, useAllTasks, useSelectedTask, useTaskActions } from '../../state/hooks';
import {
  canWriteProject,
  projectWriteFailure,
  resolveTaskMutationAccess
} from '../../state/projectWritePolicy.js';
import { ReadOnlyTaskDrawer } from './ReadOnlyTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import { createTaskUpdateTracker, reconcileTaskDraft } from './taskDraft';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useAllTasks();
  const projects = useAllProjects();
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

  const onUpdate = (taskId, patch) => {
    const access = resolveTaskMutationAccess({ projects, tasks }, taskId, patch);
    if (!access.ok) return Promise.resolve(projectWriteFailure('task/update', access));

    const keys = Object.keys(patch || {});
    for (const key of keys) dirtyFieldsRef.current.add(key);
    setDisplayTask((current) => ({ ...(current || task), ...patch }));

    const result = keys.length === 1 && keys[0] === 'wbsId' && patch.wbsId
      ? moveTaskToWbs(taskId, patch.wbsId)
      : updateTask(taskId, patch);
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
