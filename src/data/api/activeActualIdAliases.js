import { extractActualId } from '../../domain/identity/actualId.js';
import { actualIdAliasType, ACTUAL_ID_ALIAS_STORAGE_KEY } from './actualIdAliasStorage.js';

let activeAliases = new Map();
let outgoingIds = new Map();
let accountGuard = null;

// Shared by the actual repository and its feature HTTP adapters, never by
// server authorization. These aliases only translate IDs; they grant no access.
export function activateActualIdAliases(aliases, guard = null) {
  accountGuard = guard;
  activeAliases = new Map([...aliases].filter(([actual, client]) => extractActualId(client) !== actual));
  outgoingIds = new Map([...activeAliases].map(([actual, client]) => [`${actualIdAliasType(aliases, actual)}:${extractActualId(client)}`, actual]));
}

export function clearActualAccount(storage) {
  activateActualIdAliases(new Map());
  try { storage?.removeItem(`${ACTUAL_ID_ALIAS_STORAGE_KEY}.active-account`); } catch { /* Storage can be unavailable. */ }
}

function outgoing(value, type) { return outgoingIds.get(`${type}:${extractActualId(value)}`) || value; }
function incoming(value) { return activeAliases.get(extractActualId(value)) || value; }
const ENTITY_KEYS = new Map([['taskId', 'TASK'], ['projectId', 'PROJECT'], ['currentProjectId', 'PROJECT'], ['wbsId', 'WBS']]);

export function translateEntityRequest(path, init) {
  let responseAccount;
  try { responseAccount = accountGuard?.(); } catch (error) {
    if (error?.code !== 'UNAUTHORIZED') throw error;
    return { failure: { ok: false, code: error.code, message: error.message } };
  }
  if (!outgoingIds.size) return { path, init, responseGuard: accountGuard, responseAccount };
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
  return { path: `${url.pathname}${url.search}`, init: translated, responseGuard: accountGuard, responseAccount };
}

export function restoreEntityResponse(value, context = {}) {
  const { method = 'GET', guard = accountGuard } = context;
  // A successful server mutation stays successful if the account changed while
  // awaiting its response. Never restore it with another account's aliases.
  try {
    const current = guard?.();
    if (guard !== accountGuard || (Object.hasOwn(context, 'account') && current !== context.account)) {
      throw { code: 'UNAUTHORIZED', message: 'Oturum değişti. Verileri yeniden yükleyin.' };
    }
  } catch (error) {
    if (error?.code !== 'UNAUTHORIZED') throw error;
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) return { ok: false, code: error.code, message: error.message };
    return value;
  }
  function restore(item) {
    if (Array.isArray(item)) return item.map(restore);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      ENTITY_KEYS.has(key) ? incoming(child) : restore(child)]));
  }
  return restore(value);
}
