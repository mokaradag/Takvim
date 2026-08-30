import { createNewTask } from './appState.js';
import { projectWriteFailure, resolveTaskCreationAccess } from './projectWritePolicy.js';
import { WORKSPACE_MODE_PROJECT } from './selectors/workspaceSelectors.js';

const ASSIGNEE_TASK_CREATE_FIELDS = new Set([
  'task', 'title', 'description', 'keyword', 'status', 'priority', 'progress',
  'wbsId', 'plannedStart', 'plannedFinish', 'targetFinish'
]);

/**
 * Görev oluşturma yetkisini ve dar sorumlu yükünü tek davranış sınırında uygular.
 *
 * İstemcideki alan daraltması yalnızca kullanılabilirlik ve eski istemcilerin
 * güvenli davranması içindir. Sunucu aynı kapsamı SQL işlemi içinde yeniden
 * doğrular.
 */
export async function executeTaskCreation({ state = {}, input = null, id, mutate }) {
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function');

  const creation = resolveTaskCreationAccess(state, input?.projectId);
  if (!creation.ok) {
    return {
      result: projectWriteFailure('task/create', creation),
      created: null,
      scope: null
    };
  }

  const { project, scope } = creation;
  const scopedState = {
    ...state,
    workspaceMode: WORKSPACE_MODE_PROJECT,
    selectedProjectId: project.id
  };
  const taskInput = input || {};
  const baseTask = createNewTask(scopedState, undefined, id, project);
  const scopedInput = scope === 'ASSIGNEE_CREATE'
    ? Object.fromEntries(Object.entries(taskInput).filter(([key]) => ASSIGNEE_TASK_CREATE_FIELDS.has(key)))
    : taskInput;
  const scopedWbsId = scope === 'ASSIGNEE_CREATE'
    ? (state.wbs || []).find((node) => String(node.id) === String(scopedInput.wbsId)
      && String(node.projectId) === String(project.id))?.id || baseTask.wbsId
    : null;
  const currentUserId = state.currentUser?.id == null ? null : String(state.currentUser.id);
  const currentUserName = String(state.currentUser?.name || '').trim();

  const result = await mutate('task/create', () => ({
    type: 'task/add',
    task: {
      ...baseTask,
      ...scopedInput,
      id,
      projectId: project.id,
      projectCode: scope === 'ASSIGNEE_CREATE' ? (project.code ?? '') : (taskInput.projectCode ?? project.code ?? ''),
      proje: scope === 'ASSIGNEE_CREATE' ? (project.name ?? '') : (taskInput.proje ?? project.name ?? ''),
      color: scope === 'ASSIGNEE_CREATE' ? (project.color ?? baseTask.color) : (taskInput.color ?? project.color ?? baseTask.color),
      ...(scope === 'ASSIGNEE_CREATE' ? {
        wbsId: scopedWbsId,
        calendarId: null,
        assigneeIds: currentUserId ? [currentUserId] : [],
        sorumlu: currentUserId && currentUserName ? [currentUserName] : [],
        deps: [],
        recurrence: null,
        recurrenceParentId: null,
        recurrenceOccurrenceDate: null,
        milestone: false,
        isMilestone: false,
        sortOrder: null,
        plannedStart: scopedInput.plannedStart ?? baseTask.plannedStart,
        plannedFinish: scopedInput.plannedFinish ?? baseTask.plannedFinish,
        plannedDurationDays: null,
        targetFinish: scopedInput.targetFinish ?? baseTask.targetFinish,
        actualStart: null,
        actualFinish: null,
        remainingDurationDays: null,
        plannedHours: null,
        actualHours: null,
        budget: null,
        spent: null
      } : {})
    }
  }));
  const created = result.ok ? result.value?.taskUpserts?.[0] || null : null;
  return { result, created, scope };
}