import { appStateReducer, normalizeStateTask, withCompletionStamp } from './appState.js';
import { canWriteProject, resolveTaskMutationAccess } from './projectWritePolicy.js';
import { createRecurringTasks, taskCreationWithRecurrences } from './recurringTaskCreation.js';
import { normalizeTaskAssigneePatch } from '../domain/identity/taskAssigneePatch.js';
import { findProjectTag, normalizeProjectTags, projectTagCatalog } from '../domain/tags/index.js';

const EDITABLE_FIELDS = new Set([
  'task', 'description', 'keyword', 'projectId', 'wbsId', 'calendarId',
  'assigneeIds', 'status', 'priority', 'progress', 'plannedStart', 'plannedFinish',
  'targetFinish', 'plannedDurationDays', 'actualStart', 'actualFinish',
  'resetActualDates', 'remainingDurationDays', 'milestone', 'isMilestone', 'recurrence',
  'recurrenceOccurrenceDate', 'deps', 'plannedHours', 'actualHours', 'budget', 'spent'
]);

export function taskEditorPatch(before = {}, draft = {}) {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => (
    EDITABLE_FIELDS.has(key) && JSON.stringify(value ?? null) !== JSON.stringify(before[key] ?? null)
  )));
}

export function resolveTaskEditorAccess(state, taskId, patch = {}) {
  const task = state.tasks.find((item) => item.id === taskId);
  const changed = taskEditorPatch(task, patch);
  const access = resolveTaskMutationAccess(state, taskId, changed);
  if (!access.ok) return access;
  const blocked = Object.keys(changed).find((field) => (
    (field === 'targetFinish' && !access.canEditTargetFinish)
    || (['plannedStart', 'plannedFinish'].includes(field) && !access.canControlSchedule)
    || (field === 'deps' && !access.canManageStructure)
    || (field === 'recurrence' && !access.canManageRecurrence)
  ));
  return blocked ? {
    ...access, ok: false, code: 'TASK_FIELD_FORBIDDEN', field: blocked,
    message: 'Seçilen projede bu görev alanını değiştirme yetkiniz yok.'
  } : access;
}

export async function commitTaskEditorEdits(persistence, getState, edits, { onRebase, ...options } = {}) {
  const before = getState();
  const ids = [...new Set(edits.map((edit) => edit.id))];
  const flushed = await persistence.flushTaskUpdates(ids);
  const failed = flushed.find((result) => result && !result.ok);
  // Yalnızca bu boşaltmada başarıyla yazılmış yerel sürümü ilerletiriz.
  // Daha önce eskimiş taslaklar ve dışarıdan gelen sürümler CONFLICT kalır.
  const versions = new Map(flushed.flatMap((result) => result?.value?.taskUpserts || [])
    .map((task) => [task.id, task.version]));
  const rebased = edits.map((edit) => {
    const original = before.tasks.find((task) => task.id === edit.id);
    return edit.version && edit.version === original?.version && versions.get(edit.id)
      ? { ...edit, version: versions.get(edit.id) }
      : edit;
  });
  onRebase?.(rebased);
  if (failed) return failed;
  if (persistence.hasFailedTaskUpdates(ids)) return {
    ok: false,
    error: { code: 'UNSAVED_TASK_CHANGES', message: 'Önceki görev değişiklikleri kaydedilemedi. Önce bu kayıtları yeniden deneyin.' }
  };
  return persistence.mutate('task/save-draft', (current) => prepareTaskEditorCommit(current, rebased, options));
}

function taskKeywordCatalogUpdates(state, task) {
  const project = state.projects.find((item) => item.id === task?.projectId);
  if (!task?.keyword || !canWriteProject(project)) return [];
  const catalog = projectTagCatalog(project);
  if (findProjectTag(catalog, task.keyword)) return [];
  const tags = normalizeProjectTags([...catalog, { name: task.keyword }]);
  return [{ ...project, tags, tagCatalog: tags }];
}

export function prepareTaskCreationCommit(state, creation, { relatedEdits = [], generateSeries = false, syncKeywordCatalog = false } = {}) {
  const template = normalizeStateTask(creation.task, state);
  const projectUpdates = syncKeywordCatalog ? taskKeywordCatalogUpdates(state, template) : [];
  if (!relatedEdits.length && !projectUpdates.length) {
    return generateSeries ? taskCreationWithRecurrences(state, creation) : creation;
  }
  const planned = { ...state, tasks: [template, ...state.tasks] };
  const related = prepareTaskEditorCommit(planned, relatedEdits, { taskId: template.id, generateSeries });
  return { ...related, projectUpdates, tasks: [template, ...related.tasks] };
}

export function prepareTaskEditorCommit(state, edits, { taskId, generateSeries = false, syncKeywordCatalog = false } = {}) {
  let planned = state;
  const updates = [];
  for (const edit of edits) {
    const before = state.tasks.find((task) => task.id === edit.id);
    if (!before) throw Object.assign(new Error('Görev artık bulunamıyor.'), { code: 'TASK_NOT_FOUND' });
    if (edit.version && edit.version !== before.version) {
      throw Object.assign(new Error('Görev başka bir kullanıcı tarafından değiştirildi. Taslağınızı kontrol edip görevi yeniden açın.'), { code: 'CONFLICT' });
    }
    const normalized = normalizeTaskAssigneePatch(taskEditorPatch(before, edit.patch), state.people);
    if (!normalized.ok) throw Object.assign(new Error(normalized.error.message), normalized.error);
    if (!Object.keys(normalized.patch).length) continue;
    const patch = withCompletionStamp(planned, edit.id, normalized.patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'task') && !String(patch.task || '').trim()) {
      throw Object.assign(new Error('Kaydetmek için görev başlığı girin.'), { code: 'TASK_TITLE_REQUIRED' });
    }
    const access = resolveTaskEditorAccess(planned, edit.id, patch);
    if (!access.ok) throw Object.assign(new Error(access.message), access);
    updates.push({ id: edit.id, patch });
    planned = appStateReducer(planned, { type: 'task/update', id: edit.id, patch });
  }
  const template = planned.tasks.find((task) => task.id === taskId);
  const keywordChanged = updates.some((item) => item.id === taskId && Object.prototype.hasOwnProperty.call(item.patch, 'keyword'));
  const projectUpdates = syncKeywordCatalog && keywordChanged ? taskKeywordCatalogUpdates(planned, template) : [];
  if (generateSeries) {
    const access = resolveTaskMutationAccess(planned, taskId);
    if (!access.ok) throw Object.assign(new Error(access.message), access);
    if (!access.canManageRecurrence) {
      throw Object.assign(new Error('Tekrar oluşturma yetkiniz yok.'), { code: 'FORBIDDEN' });
    }
  }
  return { type: 'task/save-draft', updates, projectUpdates, tasks: generateSeries && template ? createRecurringTasks(planned, template) : [] };
}
