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

function wait(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldFail(setting, context) {
  return typeof setting === 'function' ? Boolean(setting(context)) : Boolean(setting);
}

function normalizeChanges(changes = {}) {
  return {
    projectUpserts: clone(changes.projectUpserts || []),
    projectDeletes: [...new Set(changes.projectDeletes || [])],
    taskUpserts: clone(changes.taskUpserts || []),
    taskDeletes: [...new Set(changes.taskDeletes || [])],
    wbsUpserts: clone(changes.wbsUpserts || []),
    wbsDeletes: [...new Set(changes.wbsDeletes || [])]
  };
}

function applyCollectionChanges(items, upserts, deletes, { prependNew = false } = {}) {
  const deleted = new Set(deletes);
  const upsertsById = new Map(upserts.map((item) => [item.id, item]));
  const existingIds = new Set(items.map((item) => item.id));
  const updated = items
    .filter((item) => !deleted.has(item.id))
    .map((item) => upsertsById.get(item.id) || item);
  const additions = upserts.filter((item) => !existingIds.has(item.id) && !deleted.has(item.id));
  return prependNew ? [...additions, ...updated] : [...updated, ...additions];
}

/**
 * Asynchronous mutable in-memory adapter.
 *
 * Successful writes survive later loadSnapshot() calls for this repository
 * instance only. A fresh instance starts again from its supplied seed.
 */
export function createMockRepository(seed = DEFAULT_SEED, options = {}) {
  let snapshot = clone(seed || DEFAULT_SEED);
  let failNextMutation = Boolean(options.failNextMutation);
  let loadAttempt = 0;
  let mutationAttempt = 0;

  const latencyMs = Number.isFinite(options.latencyMs) ? Math.max(0, options.latencyMs) : 0;

  return {
    kind: 'async-memory',

    async loadSnapshot() {
      loadAttempt += 1;
      await wait(latencyMs);
      if (shouldFail(options.failLoad, { attempt: loadAttempt })) {
        throw new AppRepositoryError({
          code: REPOSITORY_ERROR_CODES.LOAD_FAILED,
          message: 'Veriler yüklenemedi.',
          operation: 'loadSnapshot'
        });
      }
      return clone(snapshot);
    },

    async commitChanges(changes) {
      mutationAttempt += 1;
      await wait(latencyMs);

      const shouldFailMutation = failNextMutation
        || shouldFail(options.failMutation, { attempt: mutationAttempt, changes: clone(changes) });
      failNextMutation = false;

      if (shouldFailMutation) {
        throw new AppRepositoryError({
          code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
          message: 'Değişiklik kaydedilemedi.',
          operation: 'commitChanges'
        });
      }

      const normalized = normalizeChanges(changes);
      const candidate = clone(snapshot);
      candidate.projects = applyCollectionChanges(
        candidate.projects || [],
        normalized.projectUpserts,
        normalized.projectDeletes
      );
      candidate.tasks = applyCollectionChanges(
        candidate.tasks || [],
        normalized.taskUpserts,
        normalized.taskDeletes,
        { prependNew: true }
      );
      candidate.wbs = applyCollectionChanges(
        candidate.wbs || [],
        normalized.wbsUpserts,
        normalized.wbsDeletes
      );

      snapshot = candidate;

      const projectIds = new Set(normalized.projectUpserts.map((project) => project.id));
      const taskIds = new Set(normalized.taskUpserts.map((task) => task.id));
      const wbsIds = new Set(normalized.wbsUpserts.map((node) => node.id));
      const committed = {
        taskUpserts: (snapshot.tasks || []).filter((task) => taskIds.has(task.id)),
        taskDeletes: normalized.taskDeletes,
        wbsUpserts: (snapshot.wbs || []).filter((node) => wbsIds.has(node.id)),
        wbsDeletes: normalized.wbsDeletes
      };

      if (normalized.projectUpserts.length || normalized.projectDeletes.length) {
        committed.projectUpserts = (snapshot.projects || []).filter((project) => projectIds.has(project.id));
        committed.projectDeletes = normalized.projectDeletes;
      }

      return clone(committed);
    }
  };
}
