import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { AppRepositoryError, REPOSITORY_ERROR_CODES } from '../contracts/appRepository.js';
import {
  loadActualIdAliases,
  persistActualIdAliases
} from './actualIdAliasStorage.js';

const CODE_BY_STATUS = {
  401: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
  403: REPOSITORY_ERROR_CODES.FORBIDDEN,
  409: REPOSITORY_ERROR_CODES.CONFLICT,
  503: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE
};
const STATUS_TO_SQL = Object.freeze({ todo: 'planned', in_progress: 'in-progress', done: 'done' });
const STATUS_FROM_SQL = Object.freeze({
  planned: 'todo',
  'not-started': 'todo',
  'in-progress': 'in_progress',
  blocked: 'in_progress',
  done: 'done',
  completed: 'done',
  cancelled: 'done'
});

export function toActualUuid(value) {
  if (value == null || value === '') return null;
  // Önekli istemci kimliğinden Gerçek Sistem kimliğini ayıklayamazsak değer
  // olduğu gibi (yalnızca küçük harfe indirilerek) geri verilir; doğrulama
  // hatası `requiredActualUuid` içinde kullanıcıya anlaşılır şekilde raporlanır.
  return extractActualId(value) || String(value).trim().toLowerCase();
}

function requiredActualUuid(value, label) {
  const normalized = toActualUuid(value);
  if (!normalized || !isActualId(normalized)) {
    // Hangi kaydın Gerçek Sistem kimliği taşımadığı iletide açıkça belirtilir;
    // aksi hâlde kullanıcı yalnızca genel bir "geçerli UUID olmalıdır" uyarısı görür
    // ve sorunlu kaydı bulmasının hiçbir yolu kalmaz.
    const received = value == null || value === '' ? 'boş' : `"${String(value)}"`;
    throw new AppRepositoryError({
      code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
      message: `${label} geçerli bir Gerçek Sistem kimliği (UUID) değil. Alınan değer: ${received}. Verileri yeniden yükleyip işlemi tekrarlayın.`,
      operation: 'commitChanges',
      details: { code: 'ACTUAL_ID_INVALID', field: label, value: value == null ? null : String(value) }
    });
  }
  return normalized;
}

function toOptionalActualUuid(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requiredActualUuid(value, label);
}

export function toPersistenceStatus(value) {
  return STATUS_TO_SQL[value] || value;
}

function toOptionalPersistenceStatus(value) {
  return value === undefined ? undefined : toPersistenceStatus(value);
}

export function fromPersistenceStatus(value) {
  return STATUS_FROM_SQL[value] || value;
}

function normalizeDelete(entry, label) {
  return typeof entry === 'string'
    ? { id: requiredActualUuid(entry, label), version: null }
    : { ...entry, id: requiredActualUuid(entry?.id, label) };
}

export function normalizeActualChanges(changes = {}) {
  return {
    ...changes,
    projectUpserts: (changes.projectUpserts || []).map((project) => ({
      ...project,
      id: requiredActualUuid(project.id, 'Proje kimliği'),
      calendarId: toOptionalActualUuid(project.calendarId, 'Proje takvim kimliği')
    })),
    projectDeletes: (changes.projectDeletes || []).map((entry) => normalizeDelete(entry, 'Proje kimliği')),
    wbsUpserts: (changes.wbsUpserts || []).map((node) => ({
      ...node,
      id: requiredActualUuid(node.id, 'WBS kimliği'),
      projectId: requiredActualUuid(node.projectId, 'WBS proje kimliği'),
      parentId: toOptionalActualUuid(node.parentId, 'Üst WBS kimliği')
    })),
    wbsDeletes: (changes.wbsDeletes || []).map((entry) => normalizeDelete(entry, 'WBS kimliği')),
    taskUpserts: (changes.taskUpserts || []).map((task) => ({
      ...task,
      id: requiredActualUuid(task.id, 'Görev kimliği'),
      projectId: requiredActualUuid(task.projectId, 'Görev proje kimliği'),
      wbsId: toOptionalActualUuid(task.wbsId, 'Görev WBS kimliği'),
      calendarId: toOptionalActualUuid(task.calendarId, 'Görev takvim kimliği'),
      // Yineleme, seri şablonuna Gerçek Sistem kimliğiyle bağlanır.
      recurrenceParentId: toOptionalActualUuid(task.recurrenceParentId, 'Tekrar şablonu kimliği'),
      status: toOptionalPersistenceStatus(task.status),
      deps: Array.isArray(task.deps) ? task.deps.map((dependency) => ({
        ...dependency,
        id: dependency.id ? requiredActualUuid(dependency.id, 'Bağımlılık kimliği') : dependency.id,
        predecessorId: requiredActualUuid(dependency.predecessorId, 'Öncül görev kimliği')
      })) : task.deps
    })),
    taskDeletes: (changes.taskDeletes || []).map((entry) => normalizeDelete(entry, 'Görev kimliği'))
  };
}

function rememberClientId(map, value) {
  if (value == null || value === '') return;
  const original = String(value);
  const actual = toActualUuid(original);
  if (actual && original !== actual) map.set(actual, original);
}

function rememberDeleteId(map, entry) {
  rememberClientId(map, typeof entry === 'string' ? entry : entry?.id);
}

function collectClientIds(changes = {}, map = new Map()) {
  for (const project of changes.projectUpserts || []) {
    rememberClientId(map, project?.id);
    rememberClientId(map, project?.calendarId);
  }
  for (const entry of changes.projectDeletes || []) rememberDeleteId(map, entry);

  for (const node of changes.wbsUpserts || []) {
    rememberClientId(map, node?.id);
    rememberClientId(map, node?.projectId);
    rememberClientId(map, node?.parentId);
  }
  for (const entry of changes.wbsDeletes || []) rememberDeleteId(map, entry);

  for (const task of changes.taskUpserts || []) {
    rememberClientId(map, task?.id);
    rememberClientId(map, task?.projectId);
    rememberClientId(map, task?.wbsId);
    rememberClientId(map, task?.calendarId);
    rememberClientId(map, task?.recurrenceParentId);
    for (const dependency of Array.isArray(task?.deps) ? task.deps : []) {
      rememberClientId(map, dependency?.id);
      rememberClientId(map, dependency?.predecessorId);
    }
  }
  for (const entry of changes.taskDeletes || []) rememberDeleteId(map, entry);
  return map;
}

function restoreClientId(value, map) {
  if (value == null || value === '') return value;
  return map.get(toActualUuid(value)) || value;
}

function restoreDeleteId(entry, map) {
  return typeof entry === 'string'
    ? restoreClientId(entry, map)
    : { ...entry, id: restoreClientId(entry?.id, map) };
}

export function restoreActualCommitIds(body, changes = {}, aliases = null) {
  if (!body || typeof body !== 'object') return body;
  const map = collectClientIds(changes, aliases || new Map());
  if (!map.size) return body;

  const restored = { ...body };
  if (Array.isArray(body.projectUpserts)) {
    restored.projectUpserts = body.projectUpserts.map((project) => ({
      ...project,
      id: restoreClientId(project.id, map),
      calendarId: restoreClientId(project.calendarId, map)
    }));
  }
  if (Array.isArray(body.projectDeletes)) {
    restored.projectDeletes = body.projectDeletes.map((entry) => restoreDeleteId(entry, map));
  }
  if (Array.isArray(body.wbsUpserts)) {
    restored.wbsUpserts = body.wbsUpserts.map((node) => ({
      ...node,
      id: restoreClientId(node.id, map),
      projectId: restoreClientId(node.projectId, map),
      parentId: restoreClientId(node.parentId, map)
    }));
  }
  if (Array.isArray(body.wbsDeletes)) {
    restored.wbsDeletes = body.wbsDeletes.map((entry) => restoreDeleteId(entry, map));
  }
  if (Array.isArray(body.taskUpserts)) {
    restored.taskUpserts = body.taskUpserts.map((task) => ({
      ...task,
      id: restoreClientId(task.id, map),
      projectId: restoreClientId(task.projectId, map),
      wbsId: restoreClientId(task.wbsId, map),
      calendarId: restoreClientId(task.calendarId, map),
      recurrenceParentId: restoreClientId(task.recurrenceParentId, map),
      // Alan YOKSA eklenmez: `deps: []` "bağımlılık yok" demektir, eksik alan
      // "bilgi taşınmadı" demektir. Takma ad eşlemesi boşken gövde olduğu gibi
      // döndüğü için aynı sunucu yanıtı iki farklı biçime çözülüyordu.
      ...(Array.isArray(task.deps) ? {
        deps: task.deps.map((dependency) => ({
          ...dependency,
          predecessorId: restoreClientId(dependency.predecessorId, map)
        }))
      } : {})
    }));
  }
  if (Array.isArray(body.taskDeletes)) {
    restored.taskDeletes = body.taskDeletes.map((entry) => restoreDeleteId(entry, map));
  }
  return restored;
}

export function restoreActualSessionIds(body, map) {
  if (!body || typeof body !== 'object' || !map?.size) return body;
  return {
    ...body,
    projectAccess: Array.isArray(body.projectAccess) ? body.projectAccess.map((entry) => ({
      ...entry,
      projectId: restoreClientId(entry.projectId, map)
    })) : body.projectAccess
  };
}

export function restoreActualSnapshotIds(body, map) {
  if (!body || typeof body !== 'object' || !map?.size) return body;
  return {
    ...body,
    projects: Array.isArray(body.projects) ? body.projects.map((project) => ({
      ...project,
      id: restoreClientId(project.id, map),
      calendarId: restoreClientId(project.calendarId, map)
    })) : body.projects,
    // Görev tanımlarken seçilebilen ek projeler de aynı kimlik eşlemesinden geçer.
    assignableProjects: Array.isArray(body.assignableProjects) ? body.assignableProjects.map((project) => ({
      ...project,
      id: restoreClientId(project.id, map),
      rootWbsId: restoreClientId(project.rootWbsId, map)
    })) : body.assignableProjects,
    wbs: Array.isArray(body.wbs) ? body.wbs.map((node) => ({
      ...node,
      id: restoreClientId(node.id, map),
      projectId: restoreClientId(node.projectId, map),
      parentId: restoreClientId(node.parentId, map)
    })) : body.wbs,
    tasks: Array.isArray(body.tasks) ? body.tasks.map((task) => ({
      ...task,
      id: restoreClientId(task.id, map),
      projectId: restoreClientId(task.projectId, map),
      wbsId: restoreClientId(task.wbsId, map),
      calendarId: restoreClientId(task.calendarId, map),
      recurrenceParentId: restoreClientId(task.recurrenceParentId, map),
      // Alan YOKSA eklenmez: `deps: []` "bağımlılık yok" demektir, eksik alan
      // "bilgi taşınmadı" demektir. Takma ad eşlemesi boşken gövde olduğu gibi
      // döndüğü için aynı sunucu yanıtı iki farklı biçime çözülüyordu.
      ...(Array.isArray(task.deps) ? {
        deps: task.deps.map((dependency) => ({
          ...dependency,
          predecessorId: restoreClientId(dependency.predecessorId, map)
        }))
      } : {})
    })) : body.tasks,
    baselines: Array.isArray(body.baselines) ? body.baselines.map((baseline) => ({
      ...baseline,
      projectId: restoreClientId(baseline.projectId, map)
    })) : body.baselines,
    taskBaselineSnapshots: Array.isArray(body.taskBaselineSnapshots) ? body.taskBaselineSnapshots.map((snapshot) => ({
      ...snapshot,
      taskId: restoreClientId(snapshot.taskId, map),
      calendarId: restoreClientId(snapshot.calendarId, map)
    })) : body.taskBaselineSnapshots
  };
}

function normalizeActualResponse(body) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body.tasks)) {
    return { ...body, tasks: body.tasks.map((task) => ({ ...task, status: fromPersistenceStatus(task.status) })) };
  }
  if (Array.isArray(body.taskUpserts)) {
    return { ...body, taskUpserts: body.taskUpserts.map((task) => ({ ...task, status: fromPersistenceStatus(task.status) })) };
  }
  return body;
}

/**
 * Sunucu isteği için SON TARİH.
 *
 * Süresiz bir `fetch`, bağlantıyı kabul edip yanıt vermeyen bir sunucuda hiç
 * sonuçlanmaz. Sıralı yazma kuyruğu dönen söze bağlandığı için tek bir askıda
 * kalan istek sekme ömrü boyunca bütün yazmaları durduruyor, görev panelindeki
 * "Tamam" düğmesi `waitForIdle()` üzerinde takılıp uygulamayı DONMUŞ
 * gösteriyordu.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * `keepalive` isteği için gövde ÜST SINIRI (Fetch standardı: 64 KiB).
 *
 * Sekme kapanırken yapılan son yazma büyük bir değişiklik kümesi taşıyabilir;
 * sınırı aşan `keepalive` isteği tarayıcı tarafından reddedilir ve düzenleme
 * "sunucuya ulaşılamadı" diyerek sessizce kaybolurdu. Sınır aşıldığında istek
 * SIRADAN bir `fetch` olarak gönderilir.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

function bodyByteLength(body) {
  if (typeof body !== 'string') return 0;
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(body).length;
  return Buffer.byteLength(body, 'utf8');
}

async function requestJson(url, init, operation) {
  // `keepalive` isteği sayfa boşalırken TAMAMLANMALIDIR: zaman aşımı denetimi
  // yalnızca sıradan isteklere kurulur.
  const abortable = !init?.keepalive && typeof AbortController === 'function';
  const controller = abortable ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  let response;
  try {
    response = await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
    });
  } catch (cause) {
    throw new AppRepositoryError({
      code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE,
      message: controller?.signal.aborted
        ? 'Gerçek Sistem sunucusu zamanında yanıt vermedi.'
        : 'Gerçek Sistem sunucusuna ulaşılamadı.',
      operation,
      cause
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppRepositoryError({
      code: body?.error?.code || CODE_BY_STATUS[response.status] || REPOSITORY_ERROR_CODES.MUTATION_FAILED,
      message: body?.error?.message || 'Gerçek Sistem işlemi tamamlanamadı.',
      operation,
      details: body?.error?.details || null
    });
  }
  return normalizeActualResponse(body);
}

export function createApiRepository({
  basePath = '/api/mergen-rota',
  aliasStorage,
  aliasStorageKey
} = {}) {
  const clientIdAliases = loadActualIdAliases(aliasStorage, aliasStorageKey);
  return {
    kind: 'actual-api',
    async loadSessionContext() {
      const session = await requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
      return restoreActualSessionIds(session, clientIdAliases);
    },
    /**
     * Anlık görüntü yanıtı oturum bağlamını da taşır ve bağlam anlık görüntüyle
     * BİRLİKTE döndürülür. Paylaşılan tek yuvada saklansaydı, üst üste binen iki
     * yükleme birbirinin oturumunu tüketebilir ve A anlık görüntüsü B'nin proje
     * erişimiyle eşleşebilirdi.
     */
    async loadSnapshot({ refreshMode = 'initial' } = {}) {
      const body = await requestJson(`${basePath}/snapshot`, {
        method: 'GET',
        headers: { 'x-mergen-rota-refresh-mode': refreshMode === 'initial' ? 'initial' : 'manual' }
      }, 'loadSnapshot');
      const { session, ...snapshot } = body || {};
      const restored = restoreActualSnapshotIds(snapshot, clientIdAliases);
      return session ? { ...restored, session: restoreActualSessionIds(session, clientIdAliases) } : restored;
    },
    /**
     * `keepalive`, sekme kapanırken yapılan son yazma içindir: tarayıcı sayfayı
     * boşaltırken sıradan bir `fetch` iptal edilebilir, bu bayrakla isteğin
     * tamamlanması garanti altına alınır.
     */
    async commitChanges(changes, { keepalive = false } = {}) {
      collectClientIds(changes, clientIdAliases);
      persistActualIdAliases(clientIdAliases, aliasStorage, aliasStorageKey);
      const body = JSON.stringify({ changes: normalizeActualChanges(changes) });
      // Büyük gövde `keepalive` sınırını aşar ve istek hiç gönderilmez; sıradan
      // isteğe düşmek, değişikliği sessizce kaybetmekten iyidir.
      const useKeepalive = keepalive && bodyByteLength(body) <= KEEPALIVE_BODY_LIMIT_BYTES;
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        keepalive: useKeepalive,
        body
      }, 'commitChanges');
      return restoreActualCommitIds(committed, changes, clientIdAliases);
    },
    async flush() {}
  };
}
