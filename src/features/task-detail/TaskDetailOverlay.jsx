'use client';
import { useAllTasks, useSelectedTask, useTaskActions } from '../../state/hooks';
import { TaskDrawer } from './TaskDrawer';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useAllTasks();
  const { closeTask, updateTask, moveTaskToWbs, deleteTask } = useTaskActions();
  if (!task) return null;

  const onUpdate = (taskId, patch) => {
    const keys = Object.keys(patch || {});
    if (keys.length === 1 && keys[0] === 'wbsId' && patch.wbsId) {
      moveTaskToWbs(taskId, patch.wbsId);
      return;
    }
    updateTask(taskId, patch);
  };

  return <TaskDrawer task={task} tasks={tasks} onClose={closeTask} onUpdate={onUpdate} onDelete={deleteTask} />;
}