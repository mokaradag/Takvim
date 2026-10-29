import { PERSISTED_TASK_STATUSES } from '../../domain/constants/index.js';
import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { creationEntries } from '../../domain/identity/creationIds.js';
import { createCreationIdStorage } from './creationIdStorage.js';
import { activateActualIdAliases } from './activeActualIdAliases.js';
import { AppRepositoryError, REPOSITORY_ERROR_CODES } from '../contracts/appRepository.js';
import {
  loadActualIdAliases, actualIdAliasType, ACTUAL_ID_ALIAS_STORAGE_KEY
} from './actualIdAliasStorage.js';

const CODE_BY_STATUS = {
  401: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
  403: REPOSITORY_ERROR_CODES.FORBIDDEN,
  409: REPOSITORY_ERROR_CODES.CONFLICT,
  503: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE
};
const STATUS_TO_SQL = Object.freeze({ todo: 'planned', in_progress: 'in-progress', done: 'done' });


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
  return PERSISTED_TASK_STATUSES[value] || value;
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

function rememberClientId(map, value, values) {
  if (value == null || value === '') return;
  const original = String(value);
  const actual = toActualUuid(original);
  if (actual && original !== actual && !values.has(original)) {
    if (map.has(actual)) {
      const previous = map.get(actual), remaining = values.get(previous) - 1;
      if (remaining) values.set(previous, remaining);
      else values.delete(previous);
    }
    map.set(actual, original);
    values.set(original, 1);
  }
}

function rememberDeleteId(map, entry, values) {
  rememberClientId(map, typeof entry === 'string' ? entry : entry?.id, values);
}

function collectClientIds(changes = {}, map = new Map()) {
  // Counts preserve overwrite/deduplication semantics when values are shared.
  const values = new Map();
  for (const value of map.values()) values.set(value, (values.get(value) || 0) + 1);
  for (const project of changes.projectUpserts || []) {
    rememberClientId(map, project?.id, values);
    rememberClientId(map, project?.calendarId, values);
  }
  for (const entry of changes.projectDeletes || []) rememberDeleteId(map, entry, values);

  for (const node of changes.wbsUpserts || []) {
    rememberClientId(map, node?.id, values);
    rememberClientId(map, node?.projectId, values);
    rememberClientId(map, node?.parentId, values);
  }
  for (const entry of changes.wbsDeletes || []) rememberDeleteId(map, entry, values);

  for (const task of changes.taskUpserts || []) {
    rememberClientId(map, task?.id, values);
    rememberClientId(map, task?.projectId, values);
    rememberClientId(map, task?.wbsId, values);
    rememberClientId(map, task?.calendarId, values);
    rememberClientId(map, task?.recurrenceParentId, values);
    for (const dependency of Array.isArray(task?.deps) ? task.deps : []) {
      rememberClientId(map, dependency?.id, values);
      rememberClientId(map, dependency?.predecessorId, values);
    }
  }
  for (const entry of changes.taskDeletes || []) rememberDeleteId(map, entry, values);
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
          // Bağımlılığın KENDİ kimliği de geri çevrilir. `collectClientIds`
          // `dependency.id` değerini takma ad eşlemesine yazar ve
          // `normalizeActualChanges` onu sunucu biçimine çevirir; geri çevirme
          // yalnızca `predecessorId` alanına uygulandığı için dönen satır,
          // çevresindeki görev ve proje kimlikleri istemci biçimine dönmüşken
          // kendi kimliğini sunucu biçiminde taşıyordu.
          // `id` YALNIZCA bağımlılığın kendisi taşıyorsa geri yazılır.
          // Koşulsuz atama, kimliksiz gelen bir bağımlılığa `id: undefined`
          // KENDİ ÖZELLİĞİ ekliyordu: yanıt biçimi değişiyor ve alan varlığına
          // bakan tüketiciler kimliksiz bağımlılığı yanlış sınıflandırıyordu.
          ...(Object.hasOwn(dependency, 'id') ? { id: restoreClientId(dependency.id, map) } : {}),
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
  const restoreInboxReferences = (items) => Array.isArray(items) ? items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const restored = { ...item };
    for (const key of ['taskId', 'projectId', 'currentProjectId']) {
      if (Object.hasOwn(item, key)) restored[key] = restoreClientId(item[key], map);
    }
    return restored;
  }) : items;
  return {
    ...body,
    ...Object.fromEntries(['scheduleRequests', 'assignmentCoordinations', 'taskNotifications']
      .filter((key) => Object.hasOwn(body, key)).map((key) => [key, restoreInboxReferences(body[key])])),
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
          // Bağımlılığın KENDİ kimliği de geri çevrilir. `collectClientIds`
          // `dependency.id` değerini takma ad eşlemesine yazar ve
          // `normalizeActualChanges` onu sunucu biçimine çevirir; geri çevirme
          // yalnızca `predecessorId` alanına uygulandığı için dönen satır,
          // çevresindeki görev ve proje kimlikleri istemci biçimine dönmüşken
          // kendi kimliğini sunucu biçiminde taşıyordu.
          // `id` YALNIZCA bağımlılığın kendisi taşıyorsa geri yazılır.
          // Koşulsuz atama, kimliksiz gelen bir bağımlılığa `id: undefined`
          // KENDİ ÖZELLİĞİ ekliyordu: yanıt biçimi değişiyor ve alan varlığına
          // bakan tüketiciler kimliksiz bağımlılığı yanlış sınıflandırıyordu.
          ...(Object.hasOwn(dependency, 'id') ? { id: restoreClientId(dependency.id, map) } : {}),
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
    if (timer) clearTimeout(timer);
    throw new AppRepositoryError({
      code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE,
      message: controller?.signal.aborted
        ? 'Gerçek Sistem sunucusu zamanında yanıt vermedi.'
        : 'Gerçek Sistem sunucusuna ulaşılamadı.',
      operation,
      cause
    });
  }

  // Zaman aşımı GÖVDE OKUNANA kadar sürer.
  //
  // `fetch` başlıklar gelir gelmez çözülür; sayaç gövde okunmadan önce
  // temizlendiğinde, başlıkları gönderip gövdeyi askıda bırakan bir sunucu
  // `response.json()` sözünü sonsuza dek çözülmemiş bırakıyordu. Sıralı yazma
  // kuyruğu bu sözü beklediği için `waitForIdle()` hiç dönmüyor ve uygulama
  // donmuş görünüyordu — kodun kendi yorumunun tarif ettiği hatanın ta kendisi.
  // KESİLEN gövde, boş gövdeden ayrılır. İç `.catch(() => ({}))` iptali de
  // yutuyordu: başlıkları gelmiş ama gövdesi askıda kalan bir commit yanıtı
  // `response.ok` ile birlikte `{}` olarak dönüyor, kalıcılık kuyruğu bunu
  // BAŞARI sayıp saklanan yeniden deneme durumunu atıyordu — sunucu değişikliği
  // işlemiş de olabilir, hâlâ bekliyor da olabilirken. Ayrıştırılamayan ama
  // TAMAMLANMIŞ bir gövde (boş 204, HTML hata sayfası) ise boş nesne sayılmaya
  // devam eder ki durum kodu eşlemesi korunsun.
  //
  // Ayrım `SyntaxError` ÜZERİNDEN yapılır. Fetch sözleşmesinde `json()` yalnızca
  // gövde baştan sona okunup ÇÖZÜMLENEMEDİĞİNDE `SyntaxError` reddi verir;
  // akış düzeyindeki arızalar (kesilen bağlantı, bozuk `Content-Encoding`)
  // `TypeError` üretir. Zaman aşımı dışındaki her reddi boş gövde saymak,
  // yarıda kesilen bir commit yanıtını da BAŞARI gösteriyor ve saklanan yeniden
  // deneme durumunu atıyordu; oysa sunucunun yazmayı işleyip işlemediği bilinmiyor.
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    if (controller?.signal.aborted) {
      throw new AppRepositoryError({
        code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE,
        message: 'Gerçek Sistem sunucusu zamanında yanıt vermedi.',
        operation,
        cause
      });
    }
    if (!(cause instanceof SyntaxError)) {
      throw new AppRepositoryError({
        code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE,
        message: 'Gerçek Sistem yanıtı eksik alındı; işlemin sonucu belirsiz.',
        operation,
        cause
      });
    }
    body = {};
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const creationIds = createCreationIdStorage(aliasStorage, aliasStorageKey, { validateAccount: () => {
    guardAccount();
    if (!scopeAvailable) throw new Error('creation storage unavailable');
  } });
  // Legacy unscoped typed aliases have no authenticated owner.
  for (const id of clientIdAliases.keys()) if (actualIdAliasType(clientIdAliases, id)) {
    actualIdAliasType(clientIdAliases, id, null);
    clientIdAliases.delete(id);
  }
  let account = null;
  let scopeAvailable = false;
  const accountKey = `${aliasStorageKey || ACTUAL_ID_ALIAS_STORAGE_KEY}.active-account`;
  function guardAccount() {
    if (!account || !scopeAvailable) return;
    try {
      if (aliasStorage && aliasStorage.getItem(accountKey) !== account) {
        account = null;
        creationIds.setAccount(null, clientIdAliases);
        activateActualIdAliases(clientIdAliases, guardAccount);
        throw new Error('account changed');
      }
    } catch {
      throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
        message: 'Oturum değişti. Verileri yeniden yükleyin.', operation: 'commitChanges' });
    }
  }
  function accountStamp() {
    try { return aliasStorage?.getItem(accountKey) ?? null; } catch { return null; }
  }
  function acceptSession(session, observedAccount = accountStamp()) {
    const sicil = session?.authenticated === true ? Number(session.currentUser?.sicil ?? session.currentUser?.employeeNo) : NaN;
    const next = Number.isSafeInteger(sicil) && sicil > 0 ? String(sicil) : null;
    const current = accountStamp();
    if (current !== observedAccount && current !== next) {
      account = null;
      creationIds.setAccount(null, clientIdAliases);
      activateActualIdAliases(clientIdAliases, guardAccount);
      throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
        message: 'Oturum değişti. Verileri yeniden yükleyin.', operation: 'loadSessionContext' });
    }
    if (next !== account) {
      account = next;
      creationIds.setAccount(account, clientIdAliases);
    }
    scopeAvailable = !aliasStorage;
    try {
      if (aliasStorage?.getItem(accountKey) !== account) aliasStorage?.setItem(accountKey, account);
      scopeAvailable = !aliasStorage || aliasStorage.getItem(accountKey) === account;
    } catch { /* Versioned canonical-ID edits still work without durable storage. */ }
    if (account && scopeAvailable) creationIds.restoreAliases(clientIdAliases);
    else for (const id of clientIdAliases.keys()) if (actualIdAliasType(clientIdAliases, id)) {
      actualIdAliasType(clientIdAliases, id, null);
      clientIdAliases.delete(id);
    }
    activateActualIdAliases(clientIdAliases, guardAccount);
  }
  async function verifyAccount() {
    const previous = account;
    const observed = accountStamp();
    acceptSession(await requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext'), observed);
    if (!account || (previous && previous !== account)) throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
      message: 'Oturum doğrulanamadı. Verileri yeniden yükleyin.', operation: 'commitChanges' });
  }
  activateActualIdAliases(clientIdAliases, guardAccount);
  let preparation = Promise.resolve();
  function prepare(changes) {
    const result = preparation.then(async () => {
      if (creationEntries(changes).length && !account) await verifyAccount();
      collectClientIds(changes, clientIdAliases);
      const normalized = normalizeActualChanges(changes);
      if (creationEntries(normalized).length) {
        const records = await creationIds.reconciliationRecords(normalized, clientIdAliases);
        if (records.length) {
          const allocationChanges = {};
          for (const record of records) {
            const collection = { PROJECT: 'projectUpserts', WBS: 'wbsUpserts', TASK: 'taskUpserts' }[record.entityType];
            const original = normalized[collection].find((entry) => entry.id === record.clientId || entry.id === record.id);
            (allocationChanges[collection] ||= []).push({ ...original, id: record.id, projectId: record.projectId,
              creationProof: record.proof });
          }
          // Only the server can prove a pending identity was never committed.
          // A consumed/pruned proof fails closed, retaining its identity mapping.
          const result = await requestJson(`${basePath}/commit`, { method: 'POST', body: JSON.stringify({
            operation: 'release-creation-ids', changes: {}, allocationChanges }) }, 'commitChanges');
          if (!Array.isArray(result?.released) || result.released.some((entry) => !records.some((record) =>
            record.id === entry.id && record.entityType === entry.entityType))) throw new AppRepositoryError({
            code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
            message: 'Oluşturma işlemi doğrulanamadı. Verileri yeniden yükleyin.', operation: 'commitChanges' });
          const released = records.filter((record) => result.released.some((entry) => record.id === entry.id && record.entityType === entry.entityType));
          await creationIds.release(released, clientIdAliases);
          const unknown = records.filter((record) => !released.includes(record));
          if (unknown.length) {
            await creationIds.retireProofs(unknown, clientIdAliases);
            throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.CONFLICT,
              message: 'Oluşturma kimliği onaylanamadı. Verileri yeniden yükleyin.', operation: 'commitChanges',
              details: { code: 'CREATION_ALLOCATION_INVALID' } });
          }
        }
      }
      let prepared = await creationIds.prepare(normalized, clientIdAliases);
      if (creationEntries(prepared).some(({ entry }) => !entry.creationProof)) {
        const allocatedAt = Date.now();
        const { allocations } = await requestJson(`${basePath}/commit`, { method: 'POST',
          body: JSON.stringify({ operation: 'allocate-creation-ids', changes: {}, allocationChanges: prepared }) }, 'commitChanges');
        if (!Array.isArray(allocations)) throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.MUTATION_FAILED,
          message: 'Oluşturma kimliği alınamadı.', operation: 'commitChanges' });
        await creationIds.remember(allocations, clientIdAliases, changes, allocatedAt);
        prepared = await creationIds.prepare(normalized, clientIdAliases);
        if (creationEntries(prepared).some(({ entry }) => !entry.creationProof)) throw new AppRepositoryError({
          code: REPOSITORY_ERROR_CODES.MUTATION_FAILED, message: 'Oluşturma kimliği alınamadı.', operation: 'commitChanges' });
      }
      activateActualIdAliases(clientIdAliases, guardAccount);
      return prepared;
    });
    preparation = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    kind: 'actual-api',
    async loadSessionContext() {
      const observed = accountStamp();
      const session = await requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
      acceptSession(session, observed);
      return restoreActualSessionIds(session, clientIdAliases);
    },
    /**
     * Anlık görüntü yanıtı oturum bağlamını da taşır ve bağlam anlık görüntüyle
     * BİRLİKTE döndürülür. Paylaşılan tek yuvada saklansaydı, üst üste binen iki
     * yükleme birbirinin oturumunu tüketebilir ve A anlık görüntüsü B'nin proje
     * erişimiyle eşleşebilirdi.
     */
    async loadSnapshot({ refreshMode = 'initial' } = {}) {
      const requestMode = ['manual', 'automatic'].includes(refreshMode) ? refreshMode : 'initial';
      const observed = accountStamp();
      const body = await requestJson(`${basePath}/snapshot`, {
        method: 'GET',
        headers: { 'x-mergen-rota-refresh-mode': requestMode }
      }, 'loadSnapshot');
      const { session, ...snapshot } = body || {};
      acceptSession(session, observed);
      const restored = restoreActualSnapshotIds(snapshot, clientIdAliases);
      return session ? { ...restored, session: restoreActualSessionIds(session, clientIdAliases) } : restored;
    },
    /**
     * `keepalive`, sekme kapanırken yapılan son yazma içindir: tarayıcı sayfayı
     * boşaltırken sıradan bir `fetch` iptal edilebilir, bu bayrakla isteğin
     * tamamlanması garanti altına alınır.
     */
    async commitChanges(changes, { keepalive = false, notifyAssignees = false } = {}) {
      guardAccount();
      const prepared = !creationEntries(changes).length
        ? creationIds.prepareExisting(normalizeActualChanges((collectClientIds(changes, clientIdAliases), changes)), clientIdAliases)
        : await prepare(changes);
      const preparedAccount = account;
      const preparedScope = scopeAvailable;
      // `notifyAssignees` işlem BAŞINA bir tercihtir: kalıcı bir kullanıcı ayarı
      // olarak saklanmaz ve yalnızca kullanıcı açıkça seçtiğinde gönderilir.
      const body = JSON.stringify({
        changes: prepared,
        ...(notifyAssignees === true ? { notifyAssignees: true } : {})
      });
      // Büyük gövde `keepalive` sınırını aşar ve istek hiç gönderilmez; sıradan
      // isteğe düşmek, değişikliği sessizce kaybetmekten iyidir.
      const useKeepalive = keepalive && bodyByteLength(body) <= KEEPALIVE_BODY_LIMIT_BYTES;
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        keepalive: useKeepalive,
        body
      }, 'commitChanges');
      guardAccount();
      if (account !== preparedAccount || (preparedScope && !scopeAvailable)) throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
        message: 'Oturum değişti. Verileri yeniden yükleyin.', operation: 'commitChanges' });
      if (creationEntries(prepared).length) await creationIds.complete(prepared, clientIdAliases);
      return restoreActualCommitIds(committed, changes, clientIdAliases);
    },
    async flush() {}
  };
}
