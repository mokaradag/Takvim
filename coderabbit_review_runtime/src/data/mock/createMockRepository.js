import {
  AppRepositoryError,
  REPOSITORY_ERROR_CODES
} from '../contracts/appRepository.js';
import { applyProjectTagPropagation, planProjectTagPropagation } from '../../domain/tags/index.js';
import {
  BASELINES,
  CALENDARS,
  PEOPLE,
  PROJECTS,
  TASK_BASELINE_SNAPSHOTS,
  TASKS,
  WBS
} from './seed.js';

const DEFAULT_SEED = {
  calendars: CALENDARS,
  projects: PROJECTS,
  people: PEOPLE,
  wbs: WBS,
  tasks: TASKS,
  baselines: BASELINES,
  taskBaselineSnapshots: TASK_BASELINE_SNAPSHOTS
};

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
function wait(ms) { return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }
function shouldFail(setting, context) { return typeof setting === 'function' ? Boolean(setting(context)) : Boolean(setting); }
function normalizeDelete(value) { return typeof value === 'string' ? value : value?.id; }
function normalizeChanges(changes = {}) {
  const normalized = {
    taskUpserts: clone(changes.taskUpserts || []),
    taskDeletes: [...new Set((changes.taskDeletes || []).map(normalizeDelete).filter(Boolean))],
    wbsUpserts: clone(changes.wbsUpserts || []),
    wbsDeletes: [...new Set((changes.wbsDeletes || []).map(normalizeDelete).filter(Boolean))]
  };
  if ('projectUpserts' in changes) normalized.projectUpserts = clone(changes.projectUpserts || []);
  if ('projectDeletes' in changes) {
    normalized.projectDeletes = [...new Set((changes.projectDeletes || []).map(normalizeDelete).filter(Boolean))];
  }
  return normalized;
}
/**
 * Aynı kimliği HEM ekleyen HEM silen değişiklik kümesi reddedilir.
 *
 * Eskiden silme kazanıyor, ekleme sessizce düşüyor ve `commitChanges` yine de
 * başarıyla çözülüyordu: çağıran hem `taskUpserts` hem `taskDeletes` içinde o
 * kimliği geri alıyor, istemci durumu ile depo anlık görüntüsü ayrışıyordu.
 */
function assertNoConflictingChange(upserts = [], deletes = [], collection = 'kayıt') {
  const deleted = new Set(deletes);
  const conflicting = upserts.map((item) => item?.id).find((id) => id != null && deleted.has(id));
  if (conflicting != null) {
    throw new AppRepositoryError({
      code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
      message: `Aynı ${collection} tek bir değişiklik kümesinde hem güncellenip hem silinemez (${conflicting}).`,
      operation: 'commitChanges'
    });
  }
}

function applyCollectionChanges(items, upserts = [], deletes = [], { prependNew = false } = {}) {
  const deleted = new Set(deletes);
  const upsertsById = new Map(upserts.map((item) => [item.id, item]));
  const existingIds = new Set(items.map((item) => item.id));
  const updated = items.filter((item) => !deleted.has(item.id)).map((item) => upsertsById.get(item.id) || item);
  const additions = upserts.filter((item) => !existingIds.has(item.id) && !deleted.has(item.id));
  return prependNew ? [...additions, ...updated] : [...updated, ...additions];
}
function invalidatedPredecessorIds(beforeTasks, upserts, deletes) {
  const invalidated = new Set(deletes || []);
  const beforeById = new Map((beforeTasks || []).map((task) => [task.id, task]));
  for (const task of upserts || []) {
    const before = beforeById.get(task.id);
    if (before && before.projectId !== task.projectId) invalidated.add(task.id);
  }
  return invalidated;
}
function removePredecessorReferences(tasks, predecessorIds) {
  if (!predecessorIds.size) return tasks;
  return tasks.map((task) => {
    const dependencies = task.deps || [];
    const filtered = dependencies.filter((dependency) => !predecessorIds.has(dependency.predecessorId));
    return filtered.length === dependencies.length ? task : { ...task, deps: filtered };
  });
}
function dependenciesChanged(before, after) {
  return JSON.stringify(before?.deps || []) !== JSON.stringify(after?.deps || []);
}

export function createMockRepository(seed = DEFAULT_SEED, options = {}) {
  let snapshot = clone(seed || DEFAULT_SEED);
  let failNextMutation = Boolean(options.failNextMutation);
  let loadAttempt = 0;
  let mutationAttempt = 0;
  const latencyMs = Number.isFinite(options.latencyMs) ? Math.max(0, options.latencyMs) : 0;

  return {
    kind: 'async-memory',
    dataMode: 'demo',
    async loadSessionContext() {
      return {
        dataMode: 'demo',
        authMode: 'demo',
        authenticated: false,
        // Demo kimliği kurumsal Sicil taşımaz: fotoğraf üretilmez, baş harf gösterilir.
        currentUser: {
          id: 'demo-user',
          employeeNo: 'demo-user',
          name: 'Demo Kullanıcı',
          role: 'Demo',
          team: 'Demo',
          department: 'Demo Ortamı',
          color: '#64748b'
        },
        isSystemAdmin: true,
        isExecutive: true,
        canCreateProjects: true,
        projectAccess: (snapshot.projects || []).map((project) => ({ projectId: project.id, accessLevel: 'FULL', reasons: ['DEMO'] }))
      };
    },
    async loadSnapshot() {
      loadAttempt += 1;
      await wait(latencyMs);
      if (shouldFail(options.failLoad, { attempt: loadAttempt })) {
        throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.LOAD_FAILED, message: 'Veriler yüklenemedi.', operation: 'loadSnapshot' });
      }
      return clone(snapshot);
    },
    async commitChanges(changes) {
      mutationAttempt += 1;
      await wait(latencyMs);
      const fail = failNextMutation || shouldFail(options.failMutation, { attempt: mutationAttempt, changes: clone(changes) });
      failNextMutation = false;
      if (fail) throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.MUTATION_FAILED, message: 'Değişiklik kaydedilemedi.', operation: 'commitChanges' });
      const normalized = normalizeChanges(changes);
      const beforeTasks = snapshot.tasks || [];
      const beforeTasksById = new Map(beforeTasks.map((task) => [task.id, task]));
      const beforeProjectsById = new Map((snapshot.projects || []).map((project) => [project.id, project]));
      const candidate = clone(snapshot);
      assertNoConflictingChange(normalized.projectUpserts, normalized.projectDeletes, 'proje');
      assertNoConflictingChange(normalized.taskUpserts, normalized.taskDeletes, 'görev');
      assertNoConflictingChange(normalized.wbsUpserts, normalized.wbsDeletes, 'WBS düğümü');
      candidate.projects = applyCollectionChanges(candidate.projects || [], normalized.projectUpserts, normalized.projectDeletes);
      const invalidated = invalidatedPredecessorIds(beforeTasks, normalized.taskUpserts, normalized.taskDeletes);
      const appliedTasks = applyCollectionChanges(candidate.tasks || [], normalized.taskUpserts, normalized.taskDeletes, { prependNew: true });
      candidate.tasks = removePredecessorReferences(appliedTasks, invalidated);
      candidate.wbs = applyCollectionChanges(candidate.wbs || [], normalized.wbsUpserts, normalized.wbsDeletes);
      // Etiket kataloğu değiştiğinde görev anahtar sözcükleri Gerçek Sistem'de
      // olduğu gibi DEPO sınırında hizalanır; iki veri modu aynı planı uygular.
      const propagatedTaskIds = new Set();
      for (const project of normalized.projectUpserts || []) {
        const before = beforeProjectsById.get(project.id);
        const plan = planProjectTagPropagation({
          storedTags: before?.tagCatalog ?? before?.tags ?? [],
          nextTags: project.tags,
          renames: project.tagRenames
        });
        const nextTasks = applyProjectTagPropagation(candidate.tasks, project.id, plan);
        for (let index = 0; index < nextTasks.length; index += 1) {
          if (nextTasks[index] !== candidate.tasks[index]) propagatedTaskIds.add(nextTasks[index].id);
        }
        candidate.tasks = nextTasks;
      }
      const requestedTaskIds = new Set([...normalized.taskUpserts.map((task) => task.id), ...propagatedTaskIds]);
      const committedTaskUpserts = candidate.tasks.filter((task) => (
        requestedTaskIds.has(task.id) || dependenciesChanged(beforeTasksById.get(task.id), task)
      ));
      snapshot = candidate;
      return clone({ ...normalized, taskUpserts: committedTaskUpserts });
    },
    async flush() {}
  };
}
