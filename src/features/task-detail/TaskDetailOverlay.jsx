'use client';
import { useEffect, useRef, useState } from 'react';
import {
  useAllPeople,
  useAllProjects,
  useAllTasks,
  useTaskAssignmentScope,
  useCurrentUser,
  useScheduleRequests,
  useSelectedTask,
  useTaskCreationDraft,
  useTaskActions
} from '../../state/hooks';
import {
  projectWriteFailure,
  resolveTaskMutationAccess
} from '../../state/projectWritePolicy.js';
import { ReadOnlyTaskDrawer } from './ReadOnlyTaskDrawer';
import { SimpleTaskDrawer } from './SimpleTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import { normalizeTaskAssigneePatch } from './taskAssigneePatch.js';
import {
  clearCompletedClosingTaskId,
  closeTaskWithPendingUpdates,
  createTaskUpdateTracker,
  reconcileTaskDraft
} from './taskDraft';

export function TaskDetailOverlay({ simple = false }) {
  const task = useSelectedTask();
  const creationDraft = useTaskCreationDraft();
  const tasks = useAllTasks();
  const projects = useAllProjects();
  // Yazma kararı HAM kapsamı kullanır: yönetici bu projede görev oluşturunca
  // proje PARTIAL görünür hâle gelir ve süzülmüş liste kendi görevini salt
  // okunur açardı.
  const assignableProjects = useTaskAssignmentScope();
  const people = useAllPeople();
  const currentUser = useCurrentUser();
  const scheduleRequests = useScheduleRequests();
  const {
    closeTask,
    updateTask,
    moveTaskToWbs,
    deleteTask,
    submitScheduleChange,
    updateTaskDraft,
    cancelTaskDraft,
    saveTaskDraft
  } = useTaskActions();
  const [displayTask, setDisplayTask] = useState(task);
  const [closingTaskId, setClosingTaskId] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const draftSaveRef = useRef(null);
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

  const isCreating = creationDraft?.task?.id === task.id;
  if (isCreating) {
    const creatorFallback = { ...currentUser, createdAt: creationDraft.createdAt };
    const canManageDraft = creationDraft.scope === 'FULL' || creationDraft.scope === 'ASSIGNMENT';
    const saveDraft = (input, options) => {
      if (draftSaveRef.current?.id === task.id) return draftSaveRef.current.promise;
      setSavingDraft(true);
      const pending = { id: task.id, promise: null };
      pending.promise = saveTaskDraft(input, options).finally(() => {
        if (draftSaveRef.current === pending) {
          draftSaveRef.current = null;
          setSavingDraft(false);
        }
      });
      draftSaveRef.current = pending;
      return pending.promise;
    };
    const common = {
      task,
      onClose: cancelTaskDraft,
      onUpdate: updateTaskDraft,
      onDelete: () => Promise.resolve({ ok: true, value: null }),
      canManageAssignees: canManageDraft,
      canControlSchedule: true,
      canEditTargetFinish: true,
      canProposeSchedule: false,
      canDelete: false,
      isSaving: savingDraft,
      isCreating: true,
      onSave: saveDraft,
      creatorFallback
    };
    return simple
      ? <SimpleTaskDrawer key={task.id} {...common} />
      : <TaskDrawer
          key={task.id}
          {...common}
          tasks={tasks}
          canManageStructure={canManageDraft}
          canChooseWbs={Boolean(creationDraft.scope)}
        />;
  }

  // Yazma yetkisi görev ATAMA kapsamını ve görevin yetkili sorumlusu için dar
  // içerik/ilerleme kapsamını içerir (bkz. projectWritePolicy).
  const writeState = { projects, tasks, assignableProjects, currentUser };
  // Görev kapsamlı adlar yalnızca gösterilir; kimlik ve yazma kararı mevcut
  // Sicil kapsamı ile yetkili sorumlu sayısından türetilir.
  const initialAccess = resolveTaskMutationAccess(writeState, task.id, {});
  if (!initialAccess.ok) {
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

    const access = resolveTaskMutationAccess(writeState, taskId, persistedPatch);
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
    const taskId = task.id;
    setClosingTaskId(taskId);
    try {
      // closeTask bekleyen yamayı hemen boşaltır. İzleyiciyle paralel beklemek,
      // önce debounce süresini sonra aynı kaydı ikinci kez bekleyen seri kapanışı
      // ortadan kaldırır; boşaltılan yama yalnızca bir commit üretir.
      return await closeTaskWithPendingUpdates(updateTrackerRef.current, closeTask);
    } finally {
      setClosingTaskId((currentTaskId) => clearCompletedClosingTaskId(currentTaskId, taskId));
    }
  };

  // Temel Kipte sade düzenleyici açılır: Kapsamlı Kipin tam paneli, Temel Kipte
  // hiç toplanmayan alanlarla kullanıcıyı karşılardı.
  if (simple) {
    return (
      <SimpleTaskDrawer
        key={task.id}
        task={displayTask || task}
        onClose={onClose}
        onUpdate={onUpdate}
        onDelete={deleteTask}
        canManageAssignees={initialAccess.canManageAssignees}
        canControlSchedule={initialAccess.canControlSchedule}
        canEditTargetFinish={initialAccess.canEditTargetFinish}
        canProposeSchedule={initialAccess.canProposeSchedule}
        scheduleRequests={scheduleRequests.filter((request) => String(request.taskId) === String(task.id))}
        onProposeSchedule={submitScheduleChange}
        canDelete={initialAccess.canDelete}
        isSaving={closingTaskId === task.id}
      />
    );
  }

  return (
    <TaskDrawer
      key={task.id}
      task={displayTask || task}
      tasks={tasks}
      onClose={onClose}
      onUpdate={onUpdate}
      onDelete={deleteTask}
      canManageStructure={initialAccess.canManageStructure}
      canChooseWbs={initialAccess.canChooseWbs}
      canManageAssignees={initialAccess.canManageAssignees}
      canControlSchedule={initialAccess.canControlSchedule}
      canEditTargetFinish={initialAccess.canEditTargetFinish}
      canProposeSchedule={initialAccess.canProposeSchedule}
      scheduleRequests={scheduleRequests.filter((request) => String(request.taskId) === String(task.id))}
      onProposeSchedule={submitScheduleChange}
      canDelete={initialAccess.canDelete}
      isSaving={closingTaskId === task.id}
    />
  );
}
