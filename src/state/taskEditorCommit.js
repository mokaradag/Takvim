import { appStateReducer, normalizeStateTask, withCompletionStamp } from './appState.js';
import { canWriteProject, resolveTaskMutationAccess } from './projectWritePolicy.js';
import { createRecurringTasks, taskCreationWithRecurrences } from './recurringTaskCreation.js';
import { normalizeTaskAssigneePatch } from '../domain/identity/taskAssigneePatch.js';
import { findProjectTag, normalizeProjectTags, projectTagCatalog } from '../domain/tags/index.js';

const EDITABLE_FIELDS = new Set([
  'task', 'description', 'keyword', 'projectId', 'wbsId', 'calendarId',
  'assigneeIds', 'status', 'priority', 'progress', 'plannedStart', 'plannedFinish',
  'targetFinish', 'plannedDurationDays', 'actualStart', 'actualFinish',
  'remainingDurationDays', 'milestone', 'isMilestone', 'recurrence',
  'recurrenceOccurrenceDate', 'deps', 'plannedHours', 'actualHours', 'budget', 'spent'
]);

export function taskEditorPatch(before = {}, draft = {}) {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => (
    EDITABLE_FIELDS.has(key) && JSON.stringify(value ?? null) !== JSON.stringify(before[key] ?? null)
  )));
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
    const access = resolveTaskMutationAccess(planned, edit.id, patch);
    if (!access.ok) throw Object.assign(new Error(access.message), access);
    updates.push({ id: edit.id, patch });
    planned = appStateReducer(planned, { type: 'task/update', id: edit.id, patch });
  }
  const template = planned.tasks.find((task) => task.id === taskId);
  const keywordChanged = updates.some((item) => item.id === taskId && Object.prototype.hasOwnProperty.call(item.patch, 'keyword'));
  const projectUpdates = syncKeywordCatalog && keywordChanged ? taskKeywordCatalogUpdates(planned, template) : [];
  if (generateSeries && !resolveTaskMutationAccess(planned, taskId, { recurrence: template?.recurrence }).canManageStructure) {
    throw Object.assign(new Error('Tekrar oluşturma yetkiniz yok.'), { code: 'FORBIDDEN' });
  }
  return { type: 'task/save-draft', updates, projectUpdates, tasks: generateSeries && template ? createRecurringTasks(planned, template) : [] };
}
