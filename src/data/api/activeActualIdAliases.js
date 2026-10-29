import { extractActualId } from '../../domain/identity/actualId.js';
import { actualIdAliasType } from './actualIdAliasStorage.js';

let activeAliases = new Map();
let outgoingIds = new Map();

// Shared by the actual repository and its feature HTTP adapters, never by
// server authorization. These aliases only translate IDs; they grant no access.
export function activateActualIdAliases(aliases) {
  activeAliases = new Map([...aliases].filter(([actual, client]) => extractActualId(client) !== actual));
  outgoingIds = new Map([...activeAliases].map(([actual, client]) => [`${actualIdAliasType(aliases, actual)}:${extractActualId(client)}`, actual]));
}

function outgoing(value, type) { return outgoingIds.get(`${type}:${extractActualId(value)}`) || value; }
function incoming(value) { return activeAliases.get(extractActualId(value)) || value; }
const ENTITY_KEYS = new Map([['taskId', 'TASK'], ['projectId', 'PROJECT'], ['wbsId', 'WBS']]);

export function translateEntityRequest(path, init) {
  if (!outgoingIds.size) return { path, init };
  const url = new URL(path, 'http://localhost');
  for (const [key, type] of ENTITY_KEYS) if (url.searchParams.has(key)) url.searchParams.set(key, outgoing(url.searchParams.get(key), type));
  url.pathname = url.pathname.replace(/(\/tasks\/)([^/]+)(\/(?:outlook|reminder))$/, (_match, prefix, id, suffix) =>
    `${prefix}${encodeURIComponent(outgoing(decodeURIComponent(id), 'TASK'))}${suffix}`);
  let translated = init;
  if (typeof init?.body === 'string') {
    let body;
    try { body = JSON.parse(init.body); } catch { /* Not an entity payload. */ }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [key, type] of ENTITY_KEYS) if (Object.hasOwn(body, key)) body[key] = outgoing(body[key], type);
      if (Array.isArray(body.taskIds)) body.taskIds = body.taskIds.map((value) => outgoing(value, 'TASK'));
      translated = { ...init, body: JSON.stringify(body) };
    }
  }
  return { path: `${url.pathname}${url.search}`, init: translated };
}

export function restoreEntityResponse(value) {
  if (Array.isArray(value)) return value.map(restoreEntityResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ENTITY_KEYS.has(key) ? incoming(item) : restoreEntityResponse(item)]));
}
