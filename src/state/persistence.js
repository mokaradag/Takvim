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

function versionMap(items = []) {
  return new Map(items
    .filter((item) => item?.id && item?.version)
    .map((item) => [String(item.id), item.version]));
}

function hydrateUpserts(entries = [], knownVersions) {
  return entries.map((entry) => {
    if (!entry?.id || entry.version) return entry;
    const version = knownVersions.get(String(entry.id));
    return version ? { ...entry, version } : entry;
  });
}

function hydrateDeletes(entries = [], knownVersions) {
  return entries.map((entry) => {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!id) return entry;
    if (typeof entry !== 'string' && entry.version) return entry;
    const version = knownVersions.get(String(id));
    return version ? { ...(typeof entry === 'string' ? { id } : entry), version } : entry;
  });
}

// Sunucu, sürümü bulunan kayıtları güncelleme; sürümsüz kayıtları oluşturma niyeti olarak yorumlar.
// Arayüzdeki kısmi nesneler sürüm alanını düşürse bile mevcut kayıtların oluşturma sanılmasını önleriz.
export function hydrateKnownVersions(changes, state = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('Kalıcılaştırma değişiklik kümesi geçerli bir nesne olmalıdır.');
  }
  const projectVersions = versionMap(state.projects);
  const taskVersions = versionMap(state.tasks);
  const wbsVersions = versionMap(state.wbs);
  return {
    ...changes,
    projectUpserts: hydrateUpserts(changes.projectUpserts || [], projectVersions),
    projectDeletes: hydrateDeletes(changes.projectDeletes || [], projectVersions),
    taskUpserts: hydrateUpserts(changes.taskUpserts || [], taskVersions),
    taskDeletes: hydrateDeletes(changes.taskDeletes || [], taskVersions),
    wbsUpserts: hydrateUpserts(changes.wbsUpserts || [], wbsVersions),
    wbsDeletes: hydrateDeletes(changes.wbsDeletes || [], wbsVersions)
  };
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
    async whenIdle() {
      let observed;
      do {
        observed = tail;
        await observed;
      } while (observed !== tail);
    }
  };
}

export function createTaskPatchCoalescer(flushPatch, { delayMs = 250 } = {}) {
  const pending = new Map();
  let disposed = false;

  function disposalResult() {
    return {
      ok: false,
      error: {
        kind: 'persistence',
        code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
        message: 'Bekleyen değişiklik kaydedilmeden işlem sonlandırıldı.',
        operation: 'task/update',
        details: null
      }
    };
  }

  function scheduleFlush(taskId) {
    const entry = pending.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(taskId), delayMs);
  }

  function schedule(taskId, patch) {
    if (disposed) return Promise.resolve(disposalResult());
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
    const results = [];
    while (pending.size) {
      const batch = await Promise.all([...pending.keys()].map((taskId) => flush(taskId)));
      results.push(...batch);
    }
    return results;
  }

  function hasPending() {
    return pending.size > 0;
  }

  function dispose() {
    disposed = true;
    const result = disposalResult();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      for (const resolve of entry.waiters) resolve(result);
    }
    pending.clear();
  }

  return { schedule, flush, flushAll, hasPending, dispose };
}

function defaultSessionContext(repository) {
  return {
    dataMode: repository?.kind === 'actual-api' || repository?.kind === 'sql-server' ? 'actual' : 'demo',
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  };
}

/**
 * Açılış verisi yüklenir.
 *
 * SIRA BİLİNÇLİDİR ve paralelleştirilemez: anlık görüntü isteği kurumsal
 * katalog eşitlemesini tetikler ve yeni kurumsal proje kayıtları oluşturabilir.
 * Oturum bağlamı (yetkiler, proje erişimi) bu eşitlemeden ÖNCE okunursa yeni
 * projeler erişim listesinde görünmez. Bu yüzden oturum her zaman anlık
 * görüntüden sonra okunur.
 *
 * Gidiş-dönüş maliyeti sıralamayı bozmadan düşürülür: Gerçek Sistem deposu
 * oturum bağlamını anlık görüntü yanıtının içinde taşır ve `loadSessionContext`
 * ikinci bir ağ isteği yapmadan bunu döndürür (bkz. createApiRepository).
 */
export async function loadApplicationData(repository) {
  try {
    const snapshot = await repository.loadSnapshot();
    const session = typeof repository.loadSessionContext === 'function'
      ? await repository.loadSessionContext()
      : defaultSessionContext(repository);
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
    const changes = hydrateKnownVersions(createPersistenceChangeSet(before, planned), before);
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
      const preparedChanges = hydrateKnownVersions(changes, getState());
      const committed = await repository.commitChanges(preparedChanges);
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
    // Henüz sunucuya gitmemiş, gecikmeli birleştirme kuyruğunda bekleyen
    // düzenleme var mı? Sekme kapatılırken uyarmak için kullanılır.
    hasPendingChanges() { return taskPatches.hasPending(); },
    whenIdle() { return queue.whenIdle(); },
    async flush() {
      while (true) {
        const results = await taskPatches.flushAll();
        const failed = results.find((result) => result && !result.ok);
        if (failed) return failed;
        await queue.whenIdle();
        if (!taskPatches.hasPending()) return { ok: true };
      }
    },
    dispose() { taskPatches.dispose(); }
  };
}
