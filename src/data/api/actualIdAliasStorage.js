import { extractActualId } from '../../domain/identity/actualId.js';

export const ACTUAL_ID_ALIAS_STORAGE_KEY = 'mergen-rota.actual-id-aliases.v1';
export const MAX_ACTUAL_ID_ALIASES = 5000;
const entityTypes = new WeakMap();
const TYPES = new Set(['PROJECT', 'WBS', 'TASK']);

export function actualIdAliasType(aliases, actual, type) {
  if (type === null) entityTypes.get(aliases)?.delete(actual);
  if (TYPES.has(type)) {
    if (!entityTypes.has(aliases)) entityTypes.set(aliases, new Map());
    entityTypes.get(aliases).set(actual, type);
  }
  return entityTypes.get(aliases)?.get(actual);
}

function actualUuid(value) {
  return extractActualId(value);
}

function validAlias(actual, clientId, type) {
  const normalizedActual = actualUuid(actual);
  const normalizedClient = clientId == null ? '' : String(clientId).trim();
  return normalizedActual && normalizedClient !== normalizedActual && actualUuid(normalizedClient)
    && (actualUuid(normalizedClient) === normalizedActual || TYPES.has(type))
    ? [normalizedActual, normalizedClient, ...(TYPES.has(type) ? [type] : [])]
    : null;
}

export function loadActualIdAliases(storage, storageKey = ACTUAL_ID_ALIAS_STORAGE_KEY) {
  const aliases = new Map();
  if (!storage) return aliases;

  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return aliases;
    return decodeActualIdAliases(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export function decodeActualIdAliases(values) {
  const aliases = new Map();
  if (Array.isArray(values)) {
    const typed = values.filter((entry) => Array.isArray(entry) && TYPES.has(entry[2]));
    if (typed.length > MAX_ACTUAL_ID_ALIASES) throw new RangeError('Creation identity capacity exceeded');
    for (const entry of [...values.filter((entry) => !TYPES.has(entry?.[2])).slice(-MAX_ACTUAL_ID_ALIASES), ...typed]) {
      if (!Array.isArray(entry) || ![2, 3].includes(entry.length)) continue;
      const alias = validAlias(entry[0], entry[1], entry[2]);
      if (alias) {
        aliases.set(alias[0], alias[1]);
        actualIdAliasType(aliases, alias[0], alias[2]);
      }
    }
  }
  return aliases;
}

export function encodeActualIdAliases(aliases, { pendingIds = new Set() } = {}) {
  const values = [];
  for (const [actual, clientId] of aliases instanceof Map ? aliases : []) {
    const alias = validAlias(actual, clientId, actualIdAliasType(aliases, actual));
    if (alias) values.push(alias);
  }

  const typed = values.filter((value) => value.length === 3);
  const pending = typed.filter(([id]) => pendingIds.has(id));
  if (pending.length > MAX_ACTUAL_ID_ALIASES) throw new RangeError('Creation identity capacity exceeded');
  const completed = typed.filter(([id]) => !pendingIds.has(id));
  const formatting = values.filter((value) => value.length === 2).slice(-MAX_ACTUAL_ID_ALIASES);
  const completedCapacity = MAX_ACTUAL_ID_ALIASES - pending.length;
  return [...formatting, ...(completedCapacity ? completed.slice(-completedCapacity) : []), ...pending];
}

export function persistActualIdAliases(aliases, storage, storageKey = ACTUAL_ID_ALIAS_STORAGE_KEY) {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(encodeActualIdAliases(aliases)));
    return true;
  } catch {
    return false;
  }
}
