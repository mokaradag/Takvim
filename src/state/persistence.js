import {
  normalizeRepositoryError,
  REPOSITORY_ERROR_CODES
} from '../data/contracts/appRepository.js';
import { appStateReducer } from './appState.js';

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
  const inFlight = new Map();
  // Reddedilen yama atılmaz: kalıcılaştırma başarısız olduğunda düzenlemenin
  // tek kopyası bu olabilir (panel kapanmış, taslak sökülmüş olabilir). Yama
  // burada saklanır, kullanıcı yazmaya devam ederse üzerine birleşir ve açık
  // bir yeniden deneme ya da yeniden yükleme kararına kadar kaybolmaz.
  const failed = new Map();
  // Uçuştaki istek sürerken İPTAL EDİLEN alanlar. `cancelFields` yalnızca
  // `pending` ve `failed` haritalarına bakıyordu; `flush`, yamayı gönderime
  // vermeden ÖNCE `pending` üzerinden sildiği için, HTTP gidiş-dönüşü boyunca
  // yama iki haritada da görünmüyor ve iptal sessizce hiçbir şey yapmıyordu.
  // İstek başarısız olduğunda iptal edilmiş alan `failed` içine geri yazılıyor,
  // "Yeniden dene" onu kalıcılaştırıyor ve kullanıcı sildiği başlığı geri
  // buluyordu.
  const cancelledInFlight = new Map();
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
    const active = inFlight.get(taskId);
    if (active) {
      const activeResult = await active;
      // İlk kayıt başarısızsa yaması bu noktada daha yeni bekleyen kaydın
      // altına birleşmiştir. Aynı görevin ikinci kaydını ancak bundan sonra
      // çıkarıp göndeririz; bekleyen yoksa ilk sonucun kendisini taşırız.
      return pending.has(taskId) ? flush(taskId, options) : activeResult;
    }

    const entry = pending.get(taskId);
    if (!entry) return { ok: true, value: null };
    pending.delete(taskId);
    clearTimeout(entry.timer);
    const operation = (async () => {
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
      // Başarısız yama saklanır; yeni bir yama ilk istek sürerken kuyruğa
      // girdiyse ikisi tek yeniden denemede birleşir. Dispose sonrasında yeni
      // saklama oluşturulmaz.
      const cancelledKeys = cancelledInFlight.get(taskId);
      cancelledInFlight.delete(taskId);
      if (!result.ok && !disposed) {
        // Gönderim sürerken iptal edilen alan SAKLANMAZ: kullanıcı o değeri
        // ekrandan kaldırdı, yeniden denemede geri gelmemelidir.
        const inFlightPatch = { ...entry.patch };
        if (cancelledKeys) for (const key of cancelledKeys) delete inFlightPatch[key];
        const retainedPatch = { ...(failed.get(taskId) || {}), ...inFlightPatch };
        if (cancelledKeys) for (const key of cancelledKeys) delete retainedPatch[key];
        const newer = pending.get(taskId);
        if (newer) {
          // Eski alanlar alta serilir: daha yeni yerel değerler her zaman kazanır.
          newer.patch = { ...retainedPatch, ...newer.patch };
          failed.delete(taskId);
        } else if (Object.keys(retainedPatch).length) {
          failed.set(taskId, retainedPatch);
        } else {
          // Bütün alanları iptal edilmiş bir yama SAKLANMAZ. Boş bir kayıt
          // bırakmak `hasFailedChanges()` sonucunu doğru tutuyor, veri
          // yenilemesini `UNSAVED_TASK_CHANGES` ile süresiz engelliyor ve
          // kullanıcıya artık var olmayan bir değişiklik için uyarı gösteriyordu.
          failed.delete(taskId);
        }
      }
      // schedule() bekleyenleri çözülmeden önce kayıt artık uçuşta sayılmaz;
      // çağıran `await updateTask()` sonrasında kararlı kuyruk durumunu görür.
      if (inFlight.get(taskId) === operation) inFlight.delete(taskId);
      for (const resolve of entry.waiters) resolve(result);
      return result;
    })();

    inFlight.set(taskId, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(taskId) === operation) inFlight.delete(taskId);
    }
  }

  async function flushAll(options = {}) {
    const results = [];
    while (pending.size || inFlight.size) {
      const taskIds = new Set([...inFlight.keys(), ...pending.keys()]);
      const batch = await Promise.all([...taskIds].map((taskId) => flush(taskId, options)));
      results.push(...batch);
    }
    return results;
  }

  function hasPending() {
    return pending.size > 0 || inFlight.size > 0;
  }

  /**
   * Bekleyen (ve saklanan) yamadan belirli alanları düşürür.
   *
   * Arayüz bir alanı geçersiz kılabilir — örneğin başlık silindiğinde. Alan
   * yalnızca yeni yamaya konmazsa, kuyrukta duran ÖNCEKİ tuş vuruşu yine de
   * kalıcılaşır ve kullanıcı ekranda görmediği bir değeri kaydetmiş olurdu.
   *
   * Yamanın ÜÇ durumu da kapsanır: kuyrukta bekleyen, UÇUŞTA olan ve reddedilip
   * saklanan. Değişmez kural: `cancelFields(id, [f])` çağrıldıktan sonra,
   * kullanıcı `f` alanını yeniden yazmadıkça `id` için giden hiçbir istek o
   * alanı taşımaz.
   */
  function cancelFields(taskId, fields = []) {
    const keys = Array.isArray(fields) ? fields : [fields];
    if (!keys.length) return;
    // Uçuştaki istek geri alınamaz; iptal, isteğin SONUCUNDA uygulanır: yanıt
    // başarısızsa alan saklanan yamaya hiç yazılmaz.
    if (inFlight.has(taskId)) {
      const cancelled = cancelledInFlight.get(taskId) || new Set();
      for (const key of keys) cancelled.add(key);
      cancelledInFlight.set(taskId, cancelled);
    }
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
    return pending.size > 0 || inFlight.size > 0 || failed.size > 0;
  }

  function hasFailedChanges() {
    return failed.size > 0;
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

  /** Başarısız yamaları yeni sunucu anlık görüntüsünün üzerine geri uygular. */
  function rebaseFailedChanges(tasks = []) {
    const failedById = new Map([...failed].map(([taskId, patch]) => [String(taskId), patch]));
    const found = new Set();
    const rebasedTasks = (tasks || []).map((task) => {
      const taskId = String(task?.id ?? '');
      const patch = failedById.get(taskId);
      if (!patch) return task;
      found.add(taskId);
      return { ...task, ...patch };
    });
    return {
      tasks: rebasedTasks,
      missingTaskIds: [...failedById.keys()].filter((taskId) => !found.has(taskId))
    };
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
    cancelledInFlight.clear();
  }

  /**
   * Kapatılmış kuyruğu yeniden kullanıma açar.
   *
   * React 18 geliştirme derlemesinde `StrictMode` etkileri BİR KEZ söküp
   * yeniden bağlar. Kuyruk `useMemo` ile üretildiği için ikinci bağlamada aynı
   * nesne kullanılıyor, ama sahte sökülmede `dispose()` çağrıldığı için
   * `schedule()` her yamayı sessizce reddediyordu: geliştirme sunucusunda
   * hiçbir görev düzenlemesi kaydedilmiyor, kullanıcı ne kayıt ne de hata
   * görüyordu. Yeniden bağlanan sağlayıcı kuyruğu bununla diriltir; üretim
   * derlemesinde etki tek kez çalıştığı için çağrı etkisizdir.
   */
  function revive() {
    disposed = false;
  }

  return {
    schedule,
    flush,
    flushAll,
    cancelFields,
    revive,
    hasPending,
    hasUnsavedChanges,
    hasFailedChanges,
    retryFailed,
    discardFailed,
    rebaseFailedChanges,
    dispose
  };
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
 * İlk yükleme ile kullanıcı/otomatik yenileme niyeti depoya açıkça iletilir.
 * İlk yükleme boş kurumsal katalog kurulumunu bekleyebilir; sonraki yenilemeler
 * mevcut yetkili snapshot'ı öne alır ve katalog tazelemesini bu okumanın
 * arkasına bırakır.
 *
 * Gidiş-dönüş maliyeti düşürülür: Gerçek Sistem deposu
 * oturum bağlamını anlık görüntü yanıtının içinde taşır ve `loadSessionContext`
 * ikinci bir ağ isteği yapmadan bunu döndürür (bkz. createApiRepository).
 */
export async function loadApplicationData(repository, { refreshMode = 'initial' } = {}) {
  try {
    const { session: embeddedSession, ...snapshot } = await repository.loadSnapshot({ refreshMode });
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
    if (action.type === 'task/update'
      && !(before.tasks || []).some((task) => String(task.id) === String(action.id))) {
      const error = {
        kind: 'persistence',
        code: 'TASK_NOT_FOUND',
        message: 'Kaydedilemeyen değişikliğin görevi artık bulunamıyor.',
        operation: 'task/update',
        details: { taskId: action.id }
      };
      applyStateAction({ type: 'persistence/failure', error });
      return { ok: false, error };
    }
    const planned = appStateReducer(before, action);
    const domainError = domainErrorFromTransition(before, planned);
    if (domainError) {
      applyStateAction(action);
      return { ok: false, error: domainError };
    }
    const changes = hydrateKnownVersions(createPersistenceChangeSet(before, planned), before);
    // Sorumlu listesi mutasyonu sunucuda içerik düzenlemesinden ayrı yetki
    // ister. Tam görev nesnesindeki `assigneeIds` değişiklik kümesinde her zaman
    // bulunduğu için niyet, gerçek yamadan ayrıca taşınır. Bu işaret kalıcı
    // modele girmez; sunucu eksik PARTIAL görünümün yetkili listeyi ezmesine
    // izin vermez.
    if (action.type === 'task/update') {
      const assigneeMutation = Object.prototype.hasOwnProperty.call(action.patch || {}, 'assigneeIds');
      changes.taskUpserts = changes.taskUpserts.map((task) => (
        String(task.id) === String(action.id) ? { ...task, assigneeMutation } : task
      ));
    }
    if (action.type === 'task/save-draft') {
      const byId = new Map(action.updates.map((update) => [String(update.id), update.patch]));
      changes.taskUpserts = changes.taskUpserts.map((task) => ({
        ...task,
        assigneeMutation: Object.prototype.hasOwnProperty.call(byId.get(String(task.id)) || {}, 'assigneeIds')
      }));
    }
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
    // Bir düzenleme oturumundaki uyumlu alanların tamamı tek görev yamasında
    // birleşir. Önceki dört alanlık beyaz liste; tarih, durum, öncelik ve etiket
    // değişimlerini ayrı, sıralı commit'lere dönüştürüyordu.
    if (keys.length > 0) return taskPatches.schedule(id, patch);
    return { ok: true, value: null };
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
    hasFailedTaskUpdates() { return taskPatches.hasFailedChanges(); },
    cancelTaskFieldUpdates(id, fields) { taskPatches.cancelFields(id, fields); },
    retryFailedTaskUpdates(options = {}) { return taskPatches.retryFailed(options); },
    discardFailedTaskUpdates() { taskPatches.discardFailed(); },
    rebaseFailedTaskUpdates(snapshot = {}) {
      const rebased = taskPatches.rebaseFailedChanges(snapshot.tasks || []);
      return {
        snapshot: { ...snapshot, tasks: rebased.tasks },
        missingTaskIds: rebased.missingTaskIds
      };
    },
    runSerialized(operation) { return queue.enqueue(operation); },
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
    dispose() { taskPatches.dispose(); },
    /** Bkz. createTaskPatchCoalescer.revive — StrictMode sahte sökülmesi. */
    revive() { taskPatches.revive(); }
  };
}
