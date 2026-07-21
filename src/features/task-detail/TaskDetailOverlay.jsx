'use client';
import { useSelectedTask, useTaskActions, useTasks } from '../../state/hooks';
import { TaskDrawer } from './TaskDrawer';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useTasks();
  const { closeTask, updateTask, deleteTask } = useTaskActions();
  if (!task) return null;
  return <TaskDrawer task={task} tasks={tasks} onClose={closeTask} onUpdate={updateTask} onDelete={deleteTask} />;
}
