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
  // Reddedilen yama atılmaz: kalıcılaştırma başarısız olduğunda düzenlemenin
  // tek kopyası bu olabilir (panel kapanmış, taslak sökülmüş olabilir). Yama
  // burada saklanır, kullanıcı yazmaya devam ederse üzerine birleşir ve açık
  // bir yeniden deneme ya da yeniden yükleme kararına kadar kaybolmaz.
  const failed = new Map();
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
      // Saklanan başarısız yama yeni düzenlemenin altına serilir: kullanıcı
      // yazmaya devam ettiğinde reddedilen alanlar da birlikte yeniden gönderilir.
      const retained = failed.get(taskId);
      failed.delete(taskId);
      // Saklanan yama HER İKİ dalda da serilir. Kuyrukta zaten bir kayıt varsa
      // `retained` yalnızca siliniyor, hiç birleştirilmiyordu: reddedilen
      // düzenleme, korunması gereken tek kopya olduğu hâlde kayboluyordu.
      const current = pending.get(taskId) || { patch: {}, waiters: [], timer: null };
      current.patch = { ...(retained || {}), ...current.patch, ...patch };
      current.waiters.push(resolve);
      pending.set(taskId, current);
      scheduleFlush(taskId);
    });
  }

  async function flush(taskId, options = {}) {
    const entry = pending.get(taskId);
    if (!entry) return { ok: true, value: null };
    pending.delete(taskId);
    clearTimeout(entry.timer);
    let result;
    try {
      result = await flushPatch(taskId, entry.patch, options);
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
    // Başarısız yama saklanır; `pending` içine geri konmaz, aksi hâlde kalıcı
    // olarak reddedilen bir düzenleme her boşaltmayı sonsuz döngüye sokardı.
    if (!result.ok) failed.set(taskId, { ...(failed.get(taskId) || {}), ...entry.patch });
    for (const resolve of entry.waiters) resolve(result);
    return result;
  }

  async function flushAll(options = {}) {
    const results = [];
    while (pending.size) {
      const batch = await Promise.all([...pending.keys()].map((taskId) => flush(taskId, options)));
      results.push(...batch);
    }
    return results;
  }

  function hasPending() {
    return pending.size > 0;
  }

  /**
   * Bekleyen (ve saklanan) yamadan belirli alanları düşürür.
   *
   * Arayüz bir alanı geçersiz kılabilir — örneğin başlık silindiğinde. Alan
   * yalnızca yeni yamaya konmazsa, kuyrukta duran ÖNCEKİ tuş vuruşu yine de
   * kalıcılaşır ve kullanıcı ekranda görmediği bir değeri kaydetmiş olurdu.
   */
  function cancelFields(taskId, fields = []) {
    const keys = Array.isArray(fields) ? fields : [fields];
    if (!keys.length) return;
    const entry = pending.get(taskId);
    if (entry) {
      for (const key of keys) delete entry.patch[key];
      if (!Object.keys(entry.patch).length) {
        clearTimeout(entry.timer);
        pending.delete(taskId);
        for (const resolve of entry.waiters) resolve({ ok: true, value: null });
      }
    }
    const retained = failed.get(taskId);
    if (!retained) return;
    for (const key of keys) delete retained[key];
    if (!Object.keys(retained).length) failed.delete(taskId);
  }

  /** Kaydedilmemiş düzenleme: kuyrukta bekleyen ya da reddedilip saklanan. */
  function hasUnsavedChanges() {
    return pending.size > 0 || failed.size > 0;
  }

  /** Saklanan başarısız yamaları kuyruğa alıp yeniden gönderir. */
  function retryFailed(options = {}) {
    for (const [taskId, patch] of failed) {
      failed.delete(taskId);
      const current = pending.get(taskId) || { patch: {}, waiters: [], timer: null };
      current.patch = { ...patch, ...current.patch };
      pending.set(taskId, current);
    }
    return flushAll(options);
  }

  /** Saklanan başarısız yamaları atar (kullanıcı yeniden yüklemeyi seçtiğinde). */
  function discardFailed() {
    failed.clear();
  }

  function dispose() {
    disposed = true;
    const result = disposalResult();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      for (const resolve of entry.waiters) resolve(result);
    }
    pending.clear();
    failed.clear();
  }

  return { schedule, flush, flushAll, cancelFields, hasPending, hasUnsavedChanges, retryFailed, discardFailed, dispose };
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
    const { session: embeddedSession, ...snapshot } = await repository.loadSnapshot();
    // Gerçek Sistem deposu oturumu anlık görüntüyle birlikte döndürür; ayrı bir
    // istek yalnızca bağlam gömülü gelmediğinde yapılır.
    const session = embeddedSession
      || (typeof repository.loadSessionContext === 'function'
        ? await repository.loadSessionContext()
        : defaultSessionContext(repository));
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

  const persistAction = (operation, actionOrFactory, options = {}) => queue.enqueue(async () => {
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
      const committed = await repository.commitChanges(changes, options);
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
    (id, patch, options) => persistAction('task/update', { type: 'task/update', id, patch }, options),
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
    flushTaskUpdates(ids = [], options = {}) {
      return Promise.all([...new Set(ids)].map((id) => taskPatches.flush(id, options)));
    },
    flushAllTaskUpdates(options = {}) { return taskPatches.flushAll(options); },
    // Kaydedilmemiş düzenleme var mı? Gecikmeli birleştirme kuyruğunda bekleyen
    // yamalar ve reddedilip saklanan yamalar birlikte sayılır: sekme
    // kapatılırken uyarmak ve yeniden denemeyi önermek için kullanılır.
    hasPendingChanges() { return taskPatches.hasUnsavedChanges(); },
    cancelTaskFieldUpdates(id, fields) { taskPatches.cancelFields(id, fields); },
    retryFailedTaskUpdates(options = {}) { return taskPatches.retryFailed(options); },
    discardFailedTaskUpdates() { taskPatches.discardFailed(); },
    whenIdle() { return queue.whenIdle(); },
    async flush(options = {}) {
      while (true) {
        const results = await taskPatches.flushAll(options);
        const failed = results.find((result) => result && !result.ok);
        if (failed) return failed;
        await queue.whenIdle();
        if (!taskPatches.hasPending()) return { ok: true };
      }
    },
    dispose() { taskPatches.dispose(); }
  };
}
