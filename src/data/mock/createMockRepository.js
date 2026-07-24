import {
  AppRepositoryError,
  REPOSITORY_ERROR_CODES
} from '../contracts/appRepository.js';
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
        currentUser: { id: 'demo-user', employeeNo: 'demo-user', name: 'Demo Kullanıcı', role: 'Demo', team: 'Demo', color: '#64748b' },
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
      const candidate = clone(snapshot);
      candidate.projects = applyCollectionChanges(candidate.projects || [], normalized.projectUpserts, normalized.projectDeletes);
      const invalidated = invalidatedPredecessorIds(beforeTasks, normalized.taskUpserts, normalized.taskDeletes);
      const appliedTasks = applyCollectionChanges(candidate.tasks || [], normalized.taskUpserts, normalized.taskDeletes, { prependNew: true });
      candidate.tasks = removePredecessorReferences(appliedTasks, invalidated);
      candidate.wbs = applyCollectionChanges(candidate.wbs || [], normalized.wbsUpserts, normalized.wbsDeletes);
      const requestedTaskIds = new Set(normalized.taskUpserts.map((task) => task.id));
      const committedTaskUpserts = candidate.tasks.filter((task) => (
        requestedTaskIds.has(task.id) || dependenciesChanged(beforeTasksById.get(task.id), task)
      ));
      snapshot = candidate;
      return clone({ ...normalized, taskUpserts: committedTaskUpserts });
    },
    async flush() {}
  };
}
