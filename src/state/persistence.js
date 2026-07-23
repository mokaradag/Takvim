import {
  normalizeRepositoryError,
  REPOSITORY_ERROR_CODES
} from '../data/contracts/appRepository.js';
import { appStateReducer } from './appState.js';

const COALESCED_TASK_FIELDS = new Set([
  'task',
  'description',
  'progress',
  'remainingDurationDays'
]);

function changedEntities(before = [], after = []) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  return {
    upserts: after.filter((item) => beforeById.get(item.id) !== item),
    deletes: before
      .filter((item) => !afterById.has(item.id))
      .map((item) => (item.version ? { id: item.id, version: item.version } : item.id))
  };
}

export function createPersistenceChangeSet(before, after) {
  const projects = changedEntities(before.projects || [], after.projects || []);
  const tasks = changedEntities(before.tasks || [], after.tasks || []);
  const wbs = changedEntities(before.wbs || [], after.wbs || []);
  const changes = {
    taskUpserts: tasks.upserts,
    taskDeletes: tasks.deletes,
    wbsUpserts: wbs.upserts,
    wbsDeletes: wbs.deletes
  };
  if (projects.upserts.length) changes.projectUpserts = projects.upserts;
  if (projects.deletes.length) changes.projectDeletes = projects.deletes;
  return changes;
}

export function isEmptyChangeSet(changes) {
  return !((changes.projectUpserts?.length || 0)
    || (changes.projectDeletes?.length || 0)
    || changes.taskUpserts.length
    || changes.taskDeletes.length
    || changes.wbsUpserts.length
    || changes.wbsDeletes.length);
}

function domainErrorFromTransition(before, after) {
  if (!after.wbsActionError || after.wbsActionError === before.wbsActionError) return null;
  return { kind: 'domain', ...after.wbsActionError };
}

export function createOrderedMutationQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(job) {
      const result = tail.then(job, job);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    whenIdle() { return tail; }
  };
}

export function createTaskPatchCoalescer(flushPatch, { delayMs = 250 } = {}) {
  const pending = new Map();

  function scheduleFlush(taskId) {
    const entry = pending.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(taskId), delayMs);
  }

  function schedule(taskId, patch) {
    return new Promise((resolve) => {
      const current = pending.get(taskId) || { patch: {}, waiters: [], timer: null };
      current.patch = { ...current.patch, ...patch };
      current.waiters.push(resolve);
      pending.set(taskId, current);
      scheduleFlush(taskId);
    });
  }

  async function flush(taskId) {
    const entry = pending.get(taskId);
    if (!entry) return { ok: true, value: null };
    pending.delete(taskId);
    clearTimeout(entry.timer);
    let result;
    try {
      result = await flushPatch(taskId, entry.patch);
    } catch {
      result = {
        ok: false,
        error: {
          kind: 'persistence',
          code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
          message: 'Değişiklik kaydedilemedi.',
          operation: 'task/update',
          details: null
        }
      };
    }
    for (const resolve of entry.waiters) resolve(result);
    return result;
  }

  async function flushAll() {
    return Promise.all([...pending.keys()].map((taskId) => flush(taskId)));
  }

  function dispose() {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  }

  return { schedule, flush, flushAll, dispose };
}

export async function loadApplicationData(repository) {
  try {
    const [snapshot, session] = await Promise.all([
      repository.loadSnapshot(),
      repository.loadSessionContext()
    ]);
    return { ok: true, snapshot: { ...snapshot, session } };
  } catch (error) {
    return {
      ok: false,
      error: normalizeRepositoryError(error, {
        code: REPOSITORY_ERROR_CODES.LOAD_FAILED,
        message: 'Veriler yüklenemedi.',
        operation: 'loadSnapshot'
      })
    };
  }
}

export function createStateMutationOrchestrator({
  repository,
  getState,
  applyStateAction,
  taskPatchDelayMs = 250,
  now = () => new Date().toISOString()
}) {
  const queue = createOrderedMutationQueue();

  const persistAction = (operation, actionOrFactory) => queue.enqueue(async () => {
    const before = getState();
    const action = typeof actionOrFactory === 'function' ? actionOrFactory(before) : actionOrFactory;
    if (!action) return { ok: true, value: null };
    const planned = appStateReducer(before, action);
    const domainError = domainErrorFromTransition(before, planned);
    if (domainError) {
      applyStateAction(action);
      return { ok: false, error: domainError };
    }
    const changes = createPersistenceChangeSet(before, planned);
    if (isEmptyChangeSet(changes)) {
      applyStateAction(action);
      return { ok: true, value: null };
    }
    applyStateAction({ type: 'persistence/start', operation });
    try {
      const committed = await repository.commitChanges(changes);
      applyStateAction({
        type: 'persistence/success',
        changes: committed,
        savedAt: now(),
        clearWbsError: true
      });
      return { ok: true, value: committed };
    } catch (error) {
      const normalized = normalizeRepositoryError(error, {
        code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
        message: 'Değişiklik kaydedilemedi.',
        operation
      });
      applyStateAction({ type: 'persistence/failure', error: normalized });
      return { ok: false, error: { kind: 'persistence', ...normalized } };
    }
  });

  const commitChanges = (operation, changes) => queue.enqueue(async () => {
    applyStateAction({ type: 'persistence/start', operation });
    try {
      const committed = await repository.commitChanges(changes);
      applyStateAction({
        type: 'persistence/success',
        changes: committed,
        savedAt: now(),
        clearWbsError: true
      });
      return { ok: true, value: committed };
    } catch (error) {
      const normalized = normalizeRepositoryError(error, {
        code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
        message: 'Değişiklik kaydedilemedi.',
        operation
      });
      applyStateAction({ type: 'persistence/failure', error: normalized });
      return { ok: false, error: { kind: 'persistence', ...normalized } };
    }
  });

  const taskPatches = createTaskPatchCoalescer(
    (id, patch) => persistAction('task/update', { type: 'task/update', id, patch }),
    { delayMs: taskPatchDelayMs }
  );

  async function updateTask(id, patch = {}) {
    const keys = Object.keys(patch);
    const canCoalesce = keys.length > 0 && keys.every((key) => COALESCED_TASK_FIELDS.has(key));
    if (canCoalesce) return taskPatches.schedule(id, patch);
    const pendingResult = await taskPatches.flush(id);
    if (!pendingResult.ok) return pendingResult;
    return persistAction('task/update', { type: 'task/update', id, patch });
  }

  return {
    updateTask,
    mutate: persistAction,
    commitChanges,
    flushTaskUpdates(ids = []) { return Promise.all([...new Set(ids)].map((id) => taskPatches.flush(id))); },
    flushAllTaskUpdates() { return taskPatches.flushAll(); },
    whenIdle() { return queue.whenIdle(); },
    async flush() {
      const results = await taskPatches.flushAll();
      const failed = results.find((result) => result && !result.ok);
      if (failed) return failed;
      await queue.whenIdle();
      return { ok: true };
    },
    dispose() { taskPatches.dispose(); }
  };
}
