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
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
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
  const normalized = String(value).trim();
  const match = normalized.match(UUID_SUFFIX);
  return (match ? match[1] : normalized).toLowerCase();
}

export function toPersistenceStatus(value) {
  return STATUS_TO_SQL[value] || value;
}

export function fromPersistenceStatus(value) {
  return STATUS_FROM_SQL[value] || value;
}

function normalizeDelete(entry) {
  return typeof entry === 'string'
    ? { id: toActualUuid(entry), version: null }
    : { ...entry, id: toActualUuid(entry?.id) };
}

export function normalizeActualChanges(changes = {}) {
  return {
    ...changes,
    projectUpserts: (changes.projectUpserts || []).map((project) => ({
      ...project,
      id: toActualUuid(project.id),
      calendarId: toActualUuid(project.calendarId)
    })),
    projectDeletes: (changes.projectDeletes || []).map(normalizeDelete),
    wbsUpserts: (changes.wbsUpserts || []).map((node) => ({
      ...node,
      id: toActualUuid(node.id),
      projectId: toActualUuid(node.projectId),
      parentId: toActualUuid(node.parentId)
    })),
    wbsDeletes: (changes.wbsDeletes || []).map(normalizeDelete),
    taskUpserts: (changes.taskUpserts || []).map((task) => ({
      ...task,
      id: toActualUuid(task.id),
      projectId: toActualUuid(task.projectId),
      wbsId: toActualUuid(task.wbsId),
      calendarId: toActualUuid(task.calendarId),
      status: toPersistenceStatus(task.status),
      deps: Array.isArray(task.deps) ? task.deps.map((dependency) => ({
        ...dependency,
        id: dependency.id ? toActualUuid(dependency.id) : dependency.id,
        predecessorId: toActualUuid(dependency.predecessorId)
      })) : task.deps
    })),
    taskDeletes: (changes.taskDeletes || []).map(normalizeDelete)
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
    for (const dependency of task?.deps || []) {
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
      deps: (task.deps || []).map((dependency) => ({
        ...dependency,
        predecessorId: restoreClientId(dependency.predecessorId, map)
      }))
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
      deps: (task.deps || []).map((dependency) => ({
        ...dependency,
        predecessorId: restoreClientId(dependency.predecessorId, map)
      }))
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

async function requestJson(url, init, operation) {
  let response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  } catch (cause) {
    throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE, message: 'Gerçek Sistem sunucusuna ulaşılamadı.', operation, cause });
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
    async loadSnapshot() {
      const snapshot = await requestJson(`${basePath}/snapshot`, { method: 'GET' }, 'loadSnapshot');
      return restoreActualSnapshotIds(snapshot, clientIdAliases);
    },
    async commitChanges(changes) {
      collectClientIds(changes, clientIdAliases);
      persistActualIdAliases(clientIdAliases, aliasStorage, aliasStorageKey);
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        body: JSON.stringify({ changes: normalizeActualChanges(changes) })
      }, 'commitChanges');
      return restoreActualCommitIds(committed, changes, clientIdAliases);
    },
    async flush() {}
  };
}
