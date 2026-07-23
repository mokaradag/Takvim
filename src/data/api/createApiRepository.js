import { AppRepositoryError, REPOSITORY_ERROR_CODES } from '../contracts/appRepository.js';

const CODE_BY_STATUS = {
  401: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
  403: REPOSITORY_ERROR_CODES.FORBIDDEN,
  409: REPOSITORY_ERROR_CODES.CONFLICT,
  503: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE
};
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const STATUS_TO_SQL = Object.freeze({ todo: 'planned', in_progress: 'in-progress' });
const STATUS_FROM_SQL = Object.freeze({ planned: 'todo', 'in-progress': 'in_progress' });

export function toActualUuid(value) {
  if (value == null || value === '') return null;
  const match = String(value).match(UUID_SUFFIX);
  return match ? match[1] : String(value);
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

function normalizeActualChanges(changes = {}) {
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
      deps: (task.deps || []).map((dependency) => ({
        ...dependency,
        id: dependency.id ? toActualUuid(dependency.id) : dependency.id,
        predecessorId: toActualUuid(dependency.predecessorId)
      }))
    })),
    taskDeletes: (changes.taskDeletes || []).map(normalizeDelete)
  };
}

function collectClientIds(changes = {}) {
  const map = new Map();
  for (const collection of [changes.projectUpserts, changes.wbsUpserts, changes.taskUpserts]) {
    for (const entity of collection || []) {
      const original = entity?.id == null ? null : String(entity.id);
      const actual = toActualUuid(original);
      if (original && actual && original !== actual) map.set(actual, original);
    }
  }
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

export function restoreActualCommitIds(body, changes = {}) {
  if (!body || typeof body !== 'object') return body;
  const map = collectClientIds(changes);
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

export function createApiRepository({ basePath = '/api/mergen-rota' } = {}) {
  return {
    kind: 'actual-api',
    loadSessionContext() {
      return requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
    },
    loadSnapshot() {
      return requestJson(`${basePath}/snapshot`, { method: 'GET' }, 'loadSnapshot');
    },
    async commitChanges(changes) {
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        body: JSON.stringify({ changes: normalizeActualChanges(changes) })
      }, 'commitChanges');
      return restoreActualCommitIds(committed, changes);
    },
    async flush() {}
  };
}
